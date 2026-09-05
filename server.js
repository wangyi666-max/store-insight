/**
 * 智慧门店运营洞察平台 — 后端代理（零依赖 Node 原生 http）
 * 职责：
 *   1. 托管 public/ 静态前端
 *   2. GET  /api/health   配置自检（不泄露 PAT 本体）
 *   3. GET  /api/meta     商圈/门店清单（data/seed.json，源自知识库真实数据）
 *   4. POST /api/diagnose 转发扣子 business_diagnosis 工作流（PAT 仅存于服务端 .env）
 *        body: { shop_name, district, demo? }
 *        demo=true 时返回 样例返回.json 缓存（前端以琥珀色标识"演示缓存"，用于答辩断网兜底）
 *   5. 认证（PRD 3.1）：POST /api/auth/register|login|logout、GET /api/auth/me
 *        用户存 data/users.json（scrypt 加盐哈希，OWASP 口径）；会话存 data/sessions.json（7 天过期）
 *   6. GET  /api/default-report?store=  默认诊断数据集（data/default_reports.json，
 *        由 scripts/gen_default_report.py 基于 03 经营主表+真实 UGC 语料确定性生成）
 *   7. 后台管理系统（/admin/ 路径独立入口，与前端主站同项目同端口）：
 *        POST /api/admin/login（仅 admin/operator/viewer 角色可入，禁用账号拒入）
 *        GET  /api/admin/me
 *        用户管理(仅 admin)：GET/POST /api/admin/users、PUT /api/admin/users/:u、
 *          POST /api/admin/users/:u/status、POST /api/admin/users/:u/password
 *        数据资产：GET /api/admin/assets/boards、PUT /api/admin/assets/boards/:id、
 *          GET/POST /api/admin/assets、PUT /api/admin/assets/:id、
 *          POST /api/admin/assets/:id/archive、GET /api/admin/assets/export
 *        商圈：GET/POST /api/admin/districts、PUT/DELETE /api/admin/districts/:id、
 *          POST /api/admin/districts/import、GET /api/admin/districts/export
 *        门店：GET/POST /api/admin/stores、PUT/DELETE /api/admin/stores/:id、
 *          POST /api/admin/stores/import、GET /api/admin/stores/export
 *        权限：admin 全部；operator 资产/商圈/门店增删改；viewer 只读+导出。
 *        会话按通道(web/admin)隔离单设备在线：同通道互挤，跨通道互不影响。
 *        种子数据：scripts/gen_admin_seed.py（已存在不覆盖）；首个 admin 账号启动时自建。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SAMPLE_FILE = path.join(ROOT, '样例返回.json');
const USERS_FILE = path.join(ROOT, 'data', 'users.json');
const SESSIONS_FILE = path.join(ROOT, 'data', 'sessions.json');
const REPORTS_FILE = path.join(ROOT, 'data', 'default_reports.json');
const DISTRICTS_FILE = path.join(ROOT, 'data', 'admin_districts.json');
const STORES_FILE = path.join(ROOT, 'data', 'admin_stores.json');
const ASSETS_FILE = path.join(ROOT, 'data', 'admin_assets.json');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 登录态 7 天(PRD 3.1)
const ADMIN_ROLES = ['admin', 'operator', 'viewer']; // 后台可登录角色；前台注册用户为 member

/* ---------- .env 读取（零依赖简易解析） ---------- */
function loadEnv() {
  const env = {};
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim();
    }
  } catch (_) { /* .env 缺失时走环境变量 */ }
  return env;
}
const ENV = loadEnv();
// 部署平台禁止 COZE_ 前缀的用户变量,优先读 WORKFLOW_PAT/WORKFLOW_ID/API_BASE;本地 .env 老名继续可用
const COZE_PAT = process.env.WORKFLOW_PAT || process.env.COZE_PAT || ENV.COZE_PAT || '';
const WORKFLOW_ID = process.env.WORKFLOW_ID || process.env.COZE_WORKFLOW_ID || ENV.COZE_WORKFLOW_ID || '';
const COZE_API_BASE = (process.env.API_BASE || process.env.COZE_API_BASE || ENV.COZE_API_BASE || 'https://api.coze.cn').replace(/\/+$/, '');

const PORT = Number(process.env.PORT) || 5000;
const HOST = '0.0.0.0';
const COZE_TIMEOUT_MS = 300000; // 工作流实测 ~170s，留足余量
let liveInFlight = false; // 实时诊断并发锁

/* ---------- 扣子返回解析：{code, data:"{\"result\":\"<escaped>\"}"} 三层解包 ---------- */
function parseCozePayload(raw) {
  const outer = JSON.parse(raw);
  if (outer.code !== 0) {
    const err = new Error(`coze code=${outer.code} msg=${outer.msg || ''}`);
    err.coze = outer;
    throw err;
  }
  const data = JSON.parse(outer.data);
  const result = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
  return { result, debugUrl: outer.debug_url || '' };
}

function readSampleResult() {
  const raw = fs.readFileSync(SAMPLE_FILE, 'utf8');
  return parseCozePayload(raw).result;
}

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.endsWith('/')) rel += 'index.html'; // /admin/ 等目录路径落到各自 index.html
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ---------- 工具 ---------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------- 认证：用户/会话存储（OWASP 口径：scrypt 加盐哈希 + 限时会话） ---------- */
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJsonSafe(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 1), 'utf8');
  } catch (err) {
    // 托管部署环境文件系统可能只读/临时：写失败不阻断服务，仅记日志
    console.warn(`[store-insight] 数据文件写入失败(${path.basename(file)}): ${err.code || err.message}`);
  }
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function findUser(username) {
  const users = readJsonSafe(USERS_FILE, []);
  return users.find((u) => u.username === username) || null;
}

