'use strict';
/**
 * Hooks v2 —— Claude Code Hooks 完整事件表 + Agents SDK lifecycle。
 *
 * 事件（与 Claude Code 同步）：
 *   SessionStart / UserPromptSubmit / PreToolUse / PostToolUse /
 *   SubagentStart / SubagentStop / TeammateIdle /
 *   TaskCreated / TaskCompleted / Stop / Error
 *
 * 关键立场：hooks 不让模型决定"该不该做"，是确定性自动化层。Hub 主动 fire；
 *       fire 失败的副作用必须落账本，不能影响主线。
 *
 * 与 v1 区别：v1 只 fire 三个事件；v2 把每个事件拆出 payload schema，让 side-effect handlers 可注册、可观测、可被 policy gate 拦。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { appendJsonl, now } = require('./util');

const SCHEMA = {
  SessionStart: { fleetId: 'string', spec: 'object' },
  UserPromptSubmit: { fleetId: 'string', nodeId: 'string', text: 'string' },
  PreToolUse: { fleetId: 'string', nodeId: 'string', tool: 'string', args: 'object' },
  PostToolUse: { fleetId: 'string', nodeId: 'string', tool: 'string', args: 'object', result: 'any' },
  SubagentStart: { fleetId: 'string', nodeId: 'string', worker: 'string', attempt: 'number' },
  SubagentStop: { fleetId: 'string', nodeId: 'string', worker: 'string', attempt: 'number', result: 'any' },
  TeammateIdle: { worker: 'string' },
  TaskCreated: { fleetId: 'string', nodeId: 'string', kind: 'string', persona: 'string' },
  TaskCompleted: { fleetId: 'string', nodeId: 'string', persona: 'string', tokens: 'number', confidence: 'number' },
  Stop: { fleetId: 'string', nodeId: 'string', reason: 'string' },
  Error: { fleetId: 'string', nodeId: 'string', error: 'string' },
};

class HookBus extends EventEmitter {
  constructor(audit) {
    super();
    this.audit = audit;
    this.handlers = new Map();
    this.metrics = new Map();
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
    return super.on(event, handler);
  }

  /** 注册前置守卫：返回 false 阻断 */
  guard(event, fn) { this.on('Pre' + event, fn); }

  async fire(event, payload) {
    const t0 = Date.now();
    const env = { event, ts: now(), payload };
    try { appendJsonl(this.audit, env); } catch (_) {}
    const pre = this.handlers.get('Pre' + event) || [];
    for (const h of pre) { try { const ok = await h(payload, env); if (ok === false) return { event, blocked: true, payload }; } catch (e) { /* ignore */ } }
    const list = this.handlers.get(event) || [];
    let failed = 0;
    for (const h of list) {
      try { await h(payload, env); }
      catch (e) {
        failed++;
        try { appendJsonl(this.audit + '.err', { event, error: String(e && e.stack || e), at: now() }); } catch (_) {}
      }
    }
    const dt = Date.now() - t0;
    const m = this.metrics.get(event) || { count: 0, totalMs: 0, failed: 0 };
    m.count++; m.totalMs += dt; m.failed += failed;
    this.metrics.set(event, m);
    return { event, dt, failed };
  }

  stats() { return Object.fromEntries(this.metrics.entries()); }
}

module.exports = { HookBus, SCHEMA };