// Scheduled: reads the INAMHI stations every 15 minutes into the shared cache, so the page does not depend
// on INAMHI answering at the moment someone opens it. Each run asks only for the last 2 days (the stored
// series fills the rest), two requests at a time, with one retry.
import { readAndCache } from '../lib/stations-core.mjs';

export default async () => {
  try { const d = await readAndCache(Date.now(), { by: 'schedule', ms: 9000, tries: 2, budget: 24000 }); console.log('stations', d.gauge.fetchedAt, d.okCount, 'answered', d.gauge.errors.join('; ')) }
  catch (e) { console.log('stations failed', e && e.message) }
};
export const config = { schedule: '*/15 * * * *' };
