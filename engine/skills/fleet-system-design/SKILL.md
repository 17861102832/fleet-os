---
name: fleet-system-design
description: 在做舰队的多 agent 系统设计时如何选拓扑、控并发、过盲评。
keywords: [fleet, multi-agent, orchestration, swarms, harness, codex]
triggers: [kw:fleet, kw:orchestration]
---

# Fleet System Design Skill

## 选拓扑

- 强耦合 / 顺序 → solo
- 可分解 + ≥3 项 → mapreduce
- 单点难题 + 可验证 → sample-verify
- 主观创作 / 多解择优 → tournament
- 通用可分头调研 → fanout
- 长程多分身 + 动态 → hierarchical

## 并发上限

默认扇出 3~5。> 8 时通信成本 ∝ n^1.724。
绝对不要同模型复制 100 份跑同质采样（同质从众 85.5%）。

## 验证链

每 work 节点默认展开 N 路盲评 + 1 路裁决。
盲评节点：blind=true，禁看同伴。
裁决：accept / reject 二选一。

## 持久化

任何中间产物可重放：ledger + snapshot 双保险。
崩了不重跑，新会话自动续传。

## 用 cascade 而非"开局就高"

FrugalGPT：同任务质量 + 省 98% 成本。
RouteLLM：95% 质量省 85% 成本。
失败即升级 → tier ladder 默认 eco → mid → high。

## 反面（MAST 七大类失败）

1. 步骤重复 → 同 stall 指纹 3 次自动重排
2. 不遵守 spec → Spec Gate 必填 acceptance + budget
3. 没终止条件 → tick() 自动 settle
4. 推理行动不一致 → 盲评对抗
5. 任务规格不清 → Spec Gate
6. agent 间错位 → typed message + role contract
7. 验证缺失 → 盲评对抗 + worktree