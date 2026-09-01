'use strict';
/**
 * e2e —— 五路实战验证：把「文档承诺」逐条变成「跑过的证据」。
 *   1) approval   policy ask + autoApprove:false → awaiting_approval → approve → complete
 *   2) coldresume 跑到一半 kill hub → 新进程 resume() → 断点续传到 complete
 *   3) apiworker  mock OpenAI 端点 + --mode=api → tool_call deliver 全链路
 *   4) cliworker  fake 外部 agent（代表 claude/codex/dsh）→ 竞品即组件
 *   5) worktree   临时 git 仓 → ensureWorktree → 分支提交 → mergeQueue 合回 main
 * 每路独立端口互不干扰。输出 ✓/✗，任一失败 exit≠0。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { Hub } = require('./hub');
const { Worker } = require('./worker');
const { loadConfig, uid, ts, ensureDir, writeFileSafe } = require('./util');
const gitx = require('./git');
const { Compactor } = require('./compactor');
const { Balancer } = require('./balancer');

const ROOT = path.join(__dirname, '..', 'state', 'e2e');
const results = [];
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail: detail || '' }); console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseConfig(port, extra = {}) {
  const cfg = Object.assign({
    host: '127.0.0.1', port, tickMs: 150, boardTokens: 500,
    personaDir: path.join(__dirname, '..', 'personas'),
    stateDir: path.join(ROOT, 'p' + port), artifactDir: path.join(ROOT, 'p' + port, 'artifacts'),
    logDir: path.join(ROOT, 'p' + port, 'log'),
    limits: { maxConcurrent: 16, perWorkerSlots: 8 },
    providers: {
      eco: { baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'eco', concurrency: { ratePerSec: 50, burst: 50 } },
      mid: { baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'mid', concurrency: { ratePerSec: 50, burst: 50 } },
      high: { baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'high', concurrency: { ratePerSec: 50, burst: 50 } },
    },
  }, extra);
  const file = path.join(ROOT, `cfg-${port}.json`);
  writeFileSafe(file, JSON.stringify(cfg, null, 2));
  return file;
}

async function settle(hub, fleetId, { timeoutMs = 15000, until } = {}) {
  const dead = ts() + timeoutMs;
  while (ts() < dead) {
    if (until) { const r = until(hub); if (r !== undefined && r !== false) return r; }
    const st = hub.status(fleetId);
    if (st && (st.status === 'complete' || st.status === 'degraded' || st.status === 'halted')) return st;
    await sleep(200);
  }
  return hub.status(fleetId);
}

/* ── 1) approval 状态机 ─────────────────────────────────────── */
async function e2eApproval() {
  const cfgFile = baseConfig(7801);
  const cfg = loadConfig(cfgFile);
  const hub = new Hub(cfg); hub.start();
  const r = hub.plan({
    goal: '审批演练：发布动作必须先过人',
    topology: 'solo',
    acceptance: ['交付物可验证'],
    autoApprove: false,                 // ← 关键：ask 真的暂停
    declaredTool: 'npm publish',        // ← 命中 no_publish(ask)
    budget: { maxTokens: 500000, maxWallMs: 20000 },
  });
  const w = new Worker({ mode: 'demo', name: 'apr-w', slots: 2 }, cfg);
  await w.start();
  // 等节点进入 awaiting_approval
  let awaited = false;
  const dead = ts() + 4000;
  while (ts() < dead) {
    const st = hub.status(r.fleet);
    if (st.nodes && st.nodes.some((n) => n.status === 'awaiting_approval')) { awaited = true; break; }
    await sleep(200);
  }
  ok('approval: ask 命中后节点真的暂停(awaiting_approval)', awaited);
  const pend = hub.pendingApprovals();
  ok('approval: pendingApprovals 能列出积压', pend.length >= 1, JSON.stringify(pend[0] || {}).slice(0, 120));
  const ap = hub.approve(r.fleet, pend[0] && pend[0].id, 'e2e');
  ok('approval: approve 返回 ok', ap && ap.ok === true);
  const st = await settle(hub, r.fleet);
  const doneN = st.byStatus && st.byStatus.done || 0;
  ok('approval: 批准后舰队跑到 complete', st.status === 'complete', `status=${st.status} done=${doneN}`);
  // reject 分支
  const r2 = hub.plan({ goal: '驳回演练', topology: 'solo', acceptance: ['x'], autoApprove: false, declaredTool: 'npm publish', budget: { maxTokens: 500000, maxWallMs: 20000 }, fleet: 'rejector' });
  let a2 = false;
  const d2 = ts() + 4000;
  while (ts() < d2) { const s = hub.status('rejector'); if (s.nodes && s.nodes.some((n) => n.status === 'awaiting_approval')) { a2 = true; break; } await sleep(200); }
  ok('approval: 第二个舰队也进入待审', a2);
  const rj = hub.reject('rejector', 'n1', 'e2e 演练驳回');
  const st2 = await settle(hub, 'rejector');
  ok('approval: reject 后节点判死且舰队降级收口', rj.ok && st2.status === 'degraded', `status=${st2.status}`);
  clearInterval(hub.timer); try { hub.server.close(); } catch (_) {} hub.workers.forEach((w2) => w2.conn && w2.conn.destroy()); hub.conns.forEach((c) => c.destroy());
  await sleep(300);
}

