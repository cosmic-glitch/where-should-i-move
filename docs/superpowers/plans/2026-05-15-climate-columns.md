# Climate Columns Implementation Plan (revised — NOAA)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two default-hidden columns to the places table — January and July mean temperature — sourced from NOAA's 1991–2020 U.S. Climate Normals at dataset-build time.

**Architecture:** The build script downloads two NOAA bulk files (a station inventory with lat/lon and a monthly-temperature archive), builds a station list, and matches each place to its nearest station by great-circle distance, baking `janTempF`/`julTempF` into `data/places.js`. The app wires the two fields as numeric columns exactly like the existing `popDensity` column.

**Tech Stack:** Vanilla JS (no build, no deps), Node ESM build script, NOAA NCEI Climate Normals bulk files.

---

## Revision history

This plan was originally written for a three-column Open-Meteo design (Jan temp, Jul temp, sunny days). Implementation reached the dataset-regeneration step and Open-Meteo's free tier could not handle 8,036 places (sustained HTTP 429s after ~150). The design was revised with the user: **two columns** (Jan/Jul temp), **NOAA Climate Normals** source, **sunny-days dropped**. See `docs/superpowers/specs/2026-05-15-climate-columns-design.md`.

**Already complete and unchanged** (do not redo): `scripts/fetch_places.mjs` already parses each place's interior-point lat/lon from the Census Gazetteer and attaches transient `_lat`/`_lon` fields. The NOAA loader depends on `_lat`/`_lon` — they are already there.

The tasks below (A, B, C) replace the Open-Meteo work with the NOAA approach.

## Context for the implementer

This repo is a static web app — no build system, no tests, no `package.json`. Verification is limited by project policy (`CLAUDE.md`):
- For `index.html`: the JS-parse sanity check (below).
- For `scripts/fetch_places.mjs`: `node --check scripts/fetch_places.mjs`.
- Do NOT start a web server or browser.

**JS-parse sanity check** (run after every `index.html` edit):

```bash
node -e "const m = require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g); new Function(m[m.length-1].replace(/^<script>|<\/script>$/g, '')); console.log('OK')"
```

Expected output: `OK`

The two fields are `janTempF` and `julTempF` (integer °F, or `null` when a place has no Gazetteer lat/lon). `null` renders as "—".

---

## Task A: Replace the Open-Meteo climate code with a NOAA normals loader

`scripts/fetch_places.mjs` currently contains an Open-Meteo climate block (`aggregateClimate`, `fetchClimateBatch`, `loadClimate`, plus `CLIMATE_*` constants and a `sleep` helper). Replace that entire block with a NOAA loader. The new `loadClimate(places)` keeps the same name and signature, so its call site in `main()` (`await loadClimate(all);`) is unchanged.

**Files:**
- Modify: `scripts/fetch_places.mjs`
- Modify: `.gitignore`
- Delete: `scripts/.climate-cache.json` (stale Open-Meteo cache, gitignored)

- [ ] **Step 1: Revert the `existsSync` import**

The NOAA loader does not use `existsSync`. Change the fs import line back from:

```js
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
```

to:

```js
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
```

- [ ] **Step 2: Replace the climate block**

Read `scripts/fetch_places.mjs` and locate the climate block: it starts at the banner comment line `// ── Climate ──────…` and ends at the closing `}` of the `loadClimate` function (the next code after it is the `// For county subdivisions` comment). Delete that entire block — the banner comment, the `CLIMATE_START`/`CLIMATE_END`/`CLIMATE_YEARS` constants, the `sleep` helper, and the three functions `aggregateClimate`, `fetchClimateBatch`, `loadClimate` — and replace it with exactly this:

