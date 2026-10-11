# CLAUDE.md — Dedavi_Travels

Static site (GitHub Pages, repo `dedavi97/Dedavi_Travels`) showing visited places on a MapLibre globe, plus stats and about views. Embedded in Google Sites via "Embed by URL" (iframe).

## Rules
- Code, comments, UI text, docs: **English**. Talk to the owner (Davide, not a developer) in **Italian**, plain language.
- Vanilla HTML/CSS/JS, no framework, no build step. CDN libs pinned to exact versions.
- SemVer in `assets/js/version.js` (`APP_VERSION`). PATCH = fix, MINOR = feature, MAJOR = breaking. Bump only for commits that change executed code; data-only (sync) and doc-only commits: no bump.
- Keep README.md (owner-facing, simple) and this file updated on every relevant change.
- **Never push without Davide's explicit approval.**

## Layout
- `index.html` — single page; hash routes `#/globe`, `#/stats`, `#/about`; deep link `#/globe?place=<id>`.
- `assets/js/app.js` — global `DT`: data loading (`data/places.json`, `data/sync_status.json`), router, helpers (`DT.flag`, `DT.escape`, `DT.store` = try/catch localStorage, `DT.haversineKm`). Views register on `DT.views.<name>` with `show(el, params)` / optional `hide()`.
- `assets/js/globe.js` — MapLibre 5.24.0 style built in code (no basemap, no glyphs: cluster counts are HTML markers; country names are a DOM tooltip). Visited fill = Natural Earth `ADM0_A3` units in `place.unit`. Faint `subdivisions` line layer (first-level internal boundaries). Lakes (fill) + rivers (line, shown when `rank <= zoom + 2`) from `water.geojson`; land/visited colours vary slightly by country `tone` (NE MAPCOLOR7 % 4) so neighbours differ. maxZoom 9 (simplified borders get blocky beyond). These were added because the plain map looked "uncanny" to Davide. Clustering: radius 26 px, max zoom 5 (Davide wanted groups to split early). Projection toggle uses a CSS crossfade (MapLibre only morphs projections by zoom); choice saved in localStorage `dt.projection`. Globe is fitted to the viewport after load by measuring projected limb points (`fitGlobe`). Auto-rotation stops on first interaction; disabled with prefers-reduced-motion.
- `assets/js/stats.js` — all stats computed client-side. UN list = 193 members + VA + PS. Home = Turin. DC is not counted in US states x/50.
- `assets/css/style.css` — dark theme, accent `#f2b544`. Layout fills the iframe with `height:100%` flex (no 100vh). ≤640px: tabs fixed at the bottom.

## Data pipeline (`scripts/sync.py`, Python 3.12 + shapely)
- Normal: KML from `https://www.google.com/maps/d/kml?mid=$MYMAPS_ID&forcekml=1` (`parse_map_id` also accepts a full My Maps link in the secret), only folder `LAYER_NAME = "Visitati"`. Bootstrap: `--from-csv data/source/visitati.csv` (CSV is git-ignored).
- Failure (download, missing layer → lists layers found, 0 points, missing secret): places.json untouched, status `error`, exit 1. `sync_status.json.last_check` is always updated.
- Names: key = `name|lat5|lon5`. Order: `name_overrides.json` (by key or plain original name) → `name_cache.json` → Nominatim search (bounded ±0.5° viewbox, `namedetails` name:en) → reverse zoom 10 → original. ≥1.1 s between requests, UA with repo URL. Network failures are not cached (retried next run). Report: `data/name_report.md` (also lists location notes).
- Geography: Natural Earth 10m admin-0 countries, **Italian point of view** (`ne_10m_admin_0_countries_ita`: Crimea in Ukraine, Northern Cyprus in Cyprus, Somaliland in Somalia; Davide asked for Crimea in Ukraine) + admin-1 (downloaded to `.cache/naturalearth/` by `scripts/naturalearth.py`, cached in Actions). Sovereign via `SOVEREIGNT` (+ `SOVEREIGN_OVERRIDES`: Palestine). Dependency = `ADMIN != SOVEREIGNT`. Subdivisions only for `SUBDIVISIONS` (ITA region field → English names, USA states, GBR geonunit). Points outside polygons snap to the nearest within 25 km. Border pins: NE borders are off by a few hundred metres (Gorizia, Schengen, Vianden, Narva were wrong), so each pin's OSM country code (Nominatim reverse zoom 3, cached forever in `data/country_cache.json`) wins when it disagrees with NE and a matching unit is within 25 km. `data/location_overrides.json` (`"name": "ADM0_A3"`) still forces a unit as a last resort (currently empty).
- places.json is rewritten only if content changed (then `last_data_change` updates). Place `id` = first 10 hex of sha1(key).
- `scripts/build_geo.py` regenerates `data/geo/countries.geojson` (~1.8 MB, size-aware simplification keeps microstates) and `data/geo/subdivisions.geojson` (~1.2 MB: internal admin-1 boundaries; NE units merged by `SUB_GROUPING` where they are second-level, e.g. Italian provinces → regions, GBR → nations; outlines/coasts removed). Also `data/geo/water.geojson` (~1 MB: NE 10m lakes scalerank ≤ 7, rivers scalerank ≤ 6).
- Workflow `.github/workflows/sync.yml`: cron `0 6 1,15 * *` + manual; commits `data/` as github-actions bot with `data: sync YYYY-MM-DD` (commit step runs even on failure).

## Local testing
`run.bat` (or `python -m http.server 8000`) then http://localhost:8000. Pipeline: `pip install -r scripts/requirements.txt`, `python -X utf8 scripts/sync.py --from-csv data/source/visitati.csv`.
