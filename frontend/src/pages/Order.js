import React, { useState, useEffect, useMemo } from 'react';
import { apiJson } from '../api';
import DateField from '../DateField';

const TODAY = new Date().toISOString().slice(0, 10);

const POOLS = [
  { field: 'espresso_lbs', key: 'espresso', label: 'Espresso' },
  { field: 'drip_lbs',     key: 'drip',     label: 'Drip' },
  { field: 'coldbrew_lbs', key: 'coldbrew', label: 'Cold Brew' },
  { field: 'pourover_lbs', key: 'pourover', label: 'Pour-Over' },
];

const STATUS_LABELS = {
  sent: '✓ Sent',
  email_failed: '⚠ Saved, not delivered',
  saved: 'Saved',
};

function statusText(o) {
  if (o.hub_status === 'confirmed') return { text: '✓ Confirmed by roastery', color: 'var(--olive)' };
  if (o.hub_status === 'shipped') return { text: '⇢ Shipped', color: 'var(--graphite)' };
  if (o.hub_status === 'delivered') return { text: '✓ Delivered', color: 'var(--drift)' };
  const base = STATUS_LABELS[o.status] || o.status;
  return { text: base, color: o.status === 'sent' ? 'var(--olive)' : 'var(--warn)' };
}

const isRetailRoast = r => r === 'retail' || String(r).startsWith('retail_');
const ROAST_TAGS = { espresso: 'ESP', filter: 'FLT', retail: 'RTL', retail_espresso: 'RTL·ESP', retail_filter: 'RTL·FLT' };

const roastTag = r => (
  <span style={{ fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--drift)', border: '1px solid var(--linen)', padding: '1px 4px', marginRight: 6 }}>
    {ROAST_TAGS[r] || r}
  </span>
);

const itemQty = i => isRetailRoast(i.roast) ? `${i.bags} × 12oz` : `${i.lbs} lbs`;

const FREQ_LABELS = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };

// Same page, two layouts: below 700px the price-list table becomes a card
// per coffee with tap steppers, and the send button pins to the bottom.
function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)');
    const onChange = e => setMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

