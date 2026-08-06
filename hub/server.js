// Dose Hub — the roastery-side service. Holds the coffee catalog and price
// rules, receives orders from client shops (per-shop API keys), sends receipt
// and confirmation emails, and serves the roastery dashboard: orders inbox,
// shops, catalog, and patterns.
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const { catalogForShop, priceOrderItems } = require('./pricing');

const app = express();
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
    badge TEXT DEFAULT '',
    low_stock INTEGER DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'standard' CHECK(visibility IN ('standard','exclusive')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
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
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','confirmed','delivered')),
    received_at TEXT DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_dedupe ON orders(shop_id, source_order_id);

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    coffee_id INTEGER,
    coffee_name TEXT NOT NULL,
    roast TEXT NOT NULL CHECK(roast IN ('espresso','filter')),
    lbs REAL NOT NULL,
    price_per_lb REAL NOT NULL,
    line_total REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Databases created before this version predate some columns.
try { db.exec('ALTER TABLE shops ADD COLUMN email TEXT'); } catch { /* present */ }
for (const col of ['login_username TEXT', 'password_hash TEXT', 'salt TEXT']) {
  try { db.exec(`ALTER TABLE shops ADD COLUMN ${col}`); } catch { /* present */ }
}
for (const col of ['requested_date TEXT', 'total_lbs REAL DEFAULT 0', 'total_cost REAL']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* present */ }
}

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

