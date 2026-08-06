// Dose Hub — the roastery-side service. Client shops push their coffee orders
// here (authenticated by a per-shop API key); the roastery logs in to work the
// orders inbox, browse per-shop history, and see ordering patterns.
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json());

const dbPath = process.env.HUB_DB_PATH || '/app/data/hub.db';
require('fs').mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL REFERENCES shops(id),
    order_date TEXT NOT NULL,
    espresso_lbs REAL DEFAULT 0,
    drip_lbs REAL DEFAULT 0,
    coldbrew_lbs REAL DEFAULT 0,
    pourover_lbs REAL DEFAULT 0,
    notes TEXT,
    placed_by TEXT,
    source_order_id INTEGER,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','confirmed','delivered')),
    received_at TEXT DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_dedupe ON orders(shop_id, source_order_id);

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const SESSION_DAYS = 30;

// ─── Roastery auth (shared password from HUB_PASSWORD) ───────────────────────
const HUB_PASSWORD = process.env.HUB_PASSWORD || '';
if (!HUB_PASSWORD) console.warn('WARNING: HUB_PASSWORD is not set — the hub dashboard cannot be logged into until it is.');

function safeEqual(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest()
  );
}

function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, expires_at) VALUES (?, datetime('now', '+${SESSION_DAYS} days'))`)
    .run(sha256(token));
  return token;
}

function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at IS NULL OR expires_at <= datetime('now')").run();
}
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();

// Login rate limiting (same escalating-lockout scheme as the shop app)
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

app.post('/api/login', (req, res) => {
  if (!HUB_PASSWORD) return res.status(503).json({ error: 'HUB_PASSWORD not configured on the server' });
  const key = `ip:${req.ip}`;
  const wait = lockedFor(key);
  if (wait > 0) return res.status(429).json({ error: `Too many attempts — try again in ${wait}s` });
  if (!safeEqual((req.body && req.body.password) || '', HUB_PASSWORD)) {
    recordFailure(key);
    return res.status(401).json({ error: 'Wrong password' });
  }
  loginFailures.delete(key);
  res.json({ ok: true, token: issueToken() });
});

// ─── Shop ingest (per-shop API key) — must come BEFORE the dashboard gate ────
app.post('/api/ingest/orders', (req, res) => {
  const auth = req.get('authorization') || '';
  const apiKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const shop = apiKey && db.prepare('SELECT * FROM shops WHERE api_key_hash=?').get(sha256(apiKey));
  if (!shop) return res.status(401).json({ error: 'Invalid shop API key' });

  const b = req.body || {};
  if (!b.order_date) return res.status(400).json({ error: 'order_date required' });
  const qty = {};
  for (const k of ['espresso_lbs', 'drip_lbs', 'coldbrew_lbs', 'pourover_lbs']) qty[k] = Math.max(0, parseFloat(b[k]) || 0);
  if (Object.values(qty).every(v => v === 0)) return res.status(400).json({ error: 'Order has no quantities' });

  try {
    const r = db.prepare(`INSERT INTO orders (shop_id, order_date, espresso_lbs, drip_lbs, coldbrew_lbs, pourover_lbs, notes, placed_by, source_order_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(shop.id, String(b.order_date), qty.espresso_lbs, qty.drip_lbs, qty.coldbrew_lbs, qty.pourover_lbs,
           b.notes ? String(b.notes).slice(0, 500) : null,
           b.placed_by ? String(b.placed_by).slice(0, 64) : null,
           b.source_order_id != null ? parseInt(b.source_order_id, 10) : null);
    res.json({ ok: true, hub_order_id: r.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.json({ ok: true, duplicate: true });
    throw err;
  }
});

// ─── Dashboard auth gate ──────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path.startsWith('/ingest/')) return next();
  const token = req.get('x-hub-key') || '';
  if (token && db.prepare("SELECT token FROM sessions WHERE token=? AND expires_at > datetime('now')").get(sha256(token))) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// ─── Shops management ─────────────────────────────────────────────────────────
