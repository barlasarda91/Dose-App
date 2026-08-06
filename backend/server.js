require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const path = require('path');
const { generateReport } = require('./report');
const { LBS_TO_GRAMS, GALLONS_TO_ML, aggregateOrders, calcCoffeeStock, calcEfficiency, suggestOrderLbs } = require('./calc');

const app = express();
// Same-origin in production (frontend is served by this server) — CORS headers
// are only needed for the dev server proxy setup.
if (process.env.NODE_ENV !== 'production') app.use(cors());
app.use(express.json());

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
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(normUsername(username));
  const salt = u ? u.salt : DUMMY.salt;
  const expected = u ? u.password_hash : DUMMY.hash;
  const { hash } = await hashPassword(password, salt);
  const ok = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
  return (u && ok) ? u : null;
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
if (!usersExist()) {
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
  const setup = !usersExist();
  res.json({ setup_required: setup, setup_code_required: setup });
});

// First run only: create the admin account. Requires the setup code from the
// server logs.
app.post('/api/setup', asyncRoute(async (req, res) => {
  if (usersExist()) return res.status(400).json({ error: 'Already set up — use login' });
  const { username, password, setup_code } = req.body || {};
  if (!setupCode || !crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(setup_code || '')).digest(),
    crypto.createHash('sha256').update(setupCode).digest()
  )) return res.status(403).json({ error: 'Wrong setup code — find it in the server logs (Railway → Deployments → View Logs)' });
  const uname = normUsername(username);
  if (!USERNAME_RE.test(uname)) return res.status(400).json({ error: 'Username: 3–32 chars, letters/numbers/._- only' });
  if (String(password || '').length < PASSWORD_MIN.admin) return res.status(400).json({ error: passwordPolicyError('admin') });
  const u = await createUser(uname, password, 'admin');
  setupCode = null;
  res.json({ ok: true, token: issueToken(u.id), user: publicUser(u) });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  if (!usersExist()) return res.status(409).json({ error: 'Setup required' });
  const { username, password } = req.body || {};
  const ipKey = `ip:${req.ip}`;
  const userKey = `u:${normUsername(username)}`;
  const wait = Math.max(lockedFor(ipKey), lockedFor(userKey));
  if (wait > 0) return res.status(429).json({ error: `Too many attempts — try again in ${wait}s` });
  const u = await verifyUser(username, password || '');
  if (!u) {
    recordFailure(ipKey); recordFailure(userKey);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  clearFailures(ipKey, userKey);
  res.json({ ok: true, token: issueToken(u.id), user: publicUser(u) });
}));

app.get('/api/me', (req, res) => res.json(req.user));

// Change your own password; signs out your other sessions.
app.post('/api/change-password', asyncRoute(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
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
const SECRET_SETTINGS = ['square_access_token', 'resend_api_key'];
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
  s.password_protected = true; // login is always required
  res.json(s);
});

app.post('/api/settings', (req, res) => {
  // Day-to-day settings are open to any user; credentials are admin-only.
  const ADMIN_ONLY = [...SECRET_SETTINGS, 'order_email_to', 'order_email_from', 'square_location_id'];
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

function orderEmailHtml(order, shopName) {
  const rows = ORDER_POOLS
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

async function sendOrderEmail(order, cfg) {
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
        html: orderEmailHtml(order, shopName),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, reason: data.message || `Email provider error (${res.status})` };
    return { sent: true, to };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

app.get('/api/orders', (req, res) =>
  res.json(db.prepare('SELECT * FROM coffee_orders ORDER BY order_date DESC, id DESC').all()));

app.post('/api/orders', async (req, res) => {
  try {
    const { order_date, espresso_lbs, drip_lbs, coldbrew_lbs, pourover_lbs, notes } = req.body;
    if (!order_date) return res.status(400).json({ error: 'order_date required' });
    const qty = {
      espresso_lbs: Math.max(0, parseFloat(espresso_lbs) || 0),
      drip_lbs:     Math.max(0, parseFloat(drip_lbs)     || 0),
      coldbrew_lbs: Math.max(0, parseFloat(coldbrew_lbs) || 0),
      pourover_lbs: Math.max(0, parseFloat(pourover_lbs) || 0),
    };
    if (Object.values(qty).every(v => v === 0))
      return res.status(400).json({ error: 'Order must include at least one pool quantity' });

    const cfg = getSettings();
    const r = db.prepare(`INSERT INTO coffee_orders (order_date, espresso_lbs, drip_lbs, coldbrew_lbs, pourover_lbs, notes, created_by)
      VALUES (?,?,?,?,?,?,?)`)
      .run(order_date, qty.espresso_lbs, qty.drip_lbs, qty.coldbrew_lbs, qty.pourover_lbs, notes || null, req.user.username);
    const order = db.prepare('SELECT * FROM coffee_orders WHERE id=?').get(r.lastInsertRowid);

    const email = await sendOrderEmail(order, cfg);
    db.prepare('UPDATE coffee_orders SET status=?, sent_to=?, sent_at=? WHERE id=?')
      .run(email.sent ? 'sent' : 'email_failed', email.sent ? email.to : null,
           email.sent ? new Date().toISOString() : null, order.id);

    res.json({ order: db.prepare('SELECT * FROM coffee_orders WHERE id=?').get(order.id), email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/orders/:id', (req, res) => { db.prepare('DELETE FROM coffee_orders WHERE id=?').run(req.params.id); res.json({ success: true }); });

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
