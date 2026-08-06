require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const path = require('path');
const { generateReport } = require('./report');
const { LBS_TO_GRAMS, GALLONS_TO_ML, aggregateOrders, calcCoffeeStock, calcEfficiency, suggestOrderLbs, priceItemsFromCatalog } = require('./calc');

const app = express();
// Same-origin in production (frontend is served by this server) — CORS headers
// are only needed for the dev server proxy setup.
if (process.env.NODE_ENV !== 'production') app.use(cors());
app.use(express.json());

// The hub URL is the same for every shop — only the API key is per shop.
// A saved hub_url setting (or DEFAULT_HUB_URL env) can override for
// self-hosted setups, but the UI only asks for the key.
const DEFAULT_HUB_URL = (process.env.DEFAULT_HUB_URL || 'https://dosehub.up.railway.app').replace(/\/+$/, '');

const dbPath = process.env.DB_PATH || '/app/data/dose.db';
require('fs').mkdirSync(require('path').dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS drink_recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    square_item_name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('espresso','drip','coldbrew','pourover')),
    coffee_grams REAL NOT NULL,
    milk_whole_ml REAL DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS coffee_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_date TEXT NOT NULL,
    espresso_lbs_received REAL DEFAULT 0,
    espresso_lbs_onhand  REAL DEFAULT 0,
    drip_lbs_received    REAL DEFAULT 0,
    drip_lbs_onhand      REAL DEFAULT 0,
    coldbrew_lbs_received REAL DEFAULT 0,
    coldbrew_lbs_onhand  REAL DEFAULT 0,
    pourover_lbs_received REAL DEFAULT 0,
    pourover_lbs_onhand  REAL DEFAULT 0,
    notes TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS milk_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_date TEXT NOT NULL,
    whole_bottles_received REAL DEFAULT 0,
    whole_bottles_onhand   REAL DEFAULT 0,
    notes TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS coffee_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_date TEXT NOT NULL,
    espresso_lbs REAL DEFAULT 0,
    drip_lbs REAL DEFAULT 0,
    coldbrew_lbs REAL DEFAULT 0,
    pourover_lbs REAL DEFAULT 0,
    notes TEXT,
    status TEXT DEFAULT 'saved',
    sent_to TEXT,
    sent_at TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hub_login_cache (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL,
    verified_at TEXT
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES coffee_orders(id),
    coffee_id INTEGER,
    coffee_name TEXT NOT NULL,
    roast TEXT NOT NULL CHECK(roast IN ('espresso','filter','retail')),
    lbs REAL NOT NULL,
    bags INTEGER,
    price_per_lb REAL NOT NULL,
    line_total REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS standing_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frequency TEXT NOT NULL CHECK(frequency IN ('weekly','biweekly','monthly')),
    items_json TEXT NOT NULL,
    notes TEXT,
    next_date TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES ('alt_milk_ml_per_modifier', '180');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('square_location_id', '');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('numilk_oat_liters_per_day', '0');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('numilk_almond_liters_per_day', '0');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('shop_name', '');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('order_email_to', 'hello@boxxcoffee.com');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('order_email_from', '');
`);

function getSettings() {
  const cfg = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) cfg[r.key] = r.value;
  return cfg;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(key, String(value));
}

// Secrets live in the shop's own database (entered via Settings after login);
// environment variables remain as a fallback so older deployments keep working.
// If DOSE_SECRET_KEY is set, stored secrets are AES-256-GCM encrypted so a
// leaked database file alone reveals nothing.
const SECRET_KEY = process.env.DOSE_SECRET_KEY
  ? crypto.createHash('sha256').update(process.env.DOSE_SECRET_KEY).digest()
  : null;

function encryptSecret(plain) {
  if (!SECRET_KEY || !plain) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decryptSecret(stored) {
  if (!stored || !stored.startsWith('enc:v1:')) return stored;
  if (!SECRET_KEY) throw new Error('Stored credential is encrypted but DOSE_SECRET_KEY is not set');
  const [, , ivB64, tagB64, dataB64] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

function getSecret(settingKey, envName) {
  const v = (getSettings()[settingKey] || '').trim();
  if (v) return decryptSecret(v);
  return process.env[envName] || '';
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
// Real user accounts with roles ('admin' | 'user'). There is no
// self-registration: the one-time setup screen creates the ADMIN account and
// requires a setup code printed to the server logs, so only whoever operates
// the deployment can claim it. Passwords are salted scrypt hashes (async so
// hashing never blocks the event loop). Login is rate-limited and exchanges
// credentials for a random session token; the DB stores only the SHA-256 of
// the token, and sessions expire.

// Older databases predate some columns — add them in place.
try { db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER'); } catch { /* already present */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN expires_at TEXT'); } catch { /* already present */ }
for (const t of ['coffee_deliveries', 'milk_deliveries', 'coffee_orders', 'drink_recipes']) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN created_by TEXT`); } catch { /* already present */ }
}
try { db.exec('ALTER TABLE coffee_orders ADD COLUMN hub_status TEXT'); } catch { /* already present */ }
for (const col of ['requested_date TEXT', 'total_lbs REAL', 'total_cost REAL']) {
  try { db.exec(`ALTER TABLE coffee_orders ADD COLUMN ${col}`); } catch { /* already present */ }
}
try { db.exec("ALTER TABLE users ADD COLUMN source TEXT DEFAULT 'local'"); } catch { /* already present */ }
try { db.exec('ALTER TABLE order_items ADD COLUMN bags INTEGER'); } catch { /* already present */ }

// Widen the roast CHECK from earlier versions (SQLite requires a rebuild).
{
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_items'").get();
  if (row && !row.sql.includes("'retail'")) {
    db.exec('ALTER TABLE order_items RENAME TO order_items_migr');
    db.exec(`CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES coffee_orders(id),
      coffee_id INTEGER,
      coffee_name TEXT NOT NULL,
      roast TEXT NOT NULL CHECK(roast IN ('espresso','filter','retail')),
      lbs REAL NOT NULL,
      bags INTEGER,
      price_per_lb REAL NOT NULL,
      line_total REAL NOT NULL
    )`);
    db.exec('INSERT INTO order_items (id, order_id, coffee_id, coffee_name, roast, lbs, bags, price_per_lb, line_total) SELECT id, order_id, coffee_id, coffee_name, roast, lbs, bags, price_per_lb, line_total FROM order_items_migr');
    db.exec('DROP TABLE order_items_migr');
    console.log('Migrated order_items schema');
  }
}

const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);

const SESSION_DAYS = 30;
const SESSION_RENEW_BELOW_DAYS = 15;
const PASSWORD_MIN = { admin: 10, user: 6 };

