// Forecast gathering for the NAA assessment: MET Norway (ECMWF-based) at Coca and four upstream points, Open-Meteo for the
// model comparison and gusts, 7Timer (GFS) for instability, Coca airport METAR, GEOGLOWS modelled flow.
// Produces the same "auto" object the Claude version's 05:10 task writes. Local time = UTC-5.
import { H, DAY, ecu, ecuDate, r1, isNum, fetchJSON, cacheGet, cachePut, json } from '../lib/common.mjs';
import { readAdvisory, ADV_URL } from '../lib/advisory.mjs';

const COCA = [-0.4628, -76.9872];
const UP = { tena: [-0.99, -77.81], jatunyacu: [-1.10, -78.05], elChaco: [-0.34, -77.81], loreto: [-0.69, -77.31] };
const OM_MODELS = [['GFS', 'gfs_seamless'], ['UKMO', 'ukmo_seamless'], ['ICON', 'icon_seamless'], ['ECMWF', 'ecmwf_ifs025']];
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = d => COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
const hx = (T, RH) => { const e = RH / 100 * 6.112 * Math.exp(17.62 * T / (243.12 + T)); return T + 0.5555 * (e - 10) };

// MET Norway compact -> hourly rows {t, T, RH, ws, wd, sym, p} with 6-hour blocks spread evenly over their hours
function metRows(j) {
  const rows = new Map();
  for (const e of j.properties.timeseries) {
    const t = Date.parse(e.time), d = e.data.instant.details, n1 = e.data.next_1_hours, n6 = e.data.next_6_hours;
    const base = { t, T: d.air_temperature, RH: d.relative_humidity, cl: d.cloud_area_fraction, ps: d.air_pressure_at_sea_level, ws: d.wind_speed, wd: d.wind_from_direction, sym: (n1 || n6 || {}).summary ? (n1 || n6).summary.symbol_code : '' };
    if (n1) rows.set(t, Object.assign(base, { p: n1.details.precipitation_amount }));
    else if (n6) for (let k = 0; k < 6; k++) { const tt = t + k * H; if (!rows.has(tt)) rows.set(tt, Object.assign({}, base, { t: tt, p: n6.details.precipitation_amount / 6, coarse: k > 0 })) }
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}
const sumP = (rows, a, b, from) => { const s = rows.filter(r => r.t >= Math.max(a, from) && r.t < b); return s.length ? r1(s.reduce((x, r) => x + (r.p || 0), 0)) : null };

function timingNote(rows, L0, from) {
  const parts = [['morning', 6, 12], ['afternoon', 12, 18], ['evening', 18, 24], ['overnight', 24, 30]].map(([n, a, b]) => [n, rows.filter(r => r.t >= Math.max(L0 + a * H, from) && r.t < L0 + b * H).reduce((x, r) => x + (r.p || 0), 0)]);
  const tot = parts.reduce((x, p) => x + p[1], 0); if (tot < 1) return 'little rain';
  const top = parts.slice().sort((a, b) => b[1] - a[1])[0];
  return (tot < 5 ? 'light rain, mostly ' : tot < 15 ? 'showers, mostly ' : 'rain, heaviest ') + (top[0] === 'overnight' ? 'overnight' : 'in the ' + top[0]);
}

async function gather(now, ua, fresh) {
  const D = ecuDate(now), L0 = Date.parse(D + 'T05:00:00Z'), hourNow = Math.floor(now / H) * H, gaps = [], sources = [], vals = {};
  const met = (lat, lon) => fetchJSON('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=' + lat + '&lon=' + lon, { headers: { 'User-Agent': ua } });
  const om = m => fetchJSON('https://api.open-meteo.com/v1/forecast?latitude=' + COCA[0] + '&longitude=' + COCA[1] + '&hourly=temperature_2m,relative_humidity_2m,precipitation,wind_gusts_10m,weather_code&models=' + m + '&timezone=GMT&forecast_days=3');
  const jobs = {
    coca: met(...COCA), tena: met(...UP.tena), jatunyacu: met(...UP.jatunyacu), elChaco: met(...UP.elChaco), loreto: met(...UP.loreto),
    t7: fetchJSON('https://www.7timer.info/bin/api.pl?lon=-76.987&lat=-0.463&product=civil&output=json', {}, 8000),
    metar: fetchJSON('https://aviationweather.gov/api/data/metar?ids=SECO&format=json&hours=30', { headers: { 'User-Agent': ua } }),
    geo: fetchJSON('https://geoglows.ecmwf.int/api/v2/forecast/620929107?format=json', {}, 8000)
  };
  OM_MODELS.forEach(([lab, m]) => { jobs['om_' + lab] = om(m) });
  const keys = Object.keys(jobs), res = await Promise.allSettled(keys.map(k => jobs[k])), R = {};
  const LAB = { coca: 'MET Norway at Coca', tena: 'MET Norway at Tena', jatunyacu: 'MET Norway at Jatunyacu', elChaco: 'MET Norway at El Chaco', loreto: 'MET Norway at Loreto', t7: '7Timer (GFS)', metar: 'Coca airport observations', geo: 'GEOGLOWS modelled flow' };
  keys.forEach((k, i) => { if (res[i].status === 'fulfilled') R[k] = res[i].value; else gaps.push((LAB[k] || 'Open-Meteo ' + k.slice(3) + ' model') + ' not reached') });

  // --- Coca, MET Norway (ECMWF-based) ---
  const day = [L0 + 6 * H, L0 + 18 * H], night = [L0 + 18 * H, L0 + 30 * H], tom = [L0 + 30 * H, L0 + 54 * H], tomDay = [L0 + 30 * H, L0 + 42 * H];
  let C = null;
  if (R.coca) {
    C = metRows(R.coca); sources.push({ name: 'MET Norway (ECMWF-based), updated ' + (R.coca.properties.meta.updated_at || '').slice(0, 16).replace('T', ' ') + ' UTC', url: 'https://api.met.no/weatherapi/locationforecast/2.0/' });
    vals.rainDay = sumP(C, ...day, hourNow); vals.rainNight = sumP(C, ...night, hourNow); vals.rainTom = sumP(C, ...tom, hourNow);
    if (hourNow > day[0]) gaps.push('rainDay covers the rest of the day only');
    // rolling 6-hour blocks: each block's next occurrence (today's if at least 2 h of it remain, else tomorrow's), so the four cover the next 24 h
    vals.rainBlockDates = {};
    [['rainNt', 0, 6], ['rainAM', 6, 12], ['rainPM', 12, 18], ['rainEve', 18, 24]].forEach(([k, a, b]) => {
      const off = L0 + b * H - now >= 2 * H ? 0 : DAY, s0 = L0 + a * H + off, e0 = L0 + b * H + off;
      vals[k] = sumP(C, s0, e0, hourNow); vals.rainBlockDates[k] = ecuDate(s0 + H);
    });
    [['cloudAM', 6, 12], ['cloudPM', 12, 18]].forEach(([k, a, b]) => { const v = C.filter(r => r.t >= Math.max(L0 + a * H, hourNow) && r.t < L0 + b * H && isNum(r.cl)).map(r => r.cl); if (v.length) vals[k] = Math.round(v.reduce((x, y) => x + y, 0) / v.length) });
    vals.hourly = C.filter(r => r.t >= Math.max(day[0], hourNow) && r.t < day[1] && !r.coarse).map(r => ({ ts: new Date(r.t).toISOString().slice(0, 19) + 'Z', T: r.T, RH: r.RH, p: r.ps, ws: r.ws, cl: r.cl }));
    if (!vals.hourly.length) delete vals.hourly;
    const nextDay = C.filter(r => r.t >= Math.max(day[0], hourNow) && r.t < day[1]), wwin = nextDay.length ? nextDay : C.filter(r => r.t >= hourNow && r.t < hourNow + 12 * H);
    const tmin = C.filter(r => r.t >= hourNow && r.t < night[1]).map(r => r.T); if (tmin.length) vals.tmin = r1(Math.min(...tmin));
    const tx = C.filter(r => r.t >= day[0] && r.t < day[1] && r.t >= hourNow - 6 * H);
    let best = tx.length ? tx.reduce((a, r) => hx(r.T, r.RH) > hx(a.T, a.RH) ? r : a) : null;
    if (best) { vals.tmax = r1(Math.max(...tx.map(r => r.T))); vals.rh = Math.round(best.RH); vals._hxSrc = 'MET'; vals._bestT = best.T }
    if (wwin.length) { const w = wwin.reduce((a, r) => r.ws > a.ws ? r : a); vals.wind = Math.round(w.ws * 3.6); if (isNum(w.wd)) { vals.windDirDeg = Math.round(w.wd); vals.windDir = compass(w.wd) } }
    const tt = C.filter(r => r.t >= tomDay[0] && r.t < tomDay[1]).map(r => r.T); if (tt.length) vals.tmaxTom = r1(Math.max(...tt));
  } else gaps.push('Coca forecast (MET Norway) missing: rain, temperature and wind not gathered');

  // --- Open-Meteo models at Coca: tmax, 24 h rain, gusts, thunder codes ---
  const omRows = {};
  OM_MODELS.forEach(([lab, m]) => {
    const j = R['om_' + lab]; if (!j || !j.hourly) return;
    const h = j.hourly, pick = k => h[k] || h[k + '_' + m];
    const t = h.time.map(x => Date.parse(x + 'Z')), T = pick('temperature_2m'), P = pick('precipitation'), G = pick('wind_gusts_10m'), W = pick('weather_code'), RHm = pick('relative_humidity_2m');
    if (!T) return;
    omRows[lab] = t.map((tt, i) => ({ t: tt, T: T[i], p: P ? P[i] : null, g: G ? G[i] : null, wc: W ? W[i] : null, RH: RHm ? RHm[i] : null }));
  });
  if (Object.keys(omRows).length) sources.push({ name: 'Open-Meteo (' + Object.keys(omRows).join(', ') + ')', url: 'https://open-meteo.com/' });
  const gustSrc = omRows.ECMWF || omRows.ICON || omRows.GFS;
  if (gustSrc) { const g = gustSrc.filter(r => r.t >= Math.max(day[0], hourNow) && r.t < day[1] && isNum(r.g)).map(r => r.g); if (g.length) vals.gust = Math.round(Math.max(...g)) }

  // --- 7Timer (GFS): warmest daytime pair and instability ---
  let t7 = [];
  if (R.t7 && R.t7.init) {
    const i = R.t7.init, init = Date.UTC(+i.slice(0, 4), +i.slice(4, 6) - 1, +i.slice(6, 8), +i.slice(8, 10));
    t7 = R.t7.dataseries.map(d => ({ t: init + d.timepoint * H, T: d.temp2m, RH: parseFloat(d.rh2m), li: d.lifted_index, w: String(d.weather || ''), pt: d.prec_type }));
    sources.push({ name: '7Timer (GFS-based), init ' + i, url: 'https://www.7timer.info/' });
    const tx = t7.filter(r => r.t >= day[0] && r.t < day[1] && isNum(r.T) && isNum(r.RH));
    if (tx.length) { const b = tx.reduce((a, r) => hx(r.T, r.RH) > hx(a.T, a.RH) ? r : a); if (!isNum(vals._bestT) || hx(b.T, b.RH) > hx(vals._bestT, vals.rh)) { vals.tmax = b.T; vals.rh = Math.round(b.RH); vals._hxSrc = '7Timer' } }
  }
  delete vals._bestT; delete vals._hxSrc;

  // --- thunderstorm categories per window ---
  const ts = ([a, b]) => {
    let n = 0;
    if (C && C.some(r => r.t >= a && r.t < b && /thunder/.test(r.sym))) n++;
    Object.values(omRows).forEach(rows => { if (rows.some(r => r.t >= a && r.t < b && r.wc >= 95)) n++ });
    if (t7.some(r => r.t >= a - 3 * H && r.t < b && /^ts/.test(r.w))) n++;
    if (n >= 2) return 'likely'; if (n === 1) return 'scattered';
    const wet = C && C.filter(r => r.t >= a && r.t < b).reduce((x, r) => x + (r.p || 0), 0) >= 1;
    if (wet && t7.some(r => r.t >= a - 3 * H && r.t < b && r.li <= -4)) return 'isolated';
    return (C || t7.length) ? 'none' : undefined;
  };
  vals.tsDay = ts(day); vals.tsNight = ts(night); vals.tsTom = ts(tomDay);
  Object.keys(vals).forEach(k => vals[k] === undefined && delete vals[k]);

  // --- model comparison ---
  const models = [];
  const cd = C ? C.filter(r => r.t >= day[0] && r.t < day[1]).map(r => r.T) : [];
  if (C) models.push({ label: 'ECMWF', tmax: cd.length ? r1(Math.max(...cd)) : null, rain: isNum(vals.rainDay) || isNum(vals.rainNight) ? r1((vals.rainDay || 0) + (vals.rainNight || 0)) : null, note: timingNote(C, L0, hourNow) });
  ['GFS', 'UKMO', 'ICON'].forEach(lab => {
    const rows = omRows[lab]; if (!rows) return;
    const d = rows.filter(r => r.t >= day[0] && r.t < day[1]).map(r => r.T), p = rows.filter(r => r.t >= Math.max(day[0], hourNow) && r.t < night[1] && isNum(r.p));
    models.push({ label: lab, tmax: d.length ? r1(Math.max(...d)) : null, rain: p.length ? r1(p.reduce((x, r) => x + r.p, 0)) : null, note: timingNote(rows.map(r => ({ t: r.t, p: r.p || 0 })), L0, hourNow) });
  });
  if (!omRows.GFS && t7.length) { const d = t7.filter(r => r.t >= day[0] && r.t < day[1]).map(r => r.T); if (d.length) models.push({ label: 'GFS', tmax: Math.max(...d), rain: null, note: '7Timer' }) }
  if (models.length) vals.models = models; else gaps.push('model comparison');

  // --- river days, 05:00 to 05:00, at Coca and upstream ---
  const P = { coca: C };
  Object.keys(UP).forEach(k => { if (R[k]) P[k] = metRows(R[k]) });
  const days = [];
  for (let k = 0; k <= 5; k++) {
    const a = L0 + 5 * H + k * DAY, b = a + DAY, row = { date: ecuDate(a + 6 * H), win: '05-05', pts: {} };
    if (P.coca) row.coca = sumP(P.coca, a, b, hourNow);
    Object.keys(UP).forEach(p => { if (P[p]) { const v = sumP(P[p], a, b, hourNow); if (v !== null) row.pts[p] = v } });
    const pv = Object.values(row.pts); if (pv.length) row.up = Math.max(...pv);
    days.push(row);
  }
  vals.rainDays = days;
  if (days[0] && isNum(days[0].up)) vals.rainUp = days[0].up;
  if (days[0]) vals.rainUpPts = days[0].pts; if (days[1]) vals.rainUpTomPts = days[1].pts;

  // --- Coca airport METAR, last 24 h ---
  if (Array.isArray(R.metar) && R.metar.length) {
    const ob = R.metar.map(m => ({ t: (m.obsTime ? m.obsTime * 1000 : Date.parse(m.reportTime)), T: m.temp, Td: m.dewp, wd: m.wdir, ws: m.wspd, wx: m.wxString || '' })).filter(m => m.t > now - DAY);
    if (ob.length) {
      const hot = ob.filter(m => isNum(m.T)).reduce((a, m) => (!a || m.T > a.T) ? m : a, null);
      if (hot) { vals.obsTmax = hot.T; if (isNum(hot.Td)) vals.obsTd = hot.Td }
      vals.obsTs = ob.some(m => /(^|\s|\+|-)TS/.test(m.wx) && !/VCTS/.test(m.wx)) ? 'overhead' : ob.some(m => /VCTS/.test(m.wx)) ? 'nearby' : 'none';
      const wmax = ob.filter(m => isNum(m.ws)).reduce((a, m) => (!a || m.ws > a.ws) ? m : a, null);
      vals.obsNote = ob.length + ' airport reports in the last 24 h' + (hot ? '; warmest ' + hot.T + '°C at ' + ecu(hot.t).slice(11) : '') + (wmax ? '; strongest wind ' + Math.round(wmax.ws * 1.852) + ' km/h' + (wmax.wd === 'VRB' ? ', variable' : isNum(+wmax.wd) ? ' from ' + compass(+wmax.wd) : '') + ' at ' + ecu(wmax.t).slice(11) : '') + '.';
      sources.push({ name: 'Coca airport METAR (SECO)', url: 'https://aviationweather.gov/' });
    }
  }

  // --- GEOGLOWS modelled flow ---
  try {
    const g = R.geo, find = (o, k) => o && typeof o === 'object' ? (Array.isArray(o[k]) ? o[k] : Object.values(o).map(v => find(v, k)).find(Boolean)) : null;
    const dt = find(g, 'datetime'), fm = find(g, 'flow_median');
    if (dt && fm) {
      const near = t => { let bi = 0, bd = Infinity; dt.forEach((x, i) => { const d = Math.abs(Date.parse(x.endsWith('Z') || x.includes('+') ? x : x + 'Z') - t); if (d < bd && isNum(fm[i])) { bd = d; bi = i } }); return fm[bi] };
      const a = near(now), b = near(now + DAY);
      if (isNum(a) && isNum(b) && a > 0) { vals.flowNow = r1(a); vals.flow24 = r1(b); vals.riverFlowPct = Math.round((b - a) / a * 100); sources.push({ name: 'GEOGLOWS modelled flow', url: 'https://geoglows.ecmwf.int/' }) }
    }
  } catch (e) {}

  // official INAMHI advisory (PDF at a fixed address)
  try {
    const adv = await readAdvisory(now, fresh);
    Object.assign(vals, adv.vals);
    sources.push({ name: 'INAMHI advisory' + (adv.num ? ' No. ' + adv.num : '') + (adv.active ? ' (in force for Orellana/Napo)' : adv.inForce ? ' (in force, Orellana and Napo not named)' : ' (none in force)'), url: ADV_URL });
  } catch (e) { gaps.push('INAMHI advisory not read: check inamhi.gob.ec') }
  return { fetchedAt: ecu(now).replace(' ', 'T'), by: 'standalone gathering', sources, gaps, vals };
}

export default async (req, context) => {
  const url = new URL(req.url), fresh = url.searchParams.has('fresh'), now = Date.now();
  // a new deploy reads the forecasts afresh instead of serving what the previous version stored
  const dep = (context && context.deploy && context.deploy.id) || '';
  const ua = 'naa-field-assessment/1.0 ' + url.origin;
  const c = await cacheGet('weather');
  if (c && (c.dep || '') === dep && ecuDate(c.ts) === ecuDate(now) && (now - c.ts < (fresh ? 5 : 45) * 60e3)) return json(Object.assign({ cached: true }, c.data));
  try {
    const auto = await gather(now, ua, fresh), data = { auto };
    if (auto.sources.length) await cachePut('weather', { ts: now, dep, data });
    else if (c) return json(Object.assign({ cached: true, stale: true }, c.data));
    return json(data);
  } catch (e) { return c ? json(Object.assign({ cached: true, stale: true }, c.data)) : json({ error: String(e && e.message || e) }, 502) }
};
export const config = { path: '/api/weather' };
