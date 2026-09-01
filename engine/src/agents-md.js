'use strict';
/**
 * AGENTS.md / CLAUDE.md 协议 —— Codex / Claude Code 同款：项目指令从根到 cwd 逐级叠加，越靠近 cwd 优先级越高。
 *
 * 立场：用户已经会写自然语言意图；系统要从仓库里读出"项目知道的事情"，塞进 worker prompt。
 *       不要让 worker 自己去找 README，找出来的内容会过时且占 token。
 *
 * 叠加规则：
 *   ~/.codex/AGENTS.override.md > ~/.codex/AGENTS.md > 项目根/AGENTS.override.md > 项目根/AGENTS.md >
 *   ... 逐级向 cwd 向下，每层选择 AGENTS.override.md 或 AGENTS.md 或 fallback 文件。
 *   累计字节上限 projectDocMaxBytes（默认 32 KiB）。
 *   最终输出按"层级深度倒序"——越靠近 cwd 的规则写在越前面（覆盖）。
 */
const fs = require('fs');
const path = require('path');
const { truncate } = require('./util');

const FALLBACKS_DEFAULT = ['AGENTS.md', 'AGENTS.override.md', '.agents.md', 'TEAM_GUIDE.md'];
const HOME = process.env.USERPROFILE || process.env.HOME || '';

class AgentsMd {
  constructor({ root, fallbackNames = FALLBACKS_DEFAULT, maxBytes = 32 * 1024 } = {}) {
    this.root = root;
    this.fallbackNames = fallbackNames;
    this.maxBytes = maxBytes;
    this.layers = [];
  }

  /** 给定 cwd，从 root 一路扫到 cwd，每层选最具体的指令文件 */
  collect(cwd) {
    this.layers = [];
    const home = HOME;
    if (home) this._maybeLayer(path.join(home, '.codex'), 0);
    if (home) this._maybeLayer(home, 0);
    let rel = path.relative(this.root, cwd || process.cwd());
    if (rel.startsWith('..')) rel = '';
    const segs = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
    let acc = this.root;
    for (let i = 0; i < segs.length; i++) {
      acc = path.join(acc, segs[i]);
      this._maybeLayer(acc, i + 1);
    }
    return this.layers;
  }

  _maybeLayer(dir, depth) {
    for (const name of this.fallbackNames) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        try {
          let body = fs.readFileSync(p, 'utf8');
          if (body.length > this.maxBytes) body = truncate(body, this.maxBytes);
          this.layers.push({ depth, dir, file: p, body });
          return;
        } catch (_) {}
      }
    }
  }

  /** 渲染为 prompt 段：越靠近 cwd 的写在越前面（覆盖优先级），用清晰的层级分隔符 */
  render(cwd) {
    this.collect(cwd);
    if (!this.layers.length) return '';
    // 倒序：depth 越大越靠近 cwd，越先被读到
    const sorted = this.layers.slice().sort((a, b) => b.depth - a.depth);
    return '\n\n【项目 AGENTS.md 协议（按覆盖优先级从高到低）】\n' +
      sorted.map((l) => `--- depth=${l.depth} ${l.file} ---\n${l.body}`).join('\n\n');
  }

  /** 估算 token 占用 */
  tokenCount() {
    return this.layers.reduce((sum, l) => sum + Math.ceil(l.body.length / 3.6), 0);
  }
}

module.exports = { AgentsMd, FALLBACKS_DEFAULT };