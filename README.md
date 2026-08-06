# Dose — Coffee Efficiency Dashboard

Track coffee and milk efficiency for your coffee shop by comparing Square POS sales against stock deliveries, and order coffee from the roastery in one click.

## Setup

The app is self-configuring: on first visit it asks you to **create a shop password**, and everything shop-specific — the Square access token, Resend API key, order email — is entered on the **Settings page after logging in** and stored in that shop's own database. Deploying a new shop needs no secrets in Railway at all.

### Railway Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` |
| `DB_PATH` | Recommended | SQLite path on the persistent volume, e.g. `/app/data/dose.db` |
| `DOSE_PASSWORD` | Optional | Seeds the shop password on first boot (skips the create-password screen). In-app password changes take precedence afterwards. |
| `SQUARE_ACCESS_TOKEN` | Optional fallback | Used only when no token has been entered in Settings. |
| `RESEND_API_KEY` | Optional fallback | Used only when no key has been entered in Settings. |
| `ORDER_EMAIL_FROM` | Optional fallback | Used only when no from-address has been entered in Settings. |

Secrets are stored in the shop's database (password as a salted scrypt hash; login uses random session tokens) and are never echoed back to the browser.

### Deploy
1. Push this repo to GitHub
2. Create a new Railway project → Deploy from GitHub repo
3. Set `NODE_ENV=production` and `DB_PATH=/app/data/dose.db`
4. Create a volume mounted at `/app/data` (without it, data resets on every deploy)
5. Open the app → create the shop password → paste the Square token (and optionally Resend key) in Settings

## How it works

- **Dashboard** — opens on the current delivery cycle automatically with a snapshot of how much of the stock on hand has been consumed, pool by pool. Select any cycle or date range to re-run. Drinks sold that don't match a recipe are called out rather than silently dropped.
- **Stock Log** — log coffee deliveries (per pool) and milk deliveries / Numilk rates
- **Order** — place a coffee order with the roastery, emailed to the configured address (default `hello@boxxcoffee.com`). Includes a suggested order computed from the current cycle's burn rate, a one-click **Duplicate Last Order**, and a full order history.
- **Drink Recipes** — maps Square item names to coffee pool and gram dose. Pre-seeded with your menu on first run.
- **Settings** — Square access token + Location ID, shop name / order email / Resend key for ordering, and password change. Secret fields are write-only: they show configured/not-configured, never the value.

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

## Development

```bash
npm run install:all          # install backend + frontend deps
npm --prefix backend test    # unit tests for the efficiency / cycle / order math (backend/calc.js)
npm --prefix backend run dev # backend on :3001
npm --prefix frontend start  # frontend dev server on :3000 (proxies /api)
```
