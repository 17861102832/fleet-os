'use strict';
/**
 * 舰队协调中枢（Fleet Hub）
 * 一个进程 = 指挥舰。对外两套接口：
 *   - WebSocket（舰员领活儿/交活儿/写黑板/看直播）
 *   - HTTP（看板页面 + 只读状态，给浏览器和第三方工具）
 * MCP 服务器只是这个中枢的一个客户端，所以 Trae 会话本身也能作为一个舰员入列。
 */
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const { createServer, attachWss } = require('./ws');
const { loadConfig, ts, now, uid, writeFileSafe, ensureDir, truncate, readJsonl } = require('./util');
const { Fleet, scanPersisted } = require('./state');
const { PersonaRegistry } = require('./persona');
const topology = require('./topology');
const { Gate } = require('./limits');
const gitx = require('./git');
const { RoleRegistry } = require('./role');
const { HookBus } = require('./hooks');
const { SkillsIndex, RepoMap } = require('./skills');
const { PolicyGate } = require('./policy');
const { CascadeRouter } = require('./routing');
const { JobStore } = require('./jobstore');
const { RuntimeLimits } = require('./runtime');
const { SubagentManager } = require('./subagents');
const { EvolutionEngine } = require('./evolve');
const { FleetBus } = require('./fleetbus');
const { Permissions } = require('./permissions');
const { Balancer } = require('./balancer');
const { AgentsMd } = require('./agents-md');
const { Guardrails } = require('./guardrails');
const { Tracer, traceId: newTraceId } = require('./tracing');
const { TopicBus, RoutedAgent } = require('./topic');
const { Command, send, fanoutFromSends, CheckpointStore } = require('./langgraph');
const { Beads, Convoy, Refinery } = require('./gas-town');
const { FileMap } = require('./filemap');
const { SOPGraph } = require('./sop');
const { runTurn, RunnerState, MaxTurnsExceeded } = require('./runner');

class Hub {
  constructor(cfg) {
    this.cfg = cfg;
    this.personas = new PersonaRegistry(cfg.personaDir);
    this.roles = new RoleRegistry(path.join(cfg.__root, 'roles'));
    this.hooks = new HookBus(path.join(cfg.logDir, 'hooks.jsonl'));
    this.skills = new SkillsIndex(path.join(cfg.__root, 'skills'));
    this.repoMap = new RepoMap(cfg.__root);
    this.policy = new PolicyGate({ stateDir: cfg.logDir ? path.dirname(cfg.logDir) : cfg.stateDir });
    this.router = new CascadeRouter({ tiers: cfg.tiers || ['eco', 'mid', 'high'] });
    this.jobs = new JobStore(path.join(cfg.stateDir, 'jobs'));
    this.runtime = new RuntimeLimits(cfg.runtime);
    this.subagents = new SubagentManager(cfg.personaDir, this.runtime);
    this.evolve = new EvolutionEngine(path.join(cfg.stateDir, 'evolve'));
    this.bus = new FleetBus(path.join(cfg.stateDir, 'fleetbus'));
    this.depSettled = new Set();   // 已 settle 的舰队 id（跨舰队依赖判定）
    this.balancer = new Balancer(cfg.providers || {}, { mode: cfg.balanceMode || 'round_robin' });
    this.agentsMd = new AgentsMd({ root: cfg.__root });
    this.guardrails = new Guardrails(path.join(cfg.stateDir, 'guardrails'));
    this.tracer = new Tracer(cfg.stateDir, { workflowName: 'fleet' });
    this.topic = new TopicBus(path.join(cfg.logDir, 'topic.jsonl'));
    this.checkpoints = new CheckpointStore(path.join(cfg.stateDir, 'checkpoints'));
    this.beads = new Beads(path.join(cfg.stateDir, 'beads'));
    this.convoy = new Convoy(path.join(cfg.stateDir, 'convoys'));
    this.refinery = new Refinery(path.join(cfg.stateDir, 'refinery'));
    this.filemap = new FileMap(cfg.__root);
    this.gate = new Gate(cfg);
    this.fleets = new Map();
    this.workers = new Map();
    this.conns = new Set();
    this.startedAt = ts();
    this.logFile = path.join(cfg.logDir, 'hub.log');
    this.activeLeases = 0;
    ensureDir(cfg.stateDir); ensureDir(cfg.logDir); ensureDir(cfg.artifactDir);
    this.wireHooks();
  }
  wireHooks() {
    this.hooks.on('SessionStart', ({ fleetId, spec }) => this.log('hook SessionStart', fleetId));
    this.hooks.on('SubagentStart', ({ node, worker }) => this.log('hook SubagentStart', node && node.id, worker));
    this.hooks.on('TaskCompleted', ({ node, tokens }) => this.log('hook TaskCompleted', node && node.id, tokens));
    this.hooks.on('Error', ({ node, error }) => this.log('hook Error', node && node.id, error));
    this.hooks.guard('PreToolUse', ({ tool }) => { const r = this.policy.check({ tool: tool || 'Bash(any)' }, { actor: 'hub.guard' }); return r.allow ? true : (this.log('guard PreToolUse 阻断', tool, r.reason), false); });
  }

