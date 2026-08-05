import React, { useState, useEffect } from 'react';
import { apiJson } from '../api';

const TODAY = new Date().toISOString().slice(0, 10);

const POOLS = [
  { field: 'espresso_lbs', key: 'espresso', label: 'Espresso' },
  { field: 'drip_lbs',     key: 'drip',     label: 'Drip' },
  { field: 'coldbrew_lbs', key: 'coldbrew', label: 'Cold Brew' },
  { field: 'pourover_lbs', key: 'pourover', label: 'Pour-Over' },
];

const EMPTY_FORM = { order_date: TODAY, espresso_lbs: '', drip_lbs: '', coldbrew_lbs: '', pourover_lbs: '', notes: '' };

const STATUS_LABELS = {
  sent: '✓ Sent',
  email_failed: '⚠ Saved, email failed',
  saved: 'Saved',
};

export default function Order() {
  const [orders, setOrders]         = useState([]);
  const [suggestion, setSuggestion] = useState(null);
  const [settings, setSettings]     = useState({});
  const [form, setForm]             = useState(EMPTY_FORM);
  const [sending, setSending]       = useState(false);
  const [result, setResult]         = useState(null);
  const [error, setError]           = useState(null);

  useEffect(() => {
    apiJson('/api/orders').then(setOrders).catch(() => {});
    apiJson('/api/order-suggestion').then(setSuggestion).catch(() => {});
    apiJson('/api/settings').then(setSettings).catch(() => {});
  }, []);

  const set = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

  function useSuggestion() {
    if (!suggestion?.available) return;
    setForm(p => ({
      ...p,
      espresso_lbs: String(suggestion.pools.espresso.suggested_lbs || ''),
      drip_lbs:     String(suggestion.pools.drip.suggested_lbs     || ''),
      coldbrew_lbs: String(suggestion.pools.coldbrew.suggested_lbs || ''),
      pourover_lbs: String(suggestion.pools.pourover.suggested_lbs || ''),
    }));
  }

  function fillFromOrder(o) {
    setForm({
      order_date: TODAY,
      espresso_lbs: o.espresso_lbs > 0 ? String(o.espresso_lbs) : '',
      drip_lbs:     o.drip_lbs     > 0 ? String(o.drip_lbs)     : '',
      coldbrew_lbs: o.coldbrew_lbs > 0 ? String(o.coldbrew_lbs) : '',
      pourover_lbs: o.pourover_lbs > 0 ? String(o.pourover_lbs) : '',
      notes: o.notes || '',
    });
    setResult(null); setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const totalLbs = POOLS.reduce((s, p) => s + (parseFloat(form[p.field]) || 0), 0);

  async function send() {
    if (totalLbs <= 0 || sending) return;
    setSending(true); setResult(null); setError(null);
    try {
      const data = await apiJson('/api/orders', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      if (data.error) throw new Error(data.error);
      setOrders(x => [data.order, ...x]);
      setResult(data);
      setForm(EMPTY_FORM);
    } catch (e) {
      if (!e.unauthorized) setError(e.message);
    } finally {
      setSending(false);
    }
  }

  async function delOrder(id) {
    if (!window.confirm('Delete this order from the log? (Does not recall the email.)')) return;
    await apiJson(`/api/orders/${id}`, { method: 'DELETE' }).catch(() => {});
    setOrders(x => x.filter(o => o.id !== id));
  }

  const lastOrder = orders[0];
  const emailTo = settings.order_email_to || 'hello@boxxcoffee.com';

  return (
    <div className="page">
      <div className="page-eyebrow">Ordering</div>
      <h1 className="page-title">Place Order</h1>
      <p className="page-sub">Order coffee from the roastery — sent by email to {emailTo}</p>
      <hr className="page-rule" />

      {settings.resend_configured === false && (
        <div className="warn-box">
          ⚠ Email sending is not configured (RESEND_API_KEY is not set). Orders will be saved to the log below
          but not emailed. Add the key in Railway → Variables to enable sending.
        </div>
      )}

      {result && (
        <div className={result.email?.sent ? 'success-banner' : 'warn-box'}>
          {result.email?.sent
            ? <>✓ Order sent to {result.email.to}. It's logged below — use Duplicate next time to reorder in one click.</>
            : <>⚠ Order saved to the log, but the email didn't go out: {result.email?.reason}</>}
        </div>
      )}
      {error && <div className="error-banner"><span>⚠</span><div>{error}</div></div>}

      {suggestion?.available && (
        <div className="section">
          <div className="section-title">Suggested Order</div>
          <div className="card">
            <p style={{ fontSize: 12, color: 'var(--drift)', marginBottom: 14, lineHeight: 1.6 }}>
              Based on usage since your last delivery ({suggestion.since}, {suggestion.days} day{suggestion.days === 1 ? '' : 's'}):
              enough for the next {suggestion.horizon_days} days at the current pace, minus what should still be on the shelf.
            </p>
            <div className="table-wrap" style={{ marginBottom: 14 }}>
              <table>
                <thead><tr><th>Pool</th><th>Burn / day</th><th>Expected remaining</th><th>Suggested</th></tr></thead>
                <tbody>
                  {POOLS.map(p => {
                    const s = suggestion.pools[p.key];
                    return (
                      <tr key={p.key}>
                        <td>{p.label}</td>
                        <td>{s.burn_g_per_day > 0 ? `${s.burn_g_per_day}g` : '—'}</td>
                        <td>{s.expected_remaining_g != null ? `${(s.expected_remaining_g / 1000).toFixed(1)}kg` : 'no stock logged'}</td>
                        <td style={{ fontWeight: 600 }}>{s.suggested_lbs > 0 ? `${s.suggested_lbs} lbs` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <button className="btn btn-accent" onClick={useSuggestion}>Use Suggestion</button>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title">New Order</div>
        <div className="card">
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            {lastOrder && (
              <button className="btn btn-ghost" onClick={() => fillFromOrder(lastOrder)}>
                ⟳ Duplicate Last Order ({lastOrder.order_date})
              </button>
            )}
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-lbl">Order Date</label>
              <input type="date" className="form-input" value={form.order_date} onChange={set('order_date')} />
            </div>
            {POOLS.map(p => (
              <div className="form-group" key={p.field}>
                <label className="form-lbl">{p.label} (lbs)</label>
                <input type="number" className="form-input" min="0" step="1" placeholder="0"
                  value={form[p.field]} onChange={set(p.field)} />
              </div>
            ))}
          </div>
          <div className="form-group" style={{ maxWidth: 480, marginTop: 6 }}>
            <label className="form-lbl">Notes</label>
            <input className="form-input" placeholder="e.g. deliver Tuesday morning" value={form.notes} onChange={set('notes')} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 18 }}>
            <button className="btn btn-primary" onClick={send} disabled={sending || totalLbs <= 0}>
              {sending ? '…Sending' : `Send Order${totalLbs > 0 ? ` — ${totalLbs} lbs` : ''}`}
            </button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--drift)' }}>
              to {emailTo}
            </span>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Order History</div>
        {orders.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th>Date</th><th>Espresso</th><th>Drip</th><th>Cold Brew</th><th>Pour-Over</th>
                <th>Notes</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id}>
                    <td>{o.order_date}</td>
                    {POOLS.map(p => <td key={p.field}>{o[p.field] > 0 ? `${o[p.field]} lbs` : '—'}</td>)}
                    <td style={{ color: 'var(--drift)', fontSize: 11 }}>{o.notes || '—'}</td>
                    <td style={{ color: o.status === 'sent' ? 'var(--olive)' : 'var(--warn)' }}>
                      {STATUS_LABELS[o.status] || o.status}
                    </td>
                    <td><div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => fillFromOrder(o)}>Duplicate</button>
                      <button className="btn btn-danger" onClick={() => delOrder(o.id)}>Delete</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">No orders yet. Your sent orders will be logged here for one-click reordering.</div>}
      </div>
    </div>
  );
}
