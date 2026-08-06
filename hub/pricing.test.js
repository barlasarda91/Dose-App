const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isVisible, effectivePrice, catalogForShop, priceOrderItems } = require('./pricing');

const ITEMS = [
  { id: 1, name: 'Seasonal Espresso Blend', notes: 'chocolate', badge: 'house', low_stock: 0, price_per_lb: 12.40, visibility: 'standard', active: 1 },
  { id: 2, name: 'Ethiopia Yirgacheffe', notes: 'bergamot', badge: null, low_stock: 0, price_per_lb: 16.80, visibility: 'standard', active: 1 },
  { id: 3, name: 'Custom Blend for Cafe X', notes: 'secret', badge: null, low_stock: 0, price_per_lb: 15.00, visibility: 'exclusive', active: 1 },
  { id: 4, name: 'Retired Coffee', notes: '', badge: null, low_stock: 0, price_per_lb: 10.00, visibility: 'standard', active: 0 },
];
const GRANTS = [{ coffee_id: 3, shop_id: 7 }];

test('standard items visible to everyone; exclusive only to granted shops', () => {
  assert.equal(isVisible(ITEMS[0], 5, GRANTS), true);
  assert.equal(isVisible(ITEMS[2], 5, GRANTS), false);
  assert.equal(isVisible(ITEMS[2], 7, GRANTS), true);
});

test('catalogForShop hides exclusive and archived items and strips internals', () => {
  const cat5 = catalogForShop(ITEMS, 5, GRANTS, []);
  assert.deepEqual(cat5.map(i => i.id), [1, 2]);
  const cat7 = catalogForShop(ITEMS, 7, GRANTS, []);
  assert.deepEqual(cat7.map(i => i.id), [1, 2, 3]);
  assert.equal(cat7[0].visibility, undefined); // internals never leave the hub
});

test('amount_off, percent_off, and override rules', () => {
  assert.equal(effectivePrice(ITEMS[0], 5, [{ shop_id: 5, coffee_id: 1, rule_type: 'amount_off', value: 1.5 }]), 10.9);
  assert.equal(effectivePrice(ITEMS[0], 5, [{ shop_id: 5, coffee_id: 1, rule_type: 'percent_off', value: 10 }]), 11.16);
  assert.equal(effectivePrice(ITEMS[0], 5, [{ shop_id: 5, coffee_id: 1, rule_type: 'override', value: 9.99 }]), 9.99);
});

test('item rule beats catalog-wide rule; other shops unaffected', () => {
  const rules = [
    { shop_id: 5, coffee_id: null, rule_type: 'percent_off', value: 10 },
    { shop_id: 5, coffee_id: 2, rule_type: 'override', value: 15.00 },
  ];
  assert.equal(effectivePrice(ITEMS[0], 5, rules), 11.16); // catalog-wide applies
  assert.equal(effectivePrice(ITEMS[1], 5, rules), 15.00); // item override wins
  assert.equal(effectivePrice(ITEMS[0], 8, rules), 12.40); // shop 8 pays base
});

test('discounts never push a price below zero', () => {
  assert.equal(effectivePrice(ITEMS[0], 5, [{ shop_id: 5, coffee_id: 1, rule_type: 'amount_off', value: 99 }]), 0);
});

test('priceOrderItems prices with hub prices, ignoring client-sent ones', () => {
  const cat = catalogForShop(ITEMS, 7, GRANTS, [{ shop_id: 7, coffee_id: 3, rule_type: 'amount_off', value: 1 }]);
  const { items, total_lbs, total_cost } = priceOrderItems(
    [
      { coffee_id: 1, roast: 'espresso', lbs: 15, price_per_lb: 0.01 }, // lying price ignored
      { coffee_id: 3, roast: 'filter', lbs: 10 },
    ], cat);
  assert.equal(items[0].price_per_lb, 12.40);
  assert.equal(items[0].line_total, 186.00);
  assert.equal(items[1].price_per_lb, 14.00); // 15.00 − 1 exclusive discount
  assert.equal(total_lbs, 25);
  assert.equal(total_cost, 326.00);
});

test('priceOrderItems rejects invisible coffees, bad roasts, and zero qty', () => {
  const cat5 = catalogForShop(ITEMS, 5, GRANTS, []);
  assert.throws(() => priceOrderItems([{ coffee_id: 3, roast: 'filter', lbs: 5 }], cat5), /not available/);
  assert.throws(() => priceOrderItems([{ coffee_id: 1, roast: 'dark', lbs: 5 }], cat5), /roast/);
  assert.throws(() => priceOrderItems([{ coffee_id: 1, roast: 'filter', lbs: 0 }], cat5), /quantity/);
  assert.throws(() => priceOrderItems([], cat5), /no items/);
});
