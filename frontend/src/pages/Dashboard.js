import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { api, apiJson } from '../api';
import DateField from '../DateField';

const TODAY = new Date().toISOString().slice(0, 10);
const LBS = 453.592;

// A cycle ends the day BEFORE the next delivery: the next delivery's on-hand
// count closes the cycle, and its received bags belong to the next cycle.
function dayBefore(dateStr) {
  const t = new Date(dateStr + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

const ROASTS = [
  ['Espresso Roast', 'espresso'],
  ['Filter Roast',   'filter'],
];
const kg = v => (v / 1000).toFixed(1);
const lbsOf = g => Math.round((g / LBS) * 10) / 10;

// Closed-cycle card: efficiency and settled waste for one roast.
function EffCard({ label, e }) {
  if (!e) return null;
  const isWaste = e.flag === 'WASTE';
  const isOver  = e.flag === 'OVER_EXPECTED';
  const noStock = e.flag === 'NO_STOCK_LOGGED';
  const cls = !e.efficiency_pct ? '' : isOver ? 'bad' : isWaste ? 'warn' : 'good';
  return (
    <div className={`eff-card ${cls}`}>
      <div className="eff-label">{label}</div>
      {e.efficiency_pct != null ? (
        <>
          <div className="eff-pct">{e.efficiency_pct}<span>%</span></div>
          <div className="eff-sub">{kg(e.used)}kg used / {kg(e.stocked)}kg stocked</div>
          <div className="eff-sub">~{kg(e.theoretical_remaining)}kg expected remaining</div>
          {e.actual_remaining !== null && (
            <div className="eff-sub" style={{ color: isWaste ? 'var(--red)' : 'var(--olive)' }}>
              {kg(e.actual_remaining)}kg counted
            </div>
          )}
          {e.waste !== null && (
            <div className="eff-sub" style={{ color: isWaste ? 'var(--red)' : 'var(--drift)' }}>
              {e.waste > 0
                ? <>{e.waste >= 1000 ? `${kg(e.waste)}kg` : `${Math.round(e.waste)}g`} unaccounted ({e.stocked > 0 ? Math.round(e.waste / e.stocked * 1000) / 10 : 0}% of opening)</>
                : 'no waste — counted at or above expected'}
            </div>
          )}
        </>
      ) : (
        <div className="eff-pct" style={{ fontSize: 26, color: 'var(--linen)' }}>—</div>
      )}
      {isOver  && <span className="flag flag-over">↑ Over expected</span>}
      {isWaste && <span className="flag flag-waste">⚠ Waste detected</span>}
      {noStock && <span className="flag flag-nostock">— No stock logged</span>}
    </div>
  );
}

// Live card for the open cycle: only what's knowable without a count —
// usage, burn per day, days left, suggested order. No waste guessing.
function BurnCard({ label, e, sug, methodSplit }) {
  if (!e) return null;
  const daysLeft = sug?.days_left;
  const barCol = daysLeft == null ? 'var(--linen)' : daysLeft < 3 ? 'var(--red)' : daysLeft < 5 ? 'var(--warn)' : 'var(--olive)';
  const barW = daysLeft == null ? 0 : Math.max(3, Math.min(100, (daysLeft / 10) * 100));
  const split = (methodSplit || []).filter(m => m.grams > 0);
  const splitTotal = split.reduce((s, m) => s + m.grams, 0);
  return (
    <div className="eff-card">
      <div className="eff-label">{label}</div>
      <div className="eff-pct" style={{ color: 'var(--ink)' }}>{kg(e.used)} <span>kg used</span></div>
      <div className="eff-sub">
        {e.stocked > 0
          ? <>of {kg(e.stocked)}kg stocked · ~{kg(Math.max(0, e.theoretical_remaining))}kg should remain</>
          : e.used > 0 ? 'no stock logged for this roast yet' : 'no usage yet this cycle'}
      </div>
      {sug && (
        <div style={{ borderTop: '1px solid var(--linen)', marginTop: 12, paddingTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12 }}>
            <span style={{ color: 'var(--graphite)' }}>burn {lbsOf(sug.burn_g_per_day)} lbs/day</span>
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 18, color: daysLeft != null && daysLeft < 5 ? barCol : 'var(--ink)' }}>
              {daysLeft != null ? `~${daysLeft} days left` : '—'}
            </span>
          </div>
          <div style={{ height: 10, background: 'var(--stone)', border: '1px solid var(--linen)', marginTop: 8 }}>
            <div style={{ height: '100%', width: `${barW}%`, background: barCol }} />
          </div>
          <div className="eff-sub" style={{ marginTop: 4 }}>
            suggested next order: <strong style={{ fontWeight: 400, color: 'var(--ink)' }}>{sug.suggested_lbs} lbs</strong> (covers {sug.horizon_days || 7} days)
          </div>
        </div>
      )}
      {split.length > 0 && splitTotal > 0 && (
        <div style={{ borderTop: '1px solid var(--linen)', marginTop: 12, paddingTop: 10 }}>
          <div className="eff-label">Where the filter roast goes</div>
          <div style={{ display: 'flex', height: 12, border: '1px solid var(--linen)', overflow: 'hidden' }}>
            {split.map(m => (
              <div key={m.key} style={{ width: `${(m.grams / splitTotal * 100).toFixed(1)}%`, background: m.color }} title={`${m.label}: ${lbsOf(m.grams)} lbs`} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--drift)', marginTop: 6, flexWrap: 'wrap' }}>
            {split.map(m => (
              <span key={m.key}><span style={{ display: 'inline-block', width: 8, height: 8, marginRight: 5, background: m.color }} />{m.label} {lbsOf(m.grams)} lbs · {m.drinks} drinks</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Headline snapshot: consumption per roast at a glance.
function Snapshot({ a }) {
  const eff = a.eff || {};
  const stocked = ROASTS.reduce((s, [, k]) => s + (eff[k]?.stocked || 0), 0);
  const used    = ROASTS.reduce((s, [, k]) => s + (eff[k]?.used || 0), 0);
  const pct = stocked > 0 ? Math.round((used / stocked) * 1000) / 10 : null;
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
        </div>
      </div>
      {ROASTS.map(([label, k]) => {
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

const SPLIT_META = [
  { key: 'batch',    label: 'Batch Brew', color: 'var(--warn)' },
  { key: 'coldbrew', label: 'Cold Brew',  color: '#4A6E6B' },
  { key: 'pourover', label: 'Pour-Over',  color: 'var(--olive)' },
];

export default function Dashboard() {
  const [startDate, setStartDate] = useState(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-01'; });
  const [endDate, setEndDate]     = useState(TODAY);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError]         = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [suggestion, setSuggestion] = useState(null);
  const [history, setHistory]     = useState(null); // closed cycles, newest first

  useEffect(() => {
    apiJson('/api/coffee-deliveries').then(setDeliveries).catch(() => {});
    apiJson('/api/order-suggestion').then(s => { if (s.available) setSuggestion(s); }).catch(() => {});
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

  // Auto-load the current (most recent) cycle so the dashboard opens live.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || cycles.length === 0) return;
    autoRan.current = true;
    selectCycle(cycles[cycles.length - 1]);
  }, [cycles, selectCycle]);

  // Cycle-to-cycle waste: the last few CLOSED cycles, fetched once. Each is a
  // Square query, so keep it to three and load them quietly in sequence.
  const historyRan = useRef(false);
  useEffect(() => {
    if (historyRan.current || cycles.length === 0) return;
    historyRan.current = true;
    (async () => {
      const closed = cycles.filter(c => !c.open).slice(-3).reverse();
      const rows = [];
      for (const c of closed) {
        try {
          const a = await apiJson('/api/analytics', { method: 'POST', body: JSON.stringify({ start_date: c.start, end_date: c.end }) });
          if (!a.error) rows.push({ cycle: c, eff: a.eff });
        } catch { /* skip cycles that fail */ }
      }
      setHistory(rows);
    })();
  }, [cycles]);

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
  const totalTracked = a ? Object.values(a.matched || {}).reduce((s, v) => s + (v.qty || 0), 0) : 0;
  const unmatchedEntries = a ? Object.entries(a.unmatched || {}) : [];
  const unmatchedQty = unmatchedEntries.reduce((s, [, q]) => s + q, 0);
  const methodSplit = a?.method_usage
    ? SPLIT_META.map(m => ({ ...m, grams: a.method_usage[m.key]?.grams || 0, drinks: a.method_usage[m.key]?.drinks || 0 }))
    : [];

  const wasteCell = e => {
    if (!e || e.waste == null) return <td className="num-cell" style={{ color: 'var(--linen)' }}>—</td>;
    const pct = e.stocked > 0 ? Math.round(e.waste / e.stocked * 1000) / 10 : 0;
    const flagged = e.flag === 'WASTE';
    return (
      <td className="num-cell" style={{ color: flagged ? 'var(--red)' : 'var(--drift)', whiteSpace: 'nowrap' }}>
        {e.waste > 0 ? `${e.waste >= 1000 ? kg(e.waste) + 'kg' : Math.round(e.waste) + 'g'} (${pct}%)` : 'none'}
        {flagged && <span className="flag flag-waste" style={{ marginLeft: 8, marginTop: 0 }}>⚠</span>}
      </td>
    );
  };

  return (
    <div className="page">
      <div className="page-eyebrow">Efficiency Tracking</div>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Live burn per roast; waste settles when a delivery closes the cycle.</p>
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

      {error && <div className="error-banner"><span>⚠</span><div>{error}</div></div>}
      {loading && <div className="loading-overlay"><div className="loading-spinner" /><div className="loading-text">Fetching Square data…</div></div>}

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
              { lbl: 'Espresso Roast Used', val: kg(a.eff?.espresso?.used || 0), unit: 'kg theoretical' },
              { lbl: 'Filter Roast Used', val: kg(a.eff?.filter?.used || 0), unit: 'kg theoretical' },
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
            <div className="section">
              <div className="section-title">Current Cycle — efficiency &amp; waste settle at your next delivery count</div>
              <div className="eff-grid-2">
                <BurnCard label="Espresso Roast" e={a.eff?.espresso} sug={suggestion ? { ...suggestion.pools?.espresso, horizon_days: suggestion.horizon_days } : null} />
                <BurnCard label="Filter Roast" e={a.eff?.filter} sug={suggestion ? { ...suggestion.pools?.filter, horizon_days: suggestion.horizon_days } : null} methodSplit={methodSplit} />
              </div>
            </div>
          ) : (
            <div className="section">
              <div className="section-title">This Cycle — closed on {a.closing_delivery_date}</div>
              <div className="eff-grid-2">
                <EffCard label="Espresso Roast" e={a.eff?.espresso} />
                <EffCard label="Filter Roast" e={a.eff?.filter} />
              </div>
            </div>
          )}

          {history && history.length > 0 && (
            <div className="section">
              <div className="section-title">Closed Cycles — waste, cycle to cycle (counted at each delivery, nothing extra to log)</div>
              {ROASTS.map(([label, k]) => (
                <div key={k} style={{ marginBottom: 16 }}>
                  <div className="form-lbl" style={{ marginBottom: 6 }}>{label}</div>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Cycle</th><th className="num-cell">Stocked</th><th className="num-cell">Used</th><th className="num-cell">Counted</th><th className="num-cell">Waste</th></tr></thead>
                      <tbody>
                        {history.map(({ cycle, eff }) => {
                          const e = eff?.[k];
                          return (
                            <tr key={cycle.id}>
                              <td>{cycle.start} → {cycle.end}</td>
                              <td className="num-cell">{e ? `${kg(e.stocked)}kg` : '—'}</td>
                              <td className="num-cell">{e ? `${kg(e.used)}kg` : '—'}</td>
                              <td className="num-cell">{e && e.actual_remaining != null ? `${kg(e.actual_remaining)}kg` : '—'}</td>
                              {wasteCell(e)}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="section">
            <div className="section-title">Total Drinks</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Drink</th><th>Total</th></tr></thead>
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
                    <td style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 13 }}>Total</td>
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
