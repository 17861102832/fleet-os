'use strict';
/**
 * FleetBus —— 跨舰队协同总成：
 *   1) fleet-to-fleet 消息总线（A 舰队的发现 → B 舰队的输入）
 *   2) 舰队间依赖（fleet B 等 fleet A settle 后才开跑）
 *   3) Agent Teams 同层互喂证据（teammate peer ping，区别于 subagent 父子）
 *
 * 关键立场：
 *   - 舰队从不"聊天"，只发类型化 handoff（artifact/fact/dependency/peer_ping）
 *   - B 消费 A 的产物 = 把 A 的 artifact 指针写进 B 的黑板，不复制全文（token 隔离）
 *   - peer 互喂 = 同层舰员 ping 对方已验证的证据，结果仍要过自己的盲评（防从众）
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { appendJsonl, ensureDir, now, uid, truncate } = require('./util');

class FleetBus extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    ensureDir(dir);
    this.orders = new Map();   // dest_fleet_id -> [{source, artifacts, facts, at}]
    this.peers = new Map();    // fleet_id -> Set<team_persona> (同层小队)
    this.deps = new Map();     // fleet_id -> [dep_fleet_id]
  }

  /** 舰队 A 把成果 handoff 给舰队 B（异步投递，B 开局或运行时拉取） */
  handoff({ source, dest, artifacts = [], facts = [], note = '' }) {
    const order = { source, dest, artifacts: artifacts.slice(0, 50), facts: facts.slice(0, 30), note: truncate(note, 400), at: now() };
    if (!this.orders.has(dest)) this.orders.set(dest, []);
    this.orders.get(dest).push(order);
    appendJsonl(path.join(this.dir, 'orders.jsonl'), order);
    this.emit('handoff', order);
    return order;
  }

  /** 舰队 B 消费 A 的投递：写入黑板，返回可注入的上下文段 */
  async consume(fleetId, blackboard) {
    const orders = this.orders.get(fleetId) || [];
    const lines = [];
    for (const o of orders) {
      for (const a of o.artifacts) {
        // 只把指针+摘要进黑板，全文留在 A 的文件系统
        const rec = blackboard.put({ type: 'fact', body: `[handoff:${o.source}] artifact ${a}`, author: o.source, confidence: 0.8, tags: ['handoff'] });
        lines.push(`- (来自 ${o.source}) ${truncate(String(a), 120)}`);
      }
      for (const f of o.facts) lines.push(`- (来自 ${o.source} 的事实) ${truncate(String(f), 160)}`);
      if (o.note) lines.push(`- (来自 ${o.source} 备注) ${o.note}`);
    }
    return lines.join('\n');
  }

  /** 声明舰队间依赖：B 依赖 [A1, A2]，A 未 settle 前 B 不 ready */
  dependsOn(fleetId, depFleetIds) {
    this.deps.set(fleetId, [].concat(depFleetIds));
  }
  depsOf(fleetId) { return this.deps.get(fleetId) || []; }
  depsMet(fleetId, settledSet) {
    return (this.deps.get(fleetId) || []).every((d) => settledSet.has(d));
  }

  /** Agent Teams 同层：把一个 persona 注册进某舰队的"同僚小队" */
  joinTeam(fleetId, persona) {
    if (!this.peers.has(fleetId)) this.peers.set(fleetId, new Set());
    this.peers.get(fleetId).add(persona);
  }
  teamOf(fleetId) { return [...(this.peers.get(fleetId) || [])]; }

  /** 同层互喂证据：peer_a 把已验证证据 ping 给 peer_b（仍要过 B 的盲评） */
  peerPing({ fleetId, from, to, evidence = [], note = '' }) {
    const msg = { fleetId, from, to, evidence: evidence.slice(0, 20), note: truncate(note, 300), at: now() };
    const key = fleetId + ':' + to;
    if (!this.peers.has(key)) this.peers.set(key, []);
    this.peers.get(key).push(msg);
    appendJsonl(path.join(this.dir, 'peers.jsonl'), msg);
    this.emit('peer_ping', msg);
    return msg;
  }
  peerInbox(fleetId, persona) {
    return this.peers.get(fleetId + ':' + persona) || [];
  }

  snapshot() {
    return {
      orders: [...this.orders.entries()].map(([k, v]) => ({ dest: k, count: v.length })),
      deps: [...this.deps.entries()].map(([k, v]) => ({ fleet: k, depends: v })),
      peers: [...this.peers.keys()].filter((k) => k.includes(':')).length,
    };
  }
}

module.exports = { FleetBus };