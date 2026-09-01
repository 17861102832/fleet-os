'use strict';
/**
 * Tracing v3 —— OpenAI Agents SDK tracing + Anthropic transcript 同款。
 * 一行规则：trace_id = 'trace_<32 alnum>'；一个 trace 多个 span；span 有 started_at/ended_at。
 *
 * 关掉：环境变量 FLEET_DISABLE_TRACING=1。
 *
 * 写入 path/stateDir/traces/YYYY-MM-DD/trace_xxx.jsonl
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendJsonl, now } = require('./util');

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function traceId() {
  let s = 'trace_';
  for (let i = 0; i < 32; i++) s += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  return s;
}

class Tracer {
  constructor(root, { enabled = true, groupId = null, workflowName = 'fleet' } = {}) {
    this.enabled = enabled && process.env.FLEET_DISABLE_TRACING !== '1';
    this.root = root;
    this.groupId = groupId || traceId();
    this.workflowName = workflowName;
  }

  start(name, { attributes = {}, parentSpanId = null } = {}) {
    const spanId = 'span_' + crypto.randomBytes(8).toString('hex');
    const traceId = parentSpanId ? null : this.traceId_(); // 顶层 trace 共享 id
    const out = { traceId: traceId || this.currentTraceId, spanId, name, attributes, parentSpanId, started_at: Date.now(), status: 'running' };
    this.currentTraceId = out.traceId;
    return { ...out, end: (extra = {}) => this._end(out, extra), addEvent: (e) => this._event(out, e) };
  }

  traceId_() { if (!this.currentTraceId) this.currentTraceId = traceId(); return this.currentTraceId; }

  _end(out, extra) {
    if (!this.enabled) return;
    out.status = 'ok';
    out.ended_at = Date.now();
    Object.assign(out, extra);
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.root, 'traces', day);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    appendJsonl(path.join(dir, this.currentTraceId + '.jsonl'), out);
  }

  _event(out, e) {
    if (!this.enabled) return;
    appendJsonl(path.join(this.root, 'traces', 'events.jsonl'), { traceId: out.traceId, spanId: out.spanId, event: e, at: now() });
  }
}

module.exports = { Tracer, traceId };