```js
// ── Climate ────────────────────────────────────────────────────────────────
// Per-place January and July mean temperature (°F) from NOAA's 1991-2020 U.S.
// Climate Normals (monthly product). Two bulk files are downloaded once: a
// station inventory (lat/lon) and a temperature archive. Each place is matched
// to its nearest normals station by great-circle distance. No API key, no
// rate limits.
const NOAA_INVENTORY_URL =
  "https://www.ncei.noaa.gov/data/normals-monthly/1991-2020/doc/inventory_30yr.txt";
const NOAA_TEMP_ARCHIVE_URL =
  "https://www.ncei.noaa.gov/data/normals-monthly/1991-2020/archive/" +
  "us-climate-normals_1991-2020_v1.0.1_monthly_temperature_by-variable_c20230403.tar.gz";

// Parse inventory_30yr.txt → Map<stationId, {lat, lon}>. Each line is
// whitespace-delimited: ID, latitude, longitude, elevation, state, name…
function parseStationInventory(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    const id = f[0];
    const lat = parseFloat(f[1]);
    const lon = parseFloat(f[2]);
    if (id && Number.isFinite(lat) && Number.isFinite(lon)) map.set(id, { lat, lon });
  }
  return map;
}

// Parse mly-normal-allall.csv → Map<stationId, {jan, jul}> in °F. One row per
// station per month; columns are looked up by header name; rows whose
// measurement flag is "M" (missing) are skipped.
function parseMonthlyTavg(csv) {
  const lines = csv.split(/\r?\n/);
  const header = lines[0].split(",").map(s => s.replace(/^"|"$/g, "").trim());
  const idIdx    = header.indexOf("STATION");
  const monthIdx = header.indexOf("month");
  const tavgIdx  = header.indexOf("MLY-TAVG-NORMAL");
  const flagIdx  = header.indexOf("meas_flag_MLY-TAVG-NORMAL");
  if (idIdx < 0 || monthIdx < 0 || tavgIdx < 0 || flagIdx < 0) {
    throw new Error(`NOAA normals: missing expected columns (header was ${header.join("|")})`);
  }
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const p = lines[i].split(",").map(s => s.replace(/^"|"$/g, "").trim());
    if (p.length <= flagIdx) continue;
    const month = p[monthIdx];
    if (month !== "01" && month !== "07") continue;
    if (p[flagIdx] === "M") continue;
    const tavg = parseFloat(p[tavgIdx]);
    if (!Number.isFinite(tavg)) continue;
    let rec = map.get(p[idIdx]);
    if (!rec) { rec = { jan: null, jul: null }; map.set(p[idIdx], rec); }
    if (month === "01") rec.jan = tavg; else rec.jul = tavg;
  }
  return map;
}

// Great-circle distance in km.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Set janTempF/julTempF on every place from its nearest NOAA normals station.
// Mutates `places`.
async function loadClimate(places) {
  // Station coordinates.
  const invRes = await fetch(NOAA_INVENTORY_URL);
  if (!invRes.ok) throw new Error(`NOAA inventory: ${invRes.status} ${invRes.statusText}`);
  const inventory = parseStationInventory(await invRes.text());
  console.error(`Loaded NOAA station inventory: ${inventory.size} stations`);

  // Temperature archive → extract mly-normal-allall.csv.
  const arcRes = await fetch(NOAA_TEMP_ARCHIVE_URL);
  if (!arcRes.ok) throw new Error(`NOAA temperature archive: ${arcRes.status} ${arcRes.statusText}`);
  const dir = mkdtempSync(join(tmpdir(), "noaa-"));
  const tarPath = join(dir, "temp.tar.gz");
  writeFileSync(tarPath, Buffer.from(await arcRes.arrayBuffer()));
  execSync(`tar -xzf "${tarPath}" -C "${dir}"`, { maxBuffer: 256 * 1024 * 1024 });
  const found = execSync(`find "${dir}" -name "mly-normal-allall.csv"`).toString().trim();
  if (!found) throw new Error("NOAA temperature archive: mly-normal-allall.csv not found");
  const tavgByStation = parseMonthlyTavg(readFileSync(found.split("\n")[0], "utf8"));

  // Stations with both coordinates and a Jan+Jul normal.
  const stations = [];
  for (const [id, t] of tavgByStation) {
    const loc = inventory.get(id);
    if (loc && t.jan !== null && t.jul !== null) {
      stations.push({ lat: loc.lat, lon: loc.lon, jan: t.jan, jul: t.jul });
    }
  }
  console.error(`NOAA climate stations with Jan+Jul TAVG: ${stations.length}`);
  if (stations.length === 0) throw new Error("NOAA climate: no usable stations");

  // Nearest-station match for each place.
  let matched = 0;
  for (const p of places) {
    if (p._lat == null || p._lon == null) { p.janTempF = null; p.julTempF = null; continue; }
    let best = null, bestD = Infinity;
    for (const s of stations) {
      const d = haversineKm(p._lat, p._lon, s.lat, s.lon);
      if (d < bestD) { bestD = d; best = s; }
    }
    p.janTempF = Math.round(best.jan);
    p.julTempF = Math.round(best.jul);
    matched++;
  }
  console.error(`Climate: matched ${matched}/${places.length} places to a NOAA station.`);
}
```

