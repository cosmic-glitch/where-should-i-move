// One-off data acquisition: top US places by % Asian Indian (alone or in any combination).
//
// Requires a Census API key. Set CENSUS_API_KEY in the environment, or in a `.env`
// file at the repo root (gitignored). Sign up free at:
//   https://api.census.gov/data/key_signup.html
//
// Source: U.S. Census Bureau ACS 5-year estimates, 2023 vintage.
// Variables:
//   B02018_021E — "South Asian: Asian Indian" (alone or in combination)
//   B02011_001E — total Asian (alone or in any combination) — proper unique-persons count
//                 (NOT B02018_001E which is a tally and can sum to >100% of population)
//   B01003_001E — total population
//   B19013_001E — median household income (in inflation-adjusted dollars)
//   B25077_001E — median value of owner-occupied housing units
//   B15003_001E / _022..025E — educational attainment for population 25+: total / bachelor's,
//                              master's, professional, doctoral. % Bach+ = sum(22..25)/01.
//   B19001_001E / _017E — household income distribution: total HHs / HHs earning $200k+.
//
// Run:  node scripts/fetch_places.mjs
//   Writes the regenerated dataset to ../data/places.js (relative to this script).
//   index.html loads that file via <script src="data/places.js">; no splicing required.
//
// Census API is unkeyed (rate-limited at 500 requests/day per IP). We make 51+ calls.

// Load Census API key from .env (simple parser — no dotenv dep) or env var.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
function loadCensusKey() {
  if (process.env.CENSUS_API_KEY) return process.env.CENSUS_API_KEY;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const envPath = resolve(here, "..", ".env");
    const text = readFileSync(envPath, "utf8");
    const m = text.match(/^\s*CENSUS_API_KEY\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  } catch {}
  throw new Error(
    "CENSUS_API_KEY not set. Add it to .env or export it. " +
    "Sign up at https://api.census.gov/data/key_signup.html"
  );
}
const CENSUS_KEY = loadCensusKey();

const STATES = [
  ["01", "Alabama"], ["02", "Alaska"], ["04", "Arizona"], ["05", "Arkansas"],
  ["06", "California"], ["08", "Colorado"], ["09", "Connecticut"], ["10", "Delaware"],
  ["11", "District of Columbia"], ["12", "Florida"], ["13", "Georgia"], ["15", "Hawaii"],
  ["16", "Idaho"], ["17", "Illinois"], ["18", "Indiana"], ["19", "Iowa"],
  ["20", "Kansas"], ["21", "Kentucky"], ["22", "Louisiana"], ["23", "Maine"],
  ["24", "Maryland"], ["25", "Massachusetts"], ["26", "Michigan"], ["27", "Minnesota"],
  ["28", "Mississippi"], ["29", "Missouri"], ["30", "Montana"], ["31", "Nebraska"],
  ["32", "Nevada"], ["33", "New Hampshire"], ["34", "New Jersey"], ["35", "New Mexico"],
  ["36", "New York"], ["37", "North Carolina"], ["38", "North Dakota"], ["39", "Ohio"],
  ["40", "Oklahoma"], ["41", "Oregon"], ["42", "Pennsylvania"], ["44", "Rhode Island"],
  ["45", "South Carolina"], ["46", "South Dakota"], ["47", "Tennessee"], ["48", "Texas"],
  ["49", "Utah"], ["50", "Vermont"], ["51", "Virginia"], ["53", "Washington"],
  ["54", "West Virginia"], ["55", "Wisconsin"], ["56", "Wyoming"],
];

const POP_FLOOR = 5000;
// No demographic floor — include every place ≥ POP_FLOOR. Users filter in the UI.

// "Strong MCD" states: townships/towns are the primary local government unit,
// not represented in the Census Place hierarchy. We additionally query their
// county subdivisions so entries like Plainsboro Township NJ, Edison Township NJ,
// Lexington Town MA, etc., show up.
const STRONG_MCD_STATE_FIPS = new Set([
  "09", // Connecticut
  "23", // Maine
  "25", // Massachusetts
  "26", // Michigan
  "27", // Minnesota
  "33", // New Hampshire
  "34", // New Jersey
  "36", // New York
  "42", // Pennsylvania
  "44", // Rhode Island
  "50", // Vermont
  "55", // Wisconsin
]);

