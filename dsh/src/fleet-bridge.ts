/**
 * dsh-fleet —— Fleet OS 舰队模式的 DeepSeek Harness 桥接插件（Cordis 函数形式）。
 *
 * 职责：把舰队 hub 的全部 admin op 注册成 DSH tools，让 Harness 里的 agent
 * 直接编排一支多 agent 舰队（plan / status / board / 审批 / 跨舰队 handoff / evolve）。
 *
 * 架构映射（与 DSH 哲学对齐）：
 *   DSH append-only session log  ↔  舰队 append-only ledger
 *   DSH subagents                ↔  舰队舰队节点（多一层盲评对抗 + tier 级联）
 *   DSH Trajectory view          ↔  舰队 /board 实时看板
 *
 * 前置：舰队 hub 已在跑（node engine/src/hub.js fleet.config.json），
 *      环境变量 FLEET_HUB 可覆盖（默认 http://127.0.0.1:7788）。
 *
 * 挂载（仓库根的 cordis.yml overlay）：
 *   pnpm dsh web --patch ./dsh/cordis.yml
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-fleet'
export const inject = ['tools']

const HUB = process.env.FLEET_HUB || 'http://127.0.0.1:7788'

async function admin(body: unknown): Promise<unknown> {
  const res = await fetch(`${HUB}/v1/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j: any = await res.json().catch(() => ({ error: 'bad_json' }))
  return j && j.data !== undefined ? j.data : j
}

async function state(): Promise<unknown> {
  const res = await fetch(`${HUB}/v1/state`)
  return await res.json()
}

const jsonOut = (value: unknown) => [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'fleet_plan',
    description: '编排一支舰队（多 agent 并行 + 盲评对抗 + 预算闸）。spec: {goal, acceptance[], topology?, fanout?, lanes?[], items?[], budget{maxTokens,maxWallMs}, worktree?, permissionMode?, deps?[]}',
    parameters: {
      goal: { type: 'string', required: true, description: '一句话目标' },
      acceptance: { type: 'array', required: true, description: '验收条款' },
      topology: { type: 'string', required: false, description: 'solo|fanout|mapreduce|sample-verify|tournament|hierarchical' },
      spec_json: { type: 'string', required: false, description: '完整 spec JSON（优先于散参）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => jsonOut(v) },
    async execute(args) {
      const spec = args.spec_json ? JSON.parse(args.spec_json) : { goal: args.goal, acceptance: args.acceptance, topology: args.topology, budget: { maxTokens: 4_000_000, maxWallMs: 1_800_000 } }
      return JSON.stringify(await admin({ op: 'plan', spec }), null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_status',
    description: '看舰队/舰员状态（byStatus/budget/看板统计）',
    parameters: { fleet: { type: 'string', required: false, description: 'fleetId，缺省给全部' } },
    output: { schema: { type: 'string' }, render: (_a, v) => jsonOut(v) },
    async execute(args) { return JSON.stringify(await admin({ op: 'status', fleet: args.fleet }), null, 2) },
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_state',
    description: '全量快照：workers/fleets/nodes/busSnap/balancerSnap/evolveArtifacts/pending 审批',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => jsonOut(v) },
    async execute() { return JSON.stringify(await state(), null, 2) },
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_board',
    description: '读舰队黑板（类型化记录切片，可按关键词过滤）',
    parameters: {
      fleet: { type: 'string', required: true },
      query: { type: 'string', required: false },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => jsonOut(v) },
    async execute(args) { return JSON.stringify(await admin({ op: 'board', fleet: args.fleet, query: args.query || '', k: 30 }), null, 2) },
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_approvals',
    description: '列出待人工审批的节点（权限模式 ask 命中的高危动作）',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => jsonOut(v) },
    async execute() { return JSON.stringify(await admin({ op: 'pending' }), null, 2) },
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_approve',
    description: '批准一个待审批节点继续执行',
    parameters: { fleet: { type: 'string', required: true }, node: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => jsonOut(v) },
    async execute(args) { return JSON.stringify(await admin({ op: 'approve', fleet: args.fleet, node: args.node, by: 'dsh' }), null, 2) },
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_handoff',
    description: '跨舰队接力：A 舰队把产物指针+事实摘要投递给 B 舰队（token 隔离）',
    parameters: {
      source: { type: 'string', required: true },
      dest: { type: 'string', required: true },
      artifacts: { type: 'array', required: false },
      facts: { type: 'array', required: false },
      note: { type: 'string', required: false },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => jsonOut(v) },
    async execute(args) { return JSON.stringify(await admin({ op: 'handoff', ...args }), null, 2) },
  }))

  ctx.tools.register(defineTool({
    name: 'fleet_evolve',
    description: '舰队 settle 后提炼技能基因（policies/genome/persona-boost），越用越强',
    parameters: { fleet: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => jsonOut(v) },
    async execute(args) { return JSON.stringify(await admin({ op: 'evolve', fleet: args.fleet }), null, 2) },
  }))

  // 生命周期：插件卸载时无需手动清理（Cordis 自动回收 ctx 注册的 tool）
}
