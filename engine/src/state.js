'use strict';
/**
 * 舰队状态机 = 调度器 + 事件溯源账本 + 黑板 + 人格实例。
 *
 * 三条硬立场：
 *  1) 一切状态变更先写 append-only 账本，再改内存 —— 会话崩了、IDE 重启了，舰队从断点继续，
 *     不重跑不丢活儿（对标 Harness「模型可见即已记录」+ Gas Town「git 即状态机」）。
 *  2) 每个 work 节点默认要过对抗验证；裁决者看得见全部原始候选池（盲采样），
 *     而不是让舰员互相看着抄 —— 同构辩论实测多烧 2.1~3.4× token、从众率 85.5%。
 *  3) 终止条件是代码不是祈祷：租约 TTL、空转指纹、重试上限、预算到线，四道闸自动收口。
 */
const path = require('path');
const fs = require('fs');
const { now, ts, sha, uid, writeFileSafe, readJsonl, appendJsonl, ensureDir, estTokens, truncate } = require('./util');
const { Blackboard, render } = require('./board');
const { Budget } = require('./limits');
const { Compactor } = require('./compactor');
const LEASE_MS = 180 * 1000;
const MAX_ATTEMPTS_DEFAULT = 3;
const TIER_LADDER = { eco: ['eco', 'mid', 'high'], mid: ['mid', 'high'], high: ['high'] };

class Fleet {
  constructor({ id, spec, verdict, cfg, personas, roles, hooks, skills, repoMap, policy, router, jobs, runtime, agentsMd, guardrails, tracer, topic, checkpoints, beads, convoy, refinery, filemap, sop, emit, stateDir, resumeFrom = null }) {
    this.id = id;
    this.spec = spec;
    this.verdict = verdict;
    this.cfg = cfg;
    this.personas = personas;
    this.roles = roles;
    this.hooks = hooks;
    this.skills = skills;
    this.repoMap = repoMap;
    this.policy = policy;
    this.router = router;
    this.jobs = jobs;
    this.runtime = runtime;
    this.agentsMd = agentsMd;
    this.guardrails = guardrails;
    this.tracer = tracer;
    this.topic = topic;
    this.checkpoints = checkpoints;
    this.beads = beads;
    this.convoy = convoy;
    this.refinery = refinery;
    this.filemap = filemap;
    this.sop = sop;
    this.compactor = this.compactor || null;
    this.emit = emit || (() => {});
    this.stateDir = stateDir;
    this.depth = 0;
    this.cpSeq = 0;
    this.createdAt = ts();
    this.status = 'active';
    this.seq = 0;
    this.nodes = new Map();
    this.board = new Blackboard({ fleetId: id, artifactDir: path.join(cfg.artifactDir || path.join(stateDir, 'artifacts'), id) });
    this.budget = new Budget(spec.budget || {});
    this.ledgerFile = path.join(stateDir, 'ledger', `${id}.jsonl`);
    this.snapshotFile = path.join(stateDir, 'snapshots', `${id}.json`);
    if (resumeFrom) this._hydrate(resumeFrom);
  }

  // ── 持久化 ────────────────────────────────────────────────
  ev(type, data = {}, actor = 'hub') {
    const env = { seq: ++this.seq, ts: now(), fleet: this.id, type, actor, data };
    try { appendJsonl(this.ledgerFile, env); } catch (e) { /* 账本写不进去就是天大的事 */ throw e; }
    this.emit(env);
    return env;
  }

