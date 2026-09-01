# Fleet OS · 舰队模式

> 生产级多 Agent 协同引擎 —— WebSocket 黑板 + 事件溯源 + 盲评对抗 + 跨舰队接力 + 自进化。零 npm 依赖，36 模块，单进程可跑。

**这不是又一个"并行 N 个子代理"的玩具。** 每一个槽位、每道闸、每条账、每段上下文都可审计、可恢复、可 fork、可接力、会自进化、会负载均衡。

- 48 项端到端测试全绿（`node src/e2e.js`）
- 20 节点冒烟：complete / 0 失败
- MCP 服务器 40 个工具，可被任意支持 MCP 的 IDE/Agent 直接指挥

---

## 为什么不是 Kimi Agent Swarm

Kimi 的"100 子 agent"是权重里焊死的营销数字。同质模型并行辩论的从众率实测高达 **85.5%**（[The Cost of Consensus, 2025](https://arxiv.org/abs/2505.00914)）；Anthropic 数据显示 multi-agent 烧掉 ≈15× chat token。舰队模式用硬工程对抗这些：

| 维度 | Kimi Swarm | Fleet OS v6 |
|---|---|---|
| 并行 | 100 权重硬编码 | 配额 + 默认扇出 3~5（Anthropic 最佳实践）+ max_threads=6 / max_depth=1 护栏 |
| 通信 | 同进程共享 | WS 黑板 + 产物落盘指针（token 隔离） |
| 验证 | 自判 | **N 路盲评（盲采样）+ 裁决 + verifier rerank + 级联升级** |
| 上下文 | 无压缩 | **Compactor 热/冷分层 + observation masking**（防 context rot） |
| 模型绑定 | 单模型 | **Balancer 多厂商 round-robin / cheapest / least_error + error-aware 降级** |
| 权限 | 无 | 四权限模式 bypass/acceptEdits/plan/default + 人工审批闭环 |
| 跨舰队 | 无 | FleetBus handoff 只传指针不传全文 + 依赖门 |
| 持久化 | 会话断即丢 | append-only ledger × checkpoint × hooks × traces × beads/convoy |
| 自进化 | 无 | settled 自动提炼 policies / skills-genome / persona-boost |
| 时间旅行 | 无 | replay / fork checkpoint |

## 架构总览（36 模块）

```
协调中枢  hub.js（HTTP+WS 双栈、舰队状态机、自动续传）
调度      topology.js（solo/fanout/mapreduce/sample-verify/tournament/hierarchical 自动选）
状态      state.js（DAG 节点 + 盲评 + 级联 + checkpoint + replay/fork）
黑板      board.js（append-only + 相关性检索 + token 预算裁剪）
压缩      compactor.js（热/冷分层 + observation masking，防 context rot）
均衡      balancer.js（多 provider 轮流/最便宜/最少错误 + 自动降级）
人格      persona.js + role.js（独立立场 + seed 切入角 + Role Contract + Codex 三型角色卡）
安全      policy.js + permissions.js + guardrails.js（allow/ask/deny + 三档 tripwire）
执行      worker.js（demo / cli(claude·codex·dsh·trae-cli) / api(OpenAI 兼容 + 真实工具执行器)）
隔离      git.js（N 路 git worktree 物理隔离，并行写不踩脚）
协同      fleetbus.js（跨舰队 handoff + 依赖门 + Agent Teams 同层互喂）
进化      evolve.js（跑完自动提炼策略/技能基因/人格增强）
观测      tracing.js + hooks.js + filemap.js + public/board.html（浏览器看板）
桥接      mcp-server.js（40 工具，MCP stdio）
```

对齐的实现：OpenAI Agents SDK（role contract / guardrails / tracing）、Claude Code（hooks / permission modes）、Codex CLI（AGENTS.md 叠加 / 子代理三型 / max_threads 边界）、AutoGen v0.4（TopicBus actor 模型）、MetaGPT（SOP 契约）、LangGraph（Command / Checkpoint / time-travel）、Aider（repo map）、Gas Town（beads/convoy/refinery）、FrugalGPT / RouteLLM（级联路由）。

## 快速开始

```bash
cd engine
npm install          # 仅 dev 依赖；运行时零依赖

# 1. 起舰（Hub：HTTP+WS 中枢 + 看板 http://127.0.0.1:7788/board.html）
node src/hub.js fleet.config.json

# 2. 起舰员（demo 模式不烧 token）
node src/worker.js --mode=demo --slots=2

# 3. 下单（spec 里写目标/拓扑/验收标准/预算）
node src/fleet.js run fleet.config.json spec.json

# 4. 观战
node src/fleet.js status fleet.config.json
# 或浏览器打开 board.html
```

接入真模型：复制 `fleet.config.example.json` → `fleet.config.json`，填入 OpenAI 兼容端点（支持多厂商并存，Balancer 自动轮询/降级）。

## MCP 接入（让 IDE/Agent 当舰长）

```json
{ "mcpServers": { "fleet": { "command": "node", "args": ["<path>/engine/src/mcp-server.js", "<path>/engine/fleet.config.json"] } } }
```

40 个工具覆盖：plan / status / adopt / board / rerank / fork / subagents / handoff / deps / consume / bus_snap / perm_check / balancer / compile_stats / evolve / team_join / peer_ping …

## DeepSeek Harness 深度集成（dsh-fleet）

Fleet OS 同时是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件（`dsh-plugin` topic）。

### DSH 架构一页纸

```
Agent = Model + Harness
                  │
        ┌─────────┴──────────┐
        │   Cordis 内核       │  ← 来自 Koishi.js 生态的依赖注入/插件生命周期框架
        │  （挂载/卸载/依赖） │     只管插件，不提供任何能力
        └─────────┬──────────┘
   一切皆插件：models · tools · skills · sessions · sandboxes
              storage · loops · scheduling · UI
```

- **插件三形式**：函数 `export function apply(ctx)` / 对象 / class `Service`；`export const inject = ['tools']` 声明依赖，Cordis 等服务就绪才加载
- **工具 DSL**：`ctx.tools.register(defineTool({ name, description, parameters, output{schema,render}, execute }))` —— args 自动校验，`output.render` 决定模型看到的形态
- **四种运行时模式**：Standard（全家桶）/ Code（模型写 TS 编排多轮工具）/ Minimal（双工具基准）/ Creator（运行时检查 + 在线试插件）
- **全链路可追溯**：append-only session log（system prompt/推理/工具调用/子代理调度/每次上下文注入全记录），Trajectory 视图按来源检查，resume/fork/search/replay 全走同一事件流
- **能力分层**：Service Definition / Service Provider / Consumer 三包拆分，任何能力可换
- **挂载方式**：cordis.yml overlay `pnpm dsh web --patch ./cordis.yml`，路径必须绝对；`ctx.effect()` 提供卸载清理

### Fleet OS ↔ DSH 架构映射

| DSH 原生 | Fleet OS 对应 | 增量 |
|---|---|---|
| append-only session log | append-only ledger + checkpoints | 多一层 replay/fork time-travel |
| subagents | 舰队节点（扇出 3~5 + max_threads/depth 护栏） | 盲评对抗 + verifier rerank + tier 级联 |
| Trajectory view | /board 实时看板 | 舰队级 DAG 视图 + balancer 健康 + 待审批告警 |
| 模型插件 | Balancer 多厂商负载均衡 | round-robin/cheapest/least_error + 自动降级 |
| Context 注入 | Compactor 热/冷分层 | observation masking，防 context rot |

### 三步挂载

```bash
# 1. 起舰队 hub
node engine/src/hub.js engine/fleet.config.json

# 2. 把 dsh/cordis.yml 里的路径改成你的绝对路径
#    （插件源：dsh/src/fleet-bridge.ts —— 注册 8 个 fleet_* 工具）

# 3. DSH 加载 overlay
pnpm dsh web --patch /absolute/path/to/fleet-os/dsh/cordis.yml
```

Harness 里的 agent 即获得：`fleet_plan`（编排一支舰队）/ `fleet_status` / `fleet_state`（全量快照）/ `fleet_board`（读黑板）/ `fleet_approvals` + `fleet_approve`（人工审批闭环）/ `fleet_handoff`（跨舰队接力）/ `fleet_evolve`（技能基因提炼）。

## 测试

```bash
node src/e2e.js     # 48 项端到端：审批闭环/冷续传/api真执行器/cli外设/worktree隔离/MCP/子代理/自进化/跨舰队/权限/团队/压缩/负载均衡
```

## 许可证

MIT
