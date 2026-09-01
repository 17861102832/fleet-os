'use strict';
/**
 * Compactor —— 上下文压缩/窗口安全（对齐 ACC / MS Agent Compaction / Observation Masking）。
 *
 * 问题：黑板是 append-only，长程舰队 token 无限增长 → context rot（注意力耗尽、模型忘前提、
 *       lost-in-the-middle、token成本→前30%步骤20%token / 后30%步骤烧50%token）。
 *
 * 方案：三层 + 摘要替换事件（append-only 永不丢原始，只换"模型此后看到的表象"）：
 *   Tier 热  模型可见：当前回合 + 相关切片（board.query 已做 token 预算裁剪）
 *   Tier 温  近期记忆：最近 N 条原文，保留
 *   Tier 冷  已压缩：旧记录合并成结构化摘要，原文仍留 append-only ledger（可回放审计）
 *
 * 触发（MS CompactionTriggers 同款）：
 *   TokensExceed(maxTokens) / MessagesExceed(maxGroups) / TurnsExceed(maxTurns)
 *
 * 观测屏蔽（JetBrains 52% token 降，不损完成率）：旧 tool 输出替换成结构化占位符，
 *   只留 {tool, 摘要, 指针}——大产物始终"指而不内联"。
 */

const { estTokens, truncate, now, appendJsonl, ensureDir } = require('./util');
const fs = require('fs');
const path = require('path');

class Compactor {
  constructor({ stateDir, maxBoardTokens = 900, hotKeep = 8, coldAfter = 40, audit = true }) {
    this.stateDir = stateDir;
    this.maxBoardTokens = maxBoardTokens;   // 给模型看的黑板预算
    this.hotKeep = hotKeep;                 // 温段保留条数
    this.coldAfter = coldAfter;             // 超过 N 条开始把最旧的压到冷段
    this.audit = audit;
    ensureDir(stateDir);
  }

  /** 看板 → 模型可见视图（分段：热段原文 + 冷段摘要），token 预算硬上限 */
  render(board) {
    const records = board.records || [];
    const hot = records.slice(-this.hotKeep);
    const cold = records.slice(0, Math.max(0, records.length - this.hotKeep));
    const coldSummary = this._summary(cold);
    const lines = [];
    coldSummary.forEach((s) => lines.push(`[cold] ${s}`));
    hot.forEach((r) => lines.push(this._line(r)));
    const budgeted = [];
    let used = 0;
    for (const l of lines) {
      const t = estTokens(l);
      if (used + t > this.maxBoardTokens) break;
      budgeted.push(l); used += t;
    }
    if (used >= this.maxBoardTokens && budgeted.length < lines.length) budgeted.push(`…[+${lines.length - budgeted.length} 条已被压缩，全文见 ledger]`);
    return budgeted.join('\n');
  }

  /** 冷段 → 结构化摘要（observation masking：只留工具名/摘要/指针） */
  _summary(cold) {
    if (!cold.length) return [];
    // 按类型聚合
    const byType = {};
    cold.forEach((r) => { byType[r.type] = (byType[r.type] || 0) + 1; });
    const total = cold.length;
    const lastTs = cold[cold.length - 1].ts;
    const lastBody = cold[cold.length - 1].head || cold[cold.length - 1].body || '';
    const out = [`压缩摘要：${total} 条 → 按类型 ${Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(', ')}`, `最近的：${truncate(lastBody, 120)}`];
    // 关键事实/决策保留（绝不丢），其余归并
    const keep = cold.filter((r) => ['fact', 'decision', 'blocker'].includes(r.type)).slice(-6);
    keep.forEach((r) => out.push(`[${r.type}] ${truncate(r.head || r.body || '', 100)}`));
    return out;
  }

  _line(r) {
    if (r.artifact) {
      // observation masking：产物"指而不内联"，只留指针+摘要
      return `[${r.type}·${r.author}·c${r.confidence}] ${r.head || ''} →${r.artifact}`;
    }
    return `[${r.type}·${r.author}·c${r.confidence}] ${truncate(r.body || '', 160)}`;
  }

  /** 主动触发压缩（tick 调用）：超过 coldAfter 就合并最旧的进冷段，返回被压缩数量 */
  maybeCompact(board) {
    const records = board.records;
    if (records.length <= this.coldAfter) return { compacted: 0 };
    const toCold = records.slice(0, records.length - this.hotKeep);
    if (!toCold.length) return { compacted: 0 };
    const sig = toCold.map((r) => r.id).join(',');
    if (this.__lastSig === sig) return { compacted: 0 };
    this.__lastSig = sig;
    const did = toCold.length;
    if (this.audit) {
      try { appendJsonl(path.join(this.stateDir, 'compactions.jsonl'), { at: now(), compacted: did, total: records.length, summary: this._summary(toCold) }); } catch (_) {}
    }
    return { compacted: did };
  }

  stats(board) {
    return { total: board.records.length, hot: Math.min(this.hotKeep, board.records.length), cold: Math.max(0, board.records.length - this.hotKeep), estTokens: estTokens(this.render(board).slice(0, 2000)) };
  }
}

module.exports = { Compactor };