// Local sink + worklist server for resolving Redfin region URLs per place.
//
// WHY THIS EXISTS: Redfin's CloudFront edge 403s plain node/curl (TLS
// fingerprinting), so the autocomplete endpoint can only be hit from a real
// browser. This node process therefore does NOT call Redfin itself. It only:
//   1. serves the worklist (every PLACES + STATE_ROWS row) at GET /worklist
//   2. receives validated {key, path} results at POST /save
//   3. writes data/redfin_ids.js incrementally (resumable across runs)
//
// The actual crawl runs in the browser (same-origin on https://www.redfin.com,
// which passes CloudFront). The browser cannot fetch() this localhost server
// directly unless you accept Chrome's one-time "access devices on your local
// network" prompt (Private Network Access) — click Allow. Then paste the snippet
// printed by `--snippet` into a redfin.com tab (DevTools console, or drive it via
// the Claude-in-Chrome javascript_tool). It fetches /worklist here, queries Redfin
// autocomplete, strict-validates name+state, and POSTs resolved batches back.
//
// Run:  node scripts/redfin_sink.mjs            (starts server on :8799)
//       node scripts/redfin_sink.mjs --snippet  (prints the browser crawler to paste)
//
// Output: data/redfin_ids.js — two globals loaded by index.html via <script src>
// (plain JS so it works under file://):
//   const REDFIN_IDS       = { "Name|State": "/city/ID/ST/Slug", ... }  // places
//   const REDFIN_STATE_IDS = { "StateName":  "/state/Name",       ... }  // states
// States are namespaced internally as "STATE:<name>" so New York City (key
// "New York|New York") can't be clobbered by the New York state row.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_JS = join(ROOT, "data", "places.js");
const OUT_JS = join(ROOT, "data", "redfin_ids.js");
const PORT = 8799;
const STATE_PREFIX = "STATE:";

const ABBR = { Alabama:"AL",Alaska:"AK",Arizona:"AZ",Arkansas:"AR",California:"CA",Colorado:"CO",Connecticut:"CT",Delaware:"DE",Florida:"FL",Georgia:"GA",Hawaii:"HI",Idaho:"ID",Illinois:"IL",Indiana:"IN",Iowa:"IA",Kansas:"KS",Kentucky:"KY",Louisiana:"LA",Maine:"ME",Maryland:"MD",Massachusetts:"MA",Michigan:"MI",Minnesota:"MN",Mississippi:"MS",Missouri:"MO",Montana:"MT",Nebraska:"NE",Nevada:"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND",Ohio:"OH",Oklahoma:"OK",Oregon:"OR",Pennsylvania:"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD",Tennessee:"TN",Texas:"TX",Utah:"UT",Vermont:"VT",Virginia:"VA",Washington:"WA","West Virginia":"WV",Wisconsin:"WI",Wyoming:"WY","District of Columbia":"DC" };

// Hand-set paths for rows Redfin's autocomplete won't resolve cleanly.
// DC's bare-name query returns a /county/ page; the city page is the useful market.
const OVERRIDES = { [STATE_PREFIX + "District of Columbia"]: "/city/12839/DC/Washington-DC" };

// The browser crawler (printed by --snippet). Paste into a redfin.com tab.
const CRAWLER = String.raw`
const SINK='http://127.0.0.1:8799';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function norm(s){return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[.'’]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\bst\b/g,'saint').replace(/\bft\b/g,'fort').replace(/\bmt\b/g,'mount').replace(/\s+/g,' ').trim();}
const GOV=['township','twp','town','plantation','borough','village','gore','grant','location','purchase','municipality','charter','city'];
function stripGov(n){let p=n.split(' ');while(p.length>1&&GOV.includes(p[p.length-1]))p.pop();return p.join(' ');}
function pickPlace(rows,ourName,ourSt){const o=norm(ourName);for(const r of rows){if(!r||!r.url)continue;const a=r.url.split('/'),type=a[1],st=a[3];if(st!==ourSt)continue;const rn=norm(r.name);if(type==='city'){if(rn===o)return r.url;}else if(type==='minorcivildivision'){if(rn===o||stripGov(rn)===o)return r.url;}}return null;}
function pickState(rows,ourName){const o=norm(ourName);for(const r of rows){if(!r||!r.url)continue;const a=r.url.split('/');if(a[1]==='state'&&norm(a[a.length-1].replace(/-/g,' '))===o)return r.url;}return null;}
async function autocomplete(q){const u='https://www.redfin.com/stingray/do/location-autocomplete?location='+encodeURIComponent(q)+'&v=2&al=1&iss=false';const t=await (await fetch(u,{headers:{'accept':'application/json'},credentials:'include'})).text();if(t.indexOf('CloudFront')>=0||t.indexOf('Request blocked')>=0)throw new Error('BLOCKED');const j=JSON.parse(t.replace(/^\{\}&&/,''));const rows=[],ex=j.payload&&j.payload.exactMatch;if(ex)rows.push(ex);for(const s of ((j.payload&&j.payload.sections)||[]))for(const r of (s.rows||[]))rows.push(r);return rows;}
async function resolveOne(it){const q=it.isState?it.name:(it.name+', '+it.st);for(let a=0;a<3;a++){try{const rows=await autocomplete(q);return it.isState?pickState(rows,it.name):pickPlace(rows,it.name,it.st);}catch(e){if(e.message==='BLOCKED'){window.__prog.blocked++;await sleep(2000+2000*a);}else await sleep(500);}}return null;}
window.__prog={i:0,n:0,ok:0,fail:0,blocked:0,phase:'init'};window.__stop=false;
window.__crawl=async function(){const wl=await (await fetch(SINK+'/worklist')).json();const done=new Set(wl.done);const items=[...wl.places.map(p=>({...p,isState:false})),...wl.states.map(s=>({...s,isState:true}))].filter(it=>!done.has(it.key));window.__prog.n=items.length;window.__prog.phase='running';let ptr=0,batch=[];async function flush(){if(!batch.length)return;const b=batch;batch=[];try{await fetch(SINK+'/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});}catch(e){for(const x of b)batch.push(x);}}async function worker(){while(ptr<items.length&&!window.__stop){const it=items[ptr++];const path=await resolveOne(it);window.__prog.i++;if(path){batch.push({key:it.key,path});window.__prog.ok++;}else window.__prog.fail++;if(batch.length>=25)await flush();await sleep(100);}}await Promise.all(Array.from({length:4},()=>worker()));await flush();window.__prog.phase=window.__stop?'stopped':'done';};
window.__crawl().catch(e=>{window.__prog.phase='ERROR';window.__prog.err=String(e);});
// Keep this tab FOREGROUND (background tabs throttle timers ~1/s). Poll window.__prog.
'crawl kicked off';
`;