// Curated metro-area lookup: stateFP -> counties (without "County" suffix) -> metro name.
// Covers the major U.S. CBSAs that contain Indian-heavy places. Lookup falls back to null
// (place shown without a metro label) for counties not listed.
const METROS = {
  "San Francisco Bay Area": { "06": ["Santa Clara","San Mateo","Alameda","San Francisco","Contra Costa","Marin","Solano","Sonoma","Napa"] },
  "Los Angeles":            { "06": ["Los Angeles","Orange"] },
  "San Diego":              { "06": ["San Diego"] },
  "Sacramento":             { "06": ["Sacramento","Placer","El Dorado","Yolo","Sutter","Yuba"] },
  "Inland Empire":          { "06": ["Riverside","San Bernardino"] },
  "Central Valley":         { "06": ["San Joaquin","Stanislaus","Merced","Fresno","Madera","Kings","Tulare","Kern"] },
  "Dallas–Fort Worth":      { "48": ["Dallas","Tarrant","Collin","Denton","Rockwall","Ellis","Kaufman","Johnson","Hood","Wise","Parker","Somervell","Palo Pinto","Hunt"] },
  "Houston":                { "48": ["Harris","Fort Bend","Montgomery","Brazoria","Galveston","Liberty","Waller","Chambers","Austin","San Jacinto"] },
  "Austin":                 { "48": ["Travis","Williamson","Hays","Bastrop","Caldwell"] },
  "San Antonio":            { "48": ["Bexar","Comal","Guadalupe","Wilson","Bandera","Atascosa","Kendall","Medina"] },
  "New York City":          { "36": ["New York","Bronx","Kings","Queens","Richmond","Nassau","Suffolk","Westchester","Rockland","Orange","Putnam","Dutchess"],
                              "34": ["Bergen","Essex","Hudson","Hunterdon","Middlesex","Monmouth","Morris","Ocean","Passaic","Somerset","Sussex","Union","Warren"],
                              "42": ["Pike"] },
  "Philadelphia":           { "42": ["Philadelphia","Bucks","Chester","Delaware","Montgomery"],
                              "34": ["Burlington","Camden","Gloucester","Salem"],
                              "10": ["New Castle"],
                              "24": ["Cecil"] },
  "Washington, D.C.":       { "11": ["District of Columbia"],
                              "51": ["Arlington","Fairfax","Loudoun","Prince William","Stafford","Spotsylvania","Fauquier","Culpeper","Madison","Rappahannock","Warren","Clarke","Alexandria city","Fairfax city","Falls Church city","Manassas city","Manassas Park city","Fredericksburg city"],
                              "24": ["Montgomery","Prince George's","Frederick","Charles","Calvert"],
                              "54": ["Jefferson","Berkeley"] },
  "Baltimore":              { "24": ["Baltimore","Baltimore city","Anne Arundel","Howard","Harford","Carroll","Queen Anne's"] },
  "Boston":                 { "25": ["Suffolk","Norfolk","Plymouth","Bristol","Essex","Middlesex"],
                              "33": ["Rockingham","Strafford"] },
  "Chicago":                { "17": ["Cook","DuPage","Kane","Kendall","Lake","McHenry","Will"],
                              "18": ["Lake","Porter","Newton","Jasper"],
                              "55": ["Kenosha"] },
  "Atlanta":                { "13": ["Fulton","DeKalb","Gwinnett","Cobb","Clayton","Cherokee","Forsyth","Henry","Douglas","Fayette","Paulding","Coweta","Carroll","Newton","Rockdale","Bartow","Pickens","Spalding","Walton","Lamar","Heard","Butts","Jasper","Morgan","Barrow","Dawson","Hall","Haralson","Meriwether","Pike"] },
  "Detroit":                { "26": ["Wayne","Oakland","Macomb","Livingston","Lapeer","St. Clair"] },
  "Phoenix":                { "04": ["Maricopa","Pinal"] },
  "Seattle":                { "53": ["King","Snohomish","Pierce"] },
  "Minneapolis–St. Paul":   { "27": ["Hennepin","Ramsey","Dakota","Anoka","Washington","Scott","Carver","Wright","Sherburne","Chisago","Isanti","Mille Lacs","Le Sueur","Sibley"],
                              "55": ["Pierce","St. Croix"] },
  "Tampa":                  { "12": ["Hillsborough","Pinellas","Pasco","Hernando"] },
  "Orlando":                { "12": ["Orange","Seminole","Lake","Osceola"] },
  "Miami":                  { "12": ["Miami-Dade","Broward","Palm Beach"] },
  "Jacksonville":           { "12": ["Duval","St. Johns","Clay","Nassau","Baker"] },
  "Charlotte":              { "37": ["Mecklenburg","Cabarrus","Gaston","Union","Iredell","Rowan","Lincoln","Anson"],
                              "45": ["York","Lancaster","Chester"] },
  "Raleigh–Durham":         { "37": ["Wake","Johnston","Franklin","Granville","Durham","Orange","Chatham","Person"] },
  "Pittsburgh":             { "42": ["Allegheny","Westmoreland","Washington","Butler","Beaver","Armstrong","Fayette","Indiana"] },
  "Portland (OR)":          { "41": ["Multnomah","Washington","Clackamas","Columbia","Yamhill"],
                              "53": ["Clark","Skamania"] },
  "Denver":                 { "08": ["Denver","Arapahoe","Jefferson","Adams","Douglas","Broomfield","Elbert","Park","Clear Creek","Gilpin"] },
  "Indianapolis":           { "18": ["Marion","Hamilton","Hendricks","Johnson","Hancock","Madison","Boone","Morgan","Brown","Putnam","Shelby"] },
  "Columbus (OH)":          { "39": ["Franklin","Delaware","Fairfield","Licking","Madison","Pickaway","Union"] },
  "Cincinnati":             { "39": ["Hamilton","Butler","Warren","Clermont"],
                              "21": ["Boone","Kenton","Campbell"],
                              "18": ["Dearborn"] },
  "Cleveland":              { "39": ["Cuyahoga","Lake","Lorain","Medina","Geauga"] },
  "Memphis":                { "47": ["Shelby","Tipton","Fayette"],
                              "28": ["DeSoto","Marshall","Tate"],
                              "05": ["Crittenden"] },
  "Nashville":              { "47": ["Davidson","Williamson","Rutherford","Wilson","Sumner","Robertson","Dickson","Cheatham","Maury","Smith","Macon","Trousdale","Cannon","Hickman"] },
  "St. Louis":              { "29": ["St. Louis","St. Louis city","St. Charles","Jefferson","Franklin","Lincoln","Warren"],
                              "17": ["Madison","St. Clair","Monroe","Clinton","Bond","Macoupin","Jersey","Calhoun"] },
  "Kansas City":            { "29": ["Jackson","Clay","Cass","Platte","Ray","Caldwell"],
                              "20": ["Johnson","Wyandotte","Leavenworth","Linn","Miami"] },
  "Las Vegas":              { "32": ["Clark"] },
  "Salt Lake City":         { "49": ["Salt Lake","Tooele"] },
  // Connecticut switched from counties to Planning Regions in the 2022+ ACS.
  "Hartford":               { "09": ["Hartford","Tolland","Middlesex","Capitol Planning Region","Lower Connecticut River Valley Planning Region","Northeastern Connecticut Planning Region"] },
  "New Haven":              { "09": ["New Haven","South Central Connecticut Planning Region","Naugatuck Valley Planning Region"] },
  "Stamford–Bridgeport":    { "09": ["Fairfield","Western Connecticut Planning Region","Greater Bridgeport Planning Region"] },
  "Trenton–Princeton":      { "34": ["Mercer"] },
  "Worcester":              { "25": ["Worcester"] },
  "Allentown":              { "42": ["Lehigh","Northampton","Carbon"] },
  "Harrisburg":             { "42": ["Dauphin","Cumberland","Perry"] },
  "Lancaster (PA)":         { "42": ["Lancaster"] },
  "Reading (PA)":           { "42": ["Berks"] },
  "Northwest Arkansas":     { "05": ["Benton","Washington","Madison"] },
  "Lansing":                { "26": ["Ingham","Eaton","Clinton"] },
  "Lafayette (IN)":         { "18": ["Tippecanoe","Benton","Carroll"] },
  "Columbus (IN)":          { "18": ["Bartholomew"] },
  "Akron":                  { "39": ["Summit","Portage"] },
  "Lehigh Valley":          { "42": ["Lehigh","Northampton"] },
  "Atlantic City":          { "34": ["Atlantic"] },
  "Asheville":              { "37": ["Buncombe","Henderson","Madison","Haywood"] },
  "Winston-Salem":          { "37": ["Forsyth","Davidson","Stokes","Yadkin","Davie"] },
  "Greensboro":             { "37": ["Guilford","Randolph","Rockingham"] },
  "Greenville (SC)":        { "45": ["Greenville","Anderson","Pickens","Laurens"] },
  "Columbia (SC)":          { "45": ["Richland","Lexington","Saluda","Calhoun","Kershaw","Fairfield"] },
  "Charleston (SC)":        { "45": ["Charleston","Berkeley","Dorchester"] },
  "Knoxville":              { "47": ["Knox","Anderson","Blount","Loudon","Union","Grainger"] },
  "Chattanooga":            { "47": ["Hamilton","Marion","Sequatchie"],
                              "13": ["Walker","Catoosa","Dade"] },
  "Tucson":                 { "04": ["Pima"] },
  "Boise":                  { "16": ["Ada","Canyon","Boise","Gem","Owyhee"] },
  "Spokane":                { "53": ["Spokane","Stevens","Pend Oreille"] },
  "Eugene":                 { "41": ["Lane"] },
  "Honolulu":               { "15": ["Honolulu"] },
  "Anchorage":              { "02": ["Anchorage"] },
  "Omaha":                  { "31": ["Douglas","Sarpy","Washington"],
                              "19": ["Pottawattamie"] },
  "Des Moines":             { "19": ["Polk","Dallas","Warren","Madison","Guthrie","Story","Jasper","Marion"] },
  "Oklahoma City":          { "40": ["Oklahoma","Cleveland","Canadian","Pottawatomie","Logan","Lincoln","McClain","Grady"] },
  "Tulsa":                  { "40": ["Tulsa","Rogers","Wagoner","Creek","Okmulgee","Osage","Pawnee"] },
  "Providence":             { "44": ["Providence","Kent","Newport","Bristol","Washington"] },
  "Richmond":               { "51": ["Henrico","Chesterfield","Hanover","Goochland","Powhatan","New Kent","Charles City","Dinwiddie","Prince George","Sussex","Amelia","Caroline","King William","King and Queen","Cumberland","Louisa","Richmond city","Hopewell city","Petersburg city","Colonial Heights city"] },
  "Hampton Roads":          { "51": ["Norfolk city","Virginia Beach city","Chesapeake city","Newport News city","Hampton city","Portsmouth city","Suffolk city","Williamsburg city","Poquoson city","James City","York","Gloucester","Mathews","Isle of Wight","Southampton","Surry"] },
  "Birmingham":             { "01": ["Jefferson","Shelby","St. Clair","Walker","Blount","Bibb","Chilton"] },
  "Louisville":             { "21": ["Jefferson","Oldham","Bullitt","Shelby","Spencer","Henry","Trimble"] },
  "Buffalo":                { "36": ["Erie","Niagara"] },
  "Albany":                 { "36": ["Albany","Rensselaer","Saratoga","Schenectady"] },
  "Rochester":              { "36": ["Monroe","Livingston","Ontario","Orleans","Wayne","Yates"] },
  "Syracuse":               { "36": ["Onondaga","Madison","Oswego"] },
  "Madison (WI)":           { "55": ["Dane","Iowa","Columbia","Green"] },
  "Milwaukee":              { "55": ["Milwaukee","Waukesha","Ozaukee","Washington"] },
  "Reno":                   { "32": ["Washoe","Storey"] },
};
// Flatten into a single lookup map: `${stateFP}|${countyName}` -> metro name.
const COUNTY_TO_METRO = new Map();
for (const [metro, byState] of Object.entries(METROS)) {
  for (const [stateFP, counties] of Object.entries(byState)) {
    for (const c of counties) COUNTY_TO_METRO.set(`${stateFP}|${c}`, metro);
  }
}