const shopWithStats = s => ({
  id: s.id, name: s.name, created_at: s.created_at,
  orders_count: db.prepare('SELECT COUNT(*) n FROM orders WHERE shop_id=?').get(s.id).n,
  last_order_date: db.prepare('SELECT MAX(order_date) d FROM orders WHERE shop_id=?').get(s.id).d,
});

app.get('/api/shops', (req, res) => {
  res.json(db.prepare('SELECT * FROM shops ORDER BY name').all().map(shopWithStats));
});

// Creates a shop and returns its API key ONCE — only the hash is stored.
app.post('/api/shops', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Shop name required (2+ characters)' });
  const apiKey = 'dose_' + crypto.randomBytes(24).toString('hex');
  try {
    const r = db.prepare('INSERT INTO shops (name, api_key_hash) VALUES (?,?)').run(name, sha256(apiKey));
    res.json({ shop: shopWithStats(db.prepare('SELECT * FROM shops WHERE id=?').get(r.lastInsertRowid)), api_key: apiKey });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(400).json({ error: 'A shop with that name already exists' });
    throw err;
  }
});

// Rotate a shop's API key (old key stops working immediately).
app.post('/api/shops/:id/rotate-key', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const apiKey = 'dose_' + crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE shops SET api_key_hash=? WHERE id=?').run(sha256(apiKey), shop.id);
  res.json({ ok: true, api_key: apiKey });
});

// ─── Orders inbox ─────────────────────────────────────────────────────────────
app.get('/api/orders', (req, res) => {
  const clauses = [], params = [];
  if (req.query.shop_id) { clauses.push('o.shop_id=?'); params.push(req.query.shop_id); }
  if (req.query.status)  { clauses.push('o.status=?');  params.push(req.query.status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  res.json(db.prepare(
    `SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id
     ${where} ORDER BY o.received_at DESC, o.id DESC LIMIT 500`
  ).all(...params));
});

app.patch('/api/orders/:id', (req, res) => {
  const status = (req.body && req.body.status) || '';
  if (!['new', 'confirmed', 'delivered'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const r = db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Order not found' });
  res.json(db.prepare('SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=?').get(req.params.id));
});

// ─── Patterns ─────────────────────────────────────────────────────────────────
// Per shop: totals, pool mix, ordering cadence, and a 12-week volume series.
app.get('/api/analytics', (req, res) => {
  const shops = db.prepare('SELECT * FROM shops ORDER BY name').all();
  const out = shops.map(s => {
    const totals = db.prepare(
      `SELECT COUNT(*) orders_count,
              COALESCE(SUM(espresso_lbs),0) espresso, COALESCE(SUM(drip_lbs),0) drip,
              COALESCE(SUM(coldbrew_lbs),0) coldbrew, COALESCE(SUM(pourover_lbs),0) pourover,
              MIN(order_date) first_order, MAX(order_date) last_order
       FROM orders WHERE shop_id=?`
    ).get(s.id);
    // Average days between orders
    const dates = db.prepare('SELECT DISTINCT order_date FROM orders WHERE shop_id=? ORDER BY order_date').all(s.id).map(r => r.order_date);
    let avgInterval = null;
    if (dates.length >= 2) {
      const spanDays = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000;
      avgInterval = Math.round(spanDays / (dates.length - 1) * 10) / 10;
    }
    // Weekly total lbs, last 12 weeks
    const weekly = db.prepare(
      `SELECT strftime('%Y-%W', order_date) week,
              COALESCE(SUM(espresso_lbs + drip_lbs + coldbrew_lbs + pourover_lbs),0) lbs
       FROM orders WHERE shop_id=? AND order_date >= date('now', '-84 days')
       GROUP BY week ORDER BY week`
    ).all(s.id);
    return {
      shop_id: s.id, shop_name: s.name,
      orders_count: totals.orders_count,
      total_lbs: Math.round((totals.espresso + totals.drip + totals.coldbrew + totals.pourover) * 10) / 10,
      by_pool: { espresso: totals.espresso, drip: totals.drip, coldbrew: totals.coldbrew, pourover: totals.pourover },
      first_order: totals.first_order, last_order: totals.last_order,
      avg_interval_days: avgInterval,
      weekly,
    };
  });
  res.json(out);
});

// ─── Static dashboard ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Dose Hub running on port ${PORT}`));
