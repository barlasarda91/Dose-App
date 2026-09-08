// Hub UI pressure tests: the dashboard driven through a real browser —
// login errors, the first-run bootstrap, forced password change, role-gated
// UI (staff sees no Team tab or Delete buttons), and the confirm-order flow.
//
// Playwright is not a project dependency; this suite uses whatever the
// environment provides (PLAYWRIGHT_BROWSERS_PATH / NODE_PATH, as on the
// Claude Code runner) and SKIPS cleanly when it can't.
const path = require('path');
const { ok, section, finish, freshDir, client, startServer, waitUp } = require('./helpers');

let chromium;
try {
  if (process.env.NODE_PATH) require('module').Module._initPaths();
  ({ chromium } = require('playwright'));
} catch {
  console.log('SKIP: playwright not available in this environment — UI suite not run.');
  process.exit(0);
}
const EXEC = process.env.PW_CHROMIUM || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const PORT = 4530;
const API = `http://127.0.0.1:${PORT}`;
const j = client(API, 'x-hub-key');

(async () => {
  const dir = freshDir('hub-ui');
  const server = startServer('hub', 'server.js', {
    HUB_DB_PATH: path.join(dir, 'hub.db'), PORT: String(PORT), HUB_PASSWORD: 'ui-boot-code',
  });
  let browser;
  try {
    await waitUp(`${API}/api/health`);
    browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'temp-pass-99999' : undefined));

    section('first-run bootstrap');
    await page.goto(API);
    await page.waitForSelector('#boot-form', { timeout: 5000 });
    ok(true, 'fresh hub shows the create-owner form, not a login');
    await page.fill('#b-un', 'owner1');
    await page.fill('#b-email', 'owner@example.com');
    await page.fill('#b-pw', 'owner-pass-1234');
    await page.fill('#b-code', 'WRONG');
    await page.click('#boot-form button');
    await page.waitForTimeout(600);
    ok((await page.textContent('#boot-err')).includes('bootstrap code'), 'wrong bootstrap code surfaces an error');
    await page.fill('#b-code', 'ui-boot-code');
    await page.click('#boot-form button');
    await page.waitForSelector('.nav', { timeout: 5000 });
    ok(true, 'correct code lands on the dashboard');
    ok(await page.isVisible('text=Team'), 'owner sees the Team tab');

    section('team + forced password change');
    await page.click('[data-tab="team"]');
    await page.waitForSelector('#t-add');
    await page.fill('#t-un', 'staff1');
    await page.fill('#t-email', 'staff@example.com');
    await page.fill('#t-pw', 'temp-pass-12345');
    await page.click('#t-add');
    await page.waitForTimeout(800);
    ok(await page.isVisible('text=temp password — not yet set'), 'new account listed with temp-password status');

    const p2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await p2.goto(API);
    await p2.waitForSelector('#login-form');
    await p2.fill('#un', 'staff1');
    await p2.fill('#pw', 'wrong-password');
    await p2.click('#login-form button');
    await p2.waitForTimeout(600);
    ok((await p2.textContent('#login-err')).length > 0, 'wrong password shows an error in place');
    await p2.fill('#pw', 'temp-pass-12345');
    await p2.click('#login-form button');
    await p2.waitForSelector('#cpw-form', { timeout: 5000 });
    ok(true, 'temp password forces the set-your-own screen');
    await p2.fill('#c-new', 'staff-real-pass-1');
    await p2.click('#cpw-form button');
    await p2.waitForSelector('.nav', { timeout: 5000 });
    ok(!(await p2.isVisible('[data-tab="team"]')), 'staff does NOT see the Team tab');

    section('orders flow as staff');
    // Seed a shop + order via API (owner token from the first page's storage).
    const tok = await page.evaluate(() => localStorage.getItem('hub_key'));
    await j('POST', '/api/catalog', { name: 'Blend No. 1', price_per_lb: 14.5 }, tok);
    const shopRes = await j('POST', '/api/shops', { name: 'UI Test Shop', email: 'shop@example.com' }, tok);
    await fetch(`${API}/api/ingest/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shopRes.body.api_key}` },
      body: JSON.stringify({ order_date: '2026-06-01', items: [{ coffee_id: 1, roast: 'espresso', lbs: 10 }] }),
    });
    await p2.click('[data-tab="orders"]');
    await p2.waitForSelector('.neworder', { timeout: 5000 });
    ok(await p2.isVisible('text=UI Test Shop'), 'new order card shows for staff');
    ok(!(await p2.isVisible('.neworder >> text=Delete')), 'staff sees no Delete button on the order card');
    await p2.click('text=Confirm Order');
    await p2.waitForTimeout(1000);
    ok(!(await p2.isVisible('.neworder')), 'confirming clears the new-order card');
    await p2.click('#past-toggle');
    await p2.waitForTimeout(400);
    ok(await p2.isVisible('text=confirmed · staff1'), 'past table shows who confirmed');

    section('owner still sees owner controls');
    await page.click('[data-tab="orders"]');
    await page.waitForSelector('#past-toggle', { timeout: 5000 });
    await page.click('#past-toggle');
    await page.waitForTimeout(400);
    ok(await page.isVisible('text=Delete'), 'owner sees Delete in past orders');
  } catch (e) {
    ok(false, `suite crashed: ${e.message}`);
    console.log(server.log.slice(-1200));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
  finish();
})();
