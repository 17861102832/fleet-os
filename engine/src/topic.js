'use strict';
/**
 * Topic Bus —— AutoGen v0.4 RoutedAgent + Subscription 模型的核心抽象。
 *
 *   TopicId: 分类通道（"fleet/{id}/node/{nodeId}"）
 *   Subscription: agent 订阅某些 topic
 *   RoutedAgent: 收到 topic 上的消息时执行 handler
 *
 * 立场：舰队里的舰员不直接调用彼此，所有通信走 topic bus。
 *       这把 v1 的一对一调用改成了"发布-订阅"，为多对多并行 + 自循环留口。
 */
const { EventEmitter } = require('events');
const { appendJsonl } = require('./util');

class TopicBus extends EventEmitter {
  constructor(audit) {
    super();
    this.subs = new Map(); // topic -> Set<routedAgent>
    this.audit = audit;
  }

  subscribe(topic, agent) {
    if (!this.subs.has(topic)) this.subs.set(topic, new Set());
    this.subs.get(topic).add(agent);
  }

  publish(topic, message) {
    const subs = this.subs.get(topic) || new Set();
    const wild = this.subs.get('*') || new Set();
    if (this.audit) try { appendJsonl(this.audit, { topic, message, at: Date.now() }); } catch (_) {}
    const targets = [...subs, ...wild];
    for (const a of targets) {
      try { a.onMessage(topic, message); } catch (e) { /* 不让一个 agent 报错破坏整个 topic */ }
    }
    return targets.length;
  }

  fanout(topicToMessages) {
    const out = {};
    for (const [t, m] of Object.entries(topicToMessages || {})) out[t] = this.publish(t, m);
    return out;
  }

  topicsFor(agent) {
    const out = [];
    for (const [t, set] of this.subs.entries()) if (set.has(agent)) out.push(t);
    return out;
  }

  /** Magentic-One 同款：group chat manager 根据规则选下一个发言者 */
  selectSpeaker(candidates, rule, ctx) {
    if (rule === 'round_robin') {
      this.__rr = (this.__rr == null ? -1 : this.__rr) + 1;
      return candidates[this.__rr % candidates.length];
    }
    if (rule === 'least_active') {
      let best = candidates[0], min = Infinity;
      for (const c of candidates) {
        const n = (ctx && ctx.recent && ctx.recent[c.id]) || 0;
        if (n < min) { min = n; best = c; }
      }
      return best;
    }
    return rule && rule.next ? candidates.find((c) => c.id === rule.next) || candidates[0] : candidates[0];
  }
}

class RoutedAgent {
  constructor(id) {
    this.id = id;
    this.handlers = new Map();
  }

  onMessage(topic, message) {
    const h = this.handlers.get(topic) || this.handlers.get('*');
    if (h) h(message, topic);
  }

  on(topic, handler) { this.handlers.set(topic, handler); return this; }
}

module.exports = { TopicBus, RoutedAgent };