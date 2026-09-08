// Shared harness for the pressure-test suites. Boots the real servers against
// throwaway databases and mock upstreams (Square, hub), then hits them over
// HTTP exactly like the frontends do.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}
const near = (a, b, eps = 0.5) => Math.abs(a - b) < eps;
const section = t => console.log(`\n— ${t} —`);
function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

function freshDir(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function client(base, tokenHeader) {
  return async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { [tokenHeader]: token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

function startServer(dir, script, env) {
  const proc = spawn('node', [script], {
    cwd: path.join(ROOT, dir),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.log = '';
  proc.stdout.on('data', d => proc.log += d);
  proc.stderr.on('data', d => proc.log += d);
  return proc;
}

async function waitUp(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error(`server at ${url} never came up`);
}

// Mock Square: configurable orders, and it records every orders/search body
// so tests can assert what date filters the app actually sent.
function mockSquare(port) {
  const state = { orders: [], searches: [], catalog: [] };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v2/locations') {
      return res.end(JSON.stringify({ locations: [{ id: 'L1', status: 'ACTIVE', timezone: 'America/Los_Angeles' }] }));
    }
    if (req.url === '/v2/orders/search') {
      let b = ''; req.on('data', c => b += c);
      return req.on('end', () => {
        try { state.searches.push(JSON.parse(b)); } catch { /* keep going */ }
        res.end(JSON.stringify({ orders: state.orders }));
      });
    }
    if (req.url.startsWith('/v2/catalog/list')) {
      return res.end(JSON.stringify({ objects: state.catalog.map(n => ({ item_data: { name: n } })) }));
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise(resolve => server.listen(port, () => resolve({ state, server })));
}

// Mock hub for shop-side tests: serves a price list and accepts order pushes.
// state.mode: 'ok' | 'catalog-down' | 'orders-down'.
function mockHub(port) {
  const state = {
    mode: 'ok',
    pushes: [],
    catalog: {
      currency: '$', shop_name: 'Pressure Test Shop',
      items: [
        { id: 1, name: 'Blend No. 1', price_per_lb: 14.5, retail_price: 12.5, notes: 'chocolate. cherry.' },
        { id: 2, name: 'Guatemala La Bolsa', price_per_lb: 16.5, retail_price: null, notes: 'floral' },
      ],
    },
  };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const authed = (req.headers.authorization || '').startsWith('Bearer ');
    if (!authed) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Invalid shop API key' })); }
    if (req.url === '/api/ingest/catalog') {
      if (state.mode === 'catalog-down') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'hub exploded' })); }
      return res.end(JSON.stringify(state.catalog));
    }
    if (req.url === '/api/ingest/orders' && req.method === 'POST') {
      let b = ''; req.on('data', c => b += c);
      return req.on('end', () => {
        if (state.mode === 'orders-down') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'hub order intake down' })); }
        const body = JSON.parse(b);
        state.pushes.push(body);
        res.end(JSON.stringify({ ok: true, hub_order_id: state.pushes.length, receipt: { sent: true, to: 'shop@example.com' } }));
      });
    }
    if (req.url === '/api/ingest/order-status') {
      return res.end(JSON.stringify({ statuses: {} }));
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise(resolve => server.listen(port, () => resolve({ state, server })));
}

const sqlite = () => require(path.join(ROOT, 'backend', 'node_modules', 'better-sqlite3'));

module.exports = { ROOT, TMP, ok, near, section, finish, freshDir, client, startServer, waitUp, mockSquare, mockHub, sqlite };