// 内置账号兜底：托管部署多实例无共享磁盘，users.json 写读跨请求不可见。
// 内置演示/后台账号在代码内确定性校验（密码取环境变量），任意实例可登录；
// 本地 users.json 命中时仍走文件校验（含改密/禁用），兜底仅在线程读不到该用户时生效。
function findBuiltin(username) {
  const u = String(username || '').toLowerCase();
  const builtins = [
    { username: 'teacher01', password: 'teach2026', name: '演示教师账号', role: 'member' },
    { username: 'demo_teacher', password: 'demo2026', name: '移动端演示账号', role: 'member' },
    { username: 'admin', password: process.env.ADMIN_PWD || 'admin123456', name: '系统管理员', role: 'admin' },
    { username: 'operator01', password: process.env.OP_PWD || 'op123456', name: '运营演示账号', role: 'operator' },
    { username: 'viewer01', password: process.env.VIEW_PWD || 'view123456', name: '只读演示账号', role: 'viewer' }
  ];
  return builtins.find((x) => x.username.toLowerCase() === u) || null;
}

// 自包含签名会话：token 携带 HMAC 签名，任意实例可验（多实例部署不依赖共享 sessions.json）。
// 本地签发后同时写入 sessions.json，文件命中时保留"单设备踢下线"语义；部署环境文件不可共享，降级为无状态校验。
const SESSION_SECRET = crypto.createHash('sha256').update('sip-session:' + (COZE_PAT || 'local-dev')).digest();

