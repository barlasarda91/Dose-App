// Fetch wrapper that carries the shared-password key and funnels 401s into a
// single "show the login screen" event.
const KEY = 'dose_key';

export function getKey()   { return localStorage.getItem(KEY) || ''; }
export function setKey(k)  { localStorage.setItem(KEY, k); }
export function clearKey() { localStorage.removeItem(KEY); }

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const key = getKey();
  if (key) headers['x-dose-key'] = key;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    window.dispatchEvent(new Event('dose:unauthorized'));
    const err = new Error('Unauthorized');
    err.unauthorized = true;
    throw err;
  }
  return res;
}

export async function apiJson(path, opts) {
  return (await api(path, opts)).json();
}
