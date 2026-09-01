'use strict';
/**
 * 架构适配门（FIT GATE）—— 舰队模式与"无脑开 100 个 agent"的分水岭。
 *
 * 依据（可复核）：
 *  - Google/MIT「Towards a Science of Scaling Agent Systems」：同一套系统相对单 agent
 *    从 +80.8% 到 −70.0%；顺序规划类任务上所有多 agent 变体掉 39%~70%。
 *  - 无中心验证的独立并行错误放大 17.2×，有中心编排/验证收敛到 4.4×。
 *  - Anthropic：multi-agent ≈ 15× chat 的 token，只有任务价值付得起这个倍数时才该开。
 * 结论：并行是"预算分配器"，不是"智能放大器"。开舰前必须先过这道门。
 */
const TIGHT = /顺序|一步一步|强依赖|耦合|重构一个函数|同一个文件|串行|迁移|refactor|tightly|sequential/i;
const DECOMP = /批量|每个|分别|各自|全部|逐一|多个|扫描|爬取|收集|对比|多路|综述|调研|batch|each|all|scrape|survey|compare/i;
const VERIFIABLE = /算|计算|测试|验证|证明|复现|正确|答案|bug|修|check|verify|solve|count|derive|test/i;
const SUBJECTIVE = /文案|小说|脚本|标题|简介|风格|文笔|设计|方案|策划|创意|pitch|write a|story/i;

/**
 * @param {object} spec {goal, workload?, topology?, fanout?, budget?, items?}
 * @returns {{decision:string, topology:string, fit:number, reasons:string[], warnings:string[], fanout:number, verify:object, ladder:string[]}}
 */
function assess(spec = {}) {
  const goal = String(spec.goal || '');
  const w = spec.workload || {};
  const reasons = [];
  const warnings = [];
  let topology = spec.topology && spec.topology !== 'auto' ? spec.topology : null;

  const decomposable = w.decomposable != null ? !!w.decomposable : DECOMP.test(goal);
  const coupling = w.coupling || (TIGHT.test(goal) ? 'tight' : 'loose');
  const verifiable = w.verifiable != null ? !!w.verifiable : VERIFIABLE.test(goal);
  const subjective = w.subjective != null ? !!w.subjective : SUBJECTIVE.test(goal);
  const difficulty = w.difficulty || (verifiable && !decomposable ? 'hard' : 'medium');
  const items = Array.isArray(spec.items) ? spec.items.length : 0;

  if (!topology) {
    if (coupling === 'tight' && !decomposable) {
      topology = 'solo';
      reasons.push('强耦合/顺序依赖：多 agent 实测负收益（−39%~−70%），单脑直取');
      warnings.push('已压制并行。想要并行，先把任务切成能独立验收的块。');
    } else if (decomposable && (items > 0 || /批量|每个|分别|all|each/i.test(goal))) {
      topology = 'mapreduce';
      reasons.push(`可分解${items ? `（${items} 项）` : ''}：Map 并行 + Reduce 归并，按 LLM×MapReduce 口径处理跨块依赖`);
    } else if (verifiable && difficulty === 'hard') {
      topology = 'sample-verify';
      reasons.push('单点难题且可验证：走"宽采样 + 强验证"，coverage 随样本量幂律上升');
    } else if (subjective) {
      topology = 'tournament';
      reasons.push('质量主观：并行出多版 + 两两对弈式裁决（Elo 锦标赛，AI co-scientist 同款）');
    } else {
      topology = 'fanout';
      reasons.push('可分头调研：扇出收集 + 单点归并');
    }
  }

  // 并行宽度：不是越大越好。Anthropic 实操 3-5 个子 agent；协调成本 ∝ n^1.724
  let fanout = spec.fanout != null ? +spec.fanout : null;
  if (fanout == null) {
    if (topology === 'mapreduce') fanout = Math.max(2, Math.min(items || 8, 12));
    else if (topology === 'sample-verify') fanout = difficulty === 'hard' ? 5 : 3;
    else if (topology === 'tournament') fanout = 4;
    else if (topology === 'solo') fanout = 1;
    else fanout = 4;
  }
  fanout = Math.max(1, Math.min(+fanout, 512));
  if (fanout > 8) warnings.push(`扇出 ${fanout} > 8：通信轮次按 n^1.724 标度暴涨，只在真正正交的批量活儿上才划算`);

  // 验证：默认开。无验证的并行 = 17.2× 错误放大
  const verify = Object.assign({ on: topology !== 'solo', blind: true, n: 2, required: verifiable }, spec.verify || {});
  if (!verify.on) warnings.push('你关掉了对抗验证：错误会被下游当成已验证输入继续精修，这是 MAST 里最高频的失败类');

  // 成本闸门
  const est = estimateCost({ topology, fanout, verify });
  if (est.tokensHigh && !(spec.budget && spec.budget.maxTokens)) {
    warnings.push(`预计 token 量级 ≈ ${est.tokensHigh}（多 agent ≈ 15× 单聊）。建议设 budget.maxTokens，否则到线不自动停`);
  }

  // 级联路由：便宜模型打底，失败/低置信才升级（FrugalGPT 最多省 98%，RouteLLM 95% 质量省 85%）
  const ladder = spec.ladder || ['eco', 'mid', 'high'];

  return {
    decision: topology === 'solo' ? 'SINGLE' : 'FLEET',
    topology, fit: topology === 'solo' ? 0.9 : coupling === 'tight' ? 0.35 : 0.75,
    reasons, warnings, fanout, verify, ladder,
    workload: { decomposable, coupling, verifiable, subjective, difficulty },
    cost: est,
  };
}

