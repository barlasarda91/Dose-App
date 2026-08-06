import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { api, apiJson } from '../api';
import DateField from '../DateField';

const TODAY = new Date().toISOString().slice(0, 10);

// A cycle ends the day BEFORE the next delivery: the next delivery's on-hand
// count closes the cycle, and its received bags belong to the next cycle.
function dayBefore(dateStr) {
  const t = new Date(dateStr + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

function EffCard({ label, e, unit = 'g', note, displayUnit, scale = 1 }) {
  if (!e) return null;
  const isWaste = e.flag === 'WASTE';
  const isOver  = e.flag === 'OVER_EXPECTED';
  const noStock = e.flag === 'NO_STOCK_LOGGED';
  const cls = !e.efficiency_pct ? '' : isOver ? 'bad' : isWaste ? 'warn' : 'good';
  const cycleOpen = e.cycle_open;
  const u = displayUnit || unit;
  const fmt = v => v != null ? (v * scale).toFixed(scale < 1 ? 1 : 0) : '—';
  return (
    <div className={`eff-card ${cls}`}>
      <div className="eff-label">{label}</div>
      {note && <div className="eff-note">{note}</div>}
      {e.efficiency_pct != null ? (
        <>
          <div className="eff-pct">{e.efficiency_pct}<span>%</span></div>
          <div className="eff-sub">{fmt(e.used)}{u} used / {fmt(e.stocked)}{u} stocked</div>
          <div className="eff-sub">~{fmt(e.theoretical_remaining)}{u} expected remaining</div>
          {!cycleOpen && e.actual_remaining !== null && (
            <div className="eff-sub" style={{ color: isWaste ? 'var(--red)' : 'var(--olive)' }}>
              {fmt(e.actual_remaining)}{u} actual remaining
            </div>
          )}
          {!cycleOpen && e.waste !== null && e.waste > 0 && (
            <div className="eff-sub" style={{ color: 'var(--red)' }}>{fmt(e.waste)}{u} unaccounted</div>
          )}
        </>
      ) : (
        <div className="eff-pct" style={{ fontSize: 26, color: 'var(--linen)' }}>—</div>
      )}
      {cycleOpen && e.efficiency_pct != null && <span className="flag">◌ Open cycle</span>}
      {isOver  && <span className="flag flag-over">↑ Over expected</span>}
      {isWaste && <span className="flag flag-waste">⚠ Waste detected</span>}
      {noStock && <span className="flag flag-nostock">— No stock logged</span>}
    </div>
  );
}

const POOLS = [
  ['Espresso',  'espresso'],
  ['Drip',      'drip'],
  ['Cold Brew', 'coldbrew'],
  ['Pour-Over', 'pourover'],
];

// Headline snapshot: how much of the coffee on hand the shop went through,
// pool by pool, at a glance.
function Snapshot({ a }) {
  const eff = a.eff || {};
  const stocked = POOLS.reduce((s, [, k]) => s + (eff[k]?.stocked || 0), 0);
  const used    = POOLS.reduce((s, [, k]) => s + (eff[k]?.used || 0), 0);
  const waste   = POOLS.reduce((s, [, k]) => s + Math.max(0, eff[k]?.waste || 0), 0);
  const pct = stocked > 0 ? Math.round((used / stocked) * 1000) / 10 : null;
  const kg = v => (v / 1000).toFixed(1);
  return (
    <div className="snapshot">
      <div className="snapshot-head">
        <div className="snapshot-pct">{pct != null ? <>{pct}<span>%</span></> : '—'}</div>
        <div>
          <div className="snapshot-caption">of coffee stock consumed</div>
          <div className="snapshot-detail">
            {pct != null
              ? `~${kg(used)}kg of ${kg(stocked)}kg on hand · ${a.cycle_open ? 'cycle in progress' : 'cycle closed'}`
              : 'No coffee stock logged for this period'}
          </div>
          {!a.cycle_open && waste > 0 && (
            <div className="snapshot-detail" style={{ color: 'var(--red)' }}>
              ~{waste >= 1000 ? `${kg(waste)}kg` : `${Math.round(waste)}g`} unaccounted vs physical count
            </div>
          )}
        </div>
      </div>
      {POOLS.map(([label, k]) => {
        const e = eff[k];
        if (!e) return null;
        const p = e.stocked > 0 ? Math.min(100, (e.used / e.stocked) * 100) : 0;
        const cls = e.flag === 'OVER_EXPECTED' ? 'bad' : e.flag === 'WASTE' ? 'warn' : '';
        return (
          <div className="bar-row" key={k}>
            <div className="bar-lbl">{label}</div>
            <div className="bar-track"><div className={`bar-fill ${cls}`} style={{ width: `${p}%` }} /></div>
            <div className="bar-val">
              {e.stocked > 0
                ? `${kg(e.used)}kg / ${kg(e.stocked)}kg · ${e.efficiency_pct}%${e.flag === 'WASTE' ? ' ⚠' : e.flag === 'OVER_EXPECTED' ? ' ↑' : ''}`
                : e.used > 0 ? `${kg(e.used)}kg used · no stock logged` : '—'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const [startDate, setStartDate] = useState(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-01'; });
  const [endDate, setEndDate]     = useState(TODAY);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError]         = useState(null);
  const [deliveries, setDeliveries] = useState([]);

  useEffect(() => {
    apiJson('/api/coffee-deliveries').then(setDeliveries).catch(() => {});
  }, []);

  const cycles = useMemo(() => {
    const sorted = [...deliveries].sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));
    return sorted.map((d, i) => {
      const next = sorted[i + 1];
      const end = next ? dayBefore(next.delivery_date) : TODAY;
      return {
        id: `c${i}`, label: `Cycle ${i + 1}`,
        start: d.delivery_date,
        end: end < d.delivery_date ? d.delivery_date : end,
        open: !next,
      };
    });
  }, [deliveries]);

  const [activeCycle, setActiveCycle] = useState(null);

  const runReport = useCallback(async (start, end) => {
    setLoading(true); setError(null);
    try {
      const data = await apiJson('/api/analytics', {
        method: 'POST',
        body: JSON.stringify({ start_date: start, end_date: end }),
      });
      if (data.error) throw new Error(data.error);
      setAnalytics(data);
    } catch (e) {
      if (!e.unauthorized) setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectCycle = useCallback((c) => {
    setActiveCycle(c.id); setStartDate(c.start); setEndDate(c.end);
    runReport(c.start, c.end);
  }, [runReport]);

  // Auto-load the current (most recent) cycle so the dashboard opens with a
  // live snapshot instead of an empty state.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || cycles.length === 0) return;
    autoRan.current = true;
    selectCycle(cycles[cycles.length - 1]);
  }, [cycles, selectCycle]);

  const downloadReport = useCallback(async () => {
    setDownloading(true);
    try {
      const res = await api('/api/report', {
        method: 'POST',
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Report failed'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dose-report-${startDate}-${endDate}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (!e.unauthorized) setError(e.message);
    } finally {
      setDownloading(false);
    }
  }, [startDate, endDate]);

  const a = analytics;
  // Total drinks = sum of tracked items only (coffee drinks)
  const totalTracked = a ? Object.values(a.matched || {}).reduce((s, v) => s + (v.qty || 0), 0) : 0;
  const unmatchedEntries = a ? Object.entries(a.unmatched || {}) : [];
  const unmatchedQty = unmatchedEntries.reduce((s, [, q]) => s + q, 0);

  return (
    <div className="page">
      <div className="page-eyebrow">Efficiency Tracking</div>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Coffee & milk efficiency by delivery cycle</p>
      <hr className="page-rule" />

      {cycles.length > 0 && (
        <div className="section">
          <div className="section-title">Delivery Cycles</div>
          <div className="cycle-row">
            {cycles.map(c => (
              <button key={c.id} className={`cycle-btn ${activeCycle === c.id ? 'active' : ''}`} onClick={() => selectCycle(c)}>
                {c.label}: {c.start} → {c.end}{c.open ? ' ◌' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="date-row">
        <span className="date-lbl">From</span>
        <DateField value={startDate} onChange={v => { setStartDate(v); setActiveCycle('custom'); }} />
        <span style={{ color: 'var(--drift)', fontSize: 16 }}>→</span>
        <span className="date-lbl">To</span>
        <DateField value={endDate} onChange={v => { setEndDate(v); setActiveCycle('custom'); }} />
        <button className="btn btn-primary" onClick={() => { setActiveCycle('custom'); runReport(startDate, endDate); }} disabled={loading}>
          {loading ? '…Fetching' : 'Run Report'}
        </button>
        {a && (
          <button className="btn btn-accent" onClick={downloadReport} disabled={downloading}>
            {downloading ? '…Generating' : '↓ Download PDF'}
          </button>
        )}
      </div>

      {error && (
        <div className="error-banner">
          <span>⚠</span>
          <div>{error}</div>
        </div>
      )}

      {loading && (
        <div className="loading-overlay">
          <div className="loading-spinner" />
          <div className="loading-text">Fetching Square data…</div>
        </div>
      )}

      {!loading && a && (
        <>
          <Snapshot a={a} />

          {unmatchedEntries.length > 0 && (
            <div className="warn-box">
              ⚠ {unmatchedQty} drink{unmatchedQty === 1 ? '' : 's'} across {unmatchedEntries.length} item
              type{unmatchedEntries.length === 1 ? '' : 's'} sold in this period {unmatchedEntries.length === 1 ? 'is' : 'are'} not
              matched to any recipe and excluded from these numbers:&nbsp;
              {unmatchedEntries.sort((x, y) => y[1] - x[1]).slice(0, 6).map(([n, q]) => `${n} (${q})`).join(', ')}
              {unmatchedEntries.length > 6 ? '…' : ''}. Add them on the Recipes page to include them.
            </div>
          )}

          <div className="stats-row">
            {[
              { lbl: 'Total Drinks', val: totalTracked.toLocaleString(), unit: 'tracked coffee drinks' },
              { lbl: 'Espresso Used', val: ((a.eff?.espresso?.used || 0) / 1000).toFixed(2), unit: 'kg theoretical' },
              { lbl: 'Coffee Used', val: (POOLS.reduce((s, [, k]) => s + (a.eff?.[k]?.used || 0), 0) / 1000).toFixed(2), unit: 'kg all pools' },
              { lbl: 'Period', val: a.period?.days, unit: 'days' },
            ].map(s => (
              <div key={s.lbl} className="stat-pill">
                <div className="stat-lbl">{s.lbl}</div>
                <div className="stat-val">{s.val}</div>
                <div className="stat-unit">{s.unit}</div>
              </div>
            ))}
          </div>

          {a.cycle_open ? (
            <div className="cycle-status-banner open">
              <span className="cycle-banner-label">◌ Open</span>
              <div className="cycle-banner-text">Open cycle — no closing delivery logged yet. Efficiency reflects theoretical use against opening stock. Log the next delivery to close this cycle and calculate real waste.</div>
            </div>
          ) : (
            <div className="cycle-status-banner closed">
              <span className="cycle-banner-label closed">● Closed</span>
              <div className="cycle-banner-text">Closed cycle — closing delivery logged on {a.closing_delivery_date}. Waste calculated from actual on-hand count.</div>
            </div>
          )}

          <div className="section">
            <div className="section-title">Coffee Efficiency</div>
            <div className="eff-grid">
              <EffCard label="Espresso"  e={a.eff?.espresso}  unit="g" />
              <EffCard label="Drip"      e={a.eff?.drip}      unit="g" note="24.4g/cup · 110g per 4.5 cups" />
              <EffCard label="Cold Brew" e={a.eff?.coldbrew}  unit="g" note="26.2g/serve · 4kg per 20×1.8L" />
              <EffCard label="Pour-Over" e={a.eff?.pourover}  unit="g" note="incl. Turkish Coffee (7.5g)" />
            </div>
          </div>

          {/* Total Drinks */}
          <div className="section">
            <div className="section-title">Total Drinks</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Drink</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(a.matched || {})
                    .sort((x, y) => (y[1].qty || 0) - (x[1].qty || 0))
                    .map(([name, val]) => (
                      <tr key={name}>
                        <td className="name-cell">{name}</td>
                        <td className="num-cell">{val.qty || 0}</td>
                      </tr>
                    ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--linen)' }}>
                    <td style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 12 }}>Total</td>
                    <td style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{totalTracked}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}

      {!loading && !a && !error && (
        <div className="empty" style={{ padding: '60px 0' }}>
          {cycles.length === 0
            ? 'Log your first delivery on the Stock page to start a cycle, or pick a date range and click Run Report.'
            : 'Select a cycle or date range and click Run Report'}
        </div>
      )}
    </div>
  );
}
