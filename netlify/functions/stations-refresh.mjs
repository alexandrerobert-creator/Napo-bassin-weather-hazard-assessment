// Scheduled: the only place the site asks INAMHI for station readings, every 30 minutes (the stations report hourly).
// Each run asks only for the last 2 days (the stored series fills the rest), two requests at a time, with one retry.
// When INAMHI refuses this site (HTTP 403 "client_blocked"), the run stops after the first refusal and the following
// runs do nothing for 2 hours, so a blocked site sends INAMHI at most a couple of requests every 2 hours.
import { cacheGet } from '../lib/common.mjs';
import { readAndCache } from '../lib/stations-core.mjs';

const BLOCKED_WAIT = 2 * 36e5;

export default async () => {
  const now = Date.now(), log = (await cacheGet('stations-log')) || [], last = log.find(r => r.ts);
  if (last && last.blocked && now - last.ts < BLOCKED_WAIT) { console.log('stations: INAMHI blocked this site at', last.at, '- waiting before asking again'); return }
  try { const d = await readAndCache(now, { by: 'schedule', ms: 9000, tries: 2, budget: 24000 }); console.log('stations', d.gauge.fetchedAt, d.okCount, 'answered', d.blocked ? '(blocked)' : '', d.gauge.errors.join('; ')) }
  catch (e) { console.log('stations failed', e && e.message) }
};
export const config = { schedule: '7,37 * * * *' };
