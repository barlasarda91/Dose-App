// Portal pressure tests: two shops on ONE portal deployment against the real
// hub. Login routing, hard data isolation across every table, per-shop
// pricing, cross-shop reach attempts, operator-only backups, local staff
// accounts, and the legacy single-shop → portal migration path.
const path = require('path');
const { ok, section, finish, freshDir, client, startServer, waitUp, mockSquare, sqlite } = require('./helpers');

const HUB = 4530, APP = 4531, SQ = 4532, LEGACY = 4533;
const HUB_API = `http://127.0.0.1:${HUB}`;
const API = `http://127.0.0.1:${APP}`;
const jh = client(HUB_API, 'x-hub-key');
const j = client(API, 'x-dose-key');
const PKEY = 'portal-master-key-test';

const waitExit = proc => new Promise(r => { proc.on('exit', code => r(code)); setTimeout(() => r(null), 8000); });

(async () => {
  const dir = freshDir('portal');
  await mockSquare(SQ);

  // ── Real hub with two shops ──
  const hub = startServer('hub', 'server.js', {
    HUB_DB_PATH: path.join(dir, 'hub.db'), PORT: String(HUB), HUB_PASSWORD: 'ptest-boot',
    PORTAL_KEY: PKEY,
  });
  let app; let legacy; const extras = [];

  try {
    await waitUp(`${HUB_API}/api/health`);
    let r = await jh('POST', '/api/setup-owner', { username: 'owner1', email: 'owner@example.com', password: 'owner-pass-1234', bootstrap_password: 'ptest-boot' });
    const OWNER = r.body.token;

    r = await jh('POST', '/api/catalog', { name: 'House Blend', price_per_lb: 14 }, OWNER);
    const houseId = r.body.id;
    r = await jh('POST', '/api/shops', { name: 'Alpha Cafe', email: 'alpha@example.com' }, OWNER);
    const alphaHubId = r.body.shop.id, alphaKey = r.body.api_key;
    r = await jh('POST', '/api/shops', { name: 'Bravo Beans', email: 'bravo@example.com' }, OWNER);
    const bravoHubId = r.body.shop.id;
    // A coffee only Bravo can see — pricing isolation must survive the portal.
    r = await jh('POST', '/api/catalog', { name: 'Bravo Exclusive', price_per_lb: 19, visibility: 'exclusive', exclusive_shop_ids: [bravoHubId] }, OWNER);
    r = await jh('POST', `/api/shops/${alphaHubId}/reset-login`, { new_password: 'alpha-pass-1' }, OWNER);
    const ALPHA = r.body.login_username;
    r = await jh('POST', `/api/shops/${bravoHubId}/reset-login`, { new_password: 'bravo-pass-1' }, OWNER);
    const BRAVO = r.body.login_username;
    ok(ALPHA && BRAVO && ALPHA !== BRAVO, `two shops provisioned (${ALPHA}, ${BRAVO})`);

    section('portal refuses to boot without encryption at rest');
    const bad = startServer('backend', 'server.js', {
      DB_PATH: path.join(dir, 'nope.db'), PORT: '4539', PORTAL_KEY: PKEY, DEFAULT_HUB_URL: HUB_API,
    });
    const code = await waitExit(bad);
    ok(code !== 0 && code !== null && /DOSE_SECRET_KEY/.test(bad.log), `boot refused, names the missing key (exit ${code})`);

    section('misconfiguration diagnoses itself at the login screen');
    // Portal key mismatch, and a hub missing PORTAL_KEY entirely — both must
    // say what is wrong, not hide behind 'cannot reach the hub'.
    const hubNoKey = startServer('hub', 'server.js', { HUB_DB_PATH: path.join(dir, 'hub-nokey.db'), PORT: '4536', HUB_PASSWORD: 'x' });
    const appWrongKey = startServer('backend', 'server.js', {
      DB_PATH: path.join(dir, 'wrongkey.db'), PORT: '4537', PORTAL_KEY: 'not-the-right-key',
      DEFAULT_HUB_URL: HUB_API, DOSE_SECRET_KEY: 's1',
    });
    const appHubNoKey = startServer('backend', 'server.js', {
      DB_PATH: path.join(dir, 'hubnokey.db'), PORT: '4538', PORTAL_KEY: PKEY,
      DEFAULT_HUB_URL: 'http://127.0.0.1:4536', DOSE_SECRET_KEY: 's2',
    });
    extras.push(hubNoKey, appWrongKey, appHubNoKey);
    await waitUp('http://127.0.0.1:4536/api/health');
    await waitUp('http://127.0.0.1:4537/api/auth-status');
    await waitUp('http://127.0.0.1:4538/api/auth-status');
    r = await client('http://127.0.0.1:4537', 'x-dose-key')('POST', '/api/login', { username: ALPHA, password: 'alpha-pass-1' });
    ok(r.status === 401 && /Invalid portal key/.test(r.body.error), `mismatched PORTAL_KEY names itself (${r.body.error})`);
    r = await client('http://127.0.0.1:4538', 'x-dose-key')('POST', '/api/login', { username: ALPHA, password: 'alpha-pass-1' });
    ok(r.status === 502 && /PORTAL_KEY is not set on the hub/.test(r.body.error), `hub without PORTAL_KEY names itself (${r.body.error})`);

    // ── The portal itself ──
    app = startServer('backend', 'server.js', {
      DB_PATH: path.join(dir, 'portal.db'), PORT: String(APP), PORTAL_KEY: PKEY,
      DEFAULT_HUB_URL: HUB_API, DOSE_SECRET_KEY: 'portal-test-secret', OPERATOR_KEY: 'op-key-123',
      SQUARE_BASE_URL: `http://127.0.0.1:${SQ}`,
      // A leftover single-shop credential in the environment must NOT become
      // every shop's fallback on the portal.
      SQUARE_ACCESS_TOKEN: 'env-leak-token', RESEND_API_KEY: 'env-leak-resend',
    });
    await waitUp(`${API}/api/auth-status`);

    section('login routing: the username decides the shop');
    r = await j('GET', '/api/auth-status');
    ok(r.body.setup_required === false && r.body.mode === 'hub', 'no setup screen — the hub is the identity provider');
    r = await j('POST', '/api/login', { username: ALPHA, password: 'alpha-pass-1' });
    const TA = r.body.token;
    ok(r.status === 200 && !!TA, 'Alpha signs in at the one URL');
    r = await j('POST', '/api/login', { username: BRAVO, password: 'bravo-pass-1' });
    const TB = r.body.token;
    ok(r.status === 200 && !!TB, 'Bravo signs in at the SAME URL');
    r = await j('POST', '/api/login', { username: ALPHA, password: 'bravo-pass-1' });
    ok(r.status === 401 && r.body.error === 'Wrong username or password', 'right shop, wrong password: plain error');
    r = await j('POST', '/api/login', { username: 'owner1', password: 'whatever-12' });
    ok(r.status === 401 && /roastery account/.test(r.body.error), 'roastery username signposted to the hub');

    const db = new (sqlite())(path.join(dir, 'portal.db'));
    const shops = db.prepare('SELECT * FROM shops ORDER BY id').all();
    db.close();
    ok(shops.length === 2 && shops.some(s => s.hub_shop_id === alphaHubId) && shops.some(s => s.hub_shop_id === bravoHubId),
      'both shops mirrored locally with their hub ids');

    section('data isolation: nothing crosses the wall');
    await j('POST', '/api/recipes', { square_item_name: 'Alpha Latte', method: 'espresso', coffee_grams: 18 }, TA);
    await j('POST', '/api/recipes', { square_item_name: 'Bravo Cortado', method: 'espresso', coffee_grams: 16 }, TB);
    r = await j('GET', '/api/recipes', null, TA);
    ok(r.body.length === 1 && r.body[0].square_item_name === 'Alpha Latte', 'Alpha sees only its own recipes');
    r = await j('GET', '/api/recipes', null, TB);
    const bravoRecipeId = r.body[0] && r.body[0].id;
    ok(r.body.length === 1 && r.body[0].square_item_name === 'Bravo Cortado', 'Bravo sees only its own recipes');

    await j('POST', '/api/coffee-deliveries', { delivery_date: '2026-09-01', espresso_lbs_onhand: 2, espresso_lbs_received: 10, filter_lbs_onhand: 0, filter_lbs_received: 0 }, TA);
    r = await j('GET', '/api/coffee-deliveries', null, TB);
    ok(r.body.length === 0, "Alpha's deliveries invisible to Bravo");

    await j('POST', '/api/settings', { shop_name: 'Alpha Cafe LA', alt_milk_ml_per_modifier: '200' }, TA);
    r = await j('GET', '/api/settings', null, TB);
    ok(r.body.shop_name === '' && r.body.alt_milk_ml_per_modifier === '180', "Alpha's settings don't leak into Bravo's");
    r = await j('GET', '/api/settings', null, TA);
    ok(r.body.shop_name === 'Alpha Cafe LA' && r.body.portal_mode === true, "Alpha's settings stuck for Alpha (and portal_mode reported)");

    await j('POST', '/api/square-items/ignore', { name: 'Muffin' }, TA);
    r = await j('GET', '/api/square-items', null, TB);
    ok(!r.body.ignored.includes('Muffin'), 'ignored Square items are per shop');

    section('per-shop pricing through one portal');
    r = await j('GET', '/api/hub-catalog', null, TB);
    ok(r.body.items.some(i => i.name === 'Bravo Exclusive'), 'Bravo sees its exclusive coffee');
    r = await j('GET', '/api/hub-catalog', null, TA);
    ok(!r.body.items.some(i => i.name === 'Bravo Exclusive'), "Alpha's catalog (cached separately) hides it");

    section('orders: placed as the right shop, isolated locally');
    r = await j('POST', '/api/orders', { order_date: '2026-09-02', items: [{ coffee_id: houseId, roast: 'espresso', lbs: 10 }] }, TA);
    ok(r.status === 200 && r.body.hub.pushed === true, "Alpha's order pushed to the hub");
    r = await jh('GET', '/api/orders', null, OWNER);
    ok(r.body.length === 1 && r.body[0].shop_name === 'Alpha Cafe', 'hub attributes the order to Alpha');
    r = await j('GET', '/api/orders', null, TB);
    ok(r.body.length === 0, "Bravo's order log is empty");
    r = await j('POST', '/api/orders', { order_date: '2026-09-02', items: [{ coffee_id: houseId, roast: 'espresso', lbs: 5 }] }, TB);
    ok(r.status === 200 && r.body.hub.pushed === true, "Bravo's own order pushes fine");
    r = await j('GET', '/api/orders', null, TB);
    ok(r.body.length === 1, 'Bravo sees exactly its own order');
    r = await j('GET', '/api/orders', null, TA);
    ok(r.body.length === 1, 'Alpha still sees exactly one order');

    section('cross-shop reach attempts bounce');
    r = await j('DELETE', `/api/recipes/${bravoRecipeId}`, null, TA);
    r = await j('GET', '/api/recipes', null, TB);
    ok(r.body.length === 1, "Alpha cannot delete Bravo's recipe");
    const dbx = new (sqlite())(path.join(dir, 'portal.db'));
    const bravoOrderId = dbx.prepare('SELECT id FROM coffee_orders WHERE shop_id=(SELECT id FROM shops WHERE hub_shop_id=?)').get(bravoHubId).id;
    dbx.close();
    r = await j('DELETE', `/api/orders/${bravoOrderId}`, null, TA);
    ok(r.status === 404, "Alpha cannot delete Bravo's order by id");

    section('local staff accounts on the portal');
    r = await j('POST', '/api/users', { username: 'barista.a', password: 'staffpass1', role: 'user' }, TA);
    ok(r.status === 200, 'Alpha admin creates a local staff account');
    r = await j('POST', '/api/users', { username: 'barista.a', password: 'otherpass9', role: 'user' }, TB);
    ok(r.status === 400 && /taken/.test(r.body.error), 'staff usernames are portal-unique');
    r = await j('POST', '/api/login', { username: 'barista.a', password: 'staffpass1' });
    const TS = r.body.token;
    ok(r.status === 200 && !!TS, 'staff logs in at the same one URL');
    r = await j('GET', '/api/recipes', null, TS);
    ok(r.body.length === 1 && r.body[0].square_item_name === 'Alpha Latte', "staff lands inside Alpha's shop");
    r = await j('GET', '/api/users', null, TB);
    ok(!r.body.some(u => u.username === 'barista.a'), "Bravo's user list doesn't show Alpha's staff");

    section('standing orders stay in their shop');
    r = await j('POST', '/api/standing-orders', { frequency: 'weekly', items: [{ coffee_id: houseId, roast: 'espresso', lbs: 5 }] }, TA);
    const soId = r.body.id;
    ok(r.status === 200, 'Alpha creates a standing order');
    r = await j('GET', '/api/standing-orders', null, TB);
    ok(r.body.length === 0, 'Bravo sees no standing orders');
    const db2 = new (sqlite())(path.join(dir, 'portal.db'));
    db2.prepare('UPDATE standing_orders SET next_date=? WHERE id=?').run('2020-01-01', soId);
    db2.close();
    await j('POST', '/api/standing-orders/run', null, TB); // global scheduler, B's admin triggers it
    r = await j('GET', '/api/standing-orders', null, TA);
    ok(r.body[0] && /^placed order #\d+$/.test(r.body[0].last_result || ''), `due order placed for Alpha (${r.body[0] && r.body[0].last_result})`);
    r = await jh('GET', '/api/orders', null, OWNER);
    ok(r.body.filter(o => o.shop_name === 'Alpha Cafe').length === 2, 'hub shows the standing order as Alpha again');
    r = await j('GET', '/api/orders', null, TB);
    ok(r.body.length === 1, "Bravo's log untouched by Alpha's schedule");

    section('backups are operator-only on the portal');
    r = await j('GET', '/api/backups', null, TA);
    ok(r.status === 403, 'shop admin locked out of backups');
    let raw = await fetch(`${API}/api/operator/backups`);
    ok(raw.status === 403, 'operator route refuses without the key');
    raw = await fetch(`${API}/api/operator/backups`, { headers: { 'x-operator-key': 'op-key-123' } });
    const oplist = await raw.json();
    ok(raw.status === 200 && Array.isArray(oplist.files), 'operator key lists backups');

    section('env credentials never become another shop\'s fallback');
    r = await j('GET', '/api/square-status', null, TB);
    ok(r.body.configured === false, 'deployment-env Square token ignored — shops without their own token stay unconfigured');
    r = await j('GET', '/api/settings', null, TA);
    ok(r.body.square_token_set === false && r.body.resend_configured === false,
      'Settings reports the truth: no per-shop credential means not configured');

    section('legacy single-shop database joins the portal');
    // A deployment that lived as Alpha's own URL: legacy hub mode, data on
    // shop 1, hub key in settings — then the SAME database boots as portal.
    const ldir = freshDir('portal-legacy');
    legacy = startServer('backend', 'server.js', {
      DB_PATH: path.join(ldir, 'dose.db'), PORT: String(LEGACY), SETUP_SECRET: 'lsetup',
      DEFAULT_HUB_URL: HUB_API,
    });
    const jl = client(`http://127.0.0.1:${LEGACY}`, 'x-dose-key');
    await waitUp(`http://127.0.0.1:${LEGACY}/api/auth-status`);
    r = await jl('POST', '/api/setup', { mode: 'hub', setup_code: 'lsetup', hub_api_key: alphaKey });
    ok(r.status === 200 && r.body.connected, 'legacy deployment connects with its per-shop key');
    r = await jl('POST', '/api/login', { username: ALPHA, password: 'alpha-pass-1' });
    const TL = r.body.token;
    ok(r.status === 200, 'legacy login (old ingest path) works');
    await jl('POST', '/api/recipes', { square_item_name: 'Legacy Flat White', method: 'espresso', coffee_grams: 17 }, TL);
    legacy.kill();
    await waitExit(legacy);

    const portal2 = startServer('backend', 'server.js', {
      DB_PATH: path.join(ldir, 'dose.db'), PORT: '4534', PORTAL_KEY: PKEY,
      DEFAULT_HUB_URL: HUB_API, DOSE_SECRET_KEY: 'portal-test-secret',
    });
    legacy = portal2;
    const jp = client('http://127.0.0.1:4534', 'x-dose-key');
    await waitUp('http://127.0.0.1:4534/api/auth-status');
    r = await jp('POST', '/api/login', { username: ALPHA, password: 'alpha-pass-1' });
    ok(r.status === 200, 'same database, now in portal mode: Alpha logs in');
    r = await jp('GET', '/api/recipes', null, r.body.token);
    ok(r.body.length === 1 && r.body[0].square_item_name === 'Legacy Flat White',
      'pre-portal data linked to the hub identity — nothing re-entered, no duplicate shop');
    const db3 = new (sqlite())(path.join(ldir, 'dose.db'));
    const linkRow = db3.prepare('SELECT * FROM shops WHERE id=1').get();
    const shopCount = db3.prepare('SELECT COUNT(*) n FROM shops').get().n;
    db3.close();
    ok(linkRow.hub_shop_id === alphaHubId && shopCount === 1, `shop 1 carries the hub id, no stray rows (hub ${linkRow.hub_shop_id}, ${shopCount} shop)`);
  } catch (e) {
    ok(false, `suite crashed: ${e.message}`);
    console.log('--- hub log tail ---\n' + hub.log.slice(-1200));
    if (app) console.log('--- portal log tail ---\n' + app.log.slice(-1200));
  } finally {
    hub.kill();
    if (app) app.kill();
    if (legacy) try { legacy.kill(); } catch { /* already dead */ }
    for (const p of extras) try { p.kill(); } catch { /* already dead */ }
  }
  finish();
})();
