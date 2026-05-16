# Climate columns — design

**Date:** 2026-05-15
**Status:** Approved for planning

## Goal

Add per-place climate information to the "Where should I move?" places table so
relocation decisions can weigh weather alongside tax, demographics, and politics.
Scope is **climate only** — greenery (tree canopy / NDVI) is explicitly deferred.

## What ships

Three new numeric columns, each wired exactly like the existing `popDensity` /
`demMargin` columns (sortable, range-filterable, with a header info tooltip):

| Field key  | Header   | Meaning                                                              |
|------------|----------|----------------------------------------------------------------------|
| `janTempF` | Jan °F   | Average daily mean temperature in January, °F                        |
| `julTempF` | Jul °F   | Average daily mean temperature in July, °F                           |
| `sunnyDays`| Sun days | Sunny days per year (days where sunshine ≥ 70% of daylight)           |

Design decisions (all confirmed with the user):

- **Temperature framing:** January mean and July mean — symmetric, one number
  each, the standard climate-normal metric. January and July are the
  coldest/warmest month for the overwhelming majority of U.S. places; the
  columns are labelled with the fixed month names so this is honest, not implied
  to be a per-place coldest/warmest detection.
- **Sunshine metric:** "Sunny days per year" — concrete and relatable. A day
  counts as sunny when its sunshine duration is ≥ 70% of that day's daylight
  duration (a ratio, so it is not biased against short winter days).
- **Default visibility:** all three columns are `defaultHidden: true` in the
  column picker — consistent with `popDensity`, and avoids widening an already-
  wide table by default. The user opts in via the column picker.
- **Column placement:** grouped immediately after **Density**, the other
  "physical place" column.

## Data source

**Open-Meteo Historical Weather API** (`https://archive-api.open-meteo.com/v1/archive`).
Free, no API key, lat/lon-native. One source covers all three metrics.

Rejected alternatives: NOAA Climate Normals (station-based → nearest-station
mapping error; sparse sunshine coverage, needs a second source); PRISM + NREL
(multi-GB raster downloads + GDAL tooling — overkill).

### Inputs

Every place needs a latitude/longitude. The fetch script **already downloads**
the 2023 Census Gazetteer (place + cousub zips) and parses `ALAND_SQMI` from it.
The same Gazetteer rows carry `INTPTLAT` and `INTPTLONG` (the geography's
interior point) — we just don't parse those columns today.

### Request

For the 2015-01-01 … 2024-12-31 window (10 full years), daily variables:

- `temperature_2m_mean`
- `sunshine_duration`
- `daylight_duration`

With `temperature_unit=fahrenheit` and `timezone=auto`.

Open-Meteo accepts comma-separated `latitude`/`longitude` for **multiple
locations in one request**. The fetch batches places (~100–200 per request),
reducing ~8,000 single calls to ~50–80 batched calls. Throttle politely and
retry on HTTP 429 with backoff. Single-location requests are an acceptable
fallback if a batch fails.

### Aggregation (in the fetch script)

- `janTempF` = mean of `temperature_2m_mean` over all January days in the
  window, rounded to the nearest integer.
- `julTempF` = same for July days.
- `sunnyDays` = (count of days where `sunshine_duration / daylight_duration ≥
  0.70`) ÷ 10 years, rounded to the nearest integer.

### Null handling

- A place with no Gazetteer GEOID match (no lat/lon) → all three fields `null`.
- A place whose Open-Meteo data fails after retries → all three fields `null`,
  logged to stderr; the run continues.
- `null` renders as "—" in the table, identical to existing ACS-suppressed
  values, and is excluded from filtering/sorting the same way.

## Files changed

### `scripts/fetch_places.mjs`

1. **Gazetteer parser:** extend the existing land-area parser so the map value
   becomes `{ sqmi, lat, lon }` (or a parallel map) — read `INTPTLAT` /
   `INTPTLONG` alongside `ALAND_SQMI`. Existing `popDensity` math is unaffected.
2. **New fetch step:** after places are assembled, batch-request Open-Meteo for
   all places that have a lat/lon, aggregate to the three fields, attach them to
   each place object. Throttled, with retry/backoff.
3. **Serialization:** emit `janTempF`, `julTempF`, `sunnyDays` in each row and
   document them in the generated header comment.

### `data/places.js` (regenerated, not hand-edited)

Each row gains `janTempF`, `julTempF`, `sunnyDays` (integer or `null`).

### `index.html`

Each new column is wired the same way `popDensity` is — touch the same set of
places:

- **Header markup** (`.col-headers`): three `<div data-sort="…">` cells, each
  with an `.info` / `.info-btn` / `.info-tooltip`. Tooltip text states: source
  (Open-Meteo, ERA5 reanalysis), the 2015–2024 window, the sunny-day definition,
  the temperature framing (Jan/Jul daily mean), and a granularity caveat — the
  value is sampled at the place's Gazetteer interior point on a ~9–11 km
  reanalysis grid, so it represents the place's center, not micro-climates.
- **Column-list config** (the `{ key, label, always, dW, mW, dMin, mMin,
  defaultHidden, desc }` array): three entries with `defaultHidden: true` and
  compact numeric widths matching Density / Red-Blue.
- **`placesFilters`:** three `{ min: null, max: null }` entries.
- **Filter-config map:** three entries with `min`/`max` placeholder labels and a
  `fmt` (e.g. `v => v + '°F'`, `v => v + ' days'`).
- **Filter label map:** human-readable names for the filter dropdown
  (e.g. "Jan temp", "Jul temp", "Sunny days").
- **Cell-renderer map:** three renderers producing a `num-col` cell; `null` → "—".

Sorting works through the existing generic numeric sort once the keys are
registered (same as `popDensity`).

## Out of scope

- Greenery (tree canopy, NDVI) — a separate future feature.
- Precipitation, humidity, snowfall — only the three agreed columns ship.
- Per-place coldest/warmest-month detection — fixed January/July is intentional.
- Local micro-climate accuracy — interior-point sampling is accepted, caveated
  in the tooltip.

## Verification

Consistent with project norms (no test suite; the user does manual browser
testing):

- After editing `index.html`, run the JS-parse sanity check from `CLAUDE.md`.
- For `fetch_places.mjs`, dry-run the Open-Meteo step against a small slice of
  places (e.g. first 5) and eyeball that `janTempF` < `julTempF` and `sunnyDays`
  is in a plausible 0–365 range before a full regeneration.
- Full dataset regeneration (`node scripts/fetch_places.mjs`) is a deliberate,
  user-initiated step — not run automatically.
