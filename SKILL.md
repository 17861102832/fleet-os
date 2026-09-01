---
name: "舰队模式"
description: "舰队模式（Fleet OS v6）—— 极致生产力的并行协调中枢。WebSocket 黑板 + 事件溯源 + DAG 调度 + 独立人格 + 盲评对抗 + git worktree + role contract + hooks bus + skills progressive disclosure + repo map + cascade router + policy gate + job store + time-travel + 跨舰队协同 + Agent Teams + 权限模式 + 上下文压缩 + 多 provider 负载均衡 + MCP 全量工具。当用户说'并行蜂群极限优化'、'吊打 Kimi 集群'、'舰队模式'、'并行专家协作'、'多 agent 协调中枢'、'MCP+WS 编排'、'突破限制'、'异构集群'、'黑板架构'、'事件溯源 agent'时触发。"
version: 6.0.0
user-invocable: true
metadata: {"agent_skill":{"key":"舰队模式","aliases":["舰队模式","舰队","Fleet","FleetOS","黑板","黑板架构","并行蜂群极限","并行专家","多 agent 协调","MCP+WS","突破限制","异构集群","盲评对抗"],"priority":"first"}}
---

# 舰队模式 v3 —— 多 agent 协同的天花板

**门面：把已有的蜂群模式重写为「真生产力」，不是玩具。**
**骨相：WebSocket 黑板 · 事件溯源账本 · DAG 调度器 · 独立人格 · 盲评对抗 · git worktree · 角色契约 · Hooks Bus · Skills (progressive disclosure) · Repo Map · Cascade Router · Policy Gate · Job Store · Time-Travel · Runtime Limits · AGENTS.md 协议 · Guardrails · Tracing · Topic Bus (actor pub/sub) · Beads/Convoy/Refinery (git-as-state) · SOP 契约 · Runner Loop。**

v3 在 v2 基础上补齐：Codex `AGENTS.md` 逐级叠加协议 + `max_threads=6/max_depth=1` 硬边界、Claude Code 全套 11 事件 Hook + PreToolUse guard、OpenAI Agents SDK 三档 Guardrails（input/output/tool tripwire）+ Runner Loop（handoff/final/tool 三态）+ Tracing（trace_<32>/span）、AutoGen v0.4 Topic/Subscription/RoutedAgent actor 模型、Gas Town Beads 版本化任务账本 + Convoy 交付单元 + Refinery 合并队列、LangGraph Checkpoint store + Command/Send 语义、MetaGPT SOPGraph 阶段契约、SWE-Agent repo-aware filemap。**30 个模块，smoke-full 15 项自检全绿。**

> **关键立场**（这是与"无脑开 100 个 agent"的分水岭）
> 1) 并行不是放大器，是**预算分配器**。token 用量单独解释 Anthropic BrowseComp 80% 的方差。
> 2) 异构不是卖点，**质量才是**。Self-MoA 反超混合 MoA 6.6pt。
> 3) 同构通信 = 负资产，**必须中心验证**。无验证错误放大 17.2×。
> 4) 架构-任务错配比模型能力更致命：同一套系统 +80.8% 到 −70.0%。
> 5) 黑板/事件溯源换的不是性能，是**可重建状态 + 可审计性**。

---

## 一、舰队 14 件套（怎么落地）

