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

- **Dashboard** — opens on the current delivery cycle automatically with a snapshot of how much of the stock on hand has been consumed, pool by pool. Select any cycle or date range to re-run. Drinks sold that don't match a recipe are called out rather than silently dropped.
- **Stock Log** — log coffee deliveries (per pool) and milk deliveries / Numilk rates
- **Order** — place a coffee order with the roastery, emailed to the configured address (default `hello@boxxcoffee.com`). Includes a suggested order computed from the current cycle's burn rate, a one-click **Duplicate Last Order**, and a full order history.
- **Drink Recipes** — maps Square item names to coffee pool and gram dose. Pre-seeded with your menu on first run.
- **Settings** — Square access token + Location ID, ordering config, and user management (all admin-only), plus own-password change for everyone. Secret fields are write-only: they show configured/not-configured, never the value.

## Delivery cycles

Efficiency is measured between deliveries, not calendar periods. A delivery on date *D* closes the previous cycle (its on-hand count is that cycle's ground truth) and opens a new one:

- **Cycle N** runs from delivery N through the **day before** delivery N+1. Delivery N+1's received bags belong to cycle N+1, never to cycle N's opening stock.
- **Open cycle** — no closing delivery yet: theoretical use vs opening stock, no waste verdict.
- **Closed cycle** — real waste = (opening stock − theoretical use) − on-hand count at the next delivery. Flagged only when the gap exceeds 5% of opening stock.

Square order timestamps are filtered in the shop's own timezone (read from the Square location), so a cycle's days match the shop's actual days.

## Milk tracking
Milk consumption is calculated from Square modifier counts (Whole / Oat / Almond), not recipe definitions. Configure ml-per-modifier in Stock Log (default 180ml).

## Coffee pools
| Pool | Items |
|---|---|
| Espresso | All espresso-based drinks |
| Drip | Batch Brew, Cafe Au Lait |
| Cold Brew | Cold Brew |
| Pour-Over | Pour Over (all beans), Turkish Coffee |

## Dose calculations
- **Drip**: 24.4g per cup (110g ÷ 4.5 cups per batch)
- **Cold Brew**: 26.2g per serve (4kg ÷ 152.5 serves from 20×1.8L bottles)
- **Pour-Over**: 19g per single brew
- **Turkish**: 7.5g, deducted from pour-over pool

## Dose Hub (roastery side)

The `hub/` directory contains a separate service for the roastery:

- **Catalog** — the coffee list shops order from: name, tasting notes, base price/lb, badges (House / Seasonal / Low stock), archive flag. Items are *standard* (all shops) or *exclusive* (only the shops you pick — e.g. a custom blend for one client).
- **Per-shop pricing** — per client, a catalog-wide or per-item rule: amount off, % off, or a fixed override. Shops only ever see their final price; base prices and rules never leave the hub.
- **Orders inbox** — line-item orders (coffee × roast × lbs × price) worked through new → confirmed → delivered. **Confirming emails the shop.** New orders trigger a receipt email to the shop's registered address (and `HUB_NOTIFY_EMAIL` if set).
- **Shops** — create a shop with its registered email to mint its API key (shown once, stored hashed); edit, rotate keys.
- **Patterns** — per shop: volume, spend, espresso/filter roast mix, top coffees, cadence, 12-week trend.

**Hub environment variables:** `HUB_PASSWORD` (roastery login, required), `HUB_DB_PATH=/app/data/hub.db`, `RESEND_API_KEY` + `HUB_EMAIL_FROM` (receipt/confirmation emails), `HUB_NOTIFY_EMAIL` (your copy of new orders), `HUB_CURRENCY` (default `$`).

**Deploy** (own Railway service, same repo): New service → same GitHub repo → **Root Directory `/hub`** → variables above → volume at `/app/data`.

**Connect a shop:**
1. Hub → Shops → Add Shop (name + registered email + login password) → copy the API key. The shop's login username is generated from its name and shown after creation.
2. Fresh deployment: enter hub URL + API key on the first-run screen. Existing deployment: Settings → Ordering → Roastery Hub.
3. The shop's Order page switches from pool quantities to the live price list (their personalized view), logins are verified by the hub, and roastery confirmations appear in the shop's order history automatically. Orders are priced server-side at order time — later price changes never rewrite history.

Shop pushes are authenticated per shop (`Bearer dose_…`), re-priced and re-validated by the hub on ingest, and deduplicated (a retried push never duplicates an order). Hub login is rate-limited with expiring hashed session tokens — same security model as the shop app.

## Development

```bash
npm run install:all          # install backend + frontend deps
npm --prefix backend test    # unit tests for the efficiency / cycle / order math (backend/calc.js)
npm --prefix backend run dev # backend on :3001
npm --prefix frontend start  # frontend dev server on :3000 (proxies /api)
```
