import React, { useState, useEffect, useCallback } from 'react';
import { apiJson, setKey } from '../api';

const EMPTY_NEW_USER = { username: '', password: '', role: 'user' };

function UsersSection() {
  const [users, setUsers]   = useState([]);
  const [form, setForm]     = useState(EMPTY_NEW_USER);
  const [msg, setMsg]       = useState(null);

  const load = useCallback(() => apiJson('/api/users').then(setUsers).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  async function addUser() {
    setMsg(null);
    try {
      const data = await apiJson('/api/users', { method: 'POST', body: JSON.stringify(form) });
      if (data.error) throw new Error(data.error);
      setUsers(u => [...u, data].sort((a, b) => a.username.localeCompare(b.username)));
      setForm(EMPTY_NEW_USER);
      setMsg({ ok: true, text: `✓ Account '${data.username}' created — share the username and password with them` });
    } catch (e) {
      if (!e.unauthorized) setMsg({ ok: false, text: e.message });
    }
  }

  async function resetPassword(u) {
    const pw = window.prompt(`New password for '${u.username}' (min 6 characters):`);
    if (pw === null) return;
    setMsg(null);
    try {
      const data = await apiJson(`/api/users/${u.id}/reset-password`, { method: 'POST', body: JSON.stringify({ new_password: pw }) });
      if (data.error) throw new Error(data.error);
      setMsg({ ok: true, text: `✓ Password reset for '${u.username}' — they are signed out everywhere` });
    } catch (e) {
      if (!e.unauthorized) setMsg({ ok: false, text: e.message });
    }
  }

  async function deleteUser(u) {
    if (!window.confirm(`Delete account '${u.username}'? They will lose access immediately.`)) return;
    setMsg(null);
    try {
      const data = await apiJson(`/api/users/${u.id}`, { method: 'DELETE' });
      if (data.error) throw new Error(data.error);
      setUsers(x => x.filter(y => y.id !== u.id));
    } catch (e) {
      if (!e.unauthorized) setMsg({ ok: false, text: e.message });
    }
  }

  return (
    <div className="settings-section">
      <div className="section-title">Users</div>
      <div className="settings-card">
        <div className="settings-field-hint" style={{ marginBottom: 14 }}>
          There is no self-registration — accounts exist only when you create them here. Admins can manage users
          and credentials; regular users can run reports, log stock, and place orders.
        </div>

        {users.length > 0 && (
          <div className="table-wrap" style={{ marginBottom: 18 }}>
            <table>
              <thead><tr><th>Username</th><th>Role</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 500 }}>{u.username}</td>
                    <td style={{ color: u.role === 'admin' ? 'var(--olive)' : 'var(--drift)' }}>{u.role}</td>
                    <td style={{ color: 'var(--drift)', fontSize: 11 }}>{(u.created_at || '').slice(0, 10)}</td>
                    <td><div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => resetPassword(u)}>Reset Password</button>
                      <button className="btn btn-danger" onClick={() => deleteUser(u)}>Delete</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="settings-field-lbl" style={{ marginBottom: 8 }}>Add User</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group">
            <label className="form-lbl">Username</label>
            <input type="text" className="form-input" placeholder="e.g. kadikoy-shop" autoCapitalize="none"
              value={form.username} onChange={e => setForm(p => ({ ...p, username: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-lbl">Password</label>
            <input type="password" className="form-input" placeholder={form.role === 'admin' ? 'min 10 characters' : 'min 6 characters'} autoComplete="new-password"
              value={form.password} onChange={e => setForm(p => ({ ...p, password: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-lbl">Role</label>
            <select className="form-select" value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={addUser} disabled={!form.username || !form.password}>
            Create Account
          </button>
        </div>
        {msg && <div style={{ marginTop: 10 }}><span className={`conn-status ${msg.ok ? 'ok' : 'fail'}`}>{msg.text}</span></div>}
      </div>
    </div>
  );
}

export default function Settings({ me }) {
  const isAdmin = me?.role === 'admin';
  const [locationId, setLocationId] = useState('');
  const [shopName, setShopName]     = useState('');
  const [hubUrl, setHubUrl]         = useState('');
  // Secret inputs are write-only: blank = keep current value
  const [squareToken, setSquareToken] = useState('');
  const [hubApiKey, setHubApiKey]     = useState('');
  const [status, setStatus] = useState({ tokenSet: false, tokenSource: null, resendConfigured: false, resendSource: null, hubConfigured: false, authMode: 'local' });
  const [saved, setSaved]   = useState(false);
  const [hub, setHub] = useState({ loading: true });
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwMsg, setPwMsg]   = useState(null);

  async function load() {
    const s = await apiJson('/api/settings');
    setLocationId(s.square_location_id || '');
    setShopName(s.shop_name || '');
    setHubUrl(s.hub_url || '');
    setStatus({
      tokenSet: !!s.square_token_set,
      tokenSource: s.square_token_source,
      resendConfigured: !!s.resend_configured,
      resendSource: s.resend_source,
      hubConfigured: !!s.hub_configured,
      authMode: s.auth_mode || 'local',
      storagePersistent: s.storage_persistent,
    });
  }
  async function checkHub() {
    setHub({ loading: true });
    try { setHub({ loading: false, ...(await apiJson('/api/hub-status')) }); }
    catch { setHub({ loading: false, configured: true, ok: false, error: 'Could not verify — try reloading' }); }
  }
  useEffect(() => { load().catch(() => {}); checkHub(); }, []);

  async function save() {
    const body = { shop_name: shopName };
    if (isAdmin) {
      body.square_location_id = locationId;
      // Only send secrets the user actually typed — blank means "keep as is"
      if (squareToken.trim() !== '') body.square_access_token = squareToken.trim();
      if (hubApiKey.trim()   !== '') body.hub_api_key = hubApiKey.trim();
    }
    await apiJson('/api/settings', { method: 'POST', body: JSON.stringify(body) });
    setSquareToken(''); setHubApiKey('');
    await load().catch(() => {});
    checkHub();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  async function changePassword() {
    setPwMsg(null);
    if (pwForm.next !== pwForm.confirm) { setPwMsg({ ok: false, text: 'New passwords do not match' }); return; }
    try {
      const data = await apiJson('/api/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: pwForm.current, new_password: pwForm.next }),
      });
      if (data.error) throw new Error(data.error);
      if (data.token) setKey(data.token); // stay logged in on this device; other sessions are signed out
      setPwForm({ current: '', next: '', confirm: '' });
      setPwMsg({ ok: true, text: '✓ Password changed — your other devices will need to log in again' });
    } catch (e) {
      if (!e.unauthorized) setPwMsg({ ok: false, text: e.message });
    }
  }

  const sourceNote = src =>
    src === 'env' ? ' (from Railway environment variable — entering one here overrides it)' : '';

  return (
    <div className="page">
      <div className="page-eyebrow">Configuration</div>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        {isAdmin ? 'Square API, ordering, users, security, and dose reference.' : 'Shop info, your password, and dose reference.'}
      </p>
      <hr className="page-rule" />

      {status.storagePersistent === false && (
        <div className="error-banner">
          <span>⚠</span>
          <div>
            <strong>No persistent volume — all data on this shop is erased on every deploy.</strong><br />
            In Railway: right-click this service → Attach Volume → mount path <code>/app/data</code>, then redeploy
            and re-enter your credentials once. Until then, every build wipes settings, orders, and stock history.
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="settings-section">
          <div className="section-title">Square API</div>
          <div className="settings-card">
            <div className="settings-field">
              <label className="settings-field-lbl">Access Token</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 8 }}>
                <span className={`conn-status ${status.tokenSet ? 'ok' : 'fail'}`} style={{ marginTop: 0 }}>
                  {status.tokenSet
                    ? `● Token configured${sourceNote(status.tokenSource)}`
                    : '✕ Not set — paste your Square production access token below'}
                </span>
              </div>
              <input type="password" placeholder={status.tokenSet ? '•••••••• (leave blank to keep current)' : 'EAAA…'}
                value={squareToken} onChange={e => setSquareToken(e.target.value)} style={{ maxWidth: 420 }}
                autoComplete="new-password" />
              <div className="settings-field-hint">
                Square Developer dashboard → your application → Production → Access token. Stored in this shop's own database, never shown back once saved.
              </div>
            </div>

            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              <div className="settings-field">
                <label className="settings-field-lbl">Location ID <span style={{ fontWeight: 300, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
                <input type="text" placeholder="L1234ABCD…" value={locationId} onChange={e => setLocationId(e.target.value)} style={{ width: 240 }} />
                <div className="settings-field-hint">Leave blank to query all locations.</div>
              </div>
              <div className="settings-field">
                <label className="settings-field-lbl">Shop Name</label>
                <input type="text" placeholder="e.g. Boxx Coffee — Kadıköy" value={shopName} onChange={e => setShopName(e.target.value)} style={{ width: 240 }} />
                <div className="settings-field-hint">Identifies this location on orders and reports.</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="settings-section">
          <div className="section-title">Ordering</div>
          <div className="settings-card">
            <div className="settings-field">
              <label className="settings-field-lbl">Roastery Hub</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 8 }}>
                <span className={`conn-status ${hub.loading ? '' : hub.ok ? 'ok' : 'fail'}`} style={{ marginTop: 0 }}>
                  {hub.loading ? '… verifying key with the hub'
                    : !hub.configured ? '✕ Not connected — enter the API key from the roastery'
                    : hub.ok ? `● Key verified — the hub recognizes this shop as “${hub.shop_name || 'unnamed shop'}” · ${hub.items} coffee${hub.items === 1 ? '' : 's'} on your price list`
                    : `✕ Key saved but not working: ${hub.error}`}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 420 }}>
                <input type="password" placeholder={status.hubConfigured ? '•••••••• (leave blank to keep current)' : 'dose_… (API key from the roastery)'}
                  value={hubApiKey} onChange={e => setHubApiKey(e.target.value)} autoComplete="new-password" />
              </div>
              <div className="settings-field-hint">
                The roastery creates this shop in their Dose Hub and gives you this key — it's all you need. Receipts and confirmations are emailed by the hub to your registered address.
              </div>
            </div>

          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 8, marginBottom: 32 }}>
        <button className="btn btn-primary" onClick={save}>Save</button>
        {saved && <span className="conn-status ok" style={{ marginTop: 0 }}>✓ Saved</span>}
      </div>

      {isAdmin && status.authMode !== 'hub' && <UsersSection />}

      <div className="settings-section">
        <div className="section-title">Security</div>
        <div className="settings-card">
          <div className="settings-field">
            <label className="settings-field-lbl">Change My Password{me ? ` (${me.username})` : ''}</label>
            <div className="settings-field-hint" style={{ marginBottom: 10 }}>
              Changing your password signs you out on every other device.
              {status.authMode === 'hub'
                ? ' Your login is managed by the roastery hub — changing it here updates it at the hub for everyone using this shop account.'
                : (!isAdmin ? ' Forgot it? Ask your admin to reset it.' : '')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 320 }}>
              <input type="password" placeholder="Current password" value={pwForm.current}
                onChange={e => setPwForm(p => ({ ...p, current: e.target.value }))} autoComplete="current-password" />
              <input type="password" placeholder="New password (min 6 characters)" value={pwForm.next}
                onChange={e => setPwForm(p => ({ ...p, next: e.target.value }))} autoComplete="new-password" />
              <input type="password" placeholder="Repeat new password" value={pwForm.confirm}
                onChange={e => setPwForm(p => ({ ...p, confirm: e.target.value }))} autoComplete="new-password" />
              <button className="btn btn-ghost" onClick={changePassword}
                disabled={!pwForm.current || !pwForm.next || !pwForm.confirm}>
                Change Password
              </button>
              {pwMsg && <span className={`conn-status ${pwMsg.ok ? 'ok' : 'fail'}`}>{pwMsg.text}</span>}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
