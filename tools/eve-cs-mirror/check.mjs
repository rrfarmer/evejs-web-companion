#!/usr/bin/env node
// Read-only installation audit: no network and no server needed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offlineText } from "./offline.mjs";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const missing = new Set(), optional = new Set();
const check = p => { if (!fs.existsSync(path.join(root, p.split("?")[0]))) missing.add(p); };
const json = p => { check(p); return JSON.parse(fs.readFileSync(path.join(root, p), "utf8")); };
function paths(value) {
  if (typeof value === "string" && /^(assets|data)\/[^\s]+\.[a-z0-9]+$/.test(value)) check(value);
  else if (Array.isArray(value)) value.forEach(paths);
  else if (value && typeof value === "object") Object.values(value).forEach(paths);
}
function auditJson(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) auditJson(file);
    else if (entry.name.endsWith(".json")) {
      const text = fs.readFileSync(file, "utf8"); paths(JSON.parse(text));
      if (path.relative(root, file).replaceAll(path.sep, "/").startsWith("data/ship-fx/")) {
        for (const m of text.matchAll(/"geometryResPath"\s*:\s*"([^"/]+)"/g)) check(`assets/ship-fx/meshes/${m[1]}.bin`);
        for (const m of text.matchAll(/"(?:resourcePath|textureResPath)"\s*:\s*"([^"/:]+)"/g)) check(`assets/ship-fx/textures/${m[1]}.webp`);
      }
    }
  }
}
auditJson(path.join(root, "data"));
for (const p of ["index.html", "__routes/__page", "src/main.js", "src/render/model-worker.js", "__ext/cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"]) check(p);
for (const p of ["assets/boosters/textures.bin", "data/ship-fx.json", "assets/fx/turret-shots/laser.r32", "assets/fx/turret-shots/noise.png", "assets/fx/disintegrator-beams/atomicfx_01a.png"]) check(p);
offlineText(fs.readFileSync(path.join(root, "src/main.js"), "utf8"), "main");
const ids = json("data/scenarios/index.json");
for (const id of ids) {
  const data = json(`data/scenarios/active/${id}.json`); paths(data);
  if (data.system) check(`data/systems/${data.system}.json`);
}
const systems = new Set(Object.values(json("data/wormhole-systems.json").classes).flat());
for (const id of systems) check(`data/systems/${id}.json`);
for (const p of ["hulls", "turrets", "planets", "boosters", "abyss/rooms", "abyss/props", "abyss/clouds", "abyss/waves", "abyss/spawns"]) paths(json(`data/${p}.json`));
for (const site of Object.values(json("data/wormhole-map.json").sites)) for (const obj of site.objects) if (obj.sprite) check(`assets/ui/wormhole-sites/${obj.sprite}`);
const hulls = json("data/hulls.json");
for (const h of Object.values(hulls.models)) for (const model of [h.model, h.lowModel, h.heroModel, ...(h.lods ?? []).map(x => x[1])].filter(Boolean)) {
  check(model); if (h.zoneAreas && model.endsWith(".obj")) {
    const uv = model.replace(/\.obj$/, ".uv"); if (!fs.existsSync(path.join(root, uv))) optional.add(uv);
  }
}
const fx = json("data/ship-fx.json");
for (const dna of Object.values(fx.dnas)) for (const child of dna.children ?? []) check(`data/ship-fx/${child.tree}.json`);
for (const kind of ["turret-shots", "disintegrator-beams"]) {
  const text = JSON.stringify(json(`data/${kind}.json`));
  for (const m of text.matchAll(/"([^"/]+\.(?:png|r32))"/g)) check(`assets/fx/${kind}/${m[1]}`);
}
for (const [name, tex] of Object.entries(json("data/planets.json").textures)) {
  for (const suffix of ["", ...(tex.low ? ["_low"] : []), ...(tex.alpha && tex.dimension === "3d" ? ["_a"] : [])]) check(`assets/planets/textures/${name}${suffix}.webp`);
}
console.log(JSON.stringify({ scenarios: ids.length, wormholeSystems: systems.size, missing: [...missing], optionalUvAbsent: [...optional] }, null, 2));
if (missing.size) process.exitCode = 1;