/* ── 2) 冷续传：kill hub → 新 Hub resume ───────────────────── */
async function e2eColdResume() {
  const cfgFile = baseConfig(7802);
  const cfg = loadConfig(cfgFile);
  const hub = new Hub(cfg); hub.start();
  const r = hub.plan({
    goal: '冷续传演练：跑一半杀掉再续',
    topology: 'fanout', fanout: 2,
    lanes: [{ persona: 'scout', mission: 'A 路' }, { persona: 'analyst', mission: 'B 路' }],
    acceptance: ['两路各自交付'],
    verify: { on: false },
    budget: { maxTokens: 500000, maxWallMs: 30000 },
  });
  // 不挂 worker：手动 submit 一个节点制造"半程状态"
  let leased = null;
  const d1 = ts() + 3000;
  while (ts() < d1 && !leased) {
    const got = hub.tryAssign({ id: 'hand', name: 'hand', slots: 1, busy: new Set(), caps: { roles: ['*'], personas: ['*'], tiers: ['*'] }, online: true, conn: { send: () => true, destroy() {} } }, r.fleet);
    if (got) leased = got;
    await sleep(100);
  }
  ok('coldresume: 手工领到一个节点', !!leased, leased && leased.node.id);
  if (leased) hub.fleets.get(r.fleet).submit({ id: 'hand' }, leased.node.id, { summary: '半程交付', confidence: 0.7, tokens: 100 });
  // kill：停循环 + 关端口 + 断连接，模拟进程死亡（snapshot 仍是 active）
  clearInterval(hub.timer);
  try { hub.server.close(); hub.server = null; } catch (_) {}
  hub.conns.forEach((c) => c.destroy());
  await sleep(150);
  // 冷启：新 Hub 读 snapshots 自动 resume
  const hub2 = new Hub(cfg); hub2.start();
  ok('coldresume: 新 hub 自动 resume 该舰队', hub2.fleets.has(r.fleet), `${hub2.fleets.size} fleets`);
  const stMid = hub2.status(r.fleet);
  ok('coldresume: 半程状态正确恢复（done≥1，leased 复位 pending）', stMid.byStatus && (stMid.byStatus.done || 0) >= 1 && !(stMid.byStatus.leased || 0), JSON.stringify(stMid.byStatus));
  const w = new Worker({ mode: 'demo', name: 'cr-w', slots: 2 }, cfg);
  await w.start();
  const st = await settle(hub2, r.fleet, { timeoutMs: 12000 });
  ok('coldresume: 续传后跑到 complete', st.status === 'complete', `status=${st.status} done=${st.byStatus && st.byStatus.done}`);
  clearInterval(hub2.timer); hub2.conns.forEach((c) => c.destroy());
  await sleep(100);
}

