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
    PORTAL_KEY: 'portal-master-key',
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

    section('reset clears lockouts — the client-called-you scenario');
    const shopAuth = async (u, p) => {
      const res = await fetch(`${API}/api/ingest/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shopKey}` },
        body: JSON.stringify({ username: u, password: p }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    r = await j('POST', `/api/shops/1/reset-login`, { new_password: 'first-pass-999' }, OWNER);
    const shopUname = r.body.login_username;
    for (let i = 0; i < 6; i++) r = await shopAuth(shopUname, 'client-typo-' + i);
    r = await shopAuth(shopUname, 'first-pass-999');
    ok(r.status === 429, 'after repeated typos even the right password is rate-limited');
    r = await j('POST', `/api/shops/1/reset-login`, { new_password: 'fresh-after-call' }, OWNER);
    ok(r.status === 200, 'roaster resets the login');
    r = await shopAuth(shopUname, 'fresh-after-call');
    ok(r.status === 200, 'reset clears the lockout — new password works immediately');

    section('login telemetry and the wrong-door signpost');
    r = await j('GET', '/api/shops', null, OWNER);
    let shopRow = r.body.find(x => x.id === 1);
    ok(shopRow.last_auth_ok_at && shopRow.last_auth_fail_at && shopRow.auth_fail_count >= 5,
      `shop card shows login health (ok ${!!shopRow.last_auth_ok_at}, fails ${shopRow.auth_fail_count})`);
    // shop username typed into the HUB login → signpost, not a dead error
    r = await j('POST', '/api/login', { username: shopRow.login_username, password: 'whatever-123' });
    ok(r.status === 401 && /shop account/.test(r.body.error), `hub login signposts the wrong door (${r.body.error.slice(0, 60)}…)`);
    r = await j('POST', '/api/login', { username: 'total-stranger', password: 'whatever-123' });
    ok(r.status === 401 && !/shop account/.test(r.body.error), 'unknown usernames still get the plain error (no account probing)');
    r = await j('GET', '/api/activity', null, OWNER);
    ok(r.body.some(a => a.username === 'shop' && /set a new password via its invite link/.test(a.action)) === false,
      'no invite set-password yet in trail (sanity)');

    r = await shopAuth('some-other-shop', 'whatever-123');
    ok(r.status === 401 && /different shop/.test(r.body.error), 'wrong-deployment login gets the distinct message');
    r = await shopAuth(shopUname, 'not-the-password-1');
    ok(r.status === 401 && r.body.error === 'Wrong username or password', 'right shop, wrong password keeps the plain error');

    section('archive / restore');
    r = await j('POST', `/api/catalog/${plainId}/archive`, null, STAFF);
    ok(r.status === 403, 'staff cannot archive');
    r = await j('POST', `/api/catalog/${plainId}/archive`, null, OWNER);
    ok(r.status === 200 && r.body.active === 0, 'owner archives a coffee');
    r = await fetch(`${API}/api/ingest/catalog`, { headers: { Authorization: `Bearer ${shopKey}` } }).then(x => x.json());
    ok(!r.items.some(i => i.id === plainId), 'archived coffee vanishes from the shop price list');
    r = await ingest(shopKey, { order_date: '2026-06-05', items: [{ coffee_id: plainId, roast: 'espresso', lbs: 5 }] });
    ok(r.status === 400, 'ordering an archived coffee refused');
    r = await j('POST', `/api/catalog/${plainId}/restore`, null, OWNER);
    ok(r.status === 200 && r.body.active === 1, 'restore brings it back');
    r = await fetch(`${API}/api/ingest/catalog`, { headers: { Authorization: `Bearer ${shopKey}` } }).then(x => x.json());
    ok(r.items.some(i => i.id === plainId), 'restored coffee reappears for shops');
    r = await j('GET', '/api/activity', null, OWNER);
    ok(r.body.some(a => /archived catalog item "Sheetless Decaf"/.test(a.action)), 'archive audited');

    section('portal API: one key, shop resolved per request');
    const portal = async (method, p, body, key = 'portal-master-key') => {
      const res = await fetch(`${API}/api/portal${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    r = await portal('GET', '/shops', null, null);
    ok(r.status === 401, 'portal without a key rejected');
    r = await portal('GET', '/shops', null, 'not-the-portal-key');
    ok(r.status === 401, 'wrong portal key rejected');
    r = await portal('GET', '/shops');
    const roster = r.body.find(s => s.id === 1);
    ok(r.status === 200 && roster && roster.login_username === shopUname && roster.has_password === true,
      'roster sync carries id, username, and password state');

    r = await portal('POST', '/auth', { username: shopUname, password: 'fresh-after-call' });
    ok(r.status === 200 && r.body.shop_id === 1 && r.body.shop_name === 'Pressure Shop',
      'portal login resolves the shop from the username alone');
    r = await portal('POST', '/auth', { username: shopUname, password: 'wrong-guess-1' });
    ok(r.status === 401 && r.body.error === 'Wrong username or password', 'wrong password keeps the plain error');
    r = await portal('POST', '/auth', { username: 'owner1', password: 'whatever-123' });
    ok(r.status === 401 && /roastery account/.test(r.body.error), 'roastery username at the portal gets the wrong-door signpost');
    r = await portal('POST', '/auth', { username: 'total-stranger', password: 'whatever-123' });
    ok(r.status === 401 && !/roastery account/.test(r.body.error), 'unknown usernames keep the plain error (no probing)');

    r = await portal('GET', '/catalog?shop_id=1');
    ok(r.status === 200 && r.body.items.some(i => i.name === 'Blend No. 1'), 'portal catalog is the shop\'s own price list');
    r = await portal('GET', '/catalog?shop_id=999');
    ok(r.status === 404, 'unknown shop_id rejected');

    r = await portal('POST', '/orders', { shop_id: 1, order_date: '2026-06-08', source_order_id: 91, items: [{ coffee_id: coffeeId, roast: 'espresso', lbs: 5 }] });
    ok(r.status === 200 && r.body.hub_order_id, 'portal order lands');
    r = await portal('POST', '/orders', { shop_id: 1, order_date: '2026-06-08', source_order_id: 91, items: [{ coffee_id: coffeeId, roast: 'espresso', lbs: 5 }] });
    ok(r.status === 200 && r.body.duplicate === true, 'portal retry deduped like ingest');
    r = await j('GET', '/api/orders', null, OWNER);
    ok(r.body.find(o => o.source_order_id === 91 && o.shop_name === 'Pressure Shop'), 'portal order attributed to the right shop');
    r = await portal('GET', '/order-status?shop_id=1&ids=91');
    ok(r.status === 200 && r.body[0] && r.body[0].status === 'new', 'portal order-status polls through');

    r = await portal('POST', '/change-password', { shop_id: 1, username: shopUname, current_password: 'nope-wrong', new_password: 'portal-changed-99' });
    ok(r.status === 401, 'change-password demands the current password');
    r = await portal('POST', '/change-password', { shop_id: 1, username: shopUname, current_password: 'fresh-after-call', new_password: 'portal-changed-99' });
    ok(r.status === 200, 'shop changes its password through the portal');
    r = await portal('POST', '/auth', { username: shopUname, password: 'portal-changed-99' });
    ok(r.status === 200, 'new password works at the portal');
    r = await shopAuth(shopUname, 'portal-changed-99');
    ok(r.status === 200, 'same credential works on the legacy per-key path — one identity, two doors');

    // The client-called-you scenario, portal edition: lockout dies with the reset.
    for (let i = 0; i < 6; i++) await portal('POST', '/auth', { username: shopUname, password: 'typo-' + i });
    r = await portal('POST', '/auth', { username: shopUname, password: 'portal-changed-99' });
    ok(r.status === 429, 'hammering the portal locks the username');
    await j('POST', `/api/shops/1/reset-login`, { new_password: 'post-reset-77' }, OWNER);
    r = await portal('POST', '/auth', { username: shopUname, password: 'post-reset-77' });
    ok(r.status === 200, 'roaster reset clears the portal lockout too');

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
