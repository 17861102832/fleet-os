'use strict';
/**
 * Role + Action + typed message —— 把 MetaGPT 的 Role/Action/订阅契约拿过来，
 * 但不再"用一段长 system prompt 当 SOP"，而是显式契约：
 *   role  → action[]  → input/output schema → guard
 *   SOP   → phase + dependency + acceptance
 *
 * 这是从 Anthropic、Codex、CrewAI、MetaGPT、OpenAI Agents SDK 各取一段的合成体：
 *   - Role contract (MetaGPT)
 *   - Handoff + Runner loop (Agents SDK)
 *   - Subagent + Plan mode + Worktree (Codex / Claude)
 *   - Delegation + Hierarchical (CrewAI)
 *   - Send + Command + Checkpoint (LangGraph)
 */
const fs = require('fs');
const path = require('path');
const { now, uid, sha, writeFileSafe } = require('./util');

class RoleRegistry {
  constructor(dir) {
    this.dir = dir;
    this.roles = new Map();
    this.reload();
  }
  reload() {
    this.roles.clear();
    if (!fs.existsSync(this.dir)) return;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(require('path').join(this.dir, f), 'utf8'));
        const arr = Array.isArray(data) ? data : [data];
        for (const r of arr) if (r && r.id) this.roles.set(r.id, r);
      } catch (_) {}
    }
  }
  get(id) { return this.roles.get(id) || null; }
  list() { return [...this.roles.values()]; }
  /** 把一份"原始 system prompt"自动展开成 Role 契约（用来铸专家团人物） */
  contract({ id, callsign, charter, stance, rules, capabilities, temperature, adversarial, toolPolicy }) {
    return {
      id, callsign, charter: String(charter || '').slice(0, 8000), stance: stance || '对证据负责',
      rules: rules || [], capabilities: capabilities || ['execute'],
      adversarial: !!adversarial, temperature: temperature == null ? 0.4 : temperature,
      toolPolicy: toolPolicy || 'auto',
    };
  }
}

/** typed message —— MetaGPT 的 cause_by + AutoGen 的 topic + Agents SDK 的 handoff 都收敛在这里 */
const MSG_KINDS = [
  'task.assign', 'task.progress', 'task.submit', 'task.fail', 'task.handoff',
  'claim.fact', 'claim.evidence', 'claim.doubt',
  'board.put', 'board.query',
  'role.handoff', 'role.request_speak', 'role.request_help',
  'verdict.accept', 'verdict.reject',
  'control.inject', 'control.abort', 'control.pause',
];

function msg(kind, body = {}, from = 'hub') {
  return { id: uid('msg'), kind, ts: now(), from, ...body };
}

module.exports = { RoleRegistry, MSG_KINDS, msg };