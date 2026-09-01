'use strict';
/**
 * Filemap / Repo-aware context —— SWE-Agent 同款：filemap 工具查看 Python 文件 + 全局搜索只列匹配文件。
 *
 * 立场：舰队的 worker 在写代码类任务时，**必须**先有一个 filemap 上下文；
 *       盲目喂 ls -R 会让 token 飞。预算按 1000 tokens 默认。
 */
const fs = require('fs');
const path = require('path');
const { estTokens } = require('./util');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.next', 'out', '__pycache__', 'artifacts', 'state', 'personas', 'skills']);
const MAX_VIEW_LINES = 100;

class FileMap {
  constructor(root) { this.root = root; this.cache = new Map(); this.ttl = 30_000; }

  /** 全局搜索：只返回匹配的文件名列表，token 极省 */
  grep(pattern, { cwd, max = 50 } = {}) {
    const root = cwd || this.root;
    const hits = [];
    const re = new RegExp(pattern);
    const walk = (d) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of ents) {
        if (SKIP_DIRS.has(ent.name)) continue;
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (hits.length < max) {
          try { const body = fs.readFileSync(p, 'utf8'); if (re.test(body)) hits.push(p); } catch (_) {}
        }
      }
    };
    walk(root);
    return hits;
  }

  /** 单文件视图：每次只显示前 ~100 行（仿 SWE-Agent）） */
  view(file, { fromLine = 0, maxLines = MAX_VIEW_LINES } = {}) {
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch (_) { return { error: 'cannot_read' }; }
    const lines = body.split('\n');
    const slice = lines.slice(fromLine, fromLine + maxLines).join('\n');
    return { file, fromLine, totalLines: lines.length, body: slice, tokens: estTokens(slice) };
  }

  /** 仿 filemap：对指定 cwd 生成 token 预算内的"文件签名视图" */
  filemap({ cwd, focus = [], budget = 1200 } = {}) {
    const key = (cwd || '') + '|' + focus.join(',') + '|' + budget;
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < this.ttl) return c.text;
    const root = cwd || this.root;
    const files = [];
    const walk = (d) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of ents) {
        if (SKIP_DIRS.has(ent.name)) continue;
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(root);
    let used = 0;
    const out = [];
    for (const f of files) {
      const rel = path.relative(root, f);
      if (focus.length && !focus.some((k) => rel.toLowerCase().includes(k.toLowerCase()))) continue;
      let head;
      try { head = fs.readFileSync(f, 'utf8').split('\n').slice(0, 40).join('\n'); } catch (_) { continue; }
      const sigs = [];
      for (const ln of head.split('\n')) {
        if (/^\s*(export\s+)?(async\s+)?function\s+\w+|^def\s+\w+|^class\s+\w+|^struct\s+\w+|^pub\s+fn\s+\w+|^interface\s+\w+|^type\s+\w+/.test(ln)) sigs.push(ln.trim());
      }
      const block = `## ${rel}\n${sigs.join('\n') || '(no exported symbols detected)'}\n`;
      if (used + block.length > budget) break;
      out.push(block); used += block.length;
    }
    const text = out.join('\n');
    this.cache.set(key, { at: Date.now(), text });
    return text;
  }
}

module.exports = { FileMap };