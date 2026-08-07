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
  const TABS = [['orders', 'Orders'], ['roast', 'Roast'], ['fulfill', 'Fulfillment'], ['catalog', 'Catalog'], ['shops', 'Shops'], ['patterns', 'Patterns'], ['reports', 'Reports']];
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
    ({ orders: renderOrders, roast: renderRoast, fulfill: renderFulfill, catalog: renderCatalog, shops: renderShops, patterns: renderPatterns, reports: renderReports })[active]();
  }

  const header = (eyebrow, title, sub) =>
    `<div class="eyebrow">${eyebrow}</div><h1 class="title">${title}</h1><p class="sub">${sub}</p><hr class="rule">`;

  const roastTag = r => `<span class="roast-lbl">${r === 'espresso' ? 'ESP' : r === 'retail' ? 'RTL' : 'FLT'}</span>`;
  const qtyText = i => i.roast === 'retail' ? `${i.bags} × 12oz` : `${i.lbs} lbs`;

  // ─── Orders inbox ───────────────────────────────────────────────────────────
  async function renderOrders() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Orders', 'Incoming orders from client shops — confirming an order emails the shop.');
    let shops = [], orders = [];
    try { [shops, orders] = await Promise.all([api('/api/shops'), api('/api/orders')]); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }

    const filters = document.createElement('div');
    filters.className = 'filters';
    filters.innerHTML = `
      <select id="f-shop"><option value="">All shops</option>${shops.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <select id="f-status"><option value="">All statuses</option><option value="new">New</option><option value="confirmed">Confirmed</option><option value="shipped">Shipped</option><option value="delivered">Delivered</option></select>
      <span style="font-size:10px;color:var(--drift)" id="new-count"></span>
      <span class="ok" id="action-msg" style="margin:0"></span>`;
    page.appendChild(filters);
    const listEl = document.createElement('div');
    page.appendChild(listEl);

    let editing = null; // order id being edited

    const itemsHtml = o => o.items && o.items.length
      ? o.items.map(i => `<div style="white-space:nowrap">${roastTag(i.roast)} ${esc(i.coffee_name)} · ${qtyText(i)} · ${money(i.line_total)}</div>`).join('')
      : ['espresso_lbs', 'drip_lbs', 'coldbrew_lbs', 'pourover_lbs'].filter(f => o[f] > 0)
          .map(f => `<div>${esc(f.replace('_lbs', ''))}: ${o[f]} lbs</div>`).join('') || '—';

    const itemsEditHtml = o => o.items.map(i => `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;white-space:nowrap">
        ${roastTag(i.roast)} ${esc(i.coffee_name)}
        <input type="number" min="0" step="${i.roast === 'retail' ? 1 : 0.5}" value="${i.roast === 'retail' ? i.bags : i.lbs}"
          data-edit-item="${i.id}" style="width:70px;text-align:right">
        <span style="color:var(--drift);font-size:9px">${i.roast === 'retail' ? 'bags' : 'lbs'}</span>
      </div>`).join('');

    const nextAction = o =>
      o.status === 'new' ? `<button class="btn-sm btn" data-adv="${o.id}" data-to="confirmed">Confirm</button>`
      : o.status === 'confirmed' ? `<button class="btn-sm btn" data-adv="${o.id}" data-to="shipped">Mark Shipped</button>`
      : o.status === 'shipped' ? `<button class="btn-sm btn" data-adv="${o.id}" data-to="delivered">Mark Delivered</button>` : '';

    function draw() {
      const fs = document.getElementById('f-shop').value;
      const fst = document.getElementById('f-status').value;
      document.getElementById('new-count').textContent = `${orders.filter(o => o.status === 'new').length} new`;
      const rows = orders.filter(o => (!fs || String(o.shop_id) === fs) && (!fst || o.status === fst));
      if (!rows.length) { listEl.innerHTML = `<div class="empty">No orders${shops.length ? '' : ' — add a shop first (Shops tab)'}.</div>`; return; }
      listEl.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Received</th><th>Shop</th><th>Requested</th><th>Items</th><th class="num">Lbs</th><th class="num">Total</th><th>By</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(o => `
          <tr>
            <td>${esc((o.received_at || '').slice(0, 16))}</td>
            <td style="font-weight:500">${esc(o.shop_name)}</td>
            <td>${esc(o.requested_date || o.order_date)}</td>
            <td style="line-height:1.9;font-size:10px">
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
                   ${['new', 'confirmed'].includes(o.status) && o.items && o.items.length ? `<button class="btn-sm btn" data-start-edit="${o.id}">Edit</button>` : ''}`}
            </div></td>
          </tr>`).join('')}
        </tbody></table></div>`;

      const flash = (text) => {
        const msgEl = document.getElementById('action-msg');
        msgEl.textContent = text;
        setTimeout(() => { msgEl.textContent = ''; }, 7000);
      };
      listEl.querySelectorAll('[data-adv]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try {
          const updated = await api(`/api/orders/${btn.dataset.adv}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.to }) });
          orders = orders.map(o => o.id === updated.id ? updated : o);
          if (updated.email) flash(updated.email.sent ? `✓ ${updated.status === 'shipped' ? 'Shipped' : 'Confirmation'} email sent to ${updated.email.to}` : `⚠ Status updated, but email not sent: ${updated.email.reason}`);
          draw();
        } catch (e) { alert(e.message); }
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
          flash(updated.email?.sent ? `✓ Order updated — notification emailed to ${updated.email.to}` : `⚠ Order updated, but email not sent: ${updated.email?.reason}`);
          draw();
        } catch (e) { alert(e.message); }
      });
    }
    document.getElementById('f-shop').onchange = draw;
    document.getElementById('f-status').onchange = draw;
    draw();
  }

  // ─── Roast Program ──────────────────────────────────────────────────────────
  async function renderRoast(flashMsg) {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Roast Program', 'Everything confirmed and not yet roasted, aggregated per coffee — retail included, everything roasts together. Marking a coffee roasted moves it into the Fulfillment buckets.');
    let data;
    try { data = await api('/api/roast-program'); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }
    if (flashMsg) page.innerHTML += `<div class="ok" style="margin-bottom:14px">${flashMsg}</div>`;
    if (!data.batches.length) {
      page.innerHTML += '<div class="empty">Nothing left to roast — roasted orders are waiting in <span class="nav-link" data-goto="fulfill" style="text-decoration:underline;cursor:pointer">Fulfillment</span>, new ones in Orders.</div>';
      page.querySelectorAll('[data-goto]').forEach(el => el.onclick = () => renderShell(el.dataset.goto));
      return;
    }
    const breakdown = b => [
      b.espresso_lbs > 0 ? `Espresso ${b.espresso_lbs} lbs` : null,
      b.filter_lbs > 0 ? `Filter ${b.filter_lbs} lbs` : null,
      b.retail_lbs > 0 ? `Retail ${b.retail_lbs} lbs (${b.retail_bags} × 12oz)` : null,
    ].filter(Boolean).join(' · ');
    page.innerHTML += `
      <div class="card" style="display:flex;gap:36px;flex-wrap:wrap;align-items:baseline">
        <div><div class="lbl">Still to roast</div><div style="font-family:var(--serif);font-size:34px">${data.total_lbs} lbs</div></div>
        <div class="stat-line">${data.batches.length} coffee${data.batches.length === 1 ? '' : 's'} across ${[...new Set(data.batches.flatMap(b => b.shops))].length} shop(s) — roasted coffee flows into the Fulfillment buckets automatically</div>
        ${data.legacy_orders_excluded ? `<div class="stat-line" style="color:var(--warn)">${data.legacy_orders_excluded} legacy pool order(s) not included — handle manually from Orders</div>` : ''}
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Coffee</th><th class="num">To Roast</th><th>Breakdown (for fulfillment)</th><th class="num">Orders</th><th>For Shops</th><th></th></tr></thead>
        <tbody>${data.batches.map((b, idx) => `
          <tr>
            <td style="font-family:var(--serif);font-size:13px;color:var(--ink)">${esc(b.coffee_name)}</td>
            <td class="num" style="font-weight:500;color:var(--ink);font-size:13px">${b.lbs} lbs</td>
            <td style="color:var(--drift);font-size:10px">${breakdown(b)}</td>
            <td class="num">${b.orders_count}</td>
            <td style="color:var(--drift);font-size:10px">${b.shops.map(esc).join(', ')}</td>
            <td class="num"><button class="btn" data-roasted="${idx}">Mark Roasted</button></td>
          </tr>`).join('')}
        </tbody></table></div>`;
    page.querySelectorAll('[data-roasted]').forEach(btn => btn.onclick = async () => {
      const b = data.batches[parseInt(btn.dataset.roasted, 10)];
      btn.disabled = true;
      try {
        const r = await api('/api/roast-program/mark-roasted', { method: 'POST', body: JSON.stringify({ coffee_name: b.coffee_name }) });
        const mails = (r.roasted_emails || []).map(m =>
          m.sent ? `✉ “Roasted” email sent to ${esc(m.shop_name)}` : `⚠ ${esc(m.shop_name)} fully roasted, but email not sent: ${esc(m.reason)}`);
        renderRoast([`☕ ${esc(b.coffee_name)} roasted — moved to the fulfillment buckets of ${r.shops.map(esc).join(', ')}.`, ...mails].join('<br>'));
      } catch (e) { alert(e.message); btn.disabled = false; }
    });
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
    const qtyHtml = i => i.roast === 'retail' ? `${i.bags} × 12oz bags` : wholesaleQty(i);
    const roastSub = { espresso: 'wholesale · espresso roast', filter: 'wholesale · filter roast', retail: 'retail shelf' };
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
                    <div class="pick-name"><span class="roast-lbl">${i.roast === 'espresso' ? 'ESP' : i.roast === 'retail' ? 'RTL' : 'FLT'}</span>${esc(i.coffee_name)}<small>${roastSub[i.roast] || ''}</small></div>
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
    const qty = i => i.roast === 'retail' ? `${i.bags} × 12oz`
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
                <td>${r.roast === 'retail' ? '12oz bags' : esc(r.roast)}</td>
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
          <div><label class="lbl">Flags</label><div style="display:flex;gap:12px;padding:8px 0;font-size:10px">
            <label><input type="checkbox" id="c-low" ${it.low_stock ? 'checked' : ''}> Low stock</label>
            <label><input type="checkbox" id="c-active" ${it.active ? 'checked' : ''}> Active</label>
          </div></div>
          <div><label class="lbl">Visibility</label><select id="c-vis">
            <option value="standard" ${it.visibility === 'standard' ? 'selected' : ''}>Standard — all shops</option>
            <option value="exclusive" ${it.visibility === 'exclusive' ? 'selected' : ''}>Exclusive — selected shops</option>
          </select></div>
        </div>
        <div id="c-shops" style="display:${it.visibility === 'exclusive' ? 'flex' : 'none'};gap:14px;flex-wrap:wrap;margin-top:12px;font-size:10px">
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
              <div style="font-size:9px;color:var(--drift)">${esc(i.notes || '')}</div></td>
            <td class="num">${money(i.price_per_lb)}</td>
            <td class="num">${i.retail_price != null ? money(i.retail_price) : '—'}</td>
            <td style="font-size:10px;color:var(--drift)">${i.visibility === 'exclusive'
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
        <div style="font-size:10px;color:var(--drift);margin-bottom:10px">
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
          <div style="font-size:10px;color:var(--drift);margin-bottom:12px">
            The shop only ever sees its final price. Item rules beat the catalog-wide rule. Prices already on past orders never change.
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;font-size:11px">
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
  async function renderPatterns() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Patterns', 'Ordering volume, spend, roast mix, and cadence per shop.');
    let data;
    try { data = await api('/api/analytics'); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }
    CURRENCY = data.currency || CURRENCY;
    const list = data.shops || [];
    if (!list.length) { page.innerHTML += '<div class="empty">No shops yet.</div>'; return; }

    page.innerHTML += `<div class="stat-grid">${list.map(s => {
      const maxWeek = Math.max(1, ...s.weekly.map(w => w.lbs));
      const mixTotal = Math.max(0.001, s.roast_mix.espresso + s.roast_mix.filter);
      return `<div class="card">
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
        ${s.top_coffees.length ? `<div class="stat-line" style="margin-top:10px">${s.top_coffees.map((t, i) => `${i + 1}. ${esc(t.name)} (${t.lbs} lbs)`).join('<br>')}</div>` : ''}
        ${s.weekly.length ? `<div class="bars" title="Weekly lbs, last 12 weeks">${s.weekly.map(w =>
          `<div style="height:${Math.max(4, w.lbs / maxWeek * 100)}%" title="week ${esc(w.week)}: ${Math.round(w.lbs * 10) / 10} lbs"></div>`).join('')}</div>
        <div class="stat-line" style="margin-top:4px">weekly lbs · last 12 weeks</div>` : ''}
      </div>`;
    }).join('')}</div>`;
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
      <p style="font-size:11px;color:var(--graphite);line-height:1.7;margin-bottom:14px">
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
