// Hub pressure tests: ingest dedup, order-status transitions, edit guards,
// roast-fill idempotency and On Hand math, delete semantics, role walls.
// Boots the real hub against a throwaway database.
const path = require('path');
const { ok, near, section, finish, freshDir, client, startServer, waitUp } = require('./helpers');

const PORT = 4520;
const API = `http://127.0.0.1:${PORT}`;
const j = client(API, 'x-hub-key');

(async () => {
  const dir = freshDir('hub');
  const server = startServer('hub', 'server.js', {
    HUB_DB_PATH: path.join(dir, 'hub.db'), PORT: String(PORT), HUB_PASSWORD: 'ptest-boot',
  });
  // Shop ingest uses its own bearer key, captured at shop creation.
  const ingest = async (key, body) => {
    const res = await fetch(`${API}/api/ingest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    await waitUp(`${API}/api/health`);
    let r = await j('POST', '/api/setup-owner', { username: 'owner1', email: 'owner@example.com', password: 'owner-pass-1234', bootstrap_password: 'ptest-boot' });
    const OWNER = r.body.token;
    ok(!!OWNER, 'owner bootstrapped');
    r = await j('POST', '/api/team', { username: 'staff1', email: 'staff@example.com', role: 'staff', temp_password: 'temp-pass-12345' }, OWNER);
    r = await j('POST', '/api/login', { username: 'staff1', password: 'temp-pass-12345' });
    const tempTok = r.body.token;
    await j('POST', '/api/me/password', { current_password: 'temp-pass-12345', new_password: 'staff-real-pass-1' }, tempTok);
    r = await j('POST', '/api/login', { username: 'staff1', password: 'staff-real-pass-1' });
    const STAFF = r.body.token;
    ok(!!STAFF, 'staff account through the forced password change');

    // Catalog + shop.
    r = await j('POST', '/api/catalog', { name: 'Blend No. 1', price_per_lb: 14.5, retail_price: 12.5 }, OWNER);
    const coffeeId = r.body.id;
    r = await j('POST', '/api/shops', { name: 'Pressure Shop', email: 'shop@example.com' }, OWNER);
    const shopKey = r.body.api_key;
    ok(!!shopKey, 'shop provisioned with API key');

    section('ingest: dedup and validation');
    r = await ingest(shopKey, { order_date: '2026-06-01', source_order_id: 42, items: [{ coffee_id: coffeeId, roast: 'espresso', lbs: 35 }] });
    ok(r.status === 200, 'order ingested');
    r = await ingest(shopKey, { order_date: '2026-06-01', source_order_id: 42, items: [{ coffee_id: coffeeId, roast: 'espresso', lbs: 35 }] });
    ok(r.status === 200 && r.body.duplicate === true, 'retried push flagged as duplicate, not re-created');
    r = await j('GET', '/api/orders', null, STAFF);
    ok(r.body.filter(o => o.source_order_id === 42).length === 1, 'exactly one order exists after the retry');
    const orderId = r.body[0].id;
    r = await ingest('dose_wrongkey', { order_date: '2026-06-01', items: [{ coffee_id: coffeeId, roast: 'espresso', lbs: 5 }] });
    ok(r.status === 401, 'bad shop key rejected');
    r = await ingest(shopKey, { order_date: '2026-06-02', items: [] });
    ok(r.status === 400, 'empty order rejected');

    section('status transitions and edit guards');
    r = await j('PATCH', `/api/orders/${orderId}`, { status: 'nonsense' }, STAFF);
    ok(r.status === 400, 'invalid status rejected');
    r = await j('PATCH', `/api/orders/${orderId}`, { status: 'confirmed' }, STAFF);
    ok(r.status === 200 && r.body.confirmed_by === 'staff1', 'confirm attributed to the staff member');
    r = await j('PATCH', `/api/orders/${orderId}`, { status: 'confirmed' }, STAFF);
    ok(r.status === 200, 'double-confirm is safe (idempotent, no second email path)');
    r = await j('PATCH', `/api/orders/${orderId}`, { status: 'shipped' }, STAFF);
    ok(r.body.shipped_by === 'staff1', 'ship attributed');
    r = await j('PUT', `/api/orders/${orderId}/items`, { items: [{ id: 1, lbs: 10 }] }, STAFF);
    ok(r.status === 400 && /already shipped/.test(r.body.error), 'editing a shipped order refused');
    r = await j('PATCH', `/api/orders/${orderId}`, { status: 'confirmed' }, STAFF);
    ok(r.status === 200, 'walking a status backwards is allowed (roaster correction path)');
    await j('PATCH', `/api/orders/${orderId}`, { status: 'confirmed' }, STAFF);

    section('roast fill: whole batches, idempotency, On Hand math');
    r = await j('GET', '/api/roast-program', null, STAFF);
    const line = r.body.lines.find(l => l.coffee_id === coffeeId && l.profile === 'espresso');
    ok(line && line.owed_lbs === 35 && line.fresh.batches === 1, `35 lb owed plans one whole 55-lb batch (owed ${line && line.owed_lbs})`);
    r = await j('POST', '/api/roast-program/fill', { coffee_id: coffeeId, profile: 'espresso', mode: 'fresh', actual_out_lbs: 47.2 }, STAFF);
    ok(r.status === 200, 'fill succeeds');
    r = await j('GET', '/api/on-hand', null, STAFF);
    let row = r.body.rows.find(x => x.coffee_id === coffeeId && x.profile === 'espresso');
    ok(row && near(row.lbs, 47.2 - 35, 0.01), `leftover lands on the shelf (${row && row.lbs} lbs ≈ 12.2)`);
    ok(r.body.moves.every(m => m.created_by === 'staff1' || m.created_by == null), 'fill movements signed');
    r = await j('POST', '/api/roast-program/fill', { coffee_id: coffeeId, profile: 'espresso', mode: 'fresh' }, STAFF);
    ok(r.status === 404, 'second fill of the same line refused — no double deduction');
    r = await j('GET', '/api/on-hand', null, STAFF);
    row = r.body.rows.find(x => x.coffee_id === coffeeId && x.profile === 'espresso');
    ok(row && near(row.lbs, 12.2, 0.01), 'shelf unchanged after the refused refill');

    // Fill-from-stock: a second order small enough to cover from the shelf.
    await ingest(shopKey, { order_date: '2026-06-03', source_order_id: 43, items: [{ coffee_id: coffeeId, roast: 'espresso', lbs: 10 }] });
    r = await j('GET', '/api/orders', null, STAFF);
    const o2 = r.body.find(o => o.source_order_id === 43);
    await j('PATCH', `/api/orders/${o2.id}`, { status: 'confirmed' }, STAFF);
    r = await j('GET', '/api/roast-program', null, STAFF);
    const line2 = r.body.lines.find(l => l.coffee_id === coffeeId && l.profile === 'espresso');
    ok(line2 && line2.batches === 0, '10 lb order coverable from stock plans zero batches');
    r = await j('POST', '/api/roast-program/fill', { coffee_id: coffeeId, profile: 'espresso', mode: 'stock' }, STAFF);
    ok(r.status === 200, 'fill from stock succeeds');
    r = await j('GET', '/api/on-hand', null, STAFF);
    row = r.body.rows.find(x => x.coffee_id === coffeeId && x.profile === 'espresso');
    ok(row && near(row.lbs, 2.2, 0.01), `shelf drawn down by the order (${row && row.lbs} lbs ≈ 2.2)`);

    section('delete keeps the ledger');
    r = await j('DELETE', `/api/orders/${o2.id}`, null, STAFF);
    ok(r.status === 403, 'staff cannot delete');
    r = await j('DELETE', `/api/orders/${o2.id}`, null, OWNER);
    ok(r.status === 200, 'owner deletes the order');
    r = await j('GET', '/api/on-hand', null, OWNER);
    row = r.body.rows.find(x => x.coffee_id === coffeeId && x.profile === 'espresso');
    ok(row && near(row.lbs, 2.2, 0.01), 'stock ledger untouched by the delete — the coffee was really roasted');
    r = await j('GET', '/api/activity', null, OWNER);
    ok(r.body.some(a => a.username === 'owner1' && /deleted order/.test(a.action)), 'delete is in the audit trail');

    section('info sheets');
    r = await j('PUT', `/api/catalog/${coffeeId}/sheet`, { info_country: 'Ethiopia' }, STAFF);
    ok(r.status === 403, 'staff cannot edit info sheets');
    r = await j('PUT', `/api/catalog/${coffeeId}/sheet`, {
      info_country: 'Ethiopia', info_region: 'Guji', info_altitude: '2,200–2,300 masl',
      brew_filter: 'Batch: 60g/L at 94C.', brew_espresso: '18g in, 40g out.',
      info_sections: [{ title: 'Intro', body: 'Creamy body, blueberry sweetness.' }, { title: '', body: '' }, 'garbage'],
    }, OWNER);
    ok(r.status === 200 && r.body.info_sections.length === 1, 'sheet saved; empty/garbage sections dropped');
    r = await fetch(`${API}/api/ingest/catalog`, { headers: { Authorization: `Bearer ${shopKey}` } }).then(x => x.json());
    const synced = r.items.find(i => i.id === coffeeId);
    ok(synced.info_sheet && synced.info_sheet.country === 'Ethiopia' && synced.info_sheet.brew_espresso === '18g in, 40g out.',
      'sheet flows to the shop through catalog sync');
    ok(synced.info_sheet.sections[0].title === 'Intro', 'sections arrive in order');
    r = await j('GET', '/api/activity', null, OWNER);
    ok(r.body.some(a => /updated the info sheet for "Blend No. 1"/.test(a.action)), 'sheet edit audited');
    // a coffee with nothing filled in syncs with info_sheet null
    r = await j('POST', '/api/catalog', { name: 'Sheetless Decaf', price_per_lb: 13 }, OWNER);
    const plainId = r.body.id;
    r = await fetch(`${API}/api/ingest/catalog`, { headers: { Authorization: `Bearer ${shopKey}` } }).then(x => x.json());
    ok(r.items.find(i => i.id === plainId).info_sheet === null, 'empty sheet syncs as null — no phantom links');

    section('adjustment guards');
    r = await j('POST', '/api/on-hand/adjust', { coffee_id: coffeeId, profile: 'espresso', delta_lbs: 0 }, STAFF);
    ok(r.status === 400, 'zero-delta adjustment rejected');
    r = await j('POST', '/api/on-hand/adjust', { coffee_id: coffeeId, profile: 'decaf' }, STAFF);
    ok(r.status === 400, 'unknown profile rejected');
    r = await j('POST', '/api/on-hand/adjust', { coffee_id: 9999, profile: 'espresso', delta_lbs: 1 }, STAFF);
    ok(r.status === 404, 'unknown coffee rejected');
  } catch (e) {
    ok(false, `suite crashed: ${e.message}`);
    console.log(server.log.slice(-1500));
  } finally {
    server.kill();
  }
  finish();
})();
