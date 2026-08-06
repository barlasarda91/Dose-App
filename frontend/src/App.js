import React, { useState, useEffect } from 'react';
import './App.css';
import Dashboard from './pages/Dashboard';
import Stock     from './pages/Stock';
import Order     from './pages/Order';
import Recipes   from './pages/Recipes';
import Settings  from './pages/Settings';
import { api, setKey, clearKey } from './api';

// First run (gated by the setup code from the server logs): either connect
// this deployment to the roastery hub — logins are then the hub-issued shop
// credentials — or create a standalone local admin. Every other visit: log
// in. Credentials are exchanged for a session token stored in localStorage;
// the password itself is never kept.
function Gate({ mode }) {
  const [username, setUsername] = useState('');
  const [pw, setPw]           = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode]       = useState('');
  const [hubUrl, setHubUrl]   = useState('');
  const [hubKey, setHubKey]   = useState('');
  const [setupMode, setSetupMode] = useState('hub'); // 'hub' | 'standalone'
  const [err, setErr]         = useState(null);
  const [msg, setMsg]         = useState(null);
  const [busy, setBusy]       = useState(false);
  const isSetup = mode === 'setup';
  const isHubSetup = isSetup && setupMode === 'hub';

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (isHubSetup) { if (!code || !hubUrl || !hubKey) return; }
    else {
      if (!pw || !username) return;
      if (isSetup && pw !== confirm) { setErr('Passwords do not match'); return; }
    }
    setBusy(true); setErr(null);
    try {
      const body = isHubSetup
        ? { mode: 'hub', setup_code: code, hub_url: hubUrl, hub_api_key: hubKey }
        : { username, password: pw, ...(isSetup ? { setup_code: code } : {}) };
      const res = await fetch(isSetup ? '/api/setup' : '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.connected) {
        setMsg('✓ Connected to the roastery hub. Sign in with the shop credentials the roastery gave you.');
        setTimeout(() => window.location.reload(), 1800);
      } else if (res.ok && data.token) {
        setKey(data.token);
        window.location.reload();
      } else {
        setErr(data.error || (isSetup ? 'Setup failed' : 'Wrong username or password'));
      }
    } catch {
      setErr('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-title">Dose</div>
        <div className="login-sub">Boxx Coffee Roasters Co.</div>

        {isSetup && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            <button type="button" className={`btn ${setupMode === 'hub' ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1, padding: '7px 6px' }}
              onClick={() => { setSetupMode('hub'); setErr(null); }}>Connect to Hub</button>
            <button type="button" className={`btn ${setupMode === 'standalone' ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1, padding: '7px 6px' }}
              onClick={() => { setSetupMode('standalone'); setErr(null); }}>Standalone</button>
          </div>
        )}

        {isSetup && (
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--graphite)', lineHeight: 1.7, marginBottom: 14 }}>
            {isHubSetup
              ? <>Connect this shop to the roastery's Dose Hub. You need the hub URL and this shop's API key (from the hub's Shops tab), plus the setup code from this server's logs.</>
              : <>Run this shop without a roastery hub: create a local <strong>admin</strong> account. You need the setup code from the server logs.</>}
          </p>
        )}

        {isSetup && (
          <>
            <label className="form-lbl" htmlFor="dose-code">Setup Code</label>
            <input id="dose-code" type="text" className="form-input" autoCapitalize="none" autoCorrect="off"
              value={code} onChange={e => setCode(e.target.value)} />
          </>
        )}

        {isHubSetup ? (
          <>
            <label className="form-lbl" htmlFor="dose-huburl" style={{ marginTop: 8 }}>Hub URL</label>
            <input id="dose-huburl" type="text" className="form-input" placeholder="https://boxx-hub.up.railway.app"
              autoCapitalize="none" autoCorrect="off" value={hubUrl} onChange={e => setHubUrl(e.target.value)} />
            <label className="form-lbl" htmlFor="dose-hubkey" style={{ marginTop: 8 }}>Shop API Key</label>
            <input id="dose-hubkey" type="password" className="form-input" placeholder="dose_…"
              value={hubKey} onChange={e => setHubKey(e.target.value)} />
          </>
        ) : (
          <>
            <label className="form-lbl" htmlFor="dose-user" style={isSetup ? { marginTop: 8 } : undefined}>{isSetup ? 'Admin Username' : 'Username'}</label>
            <input id="dose-user" type="text" className="form-input" autoFocus autoCapitalize="none" autoCorrect="off"
              value={username} onChange={e => setUsername(e.target.value)} />
            <label className="form-lbl" htmlFor="dose-pw" style={{ marginTop: 8 }}>{isSetup ? 'Create Password (min 10 chars)' : 'Password'}</label>
            <input id="dose-pw" type="password" className="form-input"
              value={pw} onChange={e => setPw(e.target.value)} />
            {isSetup && (
              <>
                <label className="form-lbl" htmlFor="dose-pw2" style={{ marginTop: 8 }}>Repeat Password</label>
                <input id="dose-pw2" type="password" className="form-input"
                  value={confirm} onChange={e => setConfirm(e.target.value)} />
              </>
            )}
          </>
        )}

        {err && <div className="login-err">{err}</div>}
        {msg && <div className="login-err" style={{ color: 'var(--olive)' }}>{msg}</div>}
        <button className="btn btn-primary" type="submit" style={{ marginTop: 14, width: '100%' }}
          disabled={busy || (isHubSetup ? (!code || !hubUrl || !hubKey) : (!pw || !username || (isSetup && !code)))}>
          {busy ? '…' : isHubSetup ? 'Connect Shop' : isSetup ? 'Create Admin & Enter' : 'Enter'}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState('dashboard');
  // 'checking' | 'setup' | 'login' | 'in'
  const [auth, setAuth] = useState('checking');
  const [me, setMe] = useState(null); // { username, role }

  useEffect(() => {
    (async () => {
      try {
        const status = await fetch('/api/auth-status').then(r => r.json());
        if (status.setup_required) { setAuth('setup'); return; }
        const user = await (await api('/api/me')).json();
        setMe(user);
        setAuth('in');
      } catch (e) {
        if (e.unauthorized) { clearKey(); setAuth('login'); }
        else setAuth('in'); // server unreachable ≠ locked out; let pages surface the error
      }
    })();
    const onUnauth = () => { clearKey(); setAuth('login'); };
    window.addEventListener('dose:unauthorized', onUnauth);
    return () => window.removeEventListener('dose:unauthorized', onUnauth);
  }, []);

  function logout() {
    clearKey();
    window.location.reload();
  }

  if (auth === 'checking') return null;
  if (auth === 'setup') return <Gate mode="setup" />;
  if (auth === 'login') return <Gate mode="login" />;

  const pages = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'stock',     label: 'Stock' },
    { id: 'order',     label: 'Order' },
    { id: 'recipes',   label: 'Recipes' },
    { id: 'settings',  label: 'Settings' },
  ];
  return (
    <>
      <nav className="nav">
        <span className="nav-logo">Dose · Boxx Coffee Roasters Co.</span>
        <ul className="nav-links">
          {pages.map(p => (
            <li key={p.id}>
              <span className={`nav-link${page === p.id ? ' active' : ''}`} onClick={() => setPage(p.id)}>
                {p.label}
              </span>
            </li>
          ))}
          <li>
            <span className="nav-link" onClick={logout} title={me ? `Signed in as ${me.username}` : ''}>
              {me ? `${me.username} · Sign Out` : 'Sign Out'}
            </span>
          </li>
        </ul>
      </nav>
      {page === 'dashboard' && <Dashboard />}
      {page === 'stock'     && <Stock />}
      {page === 'order'     && <Order />}
      {page === 'recipes'   && <Recipes />}
      {page === 'settings'  && <Settings me={me} />}
    </>
  );
}
