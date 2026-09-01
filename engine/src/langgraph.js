'use strict';
/**
 * LangGraph 适配层 —— Command / Send / Checkpoint。
 *
 *   Command(update, goto): 把"state 更新 + 路由跳转"合成一次节点返回。
 *   Send(node, arg):     conditional edge 动态调用同一 node，传不同 state。
 *   Checkpoint:          每个 super-step 保存 graph state（thread_id + seq）。
 *
 * 舰队落地：fleet.submit() 已是 Command 化（update + goto + 可重试）。
 *            拓扑的 dynamic plan = Send 化（planner 返回 packages 展开 N 路 worker）。
 *            state.js.persist() = checkpoint。
 *            state.js.replay/fork = time-travel。
 */
const fs = require('fs');
const path = require('path');
const { appendJsonl, writeFileSafe, readJsonl } = require('./util');

class Command {
  constructor(update = {}, goto = null, opts = {}) {
    this.update = update; this.goto = goto; this.opts = opts;
  }
  static PARENT = Symbol('PARENT');
}

function send(node, arg) { return { __send: true, node, arg }; }

/** 收齐 Send[] 后批量 fan-out：planner → N 个 worker */
function fanoutFromSends(sends, dispatcher) {
  const jobs = [];
  for (const s of sends || []) {
    if (s && s.__send) jobs.push(dispatcher(s.node, s.arg));
  }
  return jobs;
}

class CheckpointStore {
  constructor(dir) {
    this.dir = dir;
    this.threads = new Map();
    this.load();
  }
  load() {
    this.threads.clear();
    const f = path.join(this.dir, 'threads.json');
    if (fs.existsSync(f)) { try { for (const t of JSON.parse(fs.readFileSync(f, 'utf8'))) this.threads.set(t.threadId, t); } catch (_) {} }
  }
  save() { writeFileSafe(path.join(this.dir, 'threads.json'), JSON.stringify([...this.threads.values()], null, 2)); }
  /** 每个 super-step 一个 checkpoint；threadId = fleetId */
  write(threadId, seq, state, next = [], metadata = {}) {
    const cp = { threadId, seq, ts: Date.now(), state, next, metadata };
    this.threads.set(threadId, cp);
    this.save();
    appendJsonl(path.join(this.dir, threadId + '.checkpoints.jsonl'), cp);
    return cp;
  }
  /** 重放：从某个 seq 起重新构建 next 列表 */
  replayFrom(threadId, seq = 0) {
    const events = readJsonl(path.join(this.dir, threadId + '.checkpoints.jsonl')).filter((e) => e.seq >= seq);
    return events;
  }
  /** fork：复制到 atSeq 之前的状态 + 创建新 threadId */
  fork(threadId, atSeq, newThreadId) {
    const events = readJsonl(path.join(this.dir, threadId + '.checkpoints.jsonl')).filter((e) => e.seq <= atSeq);
    const newCp = { threadId: newThreadId, seq: atSeq, ts: Date.now(), state: events.length ? events[events.length - 1].state : null, next: [], metadata: { forkedFrom: threadId } };
    this.threads.set(newThreadId, newCp);
    this.save();
    appendJsonl(path.join(this.dir, newThreadId + '.checkpoints.jsonl'), newCp);
    return newCp;
  }
}

module.exports = { Command, send, fanoutFromSends, CheckpointStore };