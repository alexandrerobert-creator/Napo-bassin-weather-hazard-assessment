// INAMHI Visor: levels and rain at the stations used by the NAA assessment, plus 9 days of hourly level and rain at
// Napo at Coca (H1135), hourly level at Coca at San Sebastián (H1134) and hourly rain at the upstream stations.
// Every 6, 12, 24 and 72 h window, and the 24 h change, ends at the moment of the reading.
//
// 2 Nov 2026 rework (INAMHI readings stopped reaching the site):
// - The hourly series are kept in the shared cache. Each run only asks INAMHI for the last 2 days and merges them in,
//   instead of asking for 9 to 11 days at every station every 10 minutes. This is far lighter on INAMHI and stays well
//   inside its 10-day public limit (older dates are refused with 401).
// - At most 2 requests at a time, with a short pause, and one retry after a failure.
// - A station that fails keeps its last good series; the error is listed but the other stations still update.
// - Every run is logged (time, ok/failed, errors per station) so /api/stations?diag=1 shows what INAMHI answered.
import { H, DAY, ecu, r1, r2, fetchJSON, cacheGet, cachePut } from './common.mjs';

const BASE = 'https://inamhi.gob.ec';
const HEAD = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'Origin': BASE, 'Referer': BASE + '/info/', 'User-Agent': 'Mozilla/5.0 (NAA field assessment)' };
const LV = { H1135: ['Napo at Coca town', 65024, '014101601h', 0.15], H1134: ['Coca at San Sebastián', 34, '014101601h', 0.15], H0719: ['Quijos DJ Oyacachi', 62023, '014101601h', 9], H0728: ['Salado AJ Coca', 65012, '014100401h', 9] };
const RN = { H1135: ['Coca town', 65024], M5189: ['CCS powerhouse', 65010], M5187: ['CCS reservoir', 65009], M5190: ['CCS intake', 65011], M1124: ['Sierrazul', 63781], M0008: ['Puyo', 2] };
const CODES = ['H1135', 'H1134', 'H0719', 'H0728', 'M5189', 'M5187', 'M5190', 'M1124', 'M0008'];
const KEEP = { lv_H1135: 9, lv_H1134: 9, lv_H0719: 3, lv_H0728: 3, rn_M0008: 3 };   // days of history kept; rain default 9
const keepDays = k => KEEP[k] || 9;
// a reading older than this is not shown as current (the page shows the reading time without a date)
export const MAXAGE = 12 * 3600e3;
const pad = n => String(n).padStart(2, '0'), ymd = d => d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate());
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(path, body, ms) { return fetchJSON(BASE + path, { method: 'POST', headers: HEAD, body: JSON.stringify(body) }, ms) }

// INAMHI accepts at most 10 days back for the public: never ask for more than 8 full days before today (UTC dates).
function span(days, now) { return [ymd(new Date(now - Math.min(days, 8) * DAY)), ymd(new Date(now + DAY))] }

async function levels(id, table, days, now, ms) {
  const [a, b] = span(days, now);
  const j = await post('/api_visor/station_data_automaticas/get_data_hour/', { id_estacion: id, table_names: [table], fecha_desde: a, fecha_hasta: b }, ms);
  if (!j || !Array.isArray(j.series) || !j.series.length) throw new Error('unexpected answer: ' + JSON.stringify(j).slice(0, 120));
  return j.series[0].data.map(p => [Date.parse(p.date), p.value === null ? null : +p.value]).filter(p => isFinite(p[0]) && typeof p[1] === 'number' && isFinite(p[1]) && p[0] <= now);
}
async function rain(id, days, now, ms) {
  const [a, b] = span(days, now);
  const j = await post('/api_visor/station_data_automaticas/get_precipitation/', { id_estacion: id, start_date: a, end_date: b }, ms);
  if (!j || !Array.isArray(j.series) || !j.series.length) throw new Error('unexpected answer: ' + JSON.stringify(j).slice(0, 120));
  const s = j.series.slice().sort((x, y) => y.data.length - x.data.length)[0];   // the hourly series (the other is daily)
  return s.data.map(p => [Date.parse(p.date), +p.value || 0]).filter(p => isFinite(p[0]) && p[0] <= now);
}
const despike = (pts, tol) => pts.filter((p, i) => { const w = pts.slice(Math.max(0, i - 3), i + 4).map(q => q[1]).sort((a, b) => a - b); return Math.abs(p[1] - w[Math.floor(w.length / 2)]) <= tol });

// merge new points into the stored series (new values win), keep only the last `days` days, sorted by time
function merge(old, add, days, now) {
  const m = new Map(old || []); (add || []).forEach(p => m.set(p[0], p[1]));
  return [...m.entries()].filter(p => p[0] > now - days * DAY - H).sort((a, b) => a[0] - b[0]);
}

