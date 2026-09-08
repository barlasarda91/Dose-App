// Dose Hub — the roastery-side service. Holds the coffee catalog and price
// rules, receives orders from client shops (per-shop API keys), sends receipt
// and confirmation emails, and serves the roastery dashboard: orders inbox,
// shops, catalog, and patterns.
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const { BAG_LBS, isRetail, catalogForShop, priceOrderItems } = require('./pricing');

const app = express();
app.set('trust proxy', 1); // Railway proxy — needed for req.protocol/req.ip
app.use(express.json());

const dbPath = process.env.HUB_DB_PATH || '/app/data/hub.db';
require('fs').mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

const CURRENCY = process.env.HUB_CURRENCY || '$';

db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    email TEXT,
    api_key_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    notes TEXT,
    price_per_lb REAL NOT NULL DEFAULT 0,
    retail_price REAL,
    badge TEXT DEFAULT '',
    low_stock INTEGER DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'standard' CHECK(visibility IN ('standard','exclusive')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS roast_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_type TEXT NOT NULL CHECK(period_type IN ('week','month')),
    period TEXT NOT NULL,
    shop_id INTEGER NOT NULL,
    shop_name TEXT NOT NULL,
    coffee_name TEXT NOT NULL,
    roast TEXT NOT NULL,
    lbs REAL NOT NULL,
    cost REAL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(period_type, period, shop_id, coffee_name, roast)
  );

  CREATE TABLE IF NOT EXISTS catalog_visibility (
    coffee_id INTEGER NOT NULL REFERENCES catalog(id),
    shop_id INTEGER NOT NULL REFERENCES shops(id),
    PRIMARY KEY (coffee_id, shop_id)
  );

  CREATE TABLE IF NOT EXISTS price_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL REFERENCES shops(id),
    coffee_id INTEGER REFERENCES catalog(id),
    rule_type TEXT NOT NULL CHECK(rule_type IN ('amount_off','percent_off','override')),
    value REAL NOT NULL DEFAULT 0
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_unique ON price_rules(shop_id, IFNULL(coffee_id, 0));

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL REFERENCES shops(id),
    order_date TEXT NOT NULL,
    requested_date TEXT,
    espresso_lbs REAL DEFAULT 0,
    drip_lbs REAL DEFAULT 0,
    coldbrew_lbs REAL DEFAULT 0,
    pourover_lbs REAL DEFAULT 0,
    total_lbs REAL DEFAULT 0,
    total_cost REAL,
    notes TEXT,
    placed_by TEXT,
    source_order_id INTEGER,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','confirmed','shipped','delivered')),
    received_at TEXT DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_dedupe ON orders(shop_id, source_order_id);

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    coffee_id INTEGER,
    coffee_name TEXT NOT NULL,
    roast TEXT NOT NULL CHECK(roast IN ('espresso','filter','retail','retail_espresso','retail_filter')),
    lbs REAL NOT NULL,
    bags INTEGER,
    price_per_lb REAL NOT NULL,
    line_total REAL NOT NULL,
    roasted INTEGER DEFAULT 0,
    roasted_at TEXT,
    packed INTEGER DEFAULT 0,
    packed_at TEXT
  );

  -- What one roast batch is, per roast profile: green weight in, roasted
  -- weight out. coffee_id 0 holds the roastery-wide defaults; other rows are
  -- per-coffee overrides.
  CREATE TABLE IF NOT EXISTS roast_math (
    coffee_id INTEGER NOT NULL DEFAULT 0,
    profile TEXT NOT NULL CHECK(profile IN ('espresso','filter')),
    green_in REAL NOT NULL,
    roasted_out REAL NOT NULL,
    PRIMARY KEY (coffee_id, profile)
  );

  -- Roasted coffee sitting at the roastery ("On Hand"), as a movements
  -- ledger: batches add, order fills and manual adjustments subtract.
  -- Current stock per coffee x profile = SUM(delta_lbs).
  CREATE TABLE IF NOT EXISTS stock_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coffee_id INTEGER NOT NULL,
    coffee_name TEXT NOT NULL,
    profile TEXT NOT NULL CHECK(profile IN ('espresso','filter')),
    delta_lbs REAL NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hub_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('owner','staff')),
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    last_active_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT DEFAULT (datetime('now')),
    username TEXT NOT NULL,
    action TEXT NOT NULL
  );
