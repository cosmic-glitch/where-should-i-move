# Climate Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three default-hidden columns to the places table — January mean temperature, July mean temperature, and sunny days per year — sourced from Open-Meteo at dataset-build time.

**Architecture:** The build script (`scripts/fetch_places.mjs`) already downloads the Census Gazetteer for land area; we extend it to also read each place's interior-point lat/lon, then call the Open-Meteo Historical Weather API to compute the three climate fields and bake them into `data/places.js`. The app (`index.html`) wires the three new fields as numeric columns exactly the way the existing `popDensity` column is wired — header cell, `COL_DEFS` entry, cell renderer, sort key, range filter.

**Tech Stack:** Vanilla JS (no build, no deps), Node ESM build script, Open-Meteo Historical Weather API (free, no key), Census Gazetteer.

---

## Context for the implementer

This repo is a static web app — no build system, no tests, no `package.json`. Two things matter:

1. **Verification is limited by project policy** (`CLAUDE.md`): do NOT start a web server, use a browser, or screenshot. The only sanctioned checks are:
   - For `index.html`: the JS-parse sanity check (see below).
   - For `scripts/fetch_places.mjs`: `node --check scripts/fetch_places.mjs`.
   - Regenerating the dataset is a deliberate, user-initiated step (Task 6).

2. **`data/places.js` is auto-generated** — never hand-edit it. It only changes by running the build script.

**JS-parse sanity check** (run after every `index.html` edit):

```bash
node -e "const m = require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g); new Function(m[m.length-1].replace(/^<script>|<\/script>$/g, '')); console.log('OK')"
```

Expected output: `OK`

The three new fields are `janTempF` (integer °F or `null`), `julTempF` (integer °F or `null`), `sunnyDays` (integer days/yr or `null`). `null` means the place had no Gazetteer lat/lon match or the climate fetch failed; it renders as "—".

The data-side tasks (1–3) and the app-side tasks (4–5) are independent — the app renders "—" for every place until the dataset is regenerated in Task 6. Implement in order anyway; the commits stay coherent.

---

## Task 1: Capture lat/lon from the Census Gazetteer

The Gazetteer parser currently maps each GEOID to a bare `ALAND_SQMI` number. Change it to map to an object `{ sqmi, lat, lon }`, reading the `INTPTLAT` / `INTPTLONG` columns the Gazetteer files already contain, and attach `_lat` / `_lon` to every place object.

**Files:**
- Modify: `scripts/fetch_places.mjs` — `loadLandArea()` (~lines 276–305) and the place-assembly block (~lines 435–458)

- [ ] **Step 1: Extend the Gazetteer parser to read lat/lon**

In `loadLandArea()`, replace the index lookups, header check, and parse loop. Current code:

```js
    const geoidIdx = header.indexOf("GEOID");
    const sqmiIdx = header.indexOf("ALAND_SQMI");
    if (geoidIdx < 0 || sqmiIdx < 0) {
      throw new Error(`gazetteer ${url}: missing GEOID or ALAND_SQMI columns (header was ${header.join("|")})`);
    }
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split("\t");
      if (parts.length <= sqmiIdx) continue;
      const geoid = parts[geoidIdx].trim();
      const sqmi = parseFloat(parts[sqmiIdx]);
      if (!geoid || !Number.isFinite(sqmi) || sqmi <= 0) continue;
      map.set(geoid, sqmi);
    }
```

Replace with:

```js
    const geoidIdx = header.indexOf("GEOID");
    const sqmiIdx  = header.indexOf("ALAND_SQMI");
    const latIdx   = header.indexOf("INTPTLAT");
    const lonIdx   = header.indexOf("INTPTLONG");
    if (geoidIdx < 0 || sqmiIdx < 0 || latIdx < 0 || lonIdx < 0) {
      throw new Error(`gazetteer ${url}: missing GEOID/ALAND_SQMI/INTPTLAT/INTPTLONG columns (header was ${header.join("|")})`);
    }
    const maxIdx = Math.max(geoidIdx, sqmiIdx, latIdx, lonIdx);
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split("\t");
      if (parts.length <= maxIdx) continue;
      const geoid = parts[geoidIdx].trim();
      const sqmi = parseFloat(parts[sqmiIdx]);
      const lat  = parseFloat(parts[latIdx]);
      const lon  = parseFloat(parts[lonIdx]);
      if (!geoid || !Number.isFinite(sqmi) || sqmi <= 0) continue;
      map.set(geoid, {
        sqmi,
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
      });
    }
```