/* ── 3) api worker：真实执行器（runner loop）全链路 ─────────── */
function startMockLLM(port) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      let msg;
      if (calls === 1) {
        // turn 1: 模型先摸一下环境（Read）再写个文件（Write）
        msg = { content: '', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"readme.txt"}' } },
          { id: 'c2', type: 'function', function: { name: 'Write', arguments: '{"path":"answer.txt","content":"4"}' } },
        ] };
      } else if (calls === 2) {
        // turn 2: 主动 deliver
        msg = { content: '', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'deliver', arguments: JSON.stringify({ summary: 'mock runner: 2+2=4 并落盘 answer.txt', evidence: ['answer.txt'], confidence: 0.9, verdict: 'accept' }) } }] };
      } else {
        msg = { content: '', tool_calls: [{ id: 'c4', type: 'function', function: { name: 'deliver', arguments: JSON.stringify({ summary: 'mock runner extra', confidence: 0.7 }) } }] };
      }
      res.end(JSON.stringify({ choices: [{ message: msg }], usage: { total_tokens: 137 } }));
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}
async function e2eApiWorker() {
  const llm = startMockLLM(7899);
  const cfgFile = baseConfig(7803, {
    providers: {
      eco: { baseUrl: 'http://127.0.0.1:7899/v1', apiKey: 'test', model: 'mock', maxTokens: 256, maxTurns: 6, allowShell: false, concurrency: { ratePerSec: 20, burst: 20 } },
      mid: { baseUrl: 'http://127.0.0.1:7899/v1', apiKey: 'test', model: 'mock', maxTokens: 256, maxTurns: 6, allowShell: false, concurrency: { ratePerSec: 20, burst: 20 } },
      high: { baseUrl: 'http://127.0.0.1:7899/v1', apiKey: 'test', model: 'mock', maxTokens: 256, maxTurns: 6, allowShell: false, concurrency: { ratePerSec: 20, burst: 20 } },
    },
  });
  const cfg = loadConfig(cfgFile);
  const hub = new Hub(cfg); hub.start();
  const r = hub.plan({
    goal: 'api 链路演练：算 2+2 并落盘证据',
    topology: 'fanout', fanout: 2,
    lanes: [{ persona: 'solver', mission: '算 2+2 并写 answer.txt' }, { persona: 'judge', mission: '裁决 2+2 的答案' }],
    acceptance: ['给出数字'],
    verify: { on: false },
    budget: { maxTokens: 500000, maxWallMs: 20000 },
  });
  const w = new Worker({ mode: 'api', provider: 'mid', name: 'api-w', slots: 2 }, cfg);
  await w.start();
  const st = await settle(hub, r.fleet, { timeoutMs: 20000 });
  const done = st.nodes && st.nodes.filter((n) => n.status === 'done' && /runner/.test(n.summary || '')).length || 0;
  ok('api worker: runner loop 多轮 Read→Write→deliver 全链路', st.status === 'complete' && done >= 1, `status=${st.status} runner done=${done}`);
  // 落盘验证：answer.txt 真的被模型"写"出来了
  const artifacts = path.join(ROOT, 'p7803', 'artifacts', 'work');
  let wrote = false;
  try { wrote = fs.existsSync(path.join(artifacts, 'solver', 'f1', 'answer.txt')) || fs.existsSync(path.join(artifacts, 'judge', 'f2', 'answer.txt')); } catch (_) {}
  ok('api worker: 模型的 Write 真正落盘 (answer.txt)', wrote, artifacts);
  ok('api worker: token 计费走了 usage.total_tokens', st.budget.tokens >= 274, `tokens=${st.budget.tokens}`);
  clearInterval(hub.timer); try { hub.server.close(); } catch (_) {} hub.conns.forEach((c) => c.destroy()); llm.close();
  await sleep(100);
}

