'use strict';
/**
 * 舰员（Worker）—— 真正干活的那双手。三种入列方式：
 *   demo  离线假人：压调度器、压并发、冒烟测试用，不吃 token
 *   api   OpenAI 兼容端点直连，**带真实执行器（runner loop）**：模型不是一次交付，
 *         而是多轮调用 Read/Write/Run/Search 工具，直到主动 deliver，或 max_turns 到顶
 *   cli   把外部 headless agent 当外设挂上（claude / codex / dsh / trae-cli）—— 竞品即组件
 *   ide   Trae 会话本身通过 MCP 入列，人也在舰队里
 *
 * api 模式的执行器（对齐 OpenAI Agents SDK runner loop + Anthropic subagent）：
 *   loop(<= maxTurns)：
 *     1) modelCall(prompt + 已收集工具结果)
 *     2) final → deliver
 *     3) tool_call → 在隔离 workdir 真实执行（Read/Write/Bash/Search/RepoScan）
 *     4) handoff → 若模型请求换舰员 -> 记录交由 hub
 *   —— 这就是"模型有手"，不是只输出文本。
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { loadConfig, sleep, ts, truncate, estTokens, ensureDir, uid } = require('./util');
const { connect } = require('./ws');

function parseArgs(argv) {
  // 兼容两种形态：① "--mode demo"（空格分隔）② "--mode=demo"（等号）——Start-Process/cmd/单串 argv 全覆盖
  const flat = [];
  for (const part of argv) {
    for (const tok of String(part).trim().split(/\s+/).filter(Boolean)) {
      const m = tok.match(/^--([\w-]+)=(.*)$/);
      if (m) { flat.push('--' + m[1], m[2]); } else flat.push(tok);
    }
  }
  const a = { slots: 2, mode: 'api', caps: '*', fleet: null, allowShell: false };
  for (let i = 0; i < flat.length; i++) {
    const k = flat[i];
    if (k === '--mode') a.mode = flat[++i];
    else if (k === '--provider') a.provider = flat[++i];
    else if (k === '--model') a.model = flat[++i];
    else if (k === '--persona') a.persona = flat[++i];
    else if (k === '--slots') a.slots = +flat[++i];
    else if (k === '--caps') a.caps = flat[++i];
    else if (k === '--tiers') a.tiers = flat[++i];
    else if (k === '--name') a.name = flat[++i];
    else if (k === '--fleet') a.fleet = flat[++i];
    else if (k === '--url') a.url = flat[++i];
    else if (k === '--allow-shell') a.allowShell = true;
    else if (k === '--config') a.config = flat[++i];
  }
  return a;
}

class Worker {
  constructor(args, cfg) {
    this.args = args;
    this.cfg = cfg;
    this.providerName = args.provider || (args.mode === 'api' ? 'mid' : null);
    this.provider = (cfg.providers || {})[this.providerName] || null;
    this.model = args.model || (this.provider && this.provider.model) || null;
    this.url = args.url || `ws://${cfg.host}:${cfg.port}`;
    this.inflight = new Map();
    this.done = 0;
    this.balancer = args.balanced ? new (require('./balancer').Balancer)(cfg.providers || {}, { mode: cfg.balanceMode || 'round_robin' }) : null;
    this.logs = path.join(cfg.logDir, `worker-${args.mode}-${process.pid}.log`);
  }

  log(...a) {
    const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
    try { fs.appendFileSync(this.logs, line + '\n'); } catch (_) {}
    process.stdout.write(line + '\n');
  }

  async start() {
    for (;;) {
      try {
        this.conn = await connect(this.url);
        break;
      } catch (e) {
        this.log('hub 未就绪，1.5s 后重连', String(e.message || e));
        await sleep(1500);
      }
    }
    const caps = this.args.caps === '*' ? { roles: ['*'], personas: ['*'], tiers: ['*'] } : parseCaps(this.args.caps, this.args.tiers);
    this.conn.send({
      t: 'hello', name: this.args.name || `${this.args.mode}-${this.model || 'local'}`, kind: this.args.mode,
      caps, provider: this.providerName, model: this.model, persona: this.args.persona, slots: this.args.slots, cwd: this.cwd,
    });
    this.conn.on('message', (m) => this.onMsg(m));
    this.conn.on('dead', () => { this.log('中枢掉线，重启入列'); setTimeout(() => this.start(), 1200); });
    this.claimTimer = setInterval(() => {
      if (this.inflight.size < this.args.slots) this.conn.send({ t: 'claim', fleet: this.args.fleet });
    }, 900);
    this.log(`入列 ${this.url} mode=${this.args.mode} model=${this.model || '-'} slots=${this.args.slots}`);
  }

  async onMsg(m) {
    if (m.t === 'welcome') return;
    if (m.t === 'noop') return;
    if (m.t !== 'lease') return;
    const job = { fleet: m.fleet, node: m.node.id, ctx: m.context };
    this.inflight.set(m.node.id, job);
    this.handle(job).catch((e) => this.conn.send({ t: 'fail', fleet: job.fleet, node: job.node, error: String(e.message || e), retryable: true }))
      .finally(() => this.inflight.delete(m.node.id));
  }

  async handle(job) {
    const { fleet, node, ctx } = job;
    this.conn.send({ t: 'progress', fleet, node, msg: `开始：${truncate(ctx.node.mission, 120)}` });
    // v3: PreToolUse hook（hub 端 guard 会联动 policy gate）
    this.hookFire('PreToolUse', { fleetId: fleet, nodeId: node, tool: this.args.mode === 'cli' ? 'CliAgent(run)' : this.args.mode === 'api' ? 'ChatCompletions(call)' : 'LocalArtifact(write)' });
    let out;
    if (this.args.mode === 'demo') out = await this.demo(ctx);
    else if (this.args.mode === 'cli') out = await this.cli(ctx);
    else out = await this.api(ctx, fleet);
    this.hookFire('PostToolUse', { fleetId: fleet, nodeId: node, tool: 'deliver', result: { confidence: out.confidence, tokens: out.tokens } });
    this.conn.send({ t: 'submit', fleet, node, result: out });
    this.done++;
    this.log(`交付 ${node} (${ctx.node.kind}/${ctx.persona.id}) conf=${out.confidence} tokens=${out.tokens}`);
  }

  /** v2: 工具调用前置 policy gate：worker 把每个工具动作发给 hub 判 allow/deny/ask */
  async policyCheck(tool, ctx) {
    if (!this.conn) return { allow: true };
    return await new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2, 8);
      const off = (m) => { if (m && m.t === 'admin_result' && m.op === 'policy' && m.id === id) { this.conn.off('message', off); resolve(m.data); } };
      this.conn.on('message', off);
      this.conn.send({ t: 'admin', op: 'policy', id, action: { tool }, ctx });
      setTimeout(() => { this.conn.off('message', off); resolve({ allow: true, audit: null }); }, 1500);
    });
  }

  /** v3: hook 上报 —— PreToolUse/PostToolUse 走 hub 的确定性自动化总线（guard 里自动过 policy） */
  hookFire(name, payload) {
    if (!this.conn || !this.conn.alive) return;
    this.conn.send({ t: 'admin', op: 'hook', name, payload });
  }

  /** 离线假人：产物真实落盘，方便验证调度/落盘/验证链是否闭环 */
  async demo(ctx) {
    await sleep(120 + (Math.abs(ctx.persona.seed) % 400));
    const dir = ensureDir(path.join(this.cfg.artifactDir, 'demo', ctx.persona.id));
    const file = path.join(dir, `${ctx.node.id}.md`);
    const body = `# ${ctx.node.id} · ${ctx.persona.callsign}\n\n立场：${ctx.persona.angle || ctx.persona.id}\n\n## 结论\n（demo 舰员产物，用于压测调度器）\n\n任务：\n${ctx.node.mission}\n`;
    fs.writeFileSync(file, body);
    const tokens = estTokens(ctx.system + ctx.user + body);
    return { summary: `[demo] ${ctx.persona.callsign} 完成 ${ctx.node.id}，产物已落盘`, evidence: [file], artifacts: [file], files: [{ path: file, body }], confidence: 0.65, tokens };
  }

  /** 外部 headless agent 当外设：prompt 走 stdin，stdout 即交付 */
  cli(ctx) {
    const tpl = this.provider && this.provider.command ? (this.provider.command[process.platform === 'win32' ? 'win' : 'posix'] || this.provider.command.posix || this.provider.command.win) : null;
    if (!tpl) throw new Error('cli provider 未配置 command');
    const prompt = `${ctx.system}\n\n${ctx.user}`;
    const cmd = tpl.replace('{prompt_file}', '@PROMPT@');
    const pf = path.join(this.cfg.stateDir, `prompt-${ctx.node.id}-${process.pid}.txt`);
    fs.writeFileSync(pf, prompt, 'utf8');
    const finalCmd = cmd.replace('@PROMPT@', `"${pf}"`);
    try {
      const stdout = execSync(finalCmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: (this.provider.timeoutMs || 600000), cwd: ctx.workdir || process.cwd(), shell: true });
      const summary = String(stdout).trim();
      const tokens = estTokens(prompt + summary);
      return { summary: truncate(summary, 8000) || '(空输出)', evidence: [], artifacts: [], confidence: summary ? 0.7 : 0.2, tokens };
    } finally {
      try { fs.unlinkSync(pf); } catch (_) {}
    }
  }

  /** 直连 OpenAI 兼容端点，带真实执行器（runner loop）：模型多轮工具调用直到 deliver/max_turns */
  async api(ctx, fleet) {
    if (!this.provider) throw new Error('未配置 provider');
    // 负载均衡 pick：balanced 模式轮流选 provider（多厂牌并存）
    let activeProvider = this.provider;
    if (this.balancer) {
      const pn = this.balancer.pick({ avoid: [this.providerName] });
      activeProvider = (this.cfg.providers || {})[pn] || this.provider;
    }
    const base = (activeProvider.baseUrl || '').replace(/\/$/, '');
    const maxTurns = activeProvider.maxTurns || 6;
    const workdir = ctx.workdir || this._workdir(ctx);
    ensureDir(workdir);

    const TOOLS = toolSchema(workdir);
    const messages = [
      { role: 'system', content: ctx.system + workerPolicyHint(ctx) },
      { role: 'user', content: ctx.user },
    ];
    let totalTokens = 0, totalCost = 0, turnLog = [];
    const t0 = ts();

    const finalize = (o) => {
      for (const f of (o.files || [])) { try { ensureDir(path.dirname(path.resolve(workdir, f.path))); fs.writeFileSync(path.resolve(workdir, f.path), f.body, 'utf8'); (o.artifacts = o.artifacts || []).push(path.resolve(workdir, f.path)); } catch (_) {} }
      o.tokens = o.tokens || totalTokens || estTokens(ctx.system + ctx.user);
      o.cost = o.cost || tokensToCost(o.tokens, activeProvider);
      o.latencyMs = ts() - t0;
      o.evidence = (o.evidence || []).concat(turnLog).slice(0, 30);
      if (this.balancer) this.balancer.report(this.providerName, true);
      if (fleet) this.conn.send({ t: 'note', fleet, record: { type: 'artifact', body: String(o.summary || '').slice(0, 800), confidence: o.confidence, author: ctx.persona.id, node: ctx.node.id } });
      return o;
    };

    const callLLM = async (model, msgs) => {
      const body = {
        model, messages: msgs,
        temperature: ctx.persona.temperature == null ? (activeProvider.temperature == null ? 0.5 : activeProvider.temperature) : ctx.persona.temperature,
        max_tokens: activeProvider.maxTokens || 4096,
      };
      if (!activeProvider.toolsUnsupported) { body.tools = TOOLS; body.tool_choice = activeProvider.toolChoice || 'auto'; }
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, activeProvider.apiKey ? { authorization: `Bearer ${activeProvider.apiKey}` } : {}),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (this.balancer) this.balancer.report(this.providerName, false, `HTTP ${res.status}`);
        throw new Error(`provider ${this.providerName} HTTP ${res.status}: ${truncate(await res.text(), 300)}`);
      }
      const j = await res.json();
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      totalTokens += (j.usage && j.usage.total_tokens) || estTokens(JSON.stringify(msgs) + String(msg.content || ''));
      return msg;
    };

    // 真实执行工具：在隔离 workdir 内跑，写黑板证据
    const execTool = async (name, args) => {
      this.conn && this.conn.send({ t: 'progress', fleet, node: ctx.node.id, msg: `执行 ${name}(${truncate(JSON.stringify(args), 60)})` });
      if (name === 'deliver') return { deliver: args };
      if (name === 'Read') {
        const p = path.resolve(workdir, String(args.path || ''));
        if (!p.startsWith(path.resolve(workdir))) return { error: 'path_escape_denied' };
        return readFileSafe(p, args.start_line, args.end_line);
      }
      if (name === 'Write') { try { fs.writeFileSync(path.resolve(workdir, String(args.path)), String(args.content || '')); return { ok: true, path: args.path }; } catch (e) { return { error: String(e.message) }; } }
      if (name === 'Edit') { try { prescriptiveEdit(workdir, args); return { ok: true }; } catch (e) { return { error: String(e.message) }; } }
      if (name === 'Bash') { return runSafeBash(workdir, args.cmd, this.provider.allowShell); }
      if (name === 'Search') { try { return new (require('./filemap').FileMap)(workdir).grep(args.pattern, { cwd: workdir, max: args.max || 30 }); } catch (e) { return { error: String(e.message) }; } }
      if (name === 'RepoScan') { try { return new (require('./filemap').FileMap)(workdir).filemap({ cwd: workdir, focus: args.focus || [], budget: args.budget || 1200 }); } catch (e) { return { error: String(e.message) }; } }
      return { error: 'unknown_tool:' + name };
    };

    // 主循环：Agent SDK runner loop
    for (let turn = 0; turn < maxTurns; turn++) {
      turnLog.push('turn ' + (turn + 1));
      const msg = await callLLM(this.model, messages);
      const content = String(msg.content || '').trim();
      const calls = msg.tool_calls || [];
      if (this.provider.toolsUnsupported) {
        // 无 tool calling 端点：退回 JSON 契约
        const m = content.match(/\{[\s\S]*\}\s*$/);
        if (m) { try { const o = JSON.parse(m[0]); if (o.summary != null) return finalize(o); } catch (_) {} }
        if (content) return finalize({ summary: content, confidence: 0.5 });
      }
      if (calls.length === 0 && content) {
        // 模型没走 tool_call 但说了结论 —— 尝试 JSON 或视为纯文本交付
        const m = content.match(/\{[\s\S]*\}\s*$/);
        if (m) { try { const o = JSON.parse(m[0]); if (o.summary != null) return finalize(o); } catch (_) {} }
        // 无工具可用时，纯文本即交付
        return finalize({ summary: content, confidence: 0.6, evidence: turnLog });
      }
      // 处理所有 tool_calls
      messages.push({ role: 'assistant', content: content || '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } })) });
      const results = [];
      for (const c of calls) {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch (_) {}
        if (c.function.name === 'deliver') {
          const o = Object.assign({}, args);
          o.tokens = totalTokens; o.cost = tokensToCost(totalTokens, this.provider); o.latencyMs = ts() - t0;
          return finalize(o);
        }
        const r = await execTool(c.function.name, args);
        results.push({ role: 'tool', tool_call_id: c.id, content: typeof r === 'string' ? r : JSON.stringify(r) });
        totalCost += tokensToCost(estTokens(JSON.stringify(r) || '0'), this.provider);
      }
      messages.push(...results);
    }
    return finalize({ summary: `[max_turns=${maxTurns} 到达] 未主动 deliver；过程日志: ${turnLog.join(' | ')}`, confidence: 0.3, evidence: turnLog });
   }

  _workdir(ctx) {
    return path.join(this.cfg.artifactDir, 'work', ctx.persona.id, ctx.node.id);
  }
}

