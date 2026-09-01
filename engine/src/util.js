'use strict';
/** 通用工具：时间、ID、哈希、JSONL、token 估算。零依赖。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const now = () => new Date().toISOString();
const ts = () => Date.now();
const uid = (p = 'id') => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* 跳过坏行，账本永不因单行损坏而不可读 */ }
  }
  return out;
}

function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function writeFileSafe(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, String(text), 'utf8');
}

/** 粗粒度 token 估算：CJK 按字符、ASCII 按 4 字符折算，够用即可（用于预算护栏，不做精确计费） */
function estTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
  return Math.max(1, Math.round(cjk + (s.length - cjk) / 3.6));
}

function expandEnv(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([A-Z0-9_]+)\}/gi, (m, k) => process.env[k] || '');
  }
  if (Array.isArray(obj)) return obj.map(expandEnv);
  if (obj && typeof obj === 'object') {
    const o = {};
    for (const k of Object.keys(obj)) o[k] = expandEnv(obj[k]);
    return o;
  }
  return obj;
}

function loadConfig(explicit) {
  const file = explicit || process.env.FLEET_CONFIG || path.join(__dirname, '..', 'fleet.config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = expandEnv(raw);
  cfg.__file = file;
  cfg.__root = path.dirname(path.resolve(file));
  for (const k of ['stateDir', 'artifactDir', 'personaDir', 'logDir']) {
    if (cfg[k]) cfg[k] = path.resolve(cfg.__root, cfg[k]);
  }
  return cfg;
}

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const pick = (arr, seed) => arr[Math.abs(hashInt(seed)) % arr.length];

function hashInt(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0;
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n) + `…[+${s.length - n}]`;
}

/** 极简分词，用于黑板相关性打分 */
function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u3000-\u9fff]/g, (c) => ' ' + c + ' ')
    .split(/[^a-z0-9\u3000-\u9fff]+/g)
    .filter((t) => t.length > 1 || /[\u3000-\u9fff]/.test(t));
}

module.exports = {
  now, ts, uid, sha, sleep, ensureDir, readJsonl, appendJsonl, writeFileSafe,
  estTokens, loadConfig, clamp, pick, hashInt, truncate, tokenize,
};