- [ ] **Step 2: Update the popDensity call site and attach lat/lon to the place**

In the place-assembly block, the current density code is:

```js
    // Population density: people per square mile of land area.
    const landSqMi = LAND_AREA ? LAND_AREA.get(geoid) : null;
    const popDensity = landSqMi && landSqMi > 0 ? Math.round(population / landSqMi) : null;
```

Replace with:

```js
    // Population density: people per square mile of land area.
    const gaz = LAND_AREA ? LAND_AREA.get(geoid) : null;
    const landSqMi = gaz ? gaz.sqmi : null;
    const popDensity = landSqMi && landSqMi > 0 ? Math.round(population / landSqMi) : null;
```

Then in the `out.push({ ... })` object immediately below, add two transient fields right after `demMargin: demMarginFor(name, county),` (the underscore prefix marks them internal — they are NOT serialized into `data/places.js`):

```js
      demMargin: demMarginFor(name, county),
      _lat: gaz ? gaz.lat : null,
      _lon: gaz ? gaz.lon : null,
```

- [ ] **Step 3: Syntax-check**

Run: `node --check scripts/fetch_places.mjs`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch_places.mjs
git commit -m "$(cat <<'EOF'
Capture place interior-point lat/lon from the Census Gazetteer

The Gazetteer rows already carry INTPTLAT/INTPTLONG; parse them
alongside ALAND_SQMI so each place gets a coordinate for the
upcoming climate fetch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add the Open-Meteo climate fetch

Add a `loadClimate(places)` function that fills `janTempF` / `julTempF` / `sunnyDays` on every place. It batches places, calls the Open-Meteo Historical Weather API, aggregates 2015–2024 daily reanalysis, and caches results in a gitignored JSON file so a re-run resumes instead of re-fetching.

**Files:**
- Modify: `scripts/fetch_places.mjs` — the fs import (~line 26); add new code after `loadLandArea()` ends (~line 305)

- [ ] **Step 1: Add `existsSync` to the fs import**

Current import line:

```js
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
```

Replace with:

```js
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
```

- [ ] **Step 2: Add the climate-fetch code**

Insert this block immediately after the closing brace of `loadLandArea()` (after the line `console.error(\`Loaded land-area gazetteer: ${map.size} geographies\`);` and its closing `}`):