async function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = await scryptAsync(String(password), salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

// Boot-time only (seeding/migration) — blocking is fine before listen().
function hashPasswordSync(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const normUsername = u => String(u || '').toLowerCase().trim();
const publicUser = u => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at });
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const passwordPolicyError = role =>
  `Password must be at least ${PASSWORD_MIN[role] || 6} characters${role === 'admin' ? ' for admin accounts' : ''}`;

// Constant-cost dummy so login timing doesn't reveal whether a username exists.
const DUMMY = hashPasswordSync('dummy-password');

async function createUser(username, password, role) {
  const { salt, hash } = await hashPassword(password);
  const r = db.prepare('INSERT INTO users (username, password_hash, salt, role) VALUES (?,?,?,?)')
    .run(normUsername(username), hash, salt, role);
  return db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
}

async function verifyUser(username, password) {
  let u = db.prepare('SELECT * FROM users WHERE username=?').get(normUsername(username));
  if (u && u.source === 'hub') u = null; // hub-managed identities never have a local password
  const salt = u ? u.salt : DUMMY.salt;
  const expected = u ? u.password_hash : DUMMY.hash;
  const { hash } = await hashPassword(password, salt);
  const ok = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
  return (u && ok) ? u : null;
}

// ─── Hub-delegated login ─────────────────────────────────────────────────────
// When a roastery hub is connected, credentials are verified against the hub
// (the hub is the identity provider). A successful login is cached (hashed)
// for 24h so a hub outage doesn't lock out people who logged in recently.
function isHubConfigured(cfg) {
  return !!hubConn(cfg).key; // the URL always resolves (default hub)
}

// Hub identities get a local user row so sessions, created_by stamps, and
// role checks keep working unchanged.
function upsertHubUser(username, role) {
  const uname = normUsername(username);
  const existing = db.prepare('SELECT * FROM users WHERE username=?').get(uname);
  if (existing) {
    if (existing.role !== role || existing.source !== 'hub')
      db.prepare("UPDATE users SET role=?, source='hub' WHERE id=?").run(role, existing.id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);
  }
  const r = db.prepare("INSERT INTO users (username, password_hash, salt, role, source) VALUES (?,?,?,?, 'hub')")
    .run(uname, 'hub-managed', '00', role);
  return db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
}

async function cacheHubLogin(username, password, role) {
  const { salt, hash } = await hashPassword(password);
  db.prepare(`INSERT OR REPLACE INTO hub_login_cache (username, password_hash, salt, role, verified_at)
    VALUES (?,?,?,?, datetime('now'))`).run(normUsername(username), hash, salt, role);
}

async function verifyCachedHubLogin(username, password) {
  const row = db.prepare(
    "SELECT * FROM hub_login_cache WHERE username=? AND verified_at > datetime('now','-24 hours')"
  ).get(normUsername(username));
  if (!row) return null;
  const { hash } = await hashPassword(password, row.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(row.password_hash, 'hex')) ? row : null;
}

function usersExist() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?, datetime('now', '+${SESSION_DAYS} days'))`)
    .run(sha256(token), userId);
  return token;
}

function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at IS NULL OR expires_at <= datetime('now')").run();
}
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();

// One-time migrations into the users table:
//  - a legacy shared password (settings) becomes the 'admin' account
//  - otherwise DOSE_PASSWORD / ADMIN_USERNAME env vars seed the admin
if (!usersExist()) {
  const cfg = getSettings();
  if (cfg.auth_password_hash && cfg.auth_salt) {
    db.prepare('INSERT INTO users (username, password_hash, salt, role) VALUES (?,?,?,?)')
      .run('admin', cfg.auth_password_hash, cfg.auth_salt, 'admin');
    db.prepare("DELETE FROM settings WHERE key IN ('auth_password_hash','auth_salt')").run();
    console.log("Migrated shared password to user 'admin' — log in as admin with the same password");
  } else if (process.env.DOSE_PASSWORD) {
    const { salt, hash } = hashPasswordSync(process.env.DOSE_PASSWORD);
    db.prepare('INSERT INTO users (username, password_hash, salt, role) VALUES (?,?,?,?)')
      .run(normUsername(process.env.ADMIN_USERNAME || 'admin'), hash, salt, 'admin');
    console.log(`Seeded admin account '${process.env.ADMIN_USERNAME || 'admin'}' from env`);
  }
}

// Setup code: while no admin exists, claiming the deployment requires a code
// that is only visible in the server logs — closes the window where a fresh
// deployment could be claimed by whoever finds the URL first.
let setupCode = null;
if (!usersExist() && !isHubConfigured(getSettings())) {
  setupCode = process.env.SETUP_SECRET || crypto.randomBytes(4).toString('hex');
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  DOSE SETUP CODE: ${setupCode}`);
  console.log('  Enter this code on the first-run setup screen to create');
  console.log('  the admin account. Only visible in these server logs.');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
}

// Login rate limiting: escalating lockout per IP and per username.
const loginFailures = new Map(); // key → { count, until }
const LOCK_AFTER = 5;
function lockedFor(key) {
  const e = loginFailures.get(key);
  if (!e || e.count < LOCK_AFTER) return 0;
  return Math.max(0, Math.ceil((e.until - Date.now()) / 1000));
}
function recordFailure(key) {
  const e = loginFailures.get(key) || { count: 0, until: 0 };
  e.count += 1;
  if (e.count >= LOCK_AFTER) {
    const lockMs = Math.min(15 * 60_000, 30_000 * 2 ** (e.count - LOCK_AFTER));
    e.until = Date.now() + lockMs;
  }
  loginFailures.set(key, e);
}
function clearFailures(...keys) { for (const k of keys) loginFailures.delete(k); }
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [k, e] of loginFailures) if (e.until < cutoff) loginFailures.delete(k);
}, 10 * 60_000).unref();

const asyncRoute = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const OPEN_PATHS = new Set(['/login', '/setup', '/auth-status']);

