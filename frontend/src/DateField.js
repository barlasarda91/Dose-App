import React, { useState, useRef, useEffect } from 'react';

// Brand-styled date picker — replaces the native browser calendar so the
// popup matches the Boxx design system (palette + typefaces).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export default function DateField({ value, onChange, min, placeholder = 'Select date', clearable = false, style }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => (value || new Date().toISOString().slice(0, 10)).slice(0, 7));
  const ref = useRef(null);

  useEffect(() => {
    const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const [y, m] = view.split('-').map(Number);
  const startDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = new Date().toISOString().slice(0, 10);
  const fmt = d => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const nav = delta => setView(new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7));

  const pick = d => { onChange(d); setOpen(false); if (d) setView(d.slice(0, 7)); };

  return (
    <div className="datefield" ref={ref} style={style}>
      <button type="button" className={`datefield-input${value ? '' : ' empty'}`}
        onClick={() => { setOpen(o => !o); if (value) setView(value.slice(0, 7)); }}>
        {value || placeholder}
      </button>
      {open && (
        <div className="df-pop">
          <div className="df-head">
            <button type="button" className="df-nav" onClick={() => nav(-1)}>‹</button>
            <span className="df-title">{MONTHS[m - 1]} {y}</span>
            <button type="button" className="df-nav" onClick={() => nav(1)}>›</button>
          </div>
          <div className="df-grid">
            {DOW.map(d => <span key={d} className="df-dow">{d}</span>)}
            {Array.from({ length: startDow }, (_, i) => <span key={`b${i}`} />)}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const d = fmt(i + 1);
              return (
                <button type="button" key={d} disabled={!!min && d < min}
                  className={`df-day${d === value ? ' sel' : ''}${d === today ? ' today' : ''}`}
                  onClick={() => pick(d)}>
                  {i + 1}
                </button>
              );
            })}
          </div>
          <div className="df-foot">
            <button type="button" className="df-link" onClick={() => { setView(today.slice(0, 7)); if (!min || today >= min) pick(today); }}>Today</button>
            {clearable && <button type="button" className="df-link" onClick={() => pick('')}>Clear</button>}
          </div>
        </div>
      )}
    </div>
  );
}