function signSessionToken(username, channel) {
  const payload = Buffer.from(JSON.stringify({
    u: username, c: channel || 'web', exp: Date.now() + SESSION_TTL_MS, r: crypto.randomBytes(8).toString('hex')
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifySessionToken(token) {
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!p.u || typeof p.exp !== 'number' || p.exp <= Date.now()) return null;
    return { username: p.u };
  } catch (_) { return null; }
}

function pruneSessions(sessions) {
  const now = Date.now();
  return sessions.filter((s) => s.expiresAt > now);
}

// 单设备在线（按通道隔离）：签发新会话时把该账号同通道旧会话标记为 replaced
// （web 前台与 admin 后台各算一台设备，互挤不跨通道；旧会话保留至自然过期，用于"被挤下线"提示）
function issueToken(username, channel) {
  channel = channel || 'web';
  const sessions = pruneSessions(readJsonSafe(SESSIONS_FILE, []));
  for (const s of sessions) {
    if (s.username === username && (s.channel || 'web') === channel && !s.replaced) s.replaced = true;
  }
  const token = signSessionToken(username, channel);
  sessions.push({ token, username, channel, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  writeJsonSafe(SESSIONS_FILE, sessions);
  return token;
}

// 把某账号全部通道会话强制下线（禁用账号/重置密码后调用）
function revokeUserSessions(username) {
  const sessions = pruneSessions(readJsonSafe(SESSIONS_FILE, []));
  for (const s of sessions) {
    if (s.username === username && !s.replaced) s.replaced = true;
  }
  writeJsonSafe(SESSIONS_FILE, sessions);
}

function touchLastLogin(username) {
  const users = readJsonSafe(USERS_FILE, []);
  const u = users.find((x) => x.username === username);
  if (u) { u.lastLoginAt = new Date().toISOString(); writeJsonSafe(USERS_FILE, users); }
}

// 启动时自检：老用户补角色字段（前台注册用户=member）；无任何 admin 时建默认后台三角色演示账号
function ensureAdminAccounts() {
  const users = readJsonSafe(USERS_FILE, []);
  let changed = false;
  for (const u of users) {
    if (!u.role) { u.role = 'member'; changed = true; }
    if (!u.status) { u.status = 'enabled'; changed = true; }
  }
  if (!users.some((u) => u.role === 'admin')) {
    // 公开部署时通过环境变量覆盖初始密码,避免仓库公开后后台默认口令泄露(短名:部署平台对变量名有长度限制)
    const defaults = [
      ['admin', process.env.ADMIN_PWD || 'admin123456', '系统管理员', 'admin'],
      ['operator01', process.env.OP_PWD || 'op123456', '运营演示账号', 'operator'],
      ['viewer01', process.env.VIEW_PWD || 'view123456', '只读演示账号', 'viewer']
    ];
    for (const [username, pwd, name, role] of defaults) {
      if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) continue;
      const { salt, hash } = hashPassword(pwd);
      users.push({ username, salt, hash, name, role, phone: '', status: 'enabled', createdAt: new Date().toISOString() });
      changed = true;
      console.log(`[admin] 已创建默认后台账号 ${username}（${role}），请尽快登录后台修改密码`);
    }
  }
  if (changed) writeJsonSafe(USERS_FILE, users);
}

// 启动时自检：前台演示账号（视频脚本/交付文档统一口径），缺失才建，幂等。
// 部署环境从零启动时保证 teacher01/demo_teacher 拿来即用，无需人工注册。
function ensureDemoAccounts() {
  const users = readJsonSafe(USERS_FILE, []);
  let changed = false;
  const demos = [
    ['teacher01', 'teach2026', '演示教师账号'],
    ['demo_teacher', 'demo2026', '移动端演示账号']
  ];
  for (const [username, pwd, name] of demos) {
    if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) continue;
    const { salt, hash } = hashPassword(pwd);
    users.push({ username, salt, hash, name, role: 'member', phone: '', status: 'enabled', createdAt: new Date().toISOString() });
    changed = true;
    console.log(`[demo] 已创建前台演示账号 ${username}`);
  }
  if (changed) writeJsonSafe(USERS_FILE, users);
}

// 返回 { username } | { replaced: true } | null
// 先查会话文件（本地命中时保留踢下线语义）；未命中再验签名 token（部署多实例无共享会话文件时兜底）
function checkSession(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const token = m[1];
  const sessions = pruneSessions(readJsonSafe(SESSIONS_FILE, []));
  const s = sessions.find((x) => x.token === token);
  if (s) {
    if (s.replaced) return { replaced: true };
    return { username: s.username };
  }
  if (/^[0-9a-f]{48}$/i.test(token)) return null; // 旧版随机 token：会话文件即权威
  return verifySessionToken(token);
}

function sendSessionReplaced(res) {
  sendJson(res, 401, { ok: false, code: 'SESSION_REPLACED', error: '该账号已在其他设备登录，当前设备已退出（同一账号同一时间仅支持一台设备在线）' });
}

/* ---------- 后台管理：权限与通用工具 ---------- */
// 返回 { username, role, user } | { replaced } | { forbidden } | { disabled } | null
function checkAdmin(req) {
  const s = checkSession(req);
  if (!s || s.replaced) return s;
  let user = findUser(s.username);
  if (!user) {
    const b = findBuiltin(s.username);
    if (b) user = { username: b.username, name: b.name, role: b.role, status: 'enabled' };
  }
  if (!user) return null;
  const role = user.role || 'member';
  if (!ADMIN_ROLES.includes(role)) return { forbidden: true };
  if (user.status === 'disabled') return { disabled: true };
  return { username: s.username, role, user };
}

// minRole: 'viewer' 任意后台角色可读；'operator' 可增删改；'admin' 仅管理员
// 校验通过返回 ctx，失败已响应并返回 null
function requireAdmin(req, res, minRole) {
  const ctx = checkAdmin(req);
  if (!ctx) { sendJson(res, 401, { ok: false, error: '登录态无效或已过期' }); return null; }
  if (ctx.replaced) { sendSessionReplaced(res); return null; }
  if (ctx.disabled) { sendJson(res, 403, { ok: false, code: 'ACCOUNT_DISABLED', error: '账号已被禁用，请联系管理员' }); return null; }
  if (ctx.forbidden) { sendJson(res, 403, { ok: false, code: 'NO_ADMIN_ROLE', error: '该账号无后台管理权限' }); return null; }
  const rank = { viewer: 1, operator: 2, admin: 3 };
  if (rank[ctx.role] < rank[minRole || 'viewer']) {
    sendJson(res, 403, { ok: false, code: 'ROLE_DENIED', error: minRole === 'admin' ? '仅管理员可操作用户管理' : '只读人员无修改权限' });
    return null;
  }
  return ctx;
}

function queryOf(req) {
  const q = req.url.split('?')[1] || '';
  const out = {};
  for (const kv of q.split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = i < 0 ? kv : kv.slice(0, i);
    // 代理可能把 %20 重写为 +，先还原再解码（与 default-report 同款处理）
    out[decodeURIComponent(k)] = decodeURIComponent((i < 0 ? '' : kv.slice(i + 1)).replace(/\+/g, ' '));
  }
  return out;
}

function paginate(list, q) {
  const total = list.length;
  const size = Math.min(Math.max(parseInt(q.size, 10) || 10, 1), 100);
  const pages = Math.max(Math.ceil(total / size), 1);
  const page = Math.min(Math.max(parseInt(q.page, 10) || 1, 1), pages);
  return { total, page, size, pages, list: list.slice((page - 1) * size, page * size) };
}

function nextId(list, prefix, field) {
  let max = 0;
  for (const it of list) {
    const m = String(it[field] || '').match(new RegExp('^' + prefix + '(\\d+)$'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + String(max + 1).padStart(3, '0');
}

function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + [headers.map((h) => esc(h[0])).join(',')]
    .concat(rows.map((r) => headers.map((h) => esc(h[1](r))).join(',')))
    .join('\r\n');
}

function sendCsv(res, filename, csvText) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  });
  res.end(csvText);
}

const nowIso = () => new Date().toISOString();
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
const numOrEmpty = (v) => {
  const s = str(v, 30);
  if (s === '') return '';
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null; // null 表示格式非法（用于校验报错）
};

function callCozeWorkflow(shopName, district) {
  const payload = JSON.stringify({
    workflow_id: WORKFLOW_ID,
    parameters: { shop_name: shopName, district: district || '粉象Park' }
  });
  const url = new URL(COZE_API_BASE + '/v1/workflow/run');
  const options = {
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname,
    timeout: COZE_TIMEOUT_MS,
    headers: {
      'Authorization': 'Bearer ' + COZE_PAT,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  return new Promise((resolve, reject) => {
    // 扣子 API 必须走 https：用 http 会被 CDN(volc-dcdn) 301 重定向
    const r = https.request(options, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (resp.statusCode !== 200) {
          reject(new Error(`coze http ${resp.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try { resolve(parseCozePayload(raw)); } catch (e) { reject(e); }
      });
    });
    r.on('timeout', () => { r.destroy(new Error('coze request timeout')); });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/api/health' && req.method === 'GET') {
    let demoAvailable = false;
    try { fs.accessSync(SAMPLE_FILE); demoAvailable = true; } catch (_) {}
    sendJson(res, 200, {
      ok: true,
      patConfigured: Boolean(COZE_PAT),
      workflowId: WORKFLOW_ID || null,
      apiBase: COZE_API_BASE,
      demoAvailable
    });
    return;
  }

  if (urlPath === '/api/meta' && req.method === 'GET') {
    try {
      const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed.json'), 'utf8'));
      sendJson(res, 200, { ok: true, meta: seed });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'seed.json 读取失败: ' + e.message });
    }
    return;
  }

  /* ---------- 认证路由 ---------- */
  if (urlPath === '/api/auth/register' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
      sendJson(res, 400, { ok: false, error: '用户名需为 4-20 位字母、数字或下划线' }); return;
    }
    if (password.length < 6 || password.length > 20) {
      sendJson(res, 400, { ok: false, error: '密码长度需为 6-20 位' }); return;
    }
    const users = readJsonSafe(USERS_FILE, []);
    if (users.some((u) => u.username.toLowerCase() === username.toLowerCase()) || findBuiltin(username)) {
      sendJson(res, 409, { ok: false, error: '用户名已被注册' }); return;
    }
    const { salt, hash } = hashPassword(password);
    users.push({ username, salt, hash, createdAt: new Date().toISOString() });
    writeJsonSafe(USERS_FILE, users);
    sendJson(res, 200, { ok: true, token: issueToken(username), username });
    return;
  }

  if (urlPath === '/api/auth/login' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = findUser(username);
    // OWASP: 失败提示不区分"用户不存在"与"密码错误"，防用户名枚举
    let authed = false;
    if (user) {
      authed = crypto.scryptSync(password, user.salt, 64).toString('hex') === user.hash;
    } else {
      const b = findBuiltin(username);
      authed = Boolean(b && b.password === password);
    }
    if (!authed) { sendJson(res, 401, { ok: false, error: '用户名或密码错误' }); return; }
    touchLastLogin(username);
    sendJson(res, 200, { ok: true, token: issueToken(username, 'web'), username });
    return;
  }

  if (urlPath === '/api/auth/logout' && req.method === 'POST') {
    const h = req.headers['authorization'] || '';
    const m = h.match(/^Bearer\s+(\S+)$/i);
    if (m) {
      const sessions = pruneSessions(readJsonSafe(SESSIONS_FILE, [])).filter((s) => s.token !== m[1]);
      writeJsonSafe(SESSIONS_FILE, sessions);
    }
    // 签名 token 无状态，无法跨实例吊销；前端清除本地 token 即完成登出，余下等待自然过期
    sendJson(res, 200, { ok: true });
    return;
  }

  if (urlPath === '/api/auth/me' && req.method === 'GET') {
    const s = checkSession(req);
    if (s && s.replaced) { sendSessionReplaced(res); return; }
    if (!s || !s.username) { sendJson(res, 401, { ok: false, error: '登录态无效或已过期' }); return; }
    sendJson(res, 200, { ok: true, username: s.username });
    return;
  }

  /* ---------- 默认诊断数据集（功能2：针对当前默认商圈/门店，无需实时调用） ---------- */
  if (urlPath === '/api/default-report' && req.method === 'GET') {
    const sess = checkSession(req);
    if (sess && sess.replaced) { sendSessionReplaced(res); return; }
    if (!sess || !sess.username) { sendJson(res, 401, { ok: false, error: '请先登录' }); return; }
    const storeName = (req.url.split('?')[1] || '').split('&').map((kv) => kv.split('='))
      .find((kv) => kv[0] === 'store');
    try {
      const all = readJsonSafe(REPORTS_FILE, null);
      if (!all) { sendJson(res, 503, { ok: false, error: '默认报告数据集未生成，请先运行 scripts/gen_default_report.py' }); return; }
      // 代理/CDN 可能把 %20 重写为 +，decodeURIComponent 不还原 +，先替换再解码
      const name = storeName ? decodeURIComponent((storeName[1] || '').replace(/\+/g, ' ')) : '';
      const report = all.stores[name];
      if (!report) { sendJson(res, 404, { ok: false, error: '该门店暂无默认报告数据: ' + name }); return; }
      sendJson(res, 200, { ok: true, source: 'default-report', generatedAt: all.meta.generated_at, result: report });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: '默认报告读取失败: ' + e.message });
    }
    return;
  }

  if (urlPath === '/api/diagnose' && req.method === 'POST') {
    const sess2 = checkSession(req);
    if (sess2 && sess2.replaced) { sendSessionReplaced(res); return; }
    if (!sess2 || !sess2.username) { sendJson(res, 401, { ok: false, error: '请先登录' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }

    const shopName = (body.shop_name || '').trim();
    const district = (body.district || '').trim();
    if (!shopName) { sendJson(res, 400, { ok: false, error: 'shop_name 不能为空' }); return; }

    if (body.demo === true) {
      try {
        const result = readSampleResult();
        sendJson(res, 200, { ok: true, source: 'demo-cache', elapsedMs: 0, result });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: '演示缓存读取失败: ' + e.message });
      }
      return;
    }

    if (!COZE_PAT || !WORKFLOW_ID) {
      sendJson(res, 503, { ok: false, error: '服务端未配置 COZE_PAT / COZE_WORKFLOW_ID，请检查 .env' });
      return;
    }

    // 公开分享场景保护：同一时间只允许一个实时诊断在执行（单次 ~3 分钟，避免并发挤占工作流额度）
    if (liveInFlight) {
      sendJson(res, 429, { ok: false, error: '已有一份实时诊断正在执行中（约 3 分钟），请稍后再试；也可先用「快速预览」查看演示缓存' });
      return;
    }

    liveInFlight = true;
    const started = Date.now();
    try {
      const { result, debugUrl } = await callCozeWorkflow(shopName, district);
      sendJson(res, 200, { ok: true, source: 'coze-live', elapsedMs: Date.now() - started, result, debugUrl });
    } catch (e) {
      const isTimeout = /timeout/i.test(e.message);
      sendJson(res, isTimeout ? 504 : 502, {
        ok: false,
        error: isTimeout ? '扣子工作流调用超时（>300s）' : '扣子工作流调用失败: ' + e.message
      });
    } finally {
      liveInFlight = false;
    }
    return;
  }

  /* ==================== 后台管理系统 /api/admin/* ==================== */

  if (urlPath === '/api/admin/login' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    // 与前台登录同口径：失败提示不区分用户不存在/密码错误
    let user = findUser(username);
    let authed = false;
    if (user) {
      authed = crypto.scryptSync(password, user.salt, 64).toString('hex') === user.hash;
    } else {
      const b = findBuiltin(username);
      if (b && b.password === password) {
        authed = true;
        user = { username: b.username, name: b.name, role: b.role, status: 'enabled' };
      }
    }
    if (!authed) { sendJson(res, 401, { ok: false, error: '用户名或密码错误' }); return; }
    if (user.status === 'disabled') { sendJson(res, 403, { ok: false, code: 'ACCOUNT_DISABLED', error: '账号已被禁用，请联系管理员' }); return; }
    const role = user.role || 'member';
    if (!ADMIN_ROLES.includes(role)) { sendJson(res, 403, { ok: false, code: 'NO_ADMIN_ROLE', error: '该账号无后台管理权限（前台注册用户请从主站登录）' }); return; }
    touchLastLogin(username);
    sendJson(res, 200, { ok: true, token: issueToken(username, 'admin'), username, name: user.name || '', role });
    return;
  }

  if (urlPath === '/api/admin/me' && req.method === 'GET') {
    const ctx = requireAdmin(req, res, 'viewer');
    if (!ctx) return;
    sendJson(res, 200, { ok: true, username: ctx.username, name: ctx.user.name || '', role: ctx.role });
    return;
  }

  /* ---------- 模块1：用户管理（仅 admin） ---------- */
  if (urlPath === '/api/admin/users' && req.method === 'GET') {
    const ctx = requireAdmin(req, res, 'admin');
    if (!ctx) return;
    const q = queryOf(req);
    let list = readJsonSafe(USERS_FILE, []).filter((u) => ADMIN_ROLES.includes(u.role));
    if (q.q) {
      const kw = q.q.toLowerCase();
      list = list.filter((u) => u.username.toLowerCase().includes(kw) || (u.name || '').toLowerCase().includes(kw) || (u.phone || '').includes(kw));
    }
    if (q.role && ADMIN_ROLES.includes(q.role)) list = list.filter((u) => u.role === q.role);
    if (q.status) list = list.filter((u) => (u.status || 'enabled') === q.status);
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const p = paginate(list, q);
    // 永不返回 salt/hash
    p.list = p.list.map((u) => ({ username: u.username, name: u.name || '', role: u.role, phone: u.phone || '', status: u.status || 'enabled', createdAt: u.createdAt || '', lastLoginAt: u.lastLoginAt || '' }));
    sendJson(res, 200, Object.assign({ ok: true }, p));
    return;
  }

  if (urlPath === '/api/admin/users' && req.method === 'POST') {
    const ctx = requireAdmin(req, res, 'admin');
    if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const username = str(body.username, 20);
    const password = String(body.password || '');
    const name = str(body.name, 20);
    const role = str(body.role, 20);
    const phone = str(body.phone, 11);
    if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) { sendJson(res, 400, { ok: false, error: '账号需为 4-20 位字母、数字或下划线' }); return; }
    if (password.length < 6 || password.length > 20) { sendJson(res, 400, { ok: false, error: '密码长度需为 6-20 位' }); return; }
    if (!name) { sendJson(res, 400, { ok: false, error: '用户姓名不能为空' }); return; }
    if (!ADMIN_ROLES.includes(role)) { sendJson(res, 400, { ok: false, error: '角色须为 管理员/运营人员/只读人员 之一' }); return; }
    if (phone && !/^1\d{10}$/.test(phone)) { sendJson(res, 400, { ok: false, error: '手机号码格式不正确' }); return; }
    const users = readJsonSafe(USERS_FILE, []);
    if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) { sendJson(res, 409, { ok: false, error: '账号已存在（唯一不可重复）' }); return; }
    const { salt, hash } = hashPassword(password);
    users.push({ username, salt, hash, name, role, phone, status: 'enabled', createdAt: nowIso() });
    writeJsonSafe(USERS_FILE, users);
    sendJson(res, 200, { ok: true, username });
    return;
  }

  const userMatch = urlPath.match(/^\/api\/admin\/users\/([^/]+)(\/(status|password))?$/);
  if (userMatch && (req.method === 'PUT' || req.method === 'POST')) {
    const ctx = requireAdmin(req, res, 'admin');
    if (!ctx) return;
    const target = decodeURIComponent(userMatch[1]);
    const action = userMatch[3] || '';
    if ((req.method === 'PUT') !== (action === '')) { res.writeHead(405); res.end('Method Not Allowed'); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const users = readJsonSafe(USERS_FILE, []);
    const u = users.find((x) => x.username === target && ADMIN_ROLES.includes(x.role));
    if (!u) { sendJson(res, 404, { ok: false, error: '后台账号不存在: ' + target }); return; }

    if (action === '') { // 编辑姓名/角色/手机号
      const name = str(body.name, 20);
      const role = str(body.role, 20);
      const phone = str(body.phone, 11);
      if (!name) { sendJson(res, 400, { ok: false, error: '用户姓名不能为空' }); return; }
      if (!ADMIN_ROLES.includes(role)) { sendJson(res, 400, { ok: false, error: '角色须为 管理员/运营人员/只读人员 之一' }); return; }
      if (phone && !/^1\d{10}$/.test(phone)) { sendJson(res, 400, { ok: false, error: '手机号码格式不正确' }); return; }
      if (target === ctx.username && role !== 'admin') { sendJson(res, 400, { ok: false, error: '不能修改自己的管理员角色' }); return; }
      u.name = name; u.role = role; u.phone = phone;
      writeJsonSafe(USERS_FILE, users);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === 'status') { // 启用/冻结
      const status = body.status === 'disabled' ? 'disabled' : 'enabled';
      if (target === ctx.username && status === 'disabled') { sendJson(res, 400, { ok: false, error: '不能禁用当前登录账号' }); return; }
      u.status = status;
      writeJsonSafe(USERS_FILE, users);
      if (status === 'disabled') revokeUserSessions(target); // 禁用即强制下线
      sendJson(res, 200, { ok: true, status });
      return;
    }
    // password：管理员重置密码，重置后强制重新登录
    const password = String(body.password || '');
    if (password.length < 6 || password.length > 20) { sendJson(res, 400, { ok: false, error: '密码长度需为 6-20 位' }); return; }
    const { salt, hash } = hashPassword(password);
    u.salt = salt; u.hash = hash;
    writeJsonSafe(USERS_FILE, users);
    revokeUserSessions(target);
    sendJson(res, 200, { ok: true });
    return;
  }

  /* ---------- 模块2：数据资产管理 ---------- */
  if (urlPath === '/api/admin/assets/boards' && req.method === 'GET') {
    const ctx = requireAdmin(req, res, 'viewer');
    if (!ctx) return;
    const data = readJsonSafe(ASSETS_FILE, { boards: [], assets: [] });
    const boards = data.boards.map((b) => Object.assign({}, b, { assetCount: data.assets.filter((a) => a.boardId === b.id && a.status !== 'archived').length }));
    sendJson(res, 200, { ok: true, boards });
    return;
  }

  const boardMatch = urlPath.match(/^\/api\/admin\/assets\/boards\/([^/]+)$/);
  if (boardMatch && req.method === 'PUT') {
    const ctx = requireAdmin(req, res, 'operator');
    if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const name = str(body.name, 30);
    if (!name) { sendJson(res, 400, { ok: false, error: '板块名称不能为空' }); return; }
    const data = readJsonSafe(ASSETS_FILE, { boards: [], assets: [] });
    const b = data.boards.find((x) => x.id === decodeURIComponent(boardMatch[1]));
    if (!b) { sendJson(res, 404, { ok: false, error: '板块不存在' }); return; }
    if (data.boards.some((x) => x.id !== b.id && x.name === name)) { sendJson(res, 409, { ok: false, error: '板块名称已存在' }); return; }
    b.name = name;
    if (body.remark !== undefined) b.remark = str(body.remark, 200);
    writeJsonSafe(ASSETS_FILE, data);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (urlPath === '/api/admin/assets' && req.method === 'GET') {
    const ctx = requireAdmin(req, res, 'viewer');
    if (!ctx) return;
    const q = queryOf(req);
    const data = readJsonSafe(ASSETS_FILE, { boards: [], assets: [] });
    let list = data.assets.slice();
    if (q.board) list = list.filter((a) => a.boardId === q.board);
    if (q.status) list = list.filter((a) => a.status === q.status);
    if (q.q) {
      const kw = q.q.toLowerCase();
      list = list.filter((a) => [a.name, a.source, a.owner, a.intro].some((f) => (f || '').toLowerCase().includes(kw)));
    }
    const p = paginate(list, q);
    const boardName = {};
    for (const b of data.boards) boardName[b.id] = b.name;
    p.list = p.list.map((a) => Object.assign({}, a, { boardName: boardName[a.boardId] || a.boardId }));
    sendJson(res, 200, Object.assign({ ok: true }, p));
    return;
  }

  if (urlPath === '/api/admin/assets' && req.method === 'POST') {
    const ctx = requireAdmin(req, res, 'operator');
    if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const data = readJsonSafe(ASSETS_FILE, { boards: [], assets: [] });
    const name = str(body.name, 60);
    if (!name) { sendJson(res, 400, { ok: false, error: '资产名称不能为空' }); return; }
    if (!data.boards.some((b) => b.id === body.boardId)) { sendJson(res, 400, { ok: false, error: '归属板块不存在' }); return; }
    if (data.assets.some((a) => a.name === name && a.status !== 'archived')) { sendJson(res, 409, { ok: false, error: '同名资产已存在' }); return; }
    const asset = {
      id: nextId(data.assets, 'A', 'id'), name, boardId: str(body.boardId, 10),
      source: str(body.source, 120), updateCycle: str(body.updateCycle, 30), scale: str(body.scale, 60),
      owner: str(body.owner, 30), intro: str(body.intro, 500), attachment: str(body.attachment, 120),
      status: 'active', createdAt: nowIso(), updatedAt: nowIso()
    };
    data.assets.push(asset);
    writeJsonSafe(ASSETS_FILE, data);
    sendJson(res, 200, { ok: true, id: asset.id });
    return;
  }

  const assetMatch = urlPath.match(/^\/api\/admin\/assets\/([^/]+?)(\/archive)?$/);
  if (assetMatch && (req.method === 'PUT' || req.method === 'POST')) {
    const ctx = requireAdmin(req, res, 'operator');
    if (!ctx) return;
    const id = decodeURIComponent(assetMatch[1]);
    const isArchive = Boolean(assetMatch[2]);
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const data = readJsonSafe(ASSETS_FILE, { boards: [], assets: [] });
    const a = data.assets.find((x) => x.id === id);
    if (!a) { sendJson(res, 404, { ok: false, error: '资产不存在: ' + id }); return; }
    if (isArchive) { // 归档/恢复
      a.status = body.status === 'active' ? 'active' : 'archived';
      a.updatedAt = nowIso();
      writeJsonSafe(ASSETS_FILE, data);
      sendJson(res, 200, { ok: true, status: a.status });
      return;
    }
    if (req.method !== 'PUT') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    const name = str(body.name, 60);
    if (!name) { sendJson(res, 400, { ok: false, error: '资产名称不能为空' }); return; }
    if (!data.boards.some((b) => b.id === body.boardId)) { sendJson(res, 400, { ok: false, error: '归属板块不存在' }); return; }
    a.name = name; a.boardId = str(body.boardId, 10);
    a.source = str(body.source, 120); a.updateCycle = str(body.updateCycle, 30); a.scale = str(body.scale, 60);
    a.owner = str(body.owner, 30); a.intro = str(body.intro, 500); a.attachment = str(body.attachment, 120);
    a.updatedAt = nowIso();
    writeJsonSafe(ASSETS_FILE, data);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (urlPath === '/api/admin/assets/export' && req.method === 'GET') {
    const ctx = requireAdmin(req, res, 'viewer');
    if (!ctx) return;
    const data = readJsonSafe(ASSETS_FILE, { boards: [], assets: [] });
    const boardName = {};
    for (const b of data.boards) boardName[b.id] = b.name;
    const csv = toCsv([
      ['资产编号', (a) => a.id], ['资产名称', (a) => a.name], ['归属板块', (a) => boardName[a.boardId] || a.boardId],
      ['数据来源', (a) => a.source], ['更新频率', (a) => a.updateCycle], ['存储量级', (a) => a.scale],
      ['负责人', (a) => a.owner], ['资产简介', (a) => a.intro], ['附件', (a) => a.attachment],
      ['状态', (a) => a.status === 'archived' ? '已归档' : '在册'], ['更新时间', (a) => a.updatedAt]
    ], data.assets);
    sendCsv(res, '数据资产台账.csv', csv);
    return;
  }

  /* ---------- 模块3：商圈信息管理 ---------- */
  function readDistrictBody(body) {
    const d = {
      name: str(body.name, 30), city: str(body.city, 20) || '西安市', region: str(body.region, 20),
      lng: numOrEmpty(body.lng), lat: numOrEmpty(body.lat), scale: str(body.scale, 30),
      tags: Array.isArray(body.tags) ? body.tags.map((t) => str(t, 12)).filter(Boolean).slice(0, 6)
        : str(body.tags, 80).split(/[,，;；]/).map((t) => t.trim()).filter(Boolean).slice(0, 6),
      years: str(body.years, 20), remark: str(body.remark, 300)
    };
    if (!d.name) return { error: '商圈名称不能为空' };
    if (d.lng === null || d.lat === null) return { error: '经纬度须为数字（可留空）' };
    return { value: d };
  }

  if (urlPath === '/api/admin/districts' && req.method === 'GET') {
    const ctx = requireAdmin(req, res, 'viewer');
    if (!ctx) return;
    const q = queryOf(req);
    let list = readJsonSafe(DISTRICTS_FILE, []);
    if (q.q) {
      const kw = q.q.toLowerCase();
      list = list.filter((d) => [d.name, d.region, d.city, (d.tags || []).join(' ')].some((f) => (f || '').toLowerCase().includes(kw)));
    }
    const stores = readJsonSafe(STORES_FILE, []);
    list = list.map((d) => Object.assign({}, d, { storeCount: stores.filter((s) => s.district === d.name).length }));
    const p = paginate(list, q);
    sendJson(res, 200, Object.assign({ ok: true }, p));
    return;
  }

  if (urlPath === '/api/admin/districts' && req.method === 'POST') {
    const ctx = requireAdmin(req, res, 'operator');
    if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const parsed = readDistrictBody(body);
    if (parsed.error) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const list = readJsonSafe(DISTRICTS_FILE, []);
    if (list.some((d) => d.name === parsed.value.name)) { sendJson(res, 409, { ok: false, error: '商圈名称已存在' }); return; }
    const d = Object.assign({ code: nextId(list, 'D', 'code') }, parsed.value, { createdAt: nowIso(), updatedAt: nowIso() });
    list.push(d);
    writeJsonSafe(DISTRICTS_FILE, list);
    sendJson(res, 200, { ok: true, code: d.code });
    return;
  }

  if (urlPath === '/api/admin/districts/import' && req.method === 'POST') {
    const ctx = requireAdmin(req, res, 'operator');
    if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
    if (!rows.length) { sendJson(res, 400, { ok: false, error: '没有可导入的数据行' }); return; }
    const list = readJsonSafe(DISTRICTS_FILE, []);
    let inserted = 0;
    const errors = [];
    rows.forEach((r, i) => {
      const parsed = readDistrictBody(r);
      const line = `第${i + 1}行`;
      if (parsed.error) { errors.push(`${line}:${parsed.error}`); return; }
      if (list.some((d) => d.name === parsed.value.name)) { errors.push(`${line}:商圈「${parsed.value.name}」已存在,跳过`); return; }
      list.push(Object.assign({ code: nextId(list, 'D', 'code') }, parsed.value, { createdAt: nowIso(), updatedAt: nowIso() }));
      inserted++;
    });
    writeJsonSafe(DISTRICTS_FILE, list);
    sendJson(res, 200, { ok: true, inserted, skipped: rows.length - inserted, errors: errors.slice(0, 20) });
    return;
  }

  if (urlPath === '/api/admin/districts/export' && req.method === 'GET') {
    const ctx = requireAdmin(req, res, 'viewer');
    if (!ctx) return;
    const list = readJsonSafe(DISTRICTS_FILE, []);
    const csv = toCsv([
      ['商圈编号', (d) => d.code], ['商圈名称', (d) => d.name], ['所在城市', (d) => d.city],
      ['行政区', (d) => d.region], ['经度', (d) => d.lng], ['纬度', (d) => d.lat],
      ['商圈规模', (d) => d.scale], ['商圈标签', (d) => (d.tags || []).join(';')],
      ['开业年限', (d) => d.years], ['备注', (d) => d.remark]
    ], list);
    sendCsv(res, '商圈信息.csv', csv);
    return;
  }

  const districtMatch = urlPath.match(/^\/api\/admin\/districts\/([^/]+)$/);
  if (districtMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const ctx = requireAdmin(req, res, 'operator');
    if (!ctx) return;
    const code = decodeURIComponent(districtMatch[1]);
    const list = readJsonSafe(DISTRICTS_FILE, []);
    const d = list.find((x) => x.code === code);
    if (!d) { sendJson(res, 404, { ok: false, error: '商圈不存在: ' + code }); return; }
    if (req.method === 'DELETE') {
      const stores = readJsonSafe(STORES_FILE, []);
      const cnt = stores.filter((s) => s.district === d.name).length;
      if (cnt > 0) { sendJson(res, 409, { ok: false, error: `该商圈下仍有 ${cnt} 家门店，请先调整门店归属后再删除` }); return; }
      writeJsonSafe(DISTRICTS_FILE, list.filter((x) => x.code !== code));
      sendJson(res, 200, { ok: true });
      return;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const parsed = readDistrictBody(body);
    if (parsed.error) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    if (parsed.value.name !== d.name) {
      if (list.some((x) => x.code !== code && x.name === parsed.value.name)) { sendJson(res, 409, { ok: false, error: '商圈名称已存在' }); return; }
      // 商圈改名时同步门店归属，保证关联不断链
      const stores = readJsonSafe(STORES_FILE, []);
      for (const s of stores) { if (s.district === d.name) { s.district = parsed.value.name; s.updatedAt = nowIso(); } }
      writeJsonSafe(STORES_FILE, stores);
    }
    Object.assign(d, parsed.value, { updatedAt: nowIso() });
    writeJsonSafe(DISTRICTS_FILE, list);
    sendJson(res, 200, { ok: true });
    return;
  }

  /* ---------- 模块4：门店信息管理 ---------- */
  function readStoreBody(body, districts) {
    const s = {
      name: str(body.name, 40), district: str(body.district, 30), address: str(body.address, 120),
      lng: numOrEmpty(body.lng), lat: numOrEmpty(body.lat),
      status: ['营业中', '已停业', '筹备中'].includes(body.status) ? body.status : '营业中',
      area: str(body.area, 20).replace(/㎡/g, ''), industry: str(body.industry, 30),
      openedAt: str(body.openedAt, 10), remark: str(body.remark, 300)
    };
    if (!s.name) return { error: '门店名称不能为空' };
    if (!s.district) return { error: '所属商圈不能为空' };
    if (!districts.some((d) => d.name === s.district)) return { error: `所属商圈「${s.district}」不存在，请先在商圈管理中建档` };
    if (s.lng === null || s.lat === null) return { error: '经纬度须为数字（可留空）' };
    if (s.openedAt && !/^\d{4}-\d{2}-\d{2}$/.test(s.openedAt)) return { error: '入驻时间格式须为 YYYY-MM-DD（可留空）' };
    if (s.area && !/^\d+(\.\d+)?$/.test(s.area)) return { error: '营业面积须为数字（单位㎡，可留空）' };
    return { value: s };
  }

  if (urlPath === '/api/admin/stores' && req.method === 'GET') {
    const ctx = requireAdmin(req, res, 'viewer');
    if (!ctx) return;
    const q = queryOf(req);
    let list = readJsonSafe(STORES_FILE, []);
    if (q.district) list = list.filter((s) => s.district === q.district);
    if (q.status) list = list.filter((s) => s.status === q.status);
    if (q.q) {
      const kw = q.q.toLowerCase();
      list = list.filter((s) => [s.name, s.industry, s.address].some((f) => (f || '').toLowerCase().includes(kw)));
    }
    const p = paginate(list, q);
    sendJson(res, 200, Object.assign({ ok: true }, p));
    return;
  }

  if (urlPath === '/api/admin/stores' && req.method === 'POST') {
    const ctx = requireAdmin(req, res, 'operator');
    if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const districts = readJsonSafe(DISTRICTS_FILE, []);
    const parsed = readStoreBody(body, districts);
    if (parsed.error) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    const list = readJsonSafe(STORES_FILE, []);
    if (list.some((s) => s.name === parsed.value.name)) { sendJson(res, 409, { ok: false, error: '门店名称已存在' }); return; }
    const s = Object.assign({ code: nextId(list, 'S', 'code') }, parsed.value, { createdAt: nowIso(), updatedAt: nowIso() });
    list.push(s);
    writeJsonSafe(STORES_FILE, list);
    sendJson(res, 200, { ok: true, code: s.code });
    return;
  }

  if (urlPath === '/api/admin/stores/import' && req.method === 'POST') {
    const ctx = requireAdmin(req, res, 'operator');
    if (!ctx) return;
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
    if (!rows.length) { sendJson(res, 400, { ok: false, error: '没有可导入的数据行' }); return; }
    const districts = readJsonSafe(DISTRICTS_FILE, []);
    const list = readJsonSafe(STORES_FILE, []);
    let inserted = 0;
    const errors = [];
    rows.forEach((r, i) => {
      const parsed = readStoreBody(r, districts);
      const line = `第${i + 1}行`;
      if (parsed.error) { errors.push(`${line}:${parsed.error}`); return; }
      if (list.some((s) => s.name === parsed.value.name)) { errors.push(`${line}:门店「${parsed.value.name}」已存在,跳过`); return; }
      list.push(Object.assign({ code: nextId(list, 'S', 'code') }, parsed.value, { createdAt: nowIso(), updatedAt: nowIso() }));
      inserted++;
    });
    writeJsonSafe(STORES_FILE, list);
    sendJson(res, 200, { ok: true, inserted, skipped: rows.length - inserted, errors: errors.slice(0, 20) });
    return;
  }

  if (urlPath === '/api/admin/stores/export' && req.method === 'GET') {
    const ctx = requireAdmin(req, res, 'viewer');
    if (!ctx) return;
    const q = queryOf(req);
    let list = readJsonSafe(STORES_FILE, []);
    if (q.district) list = list.filter((s) => s.district === q.district);
    const csv = toCsv([
      ['门店编号', (s) => s.code], ['门店名称', (s) => s.name], ['所属商圈', (s) => s.district],
      ['详细地址', (s) => s.address], ['经度', (s) => s.lng], ['纬度', (s) => s.lat],
      ['营业状态', (s) => s.status], ['营业面积(㎡)', (s) => s.area], ['业态类型', (s) => s.industry],
      ['入驻时间', (s) => s.openedAt], ['备注', (s) => s.remark]
    ], list);
    sendCsv(res, '门店信息.csv', csv);
    return;
  }

  const storeMatch = urlPath.match(/^\/api\/admin\/stores\/([^/]+)$/);
  if (storeMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const ctx = requireAdmin(req, res, 'operator');
    if (!ctx) return;
    const code = decodeURIComponent(storeMatch[1]);
    const list = readJsonSafe(STORES_FILE, []);
    const s = list.find((x) => x.code === code);
    if (!s) { sendJson(res, 404, { ok: false, error: '门店不存在: ' + code }); return; }
    if (req.method === 'DELETE') {
      writeJsonSafe(STORES_FILE, list.filter((x) => x.code !== code));
      sendJson(res, 200, { ok: true });
      return;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const districts = readJsonSafe(DISTRICTS_FILE, []);
    const parsed = readStoreBody(body, districts);
    if (parsed.error) { sendJson(res, 400, { ok: false, error: parsed.error }); return; }
    if (list.some((x) => x.code !== code && x.name === parsed.value.name)) { sendJson(res, 409, { ok: false, error: '门店名称已存在' }); return; }
    Object.assign(s, parsed.value, { updatedAt: nowIso() });
    writeJsonSafe(STORES_FILE, list);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET') { serveStatic(req, res, req.url); return; }
  res.writeHead(405); res.end('Method Not Allowed');
});

ensureAdminAccounts();
ensureDemoAccounts();
server.listen(PORT, HOST, () => {
  console.log(`[store-insight] listening on http://${HOST}:${PORT}`);
  console.log(`[store-insight] PAT configured: ${Boolean(COZE_PAT)}, workflow: ${WORKFLOW_ID || '(missing)'}`);
});
