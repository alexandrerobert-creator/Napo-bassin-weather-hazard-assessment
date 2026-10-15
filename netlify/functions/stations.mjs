// /api/stations: the INAMHI readings for the page. A scheduled function (stations-refresh) reads INAMHI every
// 10 minutes into a shared cache, so the page normally gets an answer at once. If INAMHI is slow or down, the page
// gets the last good reading (up to 36 h old), marked stale, instead of an error.
import { cacheGet, json } from '../lib/common.mjs';
import { readAndCache } from '../lib/stations-core.mjs';

export default async req => {
  const url = new URL(req.url), fresh = url.searchParams.has('fresh'), now = Date.now();
  const c = await cacheGet('stations');
  if (c && (now - c.ts < (fresh ? 2 : 10) * 60e3)) return json(Object.assign({ cached: true }, c.data));
  const stale = msg => c && now - c.ts < 36 * 36e5 ? json(Object.assign({ cached: true, stale: true, staleReason: msg }, c.data)) : json({ error: msg }, 502);
  try {
    const data = await Promise.race([readAndCache(now), new Promise((_, rej) => setTimeout(() => rej(new Error('INAMHI did not answer in time')), 8500))]);
    if (!data.gauge.levels.length) return stale('INAMHI gave no level readings: ' + data.gauge.errors.join('; '));
    return json(data);
  } catch (e) { return stale(String(e && e.message || e)) }
};
export const config = { path: '/api/stations' };
