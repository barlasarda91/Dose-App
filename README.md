# Dose — Coffee Efficiency Dashboard

Track coffee and milk efficiency for your coffee shop by comparing Square POS sales against stock deliveries, and order coffee from the roastery in one click.

## Setup

**Accounts are issued by the roastery hub.** Creating a shop in the hub creates its account: a login username (derived from the shop name, e.g. `boxx-kadikoy`), a registered email, a password, and the deployment's API key — all in one step. The shop app verifies logins **against the hub**, with a 24-hour cached-credential fallback so a hub outage doesn't lock out anyone who logged in recently (active sessions are never affected). There is no self-registration anywhere.

**Provisioning a shop:** create the shop in the hub → deploy the shop app → open its URL → the first-run screen (gated by the setup code from the server logs) connects it to the hub with the API key → hand the client the URL + their hub-issued username/password. Passwords are changed from the shop app (proxied to the hub) or reset by the roastery (Hub → Shops → Reset Login).

**Standalone mode** remains for shops without a hub: the first-run screen can instead create a local admin who manages local user accounts (`admin`/`user` roles) from Settings → Users, exactly as before. A hub-connected deployment that predates hub logins keeps its local accounts working until a hub password is set.

### Railway Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` |
| `DB_PATH` | Recommended | SQLite path on the persistent volume, e.g. `/app/data/dose.db` |
| `DOSE_PASSWORD` | Optional | Seeds the admin account's password on first boot, skipping the setup screen (username from `ADMIN_USERNAME`, default `admin`). |
| `ADMIN_USERNAME` | Optional | Username for the seeded admin account (default `admin`). |
| `SETUP_SECRET` | Optional | Overrides the auto-generated first-run setup code. |
| `DOSE_SECRET_KEY` | Recommended | Any long random string. When set, credentials stored in the database (Square token, Resend key) are AES-256-GCM encrypted, so a leaked database file alone reveals nothing. Don't lose it — re-enter credentials if it changes. |
| `SQUARE_ACCESS_TOKEN` | Optional fallback | Used only when no token has been entered in Settings. |
| `RESEND_API_KEY` | Optional fallback | Used only when no key has been entered in Settings. |
| `ORDER_EMAIL_FROM` | Optional fallback | Used only when no from-address has been entered in Settings. |

### Security model

- **No self-registration.** The first-run setup screen requires a one-time **setup code printed to the server logs** (Railway → Deployments → View Logs), so only whoever operates the deployment can claim the admin account — even if someone else finds the URL first.
- Passwords are salted **scrypt** hashes (hashed asynchronously — login never blocks the server). Admin accounts require 10+ character passwords, users 6+.
- Login is **rate-limited** per IP and per username: 5 failures triggers an escalating lockout (30s doubling up to 15 min).
- Sessions are random 256-bit tokens; the database stores only their **SHA-256 hash**, and sessions **expire after 30 days** (sliding renewal while active). Password changes/resets and account deletion revoke sessions immediately.
- Credentials in the database are **encrypted at rest** when `DOSE_SECRET_KEY` is set, and are never echoed back to the browser.
- Stock, order, and recipe writes record **which user made them** (`created_by`).
- Deployments upgraded from the earlier shared-password version migrate automatically: the old password becomes the `admin` account.
- Known accepted trade-off: the session token lives in `localStorage` (not an httpOnly cookie). Revisit if the app ever renders user-supplied HTML.

### Deploy (provisioning a shop)
1. Push this repo to GitHub
2. Create a new Railway project → Deploy from GitHub repo
3. Set `NODE_ENV=production` and `DB_PATH=/app/data/dose.db`
4. Create a volume mounted at `/app/data` (without it, data resets on every deploy)
5. Open the app → enter the **setup code** from the deploy logs → create the **admin** account (this is you, the provisioner)
6. Settings: paste the shop's Square token, set shop name / order email, create the client's user account(s)
7. Hand the client the URL and their username + password

## How it works

- **Dashboard** — opens on the current delivery cycle automatically. The live cycle shows only what's knowable without a stock count: kg used per roast, burn rate (lbs/day), ~days left with a depletion bar, the suggested next order, and where the filter roast goes by brew method (batch / cold brew / pour-over). Waste settles **cycle to cycle**: a Closed Cycles section tables the last three closed cycles per roast (stocked / used / counted / waste with % of opening, red WASTE chip above 5%). Drinks sold that don't match a recipe are called out rather than silently dropped.
- **Stock Log** — log coffee deliveries per roast (Espresso Roast / Filter Roast) and milk deliveries / Numilk rates
- **Order** — place a coffee order with the roastery, emailed to the configured address (default `hello@boxxcoffee.com`). Includes a suggested order computed from the current cycle's burn rate, a one-click **Duplicate Last Order**, and a full order history.
- **Drink Recipes** — each recipe is **picked from the shop's live Square catalog** (with 30-day sold counts), never typed, so names always match sales data. The editor asks *how is it brewed* — Espresso Machine, Batch Brew, Cold Brew, or Pour-Over — and the method decides the roast. Batch methods take batch inputs (coffee per batch + yield as cups served, or liters + serving oz) and the per-cup dose is computed server-side; espresso and pour-over keep a per-drink dose. Square items with no recipe are surfaced with **Map It** or **No coffee — ignore**. Starts empty — nothing is pre-seeded.
- **Settings** — Square access token + Location ID, ordering config, and user management (all admin-only), plus own-password change for everyone. Secret fields are write-only: they show configured/not-configured, never the value.

