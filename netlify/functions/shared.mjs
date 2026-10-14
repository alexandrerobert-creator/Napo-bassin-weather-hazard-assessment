// Shared records for everyone using the site: each morning's five-day river forecast (kept once per day, never overwritten)
// and briefs marked as issued. Stored in Netlify Blobs.
import { store, json } from '../lib/common.mjs';

const KINDS = { forecasts: { once: true }, briefs: { once: false } };
const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

export default async req => {
  const url = new URL(req.url), kind = url.searchParams.get('kind');
  if (!KINDS[kind]) return json({ error: 'unknown kind' }, 400);
  const s = await store(); if (!s) return json({ error: 'storage unavailable' }, 503);
  if (req.method === 'GET') {
    const { blobs } = await s.list({ prefix: kind + '/' });
    const keys = blobs.map(b => b.key).sort().slice(-60);
    const items = (await Promise.all(keys.map(k => s.get(k, { type: 'json' }).catch(() => null)))).filter(Boolean);
    return json({ items });
  }
  if (req.method === 'POST') {
    let body; try { body = await req.json() } catch (e) { return json({ error: 'bad json' }, 400) }
    if (!body || !okDate(body.date)) return json({ error: 'date missing' }, 400);
    const text = JSON.stringify(body); if (text.length > 200000) return json({ error: 'too large' }, 413);
    const key = kind + '/' + body.date;
    if (KINDS[kind].once && await s.get(key)) return json({ ok: true, kept: 'existing' });
    await s.setJSON(key, Object.assign({}, body, { savedTs: Date.now() }));
    return json({ ok: true });
  }
  return json({ error: 'method' }, 405);
};
export const config = { path: '/api/shared' };