// Place-to-County crosswalk loaded once at script start from the Census Bureau.
let PLACE_TO_COUNTY = null;
// 2024 county-level presidential Democratic margin (per_dem - per_gop, ×100), keyed by
// `${stateName}|${cleanCounty}`. Loaded once from the tonmcg/MEDSL aggregation.
let COUNTY_DEM_MARGIN = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Fetch with retry + linear backoff for flaky external endpoints — the Census API
// 503s intermittently mid-run, and the climate.gov ArcGIS Hub generates its CSV
// on demand and occasionally returns a bad/incomplete body with a 200. `validate`
// inspects the parsed body and returns a problem string to force a retry (used to
// reject a FEMA CSV that's missing the column we need, or non-array Census JSON).
async function fetchWithRetry(url, { tries = 5, baseDelay = 1500, label = url, parse = "text", validate } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = parse === "json" ? await res.json() : await res.text();
      const problem = validate && validate(body);
      if (problem) throw new Error(problem);
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < tries) {
        const delay = baseDelay * attempt;
        console.error(`  ${label}: ${e.message} — retry ${attempt}/${tries - 1} in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw new Error(`${label}: ${lastErr.message} (after ${tries} attempts)`);
}

async function loadCountyElection() {
  const url = "https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master/2024_US_County_Level_Presidential_Results.csv";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`county election: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const map = new Map();
  const lines = text.split("\n");
  // Header: state_name,county_fips,county_name,votes_gop,votes_dem,total_votes,diff,per_gop,per_dem,per_point_diff
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 10) continue;
    const stateName = parts[0];
    let countyName = parts[2].replace(/ (County|Parish|Borough|Census Area|Municipality|city)$/i, "").trim();
    const perGop = parseFloat(parts[7]);
    const perDem = parseFloat(parts[8]);
    if (!Number.isFinite(perGop) || !Number.isFinite(perDem)) continue;
    const margin = +((perDem - perGop) * 100).toFixed(1);
    map.set(`${stateName}|${countyName}`, margin);
  }
  COUNTY_DEM_MARGIN = map;
  console.error(`Loaded 2024 county election margins: ${map.size} counties`);
}
function demMarginFor(stateName, county) {
  if (!county || !COUNTY_DEM_MARGIN) return null;
  const v = COUNTY_DEM_MARGIN.get(`${stateName}|${county}`);
  return v === undefined ? null : v;
}