/* ── 4) cli worker：fake 外部 agent 当外设（竞品即组件）──────── */
async function e2eCliWorker() {
  const fake = path.join(__dirname, '..', 'test', 'fake-agent.js');
  const cfgFile = baseConfig(7804, {
    providers: {
      eco: { kind: 'cli', command: { win: `node "${fake}" {prompt_file}`, posix: `node ${fake} {prompt_file}` }, timeoutMs: 30000, concurrency: { ratePerSec: 20, burst: 20 } },
      mid: { kind: 'cli', command: { win: `node "${fake}" {prompt_file}`, posix: `node ${fake} {prompt_file}` }, timeoutMs: 30000, concurrency: { ratePerSec: 20, burst: 20 } },
      high: { kind: 'cli', command: { win: `node "${fake}" {prompt_file}`, posix: `node ${fake} {prompt_file}` }, timeoutMs: 30000, concurrency: { ratePerSec: 20, burst: 20 } },
    },
  });
  const cfg = loadConfig(cfgFile);
  const hub = new Hub(cfg); hub.start();
  const r = hub.plan({
    goal: 'cli 外设演练：两路独立分析 + 盲评裁决链',
    topology: 'fanout', fanout: 2,
    lanes: [{ persona: 'scout', mission: '查清 fake-agent 能力' }, { persona: 'analyst', mission: '评估 fake-agent 定位' }],
    acceptance: ['有结论有证据'],
    budget: { maxTokens: 500000, maxWallMs: 25000 },
  });
  const w = new Worker({ mode: 'cli', provider: 'mid', name: 'cli-w', slots: 2 }, cfg);
  await w.start();
  const st = await settle(hub, r.fleet, { timeoutMs: 25000 });
  const fakeDone = st.nodes && st.nodes.filter((n) => n.status === 'done' && /fake-external-agent/.test(n.summary || '')).length || 0;
  const judged = st.nodes && st.nodes.filter((n) => n.status === 'done' && n.verdict === 'accept').length || 0;
  ok('cli worker: 外部 agent 交付回流（≥2 路）', fakeDone >= 2, `done=${fakeDone}`);
  ok('cli worker: 盲评+裁决链真实跑通（含 verify 展开）', st.status === 'complete' && judged >= 2, `status=${st.status} accept 裁决=${judged}`);
  clearInterval(hub.timer); hub.conns.forEach((c) => c.destroy());
  await sleep(100);
}

/* ── 5) git worktree 物理隔离 + Refinery 合并 ──────────────── */
async function e2eWorktree() {
  const repo = path.join(ROOT, 'tmp-repo');
  const wtBase = path.join(ROOT, 'wt');
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(wtBase, { recursive: true, force: true }); } catch (_) {}  // 清掉上轮 worktree 残留，避免 gitdir 指向已删仓库
  ensureDir(repo);
  const g = (args) => gitx.sh('git', ['-C', repo, ...args]);
  g(['init', '-b', 'main']);
  const gc = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@local', '-c', 'commit.gpgsign=false'];
  fs.writeFileSync(path.join(repo, 'base.txt'), 'hello\n');
  g(['add', '.']); g([...gc, 'commit', '-m', 'init']);
  const a = gitx.ensureWorktree({ repo, baseDir: wtBase, nodeId: 'n1' });
  const b = gitx.ensureWorktree({ repo, baseDir: wtBase, nodeId: 'n2' });
  ok('worktree: 双 lane 各建独立 worktree+分支', !!a.worktree && !!b.worktree && a.branch !== b.branch, `${a.branch} / ${b.branch}`);
  fs.writeFileSync(path.join(a.worktree, 'a.txt'), 'from n1\n');
  gitx.sh('git', ['-C', a.worktree, 'add', '.']); gitx.sh('git', ['-C', a.worktree, ...gc, 'commit', '-m', 'n1 work']);
  fs.writeFileSync(path.join(b.worktree, 'b.txt'), 'from n2\n');
  gitx.sh('git', ['-C', b.worktree, 'add', '.']); gitx.sh('git', ['-C', b.worktree, ...gc, 'commit', '-m', 'n2 work']);
  const merged = gitx.mergeQueue({ repo, branches: [a.branch, b.branch] });
  ok('worktree: Refinery 排队合并两分支回 main', merged.every((m) => m.ok), merged.map((m) => `${m.branch}:${m.ok}`).join(','));
  const files = fs.readdirSync(repo);
  ok('worktree: 合并产物真实落在主仓（a.txt+b.txt）', files.includes('a.txt') && files.includes('b.txt'), files.join(','));
}