## Delivery cycles

Efficiency is measured between deliveries, not calendar periods. A delivery on date *D* closes the previous cycle (its on-hand count is that cycle's ground truth) and opens a new one:

- **Cycle N** runs from delivery N through the **day before** delivery N+1. Delivery N+1's received bags belong to cycle N+1, never to cycle N's opening stock.
- **Open cycle** — no closing delivery yet: theoretical use vs opening stock, no waste verdict.
- **Closed cycle** — real waste = (opening stock − theoretical use) − on-hand count at the next delivery. Flagged only when the gap exceeds 5% of opening stock.

Square order timestamps are filtered in the shop's own timezone (read from the Square location), so a cycle's days match the shop's actual days.

## Milk tracking (deferred)
Milk/syrup tracking is currently hidden from the UI while the shop → hub → order cycle is the focus; the data model remains and the feature returns in the efficiency-precision phase.

## Roast pools

Stock is held per **roast** — the thing the shop actually buys — not per brew method:

| Roast | Brew methods that draw from it |
|---|---|
| Espresso Roast | Espresso Machine |
| Filter Roast | Batch Brew, Cold Brew, Pour-Over |

Usage is still tallied per method (that's the dashboard's "where the filter roast goes" split), then rolled up to the two roasts for stock, efficiency, and order suggestions. Older four-pool delivery history folds drip + cold brew + pour-over into filter automatically.

## Dose calculations

Doses are recipe-driven, per shop — nothing is hard-coded. Batch-brewed methods compute the per-cup dose from real batch numbers (e.g. 900g per batch ÷ 40 cups served = 22.5g/cup; or 1800g into 19L at 8oz servings = 22.4g/cup); espresso and pour-over are set per drink.

## Dose Hub (roastery side)

The `hub/` directory contains a separate service for the roastery:

- **Catalog** — the coffee list shops order from: name, tasting notes, base price/lb, optional **12oz retail bag price**, badges (Blend / Single Origin / Single Farm / Single Lot / Decaf + Low stock), archive flag. Items are *standard* (all shops) or *exclusive* (only the shops you pick — e.g. a custom blend for one client).
- **Per-shop pricing** — per client, a catalog-wide or per-item rule: amount off, % off, or a fixed override. Shops only ever see their final price; base prices and rules never leave the hub.
- **Orders inbox** — new orders get an olive-lifted card at the top with one Confirm button; everything already handled collapses under a **Past Orders** tile searchable by month, account, and status. Orders work through **new → confirmed → shipped → delivered**; confirming and shipping each email the shop, and the roaster can **edit an order's quantities** before shipping (which emails an updated summary). New orders trigger a receipt email to the shop's registered address (and `HUB_NOTIFY_EMAIL` if set).
- **Roast Program** — everything confirmed and *not yet roasted*, per **coffee × roast profile** (12oz retail bags are ordered per profile and batch with the matching wholesale roast). Each line is checked against the **On Hand** shelf first, then counted in **whole batches**: green needed = roasted owed ÷ (1 − loss), batches always round up — an order for 35 lbs on a 55→47.5 lbs batch still means one full batch, and the ~12.5 lbs left over lands on the shelf. The roaster chooses per line: **fill from stock** or **roast it all fresh**; either way the real drop weight is logged and full-roasted orders get the "Roasted" email.
- **On Hand** — roasted coffee sitting at the roastery, per coffee × profile, with committed vs free split and a full movements ledger (batches in, order fills out, ± manual adjustments for samples/recounts).
- **Roast Math** — what one batch *is*, per roast profile: lbs green in → lbs roasted out (loss % computed, never typed). Roastery-wide defaults plus per-coffee overrides.
- **Fulfillment** — one bucket card per confirmed order, grouped by customer and sorted by requested delivery. Items stay greyed "awaiting roast" until their coffee is marked roasted, then get checked off as they're physically packed (wholesale shown as 5-lb bags, retail as 12oz bags). A **4×6 packing slip** prints per order, and a fully packed order ships with one click — which sends the "Shipped" email and updates the shop's order history.
- **Reports** — roasted coffee per client, rolled up automatically at the close of each week and month. Orders are kept forever (storage is negligible).
- **Shops** — create a shop with its registered email to mint its API key (shown once, stored hashed); edit, rotate keys.
- **Patterns** — per shop: volume, spend, espresso/filter roast mix, top coffees, cadence, 12-week trend.

**Hub environment variables:** `HUB_PASSWORD` (roastery login, required), `HUB_DB_PATH=/app/data/hub.db`, `RESEND_API_KEY` + `HUB_EMAIL_FROM` (sender — must be on the Resend-verified domain, e.g. `Dose Hub <order@send.boxxcoffee.com>`), `HUB_REPLY_TO` (where shop replies land, e.g. `order@boxxcoffee.com`), `HUB_NOTIFY_EMAIL` (your copy of new orders), `HUB_CURRENCY` (default `$`).

**Deploy** (own Railway service, same repo): New service → same GitHub repo → **Root Directory `/hub`** → variables above → volume at `/app/data`.

**Connect a shop:**
1. Hub → Shops → Add Shop (name + registered email + login password) → copy the API key. The shop's login username is generated from its name and shown after creation.
2. Fresh deployment: enter hub URL + API key on the first-run screen. Existing deployment: Settings → Ordering → Roastery Hub.
3. The shop's Order page switches from pool quantities to the live price list (their personalized view, including 12oz retail bags where offered), supports **standing orders** (weekly / bi-weekly / monthly, placed automatically at live prices), logins are verified by the hub, and roastery confirm/ship/deliver statuses appear in the shop's order history automatically. The hub URL is fixed app-wide (`DEFAULT_HUB_URL` env to override) — shops only ever enter their API key. Orders are priced server-side at order time — later price changes never rewrite history.

Shop pushes are authenticated per shop (`Bearer dose_…`), re-priced and re-validated by the hub on ingest, and deduplicated (a retried push never duplicates an order).

**Hub accounts** — every roastery person signs in with their own username + password (salted scrypt, per-user and per-IP lockouts, expiring hashed session tokens — the shop app's security model). `HUB_PASSWORD` is not a login: on a fresh hub it acts once, as the bootstrap code that creates the first **owner** account, then never works again. Two roles: **owners** additionally manage the Team tab (add accounts with a temporary password that must be replaced on first sign-in, reset, deactivate — deactivation signs that person out everywhere), catalog and price rules, shop credentials, and order deletion; **staff** run daily ops. Every consequential action lands in an append-only, signed **audit trail** (Team → Activity), orders show who confirmed and shipped them, and stock movements show who made them.

## Backups

Both services snapshot their SQLite database **nightly** (one per Los Angeles calendar day) into a `backups/` folder next to the database — on the same mounted Railway volume — keeping the newest **14** (`BACKUP_KEEP` to change, `BACKUP_DIR` to relocate). Snapshots use SQLite's online backup, so they're consistent even while the app is serving. A missed night self-heals: the hourly check (and every restart) writes the day's snapshot if it's absent.

- **See it's working**: hub `/api/health` reports `backup: { last, age_hours, count }`; the shop app has admin-only `GET /api/backups`.
- **Pull a copy off Railway**: `GET /api/backups/download` (latest, or `?file=` for a specific one) — shop admin login / hub dashboard login required. `POST /api/backups/run` forces a fresh snapshot first if wanted.
- **Second layer**: enable Railway's own volume backups (service → volume → Backups) so the entire volume — snapshots included — is also covered outside the box.

## Development

```bash
npm run install:all          # install backend + frontend + hub deps
npm --prefix backend run dev # backend on :3001
npm --prefix frontend start  # frontend dev server on :3000 (proxies /api)
```

## Testing

```bash
npm test            # everything below, in order
npm run test:unit   # backend/calc.test.js — pure math (doses, cycles, pricing)
npm run test:shop   # tests/shop.test.js — real backend vs mock Square + mock hub
npm run test:hub    # tests/hub.test.js — real hub, full roastery lifecycle
npm run test:ui     # tests/hub-ui.test.js — hub dashboard in a real browser
```

The pressure suites (`tests/`) boot the actual servers on throwaway databases and attack the seams: LA DST-spanning cycles (asserting the exact offsets sent to Square), same-day and retroactive deliveries, standing-order failure visibility, ingest dedup on retried pushes, roast-fill idempotency and On Hand ledger math, role walls, and the login/bootstrap/forced-password-change flows in a browser. The UI suite needs Playwright + a Chromium (`PW_CHROMIUM` env to point at one) and skips cleanly when absent. No network access is required — Square and the hub are mocked locally.