// FEMA National Risk Index — natural-hazard risk at the county level, keyed by
// `${stateName}|${cleanCounty}` → { ratePct, topHazards } to reuse the same
// county-name join as demMargin (no FIPS plumbing needed). `ratePct` is the national
// percentile of the composite Expected Annual Loss *rate* — expected hazard loss per
// dollar of exposed property, so unlike the composite Risk Index it is independent of
// county size (a small wildfire county can outrank a big metro). `topHazards` lists
// the 3 hazards contributing the most expected-annual-loss dollars, the figures FEMA
// sums into the composite. Counties with no rate (insufficient data) drop to null.
// Source: FEMA NRI, via the climate.gov ArcGIS Hub county CSV.
let COUNTY_NRI = null;
async function loadCountyNRI() {
  const url = "https://resilience.climate.gov/datasets/FEMA::national-risk-index-counties.csv";
  const EXPECTED_COL = "Expected Annual Loss Rate - National Percentile - Composite";
  const text = await fetchWithRetry(url, {
    label: "FEMA NRI",
    // The on-demand CSV sometimes returns a bad body with 200; require the header.
    validate: b => b.split("\n", 1)[0].includes(EXPECTED_COL) ? null : "response missing expected columns",
  });
  const lines = text.replace(/\r/g, "").split("\n");
  const header = lines[0].replace(/^﻿/, "").split(",");
  const iState = header.indexOf("State Name");
  const iCounty = header.indexOf("County Name");
  const iRatePct = header.indexOf("Expected Annual Loss Rate - National Percentile - Composite");
  if (iState < 0 || iCounty < 0 || iRatePct < 0) {
    throw new Error("FEMA NRI: expected columns not found (schema changed?)");
  }
  // Per-hazard columns: each of the ~17 hazards has a "<Hazard> - Hazard Type Risk
  // Index Rating" (for the display label) and an "<Hazard> - Expected Annual Loss -
  // Total" (the dollar figure that drives the composite — used to rank the top 3).
  // Discover them by name so it survives schema/order changes.
  const hazardCols = [];
  for (let c = 0; c < header.length; c++) {
    const m = header[c].match(/^(.*) - Hazard Type Risk Index Rating$/);
    if (!m) continue;
    const ealIdx = header.indexOf(`${m[1]} - Expected Annual Loss - Total`);
    if (ealIdx >= 0) hazardCols.push({ name: m[1], iRate: c, iEal: ealIdx });
  }
  const SKIP_RATING = new Set(["", "Not Applicable", "Insufficient Data", "No Rating"]);
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const parts = lines[i].split(",");
    if (parts.length < header.length) continue;
    const stateName = parts[iState].trim();
    // County Name is already suffix-free ("Autauga"); strip defensively anyway.
    const county = parts[iCounty].replace(/ (County|Parish|Borough|Census Area|Municipality|city)$/i, "").trim();
    const ratePct = parseFloat(parts[iRatePct]);
    if (!stateName || !county || !Number.isFinite(ratePct)) continue;
    // Top 3 contributing hazards by expected-annual-loss dollars, "Name (Rating)".
    const drivers = [];
    for (const hz of hazardCols) {
      const rt = parts[hz.iRate].trim();
      const eal = parseFloat(parts[hz.iEal]);
      if (SKIP_RATING.has(rt) || !Number.isFinite(eal)) continue;
      drivers.push({ name: hz.name, rating: rt, eal });
    }
    drivers.sort((a, b) => b.eal - a.eal);
    const topHazards = drivers.slice(0, 3).map(d => `${d.name} (${d.rating})`).join(", ") || null;
    map.set(`${stateName}|${county}`, { ratePct: +ratePct.toFixed(1), topHazards });
  }
  COUNTY_NRI = map;
  console.error(`Loaded FEMA National Risk Index: ${map.size} counties`);
}
function nriFor(stateName, county) {
  const empty = { ratePct: null, topHazards: null };
  if (!county || !COUNTY_NRI) return empty;
  return COUNTY_NRI.get(`${stateName}|${county}`) || empty;
}