  log(...a) {
    const line = `[${now()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
    try { fs.appendFileSync(this.logFile, line + '\n'); } catch (_) {}
    process.stdout.write(line + '\n');
  }

  emit(env) {
    // 舰队收口事件 → 自动触发自进化（无论来自 submit 触发还是 tick 强补）
    if (env && env.type === 'fleet.settled' && env.fleet) {
      try { this.applyEvolve(env.fleet); } catch (e) { this.log('evolve_error', env.fleet, String(e && e.message || e)); }
      this.depSettled.add(env.fleet);
    }
    for (const c of this.conns) {
      if (c.subs && (!env.fleet || c.subs === '*' || c.subs === env.fleet)) c.send({ t: 'event', env: { type: env.type, fleet: env.fleet, data: env.data, ts: env.ts, seq: env.seq } });
    }
  }

  resume() {
    for (const snap of scanPersisted(this.cfg.stateDir)) {
      if (snap.status !== 'active' && snap.status !== 'degraded' && !snap.resume) continue;
      if (snap.status !== 'active') continue;
      const f = new Fleet({
        id: snap.id, spec: snap.spec, verdict: snap.verdict, cfg: this.cfg,
        personas: this.personas, roles: this.roles, hooks: this.hooks, skills: this.skills,
        repoMap: this.repoMap, policy: this.policy, router: this.router, jobs: this.jobs,
        runtime: this.runtime, agentsMd: this.agentsMd, guardrails: this.guardrails, tracer: this.tracer,
        topic: this.topic, checkpoints: this.checkpoints, beads: this.beads, convoy: this.convoy,
        refinery: this.refinery, filemap: this.filemap, sop: this.sop,
        emit: (e) => this.emit(e), stateDir: this.cfg.stateDir, resumeFrom: snap,
      });
      this.fleets.set(f.id, f);
      this.log('resumed fleet', f.id, f.status, `${f.nodes.size} nodes`);
    }
  }

  // ── 指挥命令 ─────────────────────────────────────────────
  plan(spec) {
    const verdict = topology.assess(spec);
    const id = spec.fleet || uid('fleet');
    if (this.fleets.has(id)) throw new Error('fleet_exists:' + id);
    const f = new Fleet({
      id, spec, verdict, cfg: this.cfg, personas: this.personas, roles: this.roles,
      hooks: this.hooks, skills: this.skills, repoMap: this.repoMap, policy: this.policy,
      router: this.router, jobs: this.jobs, runtime: this.runtime, agentsMd: this.agentsMd,
      guardrails: this.guardrails, tracer: this.tracer, topic: this.topic, checkpoints: this.checkpoints,
      beads: this.beads, convoy: this.convoy, refinery: this.refinery, filemap: this.filemap, sop: this.sop,
      emit: (e) => this.emit(e), stateDir: this.cfg.stateDir,
    });
    const nodes = topology.compile(spec, verdict);
    f.ev('fleet.created', { goal: spec.goal, verdict: { topology: verdict.topology, fanout: verdict.fanout, verify: verdict.verify, fit: verdict.fit }, warnings: verdict.warnings });
    if (this.hooks) this.hooks.fire('SessionStart', { fleetId: id, spec });
    // v3: 建个 convoy 跟整舰
    if (this.convoy) f.trackConvoy(spec.goal || 'fleet', nodes.map((n) => n.id));
    if (Array.isArray(spec.deps) && spec.deps.length) { this.bus.dependsOn(id, spec.deps); this.log(`depends ${id} on ${spec.deps.join(',')}`); }
    if (spec.permissionMode) f.permissionMode = spec.permissionMode;
    f.addNodes(nodes);
    f.persist();
    this.fleets.set(id, f);
    this.log(`planned ${id} topology=${verdict.topology} fanout=${verdict.fanout} nodes=${nodes.length} runtime=${JSON.stringify(f.runtime.snapshot())}`);
    return { fleet: id, verdict, nodes: nodes.map((n) => n.id) };
  }

  status(fleetId) {
    if (!fleetId) return [...this.fleets.values()].map((f) => f.stats());
    const f = this.fleets.get(fleetId);
    if (!f) return { error: 'no_such_fleet' };
    return Object.assign(f.stats(), {
      warnings: f.verdict.warnings, reasons: f.verdict.reasons,
      nodes: [...f.nodes.values()].map((n) => ({
        id: n.id, kind: n.kind, role: n.role, persona: n.persona, status: n.status, tier: n.tier,
        attempt: n.attempts, worker: n.lease && n.lease.worker, cp: n.cp,
        summary: n.result ? truncate(n.result.summary, 200) : null,
        verdict: n.verifyVerdict || (n.result && n.result.verdict) || null,
      })),
    });
  }

  board(fleetId, { query = '', k = 20 } = {}) {
    const f = this.fleets.get(fleetId);
    if (!f) return { error: 'no_such_fleet' };
    const recs = query ? f.board.query({ text: query, k, tokenBudget: 1e9 }) : f.board.records.slice(-k);
    return recs.map((r) => ({ type: r.type, author: r.author, node: r.node, head: truncate(r.body || r.head || '', 600), artifact: r.artifact || null }));
  }

  inject(fleetId, nodeId, text) {
    const f = this.fleets.get(fleetId);
    if (!f) return { error: 'no_such_fleet' };
    const n = f.nodes.get(nodeId);
    if (!n) return { error: 'no_such_node' };
    n.critique = ((n.critique || '') + '\n[指挥官指令] ' + text).trim();
    if (n.status === 'done') { n.status = 'pending'; n.attempts = Math.max(0, n.attempts - 1); }
    f.ev('directive.injected', { id: nodeId, text: truncate(text, 500) });
    f.recompute(); f.persist();
    return { ok: true };
  }

  abort(fleetId, nodeId) {
    const f = this.fleets.get(fleetId);
    if (!f) return { error: 'no_such_fleet' };
    if (nodeId) {
      const n = f.nodes.get(nodeId);
      if (!n) return { error: 'no_such_node' };
      n.status = 'void'; n.lease = null;
      f.ev('node.voided', { id: nodeId, because: '指挥官中止' });
    } else {
      f.status = 'aborted';
      for (const n of f.nodes.values()) if (n.status !== 'done') { n.status = 'void'; n.lease = null; }
      f.ev('fleet.aborted', {});
    }
    f.persist();
    return { ok: true };
  }

  adoptExpert(file, overrides) {
    return this.personas.adoptExpert(file, overrides || {});
  }

  personaList() { return this.personas.list().map((c) => ({ id: c.id, callsign: c.callsign, role: c.role, capabilities: c.capabilities, adversarial: !!c.adversarial })); }
  rolesList() { return this.roles.list(); }
  skillsCatalog() { return [...this.skills.catalog()].map((s) => ({ id: s.id, oneLine: s.oneLine, tier1Bytes: s.tier1Bytes })); }

  /** v2 helpers */
  fork(fleetId, atSeq) { const f = this.fleets.get(fleetId); if (!f) return { error: 'no_such_fleet' }; return f.fork({ atSeq }); }
  adoptRole(role) { this.roles.roles.set(role.id, role); return role; }
  adoptSkillAt() { this.skills.reload(); return [...this.skills.skills.values()]; }
  hookFire(name, payload) { return this.hooks.fire(name, payload); }
  policyCheck(action, ctx) { return this.policy.check(action, ctx); }
  jobs() { return this.jobs.snapshot(); }
  routerSelect({ candidates, q }) { const V = require('./routing').Verifier; return this.router.rerank({ candidates, verifier: new V(), q }); }

  /** v3 审批流：跨舰队 approve / reject / 积压一览 */
  approve(fleetId, nodeId, by) { const f = this.fleets.get(fleetId); return f ? f.approve(nodeId, by) : { error: 'no_such_fleet' }; }
  reject(fleetId, nodeId, reason, by) { const f = this.fleets.get(fleetId); return f ? f.reject(nodeId, reason, by) : { error: 'no_such_fleet' }; }
  pendingApprovals() { return [...this.fleets.values()].flatMap((f) => f.awaiting().map((n) => Object.assign({ fleet: f.id }, n))); }
  worktree(fleetId, nodeId, repo) { const f = this.fleets.get(fleetId); if (!f) return { error: 'no_such_fleet' }; return gitx.ensureWorktree({ repo: repo || (f.spec && f.spec.repo) || process.cwd(), baseDir: path.join(this.cfg.stateDir, 'worktrees', fleetId), nodeId }); }
  merge(repo, branches) { return gitx.mergeQueue({ repo, branches: branches || [] }); }
  subagent(type, overrides) { return this.subagents.spawn(type, overrides || { fleet: 'hub' }); }
  subagentRoles() { return this.subagents.list(); }
  evolveArtifacts() { return this.evolve.peek(); }
  permCheck({ mode, tool, workdir }, overrides) {
    const o = overrides || {};
    const perm = new Permissions({ mode: o.mode || mode || 'default' });
    const r = perm.check({ tool: tool || 'Read', workdir });
    if (!r.allow && r.needHuman) return { allow: false, reason: 'awaiting_human', mode: perm.mode, detail: r.reason };
    return { allow: r.allow, mode: perm.mode, reason: r.reason || null };
  }
  /** 舰队 settle 后自动提炼技能基因（自进化闭环） */
  applyEvolve(fleetId) {
    const f = this.fleets.get(fleetId);
    if (!f) return { error: 'no_such_fleet' };
    const out = this.evolve.run(f);
    this.log('evolved', fleetId, { policies: out.policies.length, genome: out.genome.length, boost: out.boost.length });
    return { ok: true, ...out };
  }
  replay(fleetId, { limit = 400 } = {}) {
    const f = this.fleets.get(fleetId);
    if (f) return f.replay({ limit });
    const file = path.join(this.cfg.stateDir, 'ledger', `${fleetId}.jsonl`);
    return readJsonl(file).slice(-limit);
  }

  // ── WS 协议 ──────────────────────────────────────────────
  onConn(conn, req) {
    this.conns.add(conn);
    const url = new URL(req.url, 'http://x');
    conn.subs = url.searchParams.get('fleet') || '*';
    conn.on('message', (m) => { try { this.onMsg(conn, m); } catch (e) { conn.send({ t: 'error', error: String(e.message || e) }); } });
    conn.on('dead', () => {
      this.conns.delete(conn);
      if (conn.workerId) {
        const w = this.workers.get(conn.workerId);
        if (w) { this.log('worker offline', w.name); w.online = false; for (const id of [...w.busy]) this.releaseLease(id, w); }
      }
    });
  }

  releaseLease(nodeKey, w) {
    const [fid, nid] = nodeKey.split('/');
    const f = this.fleets.get(fid);
    if (!f) return;
    const n = f.nodes.get(nid);
    if (!n || (n.status !== 'leased' && n.status !== 'running')) { w.busy.delete(nodeKey); this.activeLeases = Math.max(0, this.activeLeases - 1); return; }
    f.fail(w, nid, { error: 'worker_offline', retryable: true });
    w.busy.delete(nodeKey);
    this.activeLeases = Math.max(0, this.activeLeases - 1);
  }

  onMsg(conn, m) {
    switch (m.t) {
      case 'hello': {
        conn.workerId = m.workerId || uid('w');
        const w = {
          id: conn.workerId, name: m.name || 'anon', kind: m.kind || 'api', conn,
          caps: Object.assign({ roles: ['*'], personas: ['*'], tiers: ['*'] }, m.caps || {}),
          provider: m.provider || null, model: m.model || null, persona: m.persona || null,
          slots: Math.max(1, +m.slots || this.cfg.limits.perWorkerSlots || 4),
          cwd: m.cwd || process.cwd(),
          busy: new Set(), online: true, seenAt: ts(), done: 0, failed: 0, tokens: 0,
          lastWin: null,
        };
        this.workers.set(w.id, w);
        conn.send({ t: 'welcome', workerId: w.id, hub: { fleets: this.fleets.size, workers: this.workers.size, cfg: { boardTokens: this.cfg.boardTokens, maxConcurrent: this.cfg.limits.maxConcurrent } } });
        this.log('worker online', w.name, w.kind, `slots=${w.slots}`);
        return;
      }
      case 'claim': {
        const w = this.workers.get(conn.workerId); if (!w) return conn.send({ t: 'error', error: 'no_hello' });
        w.seenAt = ts();
        const got = this.tryAssign(w, m.fleet);
        conn.send(got ? { t: 'lease', ...got } : { t: 'noop', reason: got === null ? 'no_ready_node' : 'gated' });
        return;
      }
      case 'progress': {
        const w = this.workers.get(conn.workerId); if (!w) return;
        const f = this.fleets.get(m.fleet); if (!f) return;
        f.progress(w, m.node, m.msg); f.persist();
        return;
      }
      case 'submit': {
        const w = this.workers.get(conn.workerId); if (!w) return conn.send({ t: 'error', error: 'no_hello' });
        const f = this.fleets.get(m.fleet); if (!f) return conn.send({ t: 'error', error: 'no_such_fleet' });
        const r = f.submit(w, m.node, m.result || {});
        const key = `${m.fleet}/${m.node}`;
        if (w.busy.has(key)) { w.busy.delete(key); this.activeLeases = Math.max(0, this.activeLeases - 1); }
        w.done += 1; w.tokens += (m.result && m.result.tokens) || 0;
        f.persist();
        conn.send({ t: 'ack', op: 'submit', node: m.node, ...r });
        return;
      }
      case 'fail': {
        const w = this.workers.get(conn.workerId); if (!w) return;
        const f = this.fleets.get(m.fleet); if (!f) return;
        f.fail(w, m.node, { error: m.error, retryable: m.retryable !== false });
        const key = `${m.fleet}/${m.node}`;
        if (w.busy.has(key)) { w.busy.delete(key); this.activeLeases = Math.max(0, this.activeLeases - 1); }
        w.failed += 1;
        f.persist();
        conn.send({ t: 'ack', op: 'fail', node: m.node });
        return;
      }
      case 'note': {
        const w = this.workers.get(conn.workerId); if (!w) return;
        const f = this.fleets.get(m.fleet); if (!f) return;
        conn.send({ t: 'ack', op: 'note', rec: f.note(w, m.record) });
        f.persist();
        return;
      }
      case 'read': {
        const f = this.fleets.get(m.fleet);
        conn.send({ t: 'board', records: f ? this.board(m.fleet, m) : [] });
        return;
      }
      case 'watch': { conn.subs = m.fleet || '*'; conn.send({ t: 'ack', op: 'watch', subs: conn.subs }); return; }
      case 'admin': return this.admin(conn, m);
      case 'ping': return conn.send({ t: 'pong', at: ts() });
      default: return conn.send({ t: 'error', error: 'unknown_t:' + m.t });
    }
  }

  admin(conn, m) {
    try {
      let data = null;
      switch (m.op) {
        case 'plan': data = this.plan(m.spec); break;
        case 'status': data = this.status(m.fleet); break;
        case 'board': data = this.board(m.fleet, m); break;
        case 'inject': data = this.inject(m.fleet, m.node, m.text); break;
        case 'abort': data = this.abort(m.fleet, m.node); break;
        case 'list': data = { fleets: [...this.fleets.values()].map((f) => f.stats()), workers: [...this.workers.values()].filter((w) => w.online).map((w) => ({ id: w.id, name: w.name, kind: w.kind, model: w.model, busy: w.busy.size, done: w.done, persona: w.persona })) }; break;
        case 'replay': data = this.replay(m.fleet, m); break;
        case 'personas': data = this.personaList(); break;
        case 'adopt_expert': data = this.adoptExpert(m.file, m.overrides); break;
        case 'note': { const f = this.fleets.get(m.fleet); data = f ? f.note({ persona: m.author || 'commander' }, m.record) : { error: 'no_such_fleet' }; break; }
        case 'worktree': { const f = this.fleets.get(m.fleet); data = f ? gitx.ensureWorktree({ repo: m.repo, baseDir: path.join(this.cfg.stateDir, 'worktrees', m.fleet), nodeId: m.node }) : { error: 'no_such_fleet' }; break; }
        case 'subagent': data = this.subagent(m.type, m.overrides); break;
        case 'subagent_roles': data = this.subagentRoles(); break;
        case 'evolve': data = this.applyEvolve(m.fleet); break;
        case 'evolve_list': data = this.evolveArtifacts(); break;
        case 'handoff': data = this.bus.handoff({ source: m.source, dest: m.dest, artifacts: m.artifacts, facts: m.facts, note: m.note }); break;
        case 'deps': data = this.bus.dependsOn(m.fleet, m.deps); break;
        case 'consume': { const f = this.fleets.get(m.fleet); data = f ? this.bus.consume(m.fleet, f.board) : { error: 'no_such_fleet' }; break; }
        case 'join_team': data = this.bus.joinTeam(m.fleet, m.persona); break;
        case 'peer_ping': data = this.bus.peerPing({ fleetId: m.fleet, from: m.from, to: m.to, evidence: m.evidence, note: m.note }); break;
        case 'peer_inbox': data = this.bus.peerInbox(m.fleet, m.persona); break;
        case 'bus_snap': data = this.bus.snapshot(); break;
        case 'perm': data = this.permCheck(m, { mode: m.mode, tool: m.tool, workdir: m.workdir }); break;
        case 'balancer': data = this.balancer.snapshot(); break;
        case 'balance_report': { const name = m.provider; const r = this.balancer.report(name, m.ok !== false, m.err); data = { ok: true, health: this.balancer.health.get(name) }; break; }
        case 'merge': { data = gitx.mergeQueue({ repo: m.repo, branches: m.branches }); break; }
        case 'stats': data = this.snapshotState(); break;
        case 'approve': data = this.approve(m.fleet, m.node, m.by); break;
        case 'reject': data = this.reject(m.fleet, m.node, m.reason, m.by); break;
        case 'pending': data = this.pendingApprovals(); break;
        default: data = { error: 'unknown_op:' + m.op };
      }
      conn.send({ t: 'admin_result', op: m.op, ok: !(data && data.error), data });
    } catch (e) {
      conn.send({ t: 'admin_result', op: m.op, ok: false, error: String(e.message || e) });
    }
  }

  tryAssign(w, onlyFleet) {
    for (const f of this.fleets.values()) {
      if (f.status !== 'active') continue;
      if (onlyFleet && f.id !== onlyFleet) continue;
      // v4 跨舰队依赖门：B 依赖的 A 未 settle，则 B 不开跑
      const deps = this.bus.depsOf(f.id);
      if (deps.length && !deps.every((d) => this.depSettled.has(d))) continue;
      let guard = 0;
      while (w.busy.size < w.slots && guard++ < 4) {
        const ok = this.gate.tryAcquire({ provider: w.provider, workerSlots: w.busy.size, globalActive: this.activeLeases });
        if (!ok.ok) return null;
        const got = f.claim(w);
        if (!got) continue;
        w.busy.add(`${f.id}/${got.node.id}`);
        this.activeLeases++;
        if (f.spec.worktree) {
          const wt = gitx.ensureWorktree({ repo: f.spec.repo || process.cwd(), baseDir: path.join(this.cfg.stateDir, 'worktrees', f.id), nodeId: got.node.id });
          if (wt.worktree) got.context.workdir = wt.worktree;
          if (wt.branch) got.context.branch = wt.branch;
        }
        f.ev('node.assigned', { id: got.node.id, worker: w.name, workdir: got.context.workdir || null });
        f.persist();
        return { fleet: f.id, ...got };
      }
    }
    return null;
  }

  // ── 主循环 ──────────────────────────────────────────────
  start() {
    const server = createServer({
      port: this.cfg.port, host: this.cfg.host,
      onRequest: (req, res) => this.http(req, res, server),
    });
    attachWss(server, (conn, req) => this.onConn(conn, req));
    this.server = server;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        this.__portBusy = true;
        this.log('port busy — hub already running? ' + this.cfg.port);
        // 库代码无权杀宿主进程：单跑 CLI 时退出，被 require 时抛给调用方处理
        if (require.main === module) process.exit(0);
        const err = new Error('EADDRINUSE:' + this.cfg.port); err.code = 'EADDRINUSE'; server.emit('fatal_port', err);
        return;
      }
      throw e;
    });
    this.resume();
    this.timer = setInterval(() => this.tickAll(), this.cfg.tickMs || 300);
    this.log(`hub on http://${this.cfg.host}:${this.cfg.port} — ${this.personas.list().length} personas, ${[...this.fleets.values()].length} fleets resumed`);
    return server;
  }

