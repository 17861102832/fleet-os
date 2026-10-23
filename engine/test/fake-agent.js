'use strict';
/**
 * fake-agent.js —— Fleet OS 的「外部 agent」测试夹具
 * ---------------------------------------------------------------------------
 * 用途：e2e.js 第 4 路（cli worker）用它扮演一个外部 headless agent（claude / codex / dsh
 * 这类竞品），验证「竞品即组件」——把外部 CLI 当外设挂进舰队，stdout 回流即交付。
 *
 * 调用契约（见 engine/src/worker.js 的 cli()）：
 *     node fake-agent.js <prompt_file>
 *   · prompt_file 由 worker 写入，内容 = system + "\n\n" + user
 *   · stdout.trim() 直接当作节点的 summary
 *
 * ★ 三条不可违反的契约（改动前先读懂）：
 *   1. 输出必须包含 "fake-external-agent" —— e2e.js:225 靠它统计「外部 agent 交付回流」
 *      的路数（要求 ≥2）。
 *   2. 输出绝不能出现 reject / 驳回 / 不通过 —— engine/src/state.js:414 用
 *      /reject|驳回|不通过/i 判定裁决节点的 verdict，出现即被判为反面裁决，
 *      盲评+裁决链会当场断掉。
 *      ⇒ 因此本夹具【不回显 prompt 原文】，只输出自己构造的结构化文本；
 *        即使要引用任务，也先经过 scrub() 过滤。
 *   3. 输出要同时含「结论」与「证据」两个词 —— 该用例的 acceptance 是
 *      ['有结论有证据']，交付契约要求二者齐备。
 *
 * 零依赖，只用 Node 内置模块。故意写成「看起来像个人在干活」，
 * 这样 e2e 跑出来的交付物才接近真实外部 agent 的形态。
 */

const fs = require('fs');

const TAG = 'fake-external-agent';
const FORBIDDEN = /reject|驳回|不通过/gi;

/** 把会触发反面裁决的词替换掉，保证输出永远安全 */
function scrub(s) {
  return String(s == null ? '' : s).replace(FORBIDDEN, '[回避]');
}

/** 从 prompt 里安全地取几段身份信息（取不到就留空，不报错） */
function extract(prompt) {
  const grab = (re) => {
    const m = prompt.match(re);
    return m ? scrub(m[1]).trim() : '';
  };
  return {
    node: grab(/【你的节点】\s*([^\n]+)/),
    goal: grab(/【目标】\s*([^\n]+)/),
    mission: grab(/【作战任务】\s*([\s\S]*?)(?:\n\n|$)/),
    acceptance: grab(/【交付契约】\s*([^\n]*)/),
    persona: grab(/【你的节点】\s*[^\n]*?\/[^\n]*?\/([^\/\n]+)/),
  };
}

function main() {
  const pf = process.argv[2];
  let prompt = '';
  try {
    prompt = fs.readFileSync(pf, 'utf8');
  } catch (e) {
    // 读不到 prompt 也要给合法交付，不能让用例挂在子进程上
    process.stderr.write(`[${TAG}] prompt 读取失败: ${e && e.message}\n`);
  }

  const info = extract(prompt);
  const mission = info.mission ? info.mission.split('\n')[0].slice(0, 120) : '（未提供任务文本）';
  const nodeLine = info.node || '未知节点';

  const lines = [
    `[${TAG}] 独立外部代理交付 · 节点 ${nodeLine}`,
    '',
    '## 结论',
    `就「${mission}」，外部视角已独立复核完毕：任务边界清晰、可在当前上下文内闭环，`,
    '可按现有契约交付，无需追加外部依赖。',
    '',
    '## 证据',
    `1) 输入契约核对：已读取 fleet 注入的完整上下文（舰队目标 / 节点身份 / 任务 / 验收标准${info.acceptance ? ' / ' + info.acceptance.slice(0, 60) : ''}），字段齐全。`,
    '2) 独立复核：以独立进程重新读取任务上下文并给出结构化答复，与舰队内其他节点互不共享过程。',
    '3) 可复现命令：`node engine/test/fake-agent.js <prompt_file>`，stdout 即交付，退出码 0。',
    '',
    '## 置信度',
    '0.72 —— 任务边界明确部分给高分；涉及外部世界事实的部分本代理无独立信源，故未给更高分。',
  ];

  // 双保险：出口处再过一次筛，任何路径都不可能漏出禁用词
  const out = scrub(lines.join('\n'));
  process.stdout.write(out + '\n');
}

main();
