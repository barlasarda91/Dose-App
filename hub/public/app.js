/* Dose Hub dashboard — vanilla JS, no build step. */
(() => {
  const POOLS = [
    ['espresso_lbs', 'Espresso', '#6B6E4A'],
    ['drip_lbs', 'Drip', '#7A7268'],
    ['coldbrew_lbs', 'Cold Brew', '#C4833A'],
    ['pourover_lbs', 'Pour-Over', '#3D3A34'],
  ];
  const app = document.getElementById('app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getToken = () => localStorage.getItem('hub_key') || '';

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
  const TABS = [['orders', 'Orders'], ['shops', 'Shops'], ['patterns', 'Patterns']];
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
    ({ orders: renderOrders, shops: renderShops, patterns: renderPatterns })[active]();
  }

  function header(eyebrow, title, sub) {
    return `<div class="eyebrow">${eyebrow}</div><h1 class="title">${title}</h1><p class="sub">${sub}</p><hr class="rule">`;
  }

  // ─── Orders inbox ───────────────────────────────────────────────────────────
  async function renderOrders() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Orders', 'Incoming orders from client shops — confirm and mark delivered as you work through them.');
    let shops = [], orders = [];
    try { [shops, orders] = await Promise.all([api('/api/shops'), api('/api/orders')]); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }

    const filters = document.createElement('div');
    filters.className = 'filters';
    filters.innerHTML = `
      <select id="f-shop"><option value="">All shops</option>${shops.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <select id="f-status"><option value="">All statuses</option><option value="new">New</option><option value="confirmed">Confirmed</option><option value="delivered">Delivered</option></select>
      <span style="font-size:10px;color:var(--drift)">${orders.filter(o => o.status === 'new').length} new</span>`;
    page.appendChild(filters);

    const listEl = document.createElement('div');
    page.appendChild(listEl);

    function draw() {
      const fs = document.getElementById('f-shop').value;
      const fst = document.getElementById('f-status').value;
      const rows = orders.filter(o => (!fs || String(o.shop_id) === fs) && (!fst || o.status === fst));
      if (!rows.length) { listEl.innerHTML = `<div class="empty">No orders${shops.length ? '' : ' — add a shop first (Shops tab) and connect it in the shop’s Settings'}.</div>`; return; }
      listEl.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Received</th><th>Shop</th><th>For date</th>${POOLS.map(p => `<th>${p[1]}</th>`).join('')}<th>Notes</th><th>By</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(o => `
          <tr>
            <td>${esc((o.received_at || '').slice(0, 16))}</td>
            <td style="font-weight:500">${esc(o.shop_name)}</td>
            <td>${esc(o.order_date)}</td>
            ${POOLS.map(([f]) => `<td>${o[f] > 0 ? o[f] + ' lbs' : '—'}</td>`).join('')}
            <td style="color:var(--drift)">${esc(o.notes || '—')}</td>
            <td style="color:var(--drift)">${esc(o.placed_by || '—')}</td>
            <td><span class="status ${o.status}">${o.status}</span></td>
            <td>${o.status === 'new' ? `<button class="btn-sm btn" data-adv="${o.id}" data-to="confirmed">Confirm</button>`
              : o.status === 'confirmed' ? `<button class="btn-sm btn" data-adv="${o.id}" data-to="delivered">Mark Delivered</button>` : ''}</td>
          </tr>`).join('')}
        </tbody></table></div>`;
      listEl.querySelectorAll('[data-adv]').forEach(btn => btn.onclick = async () => {
        try {
          const updated = await api(`/api/orders/${btn.dataset.adv}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.to }) });
          orders = orders.map(o => o.id === updated.id ? updated : o);
          draw();
        } catch (e) { alert(e.message); }
      });
    }
    document.getElementById('f-shop').onchange = draw;
    document.getElementById('f-status').onchange = draw;
    draw();
  }

  // ─── Shops ──────────────────────────────────────────────────────────────────
  async function renderShops() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Shops', 'Client shops connected to the hub. Each shop authenticates with its own API key.');
    let shops = [];
    try { shops = await api('/api/shops'); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }

    page.innerHTML += `
      <div class="card">
        <label class="lbl">Add Shop</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <input id="new-shop" placeholder="e.g. Boxx Kadıköy" style="min-width:220px">
          <button class="btn" id="add-shop">Create Shop & API Key</button>
        </div>
        <div id="add-result"></div>
      </div>
      <div id="shop-list">${shops.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Shop</th><th>Orders</th><th>Last order</th><th>Since</th><th></th></tr></thead>
        <tbody>${shops.map(s => `<tr>
          <td style="font-weight:500">${esc(s.name)}</td>
          <td>${s.orders_count}</td>
          <td>${esc(s.last_order_date || '—')}</td>
          <td style="color:var(--drift)">${esc((s.created_at || '').slice(0, 10))}</td>
          <td><button class="btn-sm btn" data-rotate="${s.id}">Rotate Key</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No shops yet.</div>'}</div>`;

    const showKey = (name, key) => {
      document.getElementById('add-result').innerHTML = `
        <div class="keybox">
          <strong>${esc(name)}</strong> — API key (shown once, copy it now):<br>
          <code id="the-key">${esc(key)}</code>
          <button class="btn-sm btn" id="copy-key" style="margin-left:8px">Copy</button><br>
          Paste it into that shop's Dose app → Settings → Ordering → Hub API Key, along with this hub's URL.
        </div>`;
      document.getElementById('copy-key').onclick = () =>
        navigator.clipboard.writeText(key).then(() => { document.getElementById('copy-key').textContent = 'Copied ✓'; });
    };

    document.getElementById('add-shop').onclick = async () => {
      const name = document.getElementById('new-shop').value.trim();
      if (!name) return;
      try {
        const data = await api('/api/shops', { method: 'POST', body: JSON.stringify({ name }) });
        showKey(data.shop.name, data.api_key);
        document.getElementById('new-shop').value = '';
      } catch (e) { document.getElementById('add-result').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
    };
    page.querySelectorAll('[data-rotate]').forEach(btn => btn.onclick = async () => {
      if (!window.confirm('Rotate this shop’s API key? The old key stops working immediately — you must update the shop’s Settings with the new one.')) return;
      try {
        const shop = shops.find(s => String(s.id) === btn.dataset.rotate);
        const data = await api(`/api/shops/${btn.dataset.rotate}/rotate-key`, { method: 'POST' });
        showKey(shop ? shop.name : 'Shop', data.api_key);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (e) { alert(e.message); }
    });
  }

  // ─── Patterns ───────────────────────────────────────────────────────────────
  async function renderPatterns() {
    const page = document.getElementById('page');
    page.innerHTML = header('Roastery', 'Patterns', 'Ordering volume, pool mix, and cadence per shop.');
    let data = [];
    try { data = await api('/api/analytics'); }
    catch (e) { if (e.message !== 'Unauthorized') page.innerHTML += `<div class="err">${esc(e.message)}</div>`; return; }
    if (!data.length) { page.innerHTML += '<div class="empty">No shops yet.</div>'; return; }

    page.innerHTML += `<div class="stat-grid">${data.map(s => {
      const maxWeek = Math.max(1, ...s.weekly.map(w => w.lbs));
      const totalPool = Math.max(1, POOLS.reduce((sum, [f, l]) => sum + (s.by_pool[f.replace('_lbs', '')] || 0), 0));
      return `<div class="card">
        <div class="stat-name">${esc(s.shop_name)}</div>
        <div class="stat-line">${s.orders_count} orders · ${s.total_lbs} lbs total</div>
        <div class="stat-line">${s.avg_interval_days != null ? `orders every ~${s.avg_interval_days} days` : 'not enough orders for cadence yet'}</div>
        <div class="stat-line">last order: ${esc(s.last_order || '—')}</div>
        <div class="pool-mix">${POOLS.map(([f, label, color]) => {
          const v = s.by_pool[f.replace('_lbs', '')] || 0;
          return v > 0 ? `<div style="width:${(v / totalPool * 100).toFixed(1)}%;background:${color}" title="${label}: ${Math.round(v * 10) / 10} lbs"></div>` : '';
        }).join('')}</div>
        <div class="legend">${POOLS.map(([f, label, color]) => {
          const v = s.by_pool[f.replace('_lbs', '')] || 0;
          return v > 0 ? `<span><span class="dot" style="background:${color}"></span>${label} ${Math.round(v * 10) / 10}</span>` : '';
        }).join('')}</div>
        ${s.weekly.length ? `<div class="bars" title="Weekly lbs, last 12 weeks">${s.weekly.map(w =>
          `<div style="height:${Math.max(4, w.lbs / maxWeek * 100)}%" title="week ${esc(w.week)}: ${Math.round(w.lbs * 10) / 10} lbs"></div>`).join('')}</div>
        <div class="stat-line" style="margin-top:4px">weekly lbs · last 12 weeks</div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  // ─── Boot ───────────────────────────────────────────────────────────────────
  if (getToken()) {
    api('/api/shops').then(() => renderShell('orders')).catch(() => {});
  } else {
    renderLogin();
  }
})();