app.use('/api', (req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  const token = req.get('x-dose-key') || '';
  const row = token && db.prepare(
    `SELECT s.token AS thash, s.expires_at, u.id, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token=? AND s.expires_at > datetime('now')`
  ).get(sha256(token));
  if (row) {
    // Sliding renewal: extend active sessions nearing expiry
    if (new Date(row.expires_at + 'Z') - Date.now() < SESSION_RENEW_BELOW_DAYS * 86400_000) {
      db.prepare(`UPDATE sessions SET expires_at = datetime('now', '+${SESSION_DAYS} days') WHERE token=?`).run(row.thash);
    }
    req.user = { id: row.id, username: row.username, role: row.role };
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
});

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

app.get('/api/auth-status', (req, res) => {
  const hubMode = isHubConfigured(getSettings());
  const setup = !usersExist() && !hubMode;
  res.json({
    setup_required: setup,
    setup_code_required: setup,
    mode: hubMode ? 'hub' : (usersExist() ? 'local' : 'unconfigured'),
  });
});

// First run only, gated by the setup code from the server logs. Two modes:
//  - mode 'hub': connect this deployment to a roastery hub (validated against
//    the hub before saving); logins are then hub credentials.
//  - default: create a standalone local admin account.
app.post('/api/setup', asyncRoute(async (req, res) => {
  if (usersExist() || isHubConfigured(getSettings())) return res.status(400).json({ error: 'Already set up — use login' });
  const { username, password, setup_code, mode } = req.body || {};
  if (!setupCode || !crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(setup_code || '')).digest(),
    crypto.createHash('sha256').update(setupCode).digest()
  )) return res.status(403).json({ error: 'Wrong setup code — find it in the server logs (Railway → Deployments → View Logs)' });

  if (mode === 'hub') {
    const hubUrl = String(req.body.hub_url || '').trim().replace(/\/+$/, '') || DEFAULT_HUB_URL;
    const hubApiKey = String(req.body.hub_api_key || '').trim();
    if (!/^https?:\/\//.test(hubUrl)) return res.status(400).json({ error: 'A valid hub URL is required (https://…)' });
    if (!hubApiKey) return res.status(400).json({ error: 'Hub API key is required' });
    try {
      const test = await fetch(`${hubUrl}/api/ingest/catalog`, { headers: { 'Authorization': `Bearer ${hubApiKey}` } });
      if (test.status === 401) return res.status(400).json({ error: 'The hub rejected this API key' });
      if (!test.ok) return res.status(400).json({ error: `The hub responded with an error (${test.status})` });
    } catch (err) {
      return res.status(400).json({ error: `Could not reach the hub: ${err.message}` });
    }
    if (hubUrl !== DEFAULT_HUB_URL) setSetting('hub_url', hubUrl);
    setSetting('hub_api_key', encryptSecret(hubApiKey));
    setupCode = null;
    return res.json({ ok: true, connected: true }); // no session — log in with hub credentials
  }

  const uname = normUsername(username);
  if (!USERNAME_RE.test(uname)) return res.status(400).json({ error: 'Username: 3–32 chars, letters/numbers/._- only' });
  if (String(password || '').length < PASSWORD_MIN.admin) return res.status(400).json({ error: passwordPolicyError('admin') });
  const u = await createUser(uname, password, 'admin');
  setupCode = null;
  res.json({ ok: true, token: issueToken(u.id), user: publicUser(u) });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const uname = normUsername(username);
  const cfg = getSettings();
  const hubMode = isHubConfigured(cfg);
  if (!usersExist() && !hubMode) return res.status(409).json({ error: 'Setup required' });
  const ipKey = `ip:${req.ip}`;
  const userKey = `u:${uname}`;
  const wait = Math.max(lockedFor(ipKey), lockedFor(userKey));
  if (wait > 0) return res.status(429).json({ error: `Too many attempts — try again in ${wait}s` });

  if (hubMode) {
    let hubUser = null;
    let fallThroughToLocal = false;
    try {
      hubUser = await hubFetch(cfg, '/api/ingest/auth', {
        method: 'POST', body: JSON.stringify({ username: uname, password: password || '' }),
      });
    } catch (err) {
      if (err.hubStatus === 401) {
        recordFailure(ipKey); recordFailure(userKey);
        return res.status(401).json({ error: 'Wrong username or password' });
      }
      if (err.hubStatus === 429) return res.status(429).json({ error: err.message });
      if (err.hubStatus === 409) {
        fallThroughToLocal = true; // hub shop has no login password yet — legacy local accounts still apply
      } else {
        // Hub unreachable: accept recently verified credentials from the cache.
        const cached = await verifyCachedHubLogin(uname, password || '');
        if (cached) {
          const u = upsertHubUser(cached.username, cached.role);
          clearFailures(ipKey, userKey);
          return res.json({ ok: true, token: issueToken(u.id), user: publicUser(u), cached: true });
        }
        return res.status(502).json({ error: 'Cannot reach the roastery hub to verify your login — try again shortly.' });
      }
    }
    if (hubUser) {
      const u = upsertHubUser(hubUser.username, hubUser.role || 'admin');
      await cacheHubLogin(hubUser.username, password || '', hubUser.role || 'admin');
      clearFailures(ipKey, userKey);
      return res.json({ ok: true, token: issueToken(u.id), user: publicUser(u) });
    }
    if (!fallThroughToLocal) return res.status(500).json({ error: 'Login failed' });
  }

  const u = await verifyUser(uname, password || '');
  if (!u) {
    recordFailure(ipKey); recordFailure(userKey);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  clearFailures(ipKey, userKey);
  res.json({ ok: true, token: issueToken(u.id), user: publicUser(u) });
}));

app.get('/api/me', (req, res) => res.json(req.user));

// Change your own password; signs out your other sessions. Hub-managed
// identities change their password AT the hub (proxied with the API key).
app.post('/api/change-password', asyncRoute(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);

  if (u.source === 'hub') {
    const cfg = getSettings();
    try {
      await hubFetch(cfg, '/api/ingest/change-password', {
        method: 'POST',
        body: JSON.stringify({ username: u.username, current_password: current_password || '', new_password: new_password || '' }),
      });
    } catch (err) {
      return res.status(err.hubStatus === 401 ? 401 : err.hubStatus === 400 ? 400 : 502).json({ error: err.message });
    }
    await cacheHubLogin(u.username, new_password, u.role);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    return res.json({ ok: true, token: issueToken(u.id) });
  }

  if (!(await verifyUser(u.username, current_password || ''))) return res.status(401).json({ error: 'Current password is wrong' });
  if (String(new_password || '').length < (PASSWORD_MIN[u.role] || 6)) return res.status(400).json({ error: passwordPolicyError(u.role) });
  const { salt, hash } = await hashPassword(new_password);
  db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  res.json({ ok: true, token: issueToken(u.id) });
}));

// ─── User management (admin only) ────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY username').all());
});

app.post('/api/users', requireAdmin, asyncRoute(async (req, res) => {
  const { username, password, role } = req.body || {};
  const uname = normUsername(username);
  const r = role === 'admin' ? 'admin' : 'user';
  if (!USERNAME_RE.test(uname)) return res.status(400).json({ error: 'Username: 3–32 chars, letters/numbers/._- only' });
  if (String(password || '').length < PASSWORD_MIN[r]) return res.status(400).json({ error: passwordPolicyError(r) });
  try {
    res.json(publicUser(await createUser(uname, password, r)));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
    throw err;
  }
}));

app.post('/api/users/:id/reset-password', requireAdmin, asyncRoute(async (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { new_password } = req.body || {};
  if (String(new_password || '').length < (PASSWORD_MIN[target.role] || 6)) return res.status(400).json({ error: passwordPolicyError(target.role) });
  const { salt, hash } = await hashPassword(new_password);
  db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, target.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id); // sign them out everywhere
  res.json({ ok: true });
}));

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
  if (target.role === 'admin' && admins <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
  db.prepare('DELETE FROM users WHERE id=?').run(target.id);
  res.json({ success: true });
});

