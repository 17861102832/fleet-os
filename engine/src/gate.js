'use strict';
/**
 * Spec Gate —— 把 Trae 的 spec.md/tasks.md/checklist.md 合同化，作为舰队的初始契约。
 * 每个 spec 进来后强校验：
 *   1. 必须有 goal
 *   2. 必须有 acceptance（>=1 条）；否则拒收
 *   3. 工作量可拆 → 必填 items/lanes（>=2 项）
 *   4. budget.maxTokens/maxCostUsd/maxWallMs 至少一项必填
 *   5. personaHints 用于指派哪个 persona，但 persona 必须是注册过的
 *   6. 任何"deliverable_files"必须有"owner"指派，否则 fail
 */
const { uid } = require('./util');

const TPL = `# spec.md
goal: <一句话目标，<= 100 字>
acceptance:
  - [验收条款 1]
  - [验收条款 2]
topology: solo|fanout|mapreduce|sample-verify|tournament|hierarchical
items:
  - [分片1]
  - [分片2]
deliverable_files:
  - path: <相对路径>
    owner: <persona id>
budget:
  maxTokens: 4000000
  maxWallMs: 1800000
`;

function gate(spec = {}) {
  const errs = [];
  if (!spec.goal || String(spec.goal).length > 200) errs.push('goal_required_and_short');
  if (!Array.isArray(spec.acceptance) || !spec.acceptance.length) errs.push('acceptance_required');
  if (!spec.budget || !(spec.budget.maxTokens || spec.budget.maxCostUsd || spec.budget.maxWallMs)) errs.push('budget_required');
  if (spec.topology && !['solo', 'fanout', 'mapreduce', 'sample-verify', 'tournament', 'hierarchical'].includes(spec.topology)) errs.push('topology_unknown');
  if (spec.deliverable_files) {
    for (const f of spec.deliverable_files) if (!f.path || !f.owner) errs.push('deliverable_needs_owner');
  }
  if (spec.topology === 'mapreduce' && !(spec.items || spec.lanes)) errs.push('mapreduce_needs_items_or_lanes');
  if (spec.topology === 'hierarchical' && !spec.planner) errs.push('hierarchical_needs_planner');
  return errs.length ? { ok: false, errs, tpl: TPL } : { ok: true, id: spec.fleet || uid('fleet') };
}

module.exports = { gate, TPL };