export default function Order() {
  const isMobile = useIsMobile();
  const [catalog, setCatalog]   = useState(null); // { configured, currency, items, error }
  const [orders, setOrders]     = useState([]);
  const [standing, setStanding] = useState([]);
  // quantities keyed by `${coffeeId}:${roast}` — roast: espresso | filter | retail (bags)
  const [qty, setQty]           = useState({});
  const [reqDate, setReqDate]   = useState('');
  const [notes, setNotes]       = useState('');
  const [freq, setFreq]         = useState('weekly');
  const [sending, setSending]   = useState(false);
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);
  const [dupNote, setDupNote]   = useState(null);
  const [soMsg, setSoMsg]       = useState(null);

  useEffect(() => {
    apiJson('/api/hub-catalog').then(setCatalog).catch(() => setCatalog({ configured: false, items: [] }));
    apiJson('/api/orders').then(setOrders).catch(() => {});
    apiJson('/api/standing-orders').then(setStanding).catch(() => {});
  }, []);

  const currency = catalog?.currency || '$';
  const money = v => `${currency}${(Math.round(v * 100) / 100).toFixed(2)}`;
  const items = catalog?.items || [];
  const catalogMode = !!(catalog?.configured && items.length > 0);
  const anyRetail = items.some(it => it.retail_price != null);

  // Retail bags are ordered per roast profile — espresso-roast bags batch
  // with wholesale espresso at the roastery, filter with filter.
  const lines = useMemo(() => {
    const out = [];
    for (const it of items) {
      for (const roast of ['espresso', 'filter']) {
        const v = parseFloat(qty[`${it.id}:${roast}`]) || 0;
        if (v > 0) out.push({ coffee_id: it.id, coffee_name: it.name, roast, lbs: v, line_total: v * it.price_per_lb });
      }
      for (const roast of ['retail_espresso', 'retail_filter']) {
        const b = Math.round(parseFloat(qty[`${it.id}:${roast}`]) || 0);
        if (b > 0 && it.retail_price != null) {
          out.push({ coffee_id: it.id, coffee_name: it.name, roast, bags: b, line_total: b * it.retail_price });
        }
      }
    }
    return out;
  }, [qty, items]);

  const totalLbs = Math.round(lines.filter(l => !isRetailRoast(l.roast)).reduce((s, l) => s + l.lbs, 0) * 10) / 10;
  const totalBags = lines.filter(l => isRetailRoast(l.roast)).reduce((s, l) => s + l.bags, 0);
  const totalCost = lines.reduce((s, l) => s + l.line_total, 0);
  const hasLines = lines.length > 0;
  const summaryQty = [totalLbs > 0 ? `${totalLbs} lbs` : null, totalBags > 0 ? `${totalBags} bags` : null].filter(Boolean).join(' · ') || '—';
  // Per-profile roast totals with retail bags folded in (0.75 lb each) —
  // this mirrors how the roastery batches it.
  const espRoastLbs = Math.round(lines.reduce((s, l) => s + (l.roast === 'espresso' ? l.lbs : l.roast === 'retail_espresso' ? l.bags * 0.75 : 0), 0) * 100) / 100;
  const fltRoastLbs = Math.round(lines.reduce((s, l) => s + (l.roast === 'filter' ? l.lbs : l.roast === 'retail_filter' ? l.bags * 0.75 : 0), 0) * 100) / 100;

  const setQ = (id, roast) => e => { setQty(p => ({ ...p, [`${id}:${roast}`]: e.target.value })); setDupNote(null); };

  // Stepper taps: ±5 lbs for wholesale roasts, ±1 bag for retail.
  const bump = (id, roast, dir) => {
    const k = `${id}:${roast}`;
    const inc = isRetailRoast(roast) ? 1 : 5;
    setQty(p => {
      const next = Math.max(0, (parseFloat(p[k]) || 0) + dir * inc);
      const out = { ...p };
      if (next > 0) out[k] = String(next); else delete out[k];
      return out;
    });
    setDupNote(null);
  };

  // Shared stepper: −/+ buttons around a typeable value.
  const Stepper = ({ id, roast, small }) => (
    <span className={`stepper${small ? ' stepper-sm' : ''}`}>
      <button type="button" aria-label={`Less ${roast}`} onClick={() => bump(id, roast, -1)}>−</button>
      <input type="number" min="0" step={isRetailRoast(roast) ? 1 : 5} inputMode="numeric" placeholder="0"
        value={qty[`${id}:${roast}`] || ''} onChange={setQ(id, roast)} />
      <button type="button" aria-label={`More ${roast}`} onClick={() => bump(id, roast, 1)}>+</button>
    </span>
  );

  // Wholesale ships in 5-lb multiples; retail in whole bags.
  const invalidLines = lines.filter(l => !isRetailRoast(l.roast) && Math.abs(l.lbs / 5 - Math.round(l.lbs / 5)) > 1e-9);
  const incrementError = invalidLines.length
    ? `Wholesale quantities must be multiples of 5 lbs — check ${invalidLines.map(l => `${l.coffee_name} (${l.lbs} lbs)`).join(', ')}`
    : null;

  const payloadItems = () => lines.map(l =>
    isRetailRoast(l.roast)
      ? { coffee_id: l.coffee_id, roast: l.roast, bags: l.bags }
      : { coffee_id: l.coffee_id, roast: l.roast, lbs: l.lbs });

  function fillFromOrder(o) {
    setResult(null); setError(null);
    if (o.items && o.items.length) {
      const next = {};
      const missing = [];
      const legacyRetail = [];
      for (const i of o.items) {
        // Pre-split retail lines carry no roast profile — can't be re-created faithfully.
        if (i.roast === 'retail') { legacyRetail.push(i.coffee_name); continue; }
        const inCatalog = items.some(c => c.id === i.coffee_id && (!isRetailRoast(i.roast) || c.retail_price != null));
        if (inCatalog) next[`${i.coffee_id}:${i.roast}`] = String(isRetailRoast(i.roast) ? i.bags : i.lbs);
        else missing.push(i.coffee_name);
      }
      setQty(next);
      setNotes(o.notes || '');
      const notes2 = [
        missing.length ? `Not on the current price list, skipped: ${[...new Set(missing)].join(', ')}` : null,
        legacyRetail.length ? `Retail bags from before the espresso/filter split need re-adding by hand: ${[...new Set(legacyRetail)].join(', ')}` : null,
      ].filter(Boolean).join(' · ');
      setDupNote(notes2 || null);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function send() {
    if (!hasLines || sending) return;
    if (incrementError) { setError(incrementError); return; }
    setSending(true); setResult(null); setError(null);
    try {
      const data = await apiJson('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ order_date: TODAY, requested_date: reqDate || null, notes, items: payloadItems() }),
      });
      if (data.error) throw new Error(data.error);
      setOrders(x => [data.order, ...x]);
      setResult(data);
      setQty({}); setNotes(''); setReqDate('');
    } catch (e) {
      if (!e.unauthorized) setError(e.message);
    } finally {
      setSending(false);
    }
  }

  async function saveStanding() {
    if (!hasLines) return;
    if (incrementError) { setSoMsg({ ok: false, text: incrementError }); return; }
    setSoMsg(null);
    try {
      const data = await apiJson('/api/standing-orders', {
        method: 'POST',
        body: JSON.stringify({ frequency: freq, items: payloadItems(), notes }),
      });
      if (data.error) throw new Error(data.error);
      setStanding(x => [...x, data].sort((a, b) => a.next_date.localeCompare(b.next_date)));
      setSoMsg({ ok: true, text: `✓ Standing order saved — next order goes out automatically on ${data.next_date}` });
    } catch (e) {
      if (!e.unauthorized) setSoMsg({ ok: false, text: e.message });
    }
  }

  async function cancelStanding(id) {
    if (!window.confirm('Cancel this standing order? No further automatic orders will be placed.')) return;
    await apiJson(`/api/standing-orders/${id}`, { method: 'DELETE' }).catch(() => {});
    setStanding(x => x.filter(s => s.id !== id));
  }

  async function delOrder(id) {
    if (!window.confirm('Delete this order from the log? (Does not recall anything already sent.)')) return;
    await apiJson(`/api/orders/${id}`, { method: 'DELETE' }).catch(() => {});
    setOrders(x => x.filter(o => o.id !== id));
  }

  const lastCatalogOrder = orders.find(o => o.items && o.items.length);

  if (catalog === null) return <div className="page"><div className="empty" style={{ padding: '60px 0' }}>Loading price list…</div></div>;

  return (
    <div className="page">
      <div className="page-eyebrow">Ordering</div>
      <h1 className="page-title">Place Order</h1>
      <p className="page-sub">
        {catalogMode ? 'Order from the roastery price list — goes straight to the roastery hub.' : 'Order coffee from the roastery.'}
      </p>
      <hr className="page-rule" />

      {catalog?.error && (
        <div className="warn-box">⚠ Could not load the price list from the hub: {catalog.error}. Try again shortly or contact the roastery.</div>
      )}

      {result && (
        <div className={(result.hub?.pushed || result.email?.sent) ? 'success-banner' : 'warn-box'}>
          {result.hub?.pushed
            ? <>✓ Order sent to the roastery.{result.hub.receipt?.sent ? ` A receipt was emailed to ${result.hub.receipt.to}.` : ''} You'll get another email when it's confirmed.</>
            : result.email?.sent
              ? <>✓ The hub couldn't be reached, but the order was emailed to {result.email.to}.</>
              : <>⚠ Order saved but not delivered — hub: {result.hub?.reason}{result.email ? ` · email: ${result.email.reason}` : ''}. Use Duplicate to retry.</>}
        </div>
      )}
      {error && <div className="error-banner"><span>⚠</span><div>{error}</div></div>}
      {dupNote && <div className="warn-box">⚠ {dupNote}</div>}

      {catalogMode ? (
        <div className="section">
          <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <span>Coffee List</span>
            {isMobile && lastCatalogOrder && (
              <button className="btn btn-secondary btn-sm" onClick={() => fillFromOrder(lastCatalogOrder)}>⟳ Duplicate Last</button>
            )}
          </div>
          {isMobile ? (
            <div>
              {items.map(it => {
                const lineTotal = ((parseFloat(qty[`${it.id}:espresso`]) || 0) + (parseFloat(qty[`${it.id}:filter`]) || 0)) * it.price_per_lb
                  + (it.retail_price != null
                    ? (Math.round(parseFloat(qty[`${it.id}:retail_espresso`]) || 0) + Math.round(parseFloat(qty[`${it.id}:retail_filter`]) || 0)) * it.retail_price
                    : 0);
                const stepRow = (roast, label, sub) => (
                  <div className="ocard-row" key={roast}>
                    <div className="ocard-rowlbl">{label}<small>{sub}</small></div>
                    <Stepper id={it.id} roast={roast} />
                  </div>
                );
                return (
                  <div className="ocard" key={it.id}>
                    <div className="ocard-head">
                      <div className="ocard-name">
                        {it.name}
                        {it.badge && <span className="ocard-badge">{it.badge}</span>}
                        {it.low_stock && <span className="ocard-badge low">Low stock</span>}
                      </div>
                      {it.notes && <div className="ocard-notes">{it.notes}</div>}
                      <div className="ocard-price">{money(it.price_per_lb)}/lb wholesale</div>
                    </div>
                    {stepRow('espresso', 'Espresso Roast', '5-lb bags · ×5 lbs')}
                    {stepRow('filter', 'Filter Roast', '5-lb bags · ×5 lbs')}
                    {it.retail_price != null && stepRow('retail_espresso', '12oz — Espresso Roast', `${money(it.retail_price)}/bag`)}
                    {it.retail_price != null && stepRow('retail_filter', '12oz — Filter Roast', `${money(it.retail_price)}/bag`)}
                    {lineTotal > 0 && <div className="ocard-total"><span>line total</span><b>{money(lineTotal)}</b></div>}
                  </div>
                );
              })}
            </div>
          ) : (<>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th rowSpan={2} style={{ minWidth: 200, verticalAlign: 'bottom' }}>Coffee</th>
                  <th rowSpan={2} style={{ textAlign: 'right', verticalAlign: 'bottom' }}>Price</th>
                  <th colSpan={2} style={{ textAlign: 'center', color: 'var(--olive)', borderLeft: '1px solid var(--linen)', borderRight: '1px solid var(--linen)' }}>Wholesale — 5 lb bags</th>
                  {anyRetail && <th colSpan={2} style={{ textAlign: 'center', color: 'var(--olive)', borderRight: '1px solid var(--linen)' }}>12oz Retail Bags</th>}
                  <th rowSpan={2} style={{ textAlign: 'right', verticalAlign: 'bottom' }}>Line Total</th>
                </tr>
                <tr>
                  <th style={{ textAlign: 'right', borderLeft: '1px solid var(--linen)' }}>Espresso (lbs ×5)</th>
                  <th style={{ textAlign: 'right', borderRight: '1px solid var(--linen)' }}>Filter (lbs ×5)</th>
                  {anyRetail && <th style={{ textAlign: 'right' }}>Espresso Roast</th>}
                  {anyRetail && <th style={{ textAlign: 'right', borderRight: '1px solid var(--linen)' }}>Filter Roast</th>}
                </tr>
              </thead>
              <tbody>
                {items.map(it => {
                  const lineTotal = ((parseFloat(qty[`${it.id}:espresso`]) || 0) + (parseFloat(qty[`${it.id}:filter`]) || 0)) * it.price_per_lb
                    + (it.retail_price != null
                      ? (Math.round(parseFloat(qty[`${it.id}:retail_espresso`]) || 0) + Math.round(parseFloat(qty[`${it.id}:retail_filter`]) || 0)) * it.retail_price
                      : 0);
                  const stepCell = (roast, enabled = true) => (
                    <td style={{ textAlign: 'right' }}>
                      {enabled ? <Stepper id={it.id} roast={roast} small /> : <span style={{ color: 'var(--linen)' }}>—</span>}
                    </td>
                  );
                  return (
                    <tr key={it.id}>
                      <td>
                        <div style={{ fontFamily: 'var(--font-serif)', fontSize: 15, color: 'var(--ink)' }}>
                          {it.name}
                          {it.badge && <span style={{ fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', border: '1px solid var(--olive)', color: 'var(--olive)', padding: '2px 7px', marginLeft: 8, verticalAlign: 'middle' }}>{it.badge}</span>}
                          {it.low_stock && <span style={{ fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase', border: '1px solid var(--warn)', color: 'var(--warn)', padding: '2px 7px', marginLeft: 8, verticalAlign: 'middle' }}>Low stock</span>}
                        </div>
                        {it.notes && <div style={{ fontSize: 11, color: 'var(--drift)', marginTop: 2 }}>{it.notes}</div>}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {money(it.price_per_lb)}
                        {it.retail_price != null && <div style={{ fontSize: 11, color: 'var(--drift)' }}>{money(it.retail_price)}/bag</div>}
                      </td>
                      {stepCell('espresso')}
                      {stepCell('filter')}
                      {anyRetail && stepCell('retail_espresso', it.retail_price != null)}
                      {anyRetail && stepCell('retail_filter', it.retail_price != null)}
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap', color: lineTotal > 0 ? 'var(--ink)' : 'var(--linen)' }}>
                        {lineTotal > 0 ? money(lineTotal) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16, background: 'var(--stone)', border: '1px solid var(--linen)', borderTop: 'none', padding: '16px 20px' }}>
            <div style={{ display: 'flex', gap: 36, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: '.22em', textTransform: 'uppercase', color: 'var(--drift)' }}>Total</div>
                <div style={{ fontFamily: 'var(--font-serif)', fontSize: 20, color: 'var(--ink)' }}>{summaryQty}</div>
                <div style={{ fontSize: 11, color: 'var(--drift)' }}>
                  {espRoastLbs} lbs espresso roast · {fltRoastLbs} lbs filter roast{totalBags > 0 ? ' (retail bags folded in)' : ''}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: '.22em', textTransform: 'uppercase', color: 'var(--drift)' }}>Est. Cost</div>
                <div style={{ fontFamily: 'var(--font-serif)', fontSize: 20, color: 'var(--ink)' }}>{totalCost > 0 ? money(totalCost) : '—'}</div>
                <div style={{ fontSize: 10, color: 'var(--drift)' }}>at current price list</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {lastCatalogOrder && (
                <button className="btn btn-ghost" onClick={() => fillFromOrder(lastCatalogOrder)}>
                  ⟳ Duplicate Last Order
                </button>
              )}
              <button className="btn btn-primary" onClick={send} disabled={sending || !hasLines}>
                {sending ? '…Sending' : `Send Order${hasLines ? ` — ${summaryQty}` : ''}`}
              </button>
            </div>
          </div>
          </>)}

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 18 }}>
            <div className="form-group">
              <label className="form-lbl">Requested Delivery</label>
              <DateField value={reqDate} onChange={setReqDate} min={TODAY} clearable placeholder="No preference" />
            </div>
            <div className="form-group" style={{ flex: 1, minWidth: 260 }}>
              <label className="form-lbl">Notes</label>
              <input className="form-input" placeholder="e.g. deliver Tuesday morning" value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-title">Standing Order</div>
            <p style={{ fontSize: 12, color: 'var(--drift)', marginBottom: 12, lineHeight: 1.6 }}>
              Fill in the quantities above, pick a rhythm, and Dose places this exact order automatically — prices always taken from the live list on the day it's placed.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="form-select" value={freq} onChange={e => setFreq(e.target.value)}>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="monthly">Monthly</option>
              </select>
              <button className="btn btn-accent" onClick={saveStanding} disabled={!hasLines}>
                Save as Standing Order{hasLines ? ` — ${summaryQty}` : ''}
              </button>
              {soMsg && <span className={`conn-status ${soMsg.ok ? 'ok' : 'fail'}`}>{soMsg.text}</span>}
            </div>
            {standing.length > 0 && (isMobile ? (
              <div style={{ marginTop: 14 }}>
                {standing.map(s => (
                  <div className="hcard" key={s.id}>
                    <div className="hcard-head">
                      <span>{FREQ_LABELS[s.frequency]}</span>
                      <span style={{ color: 'var(--olive)' }}>next: {s.next_date}</span>
                    </div>
                    <div className="hcard-items">
                      {s.items.map((i, idx) => {
                        const c = items.find(x => x.id === parseInt(i.coffee_id, 10));
                        return <div key={idx}>{roastTag(i.roast)}{c ? c.name : `#${i.coffee_id}`} · {isRetailRoast(i.roast) ? `${i.bags} × 12oz` : `${i.lbs} lbs`}</div>;
                      })}
                    </div>
                    <div className="hcard-foot">
                      <span>set by {s.created_by || '—'}</span>
                      <button className="btn btn-danger" onClick={() => cancelStanding(s.id)}>Cancel</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table>
                  <thead><tr><th>Rhythm</th><th>Items</th><th>Next Order</th><th>Set By</th><th></th></tr></thead>
                  <tbody>
                    {standing.map(s => (
                      <tr key={s.id}>
                        <td>{FREQ_LABELS[s.frequency]}</td>
                        <td style={{ fontSize: 11, lineHeight: 1.8 }}>
                          {s.items.map((i, idx) => {
                            const c = items.find(x => x.id === parseInt(i.coffee_id, 10));
                            return <div key={idx}>{roastTag(i.roast)}{c ? c.name : `#${i.coffee_id}`} · {isRetailRoast(i.roast) ? `${i.bags} × 12oz` : `${i.lbs} lbs`}</div>;
                          })}
                        </td>
                        <td>{s.next_date}</td>
                        <td style={{ color: 'var(--drift)', fontSize: 12 }}>{s.created_by || '—'}</td>
                        <td><button className="btn btn-danger" onClick={() => cancelStanding(s.id)}>Cancel</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="section">
          <div className="section-title">New Order</div>
          <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 20, color: 'var(--ink)', marginBottom: 10 }}>
              Ordering is locked
            </div>
            <p style={{ fontSize: 13, color: 'var(--drift)', lineHeight: 1.8, maxWidth: 440, margin: '0 auto' }}>
              {catalog?.configured
                ? 'Connected to the roastery, but their price list is empty — coffees will appear here as soon as the roastery publishes them.'
                : <>This shop isn't connected to the roastery yet. Enter the API key from the roastery under Settings → Ordering → Roastery Hub, and the live price list will appear here.</>}
            </p>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title">Order History</div>
        {orders.length > 0 ? (isMobile ? (
          <div>
            {orders.map(o => {
              const st = statusText(o);
              const bagCount = (o.items || []).filter(i => isRetailRoast(i.roast)).reduce((s, i) => s + (i.bags || 0), 0);
              const wholesaleLbs = (o.items || []).length
                ? Math.round((o.items || []).filter(i => i.roast !== 'retail').reduce((s, i) => s + i.lbs, 0) * 10) / 10
                : (o.total_lbs ?? POOLS.reduce((s, p) => s + (o[p.field] || 0), 0));
              const qtyStr = [wholesaleLbs > 0 ? `${wholesaleLbs} lbs` : null, bagCount > 0 ? `${bagCount} bags` : null].filter(Boolean).join(' · ') || '—';
              return (
                <div className="hcard" key={o.id}>
                  <div className="hcard-head">
                    <span>{o.order_date}{o.requested_date ? <span style={{ color: 'var(--drift)' }}> → for {o.requested_date}</span> : null}</span>
                    <span style={{ color: st.color }}>{st.text}</span>
                  </div>
                  <div className="hcard-items">
                    {o.items && o.items.length
                      ? o.items.map(i => <div key={i.id}>{roastTag(i.roast)}{i.coffee_name} · {itemQty(i)}</div>)
                      : POOLS.filter(p => o[p.field] > 0).map(p => <div key={p.field}>{p.label}: {o[p.field]} lbs</div>)}
                    {o.notes && <div style={{ color: 'var(--drift)' }}>✎ {o.notes}</div>}
                  </div>
                  <div className="hcard-foot">
                    <span>{qtyStr}{o.total_cost != null ? ` · ${money(o.total_cost)}` : ''} · by {o.created_by || '—'}</span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      {o.items && o.items.length > 0 && catalogMode &&
                        <button className="btn btn-secondary btn-sm" onClick={() => fillFromOrder(o)}>Duplicate</button>}
                      <button className="btn btn-danger" onClick={() => delOrder(o.id)}>Delete</button>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Date</th><th>Items</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Est. Cost</th>
                <th>By</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                {orders.map(o => {
                  const st = statusText(o);
                  const bagCount = (o.items || []).filter(i => isRetailRoast(i.roast)).reduce((s, i) => s + (i.bags || 0), 0);
                  const wholesaleLbs = (o.items || []).length
                    ? Math.round((o.items || []).filter(i => i.roast !== 'retail').reduce((s, i) => s + i.lbs, 0) * 10) / 10
                    : (o.total_lbs ?? POOLS.reduce((s, p) => s + (o[p.field] || 0), 0));
                  return (
                    <tr key={o.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{o.order_date}{o.requested_date ? <div style={{ fontSize: 10, color: 'var(--drift)' }}>for {o.requested_date}</div> : null}</td>
                      <td style={{ lineHeight: 1.9, fontSize: 11 }}>
                        {o.items && o.items.length
                          ? o.items.map(i => <div key={i.id} style={{ whiteSpace: 'nowrap' }}>{roastTag(i.roast)}{i.coffee_name} · {itemQty(i)}</div>)
                          : POOLS.filter(p => o[p.field] > 0).map(p => <div key={p.field}>{p.label}: {o[p.field]} lbs</div>)}
                        {o.notes && <div style={{ color: 'var(--drift)' }}>✎ {o.notes}</div>}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{[wholesaleLbs > 0 ? `${wholesaleLbs} lbs` : null, bagCount > 0 ? `${bagCount} bags` : null].filter(Boolean).join(' · ') || '—'}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{o.total_cost != null ? money(o.total_cost) : '—'}</td>
                      <td style={{ color: 'var(--drift)', fontSize: 12 }}>{o.created_by || '—'}</td>
                      <td style={{ color: st.color, fontSize: 11 }}>{st.text}</td>
                      <td><div style={{ display: 'flex', gap: 6 }}>
                        {o.items && o.items.length > 0 && catalogMode &&
                          <button className="btn btn-secondary btn-sm" onClick={() => fillFromOrder(o)}>Duplicate</button>}
                        <button className="btn btn-danger" onClick={() => delOrder(o.id)}>Delete</button>
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )) : <div className="empty">No orders yet. Your sent orders will be logged here for one-click reordering.</div>}
      </div>

      {isMobile && catalogMode && hasLines && (
        <div className="sendbar">
          <div>
            <div className="sendbar-main">{summaryQty}{totalCost > 0 ? ` — ${money(totalCost)}` : ''}</div>
            <div className={`sendbar-sub${incrementError ? ' err' : ''}`}>
              {incrementError ? '⚠ Wholesale quantities must be multiples of 5 lbs' : 'at current price list'}
            </div>
          </div>
          <button className="btn" onClick={send} disabled={sending || !!incrementError}>
            {sending ? '…Sending' : 'Send Order'}
          </button>
        </div>
      )}
    </div>
  );
}