async function loadPlaceToCounty() {
  const url = "https://www2.census.gov/geo/docs/reference/codes2020/national_place2020.txt";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`place→county crosswalk: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const map = new Map();
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("|");
    if (parts.length < 9) continue;
    const stateFP = parts[1], placeFP = parts[2];
    // Multi-county places use "~~~" separator; take the first (typically the primary).
    const counties = parts[8].split("~~~").map(s => s.trim()).filter(Boolean);
    if (counties.length === 0) continue;
    const first = counties[0].replace(/ (County|Parish|Borough|Census Area|Municipality|city)$/i, "");
    map.set(`${stateFP}|${placeFP}`, first);
  }
  PLACE_TO_COUNTY = map;
  console.error(`Loaded place→county crosswalk: ${map.size} entries`);
}

// Land area in sq mi, keyed by full GEOID (state+place FIPS for places,
// state+county+cousub FIPS for cousubs — both as zero-padded strings).
// Sourced from the 2023 Census Gazetteer (zipped tab-separated files).
let LAND_AREA = null;
function unzipFirstEntry(zipBuf) {
  // The Gazetteer zips contain a single text file; shell out to `unzip -p`
  // to extract it (no dependency, present on macOS/Linux by default).
  const dir = mkdtempSync(join(tmpdir(), "gaz-"));
  const zipPath = join(dir, "in.zip");
  writeFileSync(zipPath, zipBuf);
  return execSync(`unzip -p "${zipPath}"`, { maxBuffer: 128 * 1024 * 1024 }).toString("utf8");
}
async function loadLandArea() {
  const urls = [
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip",
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_cousubs_national.zip",
  ];
  const map = new Map();
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`gazetteer ${url}: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = unzipFirstEntry(buf);
    const lines = text.split(/\r?\n/);
    const header = lines[0].split("\t").map(s => s.trim());
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
  }
  LAND_AREA = map;
  console.error(`Loaded land-area gazetteer: ${map.size} geographies`);
}

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
  const idIdx    = header.indexOf("GHCN_ID");
  const monthIdx = header.indexOf("month");
  const tavgIdx  = header.indexOf("MLY-TAVG-NORMAL");
  const flagIdx  = header.indexOf("meas_flag_MLY-TAVG-NORMAL");
  if (idIdx < 0 || monthIdx < 0 || tavgIdx < 0 || flagIdx < 0) {
    throw new Error(`NOAA normals: missing expected columns (header was ${header.join("|")})`);
  }
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    // Naive comma-split is safe: this NOAA by-variable file has only station
    // IDs, numbers, dates, and single-char flags — no quoted free-text fields.
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

// For county subdivisions, county/region comes from inside the NAME field:
//   "Plainsboro township, Middlesex County, New Jersey" -> "Middlesex"
//   "Avon town, Capitol Planning Region, Connecticut" -> "Capitol Planning Region"
function countyFromMcdName(raw) {
  const parts = raw.split(",").map(s => s.trim());
  if (parts.length < 3) return null;
  return parts[1].replace(/ (County|Parish|Borough|Census Area|Municipality)$/i, "").trim();
}