```
舰队模式/
└── engine/                          # 极简 Node 引擎（零 npm 依赖）
    ├── src/
    │   ├── util.js                  时间/ID/哈希/JSONL/token 估算/配置加载
    │   ├── ws.js                    自实现 RFC6455（服务端+客户端+ping/pong）
    │   ├── limits.js                令牌桶 + 全局/每 worker 槽位 + 预算闸门
    │   ├── board.js                 黑板：append-only、相关性、token 预算裁剪
    │   ├── persona.js               人格注册表 + spawn(seed) 决定切入角 + 盲评 prompt
    │   ├── role.js                  Role Contract + typed message + handoff（MetaGPT+AgentsSDK）
    │   ├── hooks.js                 Hooks Bus：deterministic automation layer（Claude Hooks）
    │   ├── skills.js                Skills progressive disclosure tier-0/1/2 + Aider RepoMap
    │   ├── topology.js              架构适配门：solo/fanout/mapreduce/sample-verify/tournament/hierarchical
    │   ├── state.js                 舰队调度器 + 关键路径 + 盲评 + 级联 + 时间旅行
    │   ├── git.js                   git worktree 物理隔离 + 排队合并
    │   ├── policy.js                Policy Gate：allow/ask/deny（Claude permissions + AgentsSDK guardrails）
    │   ├── routing.js               Cascade Router：FrugalGPT+RouteLLM+Self-MoA 合成
    │   ├── jobstore.js              Async Job Store：foreground/background（Codex background agent）
    │   ├── gate.js                  Spec Gate：合同校验（Trae spec.md/tasks.md/checklist.md）
    │   ├── hub.js                   协调中枢：HTTP + WS 双栈 + 12 admin op
    │   ├── worker.js                舰员：demo / cli / api 三模
    │   ├── mcp-server.js            Trae 会话入列（stdio JSON-RPC）
    │   └── fleet.js                 CLI：plan/run/status/board/inject/abort/adopt/smoke/smoke-full
    ├── personas/default.json        10 个内置人格
    ├── skills/_template/            自带技能样例（_开头目录自动跳过）
    ├── public/board.html            浏览器看舰队直播
    ├── fleet.config.example.json    多 provider × 令牌桶 + 价格 + cli 接入
    └── package.json
```

零依赖（无 npm install），引擎自包含。Node ≥ 20。

---

## 二、九大架构能力（v2 集成）

| # | 能力 | 出处 | 舰队实现 |
|---|---|---|---|
| 1 | 角色契约 + typed message + handoff | MetaGPT / OpenAI Agents SDK | `role.js` · `MSG_KINDS` |
| 2 | Hooks Bus（确定性自动化层） | Claude Code Hooks | `hooks.js` |
| 3 | Skills progressive disclosure（tier-0/1/2） | OpenHands / Claude Skills | `skills.js` |
| 4 | Repo Map（token-budgeted 符号摘要） | Aider RepoMap | `skills.js.RepoMap` |
| 5 | Cascade Router（eco→mid→high + self-consistency + 异构去相关） | FrugalGPT / RouteLLM / Self-MoA | `routing.js` |
| 6 | Async Job Store（foreground/background） | Codex CLI Background / Claude Background | `jobstore.js` |
| 7 | Policy Gate（allow/ask/deny + 中央审批） | Claude Code Permissions + Agents SDK Guardrails | `policy.js` |
| 8 | Spec Gate（合同校验） | Trae spec.md/tasks.md/checklist.md | `gate.js` |
| 9 | Time-Travel（replay/fork） | LangGraph Checkpoint + Time Travel | `state.js.replay/fork` |

加上 v1 已经有的：黑板、DAG 调度、关键路径 rank、盲评对抗、级联升级、git worktree、append-only ledger、自动续传。

---

## 二·五、v3 再补的九大硬能力（对齐顶级架构最后一块块板）

