import React, { useState, useEffect } from 'react';
import { api } from '../api';
import DateField from '../DateField';

const TODAY = new Date().toISOString().slice(0, 10);
const LBS_TO_G = 453.592;

export default function Stock() {
  const [coffeeDeliveries, setCoffeeDeliveries] = useState([]);

  // Stock is held per ROAST — espresso and filter — matching what the shop
  // actually buys. (Filter is stored in the legacy drip columns server-side.)
  const [cForm, setCForm] = useState({
    delivery_date: TODAY,
    espresso_lbs_received: '', espresso_lbs_onhand: '',
    filter_lbs_received: '',   filter_lbs_onhand: '',
    notes: '',
  });

  useEffect(() => {
    api('/api/coffee-deliveries').then(r => r.json()).then(setCoffeeDeliveries).catch(() => {});
  }, []);

  async function saveCoffee() {
    const body = {
      delivery_date: cForm.delivery_date,
      espresso_lbs_received: parseFloat(cForm.espresso_lbs_received) || 0,
      espresso_lbs_onhand:   parseFloat(cForm.espresso_lbs_onhand)   || 0,
      filter_lbs_received:   parseFloat(cForm.filter_lbs_received)   || 0,
      filter_lbs_onhand:     parseFloat(cForm.filter_lbs_onhand)     || 0,
      notes: cForm.notes,
    };
    const r = await api('/api/coffee-deliveries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    setCoffeeDeliveries(x => [d, ...x]);
    setCForm({ delivery_date: TODAY, espresso_lbs_received: '', espresso_lbs_onhand: '', filter_lbs_received: '', filter_lbs_onhand: '', notes: '' });
  }

  async function delRow(id) {
    if (!window.confirm('Delete this delivery? Cycle calculations that depend on it will change.')) return;
    await api(`/api/coffee-deliveries/${id}`, { method: 'DELETE' });
    setCoffeeDeliveries(x => x.filter(r => r.id !== id));
  }

  const setC = k => e => setCForm(p => ({ ...p, [k]: e.target.value }));

  // Dose steppers: received moves in 5-lb bags, on-hand by 1 lb. Typing still
  // works for scale readings like 4.2.
  const bump = (k, inc, dir) => setCForm(p => {
    const next = Math.max(0, Math.round(((parseFloat(p[k]) || 0) + dir * inc) * 10) / 10);
    return { ...p, [k]: next > 0 ? String(next) : '' };
  });

  const Stepper = ({ k, inc }) => (
    <span className="stepper">
      <button type="button" aria-label={`Less ${k}`} onClick={() => bump(k, inc, -1)}>−</button>
      <input type="number" min="0" step="0.1" inputMode="decimal" placeholder="0"
        value={cForm[k]} onChange={setC(k)} />
      <button type="button" aria-label={`More ${k}`} onClick={() => bump(k, inc, 1)}>+</button>
    </span>
  );

  return (
    <div className="page">
      <div className="page-eyebrow">Inventory</div>
      <h1 className="page-title">Stock Log</h1>
      <hr className="page-rule" />

      <div className="section">
        <div className="section-title">Coffee Deliveries</div>
        <div className="card" data-tour="delivery-form" style={{ marginBottom: 16 }}>
          <div className="card-title">Log New Delivery</div>
          <p style={{ fontSize: 12, color: 'var(--drift)', marginBottom: 14, lineHeight: 1.6 }}>
            Enter lbs on hand before this delivery, and lbs received. Opening stock for a period = on hand + received at the first delivery.
          </p>
          <div style={{ marginBottom: 14 }}>
            <div className="form-group" style={{ maxWidth: 200 }}>
              <label className="form-lbl">Date</label>
              <DateField value={cForm.delivery_date} onChange={v => setCForm(p => ({ ...p, delivery_date: v }))} />
            </div>
          </div>
          {[
            { label: 'Espresso Roast', rec: 'espresso_lbs_received', oh: 'espresso_lbs_onhand' },
            { label: 'Filter Roast',   rec: 'filter_lbs_received',   oh: 'filter_lbs_onhand' },
          ].map(({ label, rec, oh }) => (
            <div key={label} className="dl-row">
              <div className="dl-roast">{label}</div>
              <div className="form-group">
                <label className="form-lbl">On Hand (lbs) · ±1</label>
                <Stepper k={oh} inc={1} />
              </div>
              <div className="form-group">
                <label className="form-lbl">Received (lbs) · ±5</label>
                <Stepper k={rec} inc={5} />
              </div>
              <div className="form-group dl-total">
                <label className="form-lbl">Total (lbs)</label>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--graphite)', paddingTop: 10, paddingBottom: 10 }}>
                  {((parseFloat(cForm[oh]) || 0) + (parseFloat(cForm[rec]) || 0)).toFixed(1)} lbs
                  <span style={{ color: 'var(--drift)', fontSize: 11, marginLeft: 6 }}>
                    = {(((parseFloat(cForm[oh]) || 0) + (parseFloat(cForm[rec]) || 0)) * LBS_TO_G / 1000).toFixed(2)}kg
                  </span>
                </div>
              </div>
            </div>
          ))}
          <div className="form-group" style={{ maxWidth: 400, marginTop: 6 }}>
            <label className="form-lbl">Notes</label>
            <input className="form-input" placeholder="e.g. weekly delivery" value={cForm.notes} onChange={setC('notes')} />
          </div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={saveCoffee}>Log Delivery</button>
        </div>

        {coffeeDeliveries.length > 0 ? (
          <div className="table-wrap"><table>
            <thead><tr>
              <th>Date</th>
              <th>Espresso Roast</th><th style={{color:'var(--warn)'}}>+rcvd</th>
              <th>Filter Roast</th><th style={{color:'var(--warn)'}}>+rcvd</th>
              <th>By</th><th>Notes</th><th></th>
            </tr></thead>
            <tbody>{coffeeDeliveries.map(d => {
              // Old four-pool rows fold into filter roast for display.
              const fOh  = Math.round((d.drip_lbs_onhand + d.coldbrew_lbs_onhand + d.pourover_lbs_onhand) * 10) / 10;
              const fRec = Math.round((d.drip_lbs_received + d.coldbrew_lbs_received + d.pourover_lbs_received) * 10) / 10;
              return (
              <tr key={d.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{d.delivery_date}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{d.espresso_lbs_onhand > 0 ? `${d.espresso_lbs_onhand}lb` : '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--warn)' }}>{d.espresso_lbs_received > 0 ? `+${d.espresso_lbs_received}lb` : '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{fOh > 0 ? `${fOh}lb` : '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--warn)' }}>{fRec > 0 ? `+${fRec}lb` : '—'}</td>
                <td style={{ color: 'var(--drift)', fontSize: 12 }}>{d.created_by || '—'}</td>
                <td style={{ color: 'var(--drift)', fontSize: 12 }}>{d.notes || '—'}</td>
                <td><button className="btn btn-danger" onClick={() => delRow(d.id)}>Delete</button></td>
              </tr>
            );})}</tbody>
          </table></div>
        ) : <div className="empty">No coffee deliveries logged yet.</div>}
      </div>
    </div>
  );
}
