'use strict';
/**
 * Permission Modes —— Claude Code 同款权限模式 + Codex approval policy 的合成：
 *   bypass      全放行（高信任环境）
 *   acceptEdits 文本编辑自动过，shell 需 ask
 *   plan        只读计划模式（禁止任何写入）
 *   default     标准 ask
 *
 * 舰队落地：每个 fleet spec 带 permissionMode；worker 的每个工具动作走权限机，
 * 命中 ask 且 autoApprove=false → 真的暂停到 awaiting_approval（reuse 审批链）。
 */
const MODES = {
  bypass:      ({ tool }) => ({ allow: true }),
  acceptEdits: ({ tool, workdir }) => {
    if (/^(Read|Search|RepoScan|Write|Edit|Bash\(ls|Bash\(cat|Bash\(git diff|Bash\(git log)/.test(tool)) return { allow: true };
    return { allow: false, needHuman: true, reason: 'acceptEdits 模式下该工具需人工批准' };
  },
  plan:        ({ tool }) => (/^(Read|Search|RepoScan|Bash\(git log|Bash\(git status|Bash\(cat|Bash\(ls)/.test(tool) ? { allow: true } : { allow: false, reason: 'plan 模式禁止写入/执行' }),
  default:     ({ tool }) => (/^(Read|Search|RepoScan|Write|Edit)$/.test(tool) ? { allow: true } : { allow: false, needHuman: true, reason: 'default 模式该工具需人工批准' }),
};

class Permissions {
  constructor({ mode = 'default', rules = [] } = {}) {
    this.mode = mode;
    this.rules = rules;   // 额外 allow/deny 覆盖（自定义）
  }
  check({ tool, workdir }) {
    const base = (MODES[this.mode] || MODES.default)({ tool, workdir });
    // 自定义 deny 高位优先
    for (const r of this.rules) {
      if (r.deny && r.pattern.test(tool)) return { allow: false, reason: r.reason || 'deny rule' };
    }
    // 自定义 allow 覆盖
    for (const r of this.rules) {
      if (r.allow && r.pattern.test(tool)) return { allow: true };
    }
    return base;
  }
  mode() { return this.mode; }
}

module.exports = { Permissions, MODES };