- [ ] **Step 3: Update the row serialization (drop `sunnyDays`)**

Find the `lines.push(...)` call that serializes one place. Its template literal currently ends with:

```js
demMargin: ${num(p.demMargin)}, janTempF: ${num(p.janTempF)}, julTempF: ${num(p.julTempF)}, sunnyDays: ${num(p.sunnyDays)} },`);
```

Change it to (remove the `sunnyDays` field):

```js
demMargin: ${num(p.demMargin)}, janTempF: ${num(p.janTempF)}, julTempF: ${num(p.julTempF)} },`);
```

- [ ] **Step 4: Update the generated header comment**

In the `lines` array, the header comment currently has three climate lines (referencing Open-Meteo / ERA5 / sunnyDays). Replace those three lines:

```js
    `//   janTempF        = avg daily mean temp, January 2015–2024 (°F; Open-Meteo, ERA5-based)`,
    `//   julTempF        = avg daily mean temp, July 2015–2024 (°F; Open-Meteo, ERA5-based)`,
    `//   sunnyDays       = days/yr with sunshine ≥ 70% of daylight, 2015–2024 (Open-Meteo, ERA5-based)`,
```

with two lines:

```js
    `//   janTempF        = January mean temp, nearest-station 1991–2020 NOAA Climate Normal (°F)`,
    `//   julTempF        = July mean temp, nearest-station 1991–2020 NOAA Climate Normal (°F)`,
```

- [ ] **Step 5: Remove the climate cache from `.gitignore`**

Delete this line from `.gitignore`:

```
scripts/.climate-cache.json
```

- [ ] **Step 6: Delete the stale Open-Meteo cache file**

Run: `rm -f scripts/.climate-cache.json`
(It is gitignored, so it was never committed — this just removes it from the worktree.)

- [ ] **Step 7: Verify the archive contents, then syntax-check**

First confirm the NOAA archive really contains `mly-normal-allall.csv` (one harmless ~28 MB download):

```bash
cd /tmp && curl -sL "https://www.ncei.noaa.gov/data/normals-monthly/1991-2020/archive/us-climate-normals_1991-2020_v1.0.1_monthly_temperature_by-variable_c20230403.tar.gz" -o noaa-temp.tar.gz && tar -tzf noaa-temp.tar.gz | grep -i "mly-normal-allall.csv" ; echo "exit: $?"
```

Expected: the command prints a path ending in `mly-normal-allall.csv`. If it prints nothing, STOP and report — the archive layout differs from the plan's assumption and the loader needs adjusting before proceeding.

Then syntax-check the script:

Run: `node --check scripts/fetch_places.mjs`
Expected: no output, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add scripts/fetch_places.mjs .gitignore
git commit -m "$(cat <<'EOF'
Replace Open-Meteo climate fetch with NOAA Climate Normals

Open-Meteo's free tier could not handle 8,036 places. loadClimate()
now downloads NOAA's 1991-2020 monthly temperature normals (station
inventory + temperature archive, no API key, no rate limits) and
matches each place to its nearest station for Jan/Jul mean temp.
The sunny-days field and the resumable cache are removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B: Drop the sunny-days column and update the temperature tooltips

`index.html` currently has three climate columns wired (`janTempF`, `julTempF`, `sunnyDays`). Remove all `sunnyDays` wiring and update the two temperature tooltips to cite NOAA instead of Open-Meteo.

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace the two temperature header cells**

Find the `janTempF` header `<div>` (contains `data-sort="janTempF"`) and replace the whole line with:

```html
      <div class="col-num" data-sort="janTempF">Jan °F<span class="arrow"></span><span class="info"><button class="info-btn" type="button" aria-label="About January temperature">i</button><span class="info-tooltip">Average January temperature, °F — the 1991–2020 January mean from NOAA's U.S. Climate Normals, taken from the weather station nearest the place's center. Station-based: most accurate where a station is close, and elevation differences between a place and its station can shift the value by a few degrees.</span></span></div>
