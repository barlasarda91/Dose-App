import React, { useState, useEffect } from 'react';
import { api } from '../api';

const CATS = [
  { id: 'espresso', label: 'Espresso' },
  { id: 'drip',     label: 'Drip' },
  { id: 'coldbrew', label: 'Cold Brew' },
  { id: 'pourover', label: 'Pour-Over' },
];
const EMPTY = { square_item_name: '', category: 'espresso', coffee_grams: '', milk_whole_ml: '', notes: '' };

export default function Recipes() {
  const [recipes, setRecipes]   = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm]         = useState(EMPTY);
  const [selected, setSelected] = useState(new Set());
  const [showBatch, setShowBatch] = useState(false);
  const [batchFields, setBatchFields] = useState({ coffee_grams: '', milk_whole_ml: '' });

  useEffect(() => { api('/api/recipes').then(r => r.json()).then(setRecipes); }, []);

  async function save() {
    const body = { ...form, coffee_grams: parseFloat(form.coffee_grams) || 0, milk_whole_ml: parseFloat(form.milk_whole_ml) || 0 };
    const url = editItem ? `/api/recipes/${editItem.id}` : '/api/recipes';
    const method = editItem ? 'PUT' : 'POST';
    const r = await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const updated = await r.json();
    setRecipes(rs => editItem ? rs.map(x => x.id === editItem.id ? updated : x) : [...rs, updated]);
    setShowModal(false);
  }

  async function del(id) {
    if (!window.confirm('Delete?')) return;
    await api(`/api/recipes/${id}`, { method: 'DELETE' });
    setRecipes(rs => rs.filter(r => r.id !== id));
  }

  async function applyBatch() {
    for (const id of selected) {
      const r = recipes.find(x => x.id === id);
      const body = {
        ...r,
        coffee_grams: batchFields.coffee_grams !== '' ? parseFloat(batchFields.coffee_grams) : r.coffee_grams,
        milk_whole_ml: batchFields.milk_whole_ml !== '' ? parseFloat(batchFields.milk_whole_ml) : r.milk_whole_ml,
      };
      const updated = await api(`/api/recipes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json());
      setRecipes(rs => rs.map(x => x.id === id ? updated : x));
    }
    setSelected(new Set()); setBatchFields({ coffee_grams: '', milk_whole_ml: '' }); setShowBatch(false);
  }

  function toggleSelect(id) { setSelected(p => { const s = new Set(p); s.has(id) ? s.delete(id) : s.add(id); return s; }); }
  function toggleAll(ids) {
    setSelected(p => ids.every(id => p.has(id)) ? (ids.forEach(id => { const s = new Set(p); s.delete(id); return s; }), new Set([...p].filter(id => !ids.includes(id)))) : new Set([...p, ...ids]));
  }
  const set = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

  return (
    <div className="page">
      <div className="page-eyebrow">Configuration</div>
      <h1 className="page-title">Recipes</h1>
      <p className="page-sub">Map Square items to coffee pools and set dose weights.</p>
      <hr className="page-rule" />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        {selected.size > 0 && <button className="btn btn-accent" style={{ marginRight: 8 }} onClick={() => setShowBatch(true)}>Batch Edit {selected.size}</button>}
        <button className="btn btn-primary" onClick={() => { setEditItem(null); setForm(EMPTY); setShowModal(true); }}>+ Add Recipe</button>
      </div>

      {showBatch && (
        <div className="batch-bar">
          <span className="batch-bar-label">Editing {selected.size} items —</span>
          <div className="batch-field"><label>Coffee (g)</label><input type="number" placeholder="skip if blank" value={batchFields.coffee_grams} onChange={e => setBatchFields(p => ({ ...p, coffee_grams: e.target.value }))} /></div>
          <button className="btn btn-accent btn-sm" onClick={applyBatch}>Apply</button>
          <button className="btn btn-secondary btn-sm" onClick={() => { setShowBatch(false); setSelected(new Set()); }}>Cancel</button>
        </div>
      )}

      {CATS.map(cat => {
        const items = recipes.filter(r => r.category === cat.id);
        const catIds = items.map(r => r.id);
        const allSel = catIds.length > 0 && catIds.every(id => selected.has(id));
        return (
          <div key={cat.id} className="section">
            <div className="section-title">{cat.label}</div>
            {items.length === 0 ? <div className="empty">No {cat.label.toLowerCase()} recipes yet.</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th className="checkbox-col"><input type="checkbox" checked={allSel} onChange={() => toggleAll(catIds)} /></th>
                    <th>Square Item Name</th><th>Coffee (g)</th><th>Notes</th><th></th>
                  </tr></thead>
                  <tbody>
                    {items.map(r => (
                      <tr key={r.id} className={selected.has(r.id) ? 'selected' : ''}>
                        <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} /></td>
                        <td style={{ fontWeight: 500 }}>{r.square_item_name}</td>
                        <td style={{ fontFamily: 'DM Mono' }}>{r.coffee_grams}g</td>
                        <td style={{ color: 'var(--steam)', fontSize: 11 }}>{r.notes || '—'}</td>
                        <td><div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => { setEditItem(r); setForm({ ...r }); setShowModal(true); }}>Edit</button>
                          <button className="btn btn-danger" onClick={() => del(r.id)}>Delete</button>
                        </div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {showModal && (
        <div className="modal-bg" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{editItem ? 'Edit Recipe' : 'New Recipe'}</div>
            <div className="modal-inner">
              <div className="form-group"><label className="form-lbl">Square Item Name *</label><input className="form-input" placeholder="e.g. Caffe Latte" value={form.square_item_name} onChange={set('square_item_name')} /></div>
              <div className="form-grid">
                <div className="form-group"><label className="form-lbl">Category</label>
                  <select className="form-select" value={form.category} onChange={set('category')}>
                    {CATS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </div>
                <div className="form-group"><label className="form-lbl">Coffee (g)</label><input className="form-input" type="number" placeholder="e.g. 18" value={form.coffee_grams} onChange={set('coffee_grams')} /></div>
              </div>
              <div className="form-group"><label className="form-lbl">Notes</label><input className="form-input" placeholder="Optional" value={form.notes} onChange={set('notes')} /></div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={!form.square_item_name || !form.coffee_grams}>Save Recipe</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
