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

## 测试

```bash
node src/e2e.js     # 48 项端到端：审批闭环/冷续传/api真执行器/cli外设/worktree隔离/MCP/子代理/自进化/跨舰队/权限/团队/压缩/负载均衡
```

## 许可证

MIT