```

Find the `julTempF` header `<div>` (contains `data-sort="julTempF"`) and replace the whole line with:

```html
      <div class="col-num" data-sort="julTempF">Jul °F<span class="arrow"></span><span class="info"><button class="info-btn" type="button" aria-label="About July temperature">i</button><span class="info-tooltip">Average July temperature, °F — the 1991–2020 July mean from NOAA's U.S. Climate Normals, taken from the weather station nearest the place's center. Station-based: most accurate where a station is close, and elevation differences between a place and its station can shift the value by a few degrees.</span></span></div>
```

- [ ] **Step 2: Delete the `sunnyDays` header cell**

Delete this entire line (the `sunnyDays` header `<div>`, which follows the `julTempF` one):

```html
      <div class="col-num" data-sort="sunnyDays">Sun days<span class="arrow"></span><span class="info"><button class="info-btn" type="button" aria-label="About sunny days">i</button><span class="info-tooltip">Sunny days per year — days when sunshine duration is at least 70% of available daylight, averaged over 2015–2024 (Open-Meteo, ERA5-based). Sampled at the place's interior point on a ~9–11 km grid.</span></span></div>
```

- [ ] **Step 3: Delete the `sunnyDays` `COL_DEFS` entry**

Delete this line from the `COL_DEFS` array:

```js
    { key: 'sunnyDays',      label: 'Sun days',   always: false, dW: '80px',                  mW: '66px',                  dMin: 80,  mMin: 66,  defaultHidden: true, desc: 'Sunny days per year' },
```

- [ ] **Step 4: Delete the `sunnyDays` cell renderer**

Delete this line from the `CELL_RENDERERS` object:

```js
    sunnyDays:      (p)    => `<div class="num-col" style="color:var(--ink-2)">${p.sunnyDays == null ? "—" : p.sunnyDays.toLocaleString()}</div>`,
```

- [ ] **Step 5: Remove `sunnyDays` from `placeKey`**

In the single-line `const placeKey = { ... }` object literal, remove the ` sunnyDays: "sunnyDays",` entry. It currently reads `... janTempF: "janTempF", julTempF: "julTempF", sunnyDays: "sunnyDays", pctIndian: ...` — change that span to `... janTempF: "janTempF", julTempF: "julTempF", pctIndian: ...`.

- [ ] **Step 6: Delete the `sunnyDays` `placesFilters` slot**

Delete this line from the `placesFilters` object:

```js
    sunnyDays:      { min: null, max: null },
```

- [ ] **Step 7: Delete the `sunnyDays` `FILTER_META` entry**

Delete this line from the `FILTER_META` object:

```js
    sunnyDays:      { min: 'Min',       max: 'Max',        fmt: v => v.toLocaleString() + ' days' },
```

- [ ] **Step 8: Delete the `sunnyDays` `PRESET_FILTER_LABEL` entry**

Delete this line from the `PRESET_FILTER_LABEL` object:

```js
    sunnyDays:      "Sunny days",
```

- [ ] **Step 9: Remove the `sunnyDays` filter predicate and fix the comment**

In the `render()` filter callback, the climate filter block currently reads:

```js
      // Climate filters: Jan/Jul mean temp (°F) and sunny days/yr; null excluded when any bound is set.
      if (f.janTempF.min !== null && (p.janTempF == null || p.janTempF < f.janTempF.min)) return false;
      if (f.janTempF.max !== null && (p.janTempF == null || p.janTempF > f.janTempF.max)) return false;
      if (f.julTempF.min !== null && (p.julTempF == null || p.julTempF < f.julTempF.min)) return false;
      if (f.julTempF.max !== null && (p.julTempF == null || p.julTempF > f.julTempF.max)) return false;
      if (f.sunnyDays.min !== null && (p.sunnyDays == null || p.sunnyDays < f.sunnyDays.min)) return false;
      if (f.sunnyDays.max !== null && (p.sunnyDays == null || p.sunnyDays > f.sunnyDays.max)) return false;
