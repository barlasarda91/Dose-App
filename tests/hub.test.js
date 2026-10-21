// Hub pressure tests: portal order intake + dedup, order-status transitions,
// edit guards, roast-fill idempotency and On Hand math, delete semantics,
// role walls. Boots the real hub against a throwaway database.
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
  // Orders arrive through the portal: one master key, shop named per request.
  const PKEY = 'portal-master-key';
  const ingest = async (shopId, body, key = PKEY) => {
    const res = await fetch(`${API}/api/portal/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, shop_id: shopId }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const portalCatalog = async (shopId) =>
    fetch(`${API}/api/portal/catalog?shop_id=${shopId}`, { headers: { Authorization: `Bearer ${PKEY}` } }).then(x => x.json());

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
    ok(r.body.shop && r.body.api_key === undefined, 'shop provisioned — no API key exists anywhere');

    section('portal order intake: dedup and validation');
    r = await ingest(1, { order_date: '2026-06-01', source_order_id: 42, items: [{ coffee_id: coffeeId, roast: 'espresso', lbs: 35 }] });
    ok(r.status === 200, 'order lands');
    r = await ingest(1, { order_date: '2026-06-01', source_order_id: 42, items: [{ coffee_id: coffeeId, roast: 'espresso', lbs: 35 }] });
    ok(r.status === 200 && r.body.duplicate === true, 'retried push flagged as duplicate, not re-created');
    r = await j('GET', '/api/orders', null, STAFF);
    ok(r.body.filter(o => o.source_order_id === 42).length === 1, 'exactly one order exists after the retry');
    const orderId = r.body[0].id;
    r = await ingest(1, { order_date: '2026-06-01', items: [{ coffee_id: coffeeId, roast: 'espresso', lbs: 5 }] }, 'not-the-portal-key');
    ok(r.status === 401, 'wrong portal key rejected');
    r = await ingest(1, { order_date: '2026-06-02', items: [] });
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
    await ingest(1, { order_date: '2026-06-03', source_order_id: 43, items: [{ coffee_id: coffeeId, roast: 'espresso', lbs: 10 }] });
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
    r = await portalCatalog(1);
    const synced = r.items.find(i => i.id === coffeeId);
    ok(synced.info_sheet && synced.info_sheet.country === 'Ethiopia' && synced.info_sheet.brew_espresso === '18g in, 40g out.',
      'sheet flows to the shop through catalog sync');
    ok(synced.info_sheet.sections[0].title === 'Intro', 'sections arrive in order');
    r = await j('GET', '/api/activity', null, OWNER);
    ok(r.body.some(a => /updated the info sheet for "Blend No. 1"/.test(a.action)), 'sheet edit audited');
    // a coffee with nothing filled in syncs with info_sheet null
    r = await j('POST', '/api/catalog', { name: 'Sheetless Decaf', price_per_lb: 13 }, OWNER);
    const plainId = r.body.id;
    r = await portalCatalog(1);
    ok(r.items.find(i => i.id === plainId).info_sheet === null, 'empty sheet syncs as null — no phantom links');

    section('reset clears lockouts — the client-called-you scenario');
    const shopAuth = async (u, p) => {
      const res = await fetch(`${API}/api/portal/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PKEY}` },
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

    r = await shopAuth(shopUname, 'not-the-password-1');
    ok(r.status === 401 && r.body.error === 'Wrong username or password', 'right shop, wrong password keeps the plain error');

    section('archive / restore');
    r = await j('POST', `/api/catalog/${plainId}/archive`, null, STAFF);
    ok(r.status === 403, 'staff cannot archive');
    r = await j('POST', `/api/catalog/${plainId}/archive`, null, OWNER);
    ok(r.status === 200 && r.body.active === 0, 'owner archives a coffee');
    r = await portalCatalog(1);
    ok(!r.items.some(i => i.id === plainId), 'archived coffee vanishes from the shop price list');
    r = await ingest(1, { order_date: '2026-06-05', items: [{ coffee_id: plainId, roast: 'espresso', lbs: 5 }] });
    ok(r.status === 400, 'ordering an archived coffee refused');
    r = await j('POST', `/api/catalog/${plainId}/restore`, null, OWNER);
    ok(r.status === 200 && r.body.active === 1, 'restore brings it back');
    r = await portalCatalog(1);
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
    const rosterOwner = roster && roster.logins.find(l => l.role === 'owner');
    ok(r.status === 200 && rosterOwner && rosterOwner.username === shopUname && rosterOwner.has_password === true,
      'roster sync carries each store\'s logins with roles and password state');

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

    section('cup profiles: vocabulary walls and the palate math');
    r = await j('PUT', `/api/catalog/${coffeeId}/sheet`, { profile_tags: ['Juicy'] }, STAFF);
    ok(r.status === 403, 'staff cannot set profile tags');
    r = await j('PUT', `/api/catalog/${coffeeId}/sheet`, { profile_tags: ['juicy', 'Winey', 'JUICY'] }, OWNER);
    ok(r.status === 200 && JSON.stringify(r.body.profile_tags) === '["Juicy","Winey"]',
      `tags canonicalized and deduped (${JSON.stringify(r.body.profile_tags)})`);
    r = await j('PUT', `/api/catalog/${coffeeId}/sheet`, { profile_tags: ['Juicy', 'Winey', 'Bright', 'Funky'] }, OWNER);
    ok(r.status === 400 && /at most 3/.test(r.body.error), 'four tags rejected');
    r = await j('PUT', `/api/catalog/${coffeeId}/sheet`, { profile_tags: ['Oaky'] }, OWNER);
    ok(r.status === 400 && /"Oaky"/.test(r.body.error), 'off-vocabulary tag rejected by name');
    r = await j('PUT', `/api/catalog/${coffeeId}/sheet`, { info_country: 'Ethiopia' }, OWNER);
    ok(JSON.stringify(r.body.profile_tags) === '["Juicy","Winey"]', 'sheet save without tags leaves them unchanged');
    r = await j('GET', '/api/profile-patterns', null, STAFF);
    ok(r.body.untagged.includes('Sheetless Decaf'), 'untagged active coffee is named, not silently skipped');
    await j('PUT', `/api/catalog/${plainId}/sheet`, { profile_tags: ['Buttery'] }, OWNER);
    r = await portalCatalog(1);
    ok(JSON.stringify(r.items.find(i => i.id === coffeeId).profile) === '["Juicy","Winey"]', 'profile rides the shop catalog sync');

    // A fresh order inside the 90-day window: 10 lb Juicy/Winey espresso +
    // 5 lb Buttery espresso + 5 lb Juicy/Winey filter.
    const today = new Date().toISOString().slice(0, 10);
    r = await ingest(1, { order_date: today, source_order_id: 777, items: [
      { coffee_id: coffeeId, roast: 'espresso', lbs: 10 },
      { coffee_id: plainId, roast: 'espresso', lbs: 5 },
      { coffee_id: coffeeId, roast: 'filter', lbs: 5 },
    ] });
    ok(r.status === 200, 'tagged order lands');
    r = await j('GET', '/api/profile-patterns', null, STAFF);
    const pat = r.body.shops.find(x => x.shop_name === 'Pressure Shop');
    ok(pat && pat.esp_lbs === 15 && pat.fil_lbs === 5, `tagged lbs split by roast (esp ${pat && pat.esp_lbs}, fil ${pat && pat.fil_lbs})`);
    ok(pat.esp.Juicy.share === 67 && pat.esp.Buttery.share === 33, `espresso palate shares right (Juicy ${pat.esp.Juicy.share}%, Buttery ${pat.esp.Buttery.share}%)`);
    ok(pat.fil.Winey.share === 100 && !pat.fil.Buttery, 'filter palate only sees filter pounds');
    ok(r.body.untagged.length === 0, 'everything tagged — the nudge list clears');

    section('product-doc import: parse walls and apply semantics');
    const DOC = [
      '# Draft Coffees', '',
      '## Colombia – Finca El Encanto / Papayo', '',
      '#### Intro', 'Brandon selected this lot for two courses.', '',
      '#### Country - Colombia', 'Colombia story paragraph.', '',
      '#### Region - Huila, Pitalito', 'This lot comes from 1,230 to 1,250 meters above sea level.', '',
      '#### Farm - Finca El Encanto', 'A family farm in Pitalito.', '',
      '#### Variety - Papayo', 'Rare variety found almost exclusively in Huila.', '',
      '#### Process - Thermal Shock Anaerobic Natural', 'Cherries are harvested selectively.', '',
      '# Active coffees', '',
      '# Ethiopia – Anasora Site', '',
      '## Intro', 'A standout natural.', '',
      '## Country', 'Ethiopia story — heading carries no value.', '',
      '## Region – Guji', 'Farms sit high in Guji.', '',
      '## Processing Station – Anasora Site', 'Station story.', '',
      '## Process – Natural', 'Dried on raised beds.', '',
      '# Past Coffees', '',
      '# Peru – Old Lot', '',
      '# Intro', 'A coffee from two seasons ago.',
    ].join('\n');
    r = await j('POST', '/api/import-doc', { text: DOC }, STAFF);
    ok(r.status === 403, 'staff cannot run the import');
    r = await j('POST', '/api/import-doc', { text: '' }, OWNER);
    ok(r.status === 400, 'empty input rejected');
    // A coffee whose name should match the first doc page by token overlap.
    r = await j('POST', '/api/catalog', { name: 'El Encanto Papayo', price_per_lb: 18 }, OWNER);
    const encId = r.body.id;
    await j('PUT', `/api/catalog/${encId}/sheet`, { profile_tags: ['Jammy'], brew_espresso: '18g in, 44g out.' }, OWNER);
    r = await j('POST', '/api/import-doc', { text: DOC }, OWNER);
    ok(r.status === 200 && r.body.coffees.length === 3, `heading-size chaos still parses (${r.body.coffees.length} coffees)`);
    const [enc, ana, past] = r.body.coffees;
    ok(enc.facts.country === 'Colombia' && enc.facts.producer === 'Finca El Encanto' && enc.facts.process === 'Thermal Shock Anaerobic Natural',
      'facts lifted from heading suffixes');
    ok(enc.facts.altitude === '1,230–1,250 masl', `altitude fished out of the Region prose (${enc.facts.altitude})`);
    ok(enc.sections.length === 6 && enc.sections[0].title === 'Intro', 'story sections kept in doc order');
    ok(enc.match_id === encId, 'catalog match suggested by name overlap');
    ok(ana.facts.country === 'Ethiopia' && ana.facts.producer === 'Anasora Site',
      'bare Country falls back to the title; Processing Station counts as producer');
    ok(ana.match_id === null, 'no fuzzy match invented for an unknown coffee');
    ok(/past/i.test(past.group), 'doc grouping survives (Past flagged for default-unchecked)');

    r = await j('POST', '/api/import-doc/apply', { items: [{ coffee_id: encId, facts: enc.facts, sections: enc.sections }, { coffee_id: 9999, facts: {}, sections: [] }] }, OWNER);
    ok(r.status === 200 && r.body.applied === 1 && r.body.results[1].ok === false, 'apply writes the real target, names the bogus one');
    r = await j('GET', '/api/catalog', null, OWNER);
    const encFull = r.body.find(i => i.id === encId);
    ok(encFull.info_country === 'Colombia' && encFull.info_altitude === '1,230–1,250 masl' && encFull.info_sections.length === 6,
      'sheet lands: facts + sections');
    ok(JSON.stringify(encFull.profile_tags) === '["Jammy"]' && encFull.brew_espresso === '18g in, 44g out.',
      'cup profile and brew notes untouched by the import');
    r = await j('GET', '/api/activity', null, OWNER);
    ok(r.body.some(a => /imported the info sheet for "El Encanto Papayo" from the product doc/.test(a.action)), 'import audited per coffee');

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
