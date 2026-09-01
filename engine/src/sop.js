'use strict';
/**
 * MetaGPT SOP —— StandardOperatingProcedure：phase + dependency + acceptance + role subscription。
 *
 * SOP = 由 Role / Action / 订阅规则 / 消息类型 / 阶段依赖共同表达的跨角色执行契约。
 *
 * 立场：不再"用一段长 system prompt 当 SOP"，而是显式 DAG；
 *       每个 phase 标注 dependency、acceptance、escalation；role 通过 watch() 订阅 phase。
 */
const { uid, now } = require('./util');

class SOPGraph {
  constructor() {
    this.phases = new Map();
    this.transitions = []; // [from, to, when]
  }
  addPhase(phase) {
    const p = Object.assign({ id: uid('phase'), acceptance: [], dependencies: [], actions: [], escalation: null }, phase);
    this.phases.set(p.id, p);
    return p;
  }
  addTransition(from, to, when) { this.transitions.push({ from, to, when, at: now() }); }
  ready(currentDone) {
    const ready = [];
    for (const p of this.phases.values()) {
      if (currentDone.has(p.id)) continue;
      if (p.dependencies.every((d) => currentDone.has(d))) ready.push(p);
    }
    return ready;
  }
  toJSON() { return { phases: [...this.phases.values()], transitions: this.transitions }; }
}

module.exports = { SOPGraph };