function estimateCost({ topology, fanout, verify }) {
  const base = topology === 'solo' ? 1 : fanout;
  const v = verify && verify.on ? 1 + (verify.n || 0) * 0.6 : 1;
  const perUnit = 12000;
  return { units: base + (verify && verify.on ? 1 : 0), tokensHigh: Math.round(base * v * perUnit), note: '含验证与归并，粗估上界' };
}

/**
 * 把 spec 展开成 DAG 节点。节点形状即调度器的唯一输入契约。
 * kind: work | challenge | adjudicate | merge | gate
 */
function compile(spec, verdict = null) {
  const v = verdict || assess(spec);
  const nodes = [];
  const acceptance = spec.acceptance || [];
  const push = (n) => nodes.push(Object.assign({
    kind: 'work', role: 'execute', persona: 'craftsman', deps: [], tier: v.ladder[1] || 'mid',
    acceptance, budgetTokens: spec.nodeBudget || 0, worktree: !!spec.worktree,
    declaredTool: spec.declaredTool || null,
  }, n));

  if (v.topology === 'solo') {
    push({ id: 'n1', role: 'execute', persona: spec.persona || 'craftsman', mission: v.soloMission || spec.goal });
    return nodes;
  }

  if (v.topology === 'mapreduce') {
    const items = (spec.items && spec.items.length) ? spec.items : Array.from({ length: v.fanout }, (_, i) => `分片 ${i + 1}/${v.fanout}`);
    const mapIds = [];
    items.forEach((it, i) => {
      const id = `m${i + 1}`;
      mapIds.push(id);
      push({
        id, role: 'map', persona: spec.persona || 'scout',
        mission: typeof it === 'string' ? it : JSON.stringify(it),
        parentGoal: spec.goal,
        acceptance: (spec.mapAcceptance || acceptance),
      });
    });
    push({ id: 'reduce', role: 'reduce', persona: spec.reducePersona || 'synthesist', deps: mapIds, mission: spec.reduceMission || `把上游所有分片结果归并成一份：${spec.goal}`, acceptance, tier: v.ladder[2] || 'high' });
    return nodes;
  }

  if (v.topology === 'fanout') {
    const lanes = spec.lanes || defaultLanes(spec.goal, v.fanout);
    const ids = [];
    lanes.forEach((ln, i) => {
      const id = `f${i + 1}`;
      ids.push(id);
      push({ id, role: 'gather', persona: ln.persona || 'scout', mission: ln.mission, acceptance: ln.acceptance || acceptance });
    });
    push({ id: 'synthesize', role: 'reduce', persona: spec.reducePersona || 'synthesist', deps: ids, mission: `交叉验证各路发现并合成结论：${spec.goal}`, tier: v.ladder[2] || 'high', acceptance });
    return nodes;
  }

  if (v.topology === 'sample-verify') {
    const ids = [];
    for (let i = 0; i < v.fanout; i++) {
      const id = `s${i + 1}`;
      ids.push(id);
      push({ id, role: 'solve', persona: spec.personas ? spec.personas[i % spec.personas.length] : 'solver', mission: spec.goal, blind: true, seedVariant: i, acceptance });
    }
    push({ id: 'adjudicate', role: 'adjudicate', persona: spec.judge || 'judge', deps: ids, mission: `从 ${ids.length} 份互相看不见的解答中裁决最优，并指出其余版本的可用零件`, tier: v.ladder[2] || 'high', kind: 'adjudicate', acceptance });
    return nodes;
  }

  if (v.topology === 'tournament') {
    const styles = spec.styles || defaultStyles(v.fanout);
    const ids = [];
    styles.forEach((st, i) => {
      const id = `t${i + 1}`;
      ids.push(id);
      push({ id, role: 'compete', persona: st.persona || 'writer', mission: `${spec.goal}\n（本路风格约束：${st.brief}）`, blind: true, acceptance: st.acceptance || acceptance });
    });
    push({ id: 'final', role: 'adjudicate', persona: spec.judge || 'judge', deps: ids, kind: 'adjudicate', mission: `两两对弈式打分，给出冠军版本 + 从落选版本里 salvage 的段落`, tier: v.ladder[2] || 'high', acceptance });
    return nodes;
  }

  if (v.topology === 'hierarchical') {
    push({ id: 'plan', role: 'plan', persona: spec.planner || 'strategist', mission: `把目标拆成 ${spec.fanout || v.fanout} 个可独立验收的工作包，每个给出验收标准`, acceptance: ['输出工作包清单，每包含明确验收口径'] });
    push({ id: 'exec', role: 'execute', persona: spec.persona || 'craftsman', deps: ['plan'], mission: `按上游工作包并行执行（引擎会在 plan 完成后二次展开）`, dynamic: true });
    return nodes;
  }

  // 兜底
  push({ id: 'n1', role: 'execute', mission: spec.goal, acceptance });
  return nodes;
}

function defaultLanes(goal, n) {
  const lanes = [
    { persona: 'scout', mission: `横向扫：这个目标${goal ? `「${goal}」` : ''}当前的一手事实与来源清单（给 URL/文件/日期）` },
    { persona: 'analyst', mission: `纵向挖：机制与因果，为什么成立、边界在哪` },
    { persona: 'redteam', mission: `反方：找出这个目标最可能错在哪，什么证据能推翻它`, adversarial: true },
    { persona: 'quant', mission: `量化：能落地的数字、阈值、可回测口径` },
    { persona: 'craftsman', mission: `落地：可直接执行的方案/代码/清单，含步骤与验证方式` },
  ];
  return lanes.slice(0, Math.max(1, n));
}

function defaultStyles(n) {
  const s = [
    { persona: 'writer', brief: '强钩子、快节奏、爽点前置' },
    { persona: 'stylist', brief: '氛围与人物质感优先，克制的爽' },
    { persona: 'plotter', brief: '结构反转优先，信息差铺到最后一句' },
    { persona: 'redteam', brief: '按"读者三章弃书"的挑剔标准重写', adversarial: true },
  ];
  return s.slice(0, Math.max(1, n));
}

module.exports = { assess, compile, defaultLanes };
