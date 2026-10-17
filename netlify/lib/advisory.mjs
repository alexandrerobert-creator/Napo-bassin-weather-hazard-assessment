// INAMHI weather advisory: the current bulletin is published at a fixed address as a PDF with real text.
// Read it, pull out number, status, validity, threat level and the Amazon lines, and say whether it covers Orellana or Napo.
import { getDocumentProxy, extractText } from 'unpdf';
import { cacheGet, cachePut } from './common.mjs';

export const ADV_URL = 'https://www.inamhi.gob.ec/pronostico/advertencia.pdf';
const MES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const MON = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const LEVEL = { 'MUY ALTO': 'very high', ALTO: 'high', MEDIO: 'medium', BAJO: 'low' };
const lvl = s => String(s || '').toUpperCase().split(/\s*[–-]\s*/).map(x => LEVEL[x.trim()] || x.trim().toLowerCase()).join(' to ');
const PHEN = [[/LLUVIAS?/i, 'rain'], [/TORMENTAS? EL[ÉE]CTRICAS?/i, 'thunderstorms'], [/R[ÁA]FAGAS DE VIENTO/i, 'wind gusts'], [/GRANIZO/i, 'hail'], [/NIEBLA/i, 'fog'], [/TEMPERATURAS? ALTAS?|CALOR/i, 'high temperatures']];
const clean = s => String(s || '').replace(/-\s+(?=[a-záéíóúñ])/g, '').replace(/\s+/g, ' ').trim();

// ms for "Ecuador local time" (UTC-5) of a given day and hour
const ecMs = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h + 5, mi);

export function parseAdvisory(raw, now) {
  const t = clean(raw);
  const g = (re, i = 1) => { const m = t.match(re); return m ? m[i] : null };
  const num = g(/Nro\.?\s*(\d+)/i), status = g(/Estatus:\s*([A-ZÁÉÍÓÚÑ ]+?)\s+PREDICCI/i) || g(/Estatus:\s*([A-ZÁÉÍÓÚÑ]+)/i);
  const issued = g(/emisi[óo]n:\s*(.+?)\s+Vigencia/i);
  const v = t.match(/Vigencia:\s*desde\s*(?:las\s*)?(\d{1,2})H(\d{2})\s*del\s*(\d{1,2})(?:\s*de\s*([a-záéíóú]+))?(?:\s*de\s*(\d{4}))?\s*hasta\s*(?:las\s*)?(\d{1,2})H(\d{2})\s*del\s*(\d{1,2})\s*de\s*([a-záéíóú]+)\s*de\s*(\d{4})/i);
  let from = null, to = null, period = '';
  if (v) {
    const y = +v[10], m2 = MES[v[9].toLowerCase()], m1 = v[4] ? MES[v[4].toLowerCase()] : m2, y1 = v[5] ? +v[5] : y;
    from = ecMs(y1, m1, +v[3], +v[1], +v[2]); to = ecMs(y, m2, +v[8], +v[6], +v[7]);
    period = m1 === m2 ? MON[m1] + ' ' + (+v[3]) + '–' + (+v[8]) : MON[m1] + ' ' + (+v[3]) + '–' + MON[m2] + ' ' + (+v[8]);
  }
  const threat = g(/NIVEL\s+(?:DE\s+)?AMENAZA:\s*(.+?)\s+FEN[ÓO]MENO/i);
  const phen = g(/FEN[ÓO]MENO:\s*(.+?)\s+DESCRIPCI[ÓO]N/i) || '';
  const amazon = g(/Regi[óo]n Amaz[óo]nica:\s*(.+?)(?=\s*•|\s+Regi[óo]n Insular|\s+Secretar|$)/i);
  const peak = g(/(Los eventos de mayor intensidad .+?\.)/i);
  const floods = g(/(Riesgo de crecidas .+?)(?=\s*•|\s+ZONAS AFECTADAS|$)/i);
  const rain = t.match(/Amazon[ií]a\s*(\d+)\s*[–-]\s*(\d+)\s*(\d+)\s*[–-]\s*(\d+)(?:\s*(\d+)\s*[–-]\s*(\d+))?/i);
  const covers = amazon && /Orellana|Napo/i.test(amazon), named = covers ? ['Orellana', 'Napo'].filter(x => new RegExp(x, 'i').test(amazon)) : [];
  const inForce = from !== null && to !== null && now >= from - 6 * 36e5 && now <= to;
  const out = { num, status, issued, from, to, period, threat, phenomenon: phen, amazon, peak, floods, covers, inForce, url: ADV_URL };
  out.active = !!(inForce && covers);
  if (out.active) {
    const what = PHEN.filter(p => p[0].test(phen)).map(p => p[1]);
    const lines = [];
    lines.push('INAMHI bulletin No. ' + num + (status ? ' (' + status.toLowerCase() + ')' : '') + ': ' + (what.length ? what.join(', ') : clean(phen).toLowerCase()) + (threat ? '; threat level ' + lvl(threat) : '') + '.');
    lines.push('Amazon region, as issued: "' + amazon.replace(/\s*[.;]\s*$/, '') + '" (' + named.join(' and ') + ' named).');
    if (rain) lines.push('Expected daily rain in the Amazon: ' + rain[1] + '–' + rain[2] + ' mm at the medium level, ' + rain[3] + '–' + rain[4] + ' mm at the high level' + (rain[5] ? ', ' + rain[5] + '–' + rain[6] + ' mm very high' : '') + '.');
    if (peak) lines.push('Peak periods, as issued: "' + peak.replace(/\.$/, '') + '".');
    lines.push(floods && /Orellana|Napo|Amaz/i.test(floods) ? 'River rises flagged: "' + floods + '".' : 'No river-rise risk named for Orellana or Napo.');
    out.vals = { advActive: true, advTitle: 'WEATHER WARNING ADVISORY', advPeriod: period, advText: lines.join('\n'), advSource: 'INAMHI Boletín Meteorológico Nro. ' + num + (issued ? ', issued ' + issued : '') + ', read from inamhi.gob.ec/pronostico/advertencia.pdf' };
  } else out.vals = { advActive: false };
  return out;
}

export async function readAdvisory(now, fresh) {
  const c = await cacheGet('advisory');
  if (c && now - c.ts < (fresh ? 15 : 60) * 60e3) return c.data;
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(ADV_URL, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (NAA field assessment)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    const pdf = await getDocumentProxy(buf), { text } = await extractText(pdf, { mergePages: true });
    const data = parseAdvisory(Array.isArray(text) ? text.join('\n') : text, now);
    data.lastModified = r.headers.get('last-modified');
    await cachePut('advisory', { ts: now, data });
    return data;
  } finally { clearTimeout(tm) }
}
