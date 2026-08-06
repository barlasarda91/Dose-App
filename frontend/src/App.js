import React, { useState, useEffect } from 'react';
import './App.css';
import Dashboard from './pages/Dashboard';
import Stock     from './pages/Stock';
import Order     from './pages/Order';
import Recipes   from './pages/Recipes';
import Settings  from './pages/Settings';
import { api, setKey, clearKey } from './api';

// First run: create the shop password. Every other visit: log in with it.
// Both exchange the password for a session token stored in localStorage —
// the password itself is never kept in the browser.
function Gate({ mode }) {
  const [pw, setPw]         = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr]       = useState(null);
  const [busy, setBusy]     = useState(false);
  const isSetup = mode === 'setup';

  async function submit(e) {
    e.preventDefault();
    if (!pw || busy) return;
    if (isSetup && pw !== confirm) { setErr('Passwords do not match'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(isSetup ? '/api/setup' : '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) {
        setKey(data.token);
        window.location.reload();
      } else {
        setErr(data.error || (isSetup ? 'Setup failed' : 'Wrong password'));
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
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--graphite)', lineHeight: 1.7, marginBottom: 14 }}>
            Welcome — set a password for this shop. Everyone using the app shares it; you can change it later in Settings.
          </p>
        )}
        <label className="form-lbl" htmlFor="dose-pw">{isSetup ? 'Create Password' : 'Password'}</label>
        <input id="dose-pw" type="password" className="form-input" autoFocus
          value={pw} onChange={e => setPw(e.target.value)} />
        {isSetup && (
          <>
            <label className="form-lbl" htmlFor="dose-pw2" style={{ marginTop: 8 }}>Repeat Password</label>
            <input id="dose-pw2" type="password" className="form-input"
              value={confirm} onChange={e => setConfirm(e.target.value)} />
          </>
        )}
        {err && <div className="login-err">{err}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || !pw} style={{ marginTop: 14, width: '100%' }}>
          {busy ? '…' : isSetup ? 'Set Password & Enter' : 'Enter'}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState('dashboard');
  // 'checking' | 'setup' | 'login' | 'in'
  const [auth, setAuth] = useState('checking');

  useEffect(() => {
    (async () => {
      try {
        const status = await fetch('/api/auth-status').then(r => r.json());
        if (status.setup_required) { setAuth('setup'); return; }
        await api('/api/settings');
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
        </ul>
      </nav>
      {page === 'dashboard' && <Dashboard />}
      {page === 'stock'     && <Stock />}
      {page === 'order'     && <Order />}
      {page === 'recipes'   && <Recipes />}
      {page === 'settings'  && <Settings />}
    </>
  );
}
