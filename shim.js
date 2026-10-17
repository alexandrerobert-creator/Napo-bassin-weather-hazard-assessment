/* Standalone runtime: stands in for the Claude page services. Live data comes from this site's functions
   (/api/stations, /api/weather) and is read by each browser. Shared with everyone using the site (/api/shared):
   the day's brief (entries, status, issued text), saved field by field and re-read every 30 s, and each day's
   river forecast. Settings (launch day, header) stay in this browser (localStorage). */
(function () {
  const LS = 'naa:v1:';
  const ls = {
    get(k) { try { const v = localStorage.getItem(LS + k); return v ? JSON.parse(v) : null } catch (e) { return null } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)) } catch (e) {} },
    del(k) { try { localStorage.removeItem(LS + k) } catch (e) {} },
    keys(p) { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(LS + p) === 0) out.push(k.slice(LS.length)) } } catch (e) {} return out }
  };
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  const merge = (a, b) => { const o = Object.assign({}, a || {}); Object.keys(b || {}).forEach(k => { o[k] = isObj(b[k]) && isObj(o[k]) ? merge(o[k], b[k]) : b[k] }); return o };
  const ecDate = () => new Date(Date.now() - 5 * 36e5).toISOString().slice(0, 10);
  const subs = { briefs: [], gauges: [], forecasts: [], config: [] }, shared = { briefs: new Map(), forecasts: new Map(), drafts: new Map() };
  const TOP = ['status', 'issuedAt', 'issuedOn', 'issuedTs', 'issuedText', 'final', 'createdTs'];
  let postGen = 0;
  let forecastsLoaded = false;
  const api = async (path, opt) => { const r = await fetch(path, Object.assign({ cache: 'no-store' }, opt)); const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status); return j };
  const post = (kind, body) => api('/api/shared?kind=' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // local doc (live data read on this device) + shared draft (common entries) + outbox (this device's saves not yet confirmed)
  function briefDocs() {
    const m = new Map(), ids = new Set([...shared.briefs.keys(), ...shared.drafts.keys(), ...ls.keys('briefs/').map(k => k.slice(7)), ...ls.keys('outbox/').map(k => k.slice(7))]);
    ids.forEach(id => {
      let d = Object.assign({ date: id }, ls.get('briefs/' + id) || {});
      const old = shared.briefs.get(id), dr = shared.drafts.get(id), ob = ls.get('outbox/' + id);
      if (old && !dr && old.status === 'issued') d = merge(d, { man: old.man || {}, status: 'issued', issuedAt: old.issuedAt, issuedOn: old.issuedOn, issuedTs: old.issuedTs, issuedText: old.issuedText, final: old.final });
      [dr, ob].forEach(x => { if (!x) return; d.man = Object.assign({}, d.man || {}, x.man || {}); TOP.forEach(k => { if (k in x) d[k] = x[k] }) });
      if (!d.status) d.status = 'draft';
      m.set(id, d);
    });
    return m;
  }
  function draftPart(data) { const o = {}; if (data.man && typeof data.man === 'object') o.man = Object.assign({}, data.man); TOP.forEach(k => { if (k in data) o[k] = data[k] }); return Object.keys(o).length ? o : null }
  const sending = new Set();
  async function sendOutbox(id) {
    if (sending.has(id)) return; const ob = ls.get('outbox/' + id); if (!ob) return;
    sending.add(id);
    try {
      const j = await post('drafts', Object.assign({ date: id }, ob));
      if (j.item) shared.drafts.set(id, j.item);
      postGen++;
      // drop what was sent unless it changed meanwhile
      const now = ls.get('outbox/' + id) || {}; const left = { man: {} };
      Object.keys(now.man || {}).forEach(k => { if (!ob.man || JSON.stringify(ob.man[k]) !== JSON.stringify(now.man[k])) left.man[k] = now.man[k] });
      TOP.forEach(k => { if ((k in now) && JSON.stringify(now[k]) !== JSON.stringify(ob[k])) left[k] = now[k] });
      if (Object.keys(left.man).length || Object.keys(left).length > 1) ls.set('outbox/' + id, left); else ls.del('outbox/' + id);
      window.NAA_SHARED_ERR = null;
    } catch (e) { window.NAA_SHARED_ERR = String(e && e.message || e) } finally { sending.delete(id) }
    emit('briefs');
    if (ls.get('outbox/' + id) && !window.NAA_SHARED_ERR) setTimeout(() => sendOutbox(id), 300);
  }
  const retryOutbox = () => ls.keys('outbox/').forEach(k => sendOutbox(k.slice(7)));
  async function pollDraft(id) {
    const gen = postGen;
    try { const j = await api('/api/shared?kind=drafts&date=' + id); if (gen !== postGen) return; const d = j.items && j.items[0]; const before = JSON.stringify(shared.drafts.get(id) || null); if (d) shared.drafts.set(id, d); if (JSON.stringify(d || null) !== before) emit('briefs') } catch (e) {}
  }
  const gaugeDocs = () => { const m = new Map(); ls.keys('gauges/').forEach(k => m.set(k.slice(7), ls.get(k))); return m };
  const snapOf = map => ({ docs: [...map.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1).map(([id, d]) => ({ id, data: () => d })) });
  function emit(kind) {
    if (kind === 'forecasts' && !forecastsLoaded) return;
    const map = kind === 'briefs' ? briefDocs() : kind === 'gauges' ? gaugeDocs() : shared.forecasts;
    subs[kind].forEach(f => { try { f(snapOf(map)) } catch (e) { console.error(e) } });
  }
  const emitConfig = () => { const c = ls.get('config/main'); subs.config.forEach(f => f({ exists: !!c, data: () => c })) };

  let pending = null, retried = false;
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
      if (st.status === 'fulfilled' && st.value.stale) window.NAA_LIVE.stale = st.value.staleReason || 'INAMHI did not answer';
      // INAMHI can be slow: try the stations once more after 20 s
      if ((st.status === 'rejected' || window.NAA_LIVE.stale) && !retried) { retried = true; setTimeout(() => { loadLive(true).finally(() => { retried = false }) }, 20e3) }
      return window.NAA_LIVE;
    }).finally(() => { pending = null });
    return pending;
  }
  async function loadShared() {
    try { const j = await api('/api/shared?kind=briefs'); shared.briefs = new Map(j.items.map(x => [x.date, x])) } catch (e) {}
    try { const gen = postGen, j = await api('/api/shared?kind=drafts'); if (gen === postGen) shared.drafts = new Map(j.items.map(x => [x.date, x])) } catch (e) {}
    emit('briefs'); retryOutbox();
    try { const j = await api('/api/shared?kind=forecasts'); shared.forecasts = new Map(j.items.map(x => [x.date, x])); forecastsLoaded = true; emit('forecasts') } catch (e) {}
  }

  function queueDraft(id, data) {
    const part = draftPart(data); if (!part) return;
    const ob = ls.get('outbox/' + id) || { man: {} }; ob.man = Object.assign({}, ob.man || {}, part.man || {}); TOP.forEach(k => { if (k in part) ob[k] = part[k] });
    ls.set('outbox/' + id, ob); setTimeout(() => sendOutbox(id), 0);
  }
  function docRef(path) {
    const parts = path.split('/'), col = parts[0], id = parts[1];
    const after = d => {
      if (col === 'briefs') emit('briefs');
      else if (col === 'config') emitConfig();
    };
    return {
      async get() { const d = ls.get(path); return { exists: !!d, data: () => d } },
      async set(data) {
        if (col === 'briefs') queueDraft(id, data);
        if (col === 'forecasts') { await post('forecasts', data); if (!shared.forecasts.has(id)) shared.forecasts.set(id, data); emit('forecasts'); return }
        ls.set(path, data); after(data);
      },
      async update(data) { if (col === 'briefs') queueDraft(id, data); const next = merge(ls.get(path), data); ls.set(path, next); after(next) },
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
    if (name === 'db') { if (!started) { started = true; setTimeout(() => { loadLive(false); loadShared() }, 0); setInterval(() => { if (document.visibilityState === 'visible') loadLive(false) }, 15 * 60e3); setInterval(() => { if (document.visibilityState === 'visible') { pollDraft(ecDate()); retryOutbox() } }, 30e3); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { pollDraft(ecDate()); retryOutbox() } }) } return db }
    return { mcp, downloads }[name] || null;
  } };
  window.NAA_STANDALONE = true;
})();
