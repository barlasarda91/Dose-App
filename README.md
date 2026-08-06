# Dose — Coffee Efficiency Dashboard

Track coffee and milk efficiency for your coffee shop by comparing Square POS sales against stock deliveries, and order coffee from the roastery in one click.

## Setup

The app is self-configuring and uses **user accounts with roles** — there is no self-registration. The first visit to a fresh deployment shows a one-time setup screen that creates the **admin** account; whoever provisions the shop (the roastery) does this **before** handing the URL to the client, then creates the client's accounts from Settings → Users. Everything shop-specific — the Square access token, Resend API key, order email — is entered on the **Settings page by an admin** and stored in that shop's own database. Deploying a new shop needs no secrets in Railway at all.

**Roles:** `admin` — manage users, credentials (Square token, Resend key, order emails), everything else. `user` — run reports, log stock, place orders, edit recipes; cannot touch users or credentials.

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

The `hub/` directory contains a separate, lightweight service for the roastery: an **orders inbox** (new → confirmed → delivered), **per-shop order history**, and **ordering patterns** (volume, pool mix, cadence, 12-week trend per shop). Client shops push orders to it automatically when they hit Send Order — email keeps working independently as a fallback.

**Deploy** (own Railway service, same repo):
1. New Railway service → same GitHub repo → set **Root Directory** to `/hub`
2. Variables: `HUB_PASSWORD` (roastery login), optionally `HUB_DB_PATH=/app/data/hub.db`
3. Volume mounted at `/app/data`

**Connect a shop:**
1. In the hub: Shops tab → Add Shop → copy the API key (shown once; stored only as a hash)
2. In that shop's Dose app: Settings → Ordering → Roastery Hub → paste the hub URL + API key
3. From then on, every sent order appears in the hub inbox with who placed it; work it through Confirm → Delivered

Shop pushes are authenticated per shop (`Bearer dose_…`), deduplicated (a retried push never duplicates an order), and the hub login is rate-limited with expiring hashed session tokens — same security model as the shop app.

## Development

```bash
npm run install:all          # install backend + frontend deps
npm --prefix backend test    # unit tests for the efficiency / cycle / order math (backend/calc.js)
npm --prefix backend run dev # backend on :3001
npm --prefix frontend start  # frontend dev server on :3000 (proxies /api)
```
