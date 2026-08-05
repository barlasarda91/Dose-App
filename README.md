# Dose — Coffee Efficiency Dashboard

Track coffee and milk efficiency for your coffee shop by comparing Square POS sales against stock deliveries, and order coffee from the roastery in one click.

## Setup

### Railway Environment Variables
Set these in your Railway service → Variables tab:

| Variable | Required | Description |
|---|---|---|
| `SQUARE_ACCESS_TOKEN` | Yes | Your Square production access token (starts with EAAA) |
| `NODE_ENV` | Yes | Set to `production` |
| `DB_PATH` | Recommended | SQLite path on the persistent volume, e.g. `/app/data/dose.db` |
| `DOSE_PASSWORD` | Strongly recommended | Shared password protecting the app and API. Without it, anyone with the URL can read sales data and place orders. |
| `RESEND_API_KEY` | For ordering | [Resend](https://resend.com) API key used to email orders to the roastery. Orders are saved (not emailed) without it. |
| `ORDER_EMAIL_FROM` | Optional | From address for order emails, e.g. `Dose Orders <orders@yourdomain.com>`. Must be a Resend-verified sender. |

### Deploy
1. Push this repo to GitHub
2. Create a new Railway project → Deploy from GitHub repo
3. Add the environment variables above
4. Create a volume mounted at `/app/data` (without it, data resets on every deploy)
5. Railway auto-builds and deploys

## How it works

- **Dashboard** — opens on the current delivery cycle automatically with a snapshot of how much of the stock on hand has been consumed, pool by pool. Select any cycle or date range to re-run. Drinks sold that don't match a recipe are called out rather than silently dropped.
- **Stock Log** — log coffee deliveries (per pool) and milk deliveries / Numilk rates
- **Order** — place a coffee order with the roastery, emailed to the configured address (default `hello@boxxcoffee.com`). Includes a suggested order computed from the current cycle's burn rate, a one-click **Duplicate Last Order**, and a full order history.
- **Drink Recipes** — maps Square item names to coffee pool and gram dose. Pre-seeded with your menu on first run.
- **Settings** — Square Location ID (optional), shop name + order email for ordering, and status of the token / password / email configuration

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
