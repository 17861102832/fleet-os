'use strict';
/**
 * Evolution Engine —— 舰队结束后自动提炼"技能基因"，越用越强。
 *
 * 输入：一次舰队跑完的 ledger（append-only 事件流）+ 黑板 + 节点结果
 * 输出：技能基因（可复用的做事模式）+ 策略修正 + 人格强化建议
 *
 * 三个产物：
 *   policies/    —— 从"失败→重试→成功"里提炼的硬规则
 *   skills-genome —— 从"高置信交付 + 低 token"里提炼的做事模式
 *   persona-boost —— 哪些人格在这种任务里更该被提前激活
 *
 * 这不是玄学，是对 MAST + Anthropic 结论的可执行化：
 *   "失败主要是组织性问题，不是模型不够聪明" —— 所以我们要把这些组织教训固化。
 */
const fs = require('fs');
const path = require('path');
const { readJsonl, appendJsonl, ensureDir, now, estTokens } = require('./util');

class EvolutionEngine {
  constructor(dir) {
    this.dir = dir;
    ensureDir(path.join(dir, 'policies'));
    ensureDir(path.join(dir, 'skills-genome'));
    ensureDir(path.join(dir, 'persona-boost'));
  }

  /** 跑完一个舰队后调用 */
  run(fleet) {
    const events = readJsonl(fleet.ledgerFile);
    return {
      policies: this._policies(events, fleet),
      genome: this._genome(events, fleet),
      boost: this._personaBoost(events, fleet),
    };
  }

  _stats(events) {
    const done = events.filter((e) => e.type === 'node.done');
    const failed = events.filter((e) => e.type === 'node.failed');
    const retries = events.filter((e) => e.type === 'node.retried');
    const gaveup = events.filter((e) => e.type === 'node.gaveup');
    const rejects = events.filter((e) => e.type === 'verdict.reject');
    return { done: done.length, failed: failed.length, retries: retries.length, gaveup: gaveup.length, rejects: rejects.length };
  }

  _policies(events, fleet) {
    const s = this._stats(events);
    const policies = [];
    // retries 高 → 需要"首次就做对"的策略
    if (s.retries > 0) {
      const worstNodes = {};
      events.filter((e) => e.type === 'node.retried').forEach((e) => { const id = e.data.id; worstNodes[id] = (worstNodes[id] || 0) + 1; });
      const top = Object.entries(worstNodes).sort((a, b) => b[1] - a[1])[0];
      if (top) policies.push({
        id: 'pol_retry_' + top[0], tier: 'medium', createdAt: now(),
        insight: `节点 ${top[0]} 重试 ${top[1]} 次才过 —— 升级为"首次即做对"策略`,
        action: '在 mission 里强制写验收前置条件与已知坑位，避免反复重试',
      });
    }
    // rejects 高 → 判定标准被误用，需要收紧裁决策略
    if (s.rejects > 0) {
      policies.push({ id: 'pol_judge_' + fleet.id.slice(-6), tier: 'low', createdAt: now(), insight: `舰队 ${fleet.id} 出现 ${s.rejects} 次 reject —— 检查裁决 prompt 是否过于严苛`, action: '下调裁决 acceptance 阈值或补充"可接受"判定口径' });
    }
    if (policies.length) appendJsonl(path.join(this.dir, 'policies', fleet.id + '.jsonl'), { fleet: fleet.id, policies, at: now() });
    return policies;
  }

  _genome(events, fleet) {
    // 从高置信、token 省、一次过的节点里提炼做事模式
    const genome = [];
    events.filter((e) => e.type === 'node.done').forEach((d) => {
      const p = d.data;
      if (p && p.confidence >= 0.8) {
        genome.push({
          fleet: fleet.id, node: p.persona, confidence: p.confidence, tokens: p.tokens,
          insight: `人格 ${p.persona} 高置信交付（conf=${p.confidence} tok=${p.tokens}）`,
          reuse: '下次同类节点优先唤醒该人格',
        });
      }
    });
    if (genome.length) appendJsonl(path.join(this.dir, 'skills-genome', fleet.id + '.jsonl'), { fleet: fleet.id, genome, at: now() });
    return genome.slice(0, 50);
  }

  _personaBoost(events, fleet) {
    const boost = {};
    events.filter((e) => e.type === 'node.done').forEach((d) => {
      const persona = d.data.persona;
      const conf = d.data.confidence || 0.5;
      if (!boost[persona]) boost[persona] = { done: 0, confSum: 0 };
      boost[persona].done++; boost[persona].confSum += conf;
    });
    const out = Object.entries(boost).map(([id, v]) => ({
      persona: id, done: v.done, avgConf: +(v.confSum / v.done).toFixed(2),
      recommend: v.avgConf >= 0.75 ? 'boost' : 'normal',
    }));
    if (out.length) appendJsonl(path.join(this.dir, 'persona-boost', fleet.id + '.jsonl'), { fleet: fleet.id, boost: out, at: now() });
    return out;
  }

  peek() { return { policies: fs.existsSync(path.join(this.dir, 'policies')) ? fs.readdirSync(path.join(this.dir, 'policies')) : [], genome: fs.existsSync(path.join(this.dir, 'skills-genome')) ? fs.readdirSync(path.join(this.dir, 'skills-genome')) : [], boost: fs.existsSync(path.join(this.dir, 'persona-boost')) ? fs.readdirSync(path.join(this.dir, 'persona-boost')) : [] }; }
}

module.exports = { EvolutionEngine };