// run tasks with a small concurrency limit and a pause between starts
async function pool(tasks, limit, gap) {
  const res = new Array(tasks.length); let next = 0;
  async function worker() { while (next < tasks.length) { const i = next++; try { res[i] = { status: 'fulfilled', value: await tasks[i]() } } catch (e) { res[i] = { status: 'rejected', reason: e } } if (gap) await sleep(gap) } }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return res;
}
async function retry(fn, tries, wait, left) { let err; for (let k = 0; k < tries; k++) { try { return await fn() } catch (e) { err = e; if (k < tries - 1 && left() > 12000) await sleep(wait); else break } } throw err }

async function coords() {
  const c = await cacheGet('coords'); if (c && c.H1135) return c;
  try {
    const list = await fetchJSON(BASE + '/api_visor/station_information/estaciones/visores/?id_aplicacion=vs_1h_inh', { headers: HEAD }, 8000), out = {};
    list.forEach(s => { if (CODES.includes(s.codigo) && +s.latitud && +s.longitud) out[s.codigo] = { lat: +s.latitud, lon: +s.longitud, alt: +s.altitud || null, name: s.punto_obs } });
    if (out.H1135) await cachePut('coords', out);
    return out;
  } catch (e) { return {} }
}

// opt.budget: total time allowed (ms); opt.ms: time per request; opt.tries: attempts per request
export async function read(now, opt = {}) {
  const ms = opt.ms || 7000, tries = opt.tries || 1, t1 = Date.now();
  const out = { fetchedAt: ecu(now).replace(' ', 'T'), levels: [], rain: [], vals: {}, errors: [] }, series = {};
  const stored = (await cacheGet('stations-series')) || {};
  const jobs = [];
  Object.entries(LV).forEach(([code, [, id, table]]) => { const k = 'lv_' + code, s = stored[k], have = s && s.length && s[s.length - 1][0] > now - 36 * H; jobs.push({ k, code, kind: 'level', run: () => levels(id, table, have ? 2 : keepDays(k), now, ms) }) });
  Object.entries(RN).forEach(([code, [, id]]) => { const k = 'rn_' + code, s = stored[k], have = s && s.length && s[s.length - 1][0] > now - 36 * H; jobs.push({ k, code, kind: 'rain', run: () => rain(id, have ? 2 : keepDays(k), now, ms) }) });
  const budget = opt.budget || 25000;
  const left = () => budget - (Date.now() - t1);
  const res = await pool(jobs.map(j => () => { if (left() < ms) throw new Error('skipped: out of time'); return retry(j.run, tries, 1500, left) }), 2, 250);
  const next = {}, fresh = {};
  jobs.forEach((j, i) => {
    const r = res[i], keep = keepDays(j.k);
    if (r.status === 'fulfilled' && r.value.length) { next[j.k] = merge(stored[j.k], r.value, keep, now); fresh[j.k] = true }
    else {
      next[j.k] = merge(stored[j.k], [], keep, now);
      const why = r.status === 'rejected' ? (r.reason && r.reason.message || String(r.reason)) : 'no data';
      const last = next[j.k].length ? next[j.k][next[j.k].length - 1][0] : null;
      out.errors.push(j.code + ' ' + j.kind + ': ' + why + (last ? ' (showing reading of ' + ecu(last).slice(5) + ')' : ''));
    }
  });
  const okCount = Object.keys(fresh).length;
  if (okCount) await cachePut('stations-series', next);

  Object.entries(LV).forEach(([code, [name, , , tol]]) => {
    const pts = next['lv_' + code]; if (!pts || !pts.length) return;
    if (pts[pts.length - 1][0] < now - MAXAGE) { out.errors.push(code + ' level: no reading since ' + ecu(pts[pts.length - 1][0]).slice(5)); return }
    const good = despike(pts, tol); if (!good.length) return;
    const last = good[good.length - 1];
    const atT = t => { const c = good.filter(p => Math.abs(p[0] - t) <= H).sort((a, b) => Math.abs(a[0] - t) - Math.abs(b[0] - t))[0]; return c ? c[1] : null };
    const v3 = atT(last[0] - 3 * H), v24 = atT(now - DAY), w24 = good.filter(p => p[0] > now - DAY).map(p => p[1]);
    out.levels.push({ code, name, now: last[1], at: ecu(last[0]).slice(11), ch3: v3 === null ? null : r2(last[1] - v3), ch24: v24 === null ? null : r2(last[1] - v24), min24: w24.length ? Math.min(...w24) : null, max24: w24.length ? Math.max(...w24) : null, fresh: !!fresh['lv_' + code] });
    if (code === 'H1135' || code === 'H1134') series[code] = good;
  });
  Object.entries(RN).forEach(([code, [name]]) => {
    const pts = next['rn_' + code]; if (!pts || !pts.length) return;
    if (pts[pts.length - 1][0] < now - MAXAGE) { out.errors.push(code + ' rain: no reading since ' + ecu(pts[pts.length - 1][0]).slice(5)); return }
    const lastT = pts[pts.length - 1][0], sum = h => r1(pts.filter(p => p[0] > now - h * H).reduce((a, p) => a + p[1], 0));
    out.rain.push({ code, name, upTo: ecu(lastT).slice(11), r6: sum(6), r12: sum(12), r24: sum(24), r72: sum(72), fresh: !!fresh['rn_' + code] });
    if (code !== 'M0008') series['rain_' + code] = pts;
  });
  const lv = c => out.levels.find(x => x.code === c), rn = c => out.rain.find(x => x.code === c), a = lv('H1135'), b = lv('H1134');
  if (a) { out.vals.riverLevel = r2(a.now); out.vals.riverTime = a.at; if (a.ch24 !== null) out.vals.riverChange = a.ch24; if (a.ch3 !== null) { const rate = a.ch3 / 3; out.vals.riverTrend = rate >= 0.1 ? 'rising fast' : rate >= 0.03 ? 'rising' : rate <= -0.03 ? 'falling' : 'steady' } }
  if (b) out.vals.h1134 = r2(b.now);
  if (rn('H1135')) out.vals.obsRain = rn('H1135').r24;
  const ups = ['M5189', 'M5187', 'M5190', 'M1124'].map(rn).filter(Boolean); if (ups.length) out.vals.obsRainUp = Math.max(...ups.map(x => x.r24));
  const foot = ['M0008', 'M1124'].map(rn).filter(Boolean); if (foot.length) out.vals.footRain12 = Math.max(...foot.map(x => x.r12));

  // hourly history on one grid, as the page's archive format: start time (Ecuador) and comma-separated values
  let hist = null;
  if (series.H1135 && series.H1135.length) {
    const t0 = series.H1135[0][0], n = Math.floor((now - t0) / H) + 1, grid = (pts, dec) => { const m = new Map(pts); return Array.from({ length: n }, (_, k) => { const v = m.get(t0 + k * H); return v === undefined ? '' : v.toFixed(dec) }).join(',') };
    hist = { date: ecu(now).slice(0, 10), t0Ecuador: ecu(t0), fetchedAt: out.fetchedAt, series: { H1135: grid(series.H1135, 2) } };
    if (series.H1134) hist.series.H1134 = grid(series.H1134, 2);
    ['H1135', 'M5189', 'M5187', 'M5190', 'M1124'].forEach(c => { if (series['rain_' + c]) hist.series['rain_' + c] = grid(series['rain_' + c], 1) });
  }
  // run log, newest first, last 30 runs
  const log = (await cacheGet('stations-log')) || [];
  log.unshift({ at: ecu(Date.now()), by: opt.by || 'page', ok: okCount, of: jobs.length, secs: Math.round((Date.now() - t1) / 100) / 10, errors: out.errors });
  await cachePut('stations-log', log.slice(0, 30));
  return { gauge: out, history: hist, coords: await coords(), okCount };
}

