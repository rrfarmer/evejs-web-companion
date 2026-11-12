// A turret module's graphic as the client's EveTurretSet loads it (its type's graphicFile), read for what its shots do to
// their target: EveTurretSet.impactSize (the impact's size: 0 makes none), and from its firing effect
// (firingEffectResPath, an EveTurretFiringFX) the firing's peak and length - EveTurretFiringFX::GetFiringDuration:
// firingDurationOverride where it is not below nought, else its stretches' longest curve (EveStretch / EveStretch3: each
// curve set's longest curve over its time scale; EveStretch2: its start and loop sets'), a curve's length its last key's
// time (Tr2CurveScalar; a colour, vector or Euler curve its parts' longest; a TriColorSequencer its functions').

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readBlack } from "./black.mjs";
import { readTurretStretch3 } from "./children.mjs";

/** The .black of a .red/.black path, where the client has it. */
function blackOf(rf, res) {
  const stem = String(res).toLowerCase().replace(/\.(red|black)$/, "");
  return rf.has(`${stem}.black`) ? `${stem}.black` : null;
}

/** A curve's length (ITriDuration / ITriCurveLength::Length): nought for one without keys of its own. */
function curveLength(c) {
  if (!c || typeof c !== "object") return 0;
  switch (c.type) {
    case "Tr2CurveScalar": {
      // its keys a list of objects, or (as the .black packs them) a table: structure [[name, ...]], items [[...]]
      const k = c.keys;
      if (Array.isArray(k)) return k.length ? Number(k[k.length - 1]?.time ?? 0) : 0;
      const col = (k?.structure ?? []).findIndex((s) => s?.[0] === "time"), rows = k?.items ?? [];
      return col >= 0 && rows.length ? Number(rows[rows.length - 1]?.[col] ?? 0) : 0;
    }
    case "Tr2CurveColor": return Math.max(curveLength(c.r), curveLength(c.g), curveLength(c.b), curveLength(c.a));
    case "Tr2CurveVector3": return Math.max(curveLength(c.x), curveLength(c.y), curveLength(c.z));
    case "Tr2CurveEulerRotation": return Math.max(curveLength(c.yaw), curveLength(c.pitch), curveLength(c.roll));
    case "TriColorSequencer": return Math.max(0, ...(c.functions ?? []).map(curveLength));
    default: return 0;
  }
}
/** TriCurveSet::GetMaxCurveDuration. */
const setLength = (cs) => Math.max(0, ...((cs?.curves ?? []).map(curveLength)));

function stretchLength(s) {
  if (!s) return 0;
  if (s.type === "EveStretch2") return Math.max(setLength(s.start), setLength(s.loop));
  // EveStretch, EveStretch3: each set's over its time scale
  return Math.max(0, ...(s.curveSets ?? []).map((cs) => setLength(cs) / (cs?.scale ?? 1)));
}

/** A curve as the page evaluates it (web/src/three/curves.ts): its own fields, a scalar's keys as their rows. */
function plainCurve(c) {
  if (Array.isArray(c)) return c.map(plainCurve);
  if (!c || typeof c !== "object") return c;
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === "keys" && v && Array.isArray(v.items)) out.keys = v.items;
    else if (v && typeof v === "object") out[k] = plainCurve(v);
    else out[k] = v;
  }
  return out;
}

const isCurve = (o) => typeof o?.type === "string" && (o.type.startsWith("Tr2Curve") || o.type === "TriPerlinCurve");

/**
 * An EveStretch2's curve set (its start, loop or end): its scale, curves and the bindings from them, each binding's
 * destination named as the stretch has it - an effect parameter by its name ("param:Intensity"), or its source or
 * destination light - with its attribute, scale and offset (TriValueBinding).
 */
function stretchCurveSet(cs, s, all = [s]) {
  if (!cs) return null;
  const curves = (cs.curves ?? []).filter(isCurve);
  const index = new Map(curves.map((c, i) => [c, i]));
  const params = s.effect?.parameters ?? [];
  const same = (a, b) => a === b || (a && b && JSON.stringify(a) === JSON.stringify(b));
  const bindings = [];
  for (const b of cs.bindings ?? []) {
    const src = b?.sourceObject, dst = b?.destinationObject;
    if (!src || !dst || !isCurve(src)) continue;
    let target = null;
    if (/Parameter$/.test(dst.type ?? "") && params.some((p) => same(p, dst))) target = `param:${dst.name}`;
    else if (s.sourceLight && same(dst, s.sourceLight) && !same(dst, s.destinationLight)) target = "sourceLight";
    else if (s.destinationLight && same(dst, s.destinationLight) && !same(dst, s.sourceLight)) target = "destinationLight";
    // (the two lights alike: told apart by the binding's name, SRC_ / DEST_ as the client's files name them)
    else if (s.sourceLight && same(dst, s.sourceLight)) target = /^dest/i.test(b.name ?? "") ? "destinationLight" : "sourceLight";
    // a GPU emitter: this stretch's or another's of the firing effect (a muzzle's set may drive its neighbour's), by
    // the stretch's index and end
    if (!target && /^Tr2Gpu(Shared|Unique)Emitter$/.test(dst.type ?? "")) {
      const i = all.findIndex((x) => x?.sourceEmitter === dst || x?.destinationEmitter === dst);
      if (i >= 0) target = `emitter:${i}:${all[i].sourceEmitter === dst ? "source" : "destination"}`;
    }
    if (!target) continue;
    bindings.push({
      name: b.name ?? null, source: index.has(src) ? index.get(src) : null, sourceCurve: index.has(src) ? null : plainCurve(src),
      sourceAttribute: b.sourceAttribute ?? "currentValue", target, destinationAttribute: b.destinationAttribute ?? "",
      scale: b.scale ?? 1, offset: b.offset ?? [0, 0, 0, 0],
    });
  }
  return { scale: cs.scale ?? 1, curves: curves.map(plainCurve), bindings };
}