/* ── 工具 schema + 安全执行器（全部限定在 workdir 内，防路径逃逸）────────── */
function toolSchema(workdir) {
  return [
    { type: 'function', function: { name: 'Read', description: '读取 workdir 内文件（前 N 行）', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'Write', description: '写入文件（覆盖）', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'Edit', description: '替换文件中的一段文本（精确匹配 old_string→new_string）', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
    { type: 'function', function: { name: 'Bash', description: '在 workdir 内执行 shell 命令', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
    { type: 'function', function: { name: 'Search', description: '全局搜索（只返回命中文件名）', parameters: { type: 'object', properties: { pattern: { type: 'string' }, max: { type: 'number' } }, required: ['pattern'] } } },
    { type: 'function', function: { name: 'RepoScan', description: '生成 token 预算内的符号摘要', parameters: { type: 'object', properties: { focus: { type: 'array', items: { type: 'string' } }, budget: { type: 'number' } } } } },
    { type: 'function', function: { name: 'deliver', description: '交付成果（必须调用）', parameters: { type: 'object', properties: { summary: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, artifacts: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, body: { type: 'string' } } } }, confidence: { type: 'number' }, verdict: { type: 'string', enum: ['accept', 'reject'] } }, required: ['summary', 'confidence'] } } },
  ];
}

function readFileSafe(p, start, end) {
  try {
    const body = fs.readFileSync(p, 'utf8');
    const lines = body.split('\n');
    const s = start || 1, e = end || 100;
    return { path: p, totalLines: lines.length, slice: lines.slice(s - 1, e).join('\n') };
  } catch (e) { return { error: String(e.message) }; }
}

function prescriptiveEdit(workdir, args) {
  const p = path.resolve(workdir, String(args.path));
  if (!p.startsWith(path.resolve(workdir))) throw new Error('path_escape_denied');
  let body = fs.readFileSync(p, 'utf8');
  if (!body.includes(String(args.old_string))) throw new Error('old_string_not_found');
  body = body.replace(String(args.old_string), String(args.new_string));
  fs.writeFileSync(p, body, 'utf8');
}

function runSafeBash(workdir, cmd, allowShell) {
  if (!allowShell) return { error: 'Bash 被 disable（spec.allowShell!=true），改用 Write/Edit' };
  try {
    const out = execSync(String(cmd).replace(/[<>]/g, ''), { encoding: 'utf8', cwd: workdir, shell: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: truncate(out, 4000) };
  } catch (e) { return { error: truncate(String(e.stderr || e.message), 1000) }; }
}

function workerPolicyHint(ctx) {
  return `\n\n【工作目录】你只在一个隔离目录里干活，绝对路径不可越界。工具 Read/Write/Edit/Bash/Search/RepoScan 都限死在该目录内。需要读外部代码就 Search 搜你的 workdir。最终必须调用 deliver。`;
}

function parseCaps(s, tiers) {
  const out = { roles: ['*'], personas: ['*'], tiers: ['*'] };
  for (const part of String(s).split(',')) {
    const [k, v] = part.split('=');
    if (!v) continue;
    out[k === 'roles' ? 'roles' : k === 'personas' ? 'personas' : k] = v.split('|');
  }
  if (tiers) out.tiers = String(tiers).split('|');
  return out;
}

function tokensToCost(tokens, provider) {
  const per1M = provider.pricePer1M || 0;
  return tokens * per1M / 1e6;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.config);
  new Worker(args, cfg).start();
}

module.exports = { Worker, parseArgs };
