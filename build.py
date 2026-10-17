# Builds the standalone page (public/index.html) from the Claude page source plus the standalone runtime (shim.js).
import re, sys, os
src = open(sys.argv[1]).read(); shim = open(os.path.join(os.path.dirname(__file__), 'shim.js')).read()
def rep(a, b, n=1):
    global src
    c = src.count(a)
    if c != n: raise SystemExit('pattern count %d != %d: %s' % (c, n, a[:80]))
    src = src.replace(a, b)
rep("issueTime: '06:30', shootDate: '' };", "issueTime: '06:30', shootDate: '2026-10-26' };")
rep('INAMHI stations: read at 05:05, and again each time you press Refresh, from the INAMHI Visor through the browser on your computer (it needs the computer awake with the Claude app open; the reading takes a few minutes and appears here by itself):',
    'INAMHI stations: read from the INAMHI Visor by this site\'s server each time the page opens, every 15 minutes while it stays open, and when you press Refresh:')
src = re.sub(r'<li>Gathered sources:.*?</li>', '<li>Gathered sources, read each time the page opens and when you press Refresh: MET Norway (ECMWF-based) hourly forecasts at Coca and the four upstream points; Open-Meteo for the model comparison (ECMWF, GFS, UKMO, ICON) and gusts; 7Timer (GFS-based) for instability; Coca airport METAR; GEOGLOWS modelled flow. The official INAMHI advisory is read automatically from its bulletin (inamhi.gob.ec/pronostico/advertencia.pdf) and marked in force when it covers Orellana or Napo; SNGR alerts are not read, so check them yourself. The day\'s brief is shared: entries, edits and Issue appear for everyone using this site within about 30 seconds, and if two people change the same field the last save wins. Live readings are read by each device; the launch day and header settings stay in this browser; each day\'s river forecast is kept for everyone.</li>', src, count=1, flags=re.S)
rep("No station readings for this date yet. They are read from the INAMHI Visor at 05:05 and when you press Refresh, if your computer is on with the Claude app open.", "No station readings for this date yet: the INAMHI Visor did not answer. Press Refresh to try again.")
rep("'Gathering the weather forecasts again in the cloud, started ' + now.hm + '. They appear here by themselves in about 3 to 6 minutes.'", "'Gathering the weather forecasts, started ' + now.hm + '.'")
rep("'No new forecast gathering arrived yet. Press Refresh again later; the 05:10 gathering still runs as usual.'", "'The forecasts were not updated. Press Refresh again in a few minutes.'")
rep("'Reading the INAMHI stations through the Claude app on your computer, started ' + now.hm + '. The new readings appear here by themselves in about 2 to 5 minutes.'", "'Reading the INAMHI stations, started ' + now.hm + '.'")
rep("'No new station reading arrived. Your computer may be asleep or the Claude app closed: wake it, open the app and press Refresh again, or enter the level from the INAMHI Visor.'", "'The INAMHI stations did not answer. Press Refresh again in a few minutes, or enter the level from the INAMHI Visor.'")
rep("saveState('Saved ' + ecNow().hm);", "saveState((window.NAA_SHARED_ERR ? 'Saved on this device, sharing when the connection returns, ' : 'Saved and shared, ') + ecNow().hm);")
rep("const STATION_WAIT = 8 * 60e3, STATION_GAP = 3 * 60e3;", "const STATION_WAIT = 90e3, STATION_GAP = 60e3;")
rep("FORECAST_WAIT = 15 * 60e3, FORECAST_GAP = 10 * 60e3;", "FORECAST_WAIT = 90e3, FORECAST_GAP = 60e3;")
rep("hint: 'INAMHI and SNGR', custom:", "hint: '<a class=\"ext\" href=\"https://www.inamhi.gob.ec/\" target=\"_blank\" rel=\"noopener\">INAMHI ↗</a> · <a class=\"ext\" href=\"https://www.gestionderiesgos.gob.ec/\" target=\"_blank\" rel=\"noopener\">SNGR ↗</a>', custom:")
rep("function stationMap(gg) {", "function stationMap(gg) {\n  if (typeof window !== 'undefined' && window.NAA_COORDS) Object.entries(window.NAA_COORDS).forEach(([c, v]) => { if (STMAP[c] && isFinite(v.lat) && isFinite(v.lon)) { STMAP[c].lat = v.lat; STMAP[c].lon = v.lon; STMAP[c].exact = 1 } });")
rep("<p class=\"reach\">Daily weather and hazard record · all times Ecuador (UTC−5)</p>", "<p class=\"reach\">Daily weather and hazard record · all times Ecuador (UTC−5) · standalone version</p>")
# insert the runtime before the page script
i = src.index('<script>\n/*PURE-START*/')
src = src[:i] + '<script>\n' + shim + '\n</script>\n' + src[i:]
m = re.search(r'<title>.*?</title>\n?', src); title = m.group(0) if m else '<title>NAA Field Assessment</title>'
src = src.replace(title, '', 1)
head = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="theme-color" content="#0f5c5c">\n' + title.strip() + '\n<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%226%22 fill=%22%230f5c5c%22/%3E%3Cpath d=%22M4 20c4-4 8 4 12 0s8 4 12 0%22 stroke=%22%23fff%22 stroke-width=%223%22 fill=%22none%22/%3E%3C/svg%3E">\n<style>body{margin:0}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
os.makedirs(os.path.join(os.path.dirname(__file__), 'public'), exist_ok=True)
open(os.path.join(os.path.dirname(__file__), 'public', 'index.html'), 'w').write(head + src + '\n</body>\n</html>\n')
print('built', len(src))
