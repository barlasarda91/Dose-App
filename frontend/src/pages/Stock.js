import React, { useState, useEffect } from 'react';
import { api } from '../api';

const TODAY = new Date().toISOString().slice(0, 10);
const LBS_TO_G = 453.592;
const GALLONS_TO_L = 3.78541;

export default function Stock() {
  const [coffeeDeliveries, setCoffeeDeliveries] = useState([]);
  const [milkDeliveries, setMilkDeliveries]     = useState([]);
  const [settings, setSettings]                 = useState({
    alt_milk_ml_per_modifier: 180,
    numilk_oat_liters_per_day: 0,
    numilk_almond_liters_per_day: 0,
  });

  const [cForm, setCForm] = useState({
    delivery_date: TODAY,
    espresso_lbs_received: '', espresso_lbs_onhand: '',
    drip_lbs_received: '',     drip_lbs_onhand: '',
    coldbrew_lbs_received: '', coldbrew_lbs_onhand: '',
    pourover_lbs_received: '', pourover_lbs_onhand: '',
    notes: '',
  });
  const [mForm, setMForm] = useState({
    delivery_date: TODAY,
    whole_bottles_received: '',
    whole_bottles_onhand: '',
    notes: '',
  });

  useEffect(() => {
    api('/api/coffee-deliveries').then(r => r.json()).then(setCoffeeDeliveries);
    api('/api/milk-deliveries').then(r => r.json()).then(setMilkDeliveries);
    api('/api/settings').then(r => r.json()).then(s => setSettings(prev => ({ ...prev, ...s })));
  }, []);

  async function saveSettings(updates) {
    const next = { ...settings, ...updates };
    setSettings(next);
    await api('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  }

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

  async function saveMilk() {
    const body = {
      delivery_date: mForm.delivery_date,
      whole_bottles_received: parseFloat(mForm.whole_bottles_received) || 0,
      whole_bottles_onhand:   parseFloat(mForm.whole_bottles_onhand)   || 0,
      notes: mForm.notes,
    };
    const r = await api('/api/milk-deliveries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    setMilkDeliveries(x => [d, ...x]);
    setMForm({ delivery_date: TODAY, whole_bottles_received: '', whole_bottles_onhand: '', notes: '' });
  }

  async function delRow(endpoint, id, setter) {
    await api(`${endpoint}/${id}`, { method: 'DELETE' });
    setter(x => x.filter(r => r.id !== id));
  }

  const setC = k => e => setCForm(p => ({ ...p, [k]: e.target.value }));
  const setM = k => e => setMForm(p => ({ ...p, [k]: e.target.value }));

  return (
    <div className="page">
      <div className="page-eyebrow">Inventory</div>
      <h1 className="page-title">Stock Log</h1>
      <p className="page-sub">Log coffee & milk deliveries. Numilk is calculated automatically from daily rates.</p>
      <hr className="page-rule" />

      {/* Modifier ml setting */}
      <div className="settings-row">
        <span className="settings-lbl">ml per milk modifier</span>
        <input className="settings-input" type="number" value={settings.alt_milk_ml_per_modifier}
          onChange={e => saveSettings({ alt_milk_ml_per_modifier: parseFloat(e.target.value) || 180 })} />
        <span style={{ fontSize: 12, color: 'var(--steam-light)' }}>Applied to Whole, Oat & Almond modifier counts from Square</span>
      </div>

      {/* Numilk daily rates */}
      <div className="section">
        <div className="section-title">Numilk Daily Production Rates</div>
        <div className="card">
          <p style={{ fontSize: 12, color: 'var(--steam)', marginBottom: 16, lineHeight: 1.6 }}>
            Set the daily production rate for each type. The app multiplies this by the number of days in the report period to calculate total stock available.
          </p>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-lbl">🌾 Oat Milk (L/day)</label>
              <input type="number" className="form-input" step="0.1" value={settings.numilk_oat_liters_per_day}
                onChange={e => saveSettings({ numilk_oat_liters_per_day: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="form-group">
              <label className="form-lbl">🌰 Almond Milk (L/day)</label>
              <input type="number" className="form-input" step="0.1" value={settings.numilk_almond_liters_per_day}
                onChange={e => saveSettings({ numilk_almond_liters_per_day: parseFloat(e.target.value) || 0 })} />
            </div>
            <div className="form-group" style={{ justifyContent: 'flex-end' }}>
              <label className="form-lbl">Preview (14-day period)</label>
              <div style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--espresso)', paddingTop: 8 }}>
                Oat: {(settings.numilk_oat_liters_per_day * 14).toFixed(1)}L &nbsp;·&nbsp; Almond: {(settings.numilk_almond_liters_per_day * 14).toFixed(1)}L
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Coffee deliveries */}
      <div className="section">
        <div className="section-title">Coffee Deliveries</div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">Log New Delivery</div>
          <p style={{ fontSize: 11, color: 'var(--steam)', marginBottom: 14, lineHeight: 1.6 }}>
            Enter lbs on hand before this delivery, and lbs received. Opening stock for a period = on hand + received at the first delivery.
          </p>
          <div style={{ marginBottom: 14 }}>
            <div className="form-group" style={{ maxWidth: 200 }}>
              <label className="form-lbl">Date</label>
              <input type="date" className="form-input" value={cForm.delivery_date} onChange={setC('delivery_date')} />
            </div>
          </div>
          {[
            { label: 'Espresso', rec: 'espresso_lbs_received', oh: 'espresso_lbs_onhand' },
            { label: 'Drip',     rec: 'drip_lbs_received',     oh: 'drip_lbs_onhand' },
            { label: 'Cold Brew',rec: 'coldbrew_lbs_received', oh: 'coldbrew_lbs_onhand' },
            { label: 'Pour-Over',rec: 'pourover_lbs_received', oh: 'pourover_lbs_onhand' },
          ].map(({ label, rec, oh }) => (
            <div key={label} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr 1fr', gap: 10, alignItems: 'end', marginBottom: 10 }}>
              <div style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--steam)', paddingBottom: 10 }}>{label}</div>
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
                <div style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--espresso)', paddingTop: 10, paddingBottom: 10 }}>
                  {((parseFloat(cForm[oh])||0) + (parseFloat(cForm[rec])||0)).toFixed(1)} lbs
                  <span style={{ color: 'var(--steam)', fontSize: 10, marginLeft: 6 }}>
                    = {(((parseFloat(cForm[oh])||0) + (parseFloat(cForm[rec])||0)) * LBS_TO_G / 1000).toFixed(2)}kg
                  </span>
                </div>
              </div>
            </div>
          ))}
          <div className="form-group" style={{ maxWidth: 400, marginTop: 6 }}>
            <label className="form-lbl">Notes</label>
            <input className="form-input" placeholder="e.g. Onyx roasters" value={cForm.notes} onChange={setC('notes')} />
          </div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={saveCoffee}>Log Delivery</button>
        </div>

        {coffeeDeliveries.length > 0 ? (
          <div className="table-wrap"><table>
            <thead><tr>
              <th>Date</th>
              <th>Espresso</th><th style={{color:'var(--caramel)'}}>+rcvd</th>
              <th>Drip</th><th style={{color:'var(--caramel)'}}>+rcvd</th>
              <th>Cold Brew</th><th style={{color:'var(--caramel)'}}>+rcvd</th>
              <th>Pour-Over</th><th style={{color:'var(--caramel)'}}>+rcvd</th>
              <th>Notes</th><th></th>
            </tr></thead>
            <tbody>{coffeeDeliveries.map(d => (
              <tr key={d.id}>
                <td style={{ fontFamily: 'DM Mono', fontSize: 11 }}>{d.delivery_date}</td>
                <td style={{ fontFamily: 'DM Mono', fontSize: 11 }}>{d.espresso_lbs_onhand > 0 ? `${d.espresso_lbs_onhand}lb` : '—'}</td>
                <td style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--caramel)' }}>{d.espresso_lbs_received > 0 ? `+${d.espresso_lbs_received}lb` : '—'}</td>
                <td style={{ fontFamily: 'DM Mono', fontSize: 11 }}>{d.drip_lbs_onhand > 0 ? `${d.drip_lbs_onhand}lb` : '—'}</td>
                <td style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--caramel)' }}>{d.drip_lbs_received > 0 ? `+${d.drip_lbs_received}lb` : '—'}</td>
                <td style={{ fontFamily: 'DM Mono', fontSize: 11 }}>{d.coldbrew_lbs_onhand > 0 ? `${d.coldbrew_lbs_onhand}lb` : '—'}</td>
                <td style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--caramel)' }}>{d.coldbrew_lbs_received > 0 ? `+${d.coldbrew_lbs_received}lb` : '—'}</td>
                <td style={{ fontFamily: 'DM Mono', fontSize: 11 }}>{d.pourover_lbs_onhand > 0 ? `${d.pourover_lbs_onhand}lb` : '—'}</td>
                <td style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--caramel)' }}>{d.pourover_lbs_received > 0 ? `+${d.pourover_lbs_received}lb` : '—'}</td>
                <td style={{ color: 'var(--steam)', fontSize: 11 }}>{d.notes || '—'}</td>
                <td><button className="btn btn-danger" onClick={() => delRow('/api/coffee-deliveries', d.id, setCoffeeDeliveries)}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <div className="empty">No coffee deliveries logged yet.</div>}
      </div>

      {/* Whole milk */}
      <div className="section">
        <div className="section-title">Whole Milk Deliveries</div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">Log Weekly Delivery</div>
          <p style={{ fontSize: 11, color: 'var(--steam)', marginBottom: 14, lineHeight: 1.6 }}>
            Enter number of 1-gallon bottles. App converts to liters (1 gal = {GALLONS_TO_L.toFixed(3)}L).
          </p>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-lbl">Date</label>
              <input type="date" className="form-input" value={mForm.delivery_date} onChange={setM('delivery_date')} />
            </div>
            <div className="form-group">
              <label className="form-lbl">Bottles On Hand</label>
              <input type="number" className="form-input" placeholder="e.g. 3" value={mForm.whole_bottles_onhand} onChange={setM('whole_bottles_onhand')} />
            </div>
            <div className="form-group">
              <label className="form-lbl">Bottles Received</label>
              <input type="number" className="form-input" placeholder="e.g. 12" value={mForm.whole_bottles_received} onChange={setM('whole_bottles_received')} />
            </div>
            <div className="form-group">
              <label className="form-lbl">Total</label>
              <div style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--espresso)', paddingTop: 10 }}>
                {((parseFloat(mForm.whole_bottles_onhand)||0) + (parseFloat(mForm.whole_bottles_received)||0)).toFixed(0)} gal
                <span style={{ color: 'var(--steam)', fontSize: 10, marginLeft: 6 }}>
                  = {(((parseFloat(mForm.whole_bottles_onhand)||0) + (parseFloat(mForm.whole_bottles_received)||0)) * GALLONS_TO_L).toFixed(1)}L
                </span>
              </div>
            </div>
            <div className="form-group">
              <label className="form-lbl">Notes</label>
              <input className="form-input" placeholder="Optional" value={mForm.notes} onChange={setM('notes')} />
            </div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={saveMilk}>Log Delivery</button>
        </div>

        {milkDeliveries.length > 0 ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>On Hand</th><th>Received</th><th>Total</th><th>Notes</th><th></th></tr></thead>
            <tbody>{milkDeliveries.map(d => {
              const total = d.whole_bottles_onhand + d.whole_bottles_received;
              return (
                <tr key={d.id}>
                  <td style={{ fontFamily: 'DM Mono', fontSize: 11 }}>{d.delivery_date}</td>
                  <td style={{ fontFamily: 'DM Mono', fontSize: 11 }}>{d.whole_bottles_onhand} gal</td>
                  <td style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--caramel)' }}>+{d.whole_bottles_received} gal</td>
                  <td style={{ fontFamily: 'DM Mono', fontSize: 11 }}>{total} gal = {(total * GALLONS_TO_L).toFixed(1)}L</td>
                  <td style={{ color: 'var(--steam)', fontSize: 11 }}>{d.notes || '—'}</td>
                  <td><button className="btn btn-danger" onClick={() => delRow('/api/milk-deliveries', d.id, setMilkDeliveries)}>Delete</button></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        ) : <div className="empty">No milk deliveries logged yet.</div>}
      </div>
    </div>
  );
}
