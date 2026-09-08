// Shop-app pressure tests: delivery-cycle torture (LA DST included), Square
// date-filter correctness, two-pool analytics edges, and standing-order
// failure visibility. Boots the real backend against a mock Square + mock hub.
const path = require('path');
const { ok, near, section, finish, freshDir, client, startServer, waitUp, mockSquare, mockHub, sqlite } = require('./helpers');

const PORT = 4510, SQ = 4511, HUB = 4512;
const API = `http://127.0.0.1:${PORT}`;
const j = client(API, 'x-dose-key');
const LB = 453.592;

(async () => {
  const dir = freshDir('shop');
  const { state: sq } = await mockSquare(SQ);
  const { state: hub } = await mockHub(HUB);
  const server = startServer('backend', 'server.js', {
    DB_PATH: path.join(dir, 'dose.db'), PORT: String(PORT), SETUP_SECRET: 'ptest',
    SQUARE_ACCESS_TOKEN: 'fake', SQUARE_BASE_URL: `http://127.0.0.1:${SQ}`,
  });

  try {
    await waitUp(`${API}/api/auth-status`);
    const su = await j('POST', '/api/setup', { username: 'admin1', password: 'ptest-pass-123', setup_code: 'ptest' });
    const T = su.body.token;
    ok(!!T, 'setup + login');

    // One espresso recipe so analytics has something to count.
    await j('POST', '/api/recipes', { square_item_name: 'Latte', method: 'espresso', coffee_grams: 18 }, T);
    sq.orders = [{ line_items: [{ name: 'Latte', quantity: '10' }, { name: 'Muffin', quantity: '3' }] }];

    section('DST: LA offsets in the Square date filter');
    // Spring forward 2026-03-08: before is PST (-08:00), after is PDT (-07:00).
    await j('POST', '/api/coffee-deliveries', { delivery_date: '2026-03-06', espresso_lbs_onhand: 2, espresso_lbs_received: 10, filter_lbs_onhand: 0, filter_lbs_received: 0 }, T);
    await j('POST', '/api/coffee-deliveries', { delivery_date: '2026-03-10', espresso_lbs_onhand: 5, espresso_lbs_received: 10, filter_lbs_onhand: 0, filter_lbs_received: 0 }, T);
    sq.searches.length = 0;
    let r = await j('POST', '/api/analytics', { start_date: '2026-03-06', end_date: '2026-03-09' }, T);
    ok(r.status === 200 && r.body.period.days === 4, `spring-forward cycle computes (${r.body.period && r.body.period.days} days)`);
    let filt = sq.searches[0] && sq.searches[0].query.filter.date_time_filter.created_at;
    ok(filt && filt.start_at === '2026-03-06T00:00:00.000-08:00', `cycle start uses PST offset (${filt && filt.start_at})`);
    ok(filt && filt.end_at === '2026-03-09T23:59:59.999-07:00', `cycle end uses PDT offset (${filt && filt.end_at})`);
    ok(r.body.cycle_open === false && near(r.body.eff.espresso.actual_remaining, 5 * LB), 'closing count read across the DST boundary');

    // Fall back 2026-11-01: before is PDT (-07:00), after is PST (-08:00).
    await j('POST', '/api/coffee-deliveries', { delivery_date: '2026-10-30', espresso_lbs_onhand: 3, espresso_lbs_received: 10, filter_lbs_onhand: 0, filter_lbs_received: 0 }, T);
    await j('POST', '/api/coffee-deliveries', { delivery_date: '2026-11-03', espresso_lbs_onhand: 6, espresso_lbs_received: 10, filter_lbs_onhand: 0, filter_lbs_received: 0 }, T);
    sq.searches.length = 0;
    r = await j('POST', '/api/analytics', { start_date: '2026-10-30', end_date: '2026-11-02' }, T);
    filt = sq.searches[0] && sq.searches[0].query.filter.date_time_filter.created_at;
    ok(filt && filt.start_at.endsWith('-07:00') && filt.end_at.endsWith('-08:00'), `fall-back offsets correct (${filt && filt.start_at} → ${filt && filt.end_at})`);

    section('cycle torture: same-day and retroactive deliveries');
    await j('POST', '/api/coffee-deliveries', { delivery_date: '2026-06-01', espresso_lbs_onhand: 2, espresso_lbs_received: 10, filter_lbs_onhand: 1, filter_lbs_received: 5 }, T);
    await j('POST', '/api/coffee-deliveries', { delivery_date: '2026-06-01', espresso_lbs_onhand: 0, espresso_lbs_received: 5, filter_lbs_onhand: 0, filter_lbs_received: 0 }, T);
    r = await j('POST', '/api/analytics', { start_date: '2026-06-01', end_date: '2026-06-05' }, T);
    // First delivery of the period counts on-hand + received; later same-period
    // deliveries count received only: 2+10+5 = 17 lb espresso.
    ok(near(r.body.eff.espresso.stocked, 17 * LB), `same-day double delivery: opening stock 17 lb (got ${(r.body.eff.espresso.stocked / LB).toFixed(1)})`);

    await j('POST', '/api/coffee-deliveries', { delivery_date: '2026-06-10', espresso_lbs_onhand: 9, espresso_lbs_received: 0, filter_lbs_onhand: 0, filter_lbs_received: 0 }, T);
    // A delivery logged late, dated between the others.
    await j('POST', '/api/coffee-deliveries', { delivery_date: '2026-06-07', espresso_lbs_onhand: 11, espresso_lbs_received: 5, filter_lbs_onhand: 0, filter_lbs_received: 0 }, T);
    r = await j('POST', '/api/analytics', { start_date: '2026-06-01', end_date: '2026-06-06' }, T);
    ok(r.body.closing_delivery_date === '2026-06-07' && near(r.body.eff.espresso.actual_remaining, 11 * LB),
      'retroactive delivery becomes the closing count for the earlier cycle');

    section('analytics edges');
    r = await j('POST', '/api/analytics', { start_date: '2026-06-01', end_date: '2026-06-01' }, T);
    ok(r.status === 200 && r.body.period.days >= 1, 'single-day range never divides by zero');
    // No recipes matching anything: usage zero, sales surfaced as unmatched.
    sq.orders = [{ line_items: [{ name: 'Mystery Drink', quantity: '7' }] }];
    r = await j('POST', '/api/analytics', { start_date: '2026-06-01', end_date: '2026-06-05' }, T);
    ok(r.body.eff.espresso.used === 0 && r.body.unmatched['Mystery Drink'] === 7, 'unmatched-only period: zero use, sales called out');
    sq.orders = [];
    r = await j('GET', '/api/order-suggestion', null, T);
    ok(r.body.available === true && r.body.pools.espresso.days_left === null, 'zero burn → no fake days-left');

    section('standing orders: failure is visible, not log-only');
    await j('POST', '/api/settings', { hub_url: `http://127.0.0.1:${HUB}`, hub_api_key: 'dose_testkey' }, T);
    r = await j('POST', '/api/standing-orders', { frequency: 'weekly', items: [{ coffee_id: 1, roast: 'espresso', lbs: 10 }] }, T);
    ok(r.status === 200, 'standing order created against the hub price list');
    const soId = r.body.id;
    // Backdate it so it's due, then run with the hub's catalog down.
    const db = new (sqlite())(path.join(dir, 'dose.db'));
    db.prepare('UPDATE standing_orders SET next_date=? WHERE id=?').run('2020-01-01', soId);
    db.close();
    hub.mode = 'catalog-down';
    r = await j('POST', '/api/standing-orders/run', null, T);
    let so = r.body.find(s => s.id === soId);
    ok(so && /^FAILED:/.test(so.last_result || ''), `failed run recorded on the order (${so && so.last_result})`);
    ok(so && so.next_date > '2020-01-01', 'date still advances (no retry storm)');
    // Next cycle: hub back up → success recorded, order actually pushed.
    hub.mode = 'ok';
    const db2 = new (sqlite())(path.join(dir, 'dose.db'));
    db2.prepare('UPDATE standing_orders SET next_date=? WHERE id=?').run('2020-01-01', soId);
    db2.close();
    r = await j('POST', '/api/standing-orders/run', null, T);
    so = r.body.find(s => s.id === soId);
    ok(so && /^placed order #\d+$/.test(so.last_result || ''), `recovery run recorded (${so && so.last_result})`);
    ok(hub.pushes.length === 1 && hub.pushes[0].items[0].lbs === 10, 'the recovered order really reached the hub');
    r = await j('GET', '/api/standing-orders', null, T);
    ok(r.body[0].last_result !== undefined, 'last_result exposed to the Order page');

    section('order validation walls');
    r = await j('POST', '/api/orders', { order_date: '2026-06-08', items: [{ coffee_id: 1, roast: 'espresso', lbs: 7 }] }, T);
    ok(r.status === 400 && /multiples of 5/.test(r.body.error), 'non-5lb wholesale quantity rejected');
    r = await j('POST', '/api/orders', { order_date: '2026-06-08', items: [{ coffee_id: 2, roast: 'retail_filter', bags: 3 }] }, T);
    ok(r.status === 400 && /not offered as retail/.test(r.body.error), 'retail bags of a non-retail coffee rejected');
    r = await j('POST', '/api/orders', { order_date: '2026-06-08', items: [{ coffee_id: 99, roast: 'espresso', lbs: 5 }] }, T);
    ok(r.status === 400 && /not on your price list/.test(r.body.error), 'unknown coffee rejected');
  } catch (e) {
    ok(false, `suite crashed: ${e.message}`);
    console.log(server.log.slice(-1500));
  } finally {
    server.kill();
  }
  finish();
})();