```

Replace that whole block with (drop the two `sunnyDays` lines, fix the comment):

```js
      // Climate filters: Jan/Jul mean temp (°F); null excluded when any bound is set.
      if (f.janTempF.min !== null && (p.janTempF == null || p.janTempF < f.janTempF.min)) return false;
      if (f.janTempF.max !== null && (p.janTempF == null || p.janTempF > f.janTempF.max)) return false;
      if (f.julTempF.min !== null && (p.julTempF == null || p.julTempF < f.julTempF.min)) return false;
      if (f.julTempF.max !== null && (p.julTempF == null || p.julTempF > f.julTempF.max)) return false;
```

- [ ] **Step 10: Delete the `sunnyDays` `describeFilters()` entry**

Delete this line from `describeFilters()`:

```js
    pushRange("sunnyDays", fmtNum, "sunny days");
```

- [ ] **Step 11: Confirm no `sunnyDays` references remain**

Run: `grep -n sunnyDays index.html`
Expected: no output (every reference removed).

- [ ] **Step 12: JS-parse sanity check**

```bash
node -e "const m = require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g); new Function(m[m.length-1].replace(/^<script>|<\/script>$/g, '')); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 13: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Drop sunny-days column; cite NOAA in temperature tooltips

The climate feature ships two columns (Jan/Jul mean temp), not
three — sunshine had no viable free national data source. Removes
all sunnyDays wiring and updates the temperature header tooltips
to cite NOAA's 1991-2020 Climate Normals and the nearest-station
and elevation caveats.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task C: Regenerate the dataset and verify

The app code is complete but every place shows "—" until `data/places.js` is regenerated. Regeneration hits the Census API plus two NOAA downloads; it takes a few minutes.

**Files:**
- Regenerate: `data/places.js` (via the build script — never hand-edit)

- [ ] **Step 1: Regenerate the dataset**

Requires `CENSUS_API_KEY` in `.env`.

Run: `node scripts/fetch_places.mjs`
Expected: console progress for states and the Gazetteer, then `Loaded NOAA station inventory: …`, `NOAA climate stations with Jan+Jul TAVG: …`, and `Climate: matched N/N places to a NOAA station.`, ending with `Wrote …/data/places.js (… places).`

- [ ] **Step 2: Verify the regenerated dataset**

```bash
node -e 'global.PLACES=[];const c=require("fs").readFileSync("data/places.js","utf8");eval(c.replace("const PLACES","PLACES"));
const w=PLACES.filter(p=>p.janTempF!=null);
console.log("places:",PLACES.length,"with climate:",w.length);
const bad=w.filter(p=>p.janTempF>p.julTempF);
console.log("places where janTempF>julTempF (expect ~0):",bad.length);
console.log("has sunnyDays field (expect false):", "sunnyDays" in PLACES[0]);
for(const n of ["Phoenix","Seattle","Minneapolis","Miami"]){const p=PLACES.find(x=>x.name===n);console.log(n+":",p&&[p.janTempF,p.julTempF]);}'
```

Expected: nearly all places have climate; `janTempF < julTempF` for essentially all; `sunnyDays` field absent; the four cities look plausible (e.g. Minneapolis cold January, Miami warm January, Phoenix hot July).

- [ ] **Step 3: Final JS-parse sanity check**

```bash
node -e "const m = require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g); new Function(m[m.length-1].replace(/^<script>|<\/script>$/g, '')); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit the regenerated dataset**

```bash
git add data/places.js
git commit -m "$(cat <<'EOF'
Regenerate places dataset with NOAA temperature fields

janTempF / julTempF now populated from NOAA 1991-2020 normals.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Hand off for manual browser testing**

Tell the user the feature is ready: open `index.html`, open the column picker, enable **Jan °F / Jul °F**, and check sorting and the per-column range filters.

---

## Notes

- **URL state needs no changes.** `encodeStateToURL()` / `hydrateFromURL()` iterate filter and column keys generically.
- **`CLAUDE.md` should be updated** to mention the two new fields and the NOAA source — flag to the user at the end; not a task here.
- **Performance:** the nearest-station match is brute-force (~8k places × ~7k stations). This is a few seconds in a one-off offline script — acceptable; no spatial index needed.
