// Shared helpers for the NAA standalone functions. Ecuador is UTC-5 all year.
import { getStore } from '@netlify/blobs';
export const H = 36e5, DAY = 864e5;
export const ecu = ms => new Date(ms - 5 * H).toISOString().slice(0, 16).replace('T', ' ');
export const ecuDate = ms => new Date(ms - 5 * H).toISOString().slice(0, 10);
export const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
export const isNum = x => typeof x === 'number' && isFinite(x);

export async function fetchJSON(url, opt = {}, ms = 7000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, Object.assign({ signal: c.signal }, opt));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t) }
}

// small cache in Netlify Blobs; works without it (local tests)
let storeP = null;
export async function store() {
  if (!storeP) storeP = Promise.resolve().then(() => getStore({ name: 'naa', consistency: 'strong' })).catch(() => null);
  return storeP;
}
export async function cacheGet(key) { try { const s = await store(); return s ? await s.get(key, { type: 'json' }) : null } catch (e) { return null } }
export async function cachePut(key, val) { try { const s = await store(); if (s) await s.setJSON(key, val) } catch (e) {} }

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, extra) });
}
