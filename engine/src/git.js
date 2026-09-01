'use strict';
/**
 * 并行写码的物理隔离：一条 lane 一个 git worktree，各自在自己分支上改，收口时排队合并。
 * Kimi 的 swarm 只能读，动不了你的仓库；舰队能在同一个仓库上开 N 条互不踩脚的写入道。
 * 默认关闭（spec.worktree=true 才启用），绝不在你没说要改的仓库上动手。
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ensureDir } = require('./util');

function isRepo(repo) {
  try { sh('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree']); return true; } catch (_) { return false; }
}
function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function ensureWorktree({ repo, baseDir, nodeId, branch = null }) {
  ensureDir(baseDir);
  const wt = path.join(baseDir, nodeId.replace(/[^a-z0-9_.-]/gi, '_'));
  const br = branch || `fleet/${nodeId.replace(/[^a-z0-9_.-]/gi, '_')}`;
  if (fs.existsSync(wt)) return { worktree: wt, branch: br, created: false };
  try {
    sh('git', ['-C', repo, 'worktree', 'add', '-B', br, wt]);
    return { worktree: wt, branch: br, created: true };
  } catch (e) {
    return { error: String(e.stderr || e.message).slice(0, 400) };
  }
}

function mergeQueue({ repo, branches, strategy = 'no-ff', author = null }) {
  // merge --no-ff 会产生 merge commit，必须带提交身份；不碰用户 git config，用一次性 -c
  const gc = ['-c', `user.name=${(author && author.name) || 'Fleet Refinery'}`, '-c', `user.email=${(author && author.email) || 'refinery@fleet.local'}`, '-c', 'commit.gpgsign=false'];
  const results = [];
  for (const b of branches) {
    try {
      const out = sh('git', ['-C', repo, ...gc, 'merge', '--no-edit', `--${strategy}`, b]);
      results.push({ branch: b, ok: true, out: out.slice(0, 500) });
    } catch (e) {
      try { sh('git', ['-C', repo, 'merge', '--abort']); } catch (_) {}
      results.push({ branch: b, ok: false, out: String(e.stderr || e.message).slice(0, 500) });
    }
  }
  return results;
}

function pruneWorktrees({ repo, baseDir }) {
  try { sh('git', ['-C', repo, 'worktree', 'prune']); } catch (_) {}
  return baseDir;
}

module.exports = { isRepo, ensureWorktree, mergeQueue, pruneWorktrees, sh };
