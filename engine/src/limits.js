'use strict';
/**
 * 并发与预算护栏。
 * 关键立场：并行数不是信仰，是配额问题。真正的极限来自
 *   1) 全局槽位（本机 CPU / 会话数）
 *   2) 每个 provider 的令牌桶（QPS/TPM 合法配额，超了排队而不是硬冲）
 *   3) 舰队预算（token / 钱 / 墙钟），到线即停
 */
const { ts, estTokens } = require('./util');

class TokenBucket {
  constructor({ ratePerSec = 1, burst = 1 } = {}) {
    this.rate = Math.max(0.05, ratePerSec);
    this.burst = Math.max(1, burst);
    this.level = this.burst;
    this.at = ts();
  }
  tryTake(n = 1) {
    const t = ts();
    this.level = Math.min(this.burst, this.level + ((t - this.at) / 1000) * this.rate);
    this.at = t;
    if (this.level >= n) { this.level -= n; return true; }
    return false;
  }
  retryInMs(n = 1) {
    const deficit = n - this.level;
    return Math.ceil((deficit / this.rate) * 1000);
  }
}

class Budget {
  constructor({ maxTokens = 0, maxCostUsd = 0, maxWallMs = 0 } = {}) {
    this.maxTokens = maxTokens;
    this.maxCostUsd = maxCostUsd;
    this.maxWallMs = maxWallMs;
    this.tokens = 0;
    this.cost = 0;
    this.startedAt = ts();
  }
  spend({ tokens = 0, cost = 0 } = {}) {
    this.tokens += tokens;
    this.cost += cost;
  }
  remaining(nowMs) {
    const t = nowMs || ts();
    const out = { ok: true, why: [] };
    if (this.maxTokens && this.tokens >= this.maxTokens) { out.ok = false; out.why.push('max_tokens'); }
    if (this.maxCostUsd && this.cost >= this.maxCostUsd) { out.ok = false; out.why.push('max_cost'); }
    if (this.maxWallMs && t - this.startedAt >= this.maxWallMs) { out.ok = false; out.why.push('max_wallclock'); }
    return out;
  }
  snapshot() {
    return {
      tokens: this.tokens, cost: +this.cost.toFixed(4), maxTokens: this.maxTokens,
      maxCostUsd: this.maxCostUsd, elapsedMs: ts() - this.startedAt,
    };
  }
}

/** 调度用的并发闸门：谁能拿槽位 */
class Gate {
  constructor(cfg) {
    this.global = (cfg.limits && cfg.limits.maxConcurrent) || 16;
    this.perWorker = (cfg.limits && cfg.limits.perWorkerSlots) || 4;
    this.buckets = new Map();
    const providers = cfg.providers || {};
    for (const name of Object.keys(providers)) {
      const p = providers[name];
      this.buckets.set(name, new TokenBucket({
        ratePerSec: (p.concurrency && p.concurrency.ratePerSec) || 1,
        burst: (p.concurrency && p.concurrency.burst) || Math.max(1, (p.concurrency && p.concurrency.maxParallel) || 2),
      }));
      this.buckets.set('model:' + (p.model || name), new TokenBucket({
        ratePerSec: (p.concurrency && p.concurrency.ratePerSec) || 1,
        burst: (p.concurrency && p.concurrency.maxParallel) || 2,
      }));
    }
  }
  providerKey(providerName) {
    return this.buckets.has(providerName) ? providerName : null;
  }
  tryAcquire({ provider, workerSlots, globalActive }) {
    if (globalActive >= this.global) return { ok: false, why: 'global_slots', retryInMs: 500 };
    if (workerSlots >= this.perWorker) return { ok: false, why: 'worker_slots', retryInMs: 500 };
    const b = this.buckets.get(provider);
    if (b && !b.tryTake(1)) return { ok: false, why: 'provider_quota', retryInMs: b.retryInMs(1) };
    return { ok: true };
  }
}

module.exports = { TokenBucket, Budget, Gate, estTokens };