// ─── Settings ─────────────────────────────────────────────────────────────────
const SECRET_SETTINGS = ['square_access_token', 'resend_api_key', 'hub_api_key'];
const HIDDEN_SETTINGS = new Set([...SECRET_SETTINGS, 'auth_password_hash', 'auth_salt']);

app.get('/api/settings', (req, res) => {
  const cfg = getSettings();
  const s = {};
  for (const [k, v] of Object.entries(cfg)) if (!HIDDEN_SETTINGS.has(k)) s[k] = v;
  // Secrets are reported as configured/not — never echoed back
  s.square_token_set  = !!getSecret('square_access_token', 'SQUARE_ACCESS_TOKEN');
  s.square_token_source = (cfg.square_access_token || '').trim() ? 'settings'
    : (process.env.SQUARE_ACCESS_TOKEN ? 'env' : null);
  s.resend_configured = !!getSecret('resend_api_key', 'RESEND_API_KEY');
  s.resend_source = (cfg.resend_api_key || '').trim() ? 'settings'
    : (process.env.RESEND_API_KEY ? 'env' : null);
  s.hub_configured = !!getSecret('hub_api_key', 'HUB_API_KEY');
  s.auth_mode = s.hub_configured ? 'hub' : 'local';
  s.password_protected = true; // login is always required
  res.json(s);
});

app.post('/api/settings', (req, res) => {
  // Day-to-day settings are open to any user; credentials are admin-only.
  const ADMIN_ONLY = [...SECRET_SETTINGS, 'order_email_to', 'order_email_from', 'square_location_id', 'hub_url'];
  if (ADMIN_ONLY.some(k => req.body[k] !== undefined) && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Admin access required to change credentials' });
  const allowed = [
    'alt_milk_ml_per_modifier',
    'numilk_oat_liters_per_day', 'numilk_almond_liters_per_day',
    'shop_name', ...ADMIN_ONLY,
  ];
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    const value = String(req.body[key]).trim();
    setSetting(key, SECRET_SETTINGS.includes(key) ? encryptSecret(value) : value);
  }
  if (req.body.square_access_token !== undefined) cachedLocations = null; // token changed → re-resolve locations
  if (req.body.hub_url !== undefined || req.body.hub_api_key !== undefined) catalogCache = { at: 0, data: null };
  res.json({ success: true });
});

// ─── Square helpers ───────────────────────────────────────────────────────────
let cachedLocations = null;

function getSquareToken() {
  const token = getSecret('square_access_token', 'SQUARE_ACCESS_TOKEN');
  if (!token) throw new Error('Square access token not set — add it on the Settings page');
  return token;
}

async function getLocations() {
  if (cachedLocations) return cachedLocations;
  const res = await fetch('https://connect.squareup.com/v2/locations', {
    headers: { 'Authorization': `Bearer ${getSquareToken()}`, 'Square-Version': '2024-01-17' }
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.detail || 'Failed to fetch locations');
  cachedLocations = (data.locations || []).filter(l => l.status === 'ACTIVE');
  return cachedLocations;
}

// The shop's IANA timezone from its Square location, so "a day" means the
// shop's day rather than a UTC day.
async function getShopTimezone(locationId) {
  try {
    const locs = await getLocations();
    const loc = locationId ? locs.find(l => l.id === locationId) : locs[0];
    return (loc && loc.timezone) || 'UTC';
  } catch {
    return 'UTC';
  }
}

// UTC offset string ("-05:00") for a calendar date in an IANA timezone.
// Sampled at noon UTC to stay clear of DST switchover hours.
function utcOffset(dateStr, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${dateStr}T12:00:00Z`));
    const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT';
    const m = name.match(/GMT([+-]\d{2}:\d{2})/);
    return m ? m[1] : '+00:00';
  } catch {
    return '+00:00';
  }
}

async function squarePost(endpoint, body) {
  const token = getSquareToken();
  const res = await fetch(`https://connect.squareup.com/v2${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Square-Version': '2024-01-17' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fetchAllOrders(startDate, endDate, locationIds) {
  if (!locationIds || locationIds.length === 0) locationIds = (await getLocations()).map(l => l.id);
  const tz = await getShopTimezone(locationIds.length === 1 ? locationIds[0] : null);
  const startOff = utcOffset(startDate, tz);
  const endOff = utcOffset(endDate, tz);
  const all = [];
  let cursor = null;
  do {
    const body = {
      location_ids: locationIds,
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: `${startDate}T00:00:00.000${startOff}`, end_at: `${endDate}T23:59:59.999${endOff}` } },
          state_filter: { states: ['COMPLETED'] },
        },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;
    const data = await squarePost('/orders/search', body);
    if (data.errors) throw new Error(data.errors[0]?.detail || 'Square API error');
    all.push(...(data.orders || []));
    cursor = data.cursor || null;
  } while (cursor);
  return all;
}

