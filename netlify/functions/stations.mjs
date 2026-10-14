// INAMHI Visor: levels and rain at the stations used by the NAA assessment, plus 9 days of hourly level and rain at Napo at Coca (H1135) hourly level at Coca at San Sebastián (H1134) and hourly rain at the upstream stations.
// Every 6, 12, 24 and 72 h window, and the 24 h change, ends at the moment of the reading.
import { H, DAY, ecu, r1, r2, fetchJSON, cacheGet, cachePut, json } from '../lib/common.mjs';

const BASE = 'https://inamhi.gob.ec';
const HEAD = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': BASE, 'Referer': BASE + '/info/', 'User-Agent': 'Mozilla/5.0 (NAA field assessment)' };
const LV = { H1135: ['Napo at Coca town', 65024, '014101601h', 0.15], H1134: ['Coca at San Sebastián', 34, '014101601h', 0.15], H0719: ['Quijos DJ Oyacachi', 62023, '014101601h', 9], H0728: ['Salado AJ Coca', 65012, '014100401h', 9] };
const RN = { H1135: ['Coca town', 65024], M5189: ['CCS powerhouse', 65010], M5187: ['CCS reservoir', 65009], M5190: ['CCS intake', 65011], M1124: ['Sierrazul', 63781], M0008: ['Puyo', 2] };
const CODES = ['H1135', 'H1134', 'H0719', 'H0728', 'M5189', 'M5187', 'M5190', 'M1124', 'M0008'];
const pad = n => String(n).padStart(2, '0'), ymd = d => d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate());
const post = (path, body) => fetchJSON(BASE + path, { method: 'POST', headers: HEAD, body: JSON.stringify(body) }, 8000);

async function levels(id, table, days, now) {
  const j = await post('/api_visor/station_data_automaticas/get_data_hour/', { id_estacion: id, table_names: [table], fecha_desde: ymd(new Date(now - days * DAY)), fecha_hasta: ymd(new Date(now + DAY)) });
  return j.series[0].data.map(p => [Date.parse(p.date), p.value]).filter(p => typeof p[1] === 'number' && p[0] <= now).sort((a, b) => a[0] - b[0]);
}
async function rain(id, days, now) {
  const j = await post('/api_visor/station_data_automaticas/get_precipitation/', { id_estacion: id, start_date: ymd(new Date(now - days * DAY)), end_date: ymd(new Date(now + DAY)) });
  const s = j.series.slice().sort((a, b) => b.data.length - a.data.length)[0];
  return s.data.map(p => [Date.parse(p.date), +p.value || 0]).filter(p => p[0] <= now).sort((a, b) => a[0] - b[0]);
}
const despike = (pts, tol) => pts.filter((p, i) => { const w = pts.slice(Math.max(0, i - 3), i + 4).map(q => q[1]).sort((a, b) => a - b); return Math.abs(p[1] - w[Math.floor(w.length / 2)]) <= tol });

async function coords() {
  const c = await cacheGet('coords'); if (c && c.H1135) return c;
  try {
    const list = await fetchJSON(BASE + '/api_visor/station_information/estaciones/visores/?id_aplicacion=vs_1h_inh', { headers: HEAD }, 8000), out = {};
    list.forEach(s => { if (CODES.includes(s.codigo) && +s.latitud && +s.longitud) out[s.codigo] = { lat: +s.latitud, lon: +s.longitud, alt: +s.altitud || null, name: s.punto_obs } });
    if (out.H1135) await cachePut('coords', out);
    return out;
  } catch (e) { return {} }
}

async function read(now) {
  const out = { fetchedAt: ecu(now).replace(' ', 'T'), levels: [], rain: [], vals: {}, errors: [] }, series = {};
  let t0 = null;
  const lvRes = await Promise.allSettled(Object.entries(LV).map(([code, [, id, table]]) => levels(id, table, code === 'H1135' || code === 'H1134' ? 9 : 3, now)));
  const rnRes = await Promise.allSettled(Object.entries(RN).map(([code, [, id]]) => rain(id, code === 'M0008' ? 3 : 9, now)));
  Object.entries(LV).forEach(([code, [name, , , tol]], i) => {
    const r = lvRes[i]; if (r.status !== 'fulfilled' || !r.value.length) { out.errors.push(code + ' level: ' + (r.reason ? r.reason.message : 'no data')); return }
    const good = despike(r.value, tol), last = good[good.length - 1];
    const atT = t => { const c = good.filter(p => Math.abs(p[0] - t) <= H).sort((a, b) => Math.abs(a[0] - t) - Math.abs(b[0] - t))[0]; return c ? c[1] : null };
    const v3 = atT(last[0] - 3 * H), v24 = atT(now - DAY), w24 = good.filter(p => p[0] > now - DAY).map(p => p[1]);
    out.levels.push({ code, name, now: last[1], at: ecu(last[0]).slice(11), ch3: v3 === null ? null : r2(last[1] - v3), ch24: v24 === null ? null : r2(last[1] - v24), min24: w24.length ? Math.min(...w24) : null, max24: w24.length ? Math.max(...w24) : null });
    if (code === 'H1135') { t0 = good[0][0]; series.H1135 = good }
    if (code === 'H1134') series.H1134 = good;
  });
  Object.entries(RN).forEach(([code, [name]], i) => {
    const r = rnRes[i]; if (r.status !== 'fulfilled' || !r.value.length) { out.errors.push(code + ' rain: ' + (r.reason ? r.reason.message : 'no data')); return }
    const pts = r.value, lastT = pts[pts.length - 1][0], sum = h => r1(pts.filter(p => p[0] > now - h * H).reduce((a, p) => a + p[1], 0));
    out.rain.push({ code, name, upTo: ecu(lastT).slice(11), r6: sum(6), r12: sum(12), r24: sum(24), r72: sum(72) });
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
  if (t0 !== null) {
    const n = Math.floor((now - t0) / H) + 1, grid = (pts, dec) => { const m = new Map(pts); return Array.from({ length: n }, (_, k) => { const v = m.get(t0 + k * H); return v === undefined ? '' : v.toFixed(dec) }).join(',') };
    hist = { date: ecu(now).slice(0, 10), t0Ecuador: ecu(t0), fetchedAt: out.fetchedAt, series: { H1135: grid(series.H1135, 2) } };
    if (series.H1134) hist.series.H1134 = grid(series.H1134, 2);
    ['H1135', 'M5189', 'M5187', 'M5190', 'M1124'].forEach(c => { if (series['rain_' + c]) hist.series['rain_' + c] = grid(series['rain_' + c], 1) });
  }
  return { gauge: out, history: hist, coords: await coords() };
}

export default async req => {
  const url = new URL(req.url), fresh = url.searchParams.has('fresh'), now = Date.now();
  const c = await cacheGet('stations');
  if (c && (now - c.ts < (fresh ? 2 : 10) * 60e3)) return json(Object.assign({ cached: true }, c.data));
  try {
    const data = await read(now);
    if (data.gauge.levels.length) await cachePut('stations', { ts: now, data });
    else if (c) return json(Object.assign({ cached: true, stale: true }, c.data));
    return json(data);
  } catch (e) { return c ? json(Object.assign({ cached: true, stale: true }, c.data)) : json({ error: String(e && e.message || e) }, 502) }
};
export const config = { path: '/api/stations' };