```js
// ── Climate ────────────────────────────────────────────────────────────────
// Per-place climate from the Open-Meteo Historical Weather API (free, no key):
//   janTempF / julTempF = avg daily mean temp in Jan / Jul over 2015-2024 (°F)
//   sunnyDays           = days/yr where sunshine >= 70% of daylight, 2015-2024
// Sampled at the place's Gazetteer interior point. Results are cached to a
// gitignored JSON file keyed by rounded lat/lon, so a re-run resumes.
const CLIMATE_START = "2015-01-01";
const CLIMATE_END   = "2024-12-31";
const CLIMATE_YEARS = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Aggregate one location's daily series into the three fields.
function aggregateClimate(daily) {
  if (!daily || !Array.isArray(daily.time)) {
    return { janTempF: null, julTempF: null, sunnyDays: null };
  }
  const { time, temperature_2m_mean: temp, sunshine_duration: sun, daylight_duration: day } = daily;
  let janSum = 0, janN = 0, julSum = 0, julN = 0, sunnyCount = 0;
  for (let i = 0; i < time.length; i++) {
    const month = time[i].slice(5, 7); // "YYYY-MM-DD"
    const t = temp ? temp[i] : null;
    if (month === "01" && Number.isFinite(t)) { janSum += t; janN++; }
    if (month === "07" && Number.isFinite(t)) { julSum += t; julN++; }
    const s = sun ? sun[i] : null, d = day ? day[i] : null;
    if (Number.isFinite(s) && Number.isFinite(d) && d > 0 && s / d >= 0.70) sunnyCount++;
  }
  return {
    janTempF: janN ? Math.round(janSum / janN) : null,
    julTempF: julN ? Math.round(julSum / julN) : null,
    sunnyDays: time.length ? Math.round(sunnyCount / CLIMATE_YEARS) : null,
  };
}

// Fetch one batch of places (each with _lat/_lon). Returns an array aligned
// with `batch`. Retries on HTTP 429 / 5xx with linear backoff.
async function fetchClimateBatch(batch, attempt = 1) {
  const lats = batch.map(p => p._lat).join(",");
  const lons = batch.map(p => p._lon).join(",");
  const url = "https://archive-api.open-meteo.com/v1/archive"
    + `?latitude=${lats}&longitude=${lons}`
    + `&start_date=${CLIMATE_START}&end_date=${CLIMATE_END}`
    + "&daily=temperature_2m_mean,sunshine_duration,daylight_duration"
    + "&temperature_unit=fahrenheit&timezone=auto";
  const res = await fetch(url);
  if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
    const wait = 3000 * attempt;
    console.error(`  Open-Meteo ${res.status}; retry ${attempt}/5 in ${wait}ms`);
    await sleep(wait);
    return fetchClimateBatch(batch, attempt + 1);
  }
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} ${res.statusText}`);
  const json = await res.json();
  // Open-Meteo returns a bare object for a 1-location request, an array otherwise.
  return Array.isArray(json) ? json : [json];
}

// Fill janTempF/julTempF/sunnyDays on every place. Mutates `places` in place.
async function loadClimate(places) {
  const here = dirname(fileURLToPath(import.meta.url));
  const cachePath = resolve(here, ".climate-cache.json");
  let cache = {};
  if (existsSync(cachePath)) {
    try { cache = JSON.parse(readFileSync(cachePath, "utf8")); }
    catch { cache = {}; }
  }
  const keyOf = p => `${p._lat.toFixed(4)},${p._lon.toFixed(4)}`;

  const todo = [];
  for (const p of places) {
    if (p._lat == null || p._lon == null) {
      p.janTempF = p.julTempF = p.sunnyDays = null;
      continue;
    }
    const cached = cache[keyOf(p)];
    if (cached) {
      p.janTempF = cached.janTempF;
      p.julTempF = cached.julTempF;
      p.sunnyDays = cached.sunnyDays;
    } else {
      todo.push(p);
    }
  }
  console.error(`Climate: ${places.length - todo.length} cached, ${todo.length} to fetch from Open-Meteo`);

  const BATCH = 50;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const results = await fetchClimateBatch(batch);
      batch.forEach((p, j) => {
        const agg = aggregateClimate(results[j] && results[j].daily);
        p.janTempF = agg.janTempF;
        p.julTempF = agg.julTempF;
        p.sunnyDays = agg.sunnyDays;
        cache[keyOf(p)] = agg;
      });
    } catch (e) {
      console.error(`  climate batch ${i}-${i + batch.length} failed: ${e.message}`);
      batch.forEach(p => { p.janTempF = p.julTempF = p.sunnyDays = null; });
    }
    writeFileSync(cachePath, JSON.stringify(cache));
    console.error(`  climate: ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    await sleep(1200); // polite throttle for the free Open-Meteo tier
  }
  console.error("Climate: done.");
}
```

- [ ] **Step 3: Syntax-check**

Run: `node --check scripts/fetch_places.mjs`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch_places.mjs
git commit -m "$(cat <<'EOF'
Add Open-Meteo climate fetch to the build script

loadClimate() fills janTempF/julTempF/sunnyDays per place from the
Open-Meteo Historical Weather API, batched and throttled, with a
gitignored resumable cache. Not yet wired into main().

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire the climate fetch into the build and emit the new fields

Call `loadClimate()` from `main()`, serialize the three fields into `data/places.js`, document them in the generated header comment, and gitignore the cache file.

**Files:**
- Modify: `scripts/fetch_places.mjs` — `main()` (~lines 479–531)
- Modify: `.gitignore`

- [ ] **Step 1: Call `loadClimate()` in `main()`**

In `main()`, find the loop that builds `all` and the `all.sort(...)` line that follows it:

```js
  all.sort((a, b) => b.pctIndian - a.pctIndian);
  console.error(`Total places fetched: ${all.length}`);
```

Insert the `loadClimate` call so it runs before the sort:

```js
  console.error(`Total places fetched: ${all.length}`);
  await loadClimate(all);
  all.sort((a, b) => b.pctIndian - a.pctIndian);
```

(Note: the `console.error(\`Total places fetched...\`)` line moves above the sort — it does not depend on sort order.)

- [ ] **Step 2: Document the new fields in the generated header comment**

In the `lines` array, find the `demMargin` comment line:

```js
    `//   demMargin       = 2024 county presidential margin (Harris − Trump, pct points; MIT/MEDSL)`,
```

Add three lines immediately after it:

```js
    `//   demMargin       = 2024 county presidential margin (Harris − Trump, pct points; MIT/MEDSL)`,
    `//   janTempF        = avg daily mean temp, January 2015–2024 (°F; Open-Meteo, ERA5-based)`,
    `//   julTempF        = avg daily mean temp, July 2015–2024 (°F; Open-Meteo, ERA5-based)`,
    `//   sunnyDays       = days/yr with sunshine ≥ 70% of daylight, 2015–2024 (Open-Meteo, ERA5-based)`,
```

- [ ] **Step 3: Serialize the three fields into each row**

Find the `lines.push(...)` call that serializes one place (the long template literal ending in `demMargin: ${num(p.demMargin)} },`). Change the trailing segment from:

```js
demMargin: ${num(p.demMargin)} },`);
```

