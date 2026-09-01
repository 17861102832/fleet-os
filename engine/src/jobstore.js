'use strict';
/**
 * Async Job Store —— Codex 那种后台 agent + Claude 那种 background subagent 的工程表达：
 *
 *   job = { id, spec, mode: 'foreground'|'background', handle, state, ... }
 *
 *  - foreground 必须 wait，阻塞发起者直到 done
 *  - background 立即返回 handle，submit 通过 callback / watch / 轮询
 *  - 持久化：每个 job 一个 JSONL 事件流 + 一一个 latest snapshot
 *  - 调度策略：同舰队后台 job 不抢前台资源；后台 job 的 token 用单独的 budget
 *  - Codex / Claude 都给了这种 model，我们落地得更狠：任何 worker 入列 = 默认 background=false，
 *    但 spec.headless=true 或 node.kind === 'challenge'/'adjudicate' → background=true。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { appendJsonl, writeFileSafe, readJsonl, uid, now, ensureDir } = require('./util');

class JobStore extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.index = new Map();
    this.reload();
  }
  reload() {
    this.index.clear();
    const idxFile = path.join(this.dir, 'index.json');
    if (fs.existsSync(idxFile)) {
      try { for (const j of JSON.parse(fs.readFileSync(idxFile, 'utf8'))) this.index.set(j.id, j); } catch (_) {}
    }
  }
  snapshot() { return [...this.index.values()]; }
  create(spec, { mode = 'foreground', handle = null } = {}) {
    const jid = uid('job');
    const job = { id: jid, spec, mode, handle: handle || uid('hdl'), state: 'queued', createdAt: Date.now(), updatedAt: Date.now(), progress: 0, log: [], result: null };
    this.index.set(jid, job);
    this.ev(jid, 'created', { spec });
    this.persist();
    return job;
  }
  setState(jid, state, payload) {
    const j = this.index.get(jid);
    if (!j) return null;
    j.state = state;
    j.updatedAt = Date.now();
    if (payload) Object.assign(j, payload);
    this.ev(jid, state, payload || {});
    this.persist();
    return j;
  }
  appendLog(jid, msg) {
    const j = this.index.get(jid);
    if (!j) return;
    j.log.push({ ts: Date.now(), msg });
    if (j.log.length > 500) j.log.shift();
    this.ev(jid, 'log', { msg });
    this.persist();
  }
  finish(jid, result) {
    const j = this.index.get(jid);
    if (!j) return;
    j.state = 'done';
    j.result = result;
    j.updatedAt = Date.now();
    j.progress = 1;
    this.ev(jid, 'done', result);
    this.persist();
    this.emit('done', j);
  }
  ev(jid, type, payload) {
    const env = { jid, type, ts: now(), payload };
    try { appendJsonl(path.join(this.dir, `${jid}.jsonl`), env); } catch (_) {}
    this.emit(type, env);
  }
  persist() {
    const idxFile = path.join(this.dir, 'index.json');
    writeFileSafe(idxFile, JSON.stringify([...this.index.values()], null, 2));
  }
}

module.exports = { JobStore };