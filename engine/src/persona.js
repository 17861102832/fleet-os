'use strict';
/**
 * 人格注册表 —— 舰队里每个执行单元都必须有独立人格，禁止"同一个提示词复制 100 份"。
 * 每个人格有：固定立场(stance)、私有日记(journal)、专属技能、模型偏好、是否对抗。
 * 立场不随别人改变 —— 这是从工程上硬掐"谄媚从众(sycophancy)"的手段：
 * 同构 swarm 的从众率实测最高 85.5%，靠"你们要有不同观点"是求不来的，必须把立场写死并彼此隔离。
 */
const fs = require('fs');
const path = require('path');
const { ensureDir, appendJsonl, readJsonl, hashInt, now } = require('./util');

class PersonaRegistry {
  constructor(dir) {
    this.dir = dir;
    this.cards = new Map();
    this.reload();
  }
  reload() {
    this.cards.clear();
    if (!fs.existsSync(this.dir)) return this;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (Array.isArray(c)) for (const one of c) if (one && one.id) this.cards.set(one.id, one);
        else if (c && c.id) this.cards.set(c.id, c);
      } catch (_) { /* 坏卡跳过 */ }
    }
    return this;
  }
  get(id) { return this.cards.get(id) || null; }
  list() { return [...this.cards.values()]; }
  byCapability(cap) { return this.list().filter((c) => (c.capabilities || []).includes(cap)); }

  /** 从「专家团」角色卡直接铸一个舰员人格（复用 311 位专家资产） */
  adoptExpert(file, overrides = {}) {
    const raw = fs.readFileSync(file, 'utf8');
    const id = overrides.id || ('expert_' + path.basename(file, '.md'));
    const card = {
      id,
      callsign: overrides.callsign || path.basename(file, '.md'),
      role: overrides.role || 'specialist',
      stance: overrides.stance || '只对证据负责，不迎合任何同伴结论',
      source: file,
      charter: raw,
      capabilities: overrides.capabilities || ['execute'],
      modelPref: overrides.modelPref || null,
      temperature: overrides.temperature == null ? 0.4 : overrides.temperature,
      adversarial: !!overrides.adversarial,
    };
    this.cards.set(id, card);
    ensureDir(this.dir);
    fs.writeFileSync(path.join(this.dir, id + '.json'), JSON.stringify(card, null, 2), 'utf8');
    return card;
  }

  journalFile(id) { return path.join(this.dir, '..', 'state', 'memories', id + '.jsonl'); }

  remember(id, entry) {
    appendJsonl(this.journalFile(id), Object.assign({ ts: now() }, entry));
  }
  recall(id, k = 12) {
    const all = readJsonl(this.journalFile(id));
    return all.slice(-k);
  }

  /**
   * 铸造一次执行实例：同一人格在不同节点上的立场由 seed 决定其切入角，
   * 保证「同一个专家、每次咬住不同的假设」，而不是随机乱飘。
   */
  spawn(personaId, { fleet, node, angleCount = 6 } = {}) {
    const card = this.get(personaId) || {
      id: personaId, callsign: personaId, role: 'worker',
      stance: '按任务书交付，不擅自扩大范围', capabilities: ['execute'], temperature: 0.5,
    };
    const seed = hashInt(`${fleet}|${node}|${personaId}`);
    const angles = card.angles && card.angles.length ? card.angles : DEFAULT_ANGLES;
    const angle = angles[Math.abs(seed) % Math.min(angleCount, angles.length)];
    return { card, seed, angle };
  }

  /**
   * 组装 system prompt。blind=true 时不给黑板上下文 —— 盲评者绝不能看见同伴答案，
   * 否则"独立并行"立刻退化成从众（实测共识崩塌可丢掉池子里 32.3pt 已有的正确答案）。
   */
  systemPrompt({ card, angle }, ctx = {}) {
    const L = [];
    L.push(`你是舰队「${card.callsign}」，代号 ${card.id}，岗位 ${card.role}。`);
    L.push(`你的立场（不可协商）：${card.stance}`);
    L.push(`本轮你只咬住这一个切入角：${angle}`);
    if (card.rules && card.rules.length) L.push('硬规则：\n' + card.rules.map((r) => '- ' + r).join('\n'));
    if (card.expertise && card.expertise.length) L.push('你被召唤是因为你懂：' + card.expertise.join('、'));
    if (card.charter) L.push('—— 角色宪章 ——\n' + card.charter.slice(0, 4000));
    const mem = ctx.memory || [];
    if (mem.length) L.push('你自己的历史笔记（只属于你，别人看不见）：\n' + mem.map((m) => `- ${m.note || m.text || JSON.stringify(m)}`).join('\n'));
    if (ctx.board) L.push('\n—— 公共黑板（他人已确认的事实/产出）——\n' + ctx.board);
    if (ctx.blind) L.push('\n【盲评模式】你看不到任何其他舰员的答案。这是故意的：只按你自己的判断输出，不要猜别人会说什么，不要试图折中。');
    L.push(`\n交付纪律：${ctx.acceptance && ctx.acceptance.length ? '逐条对照验收标准交付 →\n' + ctx.acceptance.map((a) => '  [ ] ' + a).join('\n') : '给出可验证的产物，而不是描述你打算做什么。'}`);
    L.push('输出契约：先结论，再证据（文件路径/命令输出/来源 URL），最后写"我没能证明什么"。禁止占位符、禁止 TODO、禁止把计划当成果。');
    if (card.adversarial) L.push('你是蓝军：任务是证伪。找不到缺陷就等于失职，但编造缺陷同样是失职。');
    return L.join('\n');
  }
}

const DEFAULT_ANGLES = [
  '需求边界与验收口径', '数据/事实来源可靠性', '实现路径与取舍', '失败模式与边界条件',
  '性能与成本', '对手会从哪里击穿它',
];

module.exports = { PersonaRegistry, DEFAULT_ANGLES };