  snapshot() {
    return {
      id: this.id, spec: this.spec, verdict: this.verdict, status: this.status,
      createdAt: this.createdAt, seq: this.seq, budget: this.budget.snapshot(),
      board: this.board.records, nodes: [...this.nodes.values()],
    };
  }
  persist() {
    const f = this.snapshotFile + '.tmp';
    writeFileSafe(f, JSON.stringify(this.snapshot()));
    try { fs.renameSync(f, this.snapshotFile); } catch (e) {
      // Windows 上 tick 与 worker 同步写时会偶发 EPERM，200ms 内重试 3 次
      let ok = false;
      for (let i = 0; i < 4 && !ok; i++) {
        try { fs.renameSync(f, this.snapshotFile); ok = true; } catch (_) { Atomics && Atomics.wait && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60); }
      }
      if (!ok) try { fs.copyFileSync(f, this.snapshotFile); fs.unlinkSync(f); } catch (_) {}
    }
  }
  _hydrate(snap) {
    this.status = snap.status === 'active' ? 'active' : snap.status;
    this.createdAt = snap.createdAt;
    this.seq = snap.seq || 0;
    this.board.records = snap.board || [];
    this.board.seen = new Set((snap.board || []).map((r) => r.hash));
    for (const n of snap.nodes || []) {
      const node = Object.assign({}, n);
      if (node.status === 'leased' || node.status === 'running') { node.status = 'pending'; node.lease = null; }
      this.nodes.set(node.id, node);
    }
    Object.assign(this.budget, new Budget(this.spec.budget || {}), snap.budget || {});
    this.budget.startedAt = ts();
  }

  // ── 建图 ──────────────────────────────────────────────────
  /** LangGraph Command 化：state 更新 + 路由跳转合成一次 */
  command(update, goto) { return { update, goto }; }
  /** Send: 动态展开 planner → N 个 worker */
  fanout(nodes) { return nodes.map((n) => ({ __send: true, node: n.id, arg: n })); }

  /** Gas Town Beads 绑定：每个节点背后挂一个 bead，状态自动同步 */
  beadFor(node) { return this.beads.create({ convoyId: this.id, summary: `${node.kind}/${node.role}/${node.persona} - ${String(node.mission).slice(0, 80)}` }); }
  closeBead(beadId, status = 'closed') { if (this.beads) this.beads.set(beadId, status, { closedAt: Date.now() }); }

  /** Gas Town Convoy：把一组节点装进 convoy 跟踪进度 */
  trackConvoy(name, nodeIds) {
    if (!this.beads || !this.convoy) return { convoyId: null, beadIds: [] };
    const beads = nodeIds.map(() => this.beads.create({ convoyId: this.id, summary: name }));
    const c = this.convoy.create({ name, beadIds: beads.map((b) => b.id), metadata: { fleetId: this.id, nodeIds } });
    return { convoyId: c.id, beadIds: beads.map((b) => b.id) };
  }

  addNodes(list) {
    for (const s of list) {
      if (this.nodes.has(s.id)) continue;
      const node = normalizeNode(s, this.verdict);
      this.nodes.set(node.id, node);
      this.ev('node.added', { id: node.id, kind: node.kind, role: node.role, persona: node.persona, deps: node.deps });
    }
    this.recompute();
    return this;
  }

  depsDone(node) {
    return node.deps.every((d) => {
      const p = this.nodes.get(d);
      return !p || p.status === 'done' || p.status === 'void';
    });
  }

  recompute() {
    for (const n of this.nodes.values()) {
      if (n.status === 'pending' && this.depsDone(n) && (!n.nextAt || n.nextAt <= ts())) {
        n.status = 'ready';
        n.readyAt = ts();
        this.ev('node.ready', { id: n.id, persona: n.persona, role: n.role });
      }
    }
    this.rank();
  }

  /** 关键路径优先：卡在下游长链上的节点先跑（critical path 越长越急） */
  rank() {
    const children = new Map();
    for (const n of this.nodes.values()) for (const d of n.deps) {
      if (!children.has(d)) children.set(d, []);
      children.get(d).push(n.id);
    }
    const depth = (id, seen = new Set()) => {
      if (seen.has(id)) return 0;
      seen.add(id);
      const kids = children.get(id) || [];
      return 1 + Math.max(0, ...kids.map((k) => depth(k, seen)));
    };
    for (const n of this.nodes.values()) n.cp = depth(n.id);
    [...this.nodes.values()].filter((n) => n.status === 'ready')
      .sort((a, b) => b.cp - a.cp || (a.readyAt || 0) - (b.readyAt || 0));
  }

  readyNodes() {
    return [...this.nodes.values()].filter((n) => n.status === 'ready')
      .sort((a, b) => (b.cp || 0) - (a.cp || 0) || (a.readyAt || 0) - (b.readyAt || 0));
  }

  // ── 派工 ──────────────────────────────────────────────────
  /** 一个 worker 来领活儿：按角色/人格/层级/盲评约束匹配 */
  claim(worker) {
    const ready = this.readyNodes();
    for (const node of ready) {
      if (!workerCan(worker, node)) continue;
      return this.lease(node.id, worker);
    }
    return null;
  }

  lease(nodeId, worker) {
    const node = this.nodes.get(nodeId);
    if (!node || node.status !== 'ready') return null;
    // v3: Codex 式线程槽位 —— 租约前看 max_threads 还能不能再开
    if (this.runtime && !this.runtime.canSpawnThread()) return null;
    // v3 审批流：ask 命中且 spec.autoApprove===false → 真的暂停，不是只记一笔
    // 已批准过的节点（node.approved）豁免复查，否则 approve 后再次 lease 会死循环回 awaiting
    if (this.policy && !node.approved && (node.role === 'execute' || node.role === 'map' || node.role === 'compete' || node.role === 'reduce')) {
      const p = this.policy.check({ tool: node.declaredTool || 'Bash(any)' }, { actor: worker.id, node: node.id, fleet: this.id });
      if (!p.allow && p.reason === 'awaiting_human') {
        if (this.spec.autoApprove === false) {
          node.status = 'awaiting_approval';
          node.approval = { rule: p.rule, reason: p.reasonText, askedAt: Date.now() };
          this.ev('policy.await', { id: node.id, rule: p.rule, reason: p.reasonText, worker: worker.id });
          this.board.put({ type: 'question', body: `节点 ${node.id} 触发策略「${p.rule}：${p.reasonText}」等待指挥官 approve/reject`, author: 'policy', node: node.id, confidence: 0.95 });
          this.persist();
          return null;
        }
        this.ev('policy.await', { id: node.id, rule: p.rule, reason: p.reasonText, autoApproved: true });
      }
    }
    node.status = 'leased';
    node.attempts = (node.attempts || 0) + 1;
    node.lease = { worker: worker.id, until: ts() + LEASE_MS };
    node.worker = worker.id;
    const ctx = this.context(node, worker);
    if (this.runtime) this.runtime.reserveThread(`${this.id}/${node.id}`, worker.id);
    if (this.hooks) this.hooks.fire('SubagentStart', { fleetId: this.id, node: publicNode(node), worker: worker.id, attempt: node.attempts });
    this.ev('node.leased', { id: node.id, worker: worker.id, attempt: node.attempts, provider: worker.provider, model: worker.model });
    return { node: publicNode(node), context: ctx };
  }

  /** v3 审批：批准 → 重新就绪（不烧 attempt，打 approved 豁免旗标） */
  approve(nodeId, by) {
    const n = this.nodes.get(nodeId);
    if (!n || n.status !== 'awaiting_approval') return { ok: false, error: 'not_awaiting' };
    n.status = 'pending'; n.approval = null; n.approved = { by, at: Date.now() }; n.attempts = Math.max(0, (n.attempts || 1) - 1);
    this.ev('policy.approved', { id: nodeId, by });
    this.board.put({ type: 'decision', body: `指挥官 ${by} 批准 ${nodeId}`, author: 'commander', node: nodeId, confidence: 1 });
    this.recompute(); this.persist();
    return { ok: true };
  }
  /** v3 审批：驳回 → 节点判死，写 blocker */
  reject(nodeId, reason, by) {
    const n = this.nodes.get(nodeId);
    if (!n || n.status !== 'awaiting_approval') return { ok: false, error: 'not_awaiting' };
    n.status = 'failed'; n.lease = null;
    this.ev('policy.rejected', { id: nodeId, reason: truncate(reason || '', 300), by });
    this.board.put({ type: 'blocker', body: `指挥官 ${by || 'mcp'} 驳回 ${nodeId}：${reason || '无理由'}`, author: 'commander', node: nodeId, confidence: 1 });
    this.recompute(); this.persist();
    return { ok: true };
  }
  awaiting() { return [...this.nodes.values()].filter((n) => n.status === 'awaiting_approval').map((n) => ({ id: n.id, rule: n.approval && n.approval.rule, reason: n.approval && n.approval.reason, askedAt: n.approval && n.approval.askedAt })); }

  /** 给舰员的完整作战上下文：人格 + 私有记忆 + 黑板切片（盲评节点屏蔽同伴产出） */
  context(node, worker) {
    const personaId = node.persona || 'craftsman';
    const inst = this.personas.spawn(personaId, { fleet: this.id, node: node.id });
    const blind = !!node.blind || node.kind === 'challenge';
    const depBrief = node.deps.map((d) => this.nodes.get(d)).filter(Boolean).map((d) => ({
      from: d.id, persona: d.persona, summary: d.result ? truncate(d.result.summary || '', 900) : '(未完成)',
      artifacts: d.result ? (d.result.artifacts || []).slice(0, 5) : [],
    }));
    const slice = this.board.query({
      text: [node.mission, this.spec.goal, personaId, ...(node.acceptance || [])].join(' '),
      k: 14,
      tokenBudget: (this.cfg.boardTokens || 900),
      excludeAuthor: blind ? null : node.worker,
    });
    const siblings = blind ? [] : [...this.nodes.values()]
      .filter((n) => n.critiqueTarget === node.id)
      .map((n) => `[${n.role}] ${n.result ? truncate(n.result.summary || '', 400) : ''}`);
    const system = this.personas.systemPrompt(inst, {
      memory: this.personas.recall(personaId, 10),
      board: blind ? '' : this._boardView(),
      acceptance: node.acceptance,
      blind,
    }) + (this.skills ? skillsBlock(this.skills, node, this.spec, worker) : '') + (this.roles && this.roles.get(personaId) ? `\n\n【Role Contract】${this.roles.get(personaId).callsign} | capabilities=${(this.roles.get(personaId).capabilities || []).join(',')} | adversarial=${this.roles.get(personaId).adversarial ? 'yes' : 'no'}` : '');
    const user = [
      `【舰队】${this.id}  【目标】${this.spec.goal}`,
      `【拓扑】${this.verdict.topology}  【你的节点】${node.id}/${node.kind}/${node.role}`,
      `【作战任务】\n${node.mission}`,
      node.parentGoal ? `【上位目标】${node.parentGoal}` : '',
      node.critique ? `【上一轮被驳回，必须修掉这些问题】\n${node.critique}` : '',
      depBrief.length ? `【上游交付】\n${depBrief.map((d) => `- ${d.from}(${d.persona}) ${d.summary}${d.artifacts.length ? ' 产物:' + d.artifacts.join(',') : ''}`).join('\n')}` : '',
      siblings.length ? `【同伴产出（可以不同意，但不许抄）】\n${siblings.join('\n')}` : '',
      `【交付契约】完成后用 submit 交回：summary(结论) / evidence(证据条或命令输出) / artifacts(产物文件) / files[](需要引擎代写) / confidence(0-1) / tokens(消耗) / verdict(仅裁决节点)。`,
      `【升级阶梯】你现在在 tier=${node.tier}，provider=${worker && worker.provider}。做不到就如实说 blocked，别硬编。`,
      `【policy gate】任何高风险动作（rm -rf、push、curl|sh、强推、写 .env 等）会被中央策略闸 deny；低/中风险可自动通过，需要人批的会暂停。`,
    ].filter(Boolean).join('\n\n');
    // v3: 注入 AGENTS.md 协议段（按覆盖优先级从高到低）
    const agentsMdBlock = this.agentsMd && worker && worker.cwd ? this.agentsMd.render(worker.cwd) : '';
    // v3: 注入 SOP 段（若有）
    const sopBlock = this.sop ? '' : ''; // 在 hub 注入；保留空
    // v3: 注入 gas-town hooks 提示
    const hooksBlock = '\n\n【Hooks 提示】本舰队用 Hooks Bus：SubagentStart/PreToolUse/PostToolUse/TaskCompleted/Error 自动落账本，工具动作会被中央 policy gate 闸。';
    const finalSystem = system + agentsMdBlock + sopBlock + hooksBlock;
    return { system: finalSystem, user, persona: { id: personaId, callsign: inst.card.callsign, seed: inst.seed, angle: inst.angle }, blind, node: publicNode(node) };
  }

  /** 给模型看的黑板视图：用 Compactor 做 window-safe（热+冷+预算裁剪，防 context rot） */
  _boardView() {
    if (!this.compactor) {
      this.compactor = new Compactor({ stateDir: this.stateDir, maxBoardTokens: this.cfg.boardTokens || 900 });
    }
    return this.compactor.render(this.board);
  }

  /** time-travel：replay / fork —— LangGraph 同款 */
  replay({ from = 0, limit = 200 } = {}) {
    return readJsonl(this.ledgerFile).filter((e, i) => i >= from).slice(-limit);
  }
  fork({ atSeq = 0 }) {
    const f = new Fleet({
      id: this.id + '.fork.' + atSeq,
      spec: this.spec, verdict: this.verdict, cfg: this.cfg,
      personas: this.personas, roles: this.roles, hooks: this.hooks,
      skills: this.skills, repoMap: this.repoMap, policy: this.policy, router: this.router, jobs: this.jobs,
      runtime: this.runtime, agentsMd: this.agentsMd, guardrails: this.guardrails, tracer: this.tracer,
      topic: this.topic, checkpoints: this.checkpoints, beads: this.beads, convoy: this.convoy,
      refinery: this.refinery, filemap: this.filemap, sop: this.sop,
      emit: this.emit, stateDir: this.stateDir,
    });
    const events = readJsonl(this.ledgerFile).filter((e) => e.seq <= atSeq);
    f.seq = atSeq;
    for (const e of events) appendJsonl(f.ledgerFile, e);
    if (this.checkpoints) this.checkpoints.fork(this.id, atSeq, f.id);
    f.persist();
    return { fleet: f.id, seq: atSeq };
  }

  progress(worker, nodeId, msg) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.status = 'running';
    node.lastProgress = ts();
    const sig = sha(String(msg).toLowerCase().replace(/\d+/g, '#').trim());
    node.sigs = node.sigs || [];
    node.sigs.push(sig);
    if (node.sigs.length > 8) node.sigs.shift();
    const dup = node.sigs.filter((s) => s === sig).length;
    if (dup >= 3) {
      node.stallCount = (node.stallCount || 0) + 1;
      if (node.stallCount >= 2) return this.fail(worker, nodeId, { error: 'stalled: 连续重复同一步（MAST 里步骤重复占 17.14%）', retryable: true });
    }
    this.ev('node.progress', { id: nodeId, msg: truncate(msg, 300), dup });
  }

  submit(worker, nodeId, result = {}) {
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, error: 'no_such_node' };
    const ok = result.status === 'failed' ? false : true;
    if (!ok) return this.fail(worker, nodeId, { error: result.error || 'worker_reported_failure', retryable: result.retryable !== false });

    node.result = {
      summary: String(result.summary || '').slice(0, 8000),
      evidence: (result.evidence || []).slice(0, 30),
      artifacts: (result.artifacts || []).slice(0, 50),
      confidence: result.confidence == null ? 0.7 : +result.confidence,
      files: result.files || [],
    };
    node.status = 'done';
    node.doneAt = ts();
    node.lease = null;
    const tokens = result.tokens || estTokens(node.result.summary);
    this.budget.spend({ tokens, cost: result.cost || 0 });
    this.ev('node.done', { id: node.id, persona: node.persona, tokens, confidence: node.result.confidence, summary: truncate(node.result.summary, 400) });
    // v3: 交付即结算 —— 槽位释放 + 确定性 hook + Gas Town bead 自动关闭 + LangGraph checkpoint
    if (this.runtime) this.runtime.releaseThread(`${this.id}/${node.id}`);
    if (this.hooks) this.hooks.fire('TaskCompleted', { fleetId: this.id, node: publicNode(node), tokens, confidence: node.result.confidence });
    if (node.beadId) this.closeBead(node.beadId, 'closed');
    if (this.checkpoints) { this.cpSeq = (this.cpSeq || 0) + 1; this.checkpoints.write(this.id, this.cpSeq, { nodes: [...this.nodes.values()].map((n) => ({ id: n.id, status: n.status, kind: n.kind, persona: n.persona })) }, this.readyNodes().map((n) => n.id)); }
    this.board.put({ type: 'artifact', body: node.result.summary, author: node.persona, node: node.id, confidence: node.result.confidence });

    // 动态展开：规划节点交回 packages 就直接长出新工作包
    if (Array.isArray(result.packages) && result.packages.length) {
      const kids = result.packages.map((p, i) => ({
        id: `${node.id}.${p.id || i + 1}`, role: 'execute', persona: p.persona || 'craftsman',
        mission: p.mission, acceptance: p.acceptance || node.acceptance, deps: [node.id], tier: p.tier || 'mid',
      }));
      this.addNodes(kids);
      for (const n of this.nodes.values()) if (n.dynamic && n.deps.includes(node.id)) { n.status = 'void'; this.ev('node.voided', { id: n.id, because: '被 packages 展开取代' }); }
      this.ev('plan.expanded', { parent: node.id, count: kids.length });
    }

    // 对抗验证展开
    if (node.kind === 'work' && this.verdict.verify && this.verdict.verify.on && !node.verifyDone && !node.verifyExpanding) {
      node.verifyExpanding = true;
      this.expandVerify(node);
      this.recompute();
      this.persist();
      return { ok: true, status: 'awaiting_verification' };
    }

    if (node.kind === 'challenge') { this.recompute(); this.persist(); return { ok: true }; }
    if (node.kind === 'adjudicate') return this.onAdjudication(node, result);

    this.recompute();
    this.persist();
    return { ok: true };
  }

  expandVerify(node) {
    const n = Math.max(1, (this.verdict.verify.n || 2));
    const challengers = [];
    const pool = this.personas.byCapability('adjudicate').map((c) => c.id);
    const personas = this.spec.challengers || ['redteam', 'auditor'];
    for (let i = 0; i < n; i++) {
      const cid = `v_${node.id}_${i + 1}`;
      challengers.push(cid);
      this.addNodes([{
        id: cid, kind: 'challenge', role: 'challenge', persona: personas[i % personas.length],
        deps: [node.id], blind: true, critiqueTarget: node.id, tier: this.verdict.ladder ? this.verdict.ladder[2] : 'high',
        mission: `【盲评】独立审查节点 ${node.id} 的交付物。你不知道别人怎么说，也不许猜。给出：缺陷清单（按致命度排序）+ 是否可接受(accept/reject) + 复现/证伪方法。被审对象：\n${truncate(node.result.summary, 3000)}`,
        acceptance: ['指出至少一个真实缺陷或明确说明为何无法证伪', '不得用"建议补充"这类空话充数'],
      }]);
    }
    this.addNodes([{
      id: `a_${node.id}`, kind: 'adjudicate', role: 'adjudicate', persona: this.verdict.verify.judge || 'judge',
      deps: challengers, adjudicates: node.id, tier: this.verdict.ladder ? this.verdict.ladder[2] : 'high',
      mission: `【裁决】原节点 ${node.id} 的交付 + ${challengers.length} 份互相看不见的盲评都在这。判定 accept / reject。reject 时必须给出"改什么才能过"的可执行清单。`,
      acceptance: ['必须给 accept 或 reject 之一', 'reject 时给出具体的修改指令，不是泛泛而谈'],
    }]);
    this.ev('verify.expanded', { target: node.id, challengers });
  }

  onAdjudication(node, result) {
    const target = this.nodes.get(node.adjudicates);
    const verdictWord = /reject|驳回|不通过/i.test(String(result.verdict || result.summary || '')) ? 'reject' : 'accept';
    node.status = 'done';
    node.result = { summary: truncate(result.summary || '', 2000), verdict: verdictWord };
    this.ev('verdict.recorded', { on: node.adjudicates, verdict: verdictWord, judge: node.persona, reason: truncate(result.summary, 400) });
    if (target) {
      target.verifyExpanding = false;
      if (verdictWord === 'reject' && (target.attempts || 0) <= (target.maxAttempts || MAX_ATTEMPTS_DEFAULT) - 1) {
        target.status = 'pending';
        target.critique = truncate(result.summary || '', 1500);
        this.ev('node.requeued', { id: target.id, because: '盲评驳回' });
      } else {
        target.verifyDone = true;
        target.verifyVerdict = verdictWord;
      }
    }
    this.recompute();
    this.persist();
    return { ok: true, verdict: verdictWord };
  }

  fail(worker, nodeId, { error = '', retryable = true } = {}) {
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false };
    node.lease = null;
    if (this.runtime) this.runtime.releaseThread(`${this.id}/${nodeId}`);
    if (this.hooks) this.hooks.fire('Error', { fleetId: this.id, node: publicNode(node), error: truncate(error, 400) });
    const max = node.maxAttempts || MAX_ATTEMPTS_DEFAULT;
    this.ev('node.failed', { id: node.id, worker: worker && worker.id, attempt: node.attempts, error: truncate(error, 400) });
    this.hooks && this.hooks.fire && this.hooks.fire('Error', { node: node.id, error: truncate(error, 400) });
    if (retryable && (node.attempts || 1) < max) {
      // 失败即升级模型层（cascade 的升级腿），退避后重排
      const up = TIER_LADDER[node.tier] || ['high'];
      node.tier = up[Math.min(up.length - 1, up.indexOf(node.tier) + 1)] || node.tier;
      node.status = 'pending';
      node.nextAt = ts() + Math.min(60000, 1200 * Math.pow(3, node.attempts - 1));
      this.ev('node.retried', { id: node.id, attempt: node.attempts, tier: node.tier, backoffMs: node.nextAt - ts() });
    } else {
      node.status = 'failed';
      this.board.put({ type: 'blocker', body: `${node.id} 失败：${truncate(error, 400)}`, author: node.persona || 'hub', node: node.id, confidence: 0.9 });
      this.ev('node.gaveup', { id: node.id, error: truncate(error, 400) });
    }
    this.recompute();
    this.persist();
    return { ok: true };
  }

  reap(nowMs = ts()) {
    let n = 0;
    for (const node of this.nodes.values()) {
      if ((node.status === 'leased' || node.status === 'running') && node.lease && node.lease.until < nowMs) {
        this.ev('node.lease_expired', { id: node.id, worker: node.lease.worker });
        node.status = 'pending';
        node.lease = null;
        n++;
      } else if (node.status === 'pending' && node.nextAt && node.nextAt <= nowMs && this.depsDone(node)) {
        node.status = 'ready';
        node.readyAt = nowMs;
      }
    }
    if (n) this.recompute();
    return n;
  }

  note(worker, rec) {
    const out = this.board.put(Object.assign({ author: (worker && worker.persona) || 'unknown' }, rec));
    if (!out.deduped) {
      this.ev('board.put', { id: out.id, type: out.type, author: out.author, node: out.node, tokens: out.tokens || estTokens(out.body || out.head || '') });
      if (worker && worker.persona) this.personas.remember(worker.persona, { fleet: this.id, node: rec.node || null, note: truncate(rec.body, 400) });
    }
    return out;
  }

  /** 全部收口了吗 */
  tick(nowMs = ts()) {
    this.reap(nowMs);
    const live = [...this.nodes.values()].filter((n) => ['pending', 'ready', 'leased', 'running', 'awaiting_approval'].includes(n.status));
    const failed = [...this.nodes.values()].filter((n) => n.status === 'failed');
    const rem = this.budget.remaining(nowMs);
    if (!rem.ok && this.status === 'active') {
      this.status = 'halted';
      this.ev('fleet.halted', { why: rem.why, budget: this.budget.snapshot() });
    } else if (!live.length && this.status === 'active') {
      this.status = failed.length ? 'degraded' : 'complete';
      this.ev('fleet.settled', { status: this.status, failed: failed.map((f) => f.id), nodes: this.nodes.size });
      this.persist();
    }
    return this.status;
  }

  stats() {
    const c = {};
    for (const n of this.nodes.values()) c[n.status] = (c[n.status] || 0) + 1;
    return {
      id: this.id, goal: truncate(this.spec.goal, 80), topology: this.verdict.topology, status: this.status,
      nodes: this.nodes.size, byStatus: c, budget: this.budget.snapshot(), board: this.board.stats(),
      ready: this.readyNodes().map((n) => n.id),
      running: [...this.nodes.values()].filter((n) => n.status === 'leased' || n.status === 'running').map((n) => ({ id: n.id, worker: n.lease && n.lease.worker, attempt: n.attempts })),
    };
  }
}

