import React, { useState, useEffect } from 'react';
import './App.css';
import Dashboard from './pages/Dashboard';
import Stock     from './pages/Stock';
import Order     from './pages/Order';
import Recipes   from './pages/Recipes';
import Settings  from './pages/Settings';
import { api, setKey, clearKey } from './api';

function Login() {
  const [pw, setPw]     = useState('');
  const [err, setErr]   = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        setKey(pw);
        window.location.reload();
      } else {
        setErr('Wrong password');
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
        <label className="form-lbl" htmlFor="dose-pw">Password</label>
        <input id="dose-pw" type="password" className="form-input" autoFocus
          value={pw} onChange={e => setPw(e.target.value)} />
        {err && <div className="login-err">{err}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || !pw} style={{ marginTop: 14, width: '100%' }}>
          {busy ? '…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState('dashboard');
  // null = checking, true = in, false = show login
  const [authed, setAuthed] = useState(null);

  useEffect(() => {
    api('/api/settings')
      .then(() => setAuthed(true))
      .catch(e => {
        if (e.unauthorized) { clearKey(); setAuthed(false); }
        else setAuthed(true); // server unreachable ≠ locked out; let pages surface the error
      });
    const onUnauth = () => { clearKey(); setAuthed(false); };
    window.addEventListener('dose:unauthorized', onUnauth);
    return () => window.removeEventListener('dose:unauthorized', onUnauth);
  }, []);

  if (authed === null) return null;
  if (!authed) return <Login />;

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
