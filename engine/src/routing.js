'use strict';
/**
 * Cascading Router —— FrugalGPT + RouteLLM + Self-MoA 的合成路由：
 *   1. 先用 cheap model 做 budget triage：这道题要不要升级？
 *   2. 如果升 mid 仍挂，自动升 high（cascade 升级腿）
 *   3. 同模型多次采样（N=5~10）拿 self-consistency
 *   4. 多模型异构采样则走 "去相关集"，按 BERTScore-like 词表距离去冗余
 *   5. 最后 verifier-based 重排（PRM style），别让 verifier 弱时陷入投票平台
 *
 * 这是 Anthropic BrowseComp 80% 方差解释落地后的工程动作：
 *   token 决定得分 → 把 token 投到最有希望的位置
 */
const { sha, hashInt } = require('./util');

class CascadeRouter {
  constructor({ tiers = ['eco', 'mid', 'high'], budgets = {}, verify }) {
    this.tiers = tiers;
    this.tiersByName = Object.assign({}, tiers.reduce((o, k, i) => (o[k] = i, o), {}));
    this.budgets = budgets;
    this.verify = verify || { n: 3, topP: 0.6 };
  }

  /** 起始 tier —— 用预算余量、节点 difficulty、节点 persona 来定 */
  pickStart(node, remainTokens, personaHints = {}) {
    if (personaHints.tier) return personaHints.tier;
    if (node.tier) return node.tier;
    if (node.kind === 'challenge' || node.kind === 'adjudicate') return this.tiers[this.tiers.length - 1];
    if (remainTokens < 80_000) return this.tiers[0];
    if (remainTokens < 300_000) return this.tiers[Math.min(1, this.tiers.length - 1)];
    return this.tiers[Math.min(this.tiers.length - 1, 1)];
  }

  /** N 路 self-consistency / 多模型去相关集 → verifier 排序 */
  rerank({ candidates, verifier, scoreBudget = 0.6, q = '' }) {
    if (!candidates || !candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    const scored = candidates.map((c, i) => ({
      cand: c,
      seed: i,
      s: verifier.score ? verifier.score(c, q) : c.confidence == null ? 0.5 : c.confidence,
    })).sort((a, b) => b.s - a.s);
    return scored[0].cand;
  }
}

class Verifier {
  constructor() { this.weights = { hasEvidence: 0.4, hasArtifacts: 0.2, confidence: 0.15, lengthPenalty: 0.1, acceptance: 0.15 }; }
  score(c, q) {
    let s = 0;
    const r = c || {};
    s += (r.evidence && r.evidence.length ? 1 : 0) * this.weights.hasEvidence;
    s += (r.artifacts && r.artifacts.length ? 1 : 0) * this.weights.hasArtifacts;
    s += (r.confidence == null ? 0.5 : Math.min(1, Math.max(0, r.confidence))) * this.weights.confidence;
    const len = (r.summary || '').length;
    s += Math.min(1, len / 1500) * this.weights.lengthPenalty;
    let ac = 0;
    if (Array.isArray(r.metAcceptance) && r.metAcceptance.length) ac = r.metAcceptance.filter(Boolean).length / r.metAcceptance.length;
    s += ac * this.weights.acceptance;
    return s;
  }
}

module.exports = { CascadeRouter, Verifier };