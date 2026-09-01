'use strict';
/**
 * Subagents —— Codex 三种内置角色卡的工程映射：
 *   default / worker / explorer
 *
 * Codex 事实（可复核）：
 *  - agents.max_depth = 1（root=0，只允许直接子 agent，禁止继续递归）
 *  - agents.max_threads = 6
 *  - agents.job_max_runtime_seconds = 1800
 *  - 子 agent 继承父的 sandbox policy；可声明 read-only（explorer）
 *  - 自定义 agent 用 TOML：name / description / developer_instructions 必填，
 *    model_reasoning_effort / sandbox_mode / mcp_servers / skills 可继承
 *
 * 舰队的子 agent 角色卡 = personas/codex-roles.json（3 张预置卡）。
 * 本文件提供：读取角色卡、建 subagent 上下文、校验递归深度护栏。
 */
const fs = require('fs');
const path = require('path');
const { PersonaRegistry } = require('./persona');

class SubagentManager {
  constructor(personaDir, runtime) {
    this.personas = new PersonaRegistry(personaDir);
    this.runtime = runtime;   // RuntimeLimits（含 maxDepth/maxThreads）
    this.registry = new Map();
    this.loadCodexRoles();
  }

  loadCodexRoles() {
    const f = path.join(__dirname, '..', 'personas', 'codex-roles.json');
    if (!fs.existsSync(f)) return;
    try { const arr = JSON.parse(fs.readFileSync(f, 'utf8')); arr.forEach((r) => { this.registry.set(r.id, r); this.personas.cards.set(r.id, r); }); } catch (_) {}
  }

  /** Codex 同款：按 role 类型拿 subagent 卡 */
  byRole(type, overrides = {}) {
    const id = 'codex-' + (type || 'default');
    const card = this.registry.get(id) || this.registry.get('codex-default');
    return Object.assign({}, card, overrides);
  }

  /** 生成一个 subagent 实例（含角色卡 + seed 切入角 + 读取权限），depth 校验递归 */
  spawn(type, { fleet, parentDepth = 0, nodeId = null, readOnly = null } = {}) {
    const card = this.byRole(type);
    const childDepth = parentDepth + 1;
    const depthOk = this.runtime ? this.runtime.assertDepth(parentDepth, childDepth) : childDepth <= 1;
    if (!depthOk) return { ok: false, why: 'max_depth_exceeded', nodeId, parentDepth, childDepth };
    const readOnlyEffective = readOnly != null ? readOnly : card.role === 'gather';  // explorer 默认只读
    return {
      ok: true,
      id: 'sa_' + require('./util').uid('x').slice(0, 6),
      roleId: card.id, callsign: card.callsign,
      depth: childDepth, readonly: readOnlyEffective,
      stance: card.stance, rules: card.rules || [],
      capabilities: card.capabilities || [],
      temperature: card.temperature,
      charter: card.charter || '',
    };
  }

  list() { return [...this.registry.values()]; }
}

module.exports = { SubagentManager };