/* ── MCP stdio 握手 + tools/list ───────────────────────────── */
async function e2eMcp() {
  const cfgFile = baseConfig(7805);
  const p = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], { env: Object.assign({}, process.env, { FLEET_CONFIG: cfgFile }) });
  const lines = [];
  p.stdout.on('data', (c) => { String(c).split('\n').forEach((l) => l.trim() && lines.push(l)); });
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fleet_policy_check', arguments: { tool: 'npm publish' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fleet_runtime', arguments: {} } });
  await sleep(2500);
  const parse = (id) => { const l = lines.find((x) => { try { return JSON.parse(x).id === id; } catch (_) { return false; } }); return l ? JSON.parse(l) : null; };
  const init = parse(1), list = parse(2), pol = parse(3), rt = parse(4);
  ok('mcp: initialize 握手成功 (fleet-mcp v6)', !!(init && init.result && /6\./.test(init.result.serverInfo.version)));
  const toolNames = (list && list.result && list.result.tools || []).map((t) => t.name);
  const need = ['fleet_plan', 'fleet_approve', 'fleet_reject', 'fleet_pending', 'fleet_fork', 'fleet_replay', 'fleet_policy_check', 'fleet_rerank', 'fleet_guardrail', 'fleet_skills', 'fleet_beads', 'fleet_worktree', 'fleet_runtime', 'fleet_filemap', 'fleet_hook_fire', 'fleet_trace', 'fleet_jobs', 'fleet_work', 'fleet_submit', 'fleet_note'];
  const missing = need.filter((n) => !toolNames.includes(n));
  ok(`mcp: tools/list 全 ${toolNames.length} 个、承诺的 ${need.length} 个 v3 工具齐`, missing.length === 0, missing.length ? '缺:' + missing.join(',') : '');
  ok('mcp: tools/call fleet_policy_check 走中央闸(ask)', !!(pol && pol.result && /awaiting_human/.test(pol.result.content[0].text)), '');
  ok('mcp: tools/call fleet_runtime 返回 maxThreads', !!(rt && /maxThreads/.test(rt.result.content[0].text)), '');
  p.kill();
}

