import React, { useState, useEffect, useMemo } from 'react';
import { api, apiJson } from '../api';

// Brew method decides which ROAST a drink draws from — customers never pick
// a roast directly. Batch-brewed methods use batch inputs; per-cup dose is
// computed (and re-computed server-side on save).
const METHODS = {
  espresso: { label: 'Espresso Machine', roast: 'Espresso Roast', desc: 'espresso, lattes, anything pulled on the machine', batch: false },
  batch:    { label: 'Batch Brew',       roast: 'Filter Roast',   desc: 'drip urns, airpots — brewed by the batch',        batch: true },
  coldbrew: { label: 'Cold Brew',        roast: 'Filter Roast',   desc: 'steeped by the batch, served over days',          batch: true },
  pourover: { label: 'Pour-Over',        roast: 'Filter Roast',   desc: 'brewed to order, one cup at a time',              batch: false },
};
const OZ_PER_LITER = 33.814;
const EMPTY_FORM = { square_item_name: '', method: 'espresso', coffee_grams: '', batch_grams: '', yield_mode: 'cups', yield_cups: '', yield_liters: '', serving_oz: '', notes: '' };

function cupsOf(f) {
  return f.yield_mode === 'vol'
    ? ((parseFloat(f.yield_liters) || 0) * OZ_PER_LITER) / (parseFloat(f.serving_oz) || 0)
    : (parseFloat(f.yield_cups) || 0);
}
function doseOf(f) {
  if (!METHODS[f.method].batch) return parseFloat(f.coffee_grams) || 0;
  const cups = cupsOf(f);
  return Number.isFinite(cups) && cups > 0 ? Math.round(((parseFloat(f.batch_grams) || 0) / cups) * 10) / 10 : 0;
}
const methodOf = r => r.method || ({ espresso: 'espresso', drip: 'batch', coldbrew: 'coldbrew', pourover: 'pourover' }[r.category] || 'espresso');