// ─── Analytics ────────────────────────────────────────────────────────────────
// Cycle semantics:
//   A delivery on date D closes the previous cycle (its on-hand count is that
//   cycle's ground truth) and opens a new one. A closed cycle's date range is
//   [delivery N .. day before delivery N+1] — the frontend passes ranges in
//   that shape, and this function finds the closing delivery as the first one
//   strictly after end_date. The closing delivery's received bags are never
//   mixed into the previous cycle's opening stock.
//
// CLOSED cycle:
//   opening_stock         = on_hand + received at first delivery in period
//                           (+ received-only for later in-period deliveries)
//   theoretical_remaining = opening_stock - theoretical_use
//   actual_remaining      = on_hand at first delivery AFTER period end
//   waste                 = theoretical_remaining - actual_remaining
//   flagged WASTE only when waste > 5% of opening stock
//
// OPEN cycle (no delivery after end yet): theoretical use vs stock, no verdict.
//
// Numilk: daily_rate × days, no closing count available.
async function computeAnalytics(start_date, end_date) {
  const cfg = getSettings();
  const mlPerMod = parseFloat(cfg.alt_milk_ml_per_modifier) || 180;
  const locationIds = cfg.square_location_id ? [cfg.square_location_id] : [];
  const oatLitersPerDay    = parseFloat(cfg.numilk_oat_liters_per_day)    || 0;
  const almondLitersPerDay = parseFloat(cfg.numilk_almond_liters_per_day) || 0;

  // Days in period (inclusive)
  const msPerDay = 86400000;
  const days = Math.round((new Date(end_date) - new Date(start_date)) / msPerDay) + 1;

  // Square orders
  const rawOrders = await fetchAllOrders(start_date, end_date, locationIds);
  const { orders: itemList, modifiers } = aggregateOrders(rawOrders);

  // Recipe matching
  const recipes = db.prepare('SELECT * FROM drink_recipes').all();
  const recipeMap = {};
  for (const r of recipes) recipeMap[r.square_item_name.toLowerCase().trim()] = r;

  const coffeeUsed = { espresso: 0, drip: 0, coldbrew: 0, pourover: 0 };
  const matched = {}, unmatched = {};
  for (const { name, qty, milk } of itemList) {
    const r = recipeMap[name.toLowerCase().trim()];
    if (r) {
      coffeeUsed[r.category] += r.coffee_grams * qty;
      matched[name] = { qty: (matched[name]?.qty || 0) + qty, milk };
    } else {
      unmatched[name] = (unmatched[name] || 0) + qty;
    }
  }

  // Milk used from modifiers
  const milkUsed = {
    whole:  modifiers.milk_whole  * mlPerMod,
    oat:    modifiers.milk_oat    * mlPerMod,
    almond: modifiers.milk_almond * mlPerMod,
  };

  // Coffee deliveries in period, sorted oldest first. The closing delivery
  // (first one strictly after end_date) is deliberately NOT in this list.
  const coffeeDels = db.prepare(
    'SELECT * FROM coffee_deliveries WHERE delivery_date >= ? AND delivery_date <= ? ORDER BY delivery_date ASC'
  ).all(start_date, end_date);

  const closingCoffeeDel = db.prepare(
    'SELECT * FROM coffee_deliveries WHERE delivery_date > ? ORDER BY delivery_date ASC LIMIT 1'
  ).get(end_date);

  const closingMilkDel = db.prepare(
    'SELECT * FROM milk_deliveries WHERE delivery_date > ? ORDER BY delivery_date ASC LIMIT 1'
  ).get(end_date);

  const stock = {
    espresso: calcCoffeeStock(coffeeDels, 'espresso_lbs_received', 'espresso_lbs_onhand'),
    drip:     calcCoffeeStock(coffeeDels, 'drip_lbs_received',     'drip_lbs_onhand'),
    coldbrew: calcCoffeeStock(coffeeDels, 'coldbrew_lbs_received', 'coldbrew_lbs_onhand'),
    pourover: calcCoffeeStock(coffeeDels, 'pourover_lbs_received', 'pourover_lbs_onhand'),
  };

  // Whole milk stock (gallons → ml)
  const milkDels = db.prepare(
    'SELECT * FROM milk_deliveries WHERE delivery_date >= ? AND delivery_date <= ? ORDER BY delivery_date ASC'
  ).all(start_date, end_date);

  let milkWholeStock = 0;
  if (milkDels.length > 0) {
    const first = milkDels[0];
    milkWholeStock = (first.whole_bottles_onhand + first.whole_bottles_received) * GALLONS_TO_ML;
    for (let i = 1; i < milkDels.length; i++) milkWholeStock += milkDels[i].whole_bottles_received * GALLONS_TO_ML;
  }

  // Numilk stock = daily rate × days in period
  const milkOatStock    = oatLitersPerDay    * days * 1000;
  const milkAlmondStock = almondLitersPerDay * days * 1000;

  // Actual remaining from closing delivery on_hand (null if cycle still open)
  const actualRemaining = {
    espresso: closingCoffeeDel ? closingCoffeeDel.espresso_lbs_onhand * LBS_TO_GRAMS : null,
    drip:     closingCoffeeDel ? closingCoffeeDel.drip_lbs_onhand     * LBS_TO_GRAMS : null,
    coldbrew: closingCoffeeDel ? closingCoffeeDel.coldbrew_lbs_onhand * LBS_TO_GRAMS : null,
    pourover: closingCoffeeDel ? closingCoffeeDel.pourover_lbs_onhand * LBS_TO_GRAMS : null,
    milk_whole: closingMilkDel ? closingMilkDel.whole_bottles_onhand * GALLONS_TO_ML : null,
  };

  const cycleOpen = !closingCoffeeDel;
  const eff = (stocked, used, actualRem) =>
    calcEfficiency({ stocked, used, actualRemaining: actualRem, cycleOpen });

  return {
    period: { start_date, end_date, days },
    total_orders: itemList.reduce((s, o) => s + o.qty, 0),
    matched, unmatched,
    modifier_counts: modifiers,
    milk_used: milkUsed,
    numilk_produced: {
      oat_ml:    milkOatStock,
      almond_ml: milkAlmondStock,
      days,
      oat_liters_per_day:    oatLitersPerDay,
      almond_liters_per_day: almondLitersPerDay,
    },
    cycle_open: cycleOpen,
    closing_delivery_date: closingCoffeeDel?.delivery_date || null,
    eff: {
      espresso:    eff(stock.espresso,    coffeeUsed.espresso,  actualRemaining.espresso),
      drip:        eff(stock.drip,        coffeeUsed.drip,      actualRemaining.drip),
      coldbrew:    eff(stock.coldbrew,    coffeeUsed.coldbrew,  actualRemaining.coldbrew),
      pourover:    eff(stock.pourover,    coffeeUsed.pourover,  actualRemaining.pourover),
      milk_whole:  eff(milkWholeStock,    milkUsed.whole,       actualRemaining.milk_whole),
      milk_oat:    eff(milkOatStock,      milkUsed.oat,         null),
      milk_almond: eff(milkAlmondStock,   milkUsed.almond,      null),
    },
  };
}

