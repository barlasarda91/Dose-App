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
  const TABS = [['orders', 'Orders'], ['catalog', 'Catalog'], ['shops', 'Shops'], ['patterns', 'Patterns']];
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
    ({ orders: renderOrders, catalog: renderCatalog, shops: renderShops, patterns: renderPatterns })[active]();
  }

  const header = (eyebrow, title, sub) =>
    `<div class="eyebrow">${eyebrow}</div><h1 class="title">${title}</h1><p class="sub">${sub}</p><hr class="rule">`;

  const roastTag = r => `<span class="roast-lbl">${r === 'espresso' ? 'ESP' : 'FLT'}</span>`;

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
      <select id="f-status"><option value="">All statuses</option><option value="new">New</option><option value="confirmed">Confirmed</option><option value="delivered">Delivered</option></select>
      <span style="font-size:10px;color:var(--drift)" id="new-count"></span>
      <span class="ok" id="action-msg" style="margin:0"></span>`;
    page.appendChild(filters);
    const listEl = document.createElement('div');
    page.appendChild(listEl);

    const itemsHtml = o => o.items && o.items.length
      ? o.items.map(i => `<div style="white-space:nowrap">${roastTag(i.roast)} ${esc(i.coffee_name)} · ${i.lbs} lbs · ${money(i.line_total)}</div>`).join('')
      : ['espresso_lbs', 'drip_lbs', 'coldbrew_lbs', 'pourover_lbs'].filter(f => o[f] > 0)
          .map(f => `<div>${esc(f.replace('_lbs', ''))}: ${o[f]} lbs</div>`).join('') || '—';

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
            <td style="line-height:1.9;font-size:10px">${itemsHtml(o)}${o.notes ? `<div style="color:var(--drift)">✎ ${esc(o.notes)}</div>` : ''}</td>
            <td class="num">${o.total_lbs || '—'}</td>
            <td class="num">${money(o.total_cost)}</td>
            <td style="color:var(--drift)">${esc(o.placed_by || '—')}</td>
            <td><span class="status ${o.status}">${o.status}</span></td>
            <td>${o.status === 'new' ? `<button class="btn-sm btn" data-adv="${o.id}" data-to="confirmed">Confirm</button>`
              : o.status === 'confirmed' ? `<button class="btn-sm btn" data-adv="${o.id}" data-to="delivered">Mark Delivered</button>` : ''}</td>
          </tr>`).join('')}
        </tbody></table></div>`;
      listEl.querySelectorAll('[data-adv]').forEach(btn => btn.onclick = async () => {
        btn.disabled = true;
        try {
          const updated = await api(`/api/orders/${btn.dataset.adv}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.to }) });
          orders = orders.map(o => o.id === updated.id ? updated : o);
          const msgEl = document.getElementById('action-msg');
          if (updated.email) {
            msgEl.textContent = updated.email.sent ? `✓ Confirmation email sent to ${updated.email.to}` : `⚠ Confirmed, but email not sent: ${updated.email.reason}`;
            setTimeout(() => { msgEl.textContent = ''; }, 6000);
          }
          draw();
        } catch (e) { alert(e.message); }
      });
    }
    document.getElementById('f-shop').onchange = draw;
    document.getElementById('f-status').onchange = draw;
    draw();
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
        <thead><tr><th>Coffee</th><th class="num">Base / lb</th><th>Visibility</th><th></th></tr></thead>
        <tbody>${items.map(i => `
          <tr style="${i.active ? '' : 'opacity:.55'}">
            <td><span style="font-family:var(--serif);font-size:13px;color:var(--ink)">${esc(i.name)}</span>${badge(i)}
              <div style="font-size:9px;color:var(--drift)">${esc(i.notes || '')}</div></td>
            <td class="num">${money(i.price_per_lb)}</td>
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
          Creating a shop creates its account: a login username (from the name), the password its staff sign in with, and the API key its deployment uses.
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <input id="new-shop" placeholder="Shop name, e.g. Boxx Kadıköy" style="min-width:190px">
          <input id="new-email" placeholder="Registered email (receipts go here)" style="min-width:230px">
          <input id="new-pass" type="password" placeholder="Login password (min 8)" style="min-width:170px" autocomplete="new-password">
          <button class="btn" id="add-shop">Create Shop</button>
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
          <td style="color:var(--drift)">${esc(s.login_username || '—')}${s.has_password ? '' : ' <span class="badge low">No login password</span>'}</td>
          <td style="color:var(--drift)">${esc(s.email || '— none —')}</td>
          <td>${s.orders_count}</td>
          <td>${esc(s.last_order_date || '—')}</td>
          <td><div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn-sm btn" data-pricing="${s.id}">Pricing</button>
            <button class="btn-sm btn" data-editshop="${s.id}">Edit</button>
            <button class="btn-sm btn" data-resetlogin="${s.id}">Reset Login</button>
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

    document.getElementById('add-shop').onclick = async () => {
      const name = document.getElementById('new-shop').value.trim();
      const email = document.getElementById('new-email').value.trim();
      const password = document.getElementById('new-pass').value;
      if (!name) return;
      try {
        const data = await api('/api/shops', { method: 'POST', body: JSON.stringify({ name, email, password }) });
        shops = [...shops, data.shop].sort((a, b) => a.name.localeCompare(b.name));
        showKey(data.shop.name, data.api_key);
        document.getElementById('add-result').insertAdjacentHTML('beforeend',
          `<div class="ok">Login for staff: username <strong>${esc(data.shop.login_username)}</strong> + the password you just set.</div>`);
        document.getElementById('new-shop').value = ''; document.getElementById('new-email').value = ''; document.getElementById('new-pass').value = '';
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
      document.querySelectorAll('[data-resetlogin]').forEach(btn => btn.onclick = async () => {
        const shop = shops.find(s => String(s.id) === btn.dataset.resetlogin);
        const pw = window.prompt(`New login password for '${shop.name}' (min 8 characters):`);
        if (pw === null) return;
        try {
          const data = await api(`/api/shops/${shop.id}/reset-login`, { method: 'POST', body: JSON.stringify({ new_password: pw }) });
          shops = shops.map(s => s.id === shop.id ? { ...s, login_username: data.login_username, has_password: true } : s);
          drawList();
          document.getElementById('add-result').innerHTML =
            `<div class="ok">✓ ${esc(shop.name)} login updated — username <strong>${esc(data.login_username)}</strong>, the password you just set.</div>`;
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

  // ─── Boot ───────────────────────────────────────────────────────────────────
  if (getToken()) {
    api('/api/shops').then(() => renderShell('orders')).catch(() => {});
  } else {
    renderLogin();
  }
})();
