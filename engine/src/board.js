'use strict';
/**
 * 黑板（Blackboard）—— 舰队唯一的通信介质。
 * 立场：舰员之间不许"聊天"。聊天是 token 黑洞（对等通信实测把成本翻倍到 800k 级别）。
 * 大家只往黑板写类型化记录，读时按相关性取切片，大产物落盘只回传指针。
 */
const path = require('path');
const { sha, tokenize, estTokens, writeFileSafe, uid } = require('./util');

const TYPES = ['fact', 'claim', 'artifact', 'question', 'blocker', 'decision', 'critique', 'lesson'];

class Blackboard {
  constructor({ fleetId, artifactDir }) {
    this.fleetId = fleetId;
    this.artifactDir = artifactDir;
    this.records = [];
    this.seen = new Set();
  }

  /**
   * 写一条记录。body 超过 inlineBytes 的，落盘成产物文件，黑板只留指针 + 摘要。
   * 这就是"上下文隔离"：一个舰员读 6k token 文件，只回传 400 token 摘要。
   */
  put({ type = 'claim', body = '', author = 'unknown', node = null, confidence = 0.6, tags = [], inlineBytes = 1200 }) {
    const h = sha(`${type}|${author}|${body}`);
    if (this.seen.has(h)) return { deduped: true, hash: h };
    this.seen.add(h);
    const rec = {
      id: uid('bb'), hash: h, type, author, node, confidence, tags: tags.slice(0, 8),
      ts: Date.now(), bytes: Buffer.byteLength(String(body), 'utf8'),
    };
    if (rec.bytes > inlineBytes) {
      const file = path.join(this.artifactDir, `${rec.hash}.txt`);
      writeFileSafe(file, body);
      rec.artifact = file;
      rec.head = String(body).slice(0, inlineBytes);
      rec.tokens = estTokens(body);
    } else {
      rec.body = String(body);
    }
    this.records.push(rec);
    return rec;
  }

  score(rec, q) {
    const hay = (String(rec.head || rec.body || '') + ' ' + (rec.tags || []).join(' ') + ' ' + rec.type + ' ' + rec.author).toLowerCase();
    let s = 0;
    for (const t of q) {
      let i = hay.indexOf(t);
      while (i !== -1) { s += 1; i = hay.indexOf(t, i + t.length); }
    }
    return Math.sqrt(s) + rec.confidence * 0.5;
  }

  /** 相关性检索：给 prompt 用的切片，按 token 预算裁 */
  query({ text = '', k = 12, tokenBudget = 900, excludeAuthor = null, types = null, since = 0 } = {}) {
    const q = [...new Set(tokenize(text))].filter((t) => t.length > 1);
    let pool = this.records;
    if (since) pool = pool.filter((r) => r.ts >= since);
    if (types) pool = pool.filter((r) => types.includes(r.type));
    if (excludeAuthor) pool = pool.filter((r) => r.author !== excludeAuthor);
    if (!q.length) return pool.slice(-k);
    return pool
      .map((r) => ({ r, s: this.score(r, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .reduce((acc, { r }) => {
        const cost = estTokens(r.head || r.body || '');
        if (estTokens(acc.map(lineOf).join('\n')) + cost > tokenBudget) return acc;
        acc.push(r);
        return acc;
      }, []);
  }

  stats() {
    const by = {};
    for (const r of this.records) by[r.type] = (by[r.type] || 0) + 1;
    return { total: this.records.length, byType: by };
  }
}

function lineOf(r) {
  return `[${r.type}·${r.author}·c${r.confidence}] ${r.head ? r.head + (r.artifact ? ` （全文：${r.artifact}）` : '') : r.body}`;
}

function render(records) {
  if (!records || !records.length) return '';
  return records.map(lineOf).join('\n');
}

module.exports = { Blackboard, render, TYPES };
