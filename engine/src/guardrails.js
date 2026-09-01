'use strict';
/**
 * Guardrails v3 —— OpenAI Agents SDK 三档：
 *   1) Input guardrail     只在第一个 agent 跑前执行
 *   2) Output guardrail    只在最终输出 agent 跑后执行
 *   3) Tool guardrail      每个工具调用前后
 *
 * runInParallel：默认 true（低延迟，但 agent 可能已开始）。需要阻断时设 false。
 * Tripwire 后抛 InputGuardrailTripwireTriggered / OutputGuardrail... / Tool...
 *
 * 立场：guardrail 是确定性"门"，不是 LLM 自查。坏就拒，拒就写账本+黑板。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { appendJsonl, now, uid } = require('./util');

class GuardrailHit extends Error {
  constructor(kind, message, payload) {
    super(message);
    this.name = kind + 'TripwireTriggered';
    this.kind = kind;
    this.payload = payload;
  }
}

class Guardrails extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.input = [];
    this.output = [];
    this.tool = [];
  }

  add(kind, fn) {
    if (!['input', 'output', 'tool'].includes(kind)) throw new Error('guardrail_kind:' + kind);
    this[kind].push(fn);
  }

  async runInput(payload, ctx) { return this._run('input', payload, ctx); }
  async runOutput(payload, ctx) { return this._run('output', payload, ctx); }
  async runTool(payload, ctx) { return this._run('tool', payload, ctx); }

  async _run(kind, payload, ctx) {
    const list = this[kind];
    for (const fn of list) {
      try {
        const r = await fn(payload, ctx);
        if (r && r.tripwire) throw new GuardrailHit(kind, r.message || 'guardrail_violation', { rule: r.rule, payload });
      } catch (e) {
        if (e instanceof GuardrailHit) {
          try { appendJsonl(path.join(this.dir, 'guardrails.jsonl'), { kind, hit: e.payload, ctx, at: now() }); } catch (_) {}
          this.emit('tripwire', { kind, payload, ctx });
          throw e;
        }
        // 没 tripwire 的错算过
      }
    }
    return { ok: true };
  }
}

module.exports = { Guardrails, GuardrailHit };