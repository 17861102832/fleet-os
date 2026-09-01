'use strict';
/**
 * 舰队 MCP 服务器 v3（stdio JSON-RPC 2.0）—— Trae 会话本身就是一个舰员 + 指挥官面板。
 *
 * 两类角色同时挂在一个进程里：
 *   A. 指挥面板：plan/status/board/inject/abort/approve/reject/fork/replay/policy/rerank/jobs/hooks...
 *      —— 直接调用进程内 Hub（hub 未起则自动 ensureHub）
 *   B. 舰员通道：work/submit/note —— 走 WS 入列，Hub 派 lease，IDE 交回 deliver
 *
 * MCP 协议：initialize / tools/list / tools/call（newline-delimited JSON）
 */
const path = require('path');
const fs = require('fs');
const { loadConfig, ts, uid, truncate } = require('./util');
const { connect } = require('./ws');
const { Hub } = require('./hub');
const { gate } = require('./gate');

/* ── 工具注册表：一条声明 = 一条 admin op 或一条 WS 动作 ─────────── */
const TOOLS = [
  // 指挥面
  { name: 'fleet_plan', desc: '过 Spec Gate + 架构适配门后编排舰队（spec 为 JSON 对象）', props: { spec: 'object' }, kind: 'hub', fn: (hub, a) => { const g = gate(a.spec); if (!g.ok) return { error: 'spec_gate', errs: g.errs, tpl: g.tpl }; return hub.plan(a.spec); } },
  { name: 'fleet_status', desc: '全舰队状态（节点/预算/黑板/runtime/hook 统计）', props: { fleetId: 'string?' }, kind: 'hub', fn: (hub, a) => (a.fleetId ? hub.status(a.fleetId) : hub.snapshotState()) },
  { name: 'fleet_board', desc: '黑板相关性检索', props: { fleetId: 'string', query: 'string?', k: 'number?' }, kind: 'hub', fn: (hub, a) => hub.board(a.fleetId, { query: a.query, k: a.k }) },
  { name: 'fleet_inject', desc: '向节点注入指挥官指令（自动重排）', props: { fleetId: 'string', nodeId: 'string', text: 'string' }, kind: 'hub', fn: (hub, a) => hub.inject(a.fleetId, a.nodeId, a.text) },
  { name: 'fleet_abort', desc: '中止舰队或单节点', props: { fleetId: 'string', nodeId: 'string?' }, kind: 'hub', fn: (hub, a) => hub.abort(a.fleetId, a.nodeId) },
  { name: 'fleet_approve', desc: '批准 awaiting_approval 节点继续执行', props: { fleetId: 'string', nodeId: 'string', by: 'string?' }, kind: 'hub', fn: (hub, a) => hub.approve(a.fleetId, a.nodeId, a.by || 'mcp') },
  { name: 'fleet_reject', desc: '驳回 awaiting_approval 节点（可带理由）', props: { fleetId: 'string', nodeId: 'string', reason: 'string?' }, kind: 'hub', fn: (hub, a) => hub.reject(a.fleetId, a.nodeId, a.reason) },
  { name: 'fleet_pending', desc: '列出全部舰队中的人工审批积压', props: {}, kind: 'hub', fn: (hub) => hub.pendingApprovals() },
  { name: 'fleet_replay', desc: '时间线回放：读舰队 append-only 账本', props: { fleetId: 'string', limit: 'number?' }, kind: 'hub', fn: (hub, a) => hub.replay(a.fleetId, { limit: a.limit }) },
  { name: 'fleet_fork', desc: 'time-travel fork：在某 seq 处分叉新舰队', props: { fleetId: 'string', atSeq: 'number' }, kind: 'hub', fn: (hub, a) => hub.fork(a.fleetId, a.atSeq) },
  { name: 'fleet_policy_check', desc: '中央策略闸：工具动作 allow/ask/deny + 审计', props: { tool: 'string', actor: 'string?' }, kind: 'hub', fn: (hub, a) => hub.policyCheck({ tool: a.tool }, { actor: a.actor || 'mcp' }) },
  { name: 'fleet_rerank', desc: 'cascade verifier 对候选交付重排取最优', props: { candidates: 'array', q: 'string?' }, kind: 'hub', fn: (hub, a) => hub.routerSelect({ candidates: a.candidates, q: a.q }) },
  { name: 'fleet_guardrail', desc: '跑一档 guardrail（input/output/tool）', props: { kind: 'string', payload: 'object' }, kind: 'hub', fn: async (hub, a) => { try { const r = hub.guardrails; if (a.kind === 'input') await r.runInput(a.payload, {}); else if (a.kind === 'output') await r.runOutput(a.payload, {}); else await r.runTool(a.payload, {}); return { ok: true }; } catch (e) { return { ok: false, tripwire: true, name: e.name, message: e.message }; } } },
  { name: 'fleet_skills', desc: '技能目录（tier-0 清单 + tier-1 命中预览）', props: { mission: 'string?', cwd: 'string?' }, kind: 'hub', fn: (hub, a) => ({ catalog: hub.skillsCatalog(), matched: a.mission ? hub.skills.match({ cwd: a.cwd || process.cwd(), mission: a.mission }).map((m) => ({ id: m.skill.id, score: m.score })) : [] }) },
  { name: 'fleet_roles', desc: '角色契约列表', props: {}, kind: 'hub', fn: (hub) => hub.rolesList() },
  { name: 'fleet_personas', desc: '已注册人格', props: {}, kind: 'hub', fn: (hub) => hub.personaList() },
  { name: 'fleet_adopt_expert', desc: '从专家团角色卡铸舰员人格', props: { file: 'string', id: 'string?', role: 'string?', stance: 'string?', adversarial: 'boolean?' }, kind: 'hub', fn: (hub, a) => hub.adoptExpert(a.file, { id: a.id, role: a.role, stance: a.stance, adversarial: a.adversarial }) },
  { name: 'fleet_hook_fire', desc: '向确定性自动化总线打一个事件', props: { name: 'string', payload: 'object?' }, kind: 'hub', fn: async (hub, a) => await (hub.hooks.fire(a.name, a.payload || {})) },
  { name: 'fleet_jobs', desc: 'async job store 快照（foreground/background）', props: {}, kind: 'hub', fn: (hub) => hub.jobs() },
  { name: 'fleet_beads', desc: 'Gas Town 任务账本（beads/convoy 进度）', props: {}, kind: 'hub', fn: (hub) => ({ beads: hub.beads.list().slice(-40), convoys: [...hub.convoy.index.values()] }) },
  { name: 'fleet_worktree', desc: '为节点开 git worktree（写入隔离）', props: { fleetId: 'string', nodeId: 'string', repo: 'string' }, kind: 'hub', fn: (hub, a) => hub.worktree(a.fleetId, a.nodeId, a.repo) },
  { name: 'fleet_merge', desc: 'Refinery 排队合并分支回主仓', props: { repo: 'string', branches: 'array' }, kind: 'hub', fn: (hub, a) => hub.merge(a.repo, a.branches) },
  { name: 'fleet_runtime', desc: '运行时边界快照（max_threads/max_depth/activeJobs）', props: {}, kind: 'hub', fn: (hub) => hub.runtime.snapshot() },
  { name: 'fleet_filemap', desc: 'repo-aware 符号摘要（token 预算内）', props: { cwd: 'string', focus: 'array?', budget: 'number?' }, kind: 'hub', fn: (hub, a) => hub.filemap.filemap({ cwd: a.cwd, focus: a.focus, budget: a.budget || 1200 }) },
  { name: 'fleet_trace', desc: '起一个 tracing span（观测不阻塞）', props: { name: 'string' }, kind: 'hub', fn: (hub, a) => { const s = hub.tracer.start(a.name, {}); s.end({ via: 'mcp' }); return { traceId: hub.tracer.currentTraceId }; } },
  // v4/v5 指挥面
  { name: 'fleet_subagents', desc: '列 Codex 三型子代理角色卡 / 生成一个 subagent 实例', props: { action: 'string?', type: 'string?', parentDepth: 'number?' }, kind: 'hub', fn: (hub, a) => (a.action === 'spawn' ? hub.subagent(a.type || 'default', { parentDepth: a.parentDepth || 0 }) : hub.subagentRoles()) },
  { name: 'fleet_handoff', desc: '跨舰队接力：A 只传产物指针+摘要给 B（token 隔离）', props: { source: 'string', dest: 'string', artifacts: 'array?', facts: 'array?', note: 'string?' }, kind: 'hub', fn: (hub, a) => hub.bus.handoff({ source: a.source, dest: a.dest, artifacts: a.artifacts, facts: a.facts, note: a.note }) },
  { name: 'fleet_deps', desc: '声明舰队间依赖（B 依赖 A settle 后才开跑）', props: { fleet: 'string', deps: 'array' }, kind: 'hub', fn: (hub, a) => hub.bus.dependsOn(a.fleet, a.deps) },
  { name: 'fleet_consume', desc: '舰队 B 拉取上游投递并写黑板（返回注入段）', props: { fleet: 'string' }, kind: 'hub', fn: (hub, a) => { const f = hub.fleets.get(a.fleet); return f ? hub.bus.consume(a.fleet, f.board) : { error: 'no_such_fleet' }; } },
  { name: 'fleet_bus_snap', desc: '跨舰队总线快照（orders/deps/peers）', props: {}, kind: 'hub', fn: (hub) => hub.bus.snapshot() },
  { name: 'fleet_perm_check', desc: '权限模式判定：bypass/acceptEdits/plan/default', props: { mode: 'string', tool: 'string' }, kind: 'hub', fn: (hub, a) => hub.permCheck({ mode: a.mode, tool: a.tool }) },
  { name: 'fleet_balancer', desc: '多 provider 负载均衡快照（健康/成本/模式）', props: {}, kind: 'hub', fn: (hub) => hub.balancer.snapshot() },
  { name: 'fleet_compile_stats', desc: '上下文压缩统计（黑板热/冷/压缩记录）', props: { fleetId: 'string' }, kind: 'hub', fn: async (hub, a) => { const f = hub.fleets.get(a.fleetId); if (!f) return { error: 'no_such_fleet' }; const c = f.compactor || new (require('./compactor').Compactor)({ stateDir: hub.cfg.stateDir }); return c.stats(f.board); } },
  { name: 'fleet_evolve', desc: '舰队 settle 后提炼技能基因（policies/genome/boost）', props: { fleetId: 'string' }, kind: 'hub', fn: (hub, a) => hub.applyEvolve(a.fleetId) },
  { name: 'fleet_evolve_list', desc: '已提炼的进化产物文件列表', props: {}, kind: 'hub', fn: (hub) => hub.evolveArtifacts() },
  { name: 'fleet_team_join', desc: 'Agent Teams：注册同层舰员（peer 互喂证据）', props: { fleet: 'string', persona: 'string' }, kind: 'hub', fn: (hub, a) => hub.bus.joinTeam(a.fleet, a.persona) },
  { name: 'fleet_peer_ping', desc: '同层舰员互喂已验证证据（接收方仍过盲评）', props: { fleet: 'string', from: 'string', to: 'string', evidence: 'array?', note: 'string?' }, kind: 'hub', fn: (hub, a) => hub.bus.peerPing({ fleetId: a.fleet, from: a.from, to: a.to, evidence: a.evidence, note: a.note }) },
  // 舰员面（走 WS）
  { name: 'fleet_work', desc: '本会话作为舰员拉一个 lease（返回完整作战上下文）', props: { fleetId: 'string?' }, kind: 'ws', op: 'work' },
  { name: 'fleet_submit', desc: '舰员交付物回流', props: { fleetId: 'string', nodeId: 'string', result: 'object' }, kind: 'ws', op: 'submit' },
  { name: 'fleet_note', desc: '写黑板（fact/claim/artifact/question/blocker/decision/critique/lesson）', props: { fleetId: 'string', record: 'object' }, kind: 'ws', op: 'note' },
];

