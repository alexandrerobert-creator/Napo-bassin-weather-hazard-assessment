/* Standalone runtime: stands in for the Claude page services. Records and settings stay in this browser (localStorage);
   live data comes from this site's functions (/api/stations, /api/weather); each morning's river forecast and the briefs
   marked as issued are shared with everyone using the site (/api/shared). */
(function () {
  const LS = 'naa:v1:';
  const ls = {
    get(k) { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : null } catch (e) { return null } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)) } catch (e) {} },
    keys(p) { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(LS + p) === 0) out.push(k.slice(LS.length)) } } catch (e) {} return out }
  };
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  const merge = (a, b) => { const o = Object.assign({}, a || {}); Object.keys(b || {}).forEach(k => { o[k] = isObj(b[k]) && isObj(o[k]) ? merge(o[k], b[k]) : b[k] }); return o };
  const ecDate = () => new Date(Date.now() - 5 * 36e5).toISOString().slice(0, 10);
  const subs = { briefs: [], gauges: [], forecasts: [], config: [] }, shared = { briefs: new Map(), forecasts: new Map() };
  let forecastsLoaded = false;
  const api = async (path, opt) => { const r = await fetch(path, Object.assign({ cache: 'no-store' }, opt)); const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status); return j };
  const post = (kind, body) => api('/api/shared?kind=' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function briefDocs() {
    const m = new Map(); shared.briefs.forEach((d, k) => m.set(k, d));
    ls.keys('briefs/').forEach(k => {
      const id = k.slice(7), loc = ls.get(k), sh = m.get(id);
      m.set(id, sh && sh.status === 'issued' && loc.status !== 'issued' ? merge(loc, { status: 'issued', issuedAt: sh.issuedAt, issuedOn: sh.issuedOn, issuedTs: sh.issuedTs, issuedText: sh.issuedText, final: sh.final }) : loc);
    });
    return m;
  }
  const gaugeDocs = () => { const m = new Map(); ls.keys('gauges/').forEach(k => m.set(k.slice(7), ls.get(k))); return m };
  const snapOf = map => ({ docs: [...map.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1).map(([id, d]) => ({ id, data: () => d })) });
  function emit(kind) {
    if (kind === 'forecasts' && !forecastsLoaded) return;
    const map = kind === 'briefs' ? briefDocs() : kind === 'gauges' ? gaugeDocs() : shared.forecasts;
    subs[kind].forEach(f => { try { f(snapOf(map)) } catch (e) { console.error(e) } });
  }
  const emitConfig = () => { const c = ls.get('config/main'); subs.config.forEach(f => f({ exists: !!c, data: () => c })) };

  let pending = null;
  function loadLive(fresh) {
    if (pending) return pending;
    const q = fresh ? '?fresh=1' : '';
    pending = Promise.allSettled([api('/api/stations' + q), api('/api/weather' + q)]).then(([st, wx]) => {
      const date = ecDate(), key = 'briefs/' + date, doc = Object.assign({ date, status: 'draft', createdTs: Date.now() }, ls.get(key) || {});
      if (st.status === 'fulfilled' && st.value.gauge) {
        doc.gauge = st.value.gauge;
        if (st.value.history) ls.set('gauges/' + st.value.history.date, st.value.history);
        if (st.value.coords) { window.NAA_COORDS = st.value.coords; ls.set('coords', st.value.coords) }
      }
      if (wx.status === 'fulfilled' && wx.value.auto) doc.auto = wx.value.auto;
      ls.set(key, doc); emit('briefs'); emit('gauges');
      window.NAA_LIVE = { at: Date.now(), stations: st.status === 'fulfilled', weather: wx.status === 'fulfilled', errors: [st, wx].filter(x => x.status === 'rejected').map(x => String(x.reason && x.reason.message)) };
      return window.NAA_LIVE;
    }).finally(() => { pending = null });
    return pending;
  }
  async function loadShared() {
    try { const j = await api('/api/shared?kind=briefs'); shared.briefs = new Map(j.items.map(x => [x.date, x])); emit('briefs') } catch (e) {}
    try { const j = await api('/api/shared?kind=forecasts'); shared.forecasts = new Map(j.items.map(x => [x.date, x])); forecastsLoaded = true; emit('forecasts') } catch (e) {}
  }

  function docRef(path) {
    const parts = path.split('/'), col = parts[0], id = parts[1];
    const after = d => {
      if (col === 'briefs') { emit('briefs'); if (d.status === 'issued') post('briefs', Object.assign({}, d, { date: id })).then(() => { shared.briefs.set(id, d) }).catch(() => {}) }
      else if (col === 'config') emitConfig();
    };
    return {
      async get() { const d = ls.get(path); return { exists: !!d, data: () => d } },
      async set(data) {
        if (col === 'forecasts') { await post('forecasts', data); if (!shared.forecasts.has(id)) shared.forecasts.set(id, data); emit('forecasts'); return }
        ls.set(path, data); after(data);
      },
      async update(data) { const next = merge(ls.get(path), data); ls.set(path, next); after(next) },
      onSnapshot(cb) { if (col === 'config') { subs.config.push(cb); setTimeout(emitConfig, 0) } return () => {} }
    };
  }
  const db = {
    doc: docRef,
    collection(name) { const q = { orderBy() { return q }, limit() { return q }, onSnapshot(cb) { if (subs[name]) { subs[name].push(cb); setTimeout(() => emit(name), 0) } return () => {} } }; return q }
  };
  // Refresh: the page asks to start its two gathering tasks; here both are one live read
  const mcp = { async callTool(server, tool) { if (tool !== 'fire_trigger') throw { code: 'bad_request', message: 'unknown tool' }; loadLive(true); return {} } };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.pdf$/.test(filename) ? 'application/pdf' : /\.csv$/.test(filename) ? 'text/csv' : 'application/octet-stream' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 4000); return true;
    }
  };
  try { const c = ls.get('coords'); if (c) window.NAA_COORDS = c } catch (e) {}
  let started = false;
  window.claude = { use: async name => {
    if (name === 'db') { if (!started) { started = true; setTimeout(() => { loadLive(false); loadShared() }, 0); setInterval(() => { if (document.visibilityState === 'visible') loadLive(false) }, 15 * 60e3) } return db }
    return { mcp, downloads }[name] || null;
  } };
  window.NAA_STANDALONE = true;
})();