function metroFor(stateFP, county) {
  if (!county) return null;
  return COUNTY_TO_METRO.get(`${stateFP}|${county}`) || null;
}

// "Cupertino city, California" -> "Cupertino"
// "Edison township, New Jersey" -> "Edison"
// "Reston CDP, Virginia" -> "Reston"
function cleanName(raw) {
  // Strip ", State"
  let s = raw.replace(/,.*$/, "");
  // Strip common suffixes
  s = s.replace(/\s+(city|town|township|village|borough|CDP|municipality|consolidated government|metro government|metropolitan government|unified government|urban county|comunidad|zona urbana)$/i, "");
  // Some entries have "Village of" or "City of" prefixes (rare)
  s = s.replace(/^(Village of |City of |Town of )/i, "");
  return s.trim();
}

const ACS_VARS = [
  "NAME",
  "B02018_021E", // Asian Indian (alone or in combination)
  "B02011_001E", // total Asian (alone or in any combination)
  "B01003_001E", // total population
  "B19013_001E", // median household income
  "B25077_001E", // median value, owner-occupied homes
  "B15003_001E", // population 25+
  "B15003_022E", // bachelor's degree
  "B15003_023E", // master's degree
  "B15003_024E", // professional school degree
  "B15003_025E", // doctorate degree
  "B19001_001E", // total households
  "B19001_017E", // households earning $200k+
  "B05012_001E", // total (nativity denominator)
  "B05012_003E", // foreign born
  "B01002_001E", // median age (total population)
  "B25003_001E", // total occupied housing units (tenure denom)
  "B25003_002E", // owner-occupied housing units
  "B19013D_001E",// median HHI, Asian-alone householder (suppressed for small N)
  "B03002_001E", // race/ethnicity total (Hispanic-origin-by-race denominator)
  "B03002_003E", // White alone, not Hispanic or Latino
  "B03002_004E", // Black or African American alone, not Hispanic or Latino
  "B03002_012E", // Hispanic or Latino (of any race)
  "B17001_001E", // population for whom poverty status is determined
  "B17001_002E", // income in the past 12 months below the poverty level
].join(",");

