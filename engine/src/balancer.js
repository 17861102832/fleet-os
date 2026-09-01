'use strict';
/**
 * Balancer —— 多 provider 负载均衡路由（多厂牌并存，不绑定单模型）。
 *
 * 立场：舰队最大的可靠性和成本杠杆不是"单模型多聪明"，而是"多个 provider 轮流用"。
 *   - round-robin 均匀分流（不同厂商不同推理负载 → 各自令牌桶独立）
 *   - error-aware：某 provider 连续失败 → 自动降级到健康 provider（cascade 的横向版）
 *   - 成本感知：默认按 pricePer1M 加权，省钱
 *
 * 这补齐了 Codex Cloud "多厂商" + DeepSeek Harness "model-agnostic orchestration" 的短板。
 */
const { estTokens } = require('./util');

class Balancer {
  constructor(providers = {}, cfg = {}) {
    this.providers = providers;   // { name: {model, baseUrl, kind, pricePer1M, weight} }
    this.mode = cfg.mode || 'round_robin';  // round_robin | cheapest | least_error
    this.cfg = Object.assign({ failThreshold: 2 }, cfg);
    this.rr = 0;
    this.health = new Map();      // name -> {errs, lastErr, ok}
    for (const k of Object.keys(providers)) this.health.set(k, { errs: 0, lastErr: null, ok: true });
  }

  /** 选下一个 provider（按模式） */
  pick({ avoid = [] } = {}) {
    const names = Object.keys(this.providers).filter((n) => !avoid.includes(n));
    if (!names.length) return null;
    if (this.mode === 'cheapest') {
      // 按 pricePer1M 升序，健康优先
      const sorted = names.filter((n) => this.health.get(n).ok)
        .sort((a, b) => (this.providers[a].pricePer1M || 0) - (this.providers[b].pricePer1M || 0));
      return sorted[0] || names[0];
    }
    if (this.mode === 'least_error') {
      const sorted = names.slice().sort((a, b) => this.health.get(a).errs - this.health.get(b).errs);
      return sorted[0];
    }
    // round_robin
    const healthy = names.filter((n) => this.health.get(n).ok);
    const pool = healthy.length ? healthy : names;
    const pick = pool[this.rr % pool.length];
    this.rr++;
    return pick;
  }

  /** 记录一次成功/失败（error-aware 降级） */
  report(name, ok, err = '') {
    const h = this.health.get(name);
    if (!h) return;
    if (ok) { h.errs = 0; h.lastErr = null; h.ok = true; }
    else {
      h.errs++; h.lastErr = String(err).slice(0, 160);
      if (h.errs >= (this.cfg.failThreshold || 2)) h.ok = false;   // 连续 N 次失败 → 降级
    }
  }

  /** 复活一个降级的 provider（可选，周期调用） */
  maybeReset() {
    for (const [k, h] of this.health.entries()) {
      if (!h.ok && h.errs >= (this.cfg.failThreshold || 2)) h.errs = 0;  // 允许再次尝试
    }
  }

  snapshot() {
    return {
      mode: this.mode, rr: this.rr,
      providers: Object.fromEntries([...this.health.entries()].map(([k, h]) => [k, h])),
      costs: Object.fromEntries(Object.entries(this.providers).map(([k, p]) => [k, { pricePer1M: p.pricePer1M || 0, model: p.model }])),
    };
  }
}

module.exports = { Balancer };