to:

```js
demMargin: ${num(p.demMargin)}, janTempF: ${num(p.janTempF)}, julTempF: ${num(p.julTempF)}, sunnyDays: ${num(p.sunnyDays)} },`);
```

- [ ] **Step 4: Gitignore the climate cache**

Add a line to `.gitignore`:

```
scripts/.climate-cache.json
```

- [ ] **Step 5: Syntax-check**

Run: `node --check scripts/fetch_places.mjs`
Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch_places.mjs .gitignore
git commit -m "$(cat <<'EOF'
Wire climate fetch into the build and emit climate fields

main() now calls loadClimate(); janTempF/julTempF/sunnyDays are
serialized into data/places.js and documented in its header. The
resumable cache file is gitignored.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add the three climate columns to the table (display + sort)

Wire the columns into `index.html` so they appear in the column picker, render their values, and sort. Filtering is Task 5.

**Files:**
- Modify: `index.html` — header markup (~line 927), `COL_DEFS` (~line 1797), `CELL_RENDERERS` (~line 1891), `placeKey` (~line 2276)

- [ ] **Step 1: Add the three header cells**

Find the Density header `<div>` (it contains `data-sort="popDensity"`, ends with `Separates walkable density from acreage exurbs.</span></span></div>`). Insert these three lines immediately after it (order must match `COL_DEFS`):

```html
      <div class="col-num" data-sort="janTempF">Jan °F<span class="arrow"></span><span class="info"><button class="info-btn" type="button" aria-label="About January temperature">i</button><span class="info-tooltip">Average daily mean temperature in January, °F. Computed from daily 2015–2024 reanalysis (Open-Meteo, ERA5-based). Sampled at the place's interior point on a ~9–11 km grid — represents the place's center, not neighborhood micro-climates.</span></span></div>
      <div class="col-num" data-sort="julTempF">Jul °F<span class="arrow"></span><span class="info"><button class="info-btn" type="button" aria-label="About July temperature">i</button><span class="info-tooltip">Average daily mean temperature in July, °F. Computed from daily 2015–2024 reanalysis (Open-Meteo, ERA5-based). Sampled at the place's interior point on a ~9–11 km grid — represents the place's center, not neighborhood micro-climates.</span></span></div>
      <div class="col-num" data-sort="sunnyDays">Sun days<span class="arrow"></span><span class="info"><button class="info-btn" type="button" aria-label="About sunny days">i</button><span class="info-tooltip">Sunny days per year — days when sunshine duration is at least 70% of available daylight, averaged over 2015–2024 (Open-Meteo, ERA5-based). Sampled at the place's interior point on a ~9–11 km grid.</span></span></div>
