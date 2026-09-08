// Pure calculation logic for Dose analytics — no I/O, fully unit-testable.

const LBS_TO_GRAMS = 453.592;
const GALLONS_TO_ML = 3785.41;

// Tally Square orders into per-item counts, per-item milk modifier counts,
// and overall milk modifier totals.
function aggregateOrders(orders) {
  const itemCounts = {};
  // itemMilk tracks per-item modifier counts: { 'Caffe Latte': { whole: 12, oat: 8, almond: 3 } }
  const itemMilk = {};
  const mods = { milk_whole: 0, milk_oat: 0, milk_almond: 0 };
  for (const order of orders) {
    for (const item of (order.line_items || [])) {
      const name = item.name || 'Unknown';
      const qty = parseInt(item.quantity || '1', 10);
      itemCounts[name] = (itemCounts[name] || 0) + qty;
      if (!itemMilk[name]) itemMilk[name] = { whole: 0, oat: 0, almond: 0 };
      for (const mod of (item.modifiers || [])) {
        const n = (mod.name || '').toLowerCase().trim();
        if (n === 'whole')  { mods.milk_whole  += qty; itemMilk[name].whole  += qty; }
        if (n === 'oat')    { mods.milk_oat    += qty; itemMilk[name].oat    += qty; }
        if (n === 'almond') { mods.milk_almond += qty; itemMilk[name].almond += qty; }
      }
    }
  }
  return {
    orders: Object.entries(itemCounts).map(([name, qty]) => ({
      name, qty,
      milk: itemMilk[name] || { whole: 0, oat: 0, almond: 0 },
    })),
    modifiers: mods,
  };
}

// Opening stock for a cycle, in grams. The deliveries passed in must belong to
// the cycle ONLY — the closing delivery (the one that ends the cycle) must NOT
// be included, since its received bags belong to the next cycle and its
// on-hand count is the previous cycle's closing truth.
//   stock = (on_hand + received) at first delivery, + received at later ones
function calcCoffeeStock(dels, receivedField, onhandField) {
  if (dels.length === 0) return 0;
  const first = dels[0];
  let stock = (first[onhandField] + first[receivedField]) * LBS_TO_GRAMS;
  for (let i = 1; i < dels.length; i++) stock += dels[i][receivedField] * LBS_TO_GRAMS;
  return stock;
}

// Efficiency for one pool.
// Closed cycle (actualRemaining from the closing delivery's on-hand count):
//   waste = theoretical remaining - actual remaining, flagged when > 5% of stock
// Open cycle: theoretical use vs stock only, no waste verdict.
function calcEfficiency({ stocked, used: usedRaw, actualRemaining = null, cycleOpen }) {
  const used = Math.round(usedRaw * 10) / 10;
  if (!stocked) {
    return {
      stocked: 0, used, efficiency_pct: null,
      theoretical_remaining: null, actual_remaining: null, waste: null,
      flag: used > 0 ? 'NO_STOCK_LOGGED' : null, cycle_open: cycleOpen,
    };
  }
  const theoreticalRem = stocked - used;
  const pct = Math.round((used / stocked) * 1000) / 10;
  let flag = null;
  let waste = null;
  if (used > stocked) {
    flag = 'OVER_EXPECTED';
  } else if (!cycleOpen && actualRemaining !== null) {
    waste = theoreticalRem - actualRemaining;
    if (waste > stocked * 0.05) flag = 'WASTE';
  }
  return {
    stocked: Math.round(stocked * 10) / 10,
    used,
    efficiency_pct: pct,
    theoretical_remaining: Math.round(theoreticalRem * 10) / 10,
    actual_remaining: actualRemaining !== null ? Math.round(actualRemaining * 10) / 10 : null,
    waste: waste !== null ? Math.round(waste * 10) / 10 : null,
    flag,
    cycle_open: cycleOpen,
  };
}

// Suggested order for one pool, in whole lbs: enough for `horizonDays` at the
// current burn rate, minus what should still be on the shelf.
function suggestOrderLbs({ usedGrams, days, expectedRemainingGrams, horizonDays = 7 }) {
  const burnPerDay = days > 0 ? usedGrams / days : 0;
  const remaining = Math.max(0, expectedRemainingGrams || 0);
  const needGrams = burnPerDay * horizonDays - remaining;
  return Math.max(0, Math.ceil(needGrams / LBS_TO_GRAMS));
}

// A 12oz retail bag holds 0.75 lb of roasted coffee.
const BAG_LBS = 0.75;