if (process.argv.includes("--snippet")) {
  console.log(CRAWLER);
  process.exit(0);
}

// --- load the dataset (defines globals PLACES, STATE_ROWS) ---
const src = readFileSync(DATA_JS, "utf8");
const { PLACES, STATE_ROWS } = new Function(src + "; return { PLACES, STATE_ROWS };")();

const places = PLACES.map((p) => ({ key: p.name + "|" + p.state, name: p.name, st: ABBR[p.state] || "" }));
const states = STATE_ROWS.map((s) => ({ key: STATE_PREFIX + s.name, name: s.name, st: ABBR[s.state] || "" }));

// --- results map (key -> path), resumed from any existing output ---
const results = new Map(Object.entries(OVERRIDES));
if (existsSync(OUT_JS)) {
  try {
    const prev = new Function(readFileSync(OUT_JS, "utf8") + "; return { REDFIN_IDS, REDFIN_STATE_IDS };")();
    for (const [k, v] of Object.entries(prev.REDFIN_IDS || {})) results.set(k, v);
    for (const [k, v] of Object.entries(prev.REDFIN_STATE_IDS || {})) results.set(STATE_PREFIX + k, v);
    console.log(`resumed ${results.size} existing entries from data/redfin_ids.js`);
  } catch (e) { console.log("could not parse existing output, starting fresh:", e.message); }
}

let writeTimer = null;
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const placeMap = {}, stateMap = {};
    for (const [k, v] of results) {
      if (k.startsWith(STATE_PREFIX)) stateMap[k.slice(STATE_PREFIX.length)] = v;
      else placeMap[k] = v;
    }
    const fmt = (o) => Object.keys(o).sort().map((k) => "  " + JSON.stringify(k) + ": " + JSON.stringify(o[k])).join(",\n");
    const out =
      "// Auto-generated by scripts/redfin_sink.mjs (browser-driven Redfin resolver). Do not edit by hand.\n" +
      "// Maps each place/state to its Redfin region path; index.html builds the full URL as\n" +
      "// \"https://www.redfin.com\"+path. Only strict name+state matches are stored — unresolved\n" +
      "// rows are absent and the app falls back to a Redfin search link.\n" +
      "//   REDFIN_IDS:       \"PlaceName|StateName\" -> path  (e.g. \"/city/30818/TX/Austin\")\n" +
      "//   REDFIN_STATE_IDS: \"StateName\"           -> path  (e.g. \"/state/New-York\")\n" +
      "// Loaded by index.html via <script src=\"data/redfin_ids.js\"></script> before the inline app script.\n" +
      "const REDFIN_IDS = {\n" + fmt(placeMap) + "\n};\n" +
      "const REDFIN_STATE_IDS = {\n" + fmt(stateMap) + "\n};\n";
    writeFileSync(OUT_JS, out);
  }, 400);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}

createServer((req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/ping") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }

  if (url.pathname === "/worklist") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ places, states, done: [...results.keys()] }));
    return;
  }

  if (url.pathname === "/count") {
    const ps = places.filter((p) => results.has(p.key)).length;
    const ss = states.filter((s) => results.has(s.key)).length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ total: results.size, places: ps, placesTotal: places.length, states: ss, statesTotal: states.length }));
    return;
  }

  if (url.pathname === "/save" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const arr = JSON.parse(raw);
        for (const e of arr) if (e && e.key && e.path) results.set(e.key, e.path);
        scheduleWrite();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, total: results.size }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  res.writeHead(404); res.end("not found");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`redfin sink on http://127.0.0.1:${PORT}  (${places.length} places + ${states.length} states; ${results.size} already resolved)`);
});