```

- [ ] **Step 2: Add the three `COL_DEFS` entries**

In the `COL_DEFS` array, find the `popDensity` entry (the line with `key: 'popDensity'`). Insert these three lines immediately after it:

```js
    { key: 'janTempF',       label: 'Jan °F',     always: false, dW: '74px',                  mW: '60px',                  dMin: 74,  mMin: 60,  defaultHidden: true, desc: 'Avg January temperature (°F)' },
    { key: 'julTempF',       label: 'Jul °F',     always: false, dW: '74px',                  mW: '60px',                  dMin: 74,  mMin: 60,  defaultHidden: true, desc: 'Avg July temperature (°F)' },
    { key: 'sunnyDays',      label: 'Sun days',   always: false, dW: '80px',                  mW: '66px',                  dMin: 80,  mMin: 66,  defaultHidden: true, desc: 'Sunny days per year' },
```

- [ ] **Step 3: Add the three cell renderers**

In the `CELL_RENDERERS` object, find the `popDensity:` renderer line. Insert these three lines immediately after it:

```js
    janTempF:       (p)    => `<div class="num-col" style="color:var(--ink-2)">${p.janTempF == null ? "—" : p.janTempF + "°"}</div>`,
    julTempF:       (p)    => `<div class="num-col" style="color:var(--ink-2)">${p.julTempF == null ? "—" : p.julTempF + "°"}</div>`,
    sunnyDays:      (p)    => `<div class="num-col" style="color:var(--ink-2)">${p.sunnyDays == null ? "—" : p.sunnyDays.toLocaleString()}</div>`,
