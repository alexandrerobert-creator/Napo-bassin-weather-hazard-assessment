// /api/stations: the INAMHI readings for the page. A scheduled function (stations-refresh) reads INAMHI every
// 15 minutes into a shared cache, so the page normally gets an answer at once. If INAMHI is slow or down, the page
// gets the last good reading (up to 12 h old), marked stale with its age, instead of an error.
// /api/stations?diag=1 shows the last 30 reading runs and asks INAMHI once per level station right now.
import { cacheGet, json, ecu } from '../lib/common.mjs';
import { readAndCache, diagnose, MAXAGE } from '../lib/stations-core.mjs';

export default async req => {
  const url = new URL(req.url), fresh = url.searchParams.has('fresh'), now = Date.now();
  if (url.searchParams.has('diag')) {
    const c = await cacheGet('stations');
    return json({ now: ecu(now), lastGood: c ? ecu(c.ts) : null, live: await diagnose(now), runs: (await cacheGet('stations-log')) || [] });
  }
  const c = await cacheGet('stations');
  if (c && (now - c.ts < (fresh ? 2 : 10) * 60e3)) return json(Object.assign({ cached: true }, c.data));
  const stale = msg => {
    // older than 12 h: no current reading; the page then falls back to its own stored history, labelled with the date
    if (!c || now - c.ts > MAXAGE) return json({ error: msg, lastGood: c ? ecu(c.ts) : null }, 502);
    const hrs = Math.round((now - c.ts) / 36e5 * 10) / 10;
    return json(Object.assign({ cached: true, stale: true, staleHours: hrs, staleReason: 'INAMHI readings from ' + ecu(c.ts).slice(5) + ' (' + hrs + ' h old): ' + msg }, c.data));
  };
  try {
    const data = await Promise.race([readAndCache(now, { by: 'page', ms: 6000, tries: 1, budget: 8000 }), new Promise((_, rej) => setTimeout(() => rej(new Error('INAMHI did not answer in time')), 9000))]);
    if (!data.okCount || !data.gauge.levels.length) return stale('no station answered: ' + data.gauge.errors.slice(0, 3).join('; '));
    delete data.okCount;
    return json(data);
  } catch (e) { return stale(String(e && e.message || e)) }
};
export const config = { path: '/api/stations' };
