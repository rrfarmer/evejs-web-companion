// A turret module's graphic as the client's EveTurretSet loads it (its type's graphicFile), read for what its shots do to
// their target: EveTurretSet.impactSize (the impact's size: 0 makes none), and from its firing effect
// (firingEffectResPath, an EveTurretFiringFX) the firing's peak and length - EveTurretFiringFX::GetFiringDuration:
// firingDurationOverride where it is not below nought, else its stretches' longest curve (EveStretch / EveStretch3: each
// curve set's longest curve over its time scale; EveStretch2: its start and loop sets'), a curve's length its last key's
// time (Tr2CurveScalar; a colour, vector or Euler curve its parts' longest; a TriColorSequencer its functions').

import { readBlack } from "./black.mjs";

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
    turretBuild: 4,
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
  };
}