async function fetchGeography(fips, name, geoQuery) {
  const url = `https://api.census.gov/data/2023/acs/acs5?get=${ACS_VARS}&for=${encodeURIComponent(geoQuery)}&in=state:${fips}&key=${CENSUS_KEY}`;
  // Census 503s intermittently; retry so a transient blip doesn't silently drop a state.
  const rows = await fetchWithRetry(url, {
    label: `${name} (${fips}, ${geoQuery})`,
    parse: "json",
    validate: b => Array.isArray(b) ? null : "unexpected (non-array) response",
  });
  const isPlace = geoQuery === "place:*";
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const [
      rawName,
      indianStr, asianStr, popStr, hhiStr, homeStr,
      eduTotalStr, eduBachStr, eduMastStr, eduProfStr, eduDocStr,
      hhTotalStr, hh200kStr,
      natTotalStr, natForeignStr,
      medianAgeStr,
      tenTotalStr, tenOwnerStr,
      asianHhiStr,
      raceTotalStr, whiteStr, blackStr, hispanicStr,
      povTotalStr, povBelowStr,
    ] = row;
    const population = parseInt(popStr, 10);
    const indian = parseInt(indianStr, 10);
    const asian = parseInt(asianStr, 10);
    const medianHHI = parseInt(hhiStr, 10);
    const medianHomeValue = parseInt(homeStr, 10);
    const eduTotal = parseInt(eduTotalStr, 10);
    const eduBachPlus = [eduBachStr, eduMastStr, eduProfStr, eduDocStr]
      .map(s => parseInt(s, 10))
      .reduce((a, v) => a + (Number.isFinite(v) && v >= 0 ? v : 0), 0);
    const hhTotal = parseInt(hhTotalStr, 10);
    const hh200k = parseInt(hh200kStr, 10);
    const natTotal = parseInt(natTotalStr, 10);
    const natForeign = parseInt(natForeignStr, 10);
    const medianAgeRaw = parseFloat(medianAgeStr);
    const tenTotal = parseInt(tenTotalStr, 10);
    const tenOwner = parseInt(tenOwnerStr, 10);
    const asianHhi = parseInt(asianHhiStr, 10);
    const raceTotal = parseInt(raceTotalStr, 10);
    const white = parseInt(whiteStr, 10);
    const black = parseInt(blackStr, 10);
    const hispanic = parseInt(hispanicStr, 10);
    const povTotal = parseInt(povTotalStr, 10);
    const povBelow = parseInt(povBelowStr, 10);
    if (!Number.isFinite(population) || population < POP_FLOOR) continue;
    // County + GEOID: for places, look up via Place-to-County crosswalk;
    // for MCDs, parse county from NAME. GEOID key for the land-area lookup
    // is `${stateFP}${placeFP}` (places, 7 digits) or `${stateFP}${countyFP}${cousubFP}`
    // (cousubs, 10 digits) — matches the Census Gazetteer GEOID column.
    let county = null;
    let geoid = null;
    if (isPlace) {
      const placeFP = row[row.length - 1];
      county = PLACE_TO_COUNTY ? (PLACE_TO_COUNTY.get(`${fips}|${placeFP}`) || null) : null;
      geoid = `${fips}${placeFP}`;
    } else {
      county = countyFromMcdName(rawName);
      const cousubFP = row[row.length - 1];
      const countyFP = row[row.length - 2];
      geoid = `${fips}${countyFP}${cousubFP}`;
    }
    // % Asian = (Asian alone or in combination) / total population.
    const pctAsian = Number.isFinite(asian) && asian >= 0
      ? +(asian / population).toFixed(4)
      : null;
    // % adults 25+ with bachelor's degree or higher.
    const pctBach = Number.isFinite(eduTotal) && eduTotal > 0
      ? +(eduBachPlus / eduTotal).toFixed(4)
      : null;
    // % households earning $200k+ (top bracket of B19001).
    const pct200k = Number.isFinite(hhTotal) && hhTotal > 0 && Number.isFinite(hh200k) && hh200k >= 0
      ? +(hh200k / hhTotal).toFixed(4)
      : null;
    // % foreign-born (B05012_003 / B05012_001).
    const pctForeignBorn = Number.isFinite(natTotal) && natTotal > 0 && Number.isFinite(natForeign) && natForeign >= 0
      ? +(natForeign / natTotal).toFixed(4)
      : null;
    // Race/ethnicity shares from B03002 (mutually exclusive): Hispanic of any
    // race, and non-Hispanic White / Black alone.
    const raceShare = n => Number.isFinite(raceTotal) && raceTotal > 0 && Number.isFinite(n) && n >= 0
      ? +(n / raceTotal).toFixed(4)
      : null;
    const pctHispanic = raceShare(hispanic);
    const pctWhite = raceShare(white);
    const pctBlack = raceShare(black);
    // % of people below the poverty line (B17001_002 / B17001_001).
    const pctPoverty = Number.isFinite(povTotal) && povTotal > 0 && Number.isFinite(povBelow) && povBelow >= 0
      ? +(povBelow / povTotal).toFixed(4)
      : null;
    // Median age — Census uses negative sentinels for suppression.
    const medianAge = Number.isFinite(medianAgeRaw) && medianAgeRaw > 0 ? +medianAgeRaw.toFixed(1) : null;
    // % homeownership (owner-occupied / total occupied).
    const pctHomeowner = Number.isFinite(tenTotal) && tenTotal > 0 && Number.isFinite(tenOwner) && tenOwner >= 0
      ? +(tenOwner / tenTotal).toFixed(4)
      : null;
    // Asian-alone-householder median HHI (suppressed for small N).
    const asianMedianHHI = Number.isFinite(asianHhi) && asianHhi > 0 ? asianHhi : null;
    // Population density: people per square mile of land area.
    const gaz = LAND_AREA ? LAND_AREA.get(geoid) : null;
    const landSqMi = gaz ? gaz.sqmi : null;
    const popDensity = landSqMi && landSqMi > 0 ? Math.round(population / landSqMi) : null;
    // FEMA National Risk Index (county level), joined by county name like demMargin.
    const nri = nriFor(name, county);
    out.push({
      name: cleanName(rawName),
      state: name,
      population,
      pctIndian: Number.isFinite(indian) && indian >= 0
        ? +(indian / population).toFixed(4)
        : 0,
      pctAsian,
      // Census returns negative sentinel values (e.g. -666666666) when suppressed; coerce to null.
      medianHHI: Number.isFinite(medianHHI) && medianHHI > 0 ? medianHHI : null,
      medianHomeValue: Number.isFinite(medianHomeValue) && medianHomeValue > 0 ? medianHomeValue : null,
      pctBach,
      pct200k,
      pctForeignBorn,
      pctHispanic,
      pctBlack,
      pctWhite,
      pctPoverty,
      medianAge,
      pctHomeowner,
      asianMedianHHI,
      popDensity,
      metro: metroFor(fips, county),
      demMargin: demMarginFor(name, county),
      femaEalRatePct: nri.ratePct,
      femaTopHazards: nri.topHazards,
      _lat: gaz ? gaz.lat : null,
      _lon: gaz ? gaz.lon : null,
    });
  }
  return out;
}

async function fetchState([fips, name]) {
  const places = await fetchGeography(fips, name, "place:*");
  if (!STRONG_MCD_STATE_FIPS.has(fips)) return places;
  // Strong-MCD states: also pull county subdivisions (townships, towns, boroughs).
  const mcds = await fetchGeography(fips, name, "county subdivision:*");
  // Dedupe by (cleanName, state): keep the entry with the larger population,
  // which is usually the township when it conflicts with a CDP it contains.
  const byKey = new Map();
  for (const p of [...places, ...mcds]) {
    const key = `${p.state}|${p.name}`;
    const prev = byKey.get(key);
    if (!prev || p.population > prev.population) byKey.set(key, p);
  }
  return [...byKey.values()];
}

