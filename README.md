# NAA Daily Field Assessment — standalone version

Napo Basin daily weather and hazard assessment for Coca HQ, the Napo River corridor and Yarina FOB.
Runs on Netlify with no Claude account and no computer left on.

## What runs where
- `public/index.html` — the tool. Your entries, settings and launch day stay in each person's browser.
- `netlify/functions/stations.mjs` (`/api/stations`) — reads the INAMHI Visor from Netlify's server: levels at H1135, H1134, H0719, H0728; rain at H1135, M5189, M5187, M5190, M1124, M0008; 9 days of hourly level and rain at H1135; exact station coordinates. `stations-refresh` reads INAMHI every 15 minutes, asking only for the last 2 days and adding them to the stored series. Cached 10 minutes (2 minutes when Refresh is pressed). A station that fails keeps its last reading for up to 12 h, listed in the errors.
  - `/api/stations?diag=1` shows the last 30 reading runs (which stations answered, errors) and asks INAMHI once per level station right away: open it in a browser when the readings stop.
- `netlify/functions/weather.mjs` (`/api/weather`) — MET Norway hourly forecasts at Coca and four upstream points (Tena, Jatunyacu, El Chaco, Loreto), Open-Meteo models (ECMWF, GFS, UKMO, ICON), 7Timer, Coca airport METAR, GEOGLOWS. Cached 45 minutes (5 minutes on Refresh).
- `netlify/functions/shared.mjs` (`/api/shared`) — shared with everyone using the site, in Netlify Blobs: each morning's five-day river forecast (first one of the day is kept) and briefs marked as issued.

## Deploy or update
Connected GitHub repository: replace the files with this folder's contents and commit; Netlify rebuilds by itself.
Netlify CLI: `npx netlify-cli deploy --prod` from this folder.
Netlify installs `@netlify/blobs` from `package.json` during the build; nothing else to configure.

## Not automatic in this version
Official INAMHI and SNGR advisories: check them and tick the box in the Official advisory card.