function normalizeNode(s, verdict) {
  return Object.assign({
    kind: 'work', role: 'execute', persona: 'craftsman', deps: [], status: 'pending',
    attempts: 0, maxAttempts: MAX_ATTEMPTS_DEFAULT, tier: (verdict.ladder && verdict.ladder[1]) || 'mid',
    acceptance: [], blind: false, sigs: [],
  }, s);
}

function publicNode(n) {
  return { id: n.id, kind: n.kind, role: n.role, persona: n.persona, tier: n.tier, acceptance: n.acceptance, mission: n.mission, blind: !!n.blind, attempt: n.attempts, deps: n.deps };
}

function skillsBlock(skills, node, spec, worker) {
  const cat = [...skills.catalog()].map((s) => `- ${s.id}: ${s.oneLine}`).join('\n');
  const matches = skills.match({ cwd: worker && worker.cwd, mission: node.mission, text: node.mission + ' ' + (spec.goal || '') });
  const tier1 = matches.slice(0, 3).map((m) => skills.loadTier1([m.skill.id])[0]).filter(Boolean);
  const tier1Block = tier1.length ? '\n【技能包（命中即加载）】\n' + tier1.map((s) => `### ${s.id}\n${truncate(s.content, 1200)}`).join('\n\n') : '';
  return `\n\n【可用技能目录】\n${cat}\n${tier1Block}`;
}

function workerCan(worker, node) {
  const caps = worker.caps || {};
  if (caps.roles && caps.roles.length && !caps.roles.includes('*')) {
    if (!caps.roles.includes(node.role) && !caps.roles.includes(node.kind)) return false;
  }
  if (caps.personas && caps.personas.length && !caps.personas.includes('*')) {
    if (!caps.personas.includes(node.persona)) return false;
  }
  if (caps.tiers && caps.tiers.length && !caps.tiers.includes('*')) {
    if (!caps.tiers.includes(node.tier)) return false;
  }
  if (node.kind === 'challenge' || node.kind === 'adjudicate') {
    if (caps.thinking === false) return false;
  }
  return true;
}

/** 列出磁盘上所有可续传的舰队 */
function scanPersisted(stateDir) {
  const dir = path.join(stateDir, 'snapshots');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; }
  }).filter(Boolean);
}

module.exports = { Fleet, LEASE_MS, normalizeNode, scanPersisted };