async function main() {
  await loadPlaceToCounty();
  await loadCountyElection();
  await loadCountyNRI();
  await loadLandArea();
  console.error(`Fetching ${STATES.length} states (population floor ${POP_FLOOR}, no demographic filter)...`);
  const all = [];
  const failures = [];
  for (const s of STATES) {
    try {
      const places = await fetchState(s);
      all.push(...places);
    } catch (e) {
      console.error(`  ${s[1].padEnd(22)} → ERROR: ${e.message}`);
      failures.push(s[1]);
    }
  }
  // Abort rather than write a truncated dataset: a state that fails even after
  // retries would silently drop hundreds of places. Better to fail loudly and rerun.
  if (failures.length) {
    throw new Error(`${failures.length} state(s) failed after retries: ${failures.join(", ")}. Aborting without writing (rerun to get a complete dataset).`);
  }
  console.error(`Total places fetched: ${all.length}`);
  await loadClimate(all);
  all.sort((a, b) => b.pctIndian - a.pctIndian);
  console.error(`Top 5 by % Asian Indian:`);
  all.slice(0, 5).forEach((p, i) => console.error(`  ${i + 1}. ${p.name}, ${p.state} — ${(p.pctIndian * 100).toFixed(1)}% Indian (pop ${p.population.toLocaleString()})`));
  const filtered = all;

  // Write the regenerated dataset to data/places.js (sibling of scripts/).
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, "..", "data", "places.js");
  const lines = [
    `// Auto-generated by scripts/fetch_places.mjs. Do not edit by hand.`,
    `// Source: U.S. Census ACS 5-year 2023.`,
    `// Per-place fields:`,
    `//   pctIndian       = B02018_021E / B01003_001E   (Asian Indian, alone or in combination)`,
    `//   pctAsian        = B02011_001E / B01003_001E   (total Asian, alone or in combination)`,
    `//   medianHHI       = B19013_001E`,
    `//   medianHomeValue = B25077_001E`,
    `//   pctBach         = sum(B15003_022..025E) / B15003_001E`,
    `//   pct200k         = B19001_017E / B19001_001E`,
    `//   pctForeignBorn  = B05012_003E / B05012_001E`,
    `//   pctHispanic     = B03002_012E / B03002_001E   (Hispanic or Latino, any race)`,
    `//   pctBlack        = B03002_004E / B03002_001E   (Black alone, non-Hispanic)`,
    `//   pctWhite        = B03002_003E / B03002_001E   (White alone, non-Hispanic)`,
    `//   pctPoverty      = B17001_002E / B17001_001E   (people below the poverty line)`,
    `//   medianAge       = B01002_001E`,
    `//   pctHomeowner    = B25003_002E / B25003_001E`,
    `//   asianMedianHHI  = B19013D_001E   (Asian-alone householder; suppressed for small N → null)`,
    `//   popDensity      = population / ALAND_SQMI  (people/mi²; ALAND_SQMI from 2023 Census Gazetteer)`,
    `//   demMargin       = 2024 county presidential margin (Harris − Trump, pct points; MIT/MEDSL)`,
    `//   femaEalRatePct  = FEMA NRI expected-annual-loss RATE, national percentile 0–100 (loss per $ of exposed property; size-independent; county level; null if insufficient data)`,
    `//   femaTopHazards  = top 3 hazards by expected-annual-loss $, "Name (Rating)", comma-joined (county level)`,
    `//   janTempF        = January mean temp, nearest-station 1991–2020 NOAA Climate Normal (°F)`,
    `//   julTempF        = July mean temp, nearest-station 1991–2020 NOAA Climate Normal (°F)`,
    `// Includes Census Places + county subdivisions (townships/towns) for the 12 strong-MCD states.`,
    `// Population floor ${POP_FLOOR.toLocaleString("en-US")}; no demographic filter (users filter in-UI).`,
    `// Loaded by index.html via <script src="data/places.js"></script>; declares global PLACES.`,
    `// Re-generate with: node scripts/fetch_places.mjs`,
    `const PLACES = [`,
  ];
  const num = v => (v === null || v === undefined ? "null" : v);
  for (const p of filtered) {
    const metro = p.metro ? JSON.stringify(p.metro) : "null";
    lines.push(`  { name: ${JSON.stringify(p.name)}, state: ${JSON.stringify(p.state)}, metro: ${metro}, population: ${p.population}, pctIndian: ${p.pctIndian}, pctAsian: ${num(p.pctAsian)}, medianHHI: ${num(p.medianHHI)}, medianHomeValue: ${num(p.medianHomeValue)}, pctBach: ${num(p.pctBach)}, pct200k: ${num(p.pct200k)}, pctForeignBorn: ${num(p.pctForeignBorn)}, pctHispanic: ${num(p.pctHispanic)}, pctBlack: ${num(p.pctBlack)}, pctWhite: ${num(p.pctWhite)}, pctPoverty: ${num(p.pctPoverty)}, medianAge: ${num(p.medianAge)}, pctHomeowner: ${num(p.pctHomeowner)}, asianMedianHHI: ${num(p.asianMedianHHI)}, popDensity: ${num(p.popDensity)}, demMargin: ${num(p.demMargin)}, femaEalRatePct: ${num(p.femaEalRatePct)}, femaTopHazards: ${p.femaTopHazards ? JSON.stringify(p.femaTopHazards) : "null"}, janTempF: ${num(p.janTempF)}, julTempF: ${num(p.julTempF)} },`);
  }
  lines.push(`];`, ``);
  writeFileSync(outPath, lines.join("\n"));
  console.error(`Wrote ${outPath} (${filtered.length} places).`);
}

main().catch(e => { console.error(e); process.exit(1); });
