// Pure pricing/visibility logic for the hub catalog — no I/O, unit-tested.
//
// Visibility: an item is either standard (every shop sees it) or exclusive
// (only shops explicitly granted see it).
//
// Price rules: per shop, either per-item or catalog-wide (coffee_id null).
// An item-specific rule beats the catalog-wide rule. Types:
//   amount_off  — subtract a fixed amount per lb (never below 0)
//   percent_off — subtract a percentage
//   override    — replace the price outright

function isVisible(item, shopId, exclusiveGrants) {
  if (item.visibility !== 'exclusive') return true;
  return exclusiveGrants.some(g => g.coffee_id === item.id && g.shop_id === shopId);
}

function applyRule(basePrice, rule) {
  if (!rule) return basePrice;
  const v = Number(rule.value) || 0;
  switch (rule.rule_type) {
    case 'amount_off':  return Math.max(0, basePrice - v);
    case 'percent_off': return Math.max(0, basePrice * (1 - v / 100));
    case 'override':    return Math.max(0, v);
    default:            return basePrice;
  }
}

function effectivePrice(item, shopId, rules) {
  const itemRule = rules.find(r => r.shop_id === shopId && r.coffee_id === item.id);
  const globalRule = rules.find(r => r.shop_id === shopId && r.coffee_id === null);
  const price = applyRule(item.price_per_lb, itemRule || globalRule);
  return Math.round(price * 100) / 100;
}

// A 12oz retail bag holds 0.75 lb of roasted coffee (used for roast totals).
const BAG_LBS = 0.75;

// The catalog exactly as one shop should see it: visible+active items only,
// effective prices only — base prices and rules never leave the hub.
// Retail bag prices are flat (per-shop price rules apply to wholesale /lb
// pricing only, v1).
function catalogForShop(items, shopId, exclusiveGrants, rules) {
  return items
    .filter(i => i.active)
    .filter(i => isVisible(i, shopId, exclusiveGrants))
    .map(i => ({
      id: i.id,
      name: i.name,
      notes: i.notes,
      badge: i.badge || null,
      low_stock: !!i.low_stock,
      price_per_lb: effectivePrice(i, shopId, rules),
      retail_price: i.retail_price != null && i.retail_price > 0 ? Math.round(i.retail_price * 100) / 100 : null,
    }));
}

// Validate and price an incoming order's line items against the shop's own
// catalog view. Client-supplied prices are ignored — the hub's price wins.
// Lines are either wholesale (roast espresso/filter, lbs) or retail
// (roast 'retail', bags of 12oz).
function priceOrderItems(rawItems, shopCatalog) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error('Order has no items');
  const byId = new Map(shopCatalog.map(i => [i.id, i]));
  const items = rawItems.map(raw => {
    const coffee = byId.get(parseInt(raw.coffee_id, 10));
    if (!coffee) throw new Error(`Coffee ${raw.coffee_id} is not available to this shop`);
    if (raw.roast === 'retail') {
      if (coffee.retail_price == null) throw new Error(`${coffee.name} is not offered as retail bags`);
      const bags = Math.round(parseFloat(raw.bags) || 0);
      if (bags <= 0) throw new Error(`Invalid bag count for ${coffee.name}`);
      const line_total = Math.round(bags * coffee.retail_price * 100) / 100;
      return {
        coffee_id: coffee.id, coffee_name: coffee.name, roast: 'retail',
        bags, lbs: Math.round(bags * BAG_LBS * 100) / 100,
        price_per_lb: coffee.retail_price, // unit price: per bag for retail lines
        line_total,
      };
    }
    const roast = raw.roast === 'espresso' ? 'espresso' : raw.roast === 'filter' ? 'filter' : null;
    if (!roast) throw new Error(`Invalid roast for ${coffee.name} — must be espresso, filter, or retail`);
    const lbs = Math.round((parseFloat(raw.lbs) || 0) * 10) / 10;
    if (lbs <= 0) throw new Error(`Invalid quantity for ${coffee.name}`);
    if (Math.abs(lbs / 5 - Math.round(lbs / 5)) > 1e-9)
      throw new Error(`Wholesale orders are in multiples of 5 lbs — ${coffee.name} has ${lbs} lbs`);
    const line_total = Math.round(lbs * coffee.price_per_lb * 100) / 100;
    return { coffee_id: coffee.id, coffee_name: coffee.name, roast, bags: null, lbs, price_per_lb: coffee.price_per_lb, line_total };
  });
  const total_lbs = Math.round(items.reduce((s, i) => s + i.lbs, 0) * 100) / 100;
  const total_cost = Math.round(items.reduce((s, i) => s + i.line_total, 0) * 100) / 100;
  return { items, total_lbs, total_cost };
}

module.exports = { BAG_LBS, isVisible, effectivePrice, catalogForShop, priceOrderItems };