```

- [ ] **Step 4: Add the three sort keys to `placeKey`**

Find the `placeKey` object literal (the single long line beginning `const placeKey = {`). It maps sort keys to place-object field names. Add three entries — insert `janTempF: "janTempF", julTempF: "julTempF", sunnyDays: "sunnyDays",` right after `popDensity: "popDensity",`:

```js
    const placeKey = { name: "name", state: "state", metro: "metro", pop: "population", popDensity: "popDensity", janTempF: "janTempF", julTempF: "julTempF", sunnyDays: "sunnyDays", pctIndian: "pctIndian", pctAsian: "pctAsian", pctForeignBorn: "pctForeignBorn", medianAge: "medianAge", demMargin: "demMargin", hhi: "medianHHI", asianMedianHHI: "asianMedianHHI", pctBach: "pctBach", pct200k: "pct200k", pctHomeowner: "pctHomeowner", homeValue: "medianHomeValue", death: "deathTax", income: "incomeTax", capgains: "capGainsTax", total: "total" };
```

- [ ] **Step 5: JS-parse sanity check**

Run:

```bash
node -e "const m = require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g); new Function(m[m.length-1].replace(/^<script>|<\/script>$/g, '')); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add Jan temp / Jul temp / sunny-days columns to the places table

Three default-hidden numeric columns, wired like Density: header
cell, COL_DEFS entry, cell renderer, and sort key. Filtering is
added next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add range filters for the three climate columns

Wire the per-column min/max range filter for each climate column — `placesFilters` state, `FILTER_META` chip config, `PRESET_FILTER_LABEL`, the filter predicate in `render()`, and the `describeFilters()` summary text.

**Files:**
- Modify: `index.html` — `placesFilters` (~line 1519), `FILTER_META` (~line 1604), `PRESET_FILTER_LABEL` (~line 1631), filter predicate in `render()` (~line 2216), `describeFilters()` (~line 2116)

- [ ] **Step 1: Add three `placesFilters` slots**

In the `placesFilters` object, find the `popDensity:` line. Insert immediately after it:

```js
    janTempF:       { min: null, max: null },
    julTempF:       { min: null, max: null },
    sunnyDays:      { min: null, max: null },
```

- [ ] **Step 2: Add three `FILTER_META` entries**

In the `FILTER_META` object, find the `popDensity:` line. Insert immediately after it:

```js
    janTempF:       { min: 'Min °F',    max: 'Max °F',     fmt: v => v + '°F' },
    julTempF:       { min: 'Min °F',    max: 'Max °F',     fmt: v => v + '°F' },
    sunnyDays:      { min: 'Min',       max: 'Max',        fmt: v => v.toLocaleString() + ' days' },
```

- [ ] **Step 3: Add three `PRESET_FILTER_LABEL` entries**

In the `PRESET_FILTER_LABEL` object, find the `popDensity:` line. Insert immediately after it:

```js
    janTempF:       "January temp",
    julTempF:       "July temp",
    sunnyDays:      "Sunny days",
```

- [ ] **Step 4: Add the filter predicate in `render()`**

In the `placeRows` filter callback, find the `popDensity` filter block — it ends with the line:

```js
      if (f.popDensity.max !== null && (p.popDensity == null || p.popDensity > f.popDensity.max)) return false;
```

Insert immediately after it:

```js
      // Climate filters: Jan/Jul mean temp (°F) and sunny days/yr; null excluded when any bound is set.
      if (f.janTempF.min !== null && (p.janTempF == null || p.janTempF < f.janTempF.min)) return false;
      if (f.janTempF.max !== null && (p.janTempF == null || p.janTempF > f.janTempF.max)) return false;
      if (f.julTempF.min !== null && (p.julTempF == null || p.julTempF < f.julTempF.min)) return false;
      if (f.julTempF.max !== null && (p.julTempF == null || p.julTempF > f.julTempF.max)) return false;
      if (f.sunnyDays.min !== null && (p.sunnyDays == null || p.sunnyDays < f.sunnyDays.min)) return false;
      if (f.sunnyDays.max !== null && (p.sunnyDays == null || p.sunnyDays > f.sunnyDays.max)) return false;
```

- [ ] **Step 5: Add `describeFilters()` summary entries**

In `describeFilters()`, find the line:

```js
    pushRange("popDensity", n => `${fmtNum(n)}/mi²`, "density");
```

Insert immediately after it:

```js
    pushRange("janTempF", n => `${n}°F`, "January temp");
    pushRange("julTempF", n => `${n}°F`, "July temp");
    pushRange("sunnyDays", n => `${fmtNum(n)} sunny days`, "sunny days");
```

- [ ] **Step 6: JS-parse sanity check**

Run:

```bash
node -e "const m = require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g); new Function(m[m.length-1].replace(/^<script>|<\/script>$/g, '')); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add range filters for the climate columns

placesFilters slots, FILTER_META chip config, preset labels, the
render() filter predicate, and describeFilters() summary text for
janTempF / julTempF / sunnyDays.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Regenerate the dataset and verify

The app code is complete but every place still shows "—" until `data/places.js` is regenerated. Regeneration hits the Census API and ~160 Open-Meteo batches; it takes several minutes and is a deliberate, user-initiated step.

**Files:**
- Regenerate: `data/places.js` (via the build script — never hand-edit)

- [ ] **Step 1: Smoke-test the Open-Meteo contract (one network call)**

Before the full run, confirm the API request shape and aggregation logic against two known-contrast cities — Phoenix AZ (hot, sunny) and Seattle WA (mild winter, cloudy). Run:

```bash
node -e '
const url = "https://archive-api.open-meteo.com/v1/archive?latitude=33.45,47.62&longitude=-112.07,-122.35&start_date=2015-01-01&end_date=2024-12-31&daily=temperature_2m_mean,sunshine_duration,daylight_duration&temperature_unit=fahrenheit&timezone=auto";
fetch(url).then(r => r.json()).then(arr => {
  for (const [i, name] of [[0,"Phoenix"],[1,"Seattle"]]) {
    const d = arr[i].daily;
    let jS=0,jN=0,lS=0,lN=0,sun=0;
    for (let k=0;k<d.time.length;k++){
      const m=d.time[k].slice(5,7), t=d.temperature_2m_mean[k];
      if(m==="01"&&Number.isFinite(t)){jS+=t;jN++;}
      if(m==="07"&&Number.isFinite(t)){lS+=t;lN++;}
      const s=d.sunshine_duration[k],dl=d.daylight_duration[k];
      if(Number.isFinite(s)&&Number.isFinite(dl)&&dl>0&&s/dl>=0.7)sun++;
    }
    console.log(name, "janF="+Math.round(jS/jN), "julF="+Math.round(lS/lN), "sunnyDays="+Math.round(sun/10));
  }
});
'
```

Expected: two lines printed. Sanity: for each city `janF < julF`; `sunnyDays` is in roughly 0–365; Phoenix is markedly warmer and sunnier than Seattle (e.g. Phoenix julF in the 90s and sunnyDays well above Seattle's). If the response is not an array or `.daily` is missing, stop and re-check `fetchClimateBatch` before the full run.

- [ ] **Step 2: Regenerate the dataset**

> **User-initiated.** Confirm with the user before running — this makes thousands of API calls and overwrites `data/places.js`. Requires `CENSUS_API_KEY` in `.env`.

Run: `node scripts/fetch_places.mjs`
Expected: console progress for states, the Gazetteer, and `Climate: … to fetch`/`climate: N/N` lines, ending with `Wrote …/data/places.js (… places).` If Open-Meteo rate-limits mid-run, re-running resumes from `scripts/.climate-cache.json`.

- [ ] **Step 3: Verify the regenerated dataset**

Run:

```bash
node -e 'global.PLACES=[];const c=require("fs").readFileSync("data/places.js","utf8");eval(c.replace("const PLACES","PLACES"));
const w=PLACES.filter(p=>p.janTempF!=null);
console.log("places:",PLACES.length,"with climate:",w.length);
const s=PLACES.find(p=>p.name==="Seattle"),ph=PLACES.find(p=>p.name==="Phoenix");
console.log("Seattle:",s&&[s.janTempF,s.julTempF,s.sunnyDays]);
console.log("Phoenix:",ph&&[ph.janTempF,ph.julTempF,ph.sunnyDays]);
const bad=w.filter(p=>p.janTempF>p.julTempF);
console.log("places where janTempF>julTempF (expect ~0, only odd microclimates):",bad.length);'
```

Expected: nearly all places have climate; `janTempF < julTempF` for essentially all; Seattle and Phoenix values look plausible and Phoenix is hotter/sunnier.

- [ ] **Step 4: Final JS-parse sanity check**

Run:

```bash
node -e "const m = require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/g); new Function(m[m.length-1].replace(/^<script>|<\/script>$/g, '')); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 5: Hand off to the user for manual browser testing**

Per `CLAUDE.md`, the user does manual browser testing. Tell the user the feature is ready: open `index.html`, open the column picker, enable **Jan °F / Jul °F / Sun days**, and check sorting and the per-column range filters.

- [ ] **Step 6: Commit the regenerated dataset**

```bash
git add data/places.js
git commit -m "$(cat <<'EOF'
Regenerate places dataset with climate fields

janTempF / julTempF / sunnyDays now populated from Open-Meteo.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Notes

- **URL state needs no changes.** `encodeStateToURL()` / `hydrateFromURL()` iterate `placesFilters` keys and `TOGGLEABLE_COLS` generically, so the new filters and columns get URL persistence automatically once Tasks 4–5 land.
- **`CLAUDE.md` should be updated** to mention the three new fields and the Open-Meteo source in the `PLACES` shape description and the fetch-script description — but only after the user confirms the feature works. Not a task here; flag it to the user at the end.
- **`min-width` figures in `applyColumnLayout()`** are computed from `COL_DEFS` `dMin`/`mMin` sums, so adding columns adjusts the layout automatically — no manual width edits needed.
