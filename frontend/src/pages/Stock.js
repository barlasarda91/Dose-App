import React, { useState, useEffect } from 'react';
import { api } from '../api';
import DateField from '../DateField';

const TODAY = new Date().toISOString().slice(0, 10);
const LBS_TO_G = 453.592;

export default function Stock() {
  const [coffeeDeliveries, setCoffeeDeliveries] = useState([]);

  const [cForm, setCForm] = useState({
    delivery_date: TODAY,
    espresso_lbs_received: '', espresso_lbs_onhand: '',
    drip_lbs_received: '',     drip_lbs_onhand: '',
    coldbrew_lbs_received: '', coldbrew_lbs_onhand: '',
    pourover_lbs_received: '', pourover_lbs_onhand: '',
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
      drip_lbs_received:     parseFloat(cForm.drip_lbs_received)     || 0,
      drip_lbs_onhand:       parseFloat(cForm.drip_lbs_onhand)       || 0,
      coldbrew_lbs_received: parseFloat(cForm.coldbrew_lbs_received) || 0,
      coldbrew_lbs_onhand:   parseFloat(cForm.coldbrew_lbs_onhand)   || 0,
      pourover_lbs_received: parseFloat(cForm.pourover_lbs_received) || 0,
      pourover_lbs_onhand:   parseFloat(cForm.pourover_lbs_onhand)   || 0,
      notes: cForm.notes,
    };
    const r = await api('/api/coffee-deliveries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    setCoffeeDeliveries(x => [d, ...x]);
    setCForm({ delivery_date: TODAY, espresso_lbs_received: '', espresso_lbs_onhand: '', drip_lbs_received: '', drip_lbs_onhand: '', coldbrew_lbs_received: '', coldbrew_lbs_onhand: '', pourover_lbs_received: '', pourover_lbs_onhand: '', notes: '' });
  }

  async function delRow(id) {
    if (!window.confirm('Delete this delivery? Cycle calculations that depend on it will change.')) return;
    await api(`/api/coffee-deliveries/${id}`, { method: 'DELETE' });
    setCoffeeDeliveries(x => x.filter(r => r.id !== id));
  }

  const setC = k => e => setCForm(p => ({ ...p, [k]: e.target.value }));

  return (
    <div className="page">
      <div className="page-eyebrow">Inventory</div>
      <h1 className="page-title">Stock Log</h1>
      <p className="page-sub">Log coffee deliveries — each delivery closes the previous cycle.</p>
      <hr className="page-rule" />

      <div className="section">
        <div className="section-title">Coffee Deliveries</div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">Log New Delivery</div>
          <p style={{ fontSize: 11, color: 'var(--drift)', marginBottom: 14, lineHeight: 1.6 }}>
            Enter lbs on hand before this delivery, and lbs received. Opening stock for a period = on hand + received at the first delivery.
          </p>
          <div style={{ marginBottom: 14 }}>
            <div className="form-group" style={{ maxWidth: 200 }}>
              <label className="form-lbl">Date</label>
              <DateField value={cForm.delivery_date} onChange={v => setCForm(p => ({ ...p, delivery_date: v }))} />
            </div>
          </div>
          {[
            { label: 'Espresso', rec: 'espresso_lbs_received', oh: 'espresso_lbs_onhand' },
            { label: 'Drip',     rec: 'drip_lbs_received',     oh: 'drip_lbs_onhand' },
            { label: 'Cold Brew',rec: 'coldbrew_lbs_received', oh: 'coldbrew_lbs_onhand' },
            { label: 'Pour-Over',rec: 'pourover_lbs_received', oh: 'pourover_lbs_onhand' },
          ].map(({ label, rec, oh }) => (
            <div key={label} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr 1fr', gap: 10, alignItems: 'end', marginBottom: 10 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--drift)', paddingBottom: 10 }}>{label}</div>
              <div className="form-group">
                {label === 'Espresso' && <label className="form-lbl">On Hand (lbs)</label>}
                <input type="number" className="form-input" placeholder="0" step="0.1" value={cForm[oh]} onChange={setC(oh)} />
              </div>
              <div className="form-group">
                {label === 'Espresso' && <label className="form-lbl">Received (lbs)</label>}
                <input type="number" className="form-input" placeholder="0" step="0.1" value={cForm[rec]} onChange={setC(rec)} />
              </div>
              <div className="form-group">
                {label === 'Espresso' && <label className="form-lbl">Total (lbs)</label>}
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--graphite)', paddingTop: 10, paddingBottom: 10 }}>
                  {((parseFloat(cForm[oh]) || 0) + (parseFloat(cForm[rec]) || 0)).toFixed(1)} lbs
                  <span style={{ color: 'var(--drift)', fontSize: 10, marginLeft: 6 }}>
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
              <th>Espresso</th><th style={{color:'var(--warn)'}}>+rcvd</th>
              <th>Drip</th><th style={{color:'var(--warn)'}}>+rcvd</th>
              <th>Cold Brew</th><th style={{color:'var(--warn)'}}>+rcvd</th>
              <th>Pour-Over</th><th style={{color:'var(--warn)'}}>+rcvd</th>
              <th>By</th><th>Notes</th><th></th>
            </tr></thead>
            <tbody>{coffeeDeliveries.map(d => (
              <tr key={d.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{d.delivery_date}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{d.espresso_lbs_onhand > 0 ? `${d.espresso_lbs_onhand}lb` : '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--warn)' }}>{d.espresso_lbs_received > 0 ? `+${d.espresso_lbs_received}lb` : '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{d.drip_lbs_onhand > 0 ? `${d.drip_lbs_onhand}lb` : '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--warn)' }}>{d.drip_lbs_received > 0 ? `+${d.drip_lbs_received}lb` : '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{d.coldbrew_lbs_onhand > 0 ? `${d.coldbrew_lbs_onhand}lb` : '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--warn)' }}>{d.coldbrew_lbs_received > 0 ? `+${d.coldbrew_lbs_received}lb` : '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{d.pourover_lbs_onhand > 0 ? `${d.pourover_lbs_onhand}lb` : '—'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--warn)' }}>{d.pourover_lbs_received > 0 ? `+${d.pourover_lbs_received}lb` : '—'}</td>
                <td style={{ color: 'var(--drift)', fontSize: 11 }}>{d.created_by || '—'}</td>
                <td style={{ color: 'var(--drift)', fontSize: 11 }}>{d.notes || '—'}</td>
                <td><button className="btn btn-danger" onClick={() => delRow(d.id)}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <div className="empty">No coffee deliveries logged yet.</div>}
      </div>
    </div>
  );
}