app.post('/api/analytics', async (req, res) => {
  try {
    const { start_date, end_date } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
    res.json(await computeAnalytics(start_date, end_date));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Recipes CRUD ─────────────────────────────────────────────────────────────
app.get('/api/recipes', (req, res) => res.json(db.prepare('SELECT * FROM drink_recipes ORDER BY category, square_item_name').all()));

app.post('/api/recipes', (req, res) => {
  const { square_item_name, category, coffee_grams, milk_whole_ml, notes } = req.body;
  const r = db.prepare('INSERT INTO drink_recipes (square_item_name,category,coffee_grams,milk_whole_ml,notes,created_by) VALUES (?,?,?,?,?,?)')
    .run(square_item_name, category, coffee_grams, milk_whole_ml || 0, notes || null, req.user.username);
  res.json(db.prepare('SELECT * FROM drink_recipes WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/recipes/:id', (req, res) => {
  const { square_item_name, category, coffee_grams, milk_whole_ml, notes } = req.body;
  db.prepare(`UPDATE drink_recipes SET square_item_name=?,category=?,coffee_grams=?,milk_whole_ml=?,notes=?,updated_at=datetime('now') WHERE id=?`)
    .run(square_item_name, category, coffee_grams, milk_whole_ml || 0, notes || null, req.params.id);
  res.json(db.prepare('SELECT * FROM drink_recipes WHERE id=?').get(req.params.id));
});

app.delete('/api/recipes/:id', (req, res) => { db.prepare('DELETE FROM drink_recipes WHERE id=?').run(req.params.id); res.json({ success: true }); });

// ─── Coffee Deliveries CRUD ───────────────────────────────────────────────────
app.get('/api/coffee-deliveries', (req, res) => res.json(db.prepare('SELECT * FROM coffee_deliveries ORDER BY delivery_date DESC').all()));

app.post('/api/coffee-deliveries', (req, res) => {
  const { delivery_date,
    espresso_lbs_received, espresso_lbs_onhand,
    drip_lbs_received,     drip_lbs_onhand,
    coldbrew_lbs_received, coldbrew_lbs_onhand,
    pourover_lbs_received, pourover_lbs_onhand,
    notes } = req.body;
  const r = db.prepare(`INSERT INTO coffee_deliveries
    (delivery_date, espresso_lbs_received, espresso_lbs_onhand, drip_lbs_received, drip_lbs_onhand,
     coldbrew_lbs_received, coldbrew_lbs_onhand, pourover_lbs_received, pourover_lbs_onhand, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(delivery_date,
      espresso_lbs_received||0, espresso_lbs_onhand||0,
      drip_lbs_received||0,     drip_lbs_onhand||0,
      coldbrew_lbs_received||0, coldbrew_lbs_onhand||0,
      pourover_lbs_received||0, pourover_lbs_onhand||0,
      notes||null, req.user.username);
  res.json(db.prepare('SELECT * FROM coffee_deliveries WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/coffee-deliveries/:id', (req, res) => { db.prepare('DELETE FROM coffee_deliveries WHERE id=?').run(req.params.id); res.json({ success: true }); });

// ─── Milk Deliveries CRUD ─────────────────────────────────────────────────────
app.get('/api/milk-deliveries', (req, res) => res.json(db.prepare('SELECT * FROM milk_deliveries ORDER BY delivery_date DESC').all()));

app.post('/api/milk-deliveries', (req, res) => {
  const { delivery_date, whole_bottles_received, whole_bottles_onhand, notes } = req.body;
  const r = db.prepare('INSERT INTO milk_deliveries (delivery_date,whole_bottles_received,whole_bottles_onhand,notes,created_by) VALUES (?,?,?,?,?)')
    .run(delivery_date, whole_bottles_received||0, whole_bottles_onhand||0, notes||null, req.user.username);
  res.json(db.prepare('SELECT * FROM milk_deliveries WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/milk-deliveries/:id', (req, res) => { db.prepare('DELETE FROM milk_deliveries WHERE id=?').run(req.params.id); res.json({ success: true }); });

// ─── Coffee Orders ────────────────────────────────────────────────────────────
const ORDER_POOLS = [
  ['espresso_lbs', 'Espresso'],
  ['drip_lbs', 'Drip'],
  ['coldbrew_lbs', 'Cold Brew'],
  ['pourover_lbs', 'Pour-Over'],
];

function orderEmailHtml(order, shopName, items = []) {
  const rows = items.length
    ? items.map(i =>
      `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:13px;color:#3D3A34;">${i.coffee_name} — ${i.roast === 'espresso' ? 'Espresso' : 'Filter'} Roast</td>
        <td style="padding:10px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:13px;color:#1A1916;text-align:right;">${i.lbs} lbs</td>
      </tr>`).join('')
    : ORDER_POOLS
      .filter(([field]) => order[field] > 0)
      .map(([field, label]) =>
        `<tr>
          <td style="padding:10px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:13px;color:#3D3A34;">${label}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:13px;color:#1A1916;text-align:right;">${order[field]} lbs</td>
        </tr>`)
      .join('');
  const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return `
  <div style="max-width:520px;margin:0 auto;background:#F5EFE3;border:1px solid #DDD6CC;">
    <div style="background:#1A1916;padding:22px 26px;">
      <div style="font-family:Georgia,serif;font-size:18px;color:#F5EFE3;">Coffee Order</div>
      <div style="font-family:monospace;font-size:11px;color:#B8AFA3;letter-spacing:0.14em;text-transform:uppercase;margin-top:6px;">
        ${esc(shopName || 'Dose shop')} · ${esc(order.order_date)}
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="padding:10px 14px;background:#DDD6CC;font-family:monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#7A7268;text-align:left;">Pool</th>
        <th style="padding:10px 14px;background:#DDD6CC;font-family:monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#7A7268;text-align:right;">Quantity</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${order.notes ? `<div style="padding:14px 26px;font-family:monospace;font-size:12px;color:#3D3A34;border-top:1px solid #DDD6CC;">Notes: ${esc(order.notes)}</div>` : ''}
    <div style="padding:14px 26px;font-family:monospace;font-size:10px;color:#7A7268;border-top:1px solid #DDD6CC;">
      Sent automatically by Dose — coffee efficiency dashboard
    </div>
  </div>`;
}

async function sendOrderEmail(order, cfg, items = []) {
  const apiKey = getSecret('resend_api_key', 'RESEND_API_KEY');
  if (!apiKey) return { sent: false, reason: 'Email not configured — add a Resend API key on the Settings page. Order saved but not emailed.' };
  const to = (cfg.order_email_to || 'hello@boxxcoffee.com').trim();
  const from = (cfg.order_email_from || '').trim() || process.env.ORDER_EMAIL_FROM || 'Dose Orders <onboarding@resend.dev>';
  const shopName = (cfg.shop_name || '').trim();
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `Coffee order — ${shopName || 'Dose shop'} — ${order.order_date}`,
        html: orderEmailHtml(order, shopName, items),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, reason: data.message || `Email provider error (${res.status})` };
    return { sent: true, to };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// ─── Hub connection ──────────────────────────────────────────────────────────
function hubConn(cfg) {
  return {
    url: (cfg.hub_url || '').trim().replace(/\/+$/, '') || DEFAULT_HUB_URL,
    key: getSecret('hub_api_key', 'HUB_API_KEY'),
  };
}

async function hubFetch(cfg, path, opts = {}, timeoutMs = 6000) {
  const { url, key } = hubConn(cfg);
  if (!url || !key) throw new Error('Hub not configured');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, ...(opts.headers || {}) },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Hub error (${res.status})`);
      err.hubStatus = res.status; // present = the hub answered; absent = unreachable
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

// The shop's personalized price list, proxied so the hub API key never
// reaches the browser. Cached for 60s.
let catalogCache = { at: 0, data: null };
async function getHubCatalog(cfg, fresh = false) {
  if (!fresh && catalogCache.data && Date.now() - catalogCache.at < 60_000) return catalogCache.data;
  const data = await hubFetch(cfg, '/api/ingest/catalog');
  catalogCache = { at: Date.now(), data };
  return data;
}

app.get('/api/hub-catalog', async (req, res) => {
  const cfg = getSettings();
  const { url, key } = hubConn(cfg);
  if (!url || !key) return res.json({ configured: false, items: [] });
  try {
    const data = await getHubCatalog(cfg);
    res.json({ configured: true, currency: data.currency || '$', items: data.items || [] });
  } catch (err) {
    res.json({ configured: true, error: err.message, items: [] });
  }
});

// Push a sent order to the roastery hub. Email and hub are independent
// transports — the order is always saved locally first.
async function pushOrderToHub(order, cfg, items = []) {
  try {
    const body = {
      order_date: order.order_date,
      requested_date: order.requested_date || null,
      notes: order.notes, placed_by: order.created_by, source_order_id: order.id,
    };
    if (items.length) body.items = items.map(i => ({ coffee_id: i.coffee_id, roast: i.roast, lbs: i.lbs, bags: i.bags ?? undefined }));
    else {
      body.espresso_lbs = order.espresso_lbs; body.drip_lbs = order.drip_lbs;
      body.coldbrew_lbs = order.coldbrew_lbs; body.pourover_lbs = order.pourover_lbs;
    }
    const data = await hubFetch(cfg, '/api/ingest/orders', { method: 'POST', body: JSON.stringify(body) });
    return { pushed: true, receipt: data.receipt || null };
  } catch (err) {
    return { pushed: false, reason: err.message === 'Hub not configured' ? 'Hub not configured' : err.message };
  }
}

const orderWithItems = o => ({
  ...o,
  items: db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY roast, coffee_name').all(o.id),
});

// Reflect roastery confirmations (from the hub) into local hub_status.
async function syncHubStatuses(cfg) {
  const pending = db.prepare("SELECT id FROM coffee_orders WHERE hub_status IN ('sent','confirmed')").all().map(r => r.id);
  if (!pending.length) return;
  const statuses = await hubFetch(cfg, `/api/ingest/order-status?ids=${pending.join(',')}`, {}, 3000);
  const upd = db.prepare('UPDATE coffee_orders SET hub_status=? WHERE id=? AND hub_status IS NOT ?');
  for (const s of statuses) {
    const mapped = s.status === 'new' ? 'sent' : s.status; // hub 'new' = delivered-to-hub
    upd.run(mapped, s.source_order_id, mapped);
  }
}

app.get('/api/orders', async (req, res) => {
  const cfg = getSettings();
  await syncHubStatuses(cfg).catch(() => { /* hub unreachable — show last known */ });
  res.json(db.prepare('SELECT * FROM coffee_orders ORDER BY order_date DESC, id DESC').all().map(orderWithItems));
});

// Place a catalog (line-item) order: price from the hub's list, store
// locally, push to the hub. Used by the order form and the standing-order
// scheduler.
async function placeCatalogOrder({ order_date, requested_date, notes, rawItems, username }) {
  const cfg = getSettings();
  const catalog = await getHubCatalog(cfg, true);
  const priced = priceItemsFromCatalog(rawItems, catalog.items || []);

  const r = db.prepare(`INSERT INTO coffee_orders (order_date, requested_date, total_lbs, total_cost, notes, created_by)
    VALUES (?,?,?,?,?,?)`)
    .run(order_date, requested_date || null, priced.total_lbs, priced.total_cost, notes || null, username);
  const ins = db.prepare('INSERT INTO order_items (order_id, coffee_id, coffee_name, roast, lbs, bags, price_per_lb, line_total) VALUES (?,?,?,?,?,?,?,?)');
  for (const i of priced.items) ins.run(r.lastInsertRowid, i.coffee_id, i.coffee_name, i.roast, i.lbs, i.bags ?? null, i.price_per_lb, i.line_total);
  const order = db.prepare('SELECT * FROM coffee_orders WHERE id=?').get(r.lastInsertRowid);

  // The hub emails the receipt itself; shop-side email is only the fallback
  // when the push fails.
  const hub = await pushOrderToHub(order, cfg, priced.items);
  let email = null;
  if (!hub.pushed) email = await sendOrderEmail(order, cfg, priced.items);

  db.prepare('UPDATE coffee_orders SET status=?, sent_to=?, sent_at=?, hub_status=? WHERE id=?')
    .run((hub.pushed || email?.sent) ? 'sent' : 'email_failed',
         email?.sent ? email.to : null,
         (hub.pushed || email?.sent) ? new Date().toISOString() : null,
         hub.pushed ? 'sent' : 'failed',
         order.id);

  return { order: orderWithItems(db.prepare('SELECT * FROM coffee_orders WHERE id=?').get(order.id)), hub, email };
}

app.post('/api/orders', async (req, res) => {
  try {
    const { order_date, requested_date, notes, items: rawItems } = req.body;
    if (!order_date) return res.status(400).json({ error: 'order_date required' });
    const cfg = getSettings();

    // ── Catalog order: line items priced from the hub's price list ──
    if (Array.isArray(rawItems) && rawItems.length) {
      try {
        return res.json(await placeCatalogOrder({ order_date, requested_date, notes, rawItems, username: req.user.username }));
      } catch (err) {
        const gateway = /Could not|Hub error|abort|network|fetch failed|Hub not configured/i.test(err.message);
        return res.status(gateway ? 502 : 400).json({ error: err.message });
      }
    }

    // ── Legacy pool-based order (no hub catalog connected) ──
    const qty = {
      espresso_lbs: Math.max(0, parseFloat(req.body.espresso_lbs) || 0),
      drip_lbs:     Math.max(0, parseFloat(req.body.drip_lbs)     || 0),
      coldbrew_lbs: Math.max(0, parseFloat(req.body.coldbrew_lbs) || 0),
      pourover_lbs: Math.max(0, parseFloat(req.body.pourover_lbs) || 0),
    };
    if (Object.values(qty).every(v => v === 0))
      return res.status(400).json({ error: 'Order must include at least one quantity' });

    const totalLbs = Math.round(Object.values(qty).reduce((s, v) => s + v, 0) * 10) / 10;
    const r = db.prepare(`INSERT INTO coffee_orders (order_date, requested_date, espresso_lbs, drip_lbs, coldbrew_lbs, pourover_lbs, total_lbs, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(order_date, requested_date || null, qty.espresso_lbs, qty.drip_lbs, qty.coldbrew_lbs, qty.pourover_lbs, totalLbs, notes || null, req.user.username);
    const order = db.prepare('SELECT * FROM coffee_orders WHERE id=?').get(r.lastInsertRowid);

    const [email, hub] = await Promise.all([sendOrderEmail(order, cfg), pushOrderToHub(order, cfg)]);
    db.prepare('UPDATE coffee_orders SET status=?, sent_to=?, sent_at=?, hub_status=? WHERE id=?')
      .run((email.sent || hub.pushed) ? 'sent' : 'email_failed',
           email.sent ? email.to : null,
           (email.sent || hub.pushed) ? new Date().toISOString() : null,
           hub.pushed ? 'sent' : (hub.reason === 'Hub not configured' ? null : 'failed'),
           order.id);

    res.json({ order: orderWithItems(db.prepare('SELECT * FROM coffee_orders WHERE id=?').get(order.id)), email, hub });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/orders/:id', (req, res) => {
  db.prepare('DELETE FROM order_items WHERE order_id=?').run(req.params.id);
  db.prepare('DELETE FROM coffee_orders WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ─── Standing orders ─────────────────────────────────────────────────────────
// A saved order that places itself on a schedule. Dates are calendar-based:
// weekly +7d, biweekly +14d, monthly +1 month.
function advanceDate(dateStr, frequency) {
  const d = new Date(dateStr + 'T12:00:00Z');
  if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (frequency === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

const standingOrderPublic = s => ({
  id: s.id, frequency: s.frequency, items: JSON.parse(s.items_json), notes: s.notes,
  next_date: s.next_date, active: !!s.active, created_by: s.created_by, created_at: s.created_at,
});

app.get('/api/standing-orders', (req, res) =>
  res.json(db.prepare('SELECT * FROM standing_orders WHERE active=1 ORDER BY next_date').all().map(standingOrderPublic)));

app.post('/api/standing-orders', async (req, res) => {
  try {
    const { frequency, items, notes, start_date } = req.body || {};
    if (!['weekly', 'biweekly', 'monthly'].includes(frequency)) return res.status(400).json({ error: 'Frequency must be weekly, biweekly, or monthly' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Standing order needs at least one item' });
    // Validate items against the current catalog so broken standing orders
    // can't be created.
    const catalog = await getHubCatalog(getSettings(), true);
    priceItemsFromCatalog(items, catalog.items || []);
    const today = new Date().toISOString().slice(0, 10);
    const nextDate = (start_date && start_date > today) ? start_date : advanceDate(today, frequency);
    const r = db.prepare('INSERT INTO standing_orders (frequency, items_json, notes, next_date, created_by) VALUES (?,?,?,?,?)')
      .run(frequency, JSON.stringify(items), notes || null, nextDate, req.user.username);
    res.json(standingOrderPublic(db.prepare('SELECT * FROM standing_orders WHERE id=?').get(r.lastInsertRowid)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/standing-orders/:id', (req, res) => {
  db.prepare('UPDATE standing_orders SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Scheduler: hourly, place any standing order that has come due. The order is
// stamped with who set the schedule up; failures still advance the date (the
// saved order shows a failed status rather than retry-storming the hub).
async function runStandingOrders() {
  const today = new Date().toISOString().slice(0, 10);
  const due = db.prepare('SELECT * FROM standing_orders WHERE active=1 AND next_date <= ?').all(today);
  for (const so of due) {
    try {
      await placeCatalogOrder({
        order_date: today,
        requested_date: null,
        notes: so.notes ? `${so.notes} (standing order)` : 'standing order',
        rawItems: JSON.parse(so.items_json),
        username: `${so.created_by || 'standing'} ⟳`,
      });
      console.log(`Standing order #${so.id} placed`);
    } catch (err) {
      console.error(`Standing order #${so.id} failed: ${err.message}`);
    }
    db.prepare('UPDATE standing_orders SET next_date=? WHERE id=?').run(advanceDate(so.next_date, so.frequency), so.id);
  }
}
setTimeout(runStandingOrders, 15_000);
setInterval(runStandingOrders, 60 * 60 * 1000).unref();

// Suggested order quantities from the current open cycle's burn rate.
app.get('/api/order-suggestion', async (req, res) => {
  try {
    const last = db.prepare('SELECT * FROM coffee_deliveries ORDER BY delivery_date DESC LIMIT 1').get();
    if (!last) return res.json({ available: false, reason: 'No deliveries logged yet' });
    const today = new Date().toISOString().slice(0, 10);
    const a = await computeAnalytics(last.delivery_date, today);
    const horizonDays = 7;
    const pools = {};
    for (const p of ['espresso', 'drip', 'coldbrew', 'pourover']) {
      const e = a.eff[p];
      const days = Math.max(1, a.period.days);
      pools[p] = {
        used_g: e.used,
        burn_g_per_day: Math.round(e.used / days),
        expected_remaining_g: e.theoretical_remaining,
        suggested_lbs: suggestOrderLbs({
          usedGrams: e.used, days,
          expectedRemainingGrams: e.theoretical_remaining, horizonDays,
        }),
      };
    }
    res.json({ available: true, since: last.delivery_date, days: a.period.days, horizon_days: horizonDays, pools });
  } catch (err) {
    res.json({ available: false, reason: err.message });
  }
});

// ─── PDF Report ──────────────────────────────────────────────────────────────
app.post('/api/report', async (req, res) => {
  try {
    const { start_date, end_date } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });

    const analytics = await computeAnalytics(start_date, end_date);

    const coffeeDels = db.prepare(
      'SELECT * FROM coffee_deliveries WHERE delivery_date >= ? AND delivery_date <= ? ORDER BY delivery_date ASC'
    ).all(start_date, end_date);

    const milkDels = db.prepare(
      'SELECT * FROM milk_deliveries WHERE delivery_date >= ? AND delivery_date <= ? ORDER BY delivery_date ASC'
    ).all(start_date, end_date);

    const doc = generateReport({ analytics, coffeeDels, milkDels, startDate: start_date, endDate: end_date });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="dose-report-${start_date}-${end_date}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Seed recipes if empty ────────────────────────────────────────────────────
if (db.prepare('SELECT COUNT(*) as n FROM drink_recipes').get().n === 0) {
  const ins = db.prepare('INSERT INTO drink_recipes (square_item_name,category,coffee_grams,milk_whole_ml,notes) VALUES (?,?,?,?,?)');
  [
    ['Americano','espresso',18,0,'single'],
    ['Caffe Latte','espresso',18,240,'12oz'],
    ['Cappuccino','espresso',18,120,'6oz'],
    ['Cortado','espresso',18,60,''],
    ['Espresso','espresso',18,0,'all variations'],
    ['Espresso Macchiato','espresso',18,0,''],
    ['Extra Shot','espresso',18,0,''],
    ['Flat White','espresso',18,150,''],
    ['Batch Brew','drip',24.4,0,'110g / 4.5 cups'],
    ['Cafe Au Lait','drip',24.4,0,'pulls from batch brew stock'],
    ['Cold Brew','coldbrew',26.2,0,'4kg / 20x1.8L bottles, 8oz serve'],
    ['Pour Over','pourover',19,0,'single brew — all bean variations'],
    ['Turkish Coffee','pourover',7.5,0,'deducted from pour-over pool'],
  ].forEach(r => ins.run(...r));
  console.log('Seeded default recipes');
}

// ─── Serve frontend ───────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/build')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/build/index.html')));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Dose backend running on port ${PORT}`));