export default function Recipes() {
  const [recipes, setRecipes] = useState(null);
  const [square, setSquare]   = useState({ configured: false, items: [], ignored: [] });
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api('/api/recipes').then(r => r.json()).then(setRecipes).catch(() => setRecipes([]));
    apiJson('/api/square-items').then(setSquare).catch(() => {});
  }, []);

  const mapped = useMemo(() => new Set((recipes || []).map(r => r.square_item_name.toLowerCase().trim())), [recipes]);
  const inSquare = name => square.items.some(s => s.name.toLowerCase().trim() === name.toLowerCase().trim());
  const unmapped = square.items.filter(s => !mapped.has(s.name.toLowerCase().trim()) && !square.ignored.includes(s.name));

  function openEditor(name) {
    setErr(null);
    const existing = name != null && (recipes || []).find(r => r.square_item_name === name);
    if (existing) {
      setEditItem(existing);
      setForm({
        square_item_name: existing.square_item_name,
        method: methodOf(existing),
        coffee_grams: existing.coffee_grams ?? '',
        batch_grams: existing.batch_grams ?? '',
        yield_mode: existing.yield_mode || 'cups',
        yield_cups: existing.yield_cups ?? '',
        yield_liters: existing.yield_liters ?? '',
        serving_oz: existing.serving_oz ?? '',
        notes: existing.notes || '',
      });
    } else {
      setEditItem(null);
      setForm({ ...EMPTY_FORM, square_item_name: name || '' });
    }
    setShowModal(true);
  }

  async function save() {
    setErr(null);
    const isBatch = METHODS[form.method].batch;
    const body = {
      square_item_name: form.square_item_name,
      method: form.method,
      notes: form.notes,
      ...(isBatch
        ? { batch_grams: form.batch_grams, yield_mode: form.yield_mode, yield_cups: form.yield_cups, yield_liters: form.yield_liters, serving_oz: form.serving_oz }
        : { coffee_grams: form.coffee_grams }),
    };
    const r = await api(editItem ? `/api/recipes/${editItem.id}` : '/api/recipes', {
      method: editItem ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const updated = await r.json();
    if (updated.error) { setErr(updated.error); return; }
    setRecipes(rs => editItem ? rs.map(x => x.id === editItem.id ? updated : x) : [...rs, updated]);
    setShowModal(false);
  }

  async function del(r) {
    if (!window.confirm(`Delete the recipe for ${r.square_item_name}? Its sales stop counting toward usage.`)) return;
    await api(`/api/recipes/${r.id}`, { method: 'DELETE' });
    setRecipes(rs => rs.filter(x => x.id !== r.id));
  }

  async function ignore(name) {
    await api('/api/square-items/ignore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    setSquare(s => ({ ...s, ignored: [...s.ignored, name] }));
  }
  async function unignore(name) {
    await api('/api/square-items/unignore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    setSquare(s => ({ ...s, ignored: s.ignored.filter(n => n !== name) }));
  }

  const set = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  const doseText = r => {
    const m = methodOf(r);
    if (!METHODS[m].batch || r.batch_grams == null) return `${r.coffee_grams}g / ${METHODS[m].batch ? 'cup' : 'drink'}`;
    const cups = r.yield_mode === 'vol'
      ? Math.round(((r.yield_liters || 0) * OZ_PER_LITER) / (r.serving_oz || 1))
      : Math.round(r.yield_cups || 0);
    return `${r.coffee_grams}g / cup`
      + ` · ${r.batch_grams}g per batch → ≈${cups} cups${r.yield_mode === 'vol' ? ` (${r.yield_liters}L at ${r.serving_oz}oz)` : ''}`;
  };

  if (recipes === null) return <div className="page"><div className="empty" style={{ padding: '60px 0' }}>Loading recipes…</div></div>;

  // A brand-new shop sees one button, nothing else.
  if (recipes.length === 0) {
    return (
      <div className="page">
        <div className="page-eyebrow">Setup</div>
        <h1 className="page-title">Recipes</h1>
        <hr className="page-rule" />
        <div style={{ border: '1px solid var(--linen)', background: '#FCF8EE', padding: '70px 30px', textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, marginBottom: 10 }}>Start with your best seller</div>
          <p style={{ fontSize: 12, color: 'var(--drift)', maxWidth: 440, margin: '0 auto 22px', lineHeight: 1.8 }}>
            Pick a drink from your Square menu, say how it's brewed and how much coffee goes in.
            Dose handles the rest — usage, efficiency and reorder timing all flow from here.
          </p>
          <button className="btn btn-primary" style={{ fontSize: 11, padding: '14px 28px', background: 'var(--olive)' }} onClick={() => openEditor(null)}>
            + Add Your First Recipe
          </button>
        </div>
        {showModal && editorModal()}
      </div>
    );
  }

  const roastSection = (roast, label) => {
    const items = recipes.filter(r => METHODS[methodOf(r)].roast === roast);
    if (!items.length) return null;
    return (
      <div className="section" key={roast}>
        <div className="section-title">{label}</div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Square Item</th><th>Method</th><th>Coffee</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {items.map(r => (
                <tr key={r.id}>
                  <td>
                    <span style={{ fontWeight: 500 }}>{r.square_item_name}</span>
                    {square.configured && (
                      <div style={{ fontSize: 10, color: inSquare(r.square_item_name) ? 'var(--olive)' : 'var(--warn)' }}>
                        {inSquare(r.square_item_name) ? '✓ linked to Square item' : '⚠ no longer in your Square catalog — sales can’t match it'}
                      </div>
                    )}
                  </td>
                  <td><span style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', border: '1px solid var(--linen)', padding: '3px 8px', color: 'var(--drift)', whiteSpace: 'nowrap' }}>{METHODS[methodOf(r)].label}</span></td>
                  <td style={{ fontSize: 12 }}>{doseText(r)}</td>
                  <td style={{ color: 'var(--drift)', fontSize: 12 }}>{r.notes || '—'}</td>
                  <td><div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => openEditor(r.square_item_name)}>Edit</button>
                    <button className="btn btn-danger" onClick={() => del(r)}>Delete</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  function editorModal() {
    const m = METHODS[form.method];
    const dose = doseOf(form);
    const cups = cupsOf(form);
    const pickable = square.items.filter(s => !mapped.has(s.name.toLowerCase().trim()) || s.name === form.square_item_name);
    return (
      <div className="modal-bg" onClick={() => setShowModal(false)}>
        <div className="modal" style={{ width: 560 }} onClick={e => e.stopPropagation()}>
          <div className="modal-title">{editItem ? 'Edit Recipe' : 'Map a Square Item'}</div>
          <div className="modal-inner">
            <div className="form-group">
              <label className="form-lbl">Square Item *</label>
              {editItem ? (
                <div style={{ fontSize: 14, padding: '4px 0' }}>
                  {form.square_item_name}
                  {square.configured && (
                    <span style={{ fontSize: 10, marginLeft: 8, color: inSquare(form.square_item_name) ? 'var(--olive)' : 'var(--warn)' }}>
                      {inSquare(form.square_item_name) ? '✓ linked' : '⚠ retired from Square'}
                    </span>
                  )}
                </div>
              ) : square.configured && square.items.length > 0 ? (
                <>
                  <select className="form-select" value={form.square_item_name} onChange={set('square_item_name')}>
                    <option value="">Pick from your Square catalog…</option>
                    {pickable.map(s => (
                      <option key={s.name} value={s.name}>{s.name}{s.sold_30d != null ? ` (${s.sold_30d} sold, last 30 days)` : ''}</option>
                    ))}
                  </select>
                  <div className="settings-field-hint">Pulled live from your connected Square account — no typing, no name-matching accidents.</div>
                </>
              ) : (
                <>
                  <input className="form-input" placeholder="e.g. Caffe Latte — must match the Square item name exactly" value={form.square_item_name} onChange={set('square_item_name')} />
                  <div className="settings-field-hint">Square isn't connected yet, so type the item name exactly as it appears in Square.</div>
                </>
              )}
            </div>

            <div className="form-group">
              <label className="form-lbl">How is it brewed?</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {Object.entries(METHODS).map(([k, mm]) => (
                  <div key={k} onClick={() => setForm(p => ({ ...p, method: k }))}
                    style={{ border: form.method === k ? '2px solid var(--olive)' : '1px solid var(--linen)', background: form.method === k ? 'rgba(107,110,74,.10)' : '#FCF8EE', padding: form.method === k ? '11px 13px' : '12px 14px', cursor: 'pointer' }}>
                    <div style={{ fontSize: 12.5, color: 'var(--ink)' }}>{form.method === k ? '●' : '○'} {mm.label}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--drift)', lineHeight: 1.55, marginTop: 2 }}>{mm.desc}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--olive)', marginTop: 8 }}>
                Counts against <strong style={{ fontWeight: 400 }}>{m.roast}</strong> stock — worked out for you.
              </div>
            </div>

            {m.batch ? (
              <>
                <div className="form-group">
                  <label className="form-lbl">Coffee in per batch (g)</label>
                  <input className="form-input" type="number" step="10" style={{ width: 150, textAlign: 'right' }} placeholder="900" value={form.batch_grams} onChange={set('batch_grams')} />
                </div>
                <div className="form-group">
                  <label className="form-lbl">How do you know the yield?</label>
                  <div style={{ display: 'flex', gap: 16, fontSize: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                    <label style={{ cursor: 'pointer' }}><input type="radio" checked={form.yield_mode !== 'vol'} onChange={() => setForm(p => ({ ...p, yield_mode: 'cups' }))} /> Cups served per batch</label>
                    <label style={{ cursor: 'pointer' }}><input type="radio" checked={form.yield_mode === 'vol'} onChange={() => setForm(p => ({ ...p, yield_mode: 'vol' }))} /> Volume brewed</label>
                  </div>
                  {form.yield_mode === 'vol' ? (
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <div><label className="form-lbl">Batch volume (liters)</label>
                        <input className="form-input" type="number" step="0.5" style={{ width: 130, textAlign: 'right' }} placeholder="36" value={form.yield_liters} onChange={set('yield_liters')} /></div>
                      <div><label className="form-lbl">Serving size (oz)</label>
                        <input className="form-input" type="number" step="1" style={{ width: 120, textAlign: 'right' }} placeholder="12" value={form.serving_oz} onChange={set('serving_oz')} /></div>
                    </div>
                  ) : (
                    <div><label className="form-lbl">Cups served per batch</label>
                      <input className="form-input" type="number" step="1" style={{ width: 130, textAlign: 'right' }} placeholder="40" value={form.yield_cups} onChange={set('yield_cups')} /></div>
                  )}
                </div>
                {dose > 0 ? (
                  <div style={{ border: '1px solid var(--olive)', background: 'rgba(107,110,74,.07)', padding: '10px 14px', fontSize: 12 }}>
                    = <strong style={{ fontWeight: 400 }}>{dose}g per cup</strong>
                    <span style={{ color: 'var(--drift)' }}> · {form.batch_grams}g ÷ ≈{Math.round(cups)} cups — that's what each sale deducts</span>
                  </div>
                ) : (
                  <div className="settings-field-hint">Fill the batch inputs and the per-cup dose appears here.</div>
                )}
              </>
            ) : (
              <div className="form-group">
                <label className="form-lbl">Coffee per drink (g)</label>
                <input className="form-input" type="number" step="0.1" style={{ width: 150, textAlign: 'right' }} placeholder="18" value={form.coffee_grams} onChange={set('coffee_grams')} />
              </div>
            )}

            <div className="form-group"><label className="form-lbl">Notes (optional)</label>
              <input className="form-input" placeholder="e.g. 12oz · concentrate keg" value={form.notes} onChange={set('notes')} /></div>
            {err && <div className="error-banner"><span>⚠</span><div>{err}</div></div>}
          </div>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={!form.square_item_name || doseOf(form) <= 0}>
              {editItem ? 'Save Changes' : 'Save Recipe'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-eyebrow">Setup</div>
      <h1 className="page-title">Recipes</h1>
      <hr className="page-rule" />

      {square.configured && unmapped.length > 0 && (
        <div style={{ border: '1px solid var(--warn)', borderLeft: '4px solid var(--warn)', background: 'rgba(196,131,58,.07)', padding: '16px 18px', marginBottom: 18 }}>
          <div className="form-lbl" style={{ color: 'var(--warn)' }}>Selling in Square, not counted yet</div>
          <div style={{ fontSize: 11, color: 'var(--drift)', marginBottom: 8, lineHeight: 1.7 }}>
            These items have sales but no recipe — their coffee use is invisible until you map them (or ignore drinks with no coffee).
          </div>
          {unmapped.map(s => (
            <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid rgba(184,175,163,.4)', flexWrap: 'wrap' }}>
              <span><span style={{ fontSize: 13, color: 'var(--ink)' }}>{s.name}</span>
                {s.sold_30d != null && <span style={{ fontSize: 11, color: 'var(--drift)' }}> · {s.sold_30d} sold, last 30 days</span>}</span>
              <span style={{ display: 'inline-flex', gap: 8 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => ignore(s.name)}>No coffee — ignore</button>
                <button className="btn btn-primary btn-sm" style={{ background: 'var(--olive)' }} onClick={() => openEditor(s.name)}>Map It</button>
              </span>
            </div>
          ))}
        </div>
      )}
      {square.error && <div className="warn-box">⚠ Couldn't load your Square catalog: {square.error}. You can still add recipes by typing the item name.</div>}

      {roastSection('Espresso Roast', 'Espresso Roast drinks')}
      {roastSection('Filter Roast', 'Filter Roast drinks')}

      {square.ignored.length > 0 && (
        <div className="section">
          <div className="section-title">Ignored — no coffee in these</div>
          <div>
            {square.ignored.map(n => (
              <span key={n} style={{ display: 'inline-flex', gap: 8, alignItems: 'center', border: '1px solid var(--linen)', padding: '4px 10px', fontSize: 12, color: 'var(--drift)', margin: '0 8px 8px 0', background: '#EBE3D2' }}>
                {n} <span style={{ cursor: 'pointer', color: 'var(--olive)' }} title="un-ignore" onClick={() => unignore(n)}>↺</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <button className="btn btn-primary" onClick={() => openEditor(null)}>+ Add Recipe</button>
      {showModal && editorModal()}
    </div>
  );
}
