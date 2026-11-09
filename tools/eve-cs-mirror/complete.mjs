#!/usr/bin/env node
// Complete data-driven assets the generic crawler cannot infer. Network is used
// only by this explicit preparation command, never by the offline server.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL_HOSTS, rewriteExternal } from "./offline.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const origin = "https://eve-cs.com";
const urls = new Map();
let queue = null;
const json = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const unavailablePath = path.join(root, "__unavailable-assets.json");
const unavailable = fs.existsSync(unavailablePath) ? JSON.parse(fs.readFileSync(unavailablePath, "utf8")) : {};
const previousReport = path.join(root, "__completion-report.json");
if (fs.existsSync(previousReport)) for (const item of JSON.parse(fs.readFileSync(previousReport, "utf8")).failed ?? []) unavailable[item.url] ??= { error: item.error };
const skipped = new Set();
function add(raw) {
  if (!raw || raw.includes("${")) return;
  raw = raw.replaceAll("&amp;", "&");
  const ext = /^\/__ext\/([^/]+)(\/.*)$/.exec(raw);
  if (ext) raw = `https://${ext[1]}${ext[2]}`;
  let u; try { u = new URL(raw, origin); } catch { return; }
  if (u.origin !== origin && !EXTERNAL_HOSTS.includes(u.host)) return;
  if (u.host === "esi.evetech.net" || u.pathname.startsWith("/src/member/")) return;
  if (u.origin === origin && !/^\/(assets|data|css|src)\/.+\.[a-z0-9]+$/i.test(u.pathname)) return;
  let p = decodeURIComponent(u.pathname);
  if (u.origin !== origin) p = `/__ext/${u.host}${p}`;
  if (u.host === "images.evetech.net" && u.search) p += "__" + u.search.slice(1).replace(/[^\w=]/g, "_");
  if (u.host === "fonts.googleapis.com" && u.search) p += "__" + Buffer.from(u.search).toString("base64url") + ".css";
  const f = path.join(root, ...p.split("/").filter(Boolean).map(s => s.replace(/[<>:"|?*]/g, "_")));
  if (!fs.existsSync(f) && !urls.has(f)) {
    if (!process.argv.includes("--retry-unavailable") && /^HTTP (302|400|403|404|405)/.test(unavailable[u.href]?.error ?? "")) { skipped.add(u.href); return; }
    urls.set(f, u.href); queue?.push([f, u.href]);
  }
}
function discover(s, isJson = false, source = origin + "/") {
  for (const m of s.matchAll(/["'`(](?:\.\.?\/)*((?:\/?(?:assets|data|css|src)\/|\/__ext\/)[^"'`()\s<>]+)["'`)]/g)) add(m[1]);
  if (isJson) for (const m of s.matchAll(/"system"\s*:\s*(\d+)/g)) add(`data/systems/${m[1]}.json`);
  if (isJson) for (const m of s.matchAll(/"(assets\/[^"\s]+)\.obj"/g)) add(`${m[1]}.uv`);
  if (isJson) {
    if (source.includes("/assets/app/")) for (const m of s.matchAll(/"([^"\s]+\.(?:webp|png))"/g)) if (!/^(?:assets|data|https?:|\/)/.test(m[1])) add(new URL(m[1], source).href);
    if (source.endsWith("/assets/lensflare/systems.json")) {
      for (const key of Object.keys(JSON.parse(s).flares ?? {})) add(`assets/lensflare/${key}.json`);
    }
    if (/\/assets\/lensflare\/[^/]+\.json$/.test(source) && !source.endsWith("systems.json")) {
      for (const area of JSON.parse(s).areas ?? []) for (const texture of Object.values(area.textures ?? {})) add(`assets/lensflare/textures/${texture}.webp`);
    }
    if (source.endsWith("/assets/sun/suns.json")) for (const sun of Object.values(JSON.parse(s))) {
      add(`assets/sun/${sun.surface}.jpg`); add(`assets/sun/${sun.pole}.jpg`); add(`assets/sun/${sun.ramp}.png`);
    }
    if (source.endsWith("/data/ship-fx.json")) for (const dna of Object.values(JSON.parse(s).dnas ?? {})) for (const child of dna.children ?? []) add(`data/ship-fx/${child.tree}.json`);
    if (/\/data\/ship-fx\//.test(source)) {
      for (const m of s.matchAll(/"geometryResPath"\s*:\s*"([^"/]+)"/g)) add(`assets/ship-fx/meshes/${m[1]}.bin`);
      for (const m of s.matchAll(/"(?:resourcePath|textureResPath)"\s*:\s*"([^"/:]+)"/g)) add(`assets/ship-fx/textures/${m[1]}.webp`);
    }
    const turret = /\/data\/(turret-shots|disintegrator-beams)\.json$/.exec(source);
    if (turret) for (const m of s.matchAll(/"([^"/]+\.(?:png|r32))"/g)) add(`assets/fx/${turret[1]}/${m[1]}`);
    const effect = /\/assets\/fx\/(cyno|wormhole-sky)\/effects\//.exec(source);
    if (effect) {
      const stem = value => value.split("/").pop().replace(/\.(dds|gr2)$/i, "").toLowerCase();
      for (const m of s.matchAll(/"geometryResPath"\s*:\s*"([^"]+)"/g)) add(`assets/fx/${effect[1]}/meshes/${stem(m[1])}.json`);
      for (const m of s.matchAll(/"resourcePath"\s*:\s*"([^"]+)"/g)) add(`assets/fx/${effect[1]}/textures/${stem(m[1])}.png`);
    }
  }
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(f); continue; }
    if (!/\.(json|js|css|html)$/.test(f) && entry.name !== "__page") continue;
    if (entry.name.startsWith("__")) continue;
    const s = fs.readFileSync(f, "utf8");
    discover(s, f.endsWith(".json"), origin + "/" + path.relative(root, f).replaceAll(path.sep, "/"));
  }
}
walk(root);
// Browser-observed misses are exact paths, including dynamic icons and renders.
if (fs.existsSync(path.join(root, "__missing.txt"))) {
  for (const line of fs.readFileSync(path.join(root, "__missing.txt"), "utf8").split(/\r?\n/)) add(line);
}
const hulls = json("data/hulls.json");
for (const h of [...Object.values(hulls.models), ...Object.values(json("data/turrets.json").models)]) {
  for (const model of new Set([h.model, h.lowModel, h.heroModel, ...(h.lods ?? []).map(x => x[1])].filter(Boolean))) {
    add(model); if (model.endsWith(".obj")) add(model.replace(/\.obj$/, ".uv"));
    if (h.anim) add(model.replace(/\.obj$/, ".skin"));
  }
  if (h.model?.endsWith(".obj") && Object.values(hulls.models).includes(h)) add(`data/damage-locators/${path.basename(h.model, ".obj")}.json`);
}
const planets = json("data/planets.json");
for (const [name, tex] of Object.entries(planets.textures)) {
  const alpha = tex.alpha && tex.dimension === "3d";
  for (const suffix of ["", ...(alpha ? ["_a"] : []), ...(tex.low ? ["_low", ...(alpha ? ["_low_a"] : [])] : [])]) add(`assets/planets/textures/${name}${suffix}.webp`);
}
for (const nebula of Object.keys(planets.ambient)) for (const suffix of ["_alpha.png", "_cube.webp", "_cube_low.jpg"]) add(`assets/skybox/${nebula}${suffix}`);
for (let i = 1; i <= 6; i++) for (const suffix of ["_alpha.png", "_cube.webp", "_cube_low.jpg"]) add(`assets/skybox/wormhole_class_0${i}${suffix}`);
for (const m of fs.readFileSync(path.join(root, "src/main.js"), "utf8").matchAll(/"(ad\d\d_[a-z])"/g)) for (const suffix of ["_alpha.png", "_cube.webp", "_cube_low.jpg"]) add(`assets/skybox/${m[1]}${suffix}`);
// Wormhole system selection is random; cache the whole supplied catalog.
const wh = json("data/wormhole-systems.json");
for (const ids of Object.values(wh.classes ?? {})) for (const id of ids) add(`data/systems/${id}.json`);
for (const site of Object.values(json("data/wormhole-map.json").sites)) for (const obj of site.objects) if (obj.sprite) add(`assets/ui/wormhole-sites/${obj.sprite}`);
const types = json("data/sde/types.json"), meta = json("data/sde/meta.json"), groups = json("data/sde/groups.json");
for (const [id, type] of Object.entries(types)) {
  if (!meta.icons[id]) add(`https://images.evetech.net/types/${id}/icon?size=64`);
  if ([6, 18, 65, 87].includes(groups[type.group]?.category)) add(`https://images.evetech.net/types/${id}/render?size=128`);
}
add("data/boosters.json");
add("assets/lensflare/systems.json");
add("assets/sun/suns.json");
for (const asset of ["assets/boosters/textures.bin", "data/ship-fx.json", "assets/fx/turret-shots/laser.r32", "assets/fx/turret-shots/noise.png", "assets/fx/disintegrator-beams/atomicfx_01a.png"]) add(asset);
for (const color of ["blue", "red", "green", "purple", "white"]) add(`assets/lensflare/abyssal_${color}.json`);
add("assets/fx/cyno/effects/cyno_jump_in.json");
for (const kind of Object.keys(wh.effects.kinds)) add(`assets/fx/wormhole-sky/effects/${kind}.json`);
for (const name of ["rail", "oblatespheroid_3k_01", "unit_plane"]) add(`assets/fx/tackle/${name}.json`);
const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
const tackle = main.slice(main.indexOf("var hee="), main.indexOf("var KOe="));
for (const m of tackle.matchAll(/(?:map[12]:|\.texture\()"([^"]+)"/g)) add(`assets/fx/tackle/${m[1]}.png`);
for (const damage of ["electromagnetic", "thermal", "kinetic", "explosive"]) add(`assets/ui/combatlog/${damage}.png`);
for (const bracket of ["droneAttack", "droneSentry", "droneEW", "droneLogistics", "droneMining", "droneSalvaging", "fighterSquad", "fighterSquadM", "fighterSquadH"]) add(`assets/Brackets/${bracket}_16.png`);
const manifest = [...urls].map(([file, url]) => ({ file: path.relative(root, file), url }));
fs.writeFileSync(path.join(root, "__completion-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`${urls.size} missing candidates, ${skipped.size} known unavailable (${process.argv.includes("--check") ? "check only" : "downloading"})`);
if (process.argv.includes("--check")) process.exit(0);
const login = await fetch(origin + "/auth/login?next=/", { redirect: "manual", signal: AbortSignal.timeout(30000) });
const cookie = process.env.EVECS_COOKIE || login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
let done = 0, bytes = 0; const failed = [];
queue = [...urls];
async function worker() {
  while (queue.length) {
    const [f, url] = queue.shift();
    try {
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          r = await fetch(url, { redirect: "manual", headers: { ...(url.startsWith(origin + "/") ? { cookie } : {}) }, signal: AbortSignal.timeout(30000) });
          if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
          break;
        } catch (e) { if (attempt === 2) throw e; await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); }
      }
      if (!r.ok || /text\/html/.test(r.headers.get("content-type") ?? "")) throw new Error(`HTTP ${r.status} ${r.headers.get("content-type")}`);
      let b = Buffer.from(await r.arrayBuffer());
      if (/\.(json|js|css)$/.test(f)) b = Buffer.from(rewriteExternal(b.toString("utf8")));
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); bytes += b.length;
      delete unavailable[url];
      if (/\.(json|js|css)$/.test(f)) discover(b.toString("utf8"), f.endsWith(".json"), url);
    } catch (e) { failed.push({ url, error: e.message }); unavailable[url] = { error: e.message, checked: new Date().toISOString() }; }
    done++; if (done % 100 === 0) console.log(`${done}/${urls.size}, ${(bytes / 1e6).toFixed(1)} MB, ${failed.length} unavailable`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
fs.writeFileSync(path.join(root, "__completion-report.json"), JSON.stringify({ date: new Date().toISOString(), candidates: urls.size, fetched: done - failed.length, bytes, knownUnavailable: skipped.size, failed }, null, 2));
fs.writeFileSync(unavailablePath, JSON.stringify(unavailable, null, 2));
console.log(`Finished: ${done - failed.length} fetched, ${failed.length} unavailable. See site/__completion-report.json`);
