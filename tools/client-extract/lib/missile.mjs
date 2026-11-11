// A missile type's graphics as the client's spaceObject.Missile loads them (eve/client/script/environment/spaceObject/
// missile.py LoadModel): the missile model from the type's group graphic (fsdBuiltData groupGraphics: a type's own
// graphicIDs where its group lists it, else the group's; the first), and the impact (the explosion) from the type's own
// graphicFile. The model file is an EveMissile holding one warhead (EveMissileWarhead: its flight's numbers, the sprite
// lights it carries, the GPU emitters of its trail, and the mesh drawn by missile.fx); read here for the play page's
// port of EveMissile / EveMissileWarhead (web/src/play/missileFx.ts).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readBlack } from "./black.mjs";

/** EveMissileWarhead's constructor defaults (EveMissileWarhead.cpp:24-64), for what a file leaves out. */
const WARHEAD_DEFAULTS = {
  warheadLength: 1, warheadRadius: 1, impactDuration: 0.6, impactSize: 0, durationEjectPhase: 0, startEjectVelocity: 0,
  acceleration: 1, maxExplosionDistance: 40, pathOffsetNoiseScale: 0, pathOffsetNoiseSpeed: 1,
};

const texturesOf = (fx) => Object.fromEntries((fx?.resources ?? []).filter((r) => r?.name && r.resourcePath).map((r) => [r.name, String(r.resourcePath).toLowerCase()]));
const effectName = (fx) => (fx?.effectFilePath ? String(fx.effectFilePath).split("/").pop().replace(/\.fx$/i, "").toLowerCase() : null);
/** An object as the file has it, plain (the emitters: gpuParticles.ts reads their fields by name, defaults its own). */
const plain = (o) => JSON.parse(JSON.stringify(o));

/**
 * The missile file's warheads (EveMissile.warheads; missile.py wants exactly one), each: its numbers (the class
 * defaults where the file has none), its sprite set (EveSpriteSet: items and the effect's textures), its own GPU
 * emitters (Tr2GpuSharedEmitter / Tr2GpuUniqueEmitter in particleEmitters: the trail) and its mesh's effect and
 * textures. Textures as res: paths. Null where the file is no EveMissile.
 */
export function readMissileModel(rf, missileFile) {
  const res = String(missileFile).toLowerCase().replace(/\.red$/, ".black");
  if (!rf.has(res)) return null;
  const o = readBlack(rf.read(res), res);
  if (o?.type !== "EveMissile") return null;
  const skipped = {};
  const warheads = (o.warheads ?? []).filter((w) => w?.type === "EveMissileWarhead").map((w) => {
    const out = {};
    for (const [k, v] of Object.entries(WARHEAD_DEFAULTS)) out[k] = typeof w[k] === "number" ? w[k] : v;
    const ss = w.spriteSet?.type === "EveSpriteSet" ? w.spriteSet : null;
    out.sprites = (ss?.sprites ?? []).filter((s) => s?.type === "EveSpriteSetItem").map((s) => ({
      position: s.position ?? [0, 0, 0], blinkRate: s.blinkRate ?? 0, blinkPhase: s.blinkPhase ?? 0,
      minScale: s.minScale ?? 1, maxScale: s.maxScale ?? 1, falloff: s.falloff ?? 0, color: s.color ?? [1, 1, 1, 1],
    }));
    out.spriteEffect = effectName(ss?.effect);
    out.spriteTextures = texturesOf(ss?.effect);
    out.emitters = (w.particleEmitters ?? []).filter((e) => e?.type === "Tr2GpuSharedEmitter" || e?.type === "Tr2GpuUniqueEmitter").map(plain);
    for (const e of w.particleEmitters ?? []) if (e?.type !== "Tr2GpuSharedEmitter" && e?.type !== "Tr2GpuUniqueEmitter") skipped[e?.type ?? "?"] = (skipped[e?.type ?? "?"] ?? 0) + 1;
    // its children (EveTransform.children: more GPU emitters in the client's EnableParticleEmitting): counted, not drawn
    for (const c of w.children ?? []) skipped[`child:${c?.type ?? "?"}`] = (skipped[`child:${c?.type ?? "?"}`] ?? 0) + 1;
    const area = [...(w.mesh?.opaqueAreas ?? []), ...(w.mesh?.transparentAreas ?? []), ...(w.mesh?.additiveAreas ?? [])][0] ?? null;
    out.mesh = w.mesh ? { geometry: String(w.mesh.geometryResPath ?? "").toLowerCase() || null, effect: effectName(area?.effect), textures: texturesOf(area?.effect) } : null;
    return out;
  });
  return {
    name: o.name ?? null, boundingSphere: [...(o.boundingSphereCenter ?? [0, 0, 0]), o.boundingSphereRadius ?? 0],
    warheads, skipped,
  };
}

/**
 * fsdBuiltData's groupGraphics (res:/staticdata/groupgraphics.fsdbinary), read with the client's own loader
 * (scripts/client-built-data.py, groupGraphicsLoader) once and kept as groupGraphics.json in the build folder.
 */
export function groupGraphics(rf, clientDir, outRoot, repo) {
  const file = path.join(outRoot, "groupGraphics.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = rf.entry("res:/staticdata/groupgraphics.fsdbinary");
  if (!entry) throw new Error("the client has no res:/staticdata/groupgraphics.fsdbinary");
  const data = path.join(clientDir, "ResFiles", ...entry.blob.split("/"));
  const py = spawnSync(process.env.PYTHON ?? "python", [path.join(repo, "scripts", "client-built-data.py"), path.join(clientDir, "tq", "bin64"), "groupGraphicsLoader", data],
    { encoding: "utf8", maxBuffer: 64 << 20 });
  if (py.status !== 0) throw new Error(`groupGraphics: client-built-data.py failed: ${py.stderr || py.error?.message}`);
  const table = JSON.parse(py.stdout);
  fs.writeFileSync(file, JSON.stringify(table));
  return table;
}

/** groupGraphics.GetGraphicIdsFromTypeID: the type's own graphicIDs where its group lists the type, else the group's. */
export function graphicIdsOfType(table, typeID, groupID) {
  const g = table[String(groupID)];
  if (!g) return null;
  const own = g.typeIDs?.[String(typeID)];
  return own?.graphicIDs ?? g.graphicIDs ?? null;
}

/** The SDE's graphics.jsonl row of a graphic, or null. */
export function sdeGraphic(sdeDir, graphicID) {
  const file = path.join(sdeDir, "graphics.jsonl");
  const want = new RegExp(`^\\{"_key": ?${graphicID}[,}]`);
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) if (want.test(line)) return JSON.parse(line);
  return null;
}
