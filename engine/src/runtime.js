'use strict';
/**
 * Runtime Limits —— Codex CLI 默认值硬搬：
 *   agents.max_threads         默认 6   同时打开的最大 agent 线程数
 *   agents.max_depth           默认 1   root 为 0，只允许直接子 agent，禁止递归
 *   agents.job_max_runtime_s   默认 1800  单个 job 的默认超时（秒）
 *   project_doc_max_bytes      默认 32 KiB  AGENTS.md 累计字节上限
 *
 * 立场：递归会爆。深度=1 是 Codex 给出的保守最佳实践，不许改大；
 *       并发上限要看 provider 的 ratePerSec × burst，而不是无脑加。
 *
 * 同时实现 AutoGen v0.4 的 actor model 边界：
 *   一次 fleet 里 topic+subscription 形成的订阅图 = 有向无环图。
 *   depth = 1 限制 parent-child 关系最浅，防止 groupthink 与 token 雪崩。
 */
const DEFAULT_LIMITS = {
  maxThreads: 6,
  maxDepth: 1,
  jobMaxRuntimeMs: 1800 * 1000,
  projectDocMaxBytes: 32 * 1024,
  perWorkerSlots: 4,
  globalConcurrent: 16,
};

class RuntimeLimits {
  constructor(overrides = {}) {
    this.cfg = Object.assign({}, DEFAULT_LIMITS, overrides);
    this.activeThreads = 0;
    this.activeJobs = new Map();
  }

  /** hub 在 lease 之前判断：能否再起一个 worker 线程？ */
  canSpawnThread() { return this.activeThreads < this.cfg.maxThreads; }

  reserveThread(jid, workerId) {
    if (!this.canSpawnThread()) return { ok: false, why: 'max_threads', retryInMs: 500 };
    this.activeThreads++;
    this.activeJobs.set(jid, { workerId, startedAt: Date.now(), deadline: Date.now() + this.cfg.jobMaxRuntimeMs });
    return { ok: true };
  }

  releaseThread(jid) {
    if (this.activeJobs.delete(jid)) this.activeThreads = Math.max(0, this.activeThreads - 1);
  }

  reap() {
    const t = Date.now();
    for (const [jid, j] of this.activeJobs.entries()) {
      if (t > j.deadline) {
        this.releaseThread(jid);
        return { jid, why: 'job_max_runtime' };
      }
    }
    return null;
  }

  /** depth 校验：舰队里节点产生的 plan.packages 是 depth+1，禁止递归 */
  assertDepth(currentDepth, childDepth) {
    return childDepth <= this.cfg.maxDepth;
  }

  snapshot() {
    return Object.assign({ activeThreads: this.activeThreads, activeJobs: this.activeJobs.size }, this.cfg);
  }
}

module.exports = { RuntimeLimits, DEFAULT_LIMITS };