/** A Tr2GpuSharedEmitter / Tr2GpuUniqueEmitter as the file has it (gpuParticles.ts reads its fields by name). */
const gpuEmitter = (e) => (e && (e.type === "Tr2GpuSharedEmitter" || e.type === "Tr2GpuUniqueEmitter") ? JSON.parse(JSON.stringify(e)) : null);

const pointLight = (l) => (l ? {
  position: l.position ?? [0, 0, 0], radius: Number(l.radius ?? 0), color: l.color ?? [1, 1, 1, 1], brightness: Number(l.brightness ?? 1),
  noiseAmplitude: Number(l.noiseAmplitude ?? 0), noiseFrequency: Number(l.noiseFrequency ?? 0), noiseOctaves: Number(l.noiseOctaves ?? 0),
} : null);

/**
 * A firing effect's stretch (one per muzzle, EveTurretFiringFX.stretch): an EveStretch2 read whole - its effect (by its
 * name), constant parameters and textures, quad count, start / loop / end curve sets and lights; another kind (EveStretch,
 * EveStretch3) by its type alone, not drawn yet.
 */
function readStretch(s, _i, all) {
  if (s?.type !== "EveStretch2") return { type: s?.type ?? null, name: s?.name ?? null };
  const fx = s.effect ?? null;
  const params = {};
  for (const p of fx?.parameters ?? []) if (p?.name && p.value !== undefined) params[p.name] = p.value;
  const textures = {};
  for (const r of fx?.resources ?? []) if (r?.name && r.resourcePath) textures[r.name] = String(r.resourcePath).toLowerCase();
  return {
    type: "EveStretch2", name: s.name ?? null, quadCount: Math.min(128, Number(s.quadCount ?? 0)),
    effect: fx?.effectFilePath ? String(fx.effectFilePath).split("/").pop().replace(/\.fx$/i, "").toLowerCase() : null,
    params, textures,
    start: stretchCurveSet(s.start, s, all), loop: stretchCurveSet(s.loop, s, all), end: stretchCurveSet(s.end, s, all),
    sourceLight: pointLight(s.sourceLight), destinationLight: pointLight(s.destinationLight),
    // its GPU emitters, updated with the end frames (EveStretch2::Update); another kind of emitter left out
    sourceEmitter: gpuEmitter(s.sourceEmitter), destinationEmitter: gpuEmitter(s.destinationEmitter),
  };
}

/**
 * The beam colour each charge gives its turret's firing effect (turretSet.py SetAmmoColorByTypeID: its graphic's
 * ammoColor, fsdBuiltData graphicIDs - read with the client's own loader, scripts/client-built-data.py - set on every
 * "Ammo" constant curve), by charge typeID (the SDE's types' graphicID).
 */
