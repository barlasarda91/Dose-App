import React, { useState, useEffect } from 'react';
import { apiJson } from '../api';

export default function Settings({ onSave }) {
  const [locationId, setLocationId] = useState('');
  const [shopName, setShopName]     = useState('');
  const [orderEmail, setOrderEmail] = useState('');
  const [status, setStatus]         = useState({ tokenSet: false, passwordProtected: false, resendConfigured: false });
  const [saved, setSaved]           = useState(false);

  useEffect(() => {
    apiJson('/api/settings').then(s => {
      setLocationId(s.square_location_id || '');
      setShopName(s.shop_name || '');
      setOrderEmail(s.order_email_to || '');
      setStatus({
        tokenSet: !!s.square_token_set,
        passwordProtected: !!s.password_protected,
        resendConfigured: !!s.resend_configured,
      });
    }).catch(() => {});
  }, []);

  async function save() {
    await apiJson('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        square_location_id: locationId,
        shop_name: shopName,
        order_email_to: orderEmail,
      }),
    });
    setSaved(true);
    if (onSave) onSave();
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="page">
      <div className="page-eyebrow">Configuration</div>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Square API, ordering, milk rates, and dose reference.</p>
      <hr className="page-rule" />

      <div className="settings-section">
        <div className="section-title">Square API</div>
        <div className="settings-card">
          <div className="settings-field">
            <label className="settings-field-lbl">Access Token</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <span className={`conn-status ${status.tokenSet ? 'ok' : 'fail'}`} style={{ marginTop: 0 }}>
                {status.tokenSet ? '● Token configured via Railway environment variable' : '✕ SQUARE_ACCESS_TOKEN not set — add it as a Railway environment variable'}
              </span>
            </div>
            <div className="settings-field-hint" style={{ marginTop: 8 }}>
              Set <code>SQUARE_ACCESS_TOKEN</code> in your Railway service → Variables tab. The token never passes through the browser.
            </div>
          </div>

          <div className="settings-field">
            <label className="settings-field-lbl">Location ID <span style={{ fontWeight: 300, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
            <input type="text" placeholder="L1234ABCD…" value={locationId} onChange={e => setLocationId(e.target.value)} style={{ maxWidth: 320 }} />
            <div className="settings-field-hint">Leave blank to query all locations.</div>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="section-title">Ordering</div>
        <div className="settings-card">
          <div className="settings-field">
            <label className="settings-field-lbl">Shop Name</label>
            <input type="text" placeholder="e.g. Boxx Coffee — Kadıköy" value={shopName} onChange={e => setShopName(e.target.value)} style={{ maxWidth: 320 }} />
            <div className="settings-field-hint">Shown in the order email so the roastery knows which shop is ordering.</div>
          </div>

          <div className="settings-field">
            <label className="settings-field-lbl">Order Email</label>
            <input type="text" placeholder="hello@boxxcoffee.com" value={orderEmail} onChange={e => setOrderEmail(e.target.value)} style={{ maxWidth: 320 }} />
            <div className="settings-field-hint">Where Place Order sends the order.</div>
          </div>

          <div className="settings-field">
            <label className="settings-field-lbl">Email Sending</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <span className={`conn-status ${status.resendConfigured ? 'ok' : 'fail'}`} style={{ marginTop: 0 }}>
                {status.resendConfigured ? '● RESEND_API_KEY configured — orders will be emailed' : '✕ RESEND_API_KEY not set — orders are saved but not emailed'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="section-title">Security</div>
        <div className="settings-card">
          <div className="settings-field">
            <label className="settings-field-lbl">Password Protection</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <span className={`conn-status ${status.passwordProtected ? 'ok' : 'fail'}`} style={{ marginTop: 0 }}>
                {status.passwordProtected ? '● Protected — DOSE_PASSWORD is set' : '✕ Open access — set DOSE_PASSWORD in Railway → Variables to require a password'}
              </span>
            </div>
            <div className="settings-field-hint" style={{ marginTop: 8 }}>
              Strongly recommended: without it, anyone with the URL can read sales data and place orders.
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 8, marginBottom: 32 }}>
        <button className="btn btn-primary" onClick={save}>Save</button>
        {saved && <span className="conn-status ok" style={{ marginTop: 0 }}>✓ Saved</span>}
      </div>

      <div className="settings-section">
        <div className="section-title">Dose Reference</div>
        <div className="settings-card">
          <p style={{ fontSize: 12, color: 'var(--drift)', marginBottom: 16, lineHeight: 1.7 }}>
            Fixed dose calculations baked into your drink recipes. Edit on the Drink Recipes page to adjust.
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Pool</th><th>Drink</th><th>Dose</th><th>Calculation</th></tr></thead>
              <tbody>
                <tr><td>Espresso</td><td>All espresso drinks</td><td style={{ fontFamily: 'var(--font-mono)' }}>18g</td><td style={{ color: 'var(--drift)' }}>Single shot</td></tr>
                <tr><td>Drip</td><td>Batch Brew, Cafe Au Lait</td><td style={{ fontFamily: 'var(--font-mono)' }}>24.4g</td><td style={{ color: 'var(--drift)' }}>110g ÷ 4.5 cups per batch</td></tr>
                <tr><td>Cold Brew</td><td>Cold Brew</td><td style={{ fontFamily: 'var(--font-mono)' }}>26.2g</td><td style={{ color: 'var(--drift)' }}>4kg ÷ (20×1.8L ÷ 236ml per 8oz serve)</td></tr>
                <tr><td>Pour-Over</td><td>Pour Over (all beans)</td><td style={{ fontFamily: 'var(--font-mono)' }}>19g</td><td style={{ color: 'var(--drift)' }}>Single brew</td></tr>
                <tr><td>Pour-Over</td><td>Turkish Coffee</td><td style={{ fontFamily: 'var(--font-mono)' }}>7.5g</td><td style={{ color: 'var(--drift)' }}>Shares pour-over pool</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