class MCP {
  constructor() {
    this.hub = null;
    this.conn = null;
    this.heldJob = null;
    this.cfgPath = process.env.FLEET_CONFIG || path.join(__dirname, '..', 'fleet.config.json');
  }

  async run() {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this.dispatch(line); } });
    process.stdin.on('end', () => process.exit(0));
    this.log('mcp v6 ready · tools=' + TOOLS.length);
  }

  log(...a) { try { fs.appendFileSync(path.join(__dirname, '..', 'state', 'log', 'mcp.log'), `[${new Date().toISOString()}] ${a.join(' ')}\n`); } catch (_) {} }

  async ensureHub() {
    if (this.hub && !this.hub.__dead) return this.hub;
    const cfg = loadConfig(this.cfgPath);
    this.hub = new Hub(cfg);
    try { this.hub.start(); } catch (_) {}
    return this.hub;
  }

  async ensureConn() {
    if (this.conn && this.conn.alive) return this.conn;
    const cfg = loadConfig(this.cfgPath);
    for (let t = 0; t < 6; t++) {
      try { this.conn = await connect(`ws://${cfg.host}:${cfg.port}`); break; } catch (_) { await new Promise((r) => setTimeout(r, 400)); }
    }
    if (!this.conn || !this.conn.alive) throw new Error('hub_unreachable（先起 hub 或检查端口）');
    this.conn.on('message', (m) => this.onWs(m));
    this.conn.on('dead', () => { this.conn = null; });
    this.conn.send({
      t: 'hello', name: process.env.FLEET_MCP_NAME || 'trae-ide', kind: 'ide',
      caps: { roles: ['*'], personas: ['*'], tiers: ['*'] },
      slots: 1, provider: 'ide', model: 'trae', persona: process.env.FLEET_MCP_PERSONA || 'craftsman',
      cwd: process.env.FLEET_MCP_CWD || process.cwd(),
    });
    return this.conn;
  }

  onWs(m) {
    if (m.t === 'lease' && !this.heldJob) this.heldJob = m;
    if (m.t === 'ack' && this.__ackResolve) { const r = this.__ackResolve; this.__ackResolve = null; r(m); }
    if (m.t === 'admin_result' && this.__adminWait && m.id === this.__adminWait.id) { const r = this.__adminWait.resolve; this.__adminWait = null; r(m); }
  }

  wsRequest(payload, timeoutMs = 12000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.__ackResolve = null; resolve({ t: 'timeout' }); }, timeoutMs);
      this.__ackResolve = (m) => { clearTimeout(timer); resolve(m); };
      this.conn.send(payload);
    });
  }

  async dispatch(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    if (msg.method === 'notifications/initialized' || (!('id' in msg))) return;
    try {
      const out = await this.call(msg.method, (msg.params) || {});
      const res = { jsonrpc: '2.0', id: msg.id, result: out };
      process.stdout.write(JSON.stringify(res) + '\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e.message || e) } }) + '\n');
    }
  }

  async call(method, params) {
    if (method === 'initialize') {
      return { protocolVersion: '2024-11-05', serverInfo: { name: 'fleet-mcp', version: '6.0.0' }, capabilities: { tools: {} } };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') {
      return { tools: TOOLS.map((t) => ({ name: t.name, description: t.desc, inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(t.props).map(([k, v]) => [k, { type: String(v).replace('?', ''), description: String(v) }])) } })) };
    }
    if (method === 'tools/call') {
      const t = TOOLS.find((x) => x.name === params.name);
      if (!t) throw new Error('unknown_tool:' + params.name);
      const args = coerce(t, params.arguments || {});
      let data;
      if (t.kind === 'hub') { const hub = await this.ensureHub(); data = await t.fn(hub, args); }
      else { data = await this.wsCall(t, args); }
      const text = JSON.stringify(slim(data), null, 1);
      return { content: [{ type: 'text', text: text.length > 60000 ? text.slice(0, 60000) + '…[truncated]' : text }], isError: !!(data && data.error) };
    }
    throw new Error('unknown_method:' + method);
  }

  async wsCall(t, args) {
    const conn = await this.ensureConn();
    if (t.op === 'work') {
      for (let i = 0; i < 10 && !this.heldJob; i++) { conn.send({ t: 'claim', fleet: args.fleetId || null }); await new Promise((r) => setTimeout(r, 500)); }
      const job = this.heldJob; this.heldJob = null;
      return job ? { ok: true, ...job } : { ok: false, error: 'no_job', hint: '无 ready 节点或槽位被占，先看 fleet_status' };
    }
    if (t.op === 'submit') { conn.send({ t: 'submit', fleet: args.fleetId, node: args.nodeId, result: args.result }); return await this.awaitAck(); }
    if (t.op === 'note') { conn.send({ t: 'note', fleet: args.fleetId, record: args.record }); return await this.awaitAck(); }
    throw new Error('bad_ws_op');
  }

  awaitAck() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.__ackResolve = null; resolve({ ok: true, note: 'ack 超时（可能已入列）' }); }, 4000);
      this.__ackResolve = (m) => { clearTimeout(timer); resolve(m); };
    });
  }
}

/* 参数类型粗校 + 字符串 JSON 容错（很多模型会把 object/array 传成字符串） */
function coerce(t, raw) {
  const out = {};
  for (const [k, decl] of Object.entries(t.props)) {
    let v = raw[k];
    if (v === undefined) continue;
    const type = String(decl).replace('?', '');
    if (typeof v === 'string' && (type === 'object' || type === 'array')) { try { v = JSON.parse(v); } catch (_) {} }
    if (type === 'number' && v != null) v = +v;
    if (type === 'boolean' && typeof v === 'string') v = v === 'true';
    out[k] = v;
  }
  return out;
}
function slim(x) {
  if (Array.isArray(x)) return x.slice(0, 60).map(slim);
  if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) { const v = x[k]; o[k] = typeof v === 'string' && v.length > 4000 ? truncate(v, 4000) : (k === 'nodeDetail' && Array.isArray(v) ? v.slice(0, 200) : slim(v)); } return o; }
  return x;
}

if (require.main === module) {
  new MCP().run().catch((e) => { process.stderr.write(`fatal: ${e.message || e}\n`); process.exit(1); });
}

module.exports = { MCP, TOOLS };