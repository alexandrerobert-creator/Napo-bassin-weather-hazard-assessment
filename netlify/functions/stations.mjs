// /api/stations: the INAMHI readings for the page, served only from the shared cache. The page never asks INAMHI
// itself: the scheduled function (stations-refresh) reads INAMHI every 30 minutes and stores the result, so the load
// on INAMHI is the same however many people open the page or press Refresh.
// If the stored reading is older than 12 h (or missing) the answer is an error, and the page falls back to its own
// stored history, labelled with the date.
// /api/stations?diag=1 shows the last 30 reading runs; add &live=1 to also send INAMHI one request right now.
import { cacheGet, json, ecu } from '../lib/common.mjs';
import { diagnose, MAXAGE } from '../lib/stations-core.mjs';

export default async req => {
  const url = new URL(req.url), now = Date.now();
  const c = await cacheGet('stations'), runs = (await cacheGet('stations-log')) || [];
  const blocked = !!(runs[0] && runs[0].blocked);
  if (url.searchParams.has('diag')) {
    return json({ now: ecu(now), lastGood: c ? ecu(c.ts) : null, blocked, live: url.searchParams.has('live') ? await diagnose(now) : 'add &live=1 to send INAMHI one request now', runs });
  }
  const why = blocked ? 'INAMHI is refusing this site (HTTP 403 client_blocked) since its last good reading; access has been requested'
    : runs[0] && runs[0].ok === 0 ? 'the last reading run failed: ' + (runs[0].errors || []).slice(0, 2).join('; ') : '';
  if (!c || now - c.ts > MAXAGE) return json({ error: why || 'no stored INAMHI reading yet', blocked, lastGood: c ? ecu(c.ts) : null }, 502);
  const hrs = Math.round((now - c.ts) / 36e5 * 10) / 10;
  if (hrs <= 1.5) return json(Object.assign({ cached: true }, c.data));
  return json(Object.assign({ cached: true, stale: true, staleHours: hrs, staleReason: 'INAMHI readings from ' + ecu(c.ts).slice(5) + ' (' + hrs + ' h old)' + (why ? ': ' + why : '') }, c.data));
};
export const config = { path: '/api/stations' };
