const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LBS_TO_GRAMS, aggregateOrders, calcCoffeeStock, calcEfficiency, suggestOrderLbs, priceItemsFromCatalog } = require('./calc');

// ─── aggregateOrders ──────────────────────────────────────────────────────────

test('aggregateOrders tallies items, quantities and milk modifiers', () => {
  const orders = [
    { line_items: [
      { name: 'Caffe Latte', quantity: '2', modifiers: [{ name: 'Oat' }] },
      { name: 'Americano', quantity: '1' },
    ]},
    { line_items: [
      { name: 'Caffe Latte', quantity: '1', modifiers: [{ name: ' whole ' }] },
    ]},
  ];
  const { orders: items, modifiers } = aggregateOrders(orders);
  const latte = items.find(i => i.name === 'Caffe Latte');
  assert.equal(latte.qty, 3);
  assert.deepEqual(latte.milk, { whole: 1, oat: 2, almond: 0 });
  assert.equal(items.find(i => i.name === 'Americano').qty, 1);
  assert.deepEqual(modifiers, { milk_whole: 1, milk_oat: 2, milk_almond: 0 });
});

test('aggregateOrders ignores unknown modifiers', () => {
  const { modifiers } = aggregateOrders([
    { line_items: [{ name: 'Latte', quantity: '1', modifiers: [{ name: 'Oat Milk' }, { name: 'Vanilla' }] }] },
  ]);
  assert.deepEqual(modifiers, { milk_whole: 0, milk_oat: 0, milk_almond: 0 });
});

// ─── calcCoffeeStock ──────────────────────────────────────────────────────────

test('calcCoffeeStock: empty delivery list means no stock', () => {
  assert.equal(calcCoffeeStock([], 'r', 'o'), 0);
});

test('calcCoffeeStock: first delivery counts on-hand + received, later ones received only', () => {
  const dels = [
    { r: 10, o: 5 },  // opening: (5 + 10) lbs
    { r: 20, o: 3 },  // mid-cycle: +20 lbs received; its on-hand must NOT count
  ];
  const stock = calcCoffeeStock(dels, 'r', 'o');
  assert.ok(Math.abs(stock - 35 * LBS_TO_GRAMS) < 0.001, `got ${stock}`);
});

test('calcCoffeeStock: closing delivery excluded by caller keeps cycle stock honest', () => {
  // Cycle A→B: only delivery A belongs to the cycle. Delivery B (received 25)
  // opens the next cycle — passing just [A] is the contract.
  const A = { r: 10, o: 2 };
  assert.equal(calcCoffeeStock([A], 'r', 'o'), 12 * LBS_TO_GRAMS);
});

// ─── calcEfficiency ───────────────────────────────────────────────────────────

test('calcEfficiency: no stock but usage flags NO_STOCK_LOGGED', () => {
  const e = calcEfficiency({ stocked: 0, used: 500, cycleOpen: true });
  assert.equal(e.flag, 'NO_STOCK_LOGGED');
  assert.equal(e.efficiency_pct, null);
});

test('calcEfficiency: open cycle reports pct but no waste verdict', () => {
  const e = calcEfficiency({ stocked: 10000, used: 4000, cycleOpen: true });
  assert.equal(e.efficiency_pct, 40);
  assert.equal(e.theoretical_remaining, 6000);
  assert.equal(e.waste, null);
  assert.equal(e.flag, null);
  assert.equal(e.cycle_open, true);
});

test('calcEfficiency: usage above stock flags OVER_EXPECTED', () => {
  const e = calcEfficiency({ stocked: 1000, used: 1200, cycleOpen: false, actualRemaining: 0 });
  assert.equal(e.flag, 'OVER_EXPECTED');
});

test('calcEfficiency: closed cycle with gap above 5% of stock flags WASTE', () => {
  // stocked 10kg, used 4kg → expect 6kg left; counted only 5.2kg → 800g waste (8%)
  const e = calcEfficiency({ stocked: 10000, used: 4000, cycleOpen: false, actualRemaining: 5200 });
  assert.equal(e.waste, 800);
  assert.equal(e.flag, 'WASTE');
});

test('calcEfficiency: closed cycle with small gap reports waste but no flag', () => {
  // 300g gap = 3% of stock → below the 5% threshold
  const e = calcEfficiency({ stocked: 10000, used: 4000, cycleOpen: false, actualRemaining: 5700 });
  assert.equal(e.waste, 300);
  assert.equal(e.flag, null);
});

test('calcEfficiency: counting more than expected never flags waste', () => {
  const e = calcEfficiency({ stocked: 10000, used: 4000, cycleOpen: false, actualRemaining: 6500 });
  assert.equal(e.waste, -500);
  assert.equal(e.flag, null);
});

// ─── suggestOrderLbs ──────────────────────────────────────────────────────────

test('suggestOrderLbs orders the 7-day burn minus expected remaining, rounded up', () => {
  // 1000 g/day burn, 2000g expected left → need 5000g ≈ 12 lbs
  const lbs = suggestOrderLbs({ usedGrams: 7000, days: 7, expectedRemainingGrams: 2000 });
  assert.equal(lbs, Math.ceil(5000 / LBS_TO_GRAMS));
});

test('suggestOrderLbs never goes negative and survives missing remaining', () => {
  assert.equal(suggestOrderLbs({ usedGrams: 700, days: 7, expectedRemainingGrams: 99999 }), 0);
  assert.equal(suggestOrderLbs({ usedGrams: 0, days: 0, expectedRemainingGrams: null }), 0);
});

// ─── priceItemsFromCatalog ────────────────────────────────────────────────────

test('priceItemsFromCatalog prices lines and totals from the hub catalog', () => {
  const catalog = [
    { id: 1, name: 'Blend', price_per_lb: 12.40 },
    { id: 2, name: 'Yirgacheffe', price_per_lb: 16.80 },
  ];
  const { items, total_lbs, total_cost } = priceItemsFromCatalog(
    [{ coffee_id: 1, roast: 'espresso', lbs: 15 }, { coffee_id: 2, roast: 'filter', lbs: 10 }], catalog);
  assert.equal(items[0].line_total, 186.00);
  assert.equal(items[1].line_total, 168.00);
  assert.equal(total_lbs, 25);
  assert.equal(total_cost, 354.00);
});

test('priceItemsFromCatalog rejects unknown coffees and bad input', () => {
  const catalog = [{ id: 1, name: 'Blend', price_per_lb: 12 }];
  assert.throws(() => priceItemsFromCatalog([{ coffee_id: 99, roast: 'filter', lbs: 5 }], catalog), /price list/);
  assert.throws(() => priceItemsFromCatalog([{ coffee_id: 1, roast: 'light', lbs: 5 }], catalog), /roast/);
  assert.throws(() => priceItemsFromCatalog([], catalog), /no items/);
});

test('priceItemsFromCatalog enforces 5-lb wholesale increments', () => {
  const catalog = [{ id: 1, name: 'Blend', price_per_lb: 12, retail_price: 14 }];
  assert.throws(() => priceItemsFromCatalog([{ coffee_id: 1, roast: 'filter', lbs: 3 }], catalog), /multiples of 5/);
  const ok = priceItemsFromCatalog([{ coffee_id: 1, roast: 'filter', lbs: 10 }, { coffee_id: 1, roast: 'retail', bags: 2 }], catalog);
  assert.equal(ok.total_lbs, 11.5);
});
