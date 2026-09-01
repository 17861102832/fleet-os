'use strict';
/**
 * Skills —— OpenHands 的 progressive disclosure + Anthropic 的 Skills 协议 + Aider 的 RepoMap。
 *
 * 核心立场：skill 不是"一份大文档"，而是"一份按需加载的约定包"。
 *   Tier-0  always-loaded   只有 name + one-line description（~150 bytes）
 *   Tier-1  on-match        命中关键词/路径才把 SKILL.md 加载到 system prompt（~4kb）
 *   Tier-2  on-demand       worker 真正需要某文件/脚本时才读（git_repo_map、aider_map 等）
 *
 * 命中规则按 OpenHands 实现：keyword 触发（首行 + 命令名）+ path glob 触发（worker cwd 下匹配）
 * 编译：当 worker 装弹，系统 prompt 自动 tier-0 + tier-1。
 */
const path = require('path');
const fs = require('fs');
const { writeFileSafe, ensureDir } = require('./util');

class SkillsIndex {
  constructor(root) {
    this.root = root;
    this.skills = new Map();
    this.reload();
  }
  reload() {
    this.skills.clear();
    if (!fs.existsSync(this.root)) return;
    for (const dir of fs.readdirSync(this.root)) {
      if (dir.startsWith('.') || dir.startsWith('_')) continue;
      const full = path.join(this.root, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      const file = path.join(full, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const meta = parseFrontmatter(raw);
      const one = meta.description || firstNonEmptyLine(raw) || '';
      const id = meta.name || dir;
      this.skills.set(id, {
        id, dir, path: full, oneLine: one.trim(), keywords: extractKeywords(raw, meta),
        triggers: meta.triggers || { path: [], keyword: [] }, tier1Bytes: raw.length,
      });
    }
  }
  list() { return [...this.skills.values()]; }
  /** Tier-0: name + one-line —— 永远装入 worker 的 system 预算里 */
  catalog() { return this.skills.values(); }
  /** 按 (worker cwd + 关键词 + node mission) 命中应当 tier-1 加载的 skill */
  match({ cwd = process.cwd(), mission = '', text = '' }) {
    const hit = [];
    const hay = (mission + ' ' + text).toLowerCase();
    for (const s of this.skills.values()) {
      let score = 0;
      for (const kw of s.keywords) if (hay.indexOf(kw) >= 0) score += 1;
      if (s.triggers.path && s.triggers.path.length) {
        for (const g of s.triggers.path) if (pathMatch(g, cwd)) score += 2;
      }
      if (score > 0) hit.push({ skill: s, score });
    }
    hit.sort((a, b) => b.score - a.score);
    return hit;
  }
  /** Tier-1: 把命中的 skill 正文读出来 */
  loadTier1(ids) {
    const out = [];
    for (const id of ids) {
      const s = this.skills.get(id);
      if (!s) continue;
      const file = path.join(s.path, 'SKILL.md');
      out.push({ id, content: fs.readFileSync(file, 'utf8') });
    }
    return out;
  }
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = raw.slice(3, end);
  const out = {};
  const triggers = { keyword: [], path: [] };
  for (const line of block.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === 'triggers') {
      const inline = m[2].match(/^\[(.*)\]$/);
      if (inline) {
        for (const t of inline[1].split(',')) {
          const seg = t.trim();
          if (seg.startsWith('path:')) triggers.path.push(seg.slice(5).trim());
          else if (seg.startsWith('kw:')) triggers.keyword.push(seg.slice(3).trim());
          else triggers.keyword.push(seg);
        }
      }
    } else out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  if (triggers.keyword.length || triggers.path.length) out.triggers = triggers;
  return out;
}
function firstNonEmptyLine(raw) { for (const l of raw.split('\n')) { const t = l.trim(); if (t && !t.startsWith('#')) return t; } return ''; }
function extractKeywords(raw, meta) {
  const out = new Set();
  if (meta.name) out.add(meta.name.toLowerCase());
  if (meta.keywords) for (const k of String(meta.keywords).split(',')) out.add(k.trim().toLowerCase());
  for (const l of raw.split('\n')) {
    const t = l.trim();
    if (t.startsWith('# ') || t.startsWith('## ')) out.add(t.replace(/^#+\s*/, '').toLowerCase());
    if (t.startsWith('- ')) out.add(t.slice(2).split(/\s/)[0].toLowerCase());
    if (out.size > 30) break;
  }
  return [...out].filter((w) => w.length > 1);
}
function pathMatch(glob, cwd) {
  if (!glob) return false;
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(cwd);
}

/** 极简 Aider 风格 Repo Map（不引入 tree-sitter 依赖）—— 走 grep + 头文件做符号摘要 */
class RepoMap {
  constructor(root) { this.root = root; this.cache = new Map(); this.cacheTtl = 30_000; }
  async map({ cwd, focus = [], budget = 1200 } = {}) {
    const root = cwd || this.root;
    const key = root + '|' + focus.join(',') + '|' + budget;
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < this.cacheTtl) return c.text;
    const text = await this._build(root, focus, budget);
    this.cache.set(key, { at: Date.now(), text });
    return text;
  }
  async _build(root, focus, budget) {
    if (!fs.existsSync(root)) return '';
    const out = [];
    let used = 0;
    const skipDirs = ['node_modules', '.git', 'dist', 'build', '.cache', '.next', 'out', '__pycache__', 'artifacts', 'state', 'personas'];
    const fileLister = (d) => {
      try {
        const r = [];
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          if (skipDirs.includes(ent.name)) continue;
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) r.push(...fileLister(p));
          else if (/\.(md|py|js|ts|tsx|jsx|go|rs|c|cpp|h|hpp|java|kt|swift|rb|sh|json|yaml|yml|toml)$/i.test(ent.name)) r.push(p);
        }
        return r;
      } catch (_) { return []; }
    };
    const files = fileLister(root);
    for (const f of files) {
      const rel = path.relative(root, f);
      if (focus.length && !focus.some((k) => rel.toLowerCase().includes(k.toLowerCase()))) continue;
      let head = '';
      try { head = fs.readFileSync(f, 'utf8').split('\n').slice(0, 40).join('\n'); } catch (_) { continue; }
      const sigs = [];
      for (const ln of head.split('\n')) {
        if (/^\s*(export\s+)?(async\s+)?function\s+\w+|^def\s+\w+|^class\s+\w+|^struct\s+\w+|^pub\s+fn\s+\w+|^interface\s+\w+|^type\s+\w+/.test(ln)) sigs.push(ln.trim());
      }
      const block = `## ${rel}\n${sigs.join('\n') || '(no exported symbols detected)'}\n`;
      if (used + block.length > budget) break;
      out.push(block); used += block.length;
    }
    return out.join('\n');
  }
}

module.exports = { SkillsIndex, RepoMap };