async function main() {
  ensureDir(ROOT);
  console.log('—— 舰队 v3 e2e：五路实战 + MCP stdio + subagent + 跨舰队/权限/团队 ——');
  await e2eApproval();
  await e2eColdResume();
  await e2eApiWorker();
  await e2eCliWorker();
  await e2eWorktree();
  await e2eMcp();
  await e2eSubagent();
  await e2eFleetBus();
  await e2ePermissions();
  await e2eTeamPing();
  await e2eCompactor();
  await e2eBalancer();
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n==== e2e 结果: ${pass}/${results.length} 通过 ====`);
  results.filter((r) => !r.pass).forEach((r) => console.log('FAILED: ' + r.name + ' ' + r.detail));
  process.exit(pass === results.length ? 0 : 1);
}

/* ── 7) 跨舰队协同：handoff / 依赖门 ───────────────────────── */
async function e2eFleetBus() {
  const cfgFile = baseConfig(7807);
  const cfg = loadConfig(cfgFile);
  const hub = new Hub(cfg); hub.start();
  // A 舰队（侦察）先 settle，B 舰队依赖 A
  const w = new Worker({ mode: 'demo', name: 'bus-w', slots: 3 }, cfg);
  await w.start();
  const A = hub.plan({ goal: 'A:侦察市场', topology: 'fanout', fanout: 1, lanes: [{ persona: 'scout', mission: '查一手来源' }], acceptance: ['有URL'], verify: { on: false }, budget: { maxTokens: 500000, maxWallMs: 20000 }, fleet: 'busA' });
  await settle(hub, 'busA');
  ok('fleetbus: A 舰队 settle', hub.depSettled.has('busA'), '');
  // A 把 artifact handoff 给 B
  const art = path.join(ROOT, 'p7807', 'artifacts', 'busA-find.txt');
  try { fs.writeFileSync(art, 'A发现：龙头是X'); } catch (_) {}
  const hoff = hub.bus.handoff({ source: 'busA', dest: 'busB', artifacts: [art], facts: ['龙头=X'], note: '给B的输入' });
  ok('fleetbus: A→B handoff 入队', hoff.dest === 'busB', '');
  // B 声明依赖 A
  hub.bus.dependsOn('busB', ['busA']);
  // B 依赖未满足时（若 A 未 settle）不开跑 —— 这里 A 已 settle，验证 depsMet
  ok('fleetbus: B 依赖 A 判定满足', hub.bus.depsMet('busB', hub.depSettled), '');
  // consume：B 拉取 A 的投递写黑板
  const B = hub.plan({ goal: 'B:用A的发现做决策', topology: 'fanout', fanout: 1, lanes: [{ persona: 'judge', mission: '基于A输入决策' }], acceptance: ['x'], verify: { on: false }, budget: { maxTokens: 500000, maxWallMs: 20000 }, fleet: 'busB', deps: ['busA'] });
  const consumed = await hub.bus.consume('busB', hub.fleets.get('busB').board);
  ok('fleetbus: B 消费 A 的注入（黑板有 handoff 记录）', consumed.includes('来自 busA'), consumed.slice(0, 80));
  await settle(hub, 'busB');
  ok('fleetbus: B 依赖门放行后 settle', hub.depSettled.has('busB'), '');
  clearInterval(hub.timer); try { hub.server.close(); } catch (_) {} hub.conns.forEach((c) => c.destroy());
  await sleep(100);
}

/* ── 8) 权限模式：bypass/acceptEdits/plan/default ───────────── */
async function e2ePermissions() {
  const cfgFile = baseConfig(7808);
  const cfg = loadConfig(cfgFile);
  const hub = new Hub(cfg); hub.start();
  const modes = {
    bypass: { tool: 'Bash(rm -rf /)' , pass: true },
    plan:   { tool: 'Write(/etc/passwd)', pass: false },
    acceptEdits: { tool: 'Write(a.txt)', pass: true },
    default: { tool: 'npm publish', pass: false },  // ask → awaiting_human
  };
  let all = true, det = '';
  for (const [mode, c] of Object.entries(modes)) {
    const r = hub.permCheck({ mode, tool: c.tool });
    if (c.pass) { if (!r.allow) { all = false; det += `${mode}:应过未过 `; } }
    else { if (r.allow) { all = false; det += `${mode}:应拦未拦 `; } else if (r.reason !== 'awaiting_human') { /* plan 拒绝 but 无需人批也算拦 */ } }
  }
  ok('permissions: 四模式按语义正确放行/拦截', all, det);
  // plan 模式拦截写入要 deny 而非 awaiting_human
  const planW = hub.permCheck({ mode: 'plan', tool: 'Write(x)' });
  ok('permissions: plan 模式写入被拒（非待批）', planW.allow === false && planW.reason !== 'awaiting_human', JSON.stringify(planW));
  const defaultAsk = hub.permCheck({ mode: 'default', tool: 'Bash(npm install)' });
  ok('permissions: default 高风险 shell 转人工审批', defaultAsk.allow === false && defaultAsk.reason === 'awaiting_human', JSON.stringify(defaultAsk));
  clearInterval(hub.timer); try { hub.server.close(); } catch (_) {} hub.conns.forEach((c) => c.destroy());
  await sleep(100);
}

/* ── 9) Agent Teams 同层互喂证据（TeammateIdle 式 peer ping）── */
async function e2eTeamPing() {
  const cfgFile = baseConfig(7809);
  const cfg = loadConfig(cfgFile);
  const hub = new Hub(cfg); hub.start();
  hub.bus.joinTeam('teamFleet', 'analyst');
  hub.bus.joinTeam('teamFleet', 'redteam');
  ok('team: 同层小队注册 (analyst+redteam)', hub.bus.teamOf('teamFleet').length === 2);
  const ping = hub.bus.peerPing({ fleetId: 'teamFleet', from: 'analyst', to: 'redteam', evidence: ['sourced://fact1'], note: '已核实的事实' });
  ok('team: analyst→redteam 证据 ping 入队', ping.from === 'analyst' && ping.to === 'redteam', '');
  const inbox = hub.bus.peerInbox('teamFleet', 'redteam');
  ok('team: redteam 收件箱收到证据（仍可过自己的盲评）', inbox.length === 1 && inbox[0].evidence.length === 1, JSON.stringify(inbox[0] && inbox[0].evidence));
  const snap = hub.bus.snapshot();
  ok('team: 舰队间总线快照含 peer 连接', snap.peers >= 1, JSON.stringify(snap).slice(0, 80));
  clearInterval(hub.timer); try { hub.server.close(); } catch (_) {} hub.conns.forEach((c) => c.destroy());
  await sleep(100);
}

/* ── 10) 上下文压缩：window-safe 黑板（防 context rot）──────── */
async function e2eCompactor() {
  const cfgFile = baseConfig(7810);
  const cfg = loadConfig(cfgFile);
  const hub = new Hub(cfg); hub.start();
  const r = hub.plan({ goal: '压缩演练', topology: 'fanout', fanout: 1, lanes: [{ persona: 'judge', mission: 'x' }], acceptance: ['x'], verify: { on: false }, budget: { maxTokens: 500000, maxWallMs: 15000 } });
  const f = hub.fleets.get(r.fleet);
  // 灌 60 条黑板记录（超过 coldAfter=40）触发压缩
  for (let i = 0; i < 60; i++) f.board.put({ type: i % 2 ? 'fact' : 'artifact', body: `记录${i}：${'x'.repeat(50)}`, author: 'probe', confidence: 0.6 });
  // 触发压缩
  const c = f.compactor || (f.compactor = new Compactor({ stateDir: cfg.stateDir }));
  const compacted = c.maybeCompact(f.board);
  ok('compactor: 超长黑板触发至少一次冷段压缩', compacted.compacted > 0, `compacted=${compacted.compacted}`);
  // window-safe 视图：token 预算内，冷段是摘要
  const view = c.render(f.board);
  const tok = require('./util').estTokens(view);
  ok('compactor: 渲染视图 token 预算硬上限内', tok <= (cfg.boardTokens || 900) + 200, `rendered=${tok} tokens`);
  ok('compactor: 冷段用摘要（含压缩摘要标记）', /压缩摘要/.test(view), view.slice(0, 60));
  ok('compactor: 产物观测屏蔽（指针不内联,artifact→）', /→/.test(view), '');
  clearInterval(hub.timer); try { hub.server.close(); } catch (_) {} hub.conns.forEach((c) => c.destroy());
  await sleep(100);
}

/* ── 11) 多 provider 负载均衡：round-robin + error-aware 降级 ── */
async function e2eBalancer() {
  const cfgFile = baseConfig(7811, {
    balanceMode: 'round_robin',
    providers: {
      eco: { model: 'eco', pricePer1M: 0.0002, concurrency: { ratePerSec: 50, burst: 50 } },
      mid: { model: 'mid', pricePer1M: 0.002, concurrency: { ratePerSec: 50, burst: 50 } },
      high: { model: 'high', pricePer1M: 0.01, concurrency: { ratePerSec: 50, burst: 50 } },
    },
  });
  const cfg = loadConfig(cfgFile);
  const hub = new Hub(cfg); hub.start();
  const B = hub.balancer;
  ok('balancer: 初始 3 provider 健康', Object.keys(B.snapshot().providers).length === 3);
  // round-robin 轮流：3 次 pick 应覆盖 3 个不同
  const picks = new Set([B.pick(), B.pick(), B.pick()]);
  ok('balancer: round-robin 均匀分流到 3 个 provider', picks.size === 3, [...picks].join(','));
  // error-aware 降级：连续失败 2 次 → 该 provider 标不可用
  B.report('high', false, 'rate limit'); B.report('high', false, 'rate limit');
  ok('balancer: 连续失败 2 次降级 high', B.snapshot().providers.high.ok === false, JSON.stringify(B.snapshot().providers.high));
  // 降级后 pick 不再选中失败的
  B.rr = 0; const after = [B.pick(), B.pick(), B.pick()];
  ok('balancer: 降级后再 pick 不含 high', !after.includes('high'), after.join(','));
  // cheapest 模式：挑 pricePer1M 最低且健康
  hub.balancer.mode = 'cheapest';
  const che = hub.balancer.pick();
  ok('balancer: cheapest 模式选最便宜 eco', che === 'eco', che);
  clearInterval(hub.timer); try { hub.server.close(); } catch (_) {} hub.conns.forEach((c) => c.destroy());
  await sleep(100);
}

/* ── 6) Codex sub-agent 三型角色 + 递归深度护栏 ─────────────── */
async function e2eSubagent() {
  const cfgFile = baseConfig(7806);
  const cfg = loadConfig(cfgFile);
  const hub = new Hub(cfg); hub.start();
  const roles = hub.subagentRoles();
  ok('subagent: 三型角色卡预置 (default/worker/explorer)', roles.length >= 3, roles.map((r) => r.id).join(','));
  const w = hub.subagent('worker');
  ok('subagent: 生成 worker 实例（depth=1, 非只读）', w.ok && w.depth === 1 && !w.readonly);
  const e = hub.subagent('explorer');
  ok('subagent: 生成 explorer 实例（只读）', e.ok && e.readonly === true);
  // 递归护栏：parentDepth=1 → childDepth=2 应被 max_depth=1 拒绝
  const deep = hub.subagent('worker', { parentDepth: 1 });
  ok('subagent: 递归深度护栏拦截 (max_depth=1)', deep.ok === false && deep.why === 'max_depth_exceeded', deep.why);
  // 自进化：跑一个真舰队（有 worker 交付），settle 后 evolve 自动出产物
  const ew = new Worker({ mode: 'demo', name: 'evolve-w', slots: 1 }, cfg);
  await ew.start();
  const er = hub.plan({ goal: '进化演练', topology: 'fanout', fanout: 1, lanes: [{ persona: 'judge', mission: '做个高置信交付' }], acceptance: ['x'], verify: { on: false }, budget: { maxTokens: 500000, maxWallMs: 15000 } });
  await settle(hub, er.fleet);
  const ev = hub.evolveArtifacts();
  ok('evolve: 舰队跑完自动提炼技能基因 (policies/genome/boost)', (ev.policies.length + ev.genome.length + ev.boost.length) > 0, `policies=${ev.policies.length} genome=${ev.genome.length} boost=${ev.boost.length}`);
  clearInterval(hub.timer); try { hub.server.close(); } catch (_) {} hub.conns.forEach((c) => c.destroy());
  await sleep(100);
}

main().catch((e) => { console.error('e2e fatal:', e && e.stack || e); process.exit(2); });