// ─── Email (Resend) ───────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'RESEND_API_KEY not set on the hub' };
  if (!to) return { sent: false, reason: 'No recipient email registered for this shop' };
  const from = process.env.HUB_EMAIL_FROM || 'Dose Hub <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, reason: data.message || `Email provider error (${res.status})` };
    return { sent: true, to };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function orderEmailHtml(order, items, shop, headline, sub) {
  const roastLabel = r => r === 'espresso' ? 'Espresso Roast' : 'Filter Roast';
  const rows = items.length
    ? items.map(i =>
      `<tr>
        <td style="padding:9px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:12px;color:#3D3A34;">${esc(i.coffee_name)}<br><span style="font-size:10px;color:#7A7268;">${roastLabel(i.roast)}</span></td>
        <td style="padding:9px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:12px;color:#1A1916;text-align:right;">${i.lbs} lbs</td>
        <td style="padding:9px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:12px;color:#7A7268;text-align:right;">${money(i.price_per_lb)}/lb</td>
        <td style="padding:9px 14px;border-bottom:1px solid #DDD6CC;font-family:monospace;font-size:12px;color:#1A1916;text-align:right;">${money(i.line_total)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" style="padding:9px 14px;font-family:monospace;font-size:12px;color:#3D3A34;">
        ${['espresso_lbs', 'drip_lbs', 'coldbrew_lbs', 'pourover_lbs'].filter(f => order[f] > 0).map(f => `${f.replace('_lbs', '')}: ${order[f]} lbs`).join(' · ')}
      </td></tr>`;
  return `
  <div style="max-width:560px;margin:0 auto;background:#F5EFE3;border:1px solid #DDD6CC;">
    <div style="background:#1A1916;padding:22px 26px;">
      <div style="font-family:Georgia,serif;font-size:18px;color:#F5EFE3;">${esc(headline)}</div>
      <div style="font-family:monospace;font-size:11px;color:#B8AFA3;letter-spacing:0.14em;text-transform:uppercase;margin-top:6px;">
        ${esc(shop.name)} · placed ${esc(order.order_date)}${order.requested_date ? ` · requested ${esc(order.requested_date)}` : ''}
      </div>
    </div>
    ${sub ? `<div style="padding:14px 26px;font-family:monospace;font-size:12px;color:#3D3A34;border-bottom:1px solid #DDD6CC;">${esc(sub)}</div>` : ''}
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
    <div style="padding:14px 26px;font-family:monospace;font-size:10px;color:#7A7268;border-top:1px solid #DDD6CC;">
      Dose Hub · Boxx Coffee Roasters Co.
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
  res.json({ currency: CURRENCY, items: shopCatalog(shop.id) });
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
      const ins = db.prepare('INSERT INTO order_items (order_id, coffee_id, coffee_name, roast, lbs, price_per_lb, line_total) VALUES (?,?,?,?,?,?,?)');
      for (const i of priced.items) ins.run(orderId, i.coffee_id, i.coffee_name, i.roast, i.lbs, i.price_per_lb, i.line_total);
    }

    // Receipt email to the shop's registered address; copy to the roastery.
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
    const receipt = await sendEmail(shop.email, `Order received — ${shop.name} — ${order.order_date}`,
      orderEmailHtml(order, items, shop, 'Order Received', 'Your order has been received by the roastery. You will get another email when it is confirmed.'));
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

// ─── Dashboard auth gate ──────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path.startsWith('/ingest/')) return next();
  const token = req.get('x-hub-key') || '';
  if (token && db.prepare("SELECT token FROM sessions WHERE token=? AND expires_at > datetime('now')").get(sha256(token))) return next();
  res.status(401).json({ error: 'Unauthorized' });
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
    badge: BADGES.includes(b.badge) ? b.badge : '',
    low_stock: b.low_stock ? 1 : 0,
    visibility: b.visibility === 'exclusive' ? 'exclusive' : 'standard',
    shopIds: Array.isArray(b.exclusive_shop_ids) ? b.exclusive_shop_ids.map(n => parseInt(n, 10)).filter(Number.isFinite) : [],
    active: b.active === undefined ? 1 : (b.active ? 1 : 0),
  };
}

app.post('/api/catalog', (req, res) => {
  const v = saveCatalogBody(req.body || {});
  if (v.name.length < 2) return res.status(400).json({ error: 'Coffee name required' });
  const r = db.prepare('INSERT INTO catalog (name, notes, price_per_lb, badge, low_stock, visibility, active) VALUES (?,?,?,?,?,?,?)')
    .run(v.name, v.notes, v.price, v.badge, v.low_stock, v.visibility, v.active);
  const setGrants = db.prepare('INSERT INTO catalog_visibility (coffee_id, shop_id) VALUES (?,?)');
  if (v.visibility === 'exclusive') for (const sid of v.shopIds) setGrants.run(r.lastInsertRowid, sid);
  res.json(catalogItemFull(r.lastInsertRowid));
});

app.put('/api/catalog/:id', (req, res) => {
  if (!db.prepare('SELECT id FROM catalog WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const v = saveCatalogBody(req.body || {});
  if (v.name.length < 2) return res.status(400).json({ error: 'Coffee name required' });
  db.prepare('UPDATE catalog SET name=?, notes=?, price_per_lb=?, badge=?, low_stock=?, visibility=?, active=? WHERE id=?')
    .run(v.name, v.notes, v.price, v.badge, v.low_stock, v.visibility, v.active, req.params.id);
  db.prepare('DELETE FROM catalog_visibility WHERE coffee_id=?').run(req.params.id);
  if (v.visibility === 'exclusive') {
    const ins = db.prepare('INSERT INTO catalog_visibility (coffee_id, shop_id) VALUES (?,?)');
    for (const sid of v.shopIds) ins.run(req.params.id, sid);
  }
  res.json(catalogItemFull(req.params.id));
});

// ─── Shops management ─────────────────────────────────────────────────────────
const shopWithStats = s => ({
  id: s.id, name: s.name, email: s.email, login_username: s.login_username,
  has_password: !!s.password_hash, created_at: s.created_at,
  orders_count: db.prepare('SELECT COUNT(*) n FROM orders WHERE shop_id=?').get(s.id).n,
  last_order_date: db.prepare('SELECT MAX(order_date) d FROM orders WHERE shop_id=?').get(s.id).d,
});

app.get('/api/shops', (req, res) => {
  res.json(db.prepare('SELECT * FROM shops ORDER BY name').all().map(shopWithStats));
});

// Creating a shop creates its ACCOUNT: login username (from the name),
// registered email, password, and API key (returned once).
app.post('/api/shops', async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    const email = String((req.body && req.body.email) || '').trim() || null;
    const password = (req.body && req.body.password) || '';
    if (name.length < 2) return res.status(400).json({ error: 'Shop name required (2+ characters)' });
    if (String(password).length < SHOP_PASSWORD_MIN)
      return res.status(400).json({ error: `Login password required (min ${SHOP_PASSWORD_MIN} characters)` });
    const apiKey = 'dose_' + crypto.randomBytes(24).toString('hex');
    const loginUsername = genLoginUsername(name);
    const { salt, hash } = await hashPassword(password);
    const r = db.prepare('INSERT INTO shops (name, email, api_key_hash, login_username, password_hash, salt) VALUES (?,?,?,?,?,?)')
      .run(name, email, sha256(apiKey), loginUsername, hash, salt);
    res.json({ shop: shopWithStats(db.prepare('SELECT * FROM shops WHERE id=?').get(r.lastInsertRowid)), api_key: apiKey });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(400).json({ error: 'A shop with that name already exists' });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Set or reset a shop's login password (also backfills the login username
// for shops created before accounts existed).
app.post('/api/shops/:id/reset-login', async (req, res) => {
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
    if (!shop) return res.status(404).json({ error: 'Shop not found' });
    const password = (req.body && req.body.new_password) || '';
    if (String(password).length < SHOP_PASSWORD_MIN)
      return res.status(400).json({ error: `Password must be at least ${SHOP_PASSWORD_MIN} characters` });
    const loginUsername = shop.login_username || genLoginUsername(shop.name);
    const { salt, hash } = await hashPassword(password);
    db.prepare('UPDATE shops SET login_username=?, password_hash=?, salt=? WHERE id=?').run(loginUsername, hash, salt, shop.id);
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

app.post('/api/shops/:id/rotate-key', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const apiKey = 'dose_' + crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE shops SET api_key_hash=? WHERE id=?').run(sha256(apiKey), shop.id);
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
app.put('/api/shops/:id/pricing', (req, res) => {
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
  if (!['new', 'confirmed', 'delivered'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const before = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Order not found' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, req.params.id);

  // Confirming an order notifies the shop by email.
  let email = null;
  if (status === 'confirmed' && before.status !== 'confirmed') {
    const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(before.shop_id);
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
    email = await sendEmail(shop.email, `Order confirmed — ${shop.name} — ${order.order_date}`,
      orderEmailHtml(order, items, shop, 'Order Confirmed', 'The roastery has confirmed your order and it is being prepared.'));
  }

  const updated = orderFull(db.prepare('SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=?').get(req.params.id));
  res.json({ ...updated, email });
});

// ─── Patterns ─────────────────────────────────────────────────────────────────
app.get('/api/analytics', (req, res) => {
  const shops = db.prepare('SELECT * FROM shops ORDER BY name').all();
  const out = shops.map(s => {
    const totals = db.prepare(
      `SELECT COUNT(*) orders_count, COALESCE(SUM(total_lbs),0) lbs, COALESCE(SUM(total_cost),0) cost,
              MIN(order_date) first_order, MAX(order_date) last_order
       FROM orders WHERE shop_id=?`).get(s.id);
    // Roast mix: items carry it directly; legacy pool orders map espresso→espresso, rest→filter
    const mix = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN roast='espresso' THEN lbs END),0) esp,
              COALESCE(SUM(CASE WHEN roast='filter' THEN lbs END),0) flt
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

// ─── Static dashboard ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Dose Hub running on port ${PORT}`));
