# Climate columns — design

**Date:** 2026-05-15
**Status:** Approved for planning (revised — see "Revision" below)

## Revision (2026-05-15)

The original design fetched three columns (Jan temp, Jul temp, sunny days) from
the Open-Meteo Historical Weather API. Implementation reached the dataset
regeneration step and **Open-Meteo's free tier could not handle the volume** —
8,036 places each requesting 10 years of daily data is far over the free
rate/weight limits (only ~150 places fetched before sustained HTTP 429s).

The design was revised with the user: **two columns** (January and July mean
temperature) sourced from **NOAA's 1991–2020 U.S. Climate Normals**, a bulk file
download with no API key and no rate limits. The **sunny-days column is
dropped** — NOAA's sunshine normals exist for too few stations to cover 8,036
places, and no other free, rate-limit-free national source was available.

The rest of this document reflects the revised (final) design.

## Goal

Add per-place climate information to the "Where should I move?" places table so
relocation decisions can weigh weather alongside tax, demographics, and politics.
Scope is **temperature only** — greenery and sunshine are out of scope.

## What ships

Two new numeric columns, each wired exactly like the existing `popDensity` /
`demMargin` columns (sortable, range-filterable, with a header info tooltip):

| Field key  | Header  | Meaning                                              |
|------------|---------|------------------------------------------------------|
| `janTempF` | Jan °F  | Average January temperature, °F (1991–2020 normal)   |
| `julTempF` | Jul °F  | Average July temperature, °F (1991–2020 normal)      |

Design decisions (confirmed with the user):

- **Temperature framing:** January mean and July mean — symmetric, one number
  each, the standard climate-normal metric. Labelled with the fixed month names.
- **Default visibility:** both columns are `defaultHidden: true` in the column
  picker — consistent with `popDensity`, avoids widening an already-wide table
  by default. The user opts in via the column picker.
- **Column placement:** grouped immediately after **Density**, the other
  "physical place" column.

## Data source

**NOAA 1991–2020 U.S. Climate Normals — Monthly product.** Free, no API key, no
rate limits. Two HTTPS downloads, performed once at dataset-build time:

1. **Station inventory** (~1.3 MB fixed-width text):
   `https://www.ncei.noaa.gov/data/normals-monthly/1991-2020/doc/inventory_30yr.txt`
   Each line is space-delimited: station ID, latitude, longitude, elevation,
   state, name. Provides the lat/lon for every normals station.

2. **Monthly temperature archive** (~28 MB `.tar.gz`):
   `https://www.ncei.noaa.gov/data/normals-monthly/1991-2020/archive/us-climate-normals_1991-2020_v1.0.1_monthly_temperature_by-variable_c20230403.tar.gz`
   Unpacks to `mly-normal-allall.csv` — one row per station per month, with the
   field `MLY-TAVG-NORMAL` (monthly average temperature normal, whole °F) and a
   measurement flag `meas_flag_MLY-TAVG-NORMAL` (`M` = missing → skip).

Rejected alternatives: Open-Meteo free tier (rate-limited far below the needed
volume — this is what the original design hit); a paid Open-Meteo key (avoids
the cost); PRISM rasters (multi-GB downloads + GDAL tooling).

### Inputs

Every place needs a latitude/longitude for nearest-station matching. The fetch
script already parses each place's interior-point lat/lon from the 2023 Census
Gazetteer (this work — capturing `INTPTLAT`/`INTPTLONG` — is already complete in
the build script).

### Processing (in the fetch script, once at build time)

1. Download and parse `inventory_30yr.txt` → a map of station ID → `{lat, lon}`.
2. Download the temperature `.tar.gz`, extract `mly-normal-allall.csv`, and parse
   it → a map of station ID → `{jan, jul}` mean temperature, reading the
   `MLY-TAVG-NORMAL` value for `month == "01"` and `month == "07"`, skipping rows
   whose measurement flag is `M`.
3. Join the two maps → a list of stations that have both coordinates and a
   January-and-July normal (~7,000+ stations).
4. For each place, find the **nearest station by great-circle (Haversine)
   distance** and copy that station's `jan`/`jul` values, rounded to whole °F,
   into `janTempF` / `julTempF`.

### Null handling

- A place with no Gazetteer lat/lon → both fields `null`.
- `null` renders as "—" in the table, identical to existing ACS-suppressed
  values, and is excluded from filtering/sorting the same way.
- With ~7,000 stations spread across the U.S., every place with a lat/lon gets a
  match; nearest-station distance is small for populated areas.

### Accuracy caveats (reflected in the column tooltips)

- **Station-based.** A place's temperature is its nearest station's normal.
  Accuracy is best where a station is close, worse for remote places.
- **Elevation.** Nearest-station matching ignores elevation; a place at a
  markedly different elevation than its station can be off by a few °F.

## Files changed

### `scripts/fetch_places.mjs`

The Open-Meteo climate code (`aggregateClimate`, `fetchClimateBatch`,
`loadClimate`, and the `existsSync`/cache machinery) is **replaced** by a NOAA
loader: inventory parse, archive download + extract, CSV parse, Haversine
nearest-station match. The loader keeps the name `loadClimate(places)` and the
same call site in `main()`, so the build wiring is unchanged. Serialization
emits `janTempF` and `julTempF` (no `sunnyDays`); the generated header comment
documents the two fields and the NOAA source. The Open-Meteo resumable-cache
file and its `.gitignore` entry are removed.

### `data/places.js` (regenerated, not hand-edited)

Each row gains `janTempF` and `julTempF` (integer °F or `null`).

### `index.html`

Two columns (`janTempF`, `julTempF`) are wired exactly the way `popDensity` is —
header cell with info tooltip, column-list config entry (`defaultHidden: true`),
`placesFilters` slot, filter-config + filter-label entries, and cell renderer.
The header tooltips cite NOAA's 1991–2020 Climate Normals and the
nearest-station / elevation caveats. (No `sunnyDays` column.)

## Out of scope

- Sunshine / sunny-days — dropped; no free, rate-limit-free national source.
- Greenery (tree canopy, NDVI) — a separate future feature.
- Precipitation, humidity, snowfall.
- Per-place coldest/warmest-month detection — fixed January/July is intentional.
- Elevation-adjusted temperature matching — nearest-station is accepted,
  caveated in the tooltip.

## Verification

Consistent with project norms (no test suite; the user does manual browser
testing):

- After editing `index.html`, run the JS-parse sanity check from `CLAUDE.md`.
- After editing `fetch_places.mjs`, run `node --check`.
- Full dataset regeneration (`node scripts/fetch_places.mjs`) populates the two
  fields; verify `janTempF < julTempF` for essentially all places and that
  known cities look plausible.
