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
    name: 'fleet_dashboard',
    description: '在对话中渲染舰队旗舰看板（Markdown）：KPI/DAG 分层/审批/balancer/黑板，并附浏览器看板 URL。指挥官最常用的单一视图。',
    parameters: { fleet: { type: 'string', required: false, description: 'fleetId，缺省取第一个活跃舰队' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text' as const, text: String(v) }] },
    async execute(args) {
      const s: any = await state()
      const nd: any[] = s.nodeDetail || []
      const fleets: any[] = s.fleets || []
      const f = args.fleet ? fleets.find((x) => x.id === args.fleet) : fleets[0]
      const nodes = args.fleet ? nd.filter((n) => n.fleet === args.fleet) : nd
      const by: Record<string, number> = {}
      nodes.forEach((n) => { by[n.status] = (by[n.status] || 0) + 1 })
      const done = by.done || 0, total = nodes.length
      const tok = (s.workers || []).reduce((x: number, w: any) => x + (w.tokens || 0), 0)
      const L: string[] = []
      L.push('# ⚓ Fleet Deck · 舰队看板')
      L.push('')
      L.push(`**舰队** ${f ? f.id : '（无）'} · 拓扑 ${f ? f.topology : '-'} · 状态 ${f ? f.status : '-'} · 进度 **${done}/${total}**`)
      L.push(`**舰员** ${(s.workers || []).filter((w: any) => w.online).length}/${(s.workers || []).length} 在线 · **tokens** ${tok.toLocaleString()} · **threads** ${s.runtime?.activeThreads ?? 0}/${s.runtime?.maxThreads ?? '-'}`)
      L.push('')
      L.push('| 状态 | 数量 |')
      L.push('|---|---|')
      for (const k of ['done', 'running', 'leased', 'ready', 'awaiting_approval', 'failed', 'pending']) if (by[k]) L.push(`| ${k} | ${by[k]} |`)
      L.push('')
      // DAG 分层（deps 深度）
      const byId = Object.fromEntries(nodes.map((n: any) => [n.id, n]))
      const depth: Record<string, number> = {}
      const depthOf = (id: string, seen: Set<string>): number => {
        if (depth[id] != null) return depth[id]
        if (seen.has(id)) return 0
        seen.add(id)
        const n = byId[id]
        const d = (!n || !n.deps?.length) ? 0 : 1 + Math.max(...n.deps.filter((d: string) => byId[d]).map((d: string) => depthOf(d, seen)))
        depth[id] = d; return d
      }
      nodes.forEach((n: any) => depthOf(n.id, new Set()))
      const icon: Record<string, string> = { done: '✅', running: '🔄', leased: '🔄', ready: '🔵', pending: '⚪', awaiting_approval: '⚠️', failed: '❌', void: '🚫' }
      const layers = [...new Set(nodes.map((n: any) => depth[n.id]))].sort((a, b) => a - b)
      L.push('**作战 DAG（按依赖分层）**')
      for (const d of layers) {
        L.push(`- **L${d}** ` + nodes.filter((n: any) => depth[n.id] === d).map((n: any) => `${icon[n.status] || '⚪'}\`${n.id}\`${n.attempt ? '(r' + n.attempt + ')' : ''}`).join(' · '))
      }
      const pend = nodes.filter((n: any) => n.status === 'awaiting_approval')
      if (pend.length) {
        L.push('')
        L.push('**⚠ 待人工审批**（用 fleet_approve / fleet_reject 处理）')
        pend.forEach((n: any) => L.push(`- \`${n.id}\` ${n.persona} — ${n.mission || ''}`))
      }
      const bal = s.balancerSnap || {}
      const prov = Object.entries(bal.providers || {}).map(([k, v]: [string, any]) => `${v.ok ? '🟢' : '🔴'}${k}(err×${v.errs})`).join(' ')
      L.push('')
      L.push(`**Balancer** ${bal.mode || '-'} → ${prov || '-'} ｜ **FleetBus** orders=${s.busSnap?.orders?.length ?? 0} deps=${s.busSnap?.deps?.length ?? 0} peers=${s.busSnap?.peers ?? 0} ｜ **Evolve** policies=${s.evolveArtifacts?.policies?.length ?? 0} genome=${s.evolveArtifacts?.genome?.length ?? 0}`)
      L.push('')
      L.push(`🖥️ 浏览器旗舰看板（DAG 图 + 实时事件流 + 看板审批）：\`${(process.env.FLEET_HUB || 'http://127.0.0.1:7788')}/board\``)
      return L.join('\n')
    },
  }))

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