`);

// Databases created before this version predate some columns.
try { db.exec('ALTER TABLE shops ADD COLUMN email TEXT'); } catch { /* present */ }
// Sessions predate named accounts — old tokens carry no user and stop working.
try { db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER'); } catch { /* present */ }
try { db.exec('ALTER TABLE hub_users ADD COLUMN email TEXT'); } catch { /* present */ }
try { db.exec('ALTER TABLE stock_moves ADD COLUMN created_by TEXT'); } catch { /* present */ }
for (const col of ['confirmed_by TEXT', 'confirmed_at TEXT', 'shipped_by TEXT', 'shipped_at TEXT']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* present */ }
}
for (const col of ['login_username TEXT', 'password_hash TEXT', 'salt TEXT', 'invite_token_hash TEXT', 'invite_expires_at TEXT']) {
  try { db.exec(`ALTER TABLE shops ADD COLUMN ${col}`); } catch { /* present */ }
}
for (const col of ['requested_date TEXT', 'total_lbs REAL DEFAULT 0', 'total_cost REAL']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* present */ }
}
try { db.exec('ALTER TABLE catalog ADD COLUMN retail_price REAL'); } catch { /* present */ }
for (const col of ['bags INTEGER', 'roasted INTEGER DEFAULT 0', 'roasted_at TEXT', 'packed INTEGER DEFAULT 0', 'packed_at TEXT']) {
  try { db.exec(`ALTER TABLE order_items ADD COLUMN ${col}`); } catch { /* present */ }
}

// Widen CHECK constraints from earlier versions (SQLite requires a rebuild).
function rebuildTable(table, needle, createSql, columns) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!row || row.sql.includes(needle)) return;
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_migr`);
  db.exec(createSql);
  db.exec(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table}_migr`);
  db.exec(`DROP TABLE ${table}_migr`);
  console.log(`Migrated ${table} schema`);
}
rebuildTable('orders', "'shipped'", `CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  order_date TEXT NOT NULL,
  requested_date TEXT,
  espresso_lbs REAL DEFAULT 0, drip_lbs REAL DEFAULT 0, coldbrew_lbs REAL DEFAULT 0, pourover_lbs REAL DEFAULT 0,
  total_lbs REAL DEFAULT 0, total_cost REAL,
  notes TEXT, placed_by TEXT, source_order_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','confirmed','shipped','delivered')),
  received_at TEXT DEFAULT (datetime('now'))
)`, 'id, shop_id, order_date, requested_date, espresso_lbs, drip_lbs, coldbrew_lbs, pourover_lbs, total_lbs, total_cost, notes, placed_by, source_order_id, status, received_at');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_dedupe ON orders(shop_id, source_order_id)');
rebuildTable('order_items', "'retail_espresso'", `CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  coffee_id INTEGER,
  coffee_name TEXT NOT NULL,
  roast TEXT NOT NULL CHECK(roast IN ('espresso','filter','retail','retail_espresso','retail_filter')),
  lbs REAL NOT NULL,
  bags INTEGER,
  price_per_lb REAL NOT NULL,
  line_total REAL NOT NULL,
  roasted INTEGER DEFAULT 0,
  roasted_at TEXT,
  packed INTEGER DEFAULT 0,
  packed_at TEXT
)`, 'id, order_id, coffee_id, coffee_name, roast, lbs, bags, price_per_lb, line_total, roasted, roasted_at, packed, packed_at');

// Seed the roastery-wide batch defaults once (55 lbs green → ~47.5/48 out).
db.prepare("INSERT OR IGNORE INTO roast_math (coffee_id, profile, green_in, roasted_out) VALUES (0,'espresso',55,47.5)").run();
db.prepare("INSERT OR IGNORE INTO roast_math (coffee_id, profile, green_in, roasted_out) VALUES (0,'filter',55,48)").run();

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const SESSION_DAYS = 30;
const money = v => `${CURRENCY}${(Math.round(v * 100) / 100).toFixed(2)}`;

// ─── Shop login credentials ──────────────────────────────────────────────────
// The hub is the identity provider for shop apps: each shop has a login
// username (derived from its name), an email, and a password. Shop
// deployments verify logins against /api/ingest/auth using their API key.
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);
const SHOP_PASSWORD_MIN = 8;

async function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = await scryptAsync(String(password), salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function verifyShopPassword(shop, password) {
  if (!shop.password_hash || !shop.salt) return false;
  const { hash } = await hashPassword(password, shop.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(shop.password_hash, 'hex'));
}

// "Boxx Kadıköy" → "boxx-kadikoy", made unique.
function genLoginUsername(name) {
  let base = String(name).toLowerCase()
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (base.length < 3) base = ('shop-' + base).replace(/-$/, '');
  let candidate = base, n = 2;
  while (db.prepare('SELECT 1 FROM shops WHERE login_username=?').get(candidate)) candidate = `${base}-${n++}`;
  return candidate;
}

// Env values pasted into dashboards often pick up stray whitespace or
// wrapping quotes — normalize before use.
function cleanEnv(v) {
  let s = String(v || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  return s;
}
const RESEND_KEY = cleanEnv(process.env.RESEND_API_KEY);

// Boot + live diagnostics: which optional config the running process actually
// has (booleans and lengths only — never values).
function storageIsPersistent() {
  try {
    const mounts = require('fs').readFileSync('/proc/self/mounts', 'utf8')
      .split('\n').map(l => l.split(' ')[1]).filter(Boolean);
    const dir = path.dirname(dbPath);
    return mounts.some(m => m !== '/' && (dir === m || dir.startsWith(m + '/')));
  } catch { return null; }
}

const configReport = () => ({
  ok: true,
  storage_persistent: process.env.NODE_ENV === 'production' ? storageIsPersistent() : true,
  email_configured: !!RESEND_KEY,
  email_key_length: RESEND_KEY.length, // Resend keys are ~36 chars — a short value means a truncated paste
  email_from_set: !!cleanEnv(process.env.HUB_EMAIL_FROM),
  reply_to_set: !!cleanEnv(process.env.HUB_REPLY_TO),
  notify_email_set: !!cleanEnv(process.env.HUB_NOTIFY_EMAIL),
  password_set: !!process.env.HUB_PASSWORD,
  currency: CURRENCY,
});
console.log('Hub config:', JSON.stringify(configReport()));

// ─── Nightly backups ─────────────────────────────────────────────────────────
// One snapshot per LA calendar day on the hub's own volume, newest
// BACKUP_KEEP retained. db.backup() is SQLite's online backup — safe live.
const fsb = require('fs');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
const BACKUP_KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP, 10) || 14);
const BACKUP_RE = /^hub-\d{4}-\d{2}-\d{2}\.db$/;
const backupToday = () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.HUB_TZ || 'America/Los_Angeles' });

function listBackups() {
  try { return fsb.readdirSync(BACKUP_DIR).filter(f => BACKUP_RE.test(f)).sort(); } catch { return []; }
}

async function runBackup({ force = false } = {}) {
  fsb.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `hub-${backupToday()}.db`);
  if (!force && fsb.existsSync(target)) return { written: false, file: path.basename(target) };
  const tmp = target + '.tmp';
  await db.backup(tmp);
  fsb.renameSync(tmp, target); // appear atomically — a download never sees a half-written file
  const files = listBackups();
  for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) fsb.unlinkSync(path.join(BACKUP_DIR, f));
  console.log(`Backup written: ${target}`);
  return { written: true, file: path.basename(target) };
}

const backupTick = () => runBackup().catch(err => console.error('BACKUP FAILED:', err.message));
backupTick();
setInterval(backupTick, 60 * 60 * 1000).unref();

function backupStatus() {
  const files = listBackups();
  if (!files.length) return { count: 0, last: null, age_hours: null };
  const last = files[files.length - 1];
  const st = fsb.statSync(path.join(BACKUP_DIR, last));
  return { count: files.length, last, age_hours: Math.round((Date.now() - st.mtimeMs) / 36e5 * 10) / 10 };
}

app.get('/api/health', async (req, res) => {
  const report = configReport();
  report.backup = backupStatus();
  report.named_accounts = hubUsersExist();
  // /api/health?probe=email — ask Resend directly whether the configured key
  // is accepted (no email is sent).
  if (req.query.probe === 'email' && RESEND_KEY) {
    try {
      const r = await fetch('https://api.resend.com/domains', { headers: { 'Authorization': `Bearer ${RESEND_KEY}` } });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        report.email_probe = { status: r.status, message: 'ok — Resend accepts this key (full access)', domains: (body.data || []).map(d => `${d.name}: ${d.status}`) };
      } else if (/restricted to only send/i.test(body.message || '')) {
        // Sending-only keys can't list domains but CAN send — that's a pass.
        report.email_probe = { status: 200, message: 'ok — Resend accepts this key (sending-only; domain list not visible to it)' };
      } else {
        report.email_probe = { status: r.status, message: body.message || 'error' };
      }
    } catch (e) {
      report.email_probe = { status: 0, message: `Could not reach Resend: ${e.message}` };
    }
  }
  res.json(report);
});

// ─── Roastery auth (named accounts; HUB_PASSWORD bootstraps the first owner) ──
const HUB_PASSWORD = process.env.HUB_PASSWORD || '';

function safeEqual(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest()
  );
}

const hubUsersExist = () => db.prepare('SELECT COUNT(*) c FROM hub_users').get().c > 0;
if (!hubUsersExist() && !HUB_PASSWORD) {
  console.warn('WARNING: no hub accounts exist and HUB_PASSWORD is not set — the first owner account cannot be created until it is.');
}

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 10;

function hubHashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(pw), salt, 64, (err, dk) => err ? reject(err) : resolve(salt.toString('hex') + ':' + dk.toString('hex')));
  });
}
function hubVerifyPassword(pw, stored) {
  return new Promise((resolve, reject) => {
    const [saltHex, hashHex] = String(stored || '').split(':');
    if (!saltHex || !hashHex) return resolve(false);
    crypto.scrypt(String(pw), Buffer.from(saltHex, 'hex'), 64, (err, dk) => {
      if (err) return reject(err);
      const want = Buffer.from(hashHex, 'hex');
      resolve(want.length === dk.length && crypto.timingSafeEqual(want, dk));
    });
  });
}

// Append-only trail of everything consequential, signed by whoever did it.
function audit(req, action) {
  try {
    db.prepare('INSERT INTO audit_log (username, action) VALUES (?, ?)')
      .run((req.hubUser && req.hubUser.username) || 'system', String(action).slice(0, 400));
  } catch (err) { console.error('audit failed:', err.message); }
}

function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .run(sha256(token), userId);
  return token;
}

function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at IS NULL OR expires_at <= datetime('now')").run();
}
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();

const loginFailures = new Map();
const LOCK_AFTER = 5;
function lockedFor(key) {
  const e = loginFailures.get(key);
  if (!e || e.count < LOCK_AFTER) return 0;
  return Math.max(0, Math.ceil((e.until - Date.now()) / 1000));
}
function recordFailure(key) {
  const e = loginFailures.get(key) || { count: 0, until: 0 };
  e.count += 1;
  if (e.count >= LOCK_AFTER) e.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (e.count - LOCK_AFTER));
  loginFailures.set(key, e);
}

// Public: tells the login screen whether this hub still needs its first owner.
app.get('/api/auth-mode', (req, res) => res.json({ setup_required: !hubUsersExist() }));

// First run only: HUB_PASSWORD acts as the one-time bootstrap code to create
// the first owner account, then never logs anyone in again.
app.post('/api/setup-owner', async (req, res) => {
  try {
    if (hubUsersExist()) return res.status(400).json({ error: 'Already set up — log in with your account' });
    if (!HUB_PASSWORD) return res.status(503).json({ error: 'HUB_PASSWORD is not set on the server — it is needed once, as the bootstrap code' });
    const { username, password, bootstrap_password } = req.body || {};
    const key = `ip:${req.ip}`;
    const wait = lockedFor(key);
    if (wait > 0) return res.status(429).json({ error: `Too many attempts — try again in ${wait}s` });
    if (!safeEqual(bootstrap_password || '', HUB_PASSWORD)) {
      recordFailure(key);
      return res.status(403).json({ error: 'Wrong bootstrap code (the HUB_PASSWORD value on the server)' });
    }
    const uname = String(username || '').trim().toLowerCase();
    const mail = String((req.body || {}).email || '').trim().toLowerCase();
    if (!USERNAME_RE.test(uname)) return res.status(400).json({ error: 'Username: 3–32 chars, lowercase letters/numbers/._- only' });
    if (mail && !EMAIL_RE.test(mail)) return res.status(400).json({ error: 'That email does not look valid' });
    if (String(password || '').length < PASSWORD_MIN) return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters` });
    const hash = await hubHashPassword(password);
    const r = db.prepare('INSERT INTO hub_users (username, email, password_hash, role) VALUES (?, ?, ?, ?)').run(uname, mail || null, hash, 'owner');
    loginFailures.delete(key);
    db.prepare('INSERT INTO audit_log (username, action) VALUES (?, ?)').run(uname, 'created the first owner account (bootstrap)');
    res.json({ ok: true, token: issueToken(r.lastInsertRowid), user: { username: uname, role: 'owner' }, must_change_password: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    if (!hubUsersExist()) return res.status(409).json({ error: 'Setup required', setup_required: true });
    const { username, password } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    const ipKey = `ip:${req.ip}`;
    const userKey = `u:${uname}`;
    const wait = Math.max(lockedFor(ipKey), lockedFor(userKey));
    if (wait > 0) return res.status(429).json({ error: `Too many attempts — try again in ${wait}s` });
    const user = db.prepare('SELECT * FROM hub_users WHERE username=? AND active=1').get(uname);
    const okPw = user ? await hubVerifyPassword(password || '', user.password_hash) : (await hubHashPassword('timing-equalizer'), false);
    if (!okPw) {
      recordFailure(ipKey); recordFailure(userKey);
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    loginFailures.delete(ipKey); loginFailures.delete(userKey);
    db.prepare("UPDATE hub_users SET last_active_at=datetime('now') WHERE id=?").run(user.id);
    res.json({ ok: true, token: issueToken(user.id), user: { username: user.username, role: user.role }, must_change_password: !!user.must_change_password });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Email (Resend) ───────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const apiKey = RESEND_KEY;
  if (!apiKey) return { sent: false, reason: 'RESEND_API_KEY not set on the hub' };
  if (!to) return { sent: false, reason: 'No recipient email registered for this shop' };
  const from = cleanEnv(process.env.HUB_EMAIL_FROM) || 'Dose Hub <onboarding@resend.dev>';
  // The from-address must live on the verified sending domain (e.g.
  // order@send.boxxcoffee.com), which usually isn't a real inbox — replies
  // route to HUB_REPLY_TO (e.g. order@boxxcoffee.com) when set.
  const replyTo = cleanEnv(process.env.HUB_REPLY_TO);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, ...(replyTo ? { reply_to: [replyTo] } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, reason: data.message || `Email provider error (${res.status})` };
    return { sent: true, to };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// Email palette (mirrors the app's tokens — emails can't use CSS variables)
const EM = { ink: '#1A1916', parch: '#F5EFE3', linen: '#DDD6CC', drift: '#7A7268', graphite: '#3D3A34', olive: '#6B6E4A', mute: '#B8AFA3' };

const EMAIL_STAGES = ['Received', 'Confirmed', 'Roasted', 'Shipped'];

// The stage an order is really at — used by the Updated email so the progress
// line reflects truth rather than the email's own occasion.
function orderStage(order, items) {
  if (order.status === 'shipped' || order.status === 'delivered') return 'Shipped';
  if (items && items.length && items.every(i => i.roasted)) return 'Roasted';
  if (order.status === 'confirmed') return 'Confirmed';
  return 'Received';
}

// Received → Confirmed → Roasted → Shipped, as a table (email clients choke
// on flexbox). Olive dots for done stages, current stage bolded.
function emailProgressLine(stage) {
  const idx = EMAIL_STAGES.indexOf(stage);
  if (idx === -1) return '';
  const cells = EMAIL_STAGES.map((s, i) => {
    const done = i <= idx;
    return `<td align="center" style="padding:0;width:25%;">
      <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${done ? EM.olive : EM.linen};"></span><br>
      <span style="font-family:monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:${i === idx ? EM.olive : done ? EM.graphite : EM.mute};${i === idx ? 'font-weight:bold;' : ''}">${s}</span>
    </td>`;
  }).join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#EDE6D8;border-bottom:1px solid ${EM.linen};">
    <tr><td style="padding:12px 26px 3px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>
    </td></tr><tr><td style="height:10px;"></td></tr></table>`;
}

// Typographic wordmark rather than an image: most clients block remote images
// until the reader opts in, so an image-led header would arrive broken.
function emailHeader(headline, shopLine, accent) {
  return `<div style="background:${accent || EM.ink};padding:20px 26px 18px;">
      <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:0.06em;color:${EM.parch};">BOXX</div>
      <div style="font-family:monospace;font-size:9px;color:${EM.mute};letter-spacing:0.3em;text-transform:uppercase;margin-top:1px;">Coffee Roasters Co.</div>
      <div style="font-family:Georgia,serif;font-size:17px;color:${EM.parch};margin-top:14px;border-top:1px solid rgba(245,239,227,0.25);padding-top:12px;">${esc(headline)}</div>
      <div style="font-family:monospace;font-size:11px;color:${EM.mute};letter-spacing:0.14em;text-transform:uppercase;margin-top:5px;">${shopLine}</div>
    </div>`;
}

// opts: { stage: 'Received'|'Confirmed'|'Roasted'|'Shipped' (progress line;
// omit for non-status emails), accent: header color override }
function orderEmailHtml(order, items, shop, headline, sub, opts = {}) {
  const roastLabel = r =>
    r === 'espresso' ? 'Espresso Roast' : r === 'filter' ? 'Filter Roast'
    : r === 'retail_espresso' ? '12oz Bags — Espresso Roast'
    : r === 'retail_filter' ? '12oz Bags — Filter Roast' : '12oz Retail Bags';
  const qtyLabel = i => isRetail(i.roast) ? `${i.bags} bags` : `${i.lbs} lbs`;
  const unitLabel = i => isRetail(i.roast) ? `${money(i.price_per_lb)}/bag` : `${money(i.price_per_lb)}/lb`;
  const rows = items.length
    ? items.map(i =>
      `<tr>
        <td style="padding:9px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:12px;color:#3D3A34;">${esc(i.coffee_name)}<br><span style="font-size:10px;color:#7A7268;">${roastLabel(i.roast)}</span></td>
        <td style="padding:9px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:12px;color:#1A1916;text-align:right;">${qtyLabel(i)}</td>
        <td style="padding:9px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:12px;color:#7A7268;text-align:right;">${unitLabel(i)}</td>
        <td style="padding:9px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:12px;color:#1A1916;text-align:right;">${money(i.line_total)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" style="padding:9px 14px;font-family:monospace;font-size:12px;color:#3D3A34;">
        ${['espresso_lbs', 'drip_lbs', 'coldbrew_lbs', 'pourover_lbs'].filter(f => order[f] > 0).map(f => `${f.replace('_lbs', '')}: ${order[f]} lbs`).join(' · ')}
      </td></tr>`;
  const shopLine = `${esc(shop.name)} · placed ${esc(order.order_date)}${order.requested_date ? ` · requested ${esc(order.requested_date)}` : ''}`;
  return `
  <div style="max-width:560px;margin:0 auto;background:#F5EFE3;border:1px solid #DDD6CC;">
    ${emailHeader(headline, shopLine, opts.accent)}
    ${opts.stage ? emailProgressLine(opts.stage) : ''}
    ${sub ? `<div style="padding:14px 26px;font-family:monospace;font-size:12px;color:#3D3A34;line-height:1.7;border-bottom:1px solid #DDD6CC;">${esc(sub)}</div>` : ''}
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        ${['Coffee', 'Qty', 'Price', 'Total'].map((h, i) => `<th style="padding:9px 14px;background:#DDD6CC;font-family:monospace;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#7A7268;text-align:${i ? 'right' : 'left'};">${h}</th>`).join('')}
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td style="padding:11px 14px;font-family:monospace;font-size:12px;color:#1A1916;background:#DDD6CC;">Total</td>
        <td style="padding:11px 14px;font-family:monospace;font-size:12px;color:#1A1916;background:#DDD6CC;text-align:right;">${order.total_lbs} lbs</td>
        <td style="background:#DDD6CC;"></td>
        <td style="padding:11px 14px;font-family:monospace;font-size:12px;color:#1A1916;background:#DDD6CC;text-align:right;">${order.total_cost != null ? money(order.total_cost) : '—'}</td>
      </tr></tfoot>
    </table>
    ${order.notes ? `<div style="padding:14px 26px;font-family:monospace;font-size:12px;color:#3D3A34;">Notes: ${esc(order.notes)}</div>` : ''}
    <div style="padding:14px 26px;font-family:monospace;font-size:10px;color:#7A7268;border-top:1px solid #DDD6CC;line-height:1.7;">
      Dose Hub · Boxx Coffee Roasters Co. · Los Angeles, CA<br>
      Questions about this order? Just reply to this email.
    </div>
  </div>`;
}

// ─── Shop ingest (per-shop API key) — before the dashboard gate ──────────────
function shopFromBearer(req) {
  const auth = req.get('authorization') || '';
  const apiKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return apiKey ? db.prepare('SELECT * FROM shops WHERE api_key_hash=?').get(sha256(apiKey)) : null;
}

function shopCatalog(shopId) {
  const items = db.prepare('SELECT * FROM catalog').all();
  const grants = db.prepare('SELECT * FROM catalog_visibility').all();
  const rules = db.prepare('SELECT * FROM price_rules').all();
  return catalogForShop(items, shopId, grants, rules);
}

app.get('/api/ingest/catalog', (req, res) => {
  const shop = shopFromBearer(req);
  if (!shop) return res.status(401).json({ error: 'Invalid shop API key' });
  res.json({ currency: CURRENCY, shop_name: shop.name, items: shopCatalog(shop.id) });
});

app.post('/api/ingest/orders', async (req, res) => {
  try {
    const shop = shopFromBearer(req);
    if (!shop) return res.status(401).json({ error: 'Invalid shop API key' });

    const b = req.body || {};
    if (!b.order_date) return res.status(400).json({ error: 'order_date required' });

    let priced = null;
    const legacyQty = {};
    if (Array.isArray(b.items) && b.items.length) {
      // Catalog order: hub validates visibility and computes prices itself.
      try { priced = priceOrderItems(b.items, shopCatalog(shop.id)); }
      catch (err) { return res.status(400).json({ error: err.message }); }
    } else {
      // Legacy pool-based order.
      for (const k of ['espresso_lbs', 'drip_lbs', 'coldbrew_lbs', 'pourover_lbs']) legacyQty[k] = Math.max(0, parseFloat(b[k]) || 0);
      if (Object.values(legacyQty).every(v => v === 0)) return res.status(400).json({ error: 'Order has no quantities' });
    }

    const totalLbs = priced ? priced.total_lbs
      : Math.round(Object.values(legacyQty).reduce((s, v) => s + v, 0) * 10) / 10;

    let orderId;
    try {
      const r = db.prepare(`INSERT INTO orders
        (shop_id, order_date, requested_date, espresso_lbs, drip_lbs, coldbrew_lbs, pourover_lbs, total_lbs, total_cost, notes, placed_by, source_order_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(shop.id, String(b.order_date),
          b.requested_date ? String(b.requested_date) : null,
          legacyQty.espresso_lbs || 0, legacyQty.drip_lbs || 0, legacyQty.coldbrew_lbs || 0, legacyQty.pourover_lbs || 0,
          totalLbs, priced ? priced.total_cost : null,
          b.notes ? String(b.notes).slice(0, 500) : null,
          b.placed_by ? String(b.placed_by).slice(0, 64) : null,
          b.source_order_id != null ? parseInt(b.source_order_id, 10) : null);
      orderId = r.lastInsertRowid;
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.json({ ok: true, duplicate: true });
      throw err;
    }

    if (priced) {
      const ins = db.prepare('INSERT INTO order_items (order_id, coffee_id, coffee_name, roast, lbs, bags, price_per_lb, line_total) VALUES (?,?,?,?,?,?,?,?)');
      for (const i of priced.items) ins.run(orderId, i.coffee_id, i.coffee_name, i.roast, i.lbs, i.bags ?? null, i.price_per_lb, i.line_total);
    }

    // Receipt email to the shop's registered address; copy to the roastery.
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
    const receipt = await sendEmail(shop.email, `Order received — ${shop.name} — ${order.order_date}`,
      orderEmailHtml(order, items, shop, 'Order Received', 'Your order has been received by the roastery. You will get another email when it is confirmed.', { stage: 'Received' }));
    if (process.env.HUB_NOTIFY_EMAIL) {
      await sendEmail(process.env.HUB_NOTIFY_EMAIL, `New order — ${shop.name} — ${order.order_date}`,
        orderEmailHtml(order, items, shop, 'New Order', null));
    }

    res.json({ ok: true, hub_order_id: orderId, total_lbs: totalLbs, total_cost: priced ? priced.total_cost : null, receipt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Shop deployments verify user logins here. Rate-limited per shop+username.
// 409 no_login_password lets pre-upgrade deployments fall back to their
// local accounts until a password is set in the hub.
app.post('/api/ingest/auth', async (req, res) => {
  try {
    const shop = shopFromBearer(req);
    if (!shop) return res.status(401).json({ error: 'Invalid shop API key' });
    const username = String((req.body && req.body.username) || '').toLowerCase().trim();
    const password = (req.body && req.body.password) || '';
    const lockKey = `shopauth:${shop.id}:${username}`;
    const wait = lockedFor(lockKey);
    if (wait > 0) return res.status(429).json({ error: `Too many attempts — try again in ${wait}s` });
    if (!shop.password_hash) return res.status(409).json({ error: 'no_login_password' });
    if (username !== (shop.login_username || '') || !(await verifyShopPassword(shop, password))) {
      recordFailure(lockKey);
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    loginFailures.delete(lockKey);
    res.json({ ok: true, username: shop.login_username, role: 'admin', shop_name: shop.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Shop users change their hub-managed password from inside the shop app.
app.post('/api/ingest/change-password', async (req, res) => {
  try {
    const shop = shopFromBearer(req);
    if (!shop) return res.status(401).json({ error: 'Invalid shop API key' });
    const { username, current_password, new_password } = req.body || {};
    if (String(username || '').toLowerCase().trim() !== (shop.login_username || '') ||
        !(await verifyShopPassword(shop, current_password || ''))) {
      return res.status(401).json({ error: 'Current password is wrong' });
    }
    if (String(new_password || '').length < SHOP_PASSWORD_MIN)
      return res.status(400).json({ error: `Password must be at least ${SHOP_PASSWORD_MIN} characters` });
    const { salt, hash } = await hashPassword(new_password);
    db.prepare('UPDATE shops SET password_hash=?, salt=? WHERE id=?').run(hash, salt, shop.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Shops poll this to reflect roastery confirmations in their order history.
app.get('/api/ingest/order-status', (req, res) => {
  const shop = shopFromBearer(req);
  if (!shop) return res.status(401).json({ error: 'Invalid shop API key' });
  const ids = String(req.query.ids || '').split(',').map(s => parseInt(s, 10)).filter(Number.isFinite).slice(0, 200);
  if (!ids.length) return res.json([]);
  const rows = db.prepare(
    `SELECT source_order_id, status FROM orders WHERE shop_id=? AND source_order_id IN (${ids.map(() => '?').join(',')})`
  ).all(shop.id, ...ids);
  res.json(rows);
});

// ─── Public invite endpoints (token-authenticated, no session) ───────────────
function shopFromInviteToken(token) {
  if (!token) return null;
  return db.prepare(
    "SELECT * FROM shops WHERE invite_token_hash=? AND invite_expires_at > datetime('now')"
  ).get(sha256(String(token)));
}

app.post('/api/public/invite-info', (req, res) => {
  const shop = shopFromInviteToken(req.body && req.body.token);
  if (!shop) return res.status(404).json({ error: 'This link is invalid or has expired — ask the roastery to send a new one.' });
  res.json({ shop_name: shop.name, login_username: shop.login_username });
});

app.post('/api/public/set-password', async (req, res) => {
  try {
    const shop = shopFromInviteToken(req.body && req.body.token);
    if (!shop) return res.status(404).json({ error: 'This link is invalid or has expired — ask the roastery to send a new one.' });
    const password = (req.body && req.body.password) || '';
    if (String(password).length < SHOP_PASSWORD_MIN)
      return res.status(400).json({ error: `Password must be at least ${SHOP_PASSWORD_MIN} characters` });
    const { salt, hash } = await hashPassword(password);
    db.prepare('UPDATE shops SET password_hash=?, salt=?, invite_token_hash=NULL, invite_expires_at=NULL WHERE id=?')
      .run(hash, salt, shop.id);
    res.json({ ok: true, login_username: shop.login_username, shop_name: shop.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard auth gate ──────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  if (['/login', '/setup-owner', '/auth-mode'].includes(req.path) || req.path.startsWith('/ingest/') || req.path.startsWith('/public/')) return next();
  const token = req.get('x-hub-key') || '';
  const row = token && db.prepare(
    `SELECT u.id, u.username, u.role, u.must_change_password
     FROM sessions s JOIN hub_users u ON u.id = s.user_id
     WHERE s.token=? AND s.expires_at > datetime('now') AND u.active=1`
  ).get(sha256(token));
  if (!row) return res.status(401).json({ error: 'Unauthorized' });
  req.hubUser = { id: row.id, username: row.username, role: row.role };
  db.prepare("UPDATE hub_users SET last_active_at=datetime('now') WHERE id=? AND (last_active_at IS NULL OR last_active_at < datetime('now','-5 minutes'))").run(row.id);
  // A temporary password only unlocks changing it to a real one.
  if (row.must_change_password && !['/me', '/me/password'].includes(req.path)) {
    return res.status(403).json({ error: 'Set your own password first', must_change_password: true });
  }
  next();
});

function requireOwner(req, res, next) {
  if (req.hubUser && req.hubUser.role === 'owner') return next();
  res.status(403).json({ error: 'Owner access required' });
}

// ─── Who am I / own password ─────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const u = db.prepare('SELECT username, role, must_change_password FROM hub_users WHERE id=?').get(req.hubUser.id);
  res.json({ username: u.username, role: u.role, must_change_password: !!u.must_change_password });
});

app.post('/api/me/password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    const u = db.prepare('SELECT * FROM hub_users WHERE id=?').get(req.hubUser.id);
    if (!(await hubVerifyPassword(current_password || '', u.password_hash)))
      return res.status(401).json({ error: 'Current password is wrong' });
    if (String(new_password || '').length < PASSWORD_MIN)
      return res.status(400).json({ error: `New password must be at least ${PASSWORD_MIN} characters` });
    const hash = await hubHashPassword(new_password);
    db.prepare('UPDATE hub_users SET password_hash=?, must_change_password=0 WHERE id=?').run(hash, u.id);
    // Other sessions (e.g. someone holding the temp password) die; this one stays.
    const keep = sha256(req.get('x-hub-key') || '');
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token != ?').run(u.id, keep);
    audit(req, 'changed their password');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Team management (owners) ────────────────────────────────────────────────
app.get('/api/team', requireOwner, (req, res) => {
  res.json(db.prepare('SELECT id, username, email, role, active, must_change_password, last_active_at, created_at FROM hub_users ORDER BY active DESC, username').all());
});

app.post('/api/team', requireOwner, async (req, res) => {
  try {
    const { username, role, temp_password, email } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    const mail = String(email || '').trim().toLowerCase();
    if (!USERNAME_RE.test(uname)) return res.status(400).json({ error: 'Username: 3–32 chars, lowercase letters/numbers/._- only' });
    if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: 'A valid email is required for every account' });
    if (db.prepare('SELECT id FROM hub_users WHERE email=?').get(mail)) return res.status(400).json({ error: 'That email is already attached to an account' });
    if (!['owner', 'staff'].includes(role)) return res.status(400).json({ error: 'Role must be owner or staff' });
    if (String(temp_password || '').length < PASSWORD_MIN) return res.status(400).json({ error: `Temporary password must be at least ${PASSWORD_MIN} characters` });
    if (db.prepare('SELECT id FROM hub_users WHERE username=?').get(uname)) return res.status(400).json({ error: 'That username is taken' });
    const hash = await hubHashPassword(temp_password);
    db.prepare('INSERT INTO hub_users (username, email, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)').run(uname, mail, hash, role);
    audit(req, `created ${role} account "${uname}" (${mail})`);
    res.json(db.prepare('SELECT id, username, email, role, active, must_change_password, last_active_at, created_at FROM hub_users WHERE username=?').get(uname));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Usernames are immutable once assigned; the attached email is fixable.
app.put('/api/team/:id/email', requireOwner, (req, res) => {
  const u = db.prepare('SELECT * FROM hub_users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'No such account' });
  const mail = String((req.body || {}).email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: 'A valid email is required' });
  const dupe = db.prepare('SELECT id FROM hub_users WHERE email=? AND id != ?').get(mail, u.id);
  if (dupe) return res.status(400).json({ error: 'That email is already attached to another account' });
  db.prepare('UPDATE hub_users SET email=? WHERE id=?').run(mail, u.id);
  audit(req, `changed the email for "${u.username}" to ${mail}`);
  res.json({ ok: true });
});

app.post('/api/team/:id/reset', requireOwner, async (req, res) => {
  try {
    const u = db.prepare('SELECT * FROM hub_users WHERE id=?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'No such account' });
    const temp = String((req.body || {}).temp_password || '');
    if (temp.length < PASSWORD_MIN) return res.status(400).json({ error: `Temporary password must be at least ${PASSWORD_MIN} characters` });
    const hash = await hubHashPassword(temp);
    db.prepare('UPDATE hub_users SET password_hash=?, must_change_password=1 WHERE id=?').run(hash, u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    audit(req, `reset the password for "${u.username}"`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/team/:id/deactivate', requireOwner, (req, res) => {
  const u = db.prepare('SELECT * FROM hub_users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'No such account' });
  if (u.id === req.hubUser.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
  const owners = db.prepare("SELECT COUNT(*) c FROM hub_users WHERE role='owner' AND active=1").get().c;
  if (u.role === 'owner' && u.active && owners <= 1) return res.status(400).json({ error: 'Cannot deactivate the last active owner' });
  db.prepare('UPDATE hub_users SET active=0 WHERE id=?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); // signed out everywhere, immediately
  audit(req, `deactivated account "${u.username}"`);
  res.json({ ok: true });
});

app.post('/api/team/:id/reactivate', requireOwner, (req, res) => {
  const u = db.prepare('SELECT * FROM hub_users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'No such account' });
  db.prepare('UPDATE hub_users SET active=1 WHERE id=?').run(u.id);
  audit(req, `reactivated account "${u.username}"`);
  res.json({ ok: true });
});

app.get('/api/activity', requireOwner, (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  res.json(db.prepare('SELECT at, username, action FROM audit_log ORDER BY id DESC LIMIT ?').all(limit));
});

// ─── Backup access (dashboard login required — registered behind the gate) ───
app.get('/api/backups', (req, res) => {
  const files = listBackups().map(f => {
    const st = fsb.statSync(path.join(BACKUP_DIR, f));
    return { file: f, bytes: st.size, modified: st.mtime.toISOString() };
  });
  res.json({ ...backupStatus(), keep: BACKUP_KEEP, files });
});

app.post('/api/backups/run', async (req, res) => {
  try { res.json(await runBackup({ force: true })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/backups/download', (req, res) => {
  const files = listBackups();
  if (!files.length) return res.status(404).json({ error: 'No backups yet' });
  const name = req.query.file && BACKUP_RE.test(req.query.file) && files.includes(req.query.file)
    ? req.query.file : files[files.length - 1];
  res.download(path.join(BACKUP_DIR, name), name);
});

// ─── Catalog management ───────────────────────────────────────────────────────
function catalogItemFull(id) {
  const item = db.prepare('SELECT * FROM catalog WHERE id=?').get(id);
  if (!item) return null;
  item.exclusive_shop_ids = db.prepare('SELECT shop_id FROM catalog_visibility WHERE coffee_id=?').all(id).map(r => r.shop_id);
  return item;
}

app.get('/api/catalog', (req, res) => {
  res.json(db.prepare('SELECT * FROM catalog ORDER BY active DESC, name').all().map(i => catalogItemFull(i.id)));
});

const BADGES = ['Blend', 'Single Origin', 'Single Farm', 'Single Lot', 'Decaf'];

function saveCatalogBody(b) {
  return {
    name: String(b.name || '').trim(),
    notes: b.notes ? String(b.notes).slice(0, 300) : null,
    price: Math.max(0, parseFloat(b.price_per_lb) || 0),
    retail: parseFloat(b.retail_price) > 0 ? Math.round(parseFloat(b.retail_price) * 100) / 100 : null,
    badge: BADGES.includes(b.badge) ? b.badge : '',
    low_stock: b.low_stock ? 1 : 0,
    visibility: b.visibility === 'exclusive' ? 'exclusive' : 'standard',
    shopIds: Array.isArray(b.exclusive_shop_ids) ? b.exclusive_shop_ids.map(n => parseInt(n, 10)).filter(Number.isFinite) : [],
    active: b.active === undefined ? 1 : (b.active ? 1 : 0),
  };
}

app.post('/api/catalog', requireOwner, (req, res) => {
  const v = saveCatalogBody(req.body || {});
  if (v.name.length < 2) return res.status(400).json({ error: 'Coffee name required' });
  const r = db.prepare('INSERT INTO catalog (name, notes, price_per_lb, retail_price, badge, low_stock, visibility, active) VALUES (?,?,?,?,?,?,?,?)')
    .run(v.name, v.notes, v.price, v.retail, v.badge, v.low_stock, v.visibility, v.active);
  const setGrants = db.prepare('INSERT INTO catalog_visibility (coffee_id, shop_id) VALUES (?,?)');
  if (v.visibility === 'exclusive') for (const sid of v.shopIds) setGrants.run(r.lastInsertRowid, sid);
  audit(req, `added catalog item "${v.name}"`);
  res.json(catalogItemFull(r.lastInsertRowid));
});

app.put('/api/catalog/:id', requireOwner, (req, res) => {
  if (!db.prepare('SELECT id FROM catalog WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = saveCatalogBody(req.body || {});
  if (v.name.length < 2) return res.status(400).json({ error: 'Coffee name required' });
  db.prepare('UPDATE catalog SET name=?, notes=?, price_per_lb=?, retail_price=?, badge=?, low_stock=?, visibility=?, active=? WHERE id=?')
    .run(v.name, v.notes, v.price, v.retail, v.badge, v.low_stock, v.visibility, v.active, req.params.id);
  db.prepare('DELETE FROM catalog_visibility WHERE coffee_id=?').run(req.params.id);
  if (v.visibility === 'exclusive') {
    const ins = db.prepare('INSERT INTO catalog_visibility (coffee_id, shop_id) VALUES (?,?)');
    for (const sid of v.shopIds) ins.run(req.params.id, sid);
  }
  audit(req, `updated catalog item "${v.name}"`);
  res.json(catalogItemFull(req.params.id));
});

// ─── Shops management ─────────────────────────────────────────────────────────
const shopWithStats = s => ({
  id: s.id, name: s.name, email: s.email, login_username: s.login_username,
  has_password: !!s.password_hash,
  invite_pending: !!(s.invite_token_hash && !s.password_hash),
  created_at: s.created_at,
  orders_count: db.prepare('SELECT COUNT(*) n FROM orders WHERE shop_id=?').get(s.id).n,
  last_order_date: db.prepare('SELECT MAX(order_date) d FROM orders WHERE shop_id=?').get(s.id).d,
});

app.get('/api/shops', (req, res) => {
  res.json(db.prepare('SELECT * FROM shops ORDER BY name').all().map(shopWithStats));
});

// ─── Invites ─────────────────────────────────────────────────────────────────
// The shop sets its OWN password via a single-use, 7-day invite link emailed
// to the registered address. If hub email isn't configured, the link is
// returned to the roastery dashboard to pass on manually.
function inviteEmailHtml(shop, link) {
  return `
  <div style="max-width:520px;margin:0 auto;background:#F5EFE3;border:1px solid #DDD6CC;">
    <div style="background:#1A1916;padding:22px 26px;">
      <div style="font-family:Georgia,serif;font-size:18px;color:#F5EFE3;">Welcome to Dose</div>
      <div style="font-family:monospace;font-size:11px;color:#B8AFA3;letter-spacing:0.14em;text-transform:uppercase;margin-top:6px;">${esc(shop.name)}</div>
    </div>
    <div style="padding:20px 26px;font-family:monospace;font-size:12px;color:#3D3A34;line-height:1.8;">
      Your roastery set up Dose for your shop. Your sign-in username is
      <strong>${esc(shop.login_username)}</strong> — click below to choose your password.
      The link works once and expires in 7 days.
    </div>
    <div style="padding:0 26px 24px;">
      <a href="${esc(link)}" style="display:inline-block;background:#1A1916;color:#F5EFE3;font-family:monospace;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;padding:12px 22px;text-decoration:none;">Set My Password</a>
    </div>
    <div style="padding:14px 26px;font-family:monospace;font-size:10px;color:#7A7268;border-top:1px solid #DDD6CC;">
      Dose Hub · Boxx Coffee Roasters Co.
    </div>
  </div>`;
}

async function createInvite(shopId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("UPDATE shops SET invite_token_hash=?, invite_expires_at=datetime('now','+7 days') WHERE id=?")
    .run(sha256(token), shopId);
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(shopId);
  const link = `${req.protocol}://${req.get('host')}/set-password?token=${token}`;
  const email = await sendEmail(shop.email, `Set your Dose password — ${shop.name}`, inviteEmailHtml(shop, link));
  return { ...email, link };
}

// Creating a shop creates its ACCOUNT: login username (from the name),
// registered email, and API key (returned once). The password is set by the
// shop itself through the invite link.
app.post('/api/shops', requireOwner, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    const email = String((req.body && req.body.email) || '').trim() || null;
    if (name.length < 2) return res.status(400).json({ error: 'Shop name required (2+ characters)' });
    if (!email) return res.status(400).json({ error: 'Registered email required — the password invite is sent there' });
    const apiKey = 'dose_' + crypto.randomBytes(24).toString('hex');
    const loginUsername = genLoginUsername(name);
    const r = db.prepare('INSERT INTO shops (name, email, api_key_hash, login_username) VALUES (?,?,?,?)')
      .run(name, email, sha256(apiKey), loginUsername);
    const invite = await createInvite(r.lastInsertRowid, req);
    audit(req, `created shop "${name}"`);
    res.json({ shop: shopWithStats(db.prepare('SELECT * FROM shops WHERE id=?').get(r.lastInsertRowid)), api_key: apiKey, invite });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(400).json({ error: 'A shop with that name already exists' });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Re-send (or hand out) a fresh invite — also how a lost password gets reset
// by the shop itself.
app.post('/api/shops/:id/invite', requireOwner, async (req, res) => {
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    if (!shop.email) return res.status(400).json({ error: 'Set a registered email for this shop first (Edit)' });
    audit(req, `sent a password invite for shop "${shop.name}"`);
    res.json({ ok: true, invite: await createInvite(shop.id, req) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Set or reset a shop's login password (also backfills the login username
// for shops created before accounts existed).
app.post('/api/shops/:id/reset-login', requireOwner, async (req, res) => {
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    const password = (req.body && req.body.new_password) || '';
    if (String(password).length < SHOP_PASSWORD_MIN)
      return res.status(400).json({ error: `Password must be at least ${SHOP_PASSWORD_MIN} characters` });
    const loginUsername = shop.login_username || genLoginUsername(shop.name);
    const { salt, hash } = await hashPassword(password);
    db.prepare('UPDATE shops SET login_username=?, password_hash=?, salt=? WHERE id=?').run(loginUsername, hash, salt, shop.id);
    audit(req, `reset the shop login for "${shop.name}"`);
    res.json({ ok: true, login_username: loginUsername });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/shops/:id', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const name = req.body.name !== undefined ? String(req.body.name).trim() : shop.name;
  const email = req.body.email !== undefined ? (String(req.body.email).trim() || null) : shop.email;
  if (name.length < 2) return res.status(400).json({ error: 'Shop name required' });
  db.prepare('UPDATE shops SET name=?, email=? WHERE id=?').run(name, email, shop.id);
  res.json(shopWithStats(db.prepare('SELECT * FROM shops WHERE id=?').get(shop.id)));
});

app.post('/api/shops/:id/rotate-key', requireOwner, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const apiKey = 'dose_' + crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE shops SET api_key_hash=? WHERE id=?').run(sha256(apiKey), shop.id);
  audit(req, `rotated the API key for shop "${shop.name}"`);
  res.json({ ok: true, api_key: apiKey });
});

// ─── Per-shop pricing rules ───────────────────────────────────────────────────
app.get('/api/shops/:id/pricing', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const rules = db.prepare('SELECT * FROM price_rules WHERE shop_id=?').all(shop.id);
  const items = db.prepare('SELECT * FROM catalog WHERE active=1 ORDER BY name').all();
  const grants = db.prepare('SELECT * FROM catalog_visibility').all();
  const effective = shopCatalog(shop.id);
  const effById = new Map(effective.map(i => [i.id, i.price_per_lb]));
  res.json({
    global_rule: rules.find(r => r.coffee_id === null) || null,
    items: items
      .filter(i => i.visibility !== 'exclusive' || grants.some(g => g.coffee_id === i.id && g.shop_id === shop.id))
      .map(i => ({
        coffee_id: i.id, name: i.name, base_price: i.price_per_lb,
        rule: rules.find(r => r.coffee_id === i.id) || null,
        effective_price: effById.get(i.id),
      })),
  });
});

// Replace-all semantics: the payload is the complete rule set for this shop.
app.put('/api/shops/:id/pricing', requireOwner, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const { global_rule, item_rules } = req.body || {};
  const valid = r => r && ['amount_off', 'percent_off', 'override'].includes(r.rule_type) && Number.isFinite(parseFloat(r.value));
  db.prepare('DELETE FROM price_rules WHERE shop_id=?').run(shop.id);
  const ins = db.prepare('INSERT INTO price_rules (shop_id, coffee_id, rule_type, value) VALUES (?,?,?,?)');
  if (valid(global_rule)) ins.run(shop.id, null, global_rule.rule_type, parseFloat(global_rule.value));
  for (const r of (Array.isArray(item_rules) ? item_rules : [])) {
    if (valid(r) && Number.isFinite(parseInt(r.coffee_id, 10))) ins.run(shop.id, parseInt(r.coffee_id, 10), r.rule_type, parseFloat(r.value));
  }
  audit(req, `changed price rules for ${shop.name}`);
  res.json({ ok: true });
});

// ─── Orders inbox ─────────────────────────────────────────────────────────────
function orderFull(o) {
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY roast, coffee_name').all(o.id);
  return o;
}

app.get('/api/orders', (req, res) => {
  const clauses = [], params = [];
  if (req.query.shop_id) { clauses.push('o.shop_id=?'); params.push(req.query.shop_id); }
  if (req.query.status)  { clauses.push('o.status=?');  params.push(req.query.status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  res.json(db.prepare(
    `SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id
     ${where} ORDER BY o.received_at DESC, o.id DESC LIMIT 500`
  ).all(...params).map(orderFull));
});

app.patch('/api/orders/:id', async (req, res) => {
  const status = (req.body && req.body.status) || '';
  if (!['new', 'confirmed', 'shipped', 'delivered'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const before = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Order not found' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, req.params.id);
  const by = req.hubUser.username;
  if (status === 'confirmed' && before.status !== 'confirmed')
    db.prepare("UPDATE orders SET confirmed_by=?, confirmed_at=datetime('now') WHERE id=?").run(by, req.params.id);
  if (status === 'shipped' && before.status !== 'shipped')
    db.prepare("UPDATE orders SET shipped_by=?, shipped_at=datetime('now') WHERE id=?").run(by, req.params.id);
  if (status !== before.status) {
    const shopName = (db.prepare('SELECT name FROM shops WHERE id=?').get(before.shop_id) || {}).name || '?';
    audit(req, `${status === 'new' ? 'reopened' : status} order #${before.id} (${shopName})`);
  }

  // Confirming and shipping each notify the shop by email.
  let email = null;
  if ((status === 'confirmed' && before.status !== 'confirmed') || (status === 'shipped' && before.status !== 'shipped')) {
    const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(before.shop_id);
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
    email = status === 'confirmed'
      ? await sendEmail(shop.email, `Order confirmed — ${shop.name} — ${order.order_date}`,
          orderEmailHtml(order, items, shop, 'Order Confirmed', 'The roastery has confirmed your order and it is being prepared.', { stage: 'Confirmed', accent: EM.olive }))
      : await sendEmail(shop.email, `Order shipped — ${shop.name} — ${order.order_date}`,
          orderEmailHtml(order, items, shop, 'Order Shipped', 'Your order is packed and on the way.', { stage: 'Shipped', accent: EM.olive }));
  }

  const updated = orderFull(db.prepare('SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=?').get(req.params.id));
  res.json({ ...updated, email });
});

// Delete an order outright — for trial/test orders that shouldn't become
// history. Removes the order and its line items; stock-ledger movements from
// already-filled lines are kept (the coffee was really roasted). The shop's
// own local log keeps its copy.
app.delete('/api/orders/:id', requireOwner, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const shopName = (db.prepare('SELECT name FROM shops WHERE id=?').get(order.shop_id) || {}).name || '?';
  db.prepare('DELETE FROM order_items WHERE order_id=?').run(order.id);
  db.prepare('DELETE FROM orders WHERE id=?').run(order.id);
  audit(req, `deleted order #${order.id} (${shopName}, ${order.total_lbs} lbs, placed ${order.order_date})`);
  res.json({ ok: true });
});

// Roaster edits an order's quantities; the shop is notified by email.
app.put('/api/orders/:id/items', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['shipped', 'delivered'].includes(order.status)) return res.status(400).json({ error: 'Order already shipped — cannot edit' });
    const edits = new Map((Array.isArray(req.body.items) ? req.body.items : []).map(e => [parseInt(e.id, 10), e]));
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
    if (!items.length) return res.status(400).json({ error: 'Legacy order has no editable line items' });

    const upd = db.prepare('UPDATE order_items SET lbs=?, bags=?, line_total=? WHERE id=?');
    const del = db.prepare('DELETE FROM order_items WHERE id=?');
    for (const item of items) {
      const e = edits.get(item.id);
      if (!e) continue;
      if (isRetail(item.roast)) {
        const bags = Math.max(0, Math.round(parseFloat(e.bags ?? e.qty) || 0));
        if (bags === 0) { del.run(item.id); continue; }
        upd.run(Math.round(bags * BAG_LBS * 100) / 100, bags, Math.round(bags * item.price_per_lb * 100) / 100, item.id);
      } else {
        const lbs = Math.max(0, Math.round((parseFloat(e.lbs ?? e.qty) || 0) * 10) / 10);
        if (lbs === 0) { del.run(item.id); continue; }
        upd.run(lbs, null, Math.round(lbs * item.price_per_lb * 100) / 100, item.id);
      }
    }
    const remaining = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
    if (!remaining.length) return res.status(400).json({ error: 'An order cannot be edited down to nothing — delete-level changes need a new order' });
    const totalLbs = Math.round(remaining.reduce((s, i) => s + i.lbs, 0) * 100) / 100;
    const totalCost = Math.round(remaining.reduce((s, i) => s + i.line_total, 0) * 100) / 100;
    db.prepare('UPDATE orders SET total_lbs=?, total_cost=? WHERE id=?').run(totalLbs, totalCost, order.id);

    const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(order.shop_id);
    audit(req, `edited order #${order.id} (${shop.name}) — now ${totalLbs} lbs / ${money(totalCost)}`);
    const updated = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
    const email = await sendEmail(shop.email, `Order updated — ${shop.name} — ${order.order_date}`,
      orderEmailHtml(updated, remaining, shop, 'Order Updated', 'The roastery adjusted your order — here is the updated summary.', { stage: orderStage(updated, remaining) }));

    res.json({ ...orderFull(db.prepare('SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=?').get(order.id)), email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Roast Program ────────────────────────────────────────────────────────────
// Confirmed orders' UNROASTED items, aggregated per COFFEE × ROAST PROFILE.
// Retail bags batch with their matching wholesale roast (that's why they
// carry a profile). A batch is a batch — the program consults the On Hand
// shelf first, then counts WHOLE batches for what's still short; whatever a
// batch produces beyond the orders goes back on the shelf.
const r2 = v => Math.round(v * 100) / 100;

// roast IN (...) per profile. Legacy 'retail' rows predate the profile split
// and get their own bucket with no batch math.
const PROFILE_ROASTS = {
  espresso: ['espresso', 'retail_espresso'],
  filter: ['filter', 'retail_filter'],
  legacy_retail: ['retail'],
};

function batchFor(coffeeId, profile) {
  if (profile === 'legacy_retail') return null;
  const own = db.prepare('SELECT * FROM roast_math WHERE coffee_id=? AND profile=?').get(coffeeId || -1, profile);
  const def = db.prepare('SELECT * FROM roast_math WHERE coffee_id=0 AND profile=?').get(profile);
  const b = own || def;
  return { green_in: b.green_in, roasted_out: b.roasted_out, own: !!own };
}

function stockLbs(coffeeId, profile) {
  return r2(db.prepare('SELECT COALESCE(SUM(delta_lbs),0) s FROM stock_moves WHERE coffee_id=? AND profile=?')
    .get(coffeeId || -1, profile).s);
}

// Unroasted demand grouped by coffee × profile.
function roastDemand() {
  const rows = db.prepare(
    `SELECT oi.coffee_id, oi.coffee_name, oi.roast, SUM(oi.lbs) lbs, SUM(COALESCE(oi.bags,0)) bags,
            GROUP_CONCAT(DISTINCT o.id) order_ids, GROUP_CONCAT(DISTINCT s.name) shop_names
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN shops s ON s.id = o.shop_id
     WHERE o.status = 'confirmed' AND COALESCE(oi.roasted, 0) = 0
     GROUP BY oi.coffee_id, oi.coffee_name, oi.roast`
  ).all();
  const byKey = new Map();
  for (const r of rows) {
    const profile = r.roast === 'retail' ? 'legacy_retail'
      : PROFILE_ROASTS.espresso.includes(r.roast) ? 'espresso' : 'filter';
    const key = `${r.coffee_id}:${profile}`;
    const c = byKey.get(key) || {
      coffee_id: r.coffee_id, coffee_name: r.coffee_name, profile,
      wholesale_lbs: 0, retail_bags: 0, retail_lbs: 0,
      orderIds: new Set(), shops: new Set(),
    };
    if (r.roast === 'espresso' || r.roast === 'filter') c.wholesale_lbs += r.lbs;
    else { c.retail_lbs += r.lbs; c.retail_bags += r.bags; }
    String(r.order_ids || '').split(',').filter(Boolean).forEach(id => c.orderIds.add(id));
    String(r.shop_names || '').split(',').filter(Boolean).forEach(s => c.shops.add(s));
    byKey.set(key, c);
  }
  return [...byKey.values()];
}

// One line's plan: owed → stock coverage → whole batches → leftover.
// mode 'stock' draws the shelf first; 'fresh' leaves it alone.
function planLine(d, mode) {
  const owed = r2(d.wholesale_lbs + d.retail_lbs);
  if (d.profile === 'legacy_retail') {
    return { owed_lbs: owed, stock_lbs: 0, from_stock: 0, short_lbs: owed, batches: null, green_in_lbs: null, expected_out_lbs: null, leftover_lbs: null };
  }
  const b = batchFor(d.coffee_id, d.profile);
  const stock = stockLbs(d.coffee_id, d.profile);
  const fromStock = mode === 'fresh' ? 0 : r2(Math.min(Math.max(0, stock), owed));
  const short = r2(Math.max(0, owed - fromStock));
  const batches = short > 0 ? Math.ceil(short / b.roasted_out - 1e-9) : 0;
  const greenIn = r2(batches * b.green_in);
  const expectedOut = r2(batches * b.roasted_out);
  return {
    owed_lbs: owed, stock_lbs: stock, from_stock: fromStock, short_lbs: short,
    batches, green_in_lbs: greenIn, expected_out_lbs: expectedOut,
    leftover_lbs: r2(stock + expectedOut - owed),
    batch_green_in: b.green_in, batch_roasted_out: b.roasted_out, own_math: b.own,
  };
}

app.get('/api/roast-program', (req, res) => {
  const lines = roastDemand()
    .map(d => ({
      coffee_id: d.coffee_id, coffee_name: d.coffee_name, profile: d.profile,
      wholesale_lbs: r2(d.wholesale_lbs), retail_bags: d.retail_bags, retail_lbs: r2(d.retail_lbs),
      orders_count: d.orderIds.size, shops: [...d.shops],
      ...planLine(d, 'stock'),
      fresh: planLine(d, 'fresh'),
    }))
    .sort((a, b) => a.coffee_name.localeCompare(b.coffee_name) || a.profile.localeCompare(b.profile));
  const legacy = db.prepare("SELECT COUNT(*) n FROM orders WHERE status='confirmed' AND id NOT IN (SELECT DISTINCT order_id FROM order_items)").get().n;
  res.json({
    lines,
    totals: {
      owed_lbs: r2(lines.reduce((s, l) => s + l.owed_lbs, 0)),
      from_stock: r2(lines.reduce((s, l) => s + l.from_stock, 0)),
      batches: lines.reduce((s, l) => s + (l.batches || 0), 0),
      green_in_lbs: r2(lines.reduce((s, l) => s + (l.green_in_lbs || 0), 0)),
      leftover_lbs: r2(lines.reduce((s, l) => s + Math.max(0, l.leftover_lbs || 0), 0)),
    },
    legacy_orders_excluded: legacy,
  });
});

// Fill one coffee × profile line: from stock, a fresh roast, or both.
// Marks the matching items roasted (full-roasted orders get the "Roasted"
// email), logs the batch output and the order fill on the stock ledger.
app.post('/api/roast-program/fill', async (req, res) => {
  try {
    const coffeeId = parseInt((req.body || {}).coffee_id, 10);
    const profile = String((req.body || {}).profile || '');
    const mode = (req.body || {}).mode === 'fresh' ? 'fresh' : 'stock';
    if (!Number.isFinite(coffeeId) || !PROFILE_ROASTS[profile])
      return res.status(400).json({ error: 'coffee_id and profile (espresso | filter | legacy_retail) required' });

    const d = roastDemand().find(x => x.coffee_id === coffeeId && x.profile === profile);
    if (!d) return res.status(404).json({ error: 'No unroasted items for that coffee and profile' });
    const plan = planLine(d, mode);

    if (profile !== 'legacy_retail') {
      let actual = 0;
      if (plan.batches > 0) {
        actual = parseFloat((req.body || {}).actual_out_lbs);
        if (!Number.isFinite(actual) || actual <= 0) actual = plan.expected_out_lbs;
        db.prepare('INSERT INTO stock_moves (coffee_id, coffee_name, profile, delta_lbs, reason, created_by) VALUES (?,?,?,?,?,?)')
          .run(coffeeId, d.coffee_name, profile, r2(actual),
            `Roasted ${plan.batches} batch${plan.batches === 1 ? '' : 'es'}${mode === 'fresh' ? ' (fresh — stock left alone)' : ''}`, req.hubUser.username);
      }
      db.prepare('INSERT INTO stock_moves (coffee_id, coffee_name, profile, delta_lbs, reason, created_by) VALUES (?,?,?,?,?,?)')
        .run(coffeeId, d.coffee_name, profile, -plan.owed_lbs,
          `Filled ${d.orderIds.size} order${d.orderIds.size === 1 ? '' : 's'}${plan.batches ? '' : ' from stock'}`, req.hubUser.username);
      audit(req, `filled ${d.coffee_name} · ${profile} (${mode}${plan.batches ? `, ${plan.batches} batch${plan.batches === 1 ? '' : 'es'}` : ''}, ${d.orderIds.size} order${d.orderIds.size === 1 ? '' : 's'})`);
    }

    const roasts = PROFILE_ROASTS[profile];
    const items = db.prepare(
      `SELECT oi.id, oi.order_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.status='confirmed' AND oi.coffee_id=? AND oi.roast IN (${roasts.map(() => '?').join(',')})
         AND COALESCE(oi.roasted,0)=0`
    ).all(coffeeId, ...roasts);
    const upd = db.prepare("UPDATE order_items SET roasted=1, roasted_at=datetime('now') WHERE id=?");
    for (const i of items) upd.run(i.id);

    const orderIds = [...new Set(items.map(i => i.order_id))];
    const emails = [];
    for (const oid of orderIds) {
      const left = db.prepare('SELECT COUNT(*) n FROM order_items WHERE order_id=? AND COALESCE(roasted,0)=0').get(oid).n;
      if (left > 0) continue;
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
      const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(order.shop_id);
      const its = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(oid);
      const email = await sendEmail(shop.email, `Order roasted — ${shop.name} — ${order.order_date}`,
        orderEmailHtml(order, its, shop, 'Order Roasted',
          'Your coffee has been roasted. Packing is next — you will get another email when your order ships.', { stage: 'Roasted' }));
      emails.push({ order_id: oid, shop_name: shop.name, ...email });
    }
    res.json({
      ok: true, mode, items_roasted: items.length, orders_affected: orderIds.length,
      shops: [...d.shops], batches: plan.batches, roasted_emails: emails,
      on_hand_now: profile === 'legacy_retail' ? null : stockLbs(coffeeId, profile),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Roast Math (batch sizes & drop weights) ─────────────────────────────────
app.get('/api/roast-math', (req, res) => {
  const all = db.prepare('SELECT * FROM roast_math').all();
  const pick = (cid, p) => all.find(r => r.coffee_id === cid && r.profile === p) || null;
  const strip = r => r ? { green_in: r.green_in, roasted_out: r.roasted_out } : null;
  res.json({
    defaults: { espresso: strip(pick(0, 'espresso')), filter: strip(pick(0, 'filter')) },
    coffees: db.prepare('SELECT id, name, badge FROM catalog WHERE active=1 ORDER BY name').all()
      .map(c => ({ coffee_id: c.id, name: c.name, badge: c.badge, espresso: strip(pick(c.id, 'espresso')), filter: strip(pick(c.id, 'filter')) })),
  });
});

// Replace-all semantics: defaults always present; overrides only for coffees
// that differ. green in must exceed roasted out (roasting loses weight).
app.put('/api/roast-math', (req, res) => {
  const { defaults, overrides } = req.body || {};
  const valid = b => b && Number.isFinite(parseFloat(b.green_in)) && Number.isFinite(parseFloat(b.roasted_out))
    && parseFloat(b.green_in) > 0 && parseFloat(b.roasted_out) > 0 && parseFloat(b.roasted_out) < parseFloat(b.green_in);
  for (const p of ['espresso', 'filter']) {
    if (!valid(defaults && defaults[p]))
      return res.status(400).json({ error: `Default ${p} batch needs green in > roasted out > 0` });
  }
  const put = db.prepare('INSERT OR REPLACE INTO roast_math (coffee_id, profile, green_in, roasted_out) VALUES (?,?,?,?)');
  for (const p of ['espresso', 'filter']) put.run(0, p, parseFloat(defaults[p].green_in), parseFloat(defaults[p].roasted_out));
  db.prepare('DELETE FROM roast_math WHERE coffee_id != 0').run();
  for (const o of (Array.isArray(overrides) ? overrides : [])) {
    const cid = parseInt(o.coffee_id, 10);
    if (!Number.isFinite(cid) || cid <= 0 || !['espresso', 'filter'].includes(o.profile)) continue;
    if (!valid(o)) return res.status(400).json({ error: `Override for coffee ${cid} (${o.profile}) needs green in > roasted out > 0` });
    put.run(cid, o.profile, parseFloat(o.green_in), parseFloat(o.roasted_out));
  }
  res.json({ ok: true });
});

// ─── On Hand (roasted coffee at the roastery) ────────────────────────────────
app.get('/api/on-hand', (req, res) => {
  const stock = db.prepare(
    `SELECT coffee_id, profile, MAX(coffee_name) coffee_name, ROUND(SUM(delta_lbs), 2) lbs,
            MAX(CASE WHEN delta_lbs > 0 THEN created_at END) last_roast_at
     FROM stock_moves GROUP BY coffee_id, profile
     HAVING ABS(SUM(delta_lbs)) > 0.001 OR MAX(created_at) > datetime('now','-60 days')`
  ).all();
  // Committed = what confirmed unroasted demand would draw from each pile.
  const demand = roastDemand();
  const rows = stock.map(s => {
    const d = demand.find(x => x.coffee_id === s.coffee_id && x.profile === s.profile);
    const owed = d ? r2(d.wholesale_lbs + d.retail_lbs) : 0;
    const committed = r2(Math.min(Math.max(0, s.lbs), owed));
    return { ...s, committed_lbs: committed, free_lbs: r2(s.lbs - committed) };
  }).sort((a, b) => a.coffee_name.localeCompare(b.coffee_name) || a.profile.localeCompare(b.profile));
  res.json({
    rows,
    total_lbs: r2(rows.reduce((s, r) => s + r.lbs, 0)),
    free_lbs: r2(rows.reduce((s, r) => s + r.free_lbs, 0)),
    moves: db.prepare('SELECT * FROM stock_moves ORDER BY id DESC LIMIT 40').all(),
  });
});

// Manual correction: samples, staff coffee, spillage, recounts.
app.post('/api/on-hand/adjust', (req, res) => {
  const coffeeId = parseInt((req.body || {}).coffee_id, 10);
  const profile = String((req.body || {}).profile || '');
  const delta = parseFloat((req.body || {}).delta_lbs);
  if (!Number.isFinite(coffeeId) || !['espresso', 'filter'].includes(profile) || !Number.isFinite(delta) || delta === 0)
    return res.status(400).json({ error: 'coffee_id, profile (espresso|filter) and a non-zero delta_lbs required' });
  const coffee = db.prepare('SELECT * FROM catalog WHERE id=?').get(coffeeId);
  const name = coffee ? coffee.name
    : (db.prepare('SELECT coffee_name FROM stock_moves WHERE coffee_id=? LIMIT 1').get(coffeeId) || {}).coffee_name;
  if (!name) return res.status(404).json({ error: 'Unknown coffee' });
  const note = String((req.body || {}).note || '').slice(0, 200);
  db.prepare('INSERT INTO stock_moves (coffee_id, coffee_name, profile, delta_lbs, reason, created_by) VALUES (?,?,?,?,?,?)')
    .run(coffeeId, name, profile, r2(delta), `Manual adjustment${note ? ` — ${note}` : ''}`, req.hubUser.username);
  audit(req, `adjusted On Hand: ${name} · ${profile} ${delta > 0 ? '+' : ''}${r2(delta)} lbs${note ? ` (${note})` : ''}`);
  res.json({ ok: true, on_hand_now: stockLbs(coffeeId, profile) });
});

// Fulfillment pack tracking: tick items off as they are physically packed.
app.patch('/api/order-items/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM order_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(item.order_id);
  if (order.status !== 'confirmed') return res.status(400).json({ error: 'Only items of confirmed (unshipped) orders can be packed' });
  const packed = req.body && req.body.packed ? 1 : 0;
  if (packed && !item.roasted) return res.status(400).json({ error: 'This coffee has not been roasted yet — mark it roasted in the Roast Program first' });
  db.prepare("UPDATE order_items SET packed=?, packed_at=CASE WHEN ?=1 THEN datetime('now') ELSE NULL END WHERE id=?")
    .run(packed, packed, item.id);
  res.json(orderFull(db.prepare('SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=?').get(order.id)));
});

// ─── Weekly / monthly roast reports ──────────────────────────────────────────
// At the close of each week/month, roll up roasted coffee per client into
// roast_reports. Orders are kept forever — storage is tiny and history feeds
// Patterns and audits.
function generateRoastReports() {
  for (const [type, fmt] of [['week', '%Y-W%W'], ['month', '%Y-%m']]) {
    // Periods close on the roastery's calendar (HUB_TZ, default Los Angeles),
    // not UTC — otherwise a week would roll over at 4/5pm local time.
    const laToday = new Date().toLocaleDateString('en-CA', { timeZone: process.env.HUB_TZ || 'America/Los_Angeles' });
    const current = db.prepare(`SELECT strftime('${fmt}', ?) p`).get(laToday).p;
    // Reports are purely derived from orders — rebuild closed periods from
    // scratch so deleted (trial) orders drop out instead of lingering.
    db.prepare('DELETE FROM roast_reports WHERE period_type=? AND period < ?').run(type, current);
    const rows = db.prepare(
      `SELECT strftime('${fmt}', o.order_date) period, o.shop_id, s.name shop_name,
              oi.coffee_name, oi.roast, SUM(oi.lbs) lbs, SUM(oi.line_total) cost
       FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN shops s ON s.id=o.shop_id
       WHERE o.status IN ('confirmed','shipped','delivered') AND strftime('${fmt}', o.order_date) < ?
       GROUP BY period, o.shop_id, oi.coffee_name, oi.roast`
    ).all(current);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO roast_reports (period_type, period, shop_id, shop_name, coffee_name, roast, lbs, cost)
       VALUES (?,?,?,?,?,?,?,?)`);
    for (const r of rows) ins.run(type, r.period, r.shop_id, r.shop_name, r.coffee_name, r.roast, Math.round(r.lbs * 100) / 100, Math.round(r.cost * 100) / 100);
  }
}
generateRoastReports();
setInterval(generateRoastReports, 12 * 60 * 60 * 1000).unref();

app.get('/api/reports', (req, res) => {
  const type = req.query.period_type === 'month' ? 'month' : 'week';
  const rows = db.prepare(
    'SELECT * FROM roast_reports WHERE period_type=? ORDER BY period DESC, shop_name, coffee_name LIMIT 1000'
  ).all(type);
  res.json({ currency: CURRENCY, rows });
});

// ─── Patterns ─────────────────────────────────────────────────────────────────
app.get('/api/analytics', (req, res) => {
  const shops = db.prepare('SELECT * FROM shops ORDER BY name').all();
  const out = shops.map(s => {
    const totals = db.prepare(
      `SELECT COUNT(*) orders_count, COALESCE(SUM(total_lbs),0) lbs, COALESCE(SUM(total_cost),0) cost,
              MIN(order_date) first_order, MAX(order_date) last_order
       FROM orders WHERE shop_id=?`).get(s.id);
    // Roast mix: items carry it directly (retail bags count with their
    // profile); legacy pool orders map espresso→espresso, rest→filter
    const mix = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN roast IN ('espresso','retail_espresso') THEN lbs END),0) esp,
              COALESCE(SUM(CASE WHEN roast IN ('filter','retail_filter') THEN lbs END),0) flt
       FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.shop_id=?`).get(s.id);
    const legacy = db.prepare(
      `SELECT COALESCE(SUM(espresso_lbs),0) esp, COALESCE(SUM(drip_lbs + coldbrew_lbs + pourover_lbs),0) flt
       FROM orders WHERE shop_id=? AND id NOT IN (SELECT DISTINCT order_id FROM order_items)`).get(s.id);
    const topCoffees = db.prepare(
      `SELECT coffee_name, SUM(lbs) lbs FROM order_items oi JOIN orders o ON o.id=oi.order_id
       WHERE o.shop_id=? GROUP BY coffee_name ORDER BY lbs DESC LIMIT 3`).all(s.id);
    const dates = db.prepare('SELECT DISTINCT order_date FROM orders WHERE shop_id=? ORDER BY order_date').all(s.id).map(r => r.order_date);
    let avgInterval = null;
    if (dates.length >= 2) {
      const spanDays = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000;
      avgInterval = Math.round(spanDays / (dates.length - 1) * 10) / 10;
    }
    const weekly = db.prepare(
      `SELECT strftime('%Y-%W', order_date) week, COALESCE(SUM(total_lbs),0) lbs
       FROM orders WHERE shop_id=? AND order_date >= date('now', '-84 days')
       GROUP BY week ORDER BY week`).all(s.id);
    return {
      shop_id: s.id, shop_name: s.name,
      orders_count: totals.orders_count,
      total_lbs: Math.round(totals.lbs * 10) / 10,
      total_cost: Math.round(totals.cost * 100) / 100,
      roast_mix: {
        espresso: Math.round((mix.esp + legacy.esp) * 10) / 10,
        filter: Math.round((mix.flt + legacy.flt) * 10) / 10,
      },
      top_coffees: topCoffees.map(t => ({ name: t.coffee_name, lbs: Math.round(t.lbs * 10) / 10 })),
      first_order: totals.first_order, last_order: totals.last_order,
      avg_interval_days: avgInterval,
      weekly,
    };
  });
  res.json({ currency: CURRENCY, shops: out });
});

// Full account breakdown for the Patterns drill-in: lifetime stats, roast
// mix, every coffee they buy, 12-week volume, and recent orders.
app.get('/api/analytics/shop/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Shop not found' });
  const totals = db.prepare(
    `SELECT COUNT(*) orders_count, COALESCE(SUM(total_lbs),0) lbs, COALESCE(SUM(total_cost),0) cost,
            MIN(order_date) first_order, MAX(order_date) last_order
     FROM orders WHERE shop_id=?`).get(s.id);
  const mix = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN roast IN ('espresso','retail_espresso') THEN lbs END),0) esp,
            COALESCE(SUM(CASE WHEN roast IN ('filter','retail_filter') THEN lbs END),0) flt
     FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.shop_id=?`).get(s.id);
  const coffees = db.prepare(
    `SELECT coffee_name, ROUND(SUM(lbs),1) lbs, ROUND(SUM(line_total),2) cost
     FROM order_items oi JOIN orders o ON o.id=oi.order_id
     WHERE o.shop_id=? GROUP BY coffee_name ORDER BY lbs DESC`).all(s.id);
  const weekly = db.prepare(
    `SELECT strftime('%Y-%W', order_date) week, COALESCE(SUM(total_lbs),0) lbs
     FROM orders WHERE shop_id=? AND order_date >= date('now', '-84 days')
     GROUP BY week ORDER BY week`).all(s.id);
  const recent = db.prepare(
    `SELECT id, order_date, requested_date, total_lbs, total_cost, status, placed_by
     FROM orders WHERE shop_id=? ORDER BY received_at DESC, id DESC LIMIT 10`).all(s.id);
  const dates = db.prepare('SELECT DISTINCT order_date FROM orders WHERE shop_id=? ORDER BY order_date').all(s.id).map(r => r.order_date);
  let avgInterval = null;
  if (dates.length >= 2) {
    const spanDays = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000;
    avgInterval = Math.round(spanDays / (dates.length - 1) * 10) / 10;
  }
  res.json({
    currency: CURRENCY,
    shop: { id: s.id, name: s.name, email: s.email, created_at: s.created_at },
    orders_count: totals.orders_count,
    total_lbs: Math.round(totals.lbs * 10) / 10,
    total_cost: Math.round(totals.cost * 100) / 100,
    first_order: totals.first_order, last_order: totals.last_order,
    avg_interval_days: avgInterval,
    roast_mix: { espresso: Math.round(mix.esp * 10) / 10, filter: Math.round(mix.flt * 10) / 10 },
    coffees, weekly, recent,
  });
});

// ─── Static dashboard ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Dose Hub running on port ${PORT}`));
