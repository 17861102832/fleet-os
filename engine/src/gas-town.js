'use strict';
/**
 * Beads / Refinery / Convoy —— Gas Town 三件套的工程实现。
 *
 *   Beads = versioned task & state ledger（用 append-only JSONL + snapshot）
 *   Refinery = 队列合并多个工作分支
 *   Convoy = 一组可追踪的工作交付单元
 *
 * 立场：所有"任务状态变更"必须经过 Beads 写盘 + Refinery 排队的两道闸；
 *       Convoy 是 hub 用来追踪"一组节点"的容器。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendJsonl, writeFileSafe, uid, now, readJsonl } = require('./util');

class Beads {
  constructor(dir) {
    this.dir = dir;
    this.index = new Map();
    this.load();
  }
  load() {
    this.index.clear();
    const f = path.join(this.dir, 'beads.json');
    if (fs.existsSync(f)) {
      try { for (const b of JSON.parse(fs.readFileSync(f, 'utf8'))) this.index.set(b.id, b); } catch (_) {}
    }
  }
  save() {
    const f = path.join(this.dir, 'beads.json');
    writeFileSafe(f, JSON.stringify([...this.index.values()], null, 2));
  }
  create({ convoyId, summary, owner = null } = {}) {
    const b = { id: uid('bead'), convoyId, summary, owner, status: 'open', createdAt: Date.now(), updatedAt: Date.now() };
    this.index.set(b.id, b);
    this.save();
    appendJsonl(path.join(this.dir, 'beads.jsonl'), { event: 'created', bead: b, at: now() });
    return b;
  }
  set(id, status, payload) {
    const b = this.index.get(id);
    if (!b) return null;
    Object.assign(b, payload || {}, { status, updatedAt: Date.now() });
    this.save();
    appendJsonl(path.join(this.dir, 'beads.jsonl'), { event: status, bead: { id: b.id, status, ...payload }, at: now() });
    return b;
  }
  list(convoyId) { return [...this.index.values()].filter((b) => !convoyId || b.convoyId === convoyId); }
}

class Convoy {
  constructor(dir) {
    this.dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    this.index = new Map();
    this.load();
  }
  load() {
    this.index.clear();
    const f = path.join(this.dir, 'convoys.json');
    if (fs.existsSync(f)) {
      try { for (const c of JSON.parse(fs.readFileSync(f, 'utf8'))) this.index.set(c.id, c); } catch (_) {}
    }
  }
  save() { writeFileSafe(path.join(this.dir, 'convoys.json'), JSON.stringify([...this.index.values()], null, 2)); }
  create({ name, beadIds = [], metadata = {} } = {}) {
    const c = { id: uid('convoy'), name, beads: beadIds, metadata, status: 'active', createdAt: Date.now(), updatedAt: Date.now() };
    this.index.set(c.id, c);
    this.save();
    return c;
  }
  status(id) {
    const c = this.index.get(id);
    if (!c) return null;
    return Object.assign({}, c);
  }
  progress(id, beads) {
    const c = this.index.get(id);
    if (!c) return null;
    const total = c.beads.length;
    const done = beads.filter((b) => b.status === 'closed').length;
    c.progress = total ? +(done / total).toFixed(2) : 0;
    if (done === total) c.status = 'closed';
    c.updatedAt = Date.now();
    this.save();
    return c;
  }
}

class Refinery {
  constructor(dir) {
    this.dir = dir;
    this.queue = [];
    this.mergeLog = path.join(dir, 'refinery.jsonl');
  }
  /** 排一条 worktree 合并请求；可用 cx `mergeNow=true` 强制立刻合并 */
  enqueue({ worktreeId, branch, target, strategy = 'no-ff' }) {
    const job = { id: uid('ref'), worktreeId, branch, target, strategy, status: 'queued', at: Date.now() };
    this.queue.push(job);
    appendJsonl(this.mergeLog, { event: 'queued', job, at: now() });
    return job;
  }
  /** 实际执行：调用 git merge —— 不实际调，只返回 merged 列表与冲突列表 */
  drain(execFn = () => null) {
    const out = [];
    while (this.queue.length) {
      const job = this.queue.shift();
      const r = execFn(job);
      job.status = r && r.conflict ? 'conflict' : 'merged';
      job.mergedAt = Date.now();
      appendJsonl(this.mergeLog, { event: job.status, job, at: now() });
      out.push(job);
    }
    return out;
  }
  pending() { return this.queue.length; }
}

module.exports = { Beads, Convoy, Refinery };