// read and store in the shared cache; used by the page request and by the scheduled refresh
export async function readAndCache(now, opt) {
  const data = await read(now, opt), ok = data.okCount; delete data.okCount;
  if (ok && data.gauge.levels.length) await cachePut('stations', { ts: now, data });
  return Object.assign(data, { okCount: ok });
}

// one bare request per station, for /api/stations?diag=1: what INAMHI answers right now, and how fast
export async function diagnose(now) {
  const rows = [];
  for (const [code, [, id, table]] of Object.entries(LV)) {
    const t = Date.now();
    try { const p = await levels(id, table, 1, now, 8000); rows.push({ code, kind: 'level', ok: true, points: p.length, last: p.length ? ecu(p[p.length - 1][0]) : null, ms: Date.now() - t }) }
    catch (e) { rows.push({ code, kind: 'level', ok: false, error: e && e.message, ms: Date.now() - t }) }
    await sleep(250);
  }
  const t = Date.now();
  try { const p = await rain(65024, 1, now, 8000); rows.push({ code: 'H1135', kind: 'rain', ok: true, points: p.length, ms: Date.now() - t }) }
  catch (e) { rows.push({ code: 'H1135', kind: 'rain', ok: false, error: e && e.message, ms: Date.now() - t }) }
  return rows;
}