  tickAll() {
    try {
      const t = ts();
      for (const f of this.fleets.values()) { const s = f.tick(t); if (s !== 'active') f.persist(); }
      for (const w of this.workers.values()) {
        if (!w.online) continue;
        while (w.busy.size < w.slots) {
          const got = this.tryAssign(w);
          if (!got) break;
          if (!w.conn.send({ t: 'lease', ...got })) { this.releaseLease(`${got.fleet}/${got.node.id}`, w); break; }
        }
      }
      // 强补充工：舰队节点全 done 但没收到 submit 触发的 settle 时，最后一轮显式 settle
      for (const f of this.fleets.values()) {
        if (f.status !== 'active') continue;
        const live = [...f.nodes.values()].filter((n) => ['pending','ready','leased','running','awaiting_approval'].includes(n.status));
        if (!live.length) {
          f.status = 'complete'; f.ev('fleet.settled', { status: 'complete', nodes: f.nodes.size }); f.persist();
          // 自进化闭环：舰队跑完立即提炼技能基因
          try { this.applyEvolve(f.id); } catch (e) { this.log('evolve_error', f.id, String(e && e.message || e)); }
        }
      }
    } catch (e) { this.log('tick_error', String(e && e.stack || e)); }
  }

  http(req, res, server) {
    const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    };
    if (u.pathname === '/health') return send(200, { ok: true, uptimeMs: ts() - this.startedAt, fleets: this.fleets.size, workers: this.workers.size });
    if (u.pathname === '/v1/state') return send(200, this.snapshotState());
    // v6.5: HTTP admin 通道 —— 供 dsh-fleet 插件 / 脚本用纯 HTTP 驱动舰队（与 WS admin 同一 op 协议）
    if (u.pathname === '/v1/admin' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
      req.on('end', async () => {
        try {
          const m = JSON.parse(raw || '{}');
          let result = null;
          const fakeConn = { send: (x) => { if (x && x.t === 'admin_result') result = x; } };
          this.admin(fakeConn, m);
          if (result && result.data && typeof result.data.then === 'function') result = { ...result, data: await result.data };
          send(result && result.ok ? 200 : 400, result);
        } catch (e) { send(400, { error: String(e.message || e) }); }
      });
      return;
    }
    if (u.pathname === '/v1/events') {
      const f = u.searchParams.get('fleet');
      return send(200, f ? this.replay(f, { limit: +(u.searchParams.get('limit') || 500) }) : { error: 'fleet required' });
    }
    if (u.pathname === '/' || u.pathname === '/board') {
      const file = path.join(__dirname, '..', 'public', 'board.html');
      return send(200, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '<pre>fleet hub ok</pre>', 'text/html');
    }
    return send(404, { error: 'not_found' });
  }

  snapshotState() {
    return {
      at: now(), uptimeMs: ts() - this.startedAt,
      limits: this.cfg.limits, activeLeases: this.activeLeases,
      runtime: this.runtime.snapshot(),
      hookStats: this.hooks.stats(),
      workers: [...this.workers.values()].map((w) => ({ id: w.id, name: w.name, kind: w.kind, model: w.model, provider: w.provider, persona: w.persona, online: w.online, slots: w.slots, busy: [...w.busy], done: w.done, failed: w.failed, tokens: w.tokens })),
      fleets: [...this.fleets.values()].map((f) => f.stats()),
      nodeDetail: [...this.fleets.values()].flatMap((f) => [...f.nodes.values()].map((n) => ({ fleet: f.id, id: n.id, kind: n.kind, persona: n.persona, status: n.status, tier: n.tier, attempt: n.attempts, verdict: n.verifyVerdict || null }))),
      personas: this.personaList(),
      roles: this.rolesList(),
      skills: this.skillsCatalog(),
      jobs: this.jobs.snapshot().slice(-30),
      convoys: [...this.convoy.index.values()].slice(-20),
      beads: this.beads.list().slice(-50),
      refineryPending: this.refinery.pending(),
      busSnap: this.bus.snapshot(),
      balancerSnap: this.balancer.snapshot(),
      evolveArtifacts: this.evolve.peek(),
    };
  }
}

if (require.main === module) {
  const cfg = loadConfig(process.argv[2]);
  const hub = new Hub(cfg);
  hub.start();
  const bye = () => { try { for (const f of hub.fleets.values()) f.persist(); } catch (_) {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { Hub };