export function ammoColors(rf, clientDir, sdeDir, repo) {
  const entry = rf.entry("res:/staticdata/graphicids.fsdbinary");
  if (!entry) throw new Error("the client has no res:/staticdata/graphicids.fsdbinary");
  const data = path.join(clientDir, "ResFiles", ...entry.blob.split("/"));
  const py = spawnSync(process.env.PYTHON ?? "python", [path.join(repo, "scripts", "client-built-data.py"), path.join(clientDir, "tq", "bin64"), "graphicIDsLoader", data, "ammoColor"],
    { encoding: "utf8", maxBuffer: 64 << 20 });
  if (py.status !== 0) throw new Error(`ammoColors: client-built-data.py failed: ${py.stderr || py.error?.message}`);
  const byGraphic = JSON.parse(py.stdout);
  const out = {};
  for (const line of fs.readFileSync(path.join(sdeDir, "types.jsonl"), "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const t = JSON.parse(line);
    const c = t.graphicID !== undefined ? byGraphic[String(t.graphicID)] : undefined;
    if (Array.isArray(c)) out[String(t._key)] = c;
  }
  return out;
}

/**
 * The firing effect's EveStretch3s (children.mjs readTurretStretch3: each a hull-child graph of its parts, placed from
 * outside), in place of the type-only entries readStretch leaves for them; their child effects with the first.
 */
function withStretch3(stretches, rf, fxFile) {
  if (!fxFile || !stretches.some((s) => s.type === "EveStretch3")) return stretches;
  const read = readTurretStretch3(rf, fxFile);
  return stretches.map((s, i) => {
    const r = read?.stretches[i];
    return r ? { type: "EveStretch3", name: s.name ?? null, ...r, ...(i === 0 ? { childEffects: read.childEffects } : {}) } : s;
  });
}

/** {impactSize, firingPeakTime, firingDuration, isLoopFiring} of a turret graphic, or null where it is no turret set. */
export function readTurret(rf, graphicFile) {
  const file = blackOf(rf, graphicFile);
  if (!file) return null;
  let set = null;
  const find = (n) => { if (!n || typeof n !== "object" || set) return; if (n.type === "EveTurretSet") { set = n; return; } for (const v of Object.values(n)) if (v && typeof v === "object") find(v); };
  find(readBlack(rf.read(file), file));
  if (!set) return null;
  let fx = null;
  const fxFile = set.firingEffectResPath ? blackOf(rf, set.firingEffectResPath) : null;
  if (fxFile) {
    const findFx = (n) => { if (!n || typeof n !== "object" || fx) return; if (n.type === "EveTurretFiringFX") { fx = n; return; } for (const v of Object.values(n)) if (v && typeof v === "object") findFx(v); };
    findFx(readBlack(rf.read(fxFile), fxFile));
  }
  const override = fx?.firingDurationOverride ?? -1;
  const effect = set.turretEffect ?? null;
  return {
    turretBuild: 8,
    // the aiming (EveTurretAiming: the file's sysBone numbers, its class defaults where it has none)
    aiming: {
      height: Number(set.sysBoneHeight ?? 1), pitchFactor: Number(set.sysBonePitchFactor ?? 1), pitchOffset: Number(set.sysBonePitchOffset ?? 0),
      pitchMin: Number(set.sysBonePitchMin ?? 0), pitchMax: Number(set.sysBonePitchMax ?? 90),
      pitch01Factor: Number(set.sysBonePitch01Factor ?? 1), pitch01Offset: Number(set.sysBonePitch01Offset ?? 0),
      pitch02Factor: Number(set.sysBonePitch02Factor ?? 1), pitch02Offset: Number(set.sysBonePitch02Offset ?? 0),
      pitch03Factor: Number(set.sysBonePitch03Factor ?? 1), pitch03Offset: Number(set.sysBonePitch03Offset ?? 0),
      updatePitchPose: set.updatePitchPose === true,
    },
    // the drawn turret (EveTurretSet: its model, its effect's name, textures and constant parameters, the locators it
    // fits to; maxCyclingFirePos: how many muzzles it fires in turn)
    geometry: set.geometryResPath ? String(set.geometryResPath).toLowerCase() : null,
    locatorName: String(set.locatorName ?? ""),
    maxCyclingFirePos: Number(set.maxCyclingFirePos ?? 1),
    effect: effect?.effectFilePath ? String(effect.effectFilePath).split("/").pop().replace(/\.fx$/i, "").toLowerCase() : null,
    textures: Object.fromEntries((effect?.resources ?? []).filter((r) => r?.name && r.resourcePath).map((r) => [r.name, String(r.resourcePath).toLowerCase()])),
    params: Object.fromEntries(((effect?.constParameters?.items ?? [])).filter((r) => Array.isArray(r)).map(([k, v]) => [k, v])),
    randomizeExplosionRotation: set.randomizeExplosionRotation !== false,
    graphicFile,
    impactSize: Number(set.impactSize ?? 0),
    useRandomFiringDelay: set.useRandomFiringDelay !== false,
    maxTrackingTime: Number(set.maxTrackingTime ?? 1),
    firingEffect: fxFile,
    firingPeakTime: Number(fx?.firingPeakTime ?? 0),
    firingDuration: fx ? (override >= 0 ? Number(override) : Math.max(0, ...(fx.stretch ?? []).map(stretchLength))) : 0,
    isLoopFiring: fx?.isLoopFiring === true,
    // the firing effect drawn (EveTurretFiringFX): a stretch per muzzle, the target's scaling by its radius
    // (SetScaleByRadius: scaleEffectTarget, min / max radius and scale; the class defaults where the file has none)
    firing: fx ? {
      stretches: withStretch3((fx.stretch ?? []).map(readStretch), rf, fxFile),
      scaleEffectTarget: fx.scaleEffectTarget === true,
      minRadius: Number(fx.minRadius ?? 30), maxRadius: Number(fx.maxRadius ?? 3000),
      minScale: Number(fx.minScale ?? 1), maxScale: Number(fx.maxScale ?? 10),
    } : null,
  };
}
