'use strict';
/**
 * Policy & Approval Gate —— 把 Claude Code (allow/ask/deny) + Codex (sandbox+approval)
 * + OpenAI Agents SDK (input/output/tool guardrail) 合成一层"中央安全闸"。
 *
 * 立场：不让每个舰员自己决策"能不能写"，而是中央事先判。
 *       low-risk → 自动；mid-risk → 策略审批；high-risk → 必须人批。
 *       拒绝"沉默执行"——任何 deny 都必须把原因写账本 + 写黑板。
 */
const path = require('path');
const fs = require('fs');
const { appendJsonl } = require('./util');

const RULES = [
  { id: 'no_delete_root',  kind: 'tool', pattern: /^Bash\(rm -rf \/(?!tmp|sandbox)\b/, decision: 'deny', reason: '禁止删除根目录' },
  { id: 'no_read_secret',  kind: 'tool', pattern: /^Read\(\.\/?\.(env|env\..+|secrets?\/)/, decision: 'deny', reason: '禁止读取密钥文件' },
  { id: 'no_publish',      kind: 'tool', pattern: /^(npm publish|pip upload|docker push|git push.*--force)/, decision: 'ask',   reason: '发布/强推：必须人工批准' },
  { id: 'no_force_push',   kind: 'tool', pattern: /git push.*(-f|--force(-with-lease)?)/, decision: 'deny', reason: '禁强推 main/master' },
  { id: 'no_eval_drop',    kind: 'tool', pattern: /curl[^|]*\|\s*(sh|bash)/, decision: 'deny', reason: 'curl | sh 是经典投毒' },
  { id: 'sub_write',       kind: 'tool', pattern: /^Write\(.*\.(go|rs|c|cpp)$/, decision: 'ask', reason: '系统语言文件需策略审批' },
  { id: 'sub_workdir',     kind: 'tool', pattern: /.*/, scope: 'workdir', decision: 'allow' },
];

class PolicyGate {
  constructor(opts = {}) {
    this.humanApprover = opts.humanApprover || null;
    this.audit = opts.audit || path.join(opts.stateDir || '.', 'policy.jsonl');
    this.deny = new Map();
    this.allow = new Map();
    this.ask = new Map();
    for (const r of RULES) {
      if (r.decision === 'deny') this.deny.set(r.id, r);
      else if (r.decision === 'ask') this.ask.set(r.id, r);
      else this.allow.set(r.id, r);
    }
  }

  check(action, ctx = {}) {
    const target = String(action.tool || action.kind || '');
    const matched = [];
    for (const r of [...this.deny.values(), ...this.ask.values()]) {
      if (r.pattern.test(target)) matched.push(r);
    }
    const denied = matched.find((r) => this.deny.has(r.id));
    const asked = matched.find((r) => this.ask.has(r.id));
    const decision = denied ? 'deny' : asked ? 'ask' : 'allow';
    const audit = { ts: Date.now(), action, decision, matched: matched.map((m) => ({ id: m.id, reason: m.reason })), actor: ctx.actor || null, node: ctx.node || null, fleet: ctx.fleet || null };
    try { appendJsonl(this.audit, audit); } catch (_) {}
    if (decision === 'deny') return { allow: false, reason: denied && denied.reason, audit };
    if (decision === 'ask') return { allow: false, reason: 'awaiting_human', rule: asked.id, reasonText: asked && asked.reason, audit };
    return { allow: true, audit };
  }

  /** 给 worker 一份它能用的工具白名单（最小特权） */
  capabilityFor(persona, nodeKind) {
    const base = {
      read: ['cat', 'ls', 'grep', 'rg', 'git log', 'git show', 'git diff'],
      write: nodeKind === 'work' ? ['Edit', 'Write', 'Bash(sed)', 'Bash(awk)'] : [],
      shell: nodeKind === 'challenge' ? [] : ['Bash(npm test)', 'Bash(pytest)', 'Bash(go test)'],
      net: nodeKind === 'challenge' ? false : true,
      heavy_io: persona === 'craftsman' || persona === 'solver',
    };
    return base;
  }
}

module.exports = { PolicyGate, RULES };