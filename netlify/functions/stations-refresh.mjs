// Scheduled: reads the INAMHI stations every 10 minutes into the shared cache, so the page does not depend
// on INAMHI answering at the moment someone opens it.
import { readAndCache } from '../lib/stations-core.mjs';

export default async () => {
  try { const d = await readAndCache(Date.now()); console.log('stations', d.gauge.fetchedAt, d.gauge.levels.length, 'levels', d.gauge.errors.join('; ')) }
  catch (e) { console.log('stations failed', e && e.message) }
};
export const config = { schedule: '*/10 * * * *' };
