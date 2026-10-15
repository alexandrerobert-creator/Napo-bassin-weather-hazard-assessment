// Shared records for everyone using the site, stored in Netlify Blobs:
// - forecasts: each day's five-day river forecast (the first one saved is kept, never overwritten);
// - drafts: the day's common brief (entries, status, issued text). A save merges field by field: each entry
//   sent replaces that entry only, so two people editing different fields never overwrite each other;
// - briefs: briefs marked as issued by the earlier version (read only, kept for history).
import { store, json } from '../lib/common.mjs';

const KINDS = { forecasts: { once: true }, briefs: { once: false }, drafts: { merge: true } };
const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const TOP = ['status', 'issuedAt', 'issuedOn', 'issuedTs', 'issuedText', 'final', 'createdTs'];

export default async req => {
  const url = new URL(req.url), kind = url.searchParams.get('kind');
  if (!KINDS[kind]) return json({ error: 'unknown kind' }, 400);
  const s = await store(); if (!s) return json({ error: 'storage unavailable' }, 503);
  if (req.method === 'GET') {
    const one = url.searchParams.get('date');
    if (one) { if (!okDate(one)) return json({ error: 'bad date' }, 400); const d = await s.get(kind + '/' + one, { type: 'json' }).catch(() => null); return json({ items: d ? [d] : [] }) }
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
    if (KINDS[kind].merge) {
      const cur = (await s.get(key, { type: 'json' }).catch(() => null)) || { date: body.date, man: {} };
      const next = Object.assign({}, cur, { man: Object.assign({}, cur.man || {}, (body.man && typeof body.man === 'object') ? body.man : {}) });
      TOP.forEach(k => { if (k in body) { if (k === 'createdTs' && cur.createdTs) return; next[k] = body[k] } });
      next.updatedTs = Date.now(); if (body.by) next.by = String(body.by).slice(0, 40);
      await s.setJSON(key, next);
      return json({ ok: true, item: next });
    }
    await s.setJSON(key, Object.assign({}, body, { savedTs: Date.now() }));
    return json({ ok: true });
  }
  return json({ error: 'method' }, 405);
};
export const config = { path: '/api/shared' };
