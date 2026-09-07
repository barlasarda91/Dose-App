/* Dose Hub dashboard — vanilla JS, no build step. */
(() => {
  const app = document.getElementById('app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getToken = () => localStorage.getItem('hub_key') || '';
  let CURRENCY = '$';
  const money = v => v == null ? '—' : `${CURRENCY}${(Math.round(v * 100) / 100).toFixed(2)}`;

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (getToken()) headers['x-hub-key'] = getToken();
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) { localStorage.removeItem('hub_key'); renderLogin(); throw new Error('Unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ─── Login ──────────────────────────────────────────────────────────────────
  function renderLogin(msg) {
    app.innerHTML = `
      <div class="login-wrap"><form class="login-card" id="login-form">
        <div class="login-title">Dose Hub</div>
        <div class="login-sub">Boxx Coffee Roasters Co.</div>
        <label class="lbl" for="pw">Roastery Password</label>
        <input type="password" id="pw" style="width:100%" autofocus>
        <div class="err" id="login-err">${esc(msg || '')}</div>
        <button class="btn" type="submit" style="margin-top:14px;width:100%">Enter</button>
      </form></div>`;
    document.getElementById('login-form').onsubmit = async e => {
      e.preventDefault();
      try {
        const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: document.getElementById('pw').value }) });
        localStorage.setItem('hub_key', data.token);
        renderShell('orders');
      } catch (err) {
        document.getElementById('login-err').textContent = err.message === 'Unauthorized' ? 'Wrong password' : err.message;
      }
    };
  }

  // ─── Shell + tabs ───────────────────────────────────────────────────────────
  const TABS = [['orders', 'Orders'], ['roast', 'Roast'], ['fulfill', 'Fulfillment'], ['onhand', 'On Hand'], ['math', 'Roast Math'], ['catalog', 'Catalog'], ['shops', 'Shops'], ['patterns', 'Patterns'], ['reports', 'Reports']];
  function renderShell(active) {
    app.innerHTML = `
      <nav class="nav">
        <span class="nav-logo">Dose Hub · Boxx Coffee Roasters Co.</span>
        <ul class="nav-links">
          ${TABS.map(([id, label]) => `<li><span class="nav-link ${id === active ? 'active' : ''}" data-tab="${id}">${label}</span></li>`).join('')}
          <li><span class="nav-link" id="signout">Sign Out</span></li>
        </ul>
      </nav>
      <div class="page" id="page"></div>`;
    app.querySelectorAll('[data-tab]').forEach(el => el.onclick = () => renderShell(el.dataset.tab));
    document.getElementById('signout').onclick = () => { localStorage.removeItem('hub_key'); renderLogin(); };
    ({ orders: renderOrders, roast: renderRoast, fulfill: renderFulfill, onhand: renderOnHand, math: renderRoastMath, catalog: renderCatalog, shops: renderShops, patterns: renderPatterns, reports: renderReports })[active]();
  }

  const header = (eyebrow, title, sub) =>
    `<div class="eyebrow">${eyebrow}</div><h1 class="title">${title}</h1><p class="sub">${sub}</p><hr class="rule">`;

  const ROAST_TAGS = { espresso: 'ESP', filter: 'FLT', retail: 'RTL', retail_espresso: 'RTL·ESP', retail_filter: 'RTL·FLT' };
  const isRetail = r => r === 'retail' || String(r).startsWith('retail_');
  const roastTag = r => `<span class="roast-lbl">${ROAST_TAGS[r] || r}</span>`;
  const qtyText = i => isRetail(i.roast) ? `${i.bags} × 12oz` : `${i.lbs} lbs`;
  const kg = lbs => (lbs * 0.453592).toFixed(1);
  const PROFILE_NAMES = { espresso: 'Espresso', filter: 'Filter', legacy_retail: 'Retail (legacy)' };

  // Generic modal
  const modalBg = document.getElementById('modal-bg');
  const openModal = html => { document.getElementById('modal').innerHTML = html; modalBg.classList.add('show'); };
  const closeModal = () => modalBg.classList.remove('show');
  modalBg.addEventListener('click', e => { if (e.target.id === 'modal-bg') closeModal(); });

  // ─── Orders inbox ───────────────────────────────────────────────────────────
  async function renderOrders() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Orders', 'Incoming orders from client shops — confirming an order emails the shop.');
    let shops = [], orders = [];
    try { [shops, orders] = await Promise.all([api('/api/shops'), api('/api/orders')]); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }

    const listEl = document.createElement('div');
    page.appendChild(listEl);

    let editing = null;        // order id being edited
    let pastOpen = false, fMonth = '', fShop = '', fStatus = '';

    const itemsHtml = o => o.items && o.items.length
      ? o.items.map(i => `<div style="white-space:nowrap">${roastTag(i.roast)} ${esc(i.coffee_name)} · ${qtyText(i)} · ${money(i.line_total)}</div>`).join('')
      : ['espresso_lbs', 'drip_lbs', 'coldbrew_lbs', 'pourover_lbs'].filter(f => o[f] > 0)
          .map(f => `<div>${esc(f.replace('_lbs', ''))}: ${o[f]} lbs</div>`).join('') || '—';

    const itemsEditHtml = o => o.items.map(i => `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;white-space:nowrap">
        ${roastTag(i.roast)} ${esc(i.coffee_name)}
        <input type="number" min="0" step="${isRetail(i.roast) ? 1 : 0.5}" value="${isRetail(i.roast) ? i.bags : i.lbs}"
          data-edit-item="${i.id}" style="width:70px;text-align:right">
        <span style="color:var(--drift);font-size:10px">${isRetail(i.roast) ? 'bags' : 'lbs'}</span>
      </div>`).join('');

    const nextAction = o =>
      o.status === 'confirmed' ? `<button class="btn-sm btn" data-adv="${o.id}" data-to="shipped">Mark Shipped</button>`
      : o.status === 'shipped' ? `<button class="btn-sm btn" data-adv="${o.id}" data-to="delivered">Mark Delivered</button>` : '';

    // New orders get the olive lift; everything else collapses under Past Orders.
    const newCard = o => `
      <div class="neworder">
        <div class="no-head">
          <div>
            <div class="no-shop">${esc(o.shop_name)}</div>
            <div class="no-meta">#${o.id} · received ${esc((o.received_at || '').slice(0, 16))}${o.placed_by ? ` by ${esc(o.placed_by)}` : ''} · ${o.requested_date ? `<b>requested ${esc(o.requested_date)}</b>` : 'no requested date'}</div>
          </div>
          <span class="pill">New</span>
        </div>
        <div class="no-items">
          ${editing === o.id ? itemsEditHtml(o) : itemsHtml(o)}
          ${o.notes ? `<div style="color:var(--warn)">✎ ${esc(o.notes)}</div>` : ''}
        </div>
        <div class="no-foot">
          <span class="no-tot">${o.total_lbs || '—'} lbs · ${money(o.total_cost)}</span>
          <span style="display:flex;gap:8px;flex-wrap:wrap">
            ${editing === o.id
              ? `<button class="btn-sm btn" data-save-edit="${o.id}">Save & Notify</button>
                 <button class="btn-sm btn" data-cancel-edit="1">Cancel</button>`
              : `<button class="btn-danger btn" data-del="${o.id}">Delete</button>
                 ${o.items && o.items.length ? `<button class="btn-sm btn" data-start-edit="${o.id}">Edit Quantities</button>` : ''}
                 <button class="btn btn-olive" data-adv="${o.id}" data-to="confirmed">Confirm Order</button>`}
          </span>
        </div>
      </div>`;

    function draw() {
      const news = orders.filter(o => o.status === 'new');
      const past = orders.filter(o => o.status !== 'new');
      const months = [...new Set(past.map(o => String(o.order_date || '').slice(0, 7)))].filter(Boolean).sort().reverse();
      const rows = past.filter(o =>
        (!fMonth || String(o.order_date || '').slice(0, 7) === fMonth) &&
        (!fShop || String(o.shop_id) === fShop) &&
        (!fStatus || o.status === fStatus));

      listEl.innerHTML = `
        <span class="ok" id="action-msg" style="margin:0;display:block;min-height:18px"></span>
        <div class="sechead" style="margin-top:8px"><span>New — needs your confirmation</span><span style="color:var(--olive)">${news.length} waiting</span></div>
        ${news.length ? news.map(newCard).join('') : `<div class="empty">No new orders waiting${shops.length ? '' : ' — add a shop first (Shops tab)'}.</div>`}
        <div class="sechead"><span>Everything else</span></div>
        <div class="collapsed" id="past-toggle">
          <span><span class="chev ${pastOpen ? 'open' : ''}">›</span> &nbsp;<strong style="font-weight:400">Past Orders</strong>
            <span style="color:var(--drift)"> — ${past.length} confirmed, shipped and delivered</span></span>
          <span style="font-size:11px;color:var(--drift)">${pastOpen ? 'click to collapse' : 'click to open and search'}</span>
        </div>
        ${pastOpen ? `
          <div class="filters" style="padding-top:14px">
            <select id="f-month"><option value="">All months</option>${months.map(m => `<option value="${m}" ${fMonth === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
            <select id="f-shop"><option value="">All accounts</option>${shops.map(s => `<option value="${s.id}" ${fShop === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
            <select id="f-status"><option value="">All statuses</option>${['confirmed', 'shipped', 'delivered'].map(st => `<option value="${st}" ${fStatus === st ? 'selected' : ''}>${st}</option>`).join('')}</select>
            <span style="font-size:11px;color:var(--drift)">${rows.length} of ${past.length} orders</span>
          </div>
          ${rows.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Received</th><th>Shop</th><th>Requested</th><th>Items</th><th class="num">Lbs</th><th class="num">Total</th><th>By</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows.map(o => `
              <tr>
                <td>${esc((o.received_at || '').slice(0, 16))}</td>
                <td style="font-weight:500">${esc(o.shop_name)}</td>
                <td>${esc(o.requested_date || o.order_date)}</td>
                <td style="line-height:1.9;font-size:11px">
                  ${editing === o.id ? itemsEditHtml(o) : itemsHtml(o)}
                  ${o.notes ? `<div style="color:var(--drift)">✎ ${esc(o.notes)}</div>` : ''}
                </td>
                <td class="num">${o.total_lbs || '—'}</td>
                <td class="num">${money(o.total_cost)}</td>
                <td style="color:var(--drift)">${esc(o.placed_by || '—')}</td>
                <td><span class="status ${o.status}">${o.status}</span></td>
                <td><div style="display:flex;gap:6px;flex-wrap:wrap">
                  ${editing === o.id
                    ? `<button class="btn-sm btn" data-save-edit="${o.id}">Save & Notify</button>
                       <button class="btn-sm btn" data-cancel-edit="1">Cancel</button>`
                    : `${nextAction(o)}
                       ${o.status === 'confirmed' && o.items && o.items.length ? `<button class="btn-sm btn" data-start-edit="${o.id}">Edit</button>` : ''}
                       <button class="btn-danger btn" data-del="${o.id}">Delete</button>`}
                </div></td>
              </tr>`).join('')}
            </tbody></table></div>` : '<div class="empty">No orders match those filters.</div>'}` : ''}`;

      const flash = (text) => {
        const msgEl = document.getElementById('action-msg');
        if (msgEl) { msgEl.textContent = text; setTimeout(() => { if (msgEl.isConnected) msgEl.textContent = ''; }, 7000); }
      };
      const pt = document.getElementById('past-toggle');
      if (pt) pt.onclick = () => { pastOpen = !pastOpen; draw(); };
      const wire = (id, setter) => { const el = document.getElementById(id); if (el) el.onchange = e => { setter(e.target.value); draw(); }; };
      wire('f-month', v => { fMonth = v; });
      wire('f-shop', v => { fShop = v; });
      wire('f-status', v => { fStatus = v; });

      listEl.querySelectorAll('[data-adv]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try {
          const updated = await api(`/api/orders/${btn.dataset.adv}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.to }) });
          orders = orders.map(o => o.id === updated.id ? updated : o);
          draw();
          if (updated.email) flash(updated.email.sent ? `✓ ${updated.status === 'shipped' ? 'Shipped' : 'Confirmation'} email sent to ${updated.email.to}` : `⚠ Status updated, but email not sent: ${updated.email.reason}`);
        } catch (e) { alert(e.message); }
      });
      listEl.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
        const o = orders.find(x => String(x.id) === btn.dataset.del);
        if (!window.confirm(`Delete order #${o.id} from ${o.shop_name}? It disappears from the hub permanently — roast program, patterns and reports stop counting it. The shop's own order log keeps its copy.`)) return;
        btn.disabled = true;
        try {
          await api(`/api/orders/${o.id}`, { method: 'DELETE' });
          orders = orders.filter(x => x.id !== o.id);
          draw();
          flash(`✓ Order #${o.id} deleted`);
        } catch (e) { alert(e.message); btn.disabled = false; }
      });
      listEl.querySelectorAll('[data-start-edit]').forEach(btn => btn.onclick = () => { editing = parseInt(btn.dataset.startEdit, 10); draw(); });
      listEl.querySelectorAll('[data-cancel-edit]').forEach(btn => btn.onclick = () => { editing = null; draw(); });
      listEl.querySelectorAll('[data-save-edit]').forEach(btn => btn.onclick = async () => {
        const id = parseInt(btn.dataset.saveEdit, 10);
        const items = [...listEl.querySelectorAll('[data-edit-item]')].map(inp => ({ id: parseInt(inp.dataset.editItem, 10), qty: inp.value }));
        try {
          const updated = await api(`/api/orders/${id}/items`, { method: 'PUT', body: JSON.stringify({ items }) });
          orders = orders.map(o => o.id === updated.id ? updated : o);
          editing = null;
          draw();
          flash(updated.email?.sent ? `✓ Order updated — notification emailed to ${updated.email.to}` : `⚠ Order updated, but email not sent: ${updated.email?.reason}`);
        } catch (e) { alert(e.message); }
      });
    }
    draw();
  }

  // ─── Roast Program ──────────────────────────────────────────────────────────
  // Per coffee × roast profile, stock-aware, whole batches only. Each line is
  // filled from stock, a fresh roast, or both — the roaster chooses.
  async function renderRoast(flashMsg) {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Roast Program', 'Everything confirmed and not yet roasted, per coffee and roast profile — checked against the On Hand shelf first. A batch is a batch: whatever it makes beyond the orders goes on the shelf.');
    let data;
    try { data = await api('/api/roast-program'); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }
    if (flashMsg) page.innerHTML += `<div class="ok" style="margin-bottom:14px">${flashMsg}</div>`;
    if (!data.lines.length) {
      page.innerHTML += '<div class="empty">Nothing left to roast — roasted orders are waiting in <span class="nav-link" data-goto="fulfill" style="text-decoration:underline;cursor:pointer">Fulfillment</span>, spare coffee is on the <span class="nav-link" data-goto="onhand" style="text-decoration:underline;cursor:pointer">On Hand</span> shelf.</div>';
      page.querySelectorAll('[data-goto]').forEach(el => el.onclick = () => renderShell(el.dataset.goto));
      return;
    }
    const t = data.totals;
    page.innerHTML += `
      <div class="summary">
        <div><div class="s-lbl">Owed to shops</div><div class="s-num">${t.owed_lbs} <span>lbs</span></div></div>
        <div><div class="s-lbl">Covered from stock</div><div class="s-num">${t.from_stock} <span>lbs</span></div></div>
        <div><div class="s-lbl">Batches to roast</div><div class="s-num">${t.batches}</div></div>
        <div><div class="s-lbl">Green to weigh out</div><div class="s-num">${t.green_in_lbs} <span>lbs</span></div><div class="stat-line">${kg(t.green_in_lbs)} kg</div></div>
        <div><div class="s-lbl">Left on the shelf after</div><div class="s-num">${t.leftover_lbs} <span>lbs</span></div></div>
        ${data.legacy_orders_excluded ? `<div class="stat-line" style="color:var(--warn)">${data.legacy_orders_excluded} legacy pool order(s) not included — handle manually from Orders</div>` : ''}
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Coffee</th><th>Profile</th><th class="num">Owed</th>
          <th class="num">On Hand</th><th class="num">Short By</th>
          <th class="num">Batches</th><th class="num">Green In</th><th class="num">Left After</th>
          <th>For Shops</th><th></th>
        </tr></thead>
        <tbody>${data.lines.map((l, idx) => {
          const legacy = l.profile === 'legacy_retail';
          const covered = !legacy && l.batches === 0;
          const breakdown = [
            l.wholesale_lbs > 0 ? `${l.wholesale_lbs} lbs wholesale` : null,
            l.retail_bags > 0 ? `${l.retail_bags} × 12oz (${l.retail_lbs} lbs)` : null,
          ].filter(Boolean).join(' + ');
          return `
          <tr class="${covered ? 'covered' : ''}">
            <td><span style="font-family:var(--serif);font-size:13px;color:var(--ink)">${esc(l.coffee_name)}</span>
              <div style="font-size:10px;color:var(--drift)">${breakdown}${legacy ? '' : ` · ${l.own_math ? '<span style="color:var(--olive)">own batch size</span>' : 'default batch'} ${l.batch_green_in} → ${l.batch_roasted_out} lbs`}</div></td>
            <td><span class="profile ${l.profile}">${PROFILE_NAMES[l.profile]}</span></td>
            <td class="num" style="color:var(--ink);font-size:13px">${l.owed_lbs} lbs</td>
            <td class="num">${legacy ? '—' : (l.stock_lbs > 0 ? `<span class="stockbox">${l.stock_lbs} lbs</span>` : '<span style="color:var(--linen)">—</span>')}</td>
            <td class="num">${legacy ? '—' : (l.short_lbs > 0 ? `${l.short_lbs} lbs` : '<span style="color:var(--olive)">covered</span>')}</td>
            <td class="num">${legacy ? '—' : (l.batches ? `<span class="batchbox">${l.batches} × ${l.batch_green_in} lbs</span>` : '<span style="color:var(--olive)">no roast</span>')}</td>
            <td class="num">${legacy || !l.green_in_lbs ? '—' : `<span style="color:var(--ink)">${l.green_in_lbs} lbs</span><div style="font-size:10px;color:var(--drift)">${kg(l.green_in_lbs)} kg</div>`}</td>
            <td class="num">${legacy ? '—' : (l.leftover_lbs > 0 ? `<span style="color:var(--warn)">+${l.leftover_lbs} lbs</span>` : '<span style="color:var(--drift)">nothing</span>')}</td>
            <td style="color:var(--drift);font-size:11px">${l.shops.map(esc).join(', ')}</td>
            <td class="num"><div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
              ${legacy
                ? `<button class="btn" data-fill="${idx}" data-mode="stock">Mark Roasted</button>`
                : covered
                  ? `<button class="btn btn-olive" data-fillmodal="${idx}" data-mode="stock">Fill from Stock</button>
                     <button class="btn-sm btn" data-fillmodal="${idx}" data-mode="fresh">Roast fresh instead</button>`
                  : `<button class="btn" data-fillmodal="${idx}" data-mode="stock">Log Roast${l.from_stock > 0 ? ' + stock' : ''}</button>
                     ${l.stock_lbs > 0 ? `<button class="btn-sm btn" data-fillmodal="${idx}" data-mode="fresh">Roast it all fresh</button>` : ''}`}
            </div></td>
          </tr>`;
        }).join('')}
        </tbody></table></div>
      <div class="stat-line" style="margin-top:10px">“Left after” lands on the <span class="nav-link" data-goto="onhand" style="text-decoration:underline;cursor:pointer">On Hand</span> shelf automatically. Batch sizes live in <span class="nav-link" data-goto="math" style="text-decoration:underline;cursor:pointer">Roast Math</span>.</div>`;
    page.querySelectorAll('[data-goto]').forEach(el => el.onclick = () => renderShell(el.dataset.goto));

    async function doFill(line, mode, actualOut) {
      const r = await api('/api/roast-program/fill', {
        method: 'POST',
        body: JSON.stringify({ coffee_id: line.coffee_id, profile: line.profile, mode, actual_out_lbs: actualOut }),
      });
      const mails = (r.roasted_emails || []).map(m =>
        m.sent ? `✉ “Roasted” email sent to ${esc(m.shop_name)}` : `⚠ ${esc(m.shop_name)} fully roasted, but email not sent: ${esc(m.reason)}`);
      closeModal();
      renderRoast([
        `☕ ${esc(line.coffee_name)} (${PROFILE_NAMES[line.profile]}) — ${r.batches ? `${r.batches} batch${r.batches === 1 ? '' : 'es'} logged, ` : ''}${r.orders_affected} order${r.orders_affected === 1 ? '' : 's'} moved to fulfillment${r.on_hand_now != null ? ` · ${r.on_hand_now} lbs now on the shelf` : ''}.`,
        ...mails,
      ].join('<br>'));
    }

    // Direct fill for legacy retail rows (no batch math, no modal).
    page.querySelectorAll('[data-fill]').forEach(btn => btn.onclick = async () => {
      btn.disabled = true;
      try { await doFill(data.lines[parseInt(btn.dataset.fill, 10)], 'stock'); }
      catch (e) { alert(e.message); btn.disabled = false; }
    });

    // Fill modal: choose stock vs fresh, confirm the real drop weight.
    page.querySelectorAll('[data-fillmodal]').forEach(btn => btn.onclick = () => {
      const line = data.lines[parseInt(btn.dataset.fillmodal, 10)];
      let mode = btn.dataset.mode;
      const drawModal = () => {
        const p = mode === 'fresh' ? line.fresh : line;
        const freshP = line.fresh;
        const modeCard = (m, title, desc, figure, mp) => `
          <div class="mode ${mode === m ? 'sel' : ''}" data-modesel="${m}">
            <div class="mode-t">${mode === m ? '●' : '○'} ${title}</div>
            <div class="mode-d">${desc}</div>
            <div class="mode-n">${figure}</div>
            <div class="mode-d" style="margin-top:6px">leaves <strong style="font-weight:400;color:var(--ink)">${mp.leftover_lbs} lbs</strong> on the shelf</div>
          </div>`;
        openModal(`
          <div class="modal-title">Fill Order — ${esc(line.coffee_name)} · ${PROFILE_NAMES[line.profile]}</div>
          <div class="modal-body">
            <div class="calcline" style="border-bottom:2px solid var(--ink);margin-bottom:14px">
              <span>Owed to ${line.orders_count} order${line.orders_count === 1 ? '' : 's'} · ${line.shops.map(esc).join(', ')}</span><b>${line.owed_lbs} lbs</b></div>
            <span class="lbl">How do you want to fill it?</span>
            <div class="modes">
              ${modeCard('stock', 'Use stock first',
                line.stock_lbs > 0 ? `${line.from_stock} lbs off the shelf${line.batches ? ` + ${line.batches} batch${line.batches === 1 ? '' : 'es'}` : ' — no roasting'}` : 'nothing on the shelf — must roast',
                line.batches ? `${line.green_in_lbs} lbs green · ${kg(line.green_in_lbs)} kg` : 'no green needed', line)}
              ${modeCard('fresh', 'Roast it all fresh',
                `${freshP.batches} whole batch${freshP.batches === 1 ? '' : 'es'} · shelf untouched`,
                `${freshP.green_in_lbs} lbs green · ${kg(freshP.green_in_lbs)} kg`, freshP)}
            </div>
            <div style="margin-top:16px">
              <div class="calcline"><span>From the shelf</span><b>${p.from_stock} lbs</b></div>
              <div class="calcline"><span>Still short</span><b>${p.short_lbs} lbs</b></div>
              <div class="calcline"><span>Whole batches (${line.batch_green_in} → ${line.batch_roasted_out} lbs each)</span><b>${p.batches || 'none'}</b></div>
              <div class="calcline"><span>Green to weigh out</span><b>${p.green_in_lbs} lbs · ${kg(p.green_in_lbs)} kg</b></div>
              <div class="calcline"><span>Expected output</span><b>${p.expected_out_lbs} lbs</b></div>
            </div>
            ${p.batches ? `
              <div style="margin-top:16px">
                <span class="lbl">Actual roasted output</span>
                <div style="display:flex;gap:10px;align-items:center">
                  <input type="number" step="0.1" id="fill-out" value="${p.expected_out_lbs}" style="width:120px;text-align:right">
                  <span style="font-size:11px;color:var(--drift)">lbs — correct it to the real drop weight off the scale</span>
                </div>
              </div>` : ''}
            <div style="margin-top:14px;font-size:11px;color:var(--graphite);line-height:1.7">
              Either way the orders are marked roasted and the shops get the usual <strong>Roasted</strong> email — they
              never see which route you took. Whatever is left over lands on the On Hand shelf.
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn-sm btn" id="fill-cancel">Cancel</button>
            <button class="btn btn-olive" id="fill-go">${p.batches ? 'Log Roast & Fill' : 'Fill from Stock'}</button>
          </div>`);
        document.querySelectorAll('[data-modesel]').forEach(el => el.onclick = () => { mode = el.dataset.modesel; drawModal(); });
        document.getElementById('fill-cancel').onclick = closeModal;
        document.getElementById('fill-go').onclick = async () => {
          const inp = document.getElementById('fill-out');
          document.getElementById('fill-go').disabled = true;
          try { await doFill(line, mode, inp ? parseFloat(inp.value) : undefined); }
          catch (e) { alert(e.message); closeModal(); }
        };
      };
      drawModal();
    });
  }

  // ─── On Hand (roasted coffee at the roastery) ───────────────────────────────
  async function renderOnHand() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'On Hand', 'Roasted coffee at the roastery, per coffee and roast profile. Batches land here in full; orders draw from here first.');
    let data;
    try { data = await api('/api/on-hand'); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }
    page.innerHTML += `
      <div class="summary">
        <div><div class="s-lbl">Total on the shelf</div><div class="s-num">${data.total_lbs} <span>lbs</span></div><div class="stat-line">${kg(data.total_lbs)} kg</div></div>
        <div><div class="s-lbl">Free (not committed)</div><div class="s-num">${data.free_lbs} <span>lbs</span></div></div>
        <div class="stat-line" style="max-width:320px">Committed is stock already spoken for by confirmed unroasted orders. Use ± for samples, staff coffee, spillage or a recount — every movement is logged below.</div>
      </div>
      ${data.rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Coffee</th><th>Profile</th><th class="num">On Hand</th><th class="num">Committed</th><th class="num">Free</th><th>Last Roast</th><th class="num">Adjust</th></tr></thead>
        <tbody>${data.rows.map((r, idx) => `
          <tr>
            <td style="font-family:var(--serif);font-size:13px;color:var(--ink)">${esc(r.coffee_name)}</td>
            <td><span class="profile ${r.profile}">${PROFILE_NAMES[r.profile]}</span></td>
            <td class="num" style="color:var(--ink);font-size:13px">${r.lbs} lbs<div style="font-size:10px;color:var(--drift)">${kg(r.lbs)} kg</div></td>
            <td class="num">${r.committed_lbs > 0 ? `<span style="color:var(--warn)">${r.committed_lbs} lbs</span>` : '<span style="color:var(--linen)">—</span>'}</td>
            <td class="num">${r.free_lbs} lbs</td>
            <td style="color:var(--drift);font-size:11px">${r.last_roast_at ? esc(r.last_roast_at.slice(0, 16)) : '—'}</td>
            <td class="num"><div style="display:flex;gap:6px;justify-content:flex-end">
              <button class="btn-sm btn" data-adj="${idx}" data-d="-1">−1</button>
              <button class="btn-sm btn" data-adj="${idx}" data-d="1">+1</button>
              <button class="btn-sm btn" data-adjcustom="${idx}">±…</button>
            </div></td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">Nothing on the shelf yet — it fills as batches out-produce orders.</div>'}
      <div class="sechead"><span>Movements</span><span style="font-size:11px;color:var(--drift)">every in and out, newest first</span></div>
      ${data.moves.length ? `<div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Coffee</th><th>Profile</th><th>What Happened</th><th class="num">Change</th></tr></thead>
        <tbody>${data.moves.map(m => `
          <tr>
            <td style="font-size:11px">${esc((m.created_at || '').slice(0, 16))}</td>
            <td>${esc(m.coffee_name)}</td>
            <td><span class="profile ${m.profile}">${PROFILE_NAMES[m.profile]}</span></td>
            <td>${esc(m.reason)}</td>
            <td class="num" style="color:${m.delta_lbs > 0 ? 'var(--olive)' : 'var(--graphite)'}">${m.delta_lbs > 0 ? '+' : ''}${m.delta_lbs} lbs</td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No movements yet.</div>'}`;

    const adjust = async (row, delta, note) => {
      try {
        await api('/api/on-hand/adjust', { method: 'POST', body: JSON.stringify({ coffee_id: row.coffee_id, profile: row.profile, delta_lbs: delta, note }) });
        renderOnHand();
      } catch (e) { alert(e.message); }
    };
    page.querySelectorAll('[data-adj]').forEach(btn => btn.onclick = () =>
      adjust(data.rows[parseInt(btn.dataset.adj, 10)], parseFloat(btn.dataset.d)));
    page.querySelectorAll('[data-adjcustom]').forEach(btn => btn.onclick = () => {
      const row = data.rows[parseInt(btn.dataset.adjcustom, 10)];
      const v = window.prompt(`Adjust ${row.coffee_name} (${PROFILE_NAMES[row.profile]}) by how many lbs? (negative to remove, e.g. -2.5)`);
      if (v === null) return;
      const delta = parseFloat(v);
      if (!Number.isFinite(delta) || delta === 0) return alert('Enter a non-zero number of lbs');
      const note = window.prompt('Why? (optional — e.g. recount, samples, staff coffee)') || '';
      adjust(row, delta, note);
    });
  }

  // ─── Roast Math (batch sizes & drop weights) ────────────────────────────────
  async function renderRoastMath(flashMsg) {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Roast Math', 'What one batch is, per roast profile — green in, roasted out. The Roast Program counts batches with these numbers.');
    let data;
    try { data = await api('/api/roast-math'); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }
    if (flashMsg) page.innerHTML += `<div class="ok" style="margin-bottom:14px">${flashMsg}</div>`;
    const lossPct = b => b && b.green_in > 0 ? Math.round((1 - b.roasted_out / b.green_in) * 1000) / 10 : null;
    const d = data.defaults;
    page.innerHTML += `
      <div class="card">
        <span class="lbl">Roastery Defaults</span>
        <div style="font-size:11px;color:var(--drift);margin-bottom:14px">Applied to every coffee with no override below. You enter what a batch actually is — the loss % is worked out for you.</div>
        <div style="display:flex;gap:44px;flex-wrap:wrap">
          ${['espresso', 'filter'].map(p => `
            <div>
              <div class="lbl" style="color:${p === 'espresso' ? 'var(--ink)' : 'var(--warn)'}">${PROFILE_NAMES[p]} Roast</div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <input type="number" step="0.5" min="0" id="def-${p}-in" value="${d[p] ? d[p].green_in : ''}" style="width:92px;text-align:right">
                <span style="font-size:11px;color:var(--drift)">lbs green in</span>
                <span style="color:var(--drift)">→</span>
                <input type="number" step="0.5" min="0" id="def-${p}-out" value="${d[p] ? d[p].roasted_out : ''}" style="width:92px;text-align:right">
                <span style="font-size:11px;color:var(--drift)">lbs roasted out</span>
              </div>
              <div style="font-size:11px;color:var(--drift);margin-top:6px">${d[p] ? `= ${lossPct(d[p])}% weight loss · ${kg(d[p].green_in)} kg green per drop` : ''}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="sechead"><span>Per-coffee overrides</span><span style="font-size:11px;color:var(--drift)">blank = roastery default</span></div>
      ${data.coffees.length ? `<div class="table-wrap"><table>
        <thead><tr>
          <th>Coffee</th>
          <th class="num">Espresso Green In</th><th class="num">Espresso Out</th>
          <th class="num">Filter Green In</th><th class="num">Filter Out</th>
          <th>Loss</th>
        </tr></thead>
        <tbody>${data.coffees.map(c => {
          const eff = p => c[p] || d[p];
          return `
          <tr>
            <td><span style="font-family:var(--serif);font-size:13px;color:var(--ink)">${esc(c.name)}</span>${c.badge ? `<span class="badge seasonal">${esc(c.badge)}</span>` : ''}</td>
            <td class="num"><input type="number" step="0.5" min="0" data-ovr="${c.coffee_id}:espresso:green_in" value="${c.espresso ? c.espresso.green_in : ''}" placeholder="${d.espresso ? d.espresso.green_in : ''}" style="width:88px;text-align:right"></td>
            <td class="num"><input type="number" step="0.5" min="0" data-ovr="${c.coffee_id}:espresso:roasted_out" value="${c.espresso ? c.espresso.roasted_out : ''}" placeholder="${d.espresso ? d.espresso.roasted_out : ''}" style="width:88px;text-align:right"></td>
            <td class="num"><input type="number" step="0.5" min="0" data-ovr="${c.coffee_id}:filter:green_in" value="${c.filter ? c.filter.green_in : ''}" placeholder="${d.filter ? d.filter.green_in : ''}" style="width:88px;text-align:right"></td>
            <td class="num"><input type="number" step="0.5" min="0" data-ovr="${c.coffee_id}:filter:roasted_out" value="${c.filter ? c.filter.roasted_out : ''}" placeholder="${d.filter ? d.filter.roasted_out : ''}" style="width:88px;text-align:right"></td>
            <td style="font-size:11px;color:var(--drift)">ESP ${lossPct(eff('espresso')) ?? '—'}% · FLT ${lossPct(eff('filter')) ?? '—'}%${(c.espresso || c.filter) ? ' <span style="color:var(--olive)">custom</span>' : ''}</td>
          </tr>`;
        }).join('')}
        </tbody></table></div>` : '<div class="empty">No coffees in the catalog yet.</div>'}
      <div style="display:flex;gap:10px;margin-top:16px;align-items:center">
        <button class="btn" id="rm-save">Save Roast Math</button>
        <span style="font-size:11px;color:var(--drift)">Clearing a coffee's boxes drops its override — it goes back to the roastery default.</span>
      </div>
      <div class="err" id="rm-err"></div>`;

    document.getElementById('rm-save').onclick = async () => {
      const read = id => { const el = document.getElementById(id); return el ? parseFloat(el.value) : NaN; };
      const defaults = {};
      for (const p of ['espresso', 'filter']) defaults[p] = { green_in: read(`def-${p}-in`), roasted_out: read(`def-${p}-out`) };
      // Collect overrides: a profile counts when either box is filled — the
      // missing half inherits the default so half-filled rows still work.
      const byKey = {};
      page.querySelectorAll('[data-ovr]').forEach(inp => {
        const [cid, profile, field] = inp.dataset.ovr.split(':');
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v)) return;
        const k = `${cid}:${profile}`;
        byKey[k] = byKey[k] || { coffee_id: parseInt(cid, 10), profile, green_in: defaults[profile].green_in, roasted_out: defaults[profile].roasted_out };
        byKey[k][field] = v;
      });
      try {
        await api('/api/roast-math', { method: 'PUT', body: JSON.stringify({ defaults, overrides: Object.values(byKey) }) });
        renderRoastMath('✓ Saved — the Roast Program now counts batches with these numbers.');
      } catch (e) { document.getElementById('rm-err').textContent = e.message; }
    };
  }

  // ─── Fulfillment ────────────────────────────────────────────────────────────
  // Customer buckets fill as coffee comes off the roaster: items stay greyed
  // until roasted, get checked off as they're packed, and a fully packed order
  // ships with one click (which emails the shop).
  async function renderFulfill() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Fulfillment', "Customer buckets fill as coffee comes off the roaster — pack what's ready, print the 4×6 slip, then mark shipped.");
    let shops = [], orders = [];
    try { [shops, orders] = await Promise.all([api('/api/shops'), api('/api/orders')]); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }

    let fShop = '', fView = 'topack';
    const wrap = document.createElement('div');
    page.appendChild(wrap);

    const wholesaleQty = i => Number.isInteger(i.lbs / 5) && i.lbs > 0
      ? `${i.lbs / 5} × 5 lb bags <span>(${i.lbs} lbs)</span>` : `${i.lbs} lbs`;
    const qtyHtml = i => isRetail(i.roast) ? `${i.bags} × 12oz bags` : wholesaleQty(i);
    const roastSub = { espresso: 'wholesale · espresso roast', filter: 'wholesale · filter roast', retail: 'retail shelf', retail_espresso: 'retail shelf · espresso roast', retail_filter: 'retail shelf · filter roast' };
    const legacyLines = o => ['espresso_lbs', 'drip_lbs', 'coldbrew_lbs', 'pourover_lbs'].filter(f => o[f] > 0)
      .map(f => `<div class="pick-row" style="cursor:default"><div class="pick-name">${esc(f.replace('_lbs', ''))}</div><div class="pick-qty">${o[f]} lbs</div></div>`).join('');

    function draw() {
      const toPack = orders.filter(o => o.status === 'confirmed');
      const allItems = toPack.flatMap(o => o.items || []);
      const ready = allItems.filter(i => i.roasted && !i.packed);
      const awaiting = allItems.filter(i => !i.roasted);
      const lbsReady = Math.round(ready.reduce((s, i) => s + i.lbs, 0) * 100) / 100;
      const list = orders
        .filter(o => fView === 'shipped' ? o.status === 'shipped' : o.status === 'confirmed')
        .filter(o => !fShop || String(o.shop_id) === fShop)
        .sort((a, b) => String(a.requested_date || a.order_date || '9999').localeCompare(String(b.requested_date || b.order_date || '9999')))
        .slice(0, 60);

      wrap.innerHTML = `
        <div class="summary">
          <div><div class="s-lbl">To Pack</div><div class="s-num">${toPack.length} <span>order${toPack.length === 1 ? '' : 's'}</span></div></div>
          <div><div class="s-lbl">Ready to Pack</div><div class="s-num">${ready.length} <span>items · ${lbsReady} lbs</span></div></div>
          <div><div class="s-lbl">Awaiting Roast</div><div class="s-num">${awaiting.length} <span>items</span></div></div>
          <div class="stat-line">sorted by requested delivery — earliest first</div>
        </div>
        <div class="filters">
          <select id="ff-shop"><option value="">All shops</option>${shops.map(s => `<option value="${s.id}" ${fShop === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
          <select id="ff-view">
            <option value="topack" ${fView === 'topack' ? 'selected' : ''}>To pack (confirmed)</option>
            <option value="shipped" ${fView === 'shipped' ? 'selected' : ''}>Shipped</option>
          </select>
          <span class="ok" id="ff-msg" style="margin:0"></span>
        </div>
        <div class="grid">
          ${list.length ? list.map(o => {
            const items = o.items || [];
            const done = items.filter(i => i.packed).length;
            const complete = items.length > 0 && done === items.length;
            return `<div class="order-card ${complete && o.status === 'confirmed' ? 'complete' : ''}">
              <div class="oc-head">
                <div>
                  <div class="oc-shop">${esc(o.shop_name)}</div>
                  <div class="oc-meta">#${o.id} · placed ${esc(o.order_date)}${o.placed_by ? ` by ${esc(o.placed_by)}` : ''} · ${o.requested_date ? `<b>requested ${esc(o.requested_date)}</b>` : 'requested —'}</div>
                </div>
                <span class="status ${o.status}">${o.status}</span>
              </div>
              <div class="pick">
                ${items.length ? items.map(i => `
                  <label class="pick-row ${i.roasted ? '' : 'await'} ${i.packed ? 'done' : ''}">
                    <input type="checkbox" ${i.packed ? 'checked' : ''} ${!i.roasted || o.status !== 'confirmed' ? 'disabled' : ''} data-pack="${i.id}" data-order="${o.id}">
                    <div class="pick-name"><span class="roast-lbl">${ROAST_TAGS[i.roast] || i.roast}</span>${esc(i.coffee_name)}<small>${roastSub[i.roast] || ''}</small></div>
                    <div class="pick-qty">${qtyHtml(i)}</div>
                    ${i.roasted ? (i.packed ? '' : '<span class="readylbl">ready</span>') : '<span class="awaitlbl">awaiting roast</span>'}
                  </label>`).join('') : legacyLines(o) || '<div class="empty" style="padding:10px 0">No line items</div>'}
              </div>
              ${o.notes ? `<div class="oc-notes">✎ ${esc(o.notes)}</div>` : ''}
              <div class="oc-foot">
                <span class="prog-lbl ${complete ? 'ok' : ''}">${items.length ? (complete ? '✓ all packed' : `${done} / ${items.length} packed`) : 'legacy order'}</span>
                <div class="prog"><div style="width:${items.length ? done / items.length * 100 : 0}%"></div></div>
                <button class="btn-sm" data-slip="${o.id}">Packing Slip</button>
                ${o.status === 'confirmed' ? `<button class="btn" ${complete || !items.length ? '' : 'disabled'} data-ship="${o.id}">Mark Shipped</button>` : ''}
              </div>
            </div>`;
          }).join('') : `<div class="empty" style="grid-column:1/-1">${fView === 'shipped' ? 'Nothing shipped yet.' : 'Nothing to pack — all caught up.'}</div>`}
        </div>`;

      document.getElementById('ff-shop').onchange = e => { fShop = e.target.value; draw(); };
      document.getElementById('ff-view').onchange = e => { fView = e.target.value; draw(); };
      const flash = text => {
        const el = document.getElementById('ff-msg');
        if (el) { el.innerHTML = text; setTimeout(() => { if (el.isConnected) el.innerHTML = ''; }, 8000); }
      };
      wrap.querySelectorAll('[data-pack]').forEach(cb => cb.onchange = async () => {
        cb.disabled = true;
        try {
          const updated = await api(`/api/order-items/${cb.dataset.pack}`, { method: 'PATCH', body: JSON.stringify({ packed: cb.checked }) });
          orders = orders.map(o => o.id === updated.id ? updated : o);
          draw();
        } catch (e) { alert(e.message); draw(); }
      });
      wrap.querySelectorAll('[data-slip]').forEach(btn => btn.onclick = () => {
        openSlip(orders.find(o => String(o.id) === btn.dataset.slip));
      });
      wrap.querySelectorAll('[data-ship]').forEach(btn => btn.onclick = async () => {
        const o = orders.find(x => String(x.id) === btn.dataset.ship);
        const unpacked = (o.items || []).filter(i => !i.packed).length;
        if (unpacked && !window.confirm(`${unpacked} item(s) not checked off as packed — ship anyway?`)) return;
        btn.disabled = true;
        try {
          const updated = await api(`/api/orders/${o.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'shipped' }) });
          orders = orders.map(x => x.id === updated.id ? updated : x);
          draw();
          flash(updated.email
            ? (updated.email.sent ? `✓ Order #${o.id} shipped — email sent to ${esc(updated.email.to)}` : `⚠ Order #${o.id} shipped, but email not sent: ${esc(updated.email.reason)}`)
            : `✓ Order #${o.id} shipped`);
        } catch (e) { alert(e.message); btn.disabled = false; }
      });
    }
    draw();
  }

  // 4×6 packing slip — @media print in index.html prints ONLY this element.
  function openSlip(o) {
    if (!o) return;
    const qty = i => isRetail(i.roast) ? `${i.bags} × 12oz`
      : (Number.isInteger(i.lbs / 5) && i.lbs > 0 ? `${i.lbs / 5} × 5 lb` : `${i.lbs} lbs`);
    const lines = (o.items && o.items.length)
      ? o.items.map(i => `<div class="slip-row"><span><span class="slip-box"></span>${esc(i.coffee_name)}</span><span>${qty(i)}</span></div>`).join('')
      : ['espresso_lbs', 'drip_lbs', 'coldbrew_lbs', 'pourover_lbs'].filter(f => o[f] > 0)
          .map(f => `<div class="slip-row"><span><span class="slip-box"></span>${esc(f.replace('_lbs', ''))}</span><span>${o[f]} lbs</span></div>`).join('');
    document.getElementById('slip').innerHTML = `
      <h2>Packing Slip</h2>
      <div class="slip-sub">Boxx Coffee Roasters Co. · Dose</div>
      <div class="slip-row" style="border-bottom:2px solid #1A1916;font-weight:400">
        <span>${esc(o.shop_name)}</span><span>Order #${o.id}</span>
      </div>
      <div class="slip-row"><span>Placed</span><span>${esc(o.order_date)}${o.placed_by ? ` by ${esc(o.placed_by)}` : ''}</span></div>
      <div class="slip-row"><span>Requested delivery</span><span>${esc(o.requested_date || '—')}</span></div>
      <div style="margin-top:8px">${lines}</div>
      ${o.notes ? `<div class="slip-notes">✎ ${esc(o.notes)}</div>` : ''}
      <div class="slip-foot"><span>Packed: ________</span><span>Checked: ________</span></div>`;
    document.getElementById('slip-bg').style.display = 'flex';
  }
  document.getElementById('slip-bg').addEventListener('click', e => { if (e.target.id === 'slip-bg') e.target.style.display = 'none'; });

  // ─── Reports ────────────────────────────────────────────────────────────────
  async function renderReports() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Reports', 'Roasted coffee per client, rolled up automatically at the close of each week and month.');
    const draw = async (type) => {
      let data;
      try { data = await api(`/api/reports?period_type=${type}`); }
      catch (e) { if (e.message !== 'Unauthorized') document.getElementById('rep-body').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
      CURRENCY = data.currency || CURRENCY;
      const rows = data.rows;
      const el = document.getElementById('rep-body');
      if (!rows.length) { el.innerHTML = `<div class="empty">No closed ${type}s with orders yet — reports appear once a ${type} ends.</div>`; return; }
      const periods = [...new Set(rows.map(r => r.period))];
      el.innerHTML = periods.map(p => {
        const prows = rows.filter(r => r.period === p);
        const totalLbs = Math.round(prows.reduce((s, r) => s + r.lbs, 0) * 100) / 100;
        const totalCost = Math.round(prows.reduce((s, r) => s + (r.cost || 0), 0) * 100) / 100;
        return `<div class="section">
          <div class="section-title"><span>${esc(p)} — ${totalLbs} lbs · ${money(totalCost)}</span></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Client</th><th>Coffee</th><th>Roast</th><th class="num">Lbs</th><th class="num">Value</th></tr></thead>
            <tbody>${prows.map(r => `
              <tr>
                <td style="font-weight:500">${esc(r.shop_name)}</td>
                <td>${esc(r.coffee_name)}</td>
                <td>${r.roast === 'retail' ? '12oz bags (legacy)' : r.roast === 'retail_espresso' ? '12oz · espresso' : r.roast === 'retail_filter' ? '12oz · filter' : esc(r.roast)}</td>
                <td class="num">${r.lbs}</td>
                <td class="num">${money(r.cost)}</td>
              </tr>`).join('')}
            </tbody></table></div>
        </div>`;
      }).join('');
    };
    page.innerHTML += `
      <div class="filters">
        <select id="rep-type"><option value="week">Weekly</option><option value="month">Monthly</option></select>
      </div>
      <div id="rep-body"></div>`;
    document.getElementById('rep-type').onchange = e => draw(e.target.value);
    draw('week');
  }

  // ─── Catalog ────────────────────────────────────────────────────────────────
  async function renderCatalog() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Catalog', 'The coffee list shops order from. Exclusive coffees are only visible to the shops you pick.');
    let items = [], shops = [];
    try { [items, shops] = await Promise.all([api('/api/catalog'), api('/api/shops')]); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }

    const formEl = document.createElement('div');
    formEl.className = 'card';
    page.appendChild(formEl);
    const listEl = document.createElement('div');
    page.appendChild(listEl);

    let editing = null; // item being edited, or null = adding

    function drawForm() {
      const it = editing || { name: '', notes: '', price_per_lb: '', badge: '', low_stock: 0, visibility: 'standard', exclusive_shop_ids: [], active: 1 };
      formEl.innerHTML = `
        <label class="lbl">${editing ? `Edit — ${esc(editing.name)}` : 'Add Coffee'}</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div><label class="lbl">Name</label><input id="c-name" value="${esc(it.name)}" style="min-width:200px"></div>
          <div><label class="lbl">Tasting Notes</label><input id="c-notes" value="${esc(it.notes || '')}" style="min-width:240px" placeholder="chocolate · hazelnut · fig"></div>
          <div><label class="lbl">Base Price / lb</label><input id="c-price" type="number" step="0.01" value="${it.price_per_lb}" style="width:110px"></div>
          <div><label class="lbl">12oz Bag Price</label><input id="c-retail" type="number" step="0.01" value="${it.retail_price ?? ''}" placeholder="not retail" style="width:110px"></div>
          <div><label class="lbl">Badge</label><select id="c-badge">
            <option value="" ${!it.badge ? 'selected' : ''}>None</option>
            ${['Blend', 'Single Origin', 'Single Farm', 'Single Lot', 'Decaf'].map(b =>
              `<option value="${b}" ${it.badge === b ? 'selected' : ''}>${b}</option>`).join('')}
          </select></div>
          <div><label class="lbl">Flags</label><div style="display:flex;gap:12px;padding:8px 0;font-size:11px">
            <label><input type="checkbox" id="c-low" ${it.low_stock ? 'checked' : ''}> Low stock</label>
            <label><input type="checkbox" id="c-active" ${it.active ? 'checked' : ''}> Active</label>
          </div></div>
          <div><label class="lbl">Visibility</label><select id="c-vis">
            <option value="standard" ${it.visibility === 'standard' ? 'selected' : ''}>Standard — all shops</option>
            <option value="exclusive" ${it.visibility === 'exclusive' ? 'selected' : ''}>Exclusive — selected shops</option>
          </select></div>
        </div>
        <div id="c-shops" style="display:${it.visibility === 'exclusive' ? 'flex' : 'none'};gap:14px;flex-wrap:wrap;margin-top:12px;font-size:11px">
          ${shops.map(s => `<label><input type="checkbox" class="c-shop" value="${s.id}" ${it.exclusive_shop_ids.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('') || '<span style="color:var(--drift)">No shops yet — add them in the Shops tab.</span>'}
        </div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn" id="c-save">${editing ? 'Save Changes' : 'Add Coffee'}</button>
          ${editing ? '<button class="btn btn-ghost" id="c-cancel">Cancel</button>' : ''}
        </div>
        <div class="err" id="c-err"></div>`;
      document.getElementById('c-vis').onchange = e => {
        document.getElementById('c-shops').style.display = e.target.value === 'exclusive' ? 'flex' : 'none';
      };
      if (editing) document.getElementById('c-cancel').onclick = () => { editing = null; drawForm(); };
      document.getElementById('c-save').onclick = async () => {
        const body = {
          name: document.getElementById('c-name').value,
          notes: document.getElementById('c-notes').value,
          price_per_lb: document.getElementById('c-price').value,
          retail_price: document.getElementById('c-retail').value,
          badge: document.getElementById('c-badge').value,
          low_stock: document.getElementById('c-low').checked,
          active: document.getElementById('c-active').checked,
          visibility: document.getElementById('c-vis').value,
          exclusive_shop_ids: [...formEl.querySelectorAll('.c-shop:checked')].map(x => parseInt(x.value, 10)),
        };
        try {
          const saved = editing
            ? await api(`/api/catalog/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) })
            : await api('/api/catalog', { method: 'POST', body: JSON.stringify(body) });
          items = editing ? items.map(i => i.id === saved.id ? saved : i) : [...items, saved];
          editing = null;
          drawForm(); drawList();
        } catch (e) { document.getElementById('c-err').textContent = e.message; }
      };
    }

    function drawList() {
      if (!items.length) { listEl.innerHTML = '<div class="empty">No coffees yet — add your first above.</div>'; return; }
      const badge = i => [
        i.badge ? `<span class="badge seasonal">${esc(i.badge)}</span>` : '',
        i.low_stock ? '<span class="badge low">Low stock</span>' : '',
        !i.active ? '<span class="badge">Archived</span>' : '',
      ].join('');
      listEl.innerHTML = `<div class="table-wrap" style="margin-top:14px"><table>
        <thead><tr><th>Coffee</th><th class="num">Base / lb</th><th class="num">12oz Bag</th><th>Visibility</th><th></th></tr></thead>
        <tbody>${items.map(i => `
          <tr style="${i.active ? '' : 'opacity:.55'}">
            <td><span style="font-family:var(--serif);font-size:13px;color:var(--ink)">${esc(i.name)}</span>${badge(i)}
              <div style="font-size:10px;color:var(--drift)">${esc(i.notes || '')}</div></td>
            <td class="num">${money(i.price_per_lb)}</td>
            <td class="num">${i.retail_price != null ? money(i.retail_price) : '—'}</td>
            <td style="font-size:11px;color:var(--drift)">${i.visibility === 'exclusive'
              ? `Exclusive: ${i.exclusive_shop_ids.map(id => esc((shops.find(s => s.id === id) || {}).name || '?')).join(', ') || 'nobody yet'}`
              : 'All shops'}</td>
            <td><button class="btn-sm btn" data-edit="${i.id}">Edit</button></td>
          </tr>`).join('')}
        </tbody></table></div>`;
      listEl.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => {
        editing = items.find(i => String(i.id) === btn.dataset.edit);
        drawForm();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    drawForm(); drawList();
  }

  // ─── Shops ──────────────────────────────────────────────────────────────────
  async function renderShops() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Shops', 'Client shops connected to the hub — each authenticates with its own API key. Receipts and confirmations go to the registered email.');
    let shops = [];
    try { shops = await api('/api/shops'); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }

    page.innerHTML += `
      <div class="card">
        <label class="lbl">Add Shop</label>
        <div style="font-size:11px;color:var(--drift);margin-bottom:10px">
          Creating a shop creates its account and API key, and emails the shop an invite to set its own password
          (username is generated from the name). No passwords pass through you.
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <input id="new-shop" placeholder="Shop name, e.g. Boxx Kadıköy" style="min-width:190px">
          <input id="new-email" placeholder="Registered email (invite + receipts)" style="min-width:240px">
          <button class="btn" id="add-shop">Create Shop & Send Invite</button>
        </div>
        <div id="add-result"></div>
      </div>
      <div id="shop-list"></div>
      <div id="pricing-panel"></div>`;

    function drawList() {
      document.getElementById('shop-list').innerHTML = shops.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Shop</th><th>Login</th><th>Email</th><th>Orders</th><th>Last order</th><th></th></tr></thead>
        <tbody>${shops.map(s => `<tr>
          <td style="font-weight:500">${esc(s.name)}</td>
          <td style="color:var(--drift)">${esc(s.login_username || '—')}${s.has_password ? '' : (s.invite_pending ? ' <span class="badge seasonal">Invite pending</span>' : ' <span class="badge low">No login yet</span>')}</td>
          <td style="color:var(--drift)">${esc(s.email || '— none —')}</td>
          <td>${s.orders_count}</td>
          <td>${esc(s.last_order_date || '—')}</td>
          <td><div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn-sm btn" data-pricing="${s.id}">Pricing</button>
            <button class="btn-sm btn" data-editshop="${s.id}">Edit</button>
            <button class="btn-sm btn" data-invite="${s.id}">${s.has_password ? 'Send Password Reset' : 'Send Invite'}</button>
            <button class="btn-sm btn" data-rotate="${s.id}">Rotate Key</button>
          </div></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No shops yet.</div>';
      wireList();
    }

    const showKey = (name, key) => {
      document.getElementById('add-result').innerHTML = `
        <div class="keybox">
          <strong>${esc(name)}</strong> — API key (shown once, copy it now):<br>
          <code>${esc(key)}</code>
          <button class="btn-sm btn" id="copy-key" style="margin-left:8px">Copy</button><br>
          Paste it into that shop's Dose app → Settings → Ordering → Hub API Key, along with this hub's URL.
        </div>`;
      document.getElementById('copy-key').onclick = () =>
        navigator.clipboard.writeText(key).then(() => { document.getElementById('copy-key').textContent = 'Copied ✓'; });
    };

    const inviteHtml = (shop, invite) => invite.sent
      ? `<div class="ok">✉ Invite emailed to ${esc(invite.to)} — ${esc(shop.name)} signs in as <strong>${esc(shop.login_username)}</strong> once they set their password.</div>`
      : `<div class="keybox">✉ Invite email not sent (${esc(invite.reason)}). Send this link to the shop yourself — it lets them set their password (valid 7 days):<br>
          <code>${esc(invite.link)}</code>
          <button class="btn-sm btn" data-copylink="${esc(invite.link)}" style="margin-left:8px">Copy</button></div>`;

    const wireCopy = () => document.querySelectorAll('[data-copylink]').forEach(b => b.onclick = () =>
      navigator.clipboard.writeText(b.dataset.copylink).then(() => { b.textContent = 'Copied ✓'; }));

    document.getElementById('add-shop').onclick = async () => {
      const name = document.getElementById('new-shop').value.trim();
      const email = document.getElementById('new-email').value.trim();
      if (!name) return;
      try {
        const data = await api('/api/shops', { method: 'POST', body: JSON.stringify({ name, email }) });
        shops = [...shops, data.shop].sort((a, b) => a.name.localeCompare(b.name));
        showKey(data.shop.name, data.api_key);
        document.getElementById('add-result').insertAdjacentHTML('beforeend', inviteHtml(data.shop, data.invite));
        wireCopy();
        document.getElementById('new-shop').value = ''; document.getElementById('new-email').value = '';
        drawList();
      } catch (e) { document.getElementById('add-result').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };

    function wireList() {
      document.querySelectorAll('[data-rotate]').forEach(btn => btn.onclick = async () => {
        if (!window.confirm('Rotate this shop’s API key? The old key stops working immediately.')) return;
        try {
          const shop = shops.find(s => String(s.id) === btn.dataset.rotate);
          const data = await api(`/api/shops/${btn.dataset.rotate}/rotate-key`, { method: 'POST' });
          showKey(shop ? shop.name : 'Shop', data.api_key);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-editshop]').forEach(btn => btn.onclick = async () => {
        const shop = shops.find(s => String(s.id) === btn.dataset.editshop);
        const name = window.prompt('Shop name:', shop.name);
        if (name === null) return;
        const email = window.prompt('Registered email (receipts + confirmations):', shop.email || '');
        if (email === null) return;
        try {
          const updated = await api(`/api/shops/${shop.id}`, { method: 'PUT', body: JSON.stringify({ name, email }) });
          shops = shops.map(s => s.id === updated.id ? updated : s);
          drawList();
        } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-invite]').forEach(btn => btn.onclick = async () => {
        const shop = shops.find(s => String(s.id) === btn.dataset.invite);
        try {
          const data = await api(`/api/shops/${shop.id}/invite`, { method: 'POST' });
          document.getElementById('add-result').innerHTML = inviteHtml(shop, data.invite);
          wireCopy();
          if (!shop.has_password) { shops = shops.map(s => s.id === shop.id ? { ...s, invite_pending: true } : s); drawList(); }
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-pricing]').forEach(btn => btn.onclick = () => openPricing(btn.dataset.pricing));
    }

    async function openPricing(shopId) {
      const shop = shops.find(s => String(s.id) === shopId);
      const panel = document.getElementById('pricing-panel');
      let data;
      try { data = await api(`/api/shops/${shopId}/pricing`); }
      catch (e) { panel.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }

      const ruleSelect = (id, rule) => `
        <select id="${id}-type">
          <option value="" ${!rule ? 'selected' : ''}>Base price</option>
          <option value="amount_off" ${rule?.rule_type === 'amount_off' ? 'selected' : ''}>Amount off /lb</option>
          <option value="percent_off" ${rule?.rule_type === 'percent_off' ? 'selected' : ''}>% off</option>
          <option value="override" ${rule?.rule_type === 'override' ? 'selected' : ''}>Set price</option>
        </select>
        <input id="${id}-val" type="number" step="0.01" style="width:80px" value="${rule ? rule.value : ''}" placeholder="0">`;

      panel.innerHTML = `
        <div class="card" style="margin-top:20px">
          <label class="lbl">Pricing — ${esc(shop.name)}</label>
          <div style="font-size:11px;color:var(--drift);margin-bottom:12px">
            The shop only ever sees its final price. Item rules beat the catalog-wide rule. Prices already on past orders never change.
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;font-size:12px">
            <span style="min-width:180px">Catalog-wide rule</span>${ruleSelect('g', data.global_rule)}
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Coffee</th><th class="num">Base</th><th>Rule</th><th class="num">Their price</th></tr></thead>
            <tbody>${data.items.map(i => `
              <tr>
                <td>${esc(i.name)}</td>
                <td class="num">${money(i.base_price)}</td>
                <td>${ruleSelect(`r${i.coffee_id}`, i.rule)}</td>
                <td class="num" id="eff-${i.coffee_id}">${money(i.effective_price)}</td>
              </tr>`).join('')}
            </tbody></table></div>
          <div style="display:flex;gap:10px;margin-top:14px;align-items:center">
            <button class="btn" id="save-pricing">Save Pricing</button>
            <button class="btn btn-ghost" id="close-pricing">Close</button>
            <span class="ok" id="pricing-msg" style="margin:0"></span>
          </div>
        </div>`;
      panel.scrollIntoView({ behavior: 'smooth' });

      document.getElementById('close-pricing').onclick = () => { panel.innerHTML = ''; };
      document.getElementById('save-pricing').onclick = async () => {
        const read = id => {
          const t = document.getElementById(`${id}-type`).value;
          const v = parseFloat(document.getElementById(`${id}-val`).value);
          return t && Number.isFinite(v) ? { rule_type: t, value: v } : null;
        };
        const body = {
          global_rule: read('g'),
          item_rules: data.items.map(i => {
            const r = read(`r${i.coffee_id}`);
            return r ? { coffee_id: i.coffee_id, ...r } : null;
          }).filter(Boolean),
        };
        try {
          await api(`/api/shops/${shopId}/pricing`, { method: 'PUT', body: JSON.stringify(body) });
          document.getElementById('pricing-msg').textContent = '✓ Saved';
          openPricing(shopId); // re-render with server-computed effective prices
        } catch (e) { alert(e.message); }
      };
    }

    drawList();
  }

  // ─── Patterns ───────────────────────────────────────────────────────────────
  // The tile grid is the overview; clicking a shop opens its full account
  // breakdown without leaving the tab.
  async function renderPatterns() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Patterns', 'Ordering volume, spend, roast mix, and cadence per shop — click a shop for the full picture.');
    let data;
    try { data = await api('/api/analytics'); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }
    CURRENCY = data.currency || CURRENCY;
    const list = data.shops || [];
    if (!list.length) { page.innerHTML += '<div class="empty">No shops yet.</div>'; return; }

    page.innerHTML += `<div class="stat-grid">${list.map(s => {
      const maxWeek = Math.max(1, ...s.weekly.map(w => w.lbs));
      const mixTotal = Math.max(0.001, s.roast_mix.espresso + s.roast_mix.filter);
      return `<div class="card shoptile" data-shop="${s.shop_id}">
        <div class="stat-name">${esc(s.shop_name)}</div>
        <div class="stat-line">${s.orders_count} orders · ${s.total_lbs} lbs${s.total_cost ? ` · ${money(s.total_cost)}` : ''}</div>
        <div class="stat-line">${s.avg_interval_days != null ? `orders every ~${s.avg_interval_days} days` : 'not enough orders for cadence yet'}</div>
        <div class="stat-line">last order: ${esc(s.last_order || '—')}</div>
        <div class="pool-mix">
          ${s.roast_mix.espresso > 0 ? `<div style="width:${(s.roast_mix.espresso / mixTotal * 100).toFixed(1)}%;background:#6B6E4A" title="Espresso roast: ${s.roast_mix.espresso} lbs"></div>` : ''}
          ${s.roast_mix.filter > 0 ? `<div style="width:${(s.roast_mix.filter / mixTotal * 100).toFixed(1)}%;background:#C4833A" title="Filter roast: ${s.roast_mix.filter} lbs"></div>` : ''}
        </div>
        <div class="legend">
          <span><span class="dot" style="background:#6B6E4A"></span>Espresso ${s.roast_mix.espresso} lbs</span>
          <span><span class="dot" style="background:#C4833A"></span>Filter ${s.roast_mix.filter} lbs</span>
        </div>
        ${s.weekly.length ? `<div class="bars" title="Weekly lbs, last 12 weeks">${s.weekly.map(w =>
          `<div style="height:${Math.max(4, w.lbs / maxWeek * 100)}%" title="week ${esc(w.week)}: ${Math.round(w.lbs * 10) / 10} lbs"></div>`).join('')}</div>` : ''}
        <div class="more">View account →</div>
      </div>`;
    }).join('')}</div>`;
    page.querySelectorAll('[data-shop]').forEach(el => el.onclick = () => renderShopDetail(el.dataset.shop));
  }

  async function renderShopDetail(shopId) {
    const page = document.getElementById('page');
    let s;
    try { s = await api(`/api/analytics/shop/${shopId}`); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    CURRENCY = s.currency || CURRENCY;
    const mixTotal = Math.max(0.001, s.roast_mix.espresso + s.roast_mix.filter);
    const maxWeek = Math.max(1, ...s.weekly.map(w => w.lbs));
    const maxCoffee = Math.max(1, ...s.coffees.map(c => c.lbs));
    page.innerHTML = `
      <span class="backlink" id="pat-back">← All shops</span>
      ${header('Account', esc(s.shop.name), 'Everything this account has ordered, and how they order it.')}
      <div class="detail-stats">
        <div class="detail-stat"><div class="s-lbl">Orders</div><div class="v">${s.orders_count}</div></div>
        <div class="detail-stat"><div class="s-lbl">Total Coffee</div><div class="v">${s.total_lbs} <span style="font-size:13px;color:var(--drift)">lbs</span></div></div>
        <div class="detail-stat"><div class="s-lbl">Lifetime Spend</div><div class="v">${money(s.total_cost)}</div></div>
        <div class="detail-stat"><div class="s-lbl">Cadence</div><div class="v">${s.avg_interval_days != null ? `~${s.avg_interval_days}` : '—'} <span style="font-size:13px;color:var(--drift)">days</span></div></div>
        <div class="detail-stat"><div class="s-lbl">Last Order</div><div class="v" style="font-size:17px">${esc(s.last_order || '—')}</div></div>
      </div>
      <div class="two-col">
        <div>
          <div class="sechead" style="margin-top:0"><span>Volume · last 12 weeks</span></div>
          <div class="card" style="margin:0 0 16px">
            ${s.weekly.length ? `<div class="bars" style="height:110px">${s.weekly.map(w =>
              `<div style="height:${Math.max(3, w.lbs / maxWeek * 100)}%" title="week ${esc(w.week)}: ${Math.round(w.lbs * 10) / 10} lbs"></div>`).join('')}</div>
            <div class="stat-line" style="margin-top:6px">peak ${Math.round(maxWeek * 10) / 10} lbs · avg ${Math.round(s.weekly.reduce((a, w) => a + w.lbs, 0) / s.weekly.length * 10) / 10} lbs/week</div>`
            : '<div class="empty" style="padding:20px 0">No orders in the last 12 weeks.</div>'}
          </div>
          <div class="sechead"><span>Roast Mix</span></div>
          <div class="card" style="margin:0">
            <div class="pool-mix" style="height:14px">
              ${s.roast_mix.espresso > 0 ? `<div style="width:${(s.roast_mix.espresso / mixTotal * 100).toFixed(1)}%;background:#6B6E4A"></div>` : ''}
              ${s.roast_mix.filter > 0 ? `<div style="width:${(s.roast_mix.filter / mixTotal * 100).toFixed(1)}%;background:#C4833A"></div>` : ''}
            </div>
            <div class="legend" style="margin-top:8px">
              <span><span class="dot" style="background:#6B6E4A"></span>Espresso ${s.roast_mix.espresso} lbs (${Math.round(s.roast_mix.espresso / mixTotal * 100)}%)</span>
              <span><span class="dot" style="background:#C4833A"></span>Filter ${s.roast_mix.filter} lbs (${Math.round(s.roast_mix.filter / mixTotal * 100)}%)</span>
            </div>
            <div class="stat-line" style="margin-top:6px">retail bags counted with their roast profile</div>
          </div>
        </div>
        <div>
          <div class="sechead" style="margin-top:0"><span>Coffees they buy</span></div>
          ${s.coffees.length ? `<div class="table-wrap" style="margin-bottom:16px"><table>
            <thead><tr><th>Coffee</th><th class="num">Lbs</th><th class="num">Value</th><th style="width:34%">Share</th></tr></thead>
            <tbody>${s.coffees.map(c => `
              <tr>
                <td>${esc(c.coffee_name)}</td><td class="num">${c.lbs}</td><td class="num">${money(c.cost)}</td>
                <td><div style="height:8px;background:var(--stone);border:1px solid var(--linen)"><div style="height:100%;width:${(c.lbs / maxCoffee * 100).toFixed(1)}%;background:var(--olive)"></div></div></td>
              </tr>`).join('')}</tbody>
          </table></div>` : '<div class="empty">No line-item orders yet.</div>'}
          <div class="sechead"><span>Recent orders</span></div>
          ${s.recent.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Date</th><th class="num">Lbs</th><th class="num">Total</th><th>By</th><th>Status</th></tr></thead>
            <tbody>${s.recent.map(o => `
              <tr>
                <td>${esc(o.order_date)}${o.requested_date ? `<div style="font-size:10px;color:var(--drift)">for ${esc(o.requested_date)}</div>` : ''}</td>
                <td class="num">${o.total_lbs || '—'}</td>
                <td class="num">${money(o.total_cost)}</td>
                <td style="color:var(--drift)">${esc(o.placed_by || '—')}</td>
                <td><span class="status ${o.status}">${o.status}</span></td>
              </tr>`).join('')}</tbody>
          </table></div>` : '<div class="empty">No orders yet.</div>'}
        </div>
      </div>`;
    document.getElementById('pat-back').onclick = renderPatterns;
  }

  // ─── Public set-password page (invite links land here) ─────────────────────
  async function renderSetPassword(token) {
    const shell = (inner) => {
      app.innerHTML = `<div class="login-wrap"><div class="login-card">
        <div class="login-title">Dose</div>
        <div class="login-sub">Boxx Coffee Roasters Co.</div>
        ${inner}
      </div></div>`;
    };
    let info;
    try {
      info = await api('/api/public/invite-info', { method: 'POST', body: JSON.stringify({ token }) });
    } catch (e) {
      shell(`<div class="err" style="margin:0">${esc(e.message)}</div>`);
      return;
    }
    shell(`
      <p style="font-size:12px;color:var(--graphite);line-height:1.7;margin-bottom:14px">
        Welcome, <strong>${esc(info.shop_name)}</strong> — choose the password your shop will sign in with.
        Your username is <strong>${esc(info.login_username)}</strong>.
      </p>
      <form id="sp-form">
        <label class="lbl" for="sp-pw">Password (min 8 characters)</label>
        <input type="password" id="sp-pw" style="width:100%" autocomplete="new-password" autofocus>
        <label class="lbl" for="sp-pw2" style="margin-top:10px">Repeat Password</label>
        <input type="password" id="sp-pw2" style="width:100%" autocomplete="new-password">
        <div class="err" id="sp-err"></div>
        <button class="btn" type="submit" style="margin-top:14px;width:100%">Set Password</button>
      </form>`);
    document.getElementById('sp-form').onsubmit = async e => {
      e.preventDefault();
      const pw = document.getElementById('sp-pw').value;
      if (pw !== document.getElementById('sp-pw2').value) {
        document.getElementById('sp-err').textContent = 'Passwords do not match';
        return;
      }
      try {
        const done = await api('/api/public/set-password', { method: 'POST', body: JSON.stringify({ token, password: pw }) });
        shell(`<div class="ok" style="margin:0;line-height:1.8">
          ✓ Password set. Sign in to your shop's Dose app as <strong>${esc(done.login_username)}</strong> with your new password.
          You can close this page.</div>`);
      } catch (err) {
        document.getElementById('sp-err').textContent = err.message;
      }
    };
  }

  // ─── Boot ───────────────────────────────────────────────────────────────────
  if (window.location.pathname === '/set-password') {
    renderSetPassword(new URLSearchParams(window.location.search).get('token') || '');
  } else if (getToken()) {
    api('/api/shops').then(() => renderShell('orders')).catch(() => {});
  } else {
    renderLogin();
  }
})();