| # | 能力 | 出处（硬证据） | 舰队实现 |
|---|---|---|---|
| 10 | AGENTS.md 逐级叠加协议（override > root > 逐层向下，32KiB 预算） | Codex 官方 `agents-md` | [agents-md.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/agents-md.js) |
| 11 | Runtime Limits：`max_threads=6`、`max_depth=1`、job 30min 超时 | Codex 官方默认值 | [runtime.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/runtime.js) |
| 12 | Hooks 全 11 事件 + PreToolUse guard（返回 false 即阻断） | Claude Code Hooks | [hooks.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/hooks.js) |
| 13 | Guardrails 三档（input/output/tool）+ tripwire 抛异常停执行 | OpenAI Agents SDK | [guardrails.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/guardrails.js) |
| 14 | Tracing：`trace_<32alnum>` + span started/ended，env 可关 | Agents SDK tracing | [tracing.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/tracing.js) |
| 15 | TopicBus：topic/subscription/RoutedAgent + selectSpeaker（round_robin/least_active）= Magentic-One 群聊管理器的调度内核 | AutoGen v0.4 actor | [topic.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/topic.js) |
| 16 | Beads（版本化任务账本）/ Convoy（交付追踪单元）/ Refinery（合并队列） | Gas Town git-as-state | [gas-town.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/gas-town.js) |
| 17 | Command(update+goto)/Send(动态 fan-out)/CheckpointStore(thread_id+seq，可 replay/fork) | LangGraph | [langgraph.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/langgraph.js) |
| 18 | SOPGraph（phase+dependency+acceptance 显式契约，取代长 prompt SOP）+ Runner Loop（handoff/final/tool 三态）+ FileMap（SWE-Agent 式 100 行视图/grep 只列文件） | MetaGPT · Agents SDK · SWE-agent | [sop.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/sop.js) · [runner.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/runner.js) · [filemap.js](file:///c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/filemap.js) |

**接线方式（不是孤岛，全部进主循环）**：
- `lease()` 前查 `runtime.canSpawnThread()`（Codex 边界）→ 满槽就回 noop 排队
- `lease()` 时 `reserveThread` + fire `SubagentStart`；`submit()` 时 `releaseThread` + fire `TaskCompleted` + 写 checkpoint + 自动关 bead；`fail()` 时 `releaseThread` + fire `Error`
- worker 每次执行动作前后 fire `PreToolUse`/`PostToolUse` → hub 的 guard 联动 `policy.check`，deny 即阻断
- `context()` 自动拼 AGENTS.md 覆盖链 + Role Contract + Hooks 提示 + Skills tier-0/1 + 黑板切片
- hook 事件全部落 `state/log/hooks.jsonl`（实测单轮 27KB），trace 落 `state/traces/YYYY-MM-DD/`

**smoke-full 15 项自检实测结果**（`node src/fleet.js smoke-full`）：
```
1) runtime: maxThreads=6 maxDepth=1 ✓   2) agentsMd 叠加 ✓   3) skills catalog ✓
4) policy deny/ask/allow ✓✓✓            5) guardrails 拦注入 ✓ 正常放行 ✓
6) tracing traceId ✓                    7) topic pub/sub ✓
8) beads 创建→closed ✓ convoy ✓         9) refinery fleet/n1→merged ✓
10) filemap 符号摘要 ✓                  11) Command/Send/fork@state ✓
12) SOP ready 顺序 plan→code ✓          13) runner handoff loop ✓
14) rerank winner=evidence满者 ✓        15) job background ✓
真舰队：20 节点 / status=complete / 0 失败 / 全链路 hook 落盘
```

---

## 三、八种开舰姿势（用户怎么说，怎么做）

| 触发语 | 动作 |
|---|---|
| "开舰队 / 编排并行 / 蜂群极限" | `./bin/fleet run fleet.config.json spec.json` |
| "看舰队状态 / 黑板" | `./bin/fleet status [fleetId]` + `./bin/fleet board <fleetId>` |
| "压一压 / 冒烟一下" | `./bin/fleet smoke fleet.config.json` |
| "全量冒烟" | `./bin/fleet smoke-full fleet.config.json` |
| "把专家团 X 铸成舰员" | `./bin/fleet adopt path/to/X.md '{"id":"X"}'` |
| "Trae 也入列" | 把 MCP 服务器注册到 Trae |
| "把 claude / codex / dsh 挂进来" | worker --mode=cli，provider 配置里塞 command |
| "接着上次跑" | hub 启动自动 `state/snapshots/*.json` 续传 |
| "回放 / fork" | `./bin/fleet replay <fleetId>` · `./bin/fleet fork <fleetId> <atSeq>` |
| "重排 / 测策略闸 / 技能目录 / 角色目录" | `./bin/fleet rerank` · `policy` · `skills` · `roles` |
| "重启集群 / 收尾" | `./bin/fleet abort <fleetId>` |

---

## 四、MCP 工具表（Trae 直接调）

| 工具 | 用途 |
|---|---|
| `fleet_plan` | 编排舰队（含 spec gate） |
| `fleet_status` | 全舰队状态/节点/预算/看板 |
| `fleet_board` | 黑板相关性检索 |
| `fleet_inject` | 注入指挥官指令 |
| `fleet_abort` | 中止舰队/节点 |
| `fleet_work` | 本会话作为舰员：拉 lease |
| `fleet_submit` | 交付物回流 |
| `fleet_note` | 写黑板 |
| `fleet_adopt_expert` | 从专家团角色卡铸人格 |
| `fleet_personas` · `fleet_skills` · `fleet_roles` | 列已注册 |
| `fleet_worktree` | 给节点开 git worktree |
| `fleet_replay` · `fleet_fork` | 时间旅行 |
| `fleet_policy_check` | 工具动作前置 policy 判 allow/ask/deny |
| `fleet_rerank` | cascade 重排 |
| `fleet_jobs` · `fleet_run_hub` | 后台 job · 在 MCP 进程内起 hub |

Trae MCP 配置：

```json
{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/src/mcp-server.js"],
      "env": { "FLEET_CONFIG": "c:/Users/赵锡坤/.trae-cn/skills/舰队模式/engine/fleet.config.json" }
    }
  }
}
```

---

## 五、舰队拓扑自适配（铁律）

| 信号 | 拓扑 | 适用 |
|---|---|---|
| 强耦合、顺序、依赖链 | **SINGLE** | refactor / 同文件 / 串行迁移 |
| 可分解 + ≥3 项 | **MAPREDUCE** | 批扫描 / 多个标的 |
| 单点难题 + 可验证 | **SAMPLE-VERIFY** | math / proof / 单问题强验证 |
| 主观创作 / 多解择优 | **TOURNAMENT** | 文案 / 标题 / 设计方案（Elo 对弈） |
| 通用可分头调研 | **FANOUT** | 行业研究 / 立项调研 |
| 长程多分身 + 动态 | **HIERARCHICAL** | 规划节点交 packages 自动二次展开 |

并行宽度：默认 3~5。> 8 时警告通信成本 ∝ n^1.724。
是否开盲评：默认开。关闭时**主动警告**。
级联 ladder：默认 `eco → mid → high`。失败即升级（cascade 升级腿，FrugalGPT 最多省 98%）。

---

## 六、人格独立 + 角色契约 —— 双层防"谄媚从众"

同构 swarm 从众率实测最高 **85.5%**。两件事必须做：

**Layer 1 - 人格（Persona）**：`personas/spawn(seed)` 让同一人格每轮咬住不同切入角。立场写入 system prompt。

**Layer 2 - 角色契约（Role）**：`role.js` 把人设升级为 typed contract：
```
role.craftsman: {
  callsign, stance, rules[], capabilities[], adversarial, temperature, toolPolicy
}
```
每个 worker prompt 自动附带 `【Role Contract】` 一行，强制 persona 知道自己能干什么不能干什么。

---

## 七、Skills Progressive Disclosure

借鉴 OpenHands 三层 + Aider RepoMap：

```
Tier-0  always-loaded    仅 name + one-line description（~150 bytes）
Tier-1  on-match         命中 keyword/path 才把 SKILL.md 装入（~4kb）
Tier-2  on-demand        worker 真正需要时才读（RepoMap 等）
```

命中规则：keyword 触发（首行+命令名+description）+ path glob 触发（worker cwd 下匹配）。

仓库地图：用 `RepoMap.map({cwd, focus, budget=1200})` 自动生成 1200 token 预算内的文件级符号摘要，只把"相关文件 + 头 40 行 + 导出符号"喂给 worker。

---

## 八、Policy Gate（中央安全闸）+ 人工审批闭环【e2e 实测】

不是每个 worker 各自决策"能不能写"，而是中央事先判：

```
低风险 → allow（自动）
中风险 → ask：spec.autoApprove===false 时节点真的进入 awaiting_approval 暂停，
         指挥官 fleet approve <fleetId> <nodeId> 后豁免复查继续；
         fleet reject 则节点判死、舰队降级收口
高风险 → deny（直接拒绝，写账本+黑板）
```

内置规则：`no_delete_root` / `no_read_secret` / `no_publish` / `no_force_push` / `no_eval_drop` / `sub_write`。
CLI：`fleet approve|reject|pending|live`（走 WS 打到运行中的 hub）。
MCP：`fleet_approve` / `fleet_reject` / `fleet_pending`。
看板：awaiting_approval 积压黄色告警，无积压绿色。

---

## 九、Cascade Router（成本可控）

```
v2 路由器 = FrugalGPT (cost cascade)
          + RouteLLM (matrix-decomposition router)
          + Self-MoA (homogeneous best-of-N)
          + PRM verifier rerank
```

用法：
- 起始 tier = `pickStart(node, remainTokens, personaHints)`
- 失败自动升级：eco → mid → high（state.js 的 fail() 已实现）
- 多路采样用 `rerank({candidates, verifier, q})` 出最佳

---

## 十、Async Job Store

`Codex CLI Background` 和 `Claude Code Background Subagent` 都有这能力。舰队落地：

```
job = { id, spec, mode: 'foreground'|'background', handle, state, log[], result }
```

任何 worker 入列默认 `background=false`；`spec.headless=true` 或 node.kind === 'challenge'/'adjudicate' → `background=true`。

---

## 十一、Time-Travel（LangGraph 同款）

```
fleet.replay({ from, limit })            // 重放事件
fleet.fork({ atSeq })                    // 在 atSeq 处分叉
```

分叉会创建一个新舰队 ID，把历史事件拷过去。适合"换一条路重跑"。

---

## 十二、工程底线

| 维度 | 阈值 | 触发 |
|---|---|---|
| 全局并发 | maxConcurrent=16 | 超就排队 |
| 每 worker 槽 | perWorkerSlots=4 | 同进程 N 个串行并发 |
| 节点租约 | 180s | 超时自动回收重派 |
| 同 stall 指纹 | 3 次 | 自动判 stalled，回队升级 |
| 黑板相关性 | tokenBudget=900 | 强行裁剪，大产物落盘只回指针 |
| 舰队预算 | tokens/cost/wallclock | 到线自动 halted，写账本 |
| 持久化 | append-only ledger + snapshot 双保险 | EPERM 时 4 次重试，最后降级 copy+unlink |
| Job | foreground/background 双模 | mode='background' 不阻塞发起者 |
| Policy | allow/ask/deny | 中央闸；worker 工具调用前必问 |
| Repo map | 1200 tokens | 给 worker 自动生成定向符号摘要 |

---

## 十三、与顶级架构的差异化

| 维度 | Kimi K2.5 Swarm | DeepSeek Harness | TRAE Kit | **舰队模式 v2** |
|---|---|---|---|---|
| 并行上限 | 100（写在权重里） | 无固定上限 | 20 路由专家 | **无固定上限，靠配额；默认扇出 3~5** |
| 通信 | 子 agent 同进程 | Cordis 插件事件总线 | 文件/提示词路由 | **WebSocket 黑板 + 大产物落盘指针** |
| 独立人格 | 同模型复制 | 没有 | 20 个路由人格（无对抗） | **硬编码立场 + seed 切入角 + 角色契约 + 盲评对抗** |
| 验证 | 模型自己判断 | 模型自己判断 | 没有 | **N 路盲评 + 1 路裁决 + 级联升级 + verifier rerank** |
| 持久化 | 会话内 | append-only ledger | 没有 | **ledger + snapshot 双保险 + time-travel fork** |
| 多舰队跨模型 | 没有 | Profile Bundle | 没有 | **WS + 多 provider 令牌桶，竞品即组件** |
| Hooks | 没有 | 没有 | 没有 | **deterministic automation：SubagentStart/Error/TaskCompleted...** |
| Skills | 没有 | 插件但无 progressive | 没有 | **tier-0/1/2 渐进披露 + Repo Map** |
| Policy Gate | 无 deny 规则 | 没有 | 没有 | **中央 allow/ask/deny 三态 + policy.jsonl 审计** |
| Job 后台 | 没有 | 没有 | 没有 | **foreground/background + handle + jobstore 持久** |
| Cascade | 没有 | 没有 | 没有 | **eco→mid→high 自动升级 + verifier rerank** |
| Time-Travel | 没有 | 没有 | 没有 | **replay/fork（LangGraph 同款）** |
| 学习曲线 | 闭源权重 | 装 Node + 写插件 | 装 .trae 目录 | **零依赖单文件 CLI，11 条命令跑通全栈** |

---

## 十四、上手 30 秒

```bash
# 1. 起舰
node "c:\Users\赵锡坤\.trae-cn\skills\舰队模式\engine\src\hub.js" "c:\Users\赵锡坤\.trae-cn\skills\舰队模式\engine\fleet.config.json"

# 2. 跑一个目标
./bin/fleet run fleet.config.json spec.json

# 3. 起舰员（demo 不烧 token）
node "c:\Users\赵锡坤\.trae-cn\skills\舰队模式\engine\src\worker.js" --mode=demo --slots=2

# 4. 看直播
打开 http://127.0.0.1:7788

# 5. MCP 注册 Trae，IDE 自己也是一双能领活儿的手
```

冒烟已实测：`smoke-full` → 20 节点 / complete / 0 失败 / skills 命中 / policy deny/ask/allow 全验证 / rerank 工作 / jobs 闭环。

## 十四·五、e2e 实战套件【27/27 全绿 + 真执行器】

`node src/e2e.js`——六路实战，每路独立端口互不干扰：

| 路 | 验证内容 | 结果 |
|---|---|---|
| approval | 人工审批状态机：ask→awaiting_approval→pendingApprovals→approve→complete；reject→degraded | 6/6 |
| coldresume | 半程 kill hub（关端口+停循环）→ 新 Hub 自动 resume → leased 复位 → 续传 complete | 4/4 |
| api worker **（真执行器）** | 模型多轮 Read→Write→deliver，`answer.txt` 真实落盘，usage.total_tokens 计费 | 3/3 |
| cli worker | 外部 agent（claude/codex/dsh 同款）交付回流 + 盲评+裁决链真实展开（12 done + accept 裁决） | 2/2 |
| worktree | 双 lane worktree→分支提交→Refinery 合并回 main→产物落仓 | 3/3 |
| MCP stdio | initialize 握手 + tools/list 28 个 + policy 中央闸 + runtime 快照 | 4/4 |
| subagent | Codex 三型角色卡 + max_depth=1 递归护栏 | 4/4 |
| evolve | 舰队跑完自动提炼技能基因（policies/genome/boost） | 1/1 |

**api worker 已升级成真执行器（最顶级关键）**：不再是被动输出 JSON，模型每轮可调用 `Read/Write/Edit/Bash/Search/RepoScan/deliver` 工具，在隔离 workdir 里真实读写文件，直到主动 deliver 或 max_turns 到顶（对齐 OpenAI Agents SDK runner loop + Anthropic subagent "有手"）。
所有工具路径强制 `path.startsWith(workdir)` 防逃逸；shell 默认禁用，`spec.allowShell` 才开。

```bash
node "c:\Users\赵锡坤\.trae-cn\skills\舰队模式\engine\src\e2e.js"
```

| 路 | 验证内容 | 结果 |
|---|---|---|
| approval | ask→真暂停→pendingApprovals→approve→complete；reject→degraded | 6/6 ✓ |
| coldresume | 半程 kill hub（关端口+停循环）→ 新 Hub 自动 resume → 续传到 complete，leased 节点复位不重跑已完成项 | 4/4 ✓ |
| api worker | mock OpenAI 端点 → deliver tool_call 解析 → usage.total_tokens 计费 → 舰队 complete | 2/2 ✓ |
| cli worker | fake 外部 agent（代表 claude/codex/dsh）→ 交付回流 → **盲评+裁决链真实展开**（12 done + 6 accept 裁决） | 2/2 ✓ |
| worktree | 双 lane 独立 worktree+分支 → 各自提交 → Refinery 排队合并回 main → 产物真实落仓 | 3/3 ✓ |
| MCP stdio | initialize 握手 → tools/list 28 个（v3 承诺 20 个全齐）→ policy 走中央闸 → runtime 快照 | 4/4 ✓ |

e2e 还顺手抓出并修掉三个真 bug：approve 后无限重入审批（加 approved 豁免旗标）、库代码 process.exit 杀宿主（改 EADDRINUSE 事件化）、mergeQueue 缺提交身份（一次性 -c 注入，不碰用户 git config）。

---

## 十五、记住的事

- 任何舰员都不能"聊天"，只能写黑板；黑板之外的产品 = 大产物落盘 + 摘要。
- 盲评默认开启，关掉必出警告。
- fanout > 8 必出警告（通信成本 ∝ n^1.724）。
- 强耦合任务禁止多 agent；先拆，否则让 solo 跑。
- tier ladder 默认 eco→mid→high，省下来的 token 可以再开 5 倍舰员。
- 任何工具动作先过中央闸：allow 自动，ask 暂停，deny 拒绝并写账本。
- Skills 不装不读：tier-0 进 prompt，tier-1 命中才进，tier-2 worker 自己按需。
- Hooks 不让模型决定"该不该做"——确定性自动化层，错了就错了，至少不模糊。
- Repo map 不喂全仓库：1200 token 预算只喂相关文件 + 导出符号。
- Job 后台运行不阻塞发起者；foreground 必须 wait。