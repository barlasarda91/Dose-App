import React, { useState, useEffect } from 'react';
import './App.css';
import Dashboard from './pages/Dashboard';
import Stock     from './pages/Stock';
import Order     from './pages/Order';
import Recipes   from './pages/Recipes';
import Settings  from './pages/Settings';
import { api, setKey, clearKey } from './api';

// First run: create the ADMIN account (done by whoever provisions the shop —
// there is no self-registration). Every other visit: log in with the
// username + password an admin created. Both exchange credentials for a
// session token stored in localStorage — the password is never kept.
function Gate({ mode }) {
  const [username, setUsername] = useState('');
  const [pw, setPw]           = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr]         = useState(null);
  const [busy, setBusy]       = useState(false);
  const isSetup = mode === 'setup';

  async function submit(e) {
    e.preventDefault();
    if (!pw || !username || busy) return;
    if (isSetup && pw !== confirm) { setErr('Passwords do not match'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(isSetup ? '/api/setup' : '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) {
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
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--graphite)', lineHeight: 1.7, marginBottom: 14 }}>
            First-time setup — create the <strong>admin</strong> account for this shop. The admin creates all other user accounts from Settings.
          </p>
        )}
        <label className="form-lbl" htmlFor="dose-user">{isSetup ? 'Admin Username' : 'Username'}</label>
        <input id="dose-user" type="text" className="form-input" autoFocus autoCapitalize="none" autoCorrect="off"
          value={username} onChange={e => setUsername(e.target.value)} />
        <label className="form-lbl" htmlFor="dose-pw" style={{ marginTop: 8 }}>{isSetup ? 'Create Password' : 'Password'}</label>
        <input id="dose-pw" type="password" className="form-input"
          value={pw} onChange={e => setPw(e.target.value)} />
        {isSetup && (
          <>
            <label className="form-lbl" htmlFor="dose-pw2" style={{ marginTop: 8 }}>Repeat Password</label>
            <input id="dose-pw2" type="password" className="form-input"
              value={confirm} onChange={e => setConfirm(e.target.value)} />
          </>
        )}
        {err && <div className="login-err">{err}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || !pw || !username} style={{ marginTop: 14, width: '100%' }}>
          {busy ? '…' : isSetup ? 'Create Admin & Enter' : 'Enter'}
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