// ─── Brew methods ────────────────────────────────────────────────────────────
// How a drink is brewed determines which ROAST it draws from — espresso
// machine drinks pull espresso roast, everything else pulls filter roast.
// Stock and efficiency are tracked per roast; the method is kept so usage can
// still be broken down (batch vs cold brew vs pour-over).
const METHODS = ['espresso', 'batch', 'coldbrew', 'pourover'];
const METHOD_ROAST = { espresso: 'espresso', batch: 'filter', coldbrew: 'filter', pourover: 'filter' };
const OZ_PER_LITER = 33.814;

// Per-cup dose for batch-brewed methods (batch brew, cold brew): coffee in
// per batch ÷ cups out. Yield comes as cups served directly, or as brewed
// volume + serving size.
function batchDoseGrams({ batch_grams, yield_mode, yield_cups, yield_liters, serving_oz }) {
  const g = parseFloat(batch_grams);
  if (!Number.isFinite(g) || g <= 0) throw new Error('Coffee per batch must be a positive number of grams');
  let cups;
  if (yield_mode === 'vol') {
    const l = parseFloat(yield_liters), oz = parseFloat(serving_oz);
    if (!Number.isFinite(l) || l <= 0) throw new Error('Batch volume in liters is required');
    if (!Number.isFinite(oz) || oz <= 0) throw new Error('Serving size in oz is required to turn volume into cups');
    cups = (l * OZ_PER_LITER) / oz;
  } else {
    cups = parseFloat(yield_cups);
    if (!Number.isFinite(cups) || cups <= 0) throw new Error('Cups served per batch is required');
  }
  return Math.round((g / cups) * 10) / 10;
}

// Retail bags carry their roast profile ('retail_espresso' / 'retail_filter')
// so the roastery can batch them with the matching wholesale roast. Plain
// 'retail' is the legacy value from before the split — still accepted.
const RETAIL_ROASTS = ['retail', 'retail_espresso', 'retail_filter'];
const isRetail = r => RETAIL_ROASTS.includes(r);

// Price an order's line items against the catalog fetched from the hub.
// The hub recomputes prices on ingest with the same rules — this keeps the
// locally stored copy identical to what the roastery bills. Lines are either
// wholesale (roast espresso/filter, lbs) or retail (12oz bags, per profile).
function priceItemsFromCatalog(rawItems, catalogItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error('Order has no items');
  const byId = new Map(catalogItems.map(i => [i.id, i]));
  const items = rawItems.map(raw => {
    const coffee = byId.get(parseInt(raw.coffee_id, 10));
    if (!coffee) throw new Error(`Coffee ${raw.coffee_id} is not on your price list`);
    if (isRetail(raw.roast)) {
      if (coffee.retail_price == null) throw new Error(`${coffee.name} is not offered as retail bags`);
      const bags = Math.round(parseFloat(raw.bags) || 0);
      if (bags <= 0) throw new Error(`Invalid bag count for ${coffee.name}`);
      return {
        coffee_id: coffee.id, coffee_name: coffee.name, roast: raw.roast,
        bags, lbs: Math.round(bags * BAG_LBS * 100) / 100,
        price_per_lb: coffee.retail_price, // unit price: per bag for retail lines
        line_total: Math.round(bags * coffee.retail_price * 100) / 100,
      };
    }
    const roast = raw.roast === 'espresso' ? 'espresso' : raw.roast === 'filter' ? 'filter' : null;
    if (!roast) throw new Error(`Invalid roast for ${coffee.name}`);
    const lbs = Math.round((parseFloat(raw.lbs) || 0) * 10) / 10;
    if (lbs <= 0) throw new Error(`Invalid quantity for ${coffee.name}`);
    if (Math.abs(lbs / 5 - Math.round(lbs / 5)) > 1e-9)
      throw new Error(`Wholesale orders are in multiples of 5 lbs — ${coffee.name} has ${lbs} lbs`);
    const line_total = Math.round(lbs * coffee.price_per_lb * 100) / 100;
    return { coffee_id: coffee.id, coffee_name: coffee.name, roast, bags: null, lbs, price_per_lb: coffee.price_per_lb, line_total };
  });
  return {
    items,
    total_lbs: Math.round(items.reduce((s, i) => s + i.lbs, 0) * 100) / 100,
    total_cost: Math.round(items.reduce((s, i) => s + i.line_total, 0) * 100) / 100,
  };
}

module.exports = { LBS_TO_GRAMS, GALLONS_TO_ML, BAG_LBS, RETAIL_ROASTS, isRetail, METHODS, METHOD_ROAST, OZ_PER_LITER, batchDoseGrams, aggregateOrders, calcCoffeeStock, calcEfficiency, suggestOrderLbs, priceItemsFromCatalog };
