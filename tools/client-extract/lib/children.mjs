// A hull's children (EveSOFDataHull.children: EveSOFDataHullChild { redFilePath, groupIndex }), as the client's EveSOF
// loads each one's object file (the .red, shipped as .black) and hangs it under the ship: a graph of EveChild*
// objects (containers, quads, meshes, line sets, particle systems, lights), curve sets, controllers and state
// machines. This reads the part drawn so far, the static one:
//
// - EveChildContainer: its transform (useSRT, the client's default: translation, rotation, scaling), display, its
//   displayFilter (trinity.DisplayModifierChooser: Low 0, Low_and_Medium 1, Medium 2, Medium_and_High 3, High 4,
//   None_ 5, the default; kept at high quality: 3, 4, 5), its objects and transform modifiers;
// - EveChildQuad: transform, color, brightness, minScreenSize and its effect (flarequad.fx, flarequadsoft.fx);
// - EveChildMesh on a Tr2InstancedMesh drawn with traffic.fx (a station's traffic): its transform, the instance
//   geometry's file, the effect's constants and its textures (PositionMap, TexMap); the instances themselves are
//   read by the caller (readTrafficInstances), the reader being asynchronous;
// - EveChildMesh on a Tr2Mesh: its transform, geometry file (the caller extracts it), mesh index and the areas drawn
//   with ubershader.fx, ubershadertwosided.fx, fx3dv5.fx, texturecolor.fx, flare.fx, twocolorflare.fx,
//   motionvectorramp.fx in its default options, or the hulls' quadv5.fx and quadglassv5.fx (kind, index, count, the effect's options, constants and textures); its other
//   areas counted;
// - EveChildLineSet: its transform, colours, brightness, the line set's additive flag, width factor and textures, and
//   each EveBezierCurve (its own transform, point1, bezierPoint, point2, segments, lineWidth), defaults as the
//   client's classes have them (read in its Python).
//
// The rest is counted, not read (meshes, line sets, particle systems, point lights, curve sets, state machines).
//
// Which children a hull gets for a faction, and where (carbonengine/trinity EveSOF.cpp's SetupEffects, a standalone
// build, EveSOFDataHullBuildFilter::STANDALONE = 1):
// - a sof6 hull's are its childSets' items (SetupEffectChildren): a set only where the faction's visibility group set
//   names its visibilityGroup (EveSOFDNA::IsInVisibilityData: the name's FNV hash, as written; a set naming none is
//   in "primary", EveSOFDataHullChildSet's default, which all but 17 factions name), an item only where its
//   buildFilter has STANDALONE; its children list is not read;
// - another hull's are its children (SetupChildrenAndAnimations): one only where its buildFilter has STANDALONE, and
//   not where the faction's child data for its groupIndex (EveSOFDataFactionChild, the last of that index; -1 none)
//   says it is not visible (isVisible, false where unsaid); a groupIndex the faction does not name is built;
// - an object hidden in its file (display false) is read where a curve set that plays on load drives its display,
//   marked display false (Jita 4-4's hologram adverts: shown by its play_start set's scale curves);
// - each child's root takes the entry's translation, rotation and scaling (the defaults 0, identity, 1 where unsaid)
//   in place of its own (EveChildTransform::Setup, where useSRT; EveTransform's SetTranslation and the rest).

import { readBlack } from "./black.mjs";

const HIGH_QUALITY = new Set([3, 4, 5]);
// motionvectorramp.fx is drawn in the permutations the client's child meshes use (its file's permutations:
// Tr2EffectRes.cpp's reader): the default, and record 19 (no interpolation, one diffuse map, the mask)
const MOTION_VECTOR_RAMP_DEFAULTS = [["INTERPOLATION", "INTERPOLATION_ENABLED"], ["DIFFUSE_MAP_COUNT", "ZERO"], ["COLORMAP", "COLORMAP_RAMP"], ["MASK", "MASK_DISABLED"], ["TEXTURE_TRANSFORM", "TRANSFORM_DISABLED"]];
const MOTION_VECTOR_RAMP_DRAWN = [{}, { INTERPOLATION: "INTERPOLATION_DISABLED", DIFFUSE_MAP_COUNT: "ONE", MASK: "MASK_ENABLED" }];

const srt = (o) => {
  const t = o.translation ?? [0, 0, 0], r = o.rotation ?? [0, 0, 0, 1], s = o.scaling ?? [1, 1, 1];
  // the column-major matrix of T x R x S, as THREE.Matrix4.compose makes it
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
};
const identity = (m) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);
/** An effect's constants by name: its constParameters (name, value rows) and its Tr2Vector4Parameter / Tr2FloatParameter list. */
function effectParams(fx) {
  const out = {};
  for (const row of fx?.constParameters?.items ?? []) if (Array.isArray(row) && typeof row[0] === "string") out[row[0]] = row[1];
  for (const p of fx?.parameters ?? []) if (p?.name) out[p.name] = p.value ?? null;
  return out;
}
const effectTextures = (fx) => Object.fromEntries((fx?.resources ?? []).filter((r) => r?.name && r.resourcePath).map((r) => [r.name, String(r.resourcePath).toLowerCase()]));
/** An EveChildModifierSRT's own transform (its translation, rotation and scaling; the defaults where unsaid), or null. */
const srtOf = (mods) => {
  const m = (mods ?? []).find((t) => t?.type === "EveChildModifierSRT");
  return m ? { id: idOf(m), translation: m.translation ?? [0, 0, 0], rotation: m.rotation ?? [0, 0, 0, 1], scaling: m.scaling ?? [1, 1, 1] } : null;
};
/** An object's own translation, rotation and scaling (what a curve set's binding may drive). */
const parts = (o) => ({ t: o.translation ?? [0, 0, 0], r: o.rotation ?? [0, 0, 0, 1], s: o.scaling ?? [1, 1, 1] });
const effectName = (fx) => (fx?.effectFilePath ? String(fx.effectFilePath).split("/").pop().replace(/\.fx$/i, "").toLowerCase() : null);

// Every object a curve set's binding may name gets an id (the binding's destinationObject is the object itself in the
// file's graph): the drawn nodes, a mesh's areas and its effects' parameters carry theirs.
let ids = new WeakMap();
let nextId = 1;
const idOf = (o) => { if (!ids.has(o)) ids.set(o, nextId++); return ids.get(o); };

/** A curve as the page evaluates it (web/src/three/curves.ts): its own fields, a scalar's keys as their rows. */
function curveData(c) {
  if (Array.isArray(c)) return c.map(curveData);
  if (!c || typeof c !== "object") return c;
  // a curve may be a binding's destination (its timeOffset, say), so it carries its id
  const out = typeof c.type === "string" && (c.type.startsWith("Tr2Curve") || c.type === "TriPerlinCurve") ? { id: idOf(c) } : {};
  for (const [k, v] of Object.entries(c)) {
    if (k === "keys" && v && Array.isArray(v.items)) out.keys = v.items;
    else if (v && typeof v === "object") out[k] = curveData(v);
    else out[k] = v;
  }
  return out;
}

/**
 * A curve set (TriCurveSet): its name, whether it plays on load (true unless said; the others wait for a controller's
 * state machine to play them), its scale, its time ranges (Tr2CurveSetRange: start 0, end 1, not looped unless said),
 * its curves, and the bindings whose source is one of its curves (or any curve), each naming its destination by id.
 */
// a curve a set evaluates: Trinity's Tr2Curve* and its TriPerlinCurve
const isCurve = (o) => typeof o?.type === "string" && (o.type.startsWith("Tr2Curve") || o.type === "TriPerlinCurve");
function readCurveSet(cs) {
  const curves = (cs.curves ?? []).filter(isCurve);
  const index = new Map(curves.map((c, i) => [c, i]));
  const bindings = [];
  for (const b of cs.bindings ?? []) {
    const src = b?.sourceObject, dst = b?.destinationObject;
    // a source that is a container's fx attributes (EveCameraFxAttributes, EveSpaceObjectFxAttributes: values the
    // engine gathers each update - distance to the camera, look angle, ...): named by its id and type
    if (src && dst && /^Eve(Camera|SpaceObject)FxAttributes$/.test(src.type ?? "")) {
      bindings.push({
        id: idOf(b), source: null, sourceCurve: null, sourceFx: idOf(src), sourceFxType: src.type,
        sourceAttribute: b.sourceAttribute ?? "", destination: idOf(dst), destinationType: dst.type ?? null,
        destinationAttribute: b.destinationAttribute ?? "", scale: b.scale ?? 1, offset: b.offset ?? [0, 0, 0, 0],
      });
      continue;
    }
    if (!src || !dst || !isCurve(src)) continue;
    bindings.push({
      // a binding may be another's destination (its scale)
      id: idOf(b), source: index.has(src) ? index.get(src) : null, sourceCurve: index.has(src) ? null : curveData(src),
      sourceAttribute: b.sourceAttribute ?? "currentValue", destination: idOf(dst), destinationType: dst.type ?? null,
      destinationAttribute: b.destinationAttribute ?? "", scale: b.scale ?? 1, offset: b.offset ?? [0, 0, 0, 0],
    });
  }
  const ranges = (cs.ranges ?? []).filter((r) => r?.name).map((r) => ({ name: r.name, start: r.startTime ?? 0, end: r.endTime ?? 1, looped: r.looped === true }));
  return { id: idOf(cs), name: cs.name ?? null, playOnLoad: cs.playOnLoad !== false, scale: cs.scale ?? 1, ranges, curves: curves.map(curveData), bindings };
}

// The object files Tr2ActionChildEffect loads (by their .red path, as the actions name them), each read once per build
// as a child's graph (readNode): the page builds one when a controller's state starts.
let effectRoots = new Map();
// the hull locator sets the file's effect propagators name (written with the children: extract.mjs locatorSets)
let locatorSetsUsed = new Set();
export const usedLocatorSets = () => [...locatorSetsUsed];
/** The child effects the last readHullChildren read, by path. */
export function childEffectRoots() {
  return Object.fromEntries(effectRoots);
}
function readChildEffect(path, skipped) {
  const key = String(path).toLowerCase();
  if (effectRoots.has(key)) return key;
  effectRoots.set(key, null);
  const res = key.replace(/\.red$/, ".black");
  if (!readRf?.has(res)) return key;
  const kept = shownBySet, keptEmitters = actionEmitters;
  try {
    const o = readBlack(readRf.read(res), res);
    shownBySet = findShownBySet(o);
    actionEmitters = findActionEmitters(o);
    effectRoots.set(key, readNode(o, skipped));
  } catch (e) {
    skipped.unreadEffect = String(e.message ?? e);
  } finally {
    shownBySet = kept;
    actionEmitters = keptEmitters;
  }
  return key;
}

/**
 * The object a Tr2ActionSetValue's binding point names (Tr2BindingPoint): its destination object, or its path from a
 * root - "Owner" (the controller's owner) then .objects["name"] steps (a list's element of that name) - or null.
 */
function setValueObject(owner, a) {
  if (!a.path) return a.destination ?? null;
  const m = /^Owner((?:\.(?:objects|curveSets|curves|parameters)\["[^"]*"\])*)$/.exec(String(a.path));
  if (!m) return null;
  let o = owner;
  for (const step of m[1].matchAll(/\.(objects|curveSets|curves|parameters)\["([^"]*)"\]/g)) {
    // an object's parameters: its effect's, or its mesh areas' effects' (the first of that name)
    const list = step[1] === "parameters" ? effectParametersOf(o) : (o?.[step[1]] ?? []);
    o = list.find((x) => x?.name === step[2]) ?? null;
    if (!o) return null;
  }
  return o;
}
/** An object's effect parameters (Tr2*Parameter): its own effect's, then its mesh's areas' effects'. */
function effectParametersOf(o) {
  const areas = ["opaqueAreas", "transparentAreas", "additiveAreas", "decalAreas", "distortionAreas"].flatMap((k) => o?.mesh?.[k] ?? []);
  return [o?.effect, ...areas.map((x) => x?.effect)].flatMap((fx) => fx?.parameters ?? []);
}

/**
 * A Tr2Controller (Trinity's Controllers/): its float variables at their defaults, and each state machine's states
 * (the start state's index; each state's actions and transitions, a transition's destination being the state of its
 * name - Tr2StateMachineTransition's "name" is its destinationName). Of the actions, Tr2ActionChildEffect is read (its
 * file read as a child effect); the others are kept by type only.
 */
function readController(c, skipped, owner) {
  const varNames = new Set((c.variables ?? []).filter((v) => v?.name).map((v) => v.name));
  const readActions = (list) => (list ?? []).filter(Boolean).map((a) => {
    // Tr2ActionSetValue: into a variable (its path a variable's name, or its destination the variable), or into an
    // object's display (its path from Owner, or its destination object): the object's id
    if (a.type === "Tr2ActionSetValue") {
      const value = String(a.value ?? "");
      if (a.attribute === "value" && a.path && varNames.has(a.path)) return { k: "setVar", variable: a.path, value };
      if (a.attribute === "value" && !a.path && a.destination?.type === "Tr2ControllerFloatVariable") return { k: "setVar", variable: a.destination.name, value };
      const target = a.attribute === "display" ? setValueObject(owner, a) : null;
      if (target) return { k: "setDisplay", target: idOf(target), value };
      // a curve set's time or speed (Owner...curveSets["name"]: TriCurveSet's scaledTime and scale)
      const set = a.attribute === "scaledTime" || a.attribute === "scale" ? setValueObject(owner, a) : null;
      if (set?.type === "TriCurveSet") return { k: a.attribute === "scale" ? "setSetScale" : "setSetTime", curveSet: idOf(set), value };
      // a curve's input (an expression's input1..4: Tr2CurveScalarExpression) by its id, as a binding's
      if (/^input[1-4]$/.test(a.attribute ?? "")) {
        const curve = setValueObject(owner, a);
        if (isCurve(curve)) return { k: "setValue", target: idOf(curve), attribute: a.attribute, value };
      }
      // an effect parameter's value (Tr2Vector4Parameter / Tr2FloatParameter: "value", or one component "value.w")
      if (/^value(\.[xyzw])?$/.test(a.attribute ?? "")) {
        const param = setValueObject(owner, a);
        if (/^Tr2(Vector[234]|Float)Parameter$/.test(param?.type ?? "")) return { k: "setValue", target: idOf(param), attribute: a.attribute, value };
      }
      // an effect propagator's trigger (EveChildEffectPropagator "trigger": non-nought reads its locators and plays)
      const propagator = a.attribute === "trigger" ? setValueObject(owner, a) : null;
      if (propagator?.type === "EveChildEffectPropagator") return { k: "trigger", target: idOf(propagator), value };
      skipped[a.type] = (skipped[a.type] ?? 0) + 1;
      return { k: a.type };
    }
    if (a.type === "Tr2ActionAnimateCurveSet") {
      if (!a.curveSet) { skipped[a.type] = (skipped[a.type] ?? 0) + 1; return { k: a.type }; }
      // its set is its own (held by the action, no container's): read with it, never played, only applied
      return { k: "animateCurveSet", curveSet: idOf(a.curveSet), ownSet: { ...readCurveSet(a.curveSet), playOnLoad: false }, value: String(a.value ?? "StateTime()") };
    }
    // Tr2ActionSpawnParticles: on start its emitter spawns rate x the emitter's own rate (Tr2DynamicEmitter::SpawnParticles)
    if (a.type === "Tr2ActionSpawnParticles") {
      if (!a.emitter) { skipped[a.type] = (skipped[a.type] ?? 0) + 1; return { k: a.type }; }
      return { k: "spawnParticles", emitter: idOf(a.emitter), rate: a.rate ?? 1 };
    }
    if (a.type === "Tr2ActionPlayCurveSet") return { k: "playCurveSet", set: a.curveSetName ?? "", range: a.rangeName ?? "", sync: a.syncToRange === true };
    if (a.type === "Tr2ActionChildEffect") {
      return { k: "childEffect", effect: a.path ? readChildEffect(a.path, skipped) : null, name: a.childName ?? null, add: a.addOnStart !== false, remove: a.removeOnStop !== false, other: a.targetAnotherOwner || null };
    }
    skipped[a.type ?? "?"] = (skipped[a.type ?? "?"] ?? 0) + 1;
    return { k: a.type ?? "?" };
  });
  const machines = (c.stateMachines ?? []).filter(Boolean).map((sm) => {
    const states = (sm.states ?? []).filter(Boolean);
    const indexOf = (name) => states.findIndex((s) => s.name === name);
    return {
      name: sm.name ?? null,
      start: sm.startState ? states.indexOf(sm.startState) : -1,
      states: states.map((st) => ({
        name: st.name ?? null,
        actions: readActions(st.actions),
        transitions: (st.transitions ?? []).filter(Boolean).map((t) => ({ condition: String(t.condition ?? ""), to: indexOf(t.name) })),
      })),
    };
  });
  // its event handlers (Tr2ControllerEventHandler: a name, actions started then stopped when the event comes)
  const eventHandlers = (c.eventHandlers ?? []).filter((e) => e?.name).map((e) => ({ name: e.name, actions: readActions(e.actions) }));
  // each variable's id: a curve set's binding may set it (Tr2ControllerFloatVariable "value")
  return { name: c.name ?? null, variables: (c.variables ?? []).filter((v) => v?.name).map((v) => ({ name: v.name, value: v.defaultValue ?? 0, id: idOf(v) })), machines, ...(eventHandlers.length ? { eventHandlers } : {}) };
}
let readRf = null;

// The objects whose display a curve set drives (in the file being read): one hidden in the file (display false) is
// read all the same, marked display false, for the set to show (on load, or when a controller plays it).
let shownBySet = new Set();
/**
 * The emitters a file's Tr2ActionSpawnParticles hold (each its own, in no EveChildParticleSystem's list: a gate's Arrival
 * and Departure emitters), by the particle system they emit into: the particle child that draws that system takes them
 * as emitters that only the action fires.
 */
let actionEmitters = new Map();
function findActionEmitters(root) {
  const out = new Map();
  const seen = new Set();
  const walk = (o) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (o.type === "Tr2ActionSpawnParticles" && o.emitter?.particleSystem) {
      const list = out.get(o.emitter.particleSystem) ?? [];
      if (!list.includes(o.emitter)) list.push(o.emitter);
      out.set(o.emitter.particleSystem, list);
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(root);
  return out;
}

function findShownBySet(root) {
  const out = new Set(), seen = new Set();
  const walk = (o) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (o.type === "TriCurveSet") {
      for (const b of o.bindings ?? []) if (b?.destinationObject && String(b.destinationAttribute ?? "").split(".")[0] === "display") out.add(b.destinationObject);
    }
    // a controller's SetValue on an object's display shows it too
    for (const c of o.controllers ?? []) for (const sm of c?.stateMachines ?? []) for (const st of sm?.states ?? []) for (const a of st?.actions ?? []) {
      if (a?.type !== "Tr2ActionSetValue" || a.attribute !== "display") continue;
      const target = setValueObject(o, a);
      if (target) out.add(target);
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(root);
  return out;
}

/** One EveChild* object as the page draws it, or null where nothing of it is drawn; `skipped` counts the rest by type. */
function readNode(o, skipped) {
  if (!o || typeof o !== "object") return null;
  const hidden = o.display === false;
  if (hidden && !shownBySet.has(o)) return null;
  const node = readShown(o, skipped);
  if (node && hidden) node.display = false;
  return node;
}

function readShown(o, skipped) {
  if (o.type === "EveChildQuad") {
    return {
      k: "quad", id: idOf(o), name: o.name ?? null, m: srt(o), color: o.color ?? [1, 1, 1, 1], brightness: o.brightness ?? 1,
      minScreenSize: o.minScreenSize ?? 0, effect: effectName(o.effect),
    };
  }
  if (o.type === "EveChildMesh" && o.mesh?.type === "Tr2InstancedMesh") {
    const area = [...(o.mesh.additiveAreas ?? []), ...(o.mesh.transparentAreas ?? []), ...(o.mesh.opaqueAreas ?? [])][0];
    if (effectName(area?.effect) === "traffic" && o.mesh.instanceGeometryResPath) {
      return {
        k: "traffic", name: o.name ?? null, m: srt(o), instances: String(o.mesh.instanceGeometryResPath).toLowerCase(),
        params: effectParams(area.effect), textures: effectTextures(area.effect),
      };
    }
  }
  if (o.type === "EveChildParticleSystem") {
    const cpu = o.mesh?.type === "Tr2InstancedMesh" && o.mesh.geometryResPath ? readParticleSystemChild(o, skipped) : null;
    // its GPU emitters (Tr2GpuUniqueEmitter, Tr2GpuSharedEmitter): they emit into the scene's one GPU particle system
    // (gpuParticles.ts), each from where the child is (EveChildParticleSystem::Update's childWorldTransform)
    const gpu = (o.particleEmitters ?? []).filter((e) => e?.type === "Tr2GpuUniqueEmitter" || e?.type === "Tr2GpuSharedEmitter");
    const gpuNode = gpu.length ? {
      k: "gpuParticles", id: idOf(o), name: o.name ?? null, m: srt(o), ...parts(o),
      emitters: gpu.map((e) => ({ id: idOf(e), ...plainOf(e, () => null) })),
      modifiers: (o.transformModifiers ?? []).map((t) => t.type),
    } : null;
    if (cpu && gpuNode) return { k: "container", name: o.name ?? null, m: null, t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1], curveSets: [], modifiers: [], srt: null, objects: [cpu, gpuNode], lights: [] };
    if (cpu || gpuNode) return cpu ?? gpuNode;
  }
  if (o.type === "EveChildMesh" && o.mesh?.type === "Tr2Mesh" && o.mesh.geometryResPath) {
    const areas = [];
    for (const [list, kind] of [["opaqueAreas", "opaque"], ["transparentAreas", "transparent"], ["additiveAreas", "additive"], ["distortionAreas", "distortion"]]) {
      for (const a of o.mesh[list] ?? []) {
        const fx = effectName(a.effect);
        const opts = Object.fromEntries((a.effect?.options?.items ?? []).filter((r) => Array.isArray(r)));
        // a distortion area draws into the distortion map (ubershaderdistortion.fx, the one effect such areas use)
        const drawn = kind === "distortion" ? fx === "ubershaderdistortion" : ["ubershader", "fx3dv5", "ubershadertwosided", "flare", "twocolorflare", "quadv5", "quadglassv5", "quaddetailv5", "fxv5"].includes(fx)
          || fx === "texturecolor"
          || (fx === "motionvectorramp" && MOTION_VECTOR_RAMP_DRAWN.some((perm) => MOTION_VECTOR_RAMP_DEFAULTS.every(([k, v]) => (opts[k] ?? v) === (perm[k] ?? v))));
        if (!drawn) { const k = fx === "motionvectorramp" || fx === "texturecolor" ? `area:${fx}:options` : `area:${fx}`; skipped[k] = (skipped[k] ?? 0) + 1; continue; }
        areas.push({
          id: idOf(a), paramIds: Object.fromEntries((a.effect.parameters ?? []).filter((p) => p?.name).map((p) => [p.name, idOf(p)])),
          kind, name: a.name ?? null, index: a.index ?? 0, count: a.count ?? 1, effect: fx,
          options: Object.fromEntries((a.effect.options?.items ?? []).filter((r) => Array.isArray(r))),
          params: effectParams(a.effect), textures: effectTextures(a.effect),
        });
      }
    }
    if (!areas.length) return null;
    return {
      k: "mesh", id: idOf(o), name: o.name ?? null, m: srt(o), ...parts(o), geometry: String(o.mesh.geometryResPath).toLowerCase(),
      meshIndex: o.mesh.meshIndex ?? 0, minScreenSize: o.minScreenSize ?? 0, areas,
      modifiers: (o.transformModifiers ?? []).map((t) => t.type), srt: srtOf(o.transformModifiers),
    };
  }
  if (o.type === "EveChildLineSet" && o.lineSet) {
    const curves = (o.lines ?? []).filter((c) => c?.type === "EveBezierCurve" && c.display !== false).map((c) => ({
      m: srt(c), p1: c.point1 ?? [0, 0, 0], c: c.bezierPoint ?? [0, 0, 0], p2: c.point2 ?? [0, 0, 0],
      segments: c.segments ?? 24, width: c.lineWidth ?? 1,
    }));
    if (!curves.length) { skipped.EveChildLineSet = (skipped.EveChildLineSet ?? 0) + 1; return null; }
    return {
      k: "lines", id: idOf(o), name: o.name ?? null, m: srt(o), baseColor: o.baseColor ?? [1, 1, 1, 1], animColor: o.animColor ?? [0, 0, 0, 1],
      brightness: o.brightness ?? 1, additive: o.lineSet.additive === true || o.additiveBatches === true,
      widthFactor: o.lineSet.lineWidthFactor ?? 1, scrollSpeed: o.scrollSpeed ?? 0, effect: effectName(o.lineSet.lineEffect),
      textures: effectTextures(o.lineSet.lineEffect), curves,
    };
  }
  // EveChildEffectPropagator (Trinity's Eve/SpaceObject/Children/): its instance container's source copied to each
  // locator of the set it names; read where the set is the owner's (propagationType externalLocatorSet, 1) and the
  // trigger places every copy at once and keeps it (triggerMethood instantPermanent, 2)
  if (o.type === "EveChildEffectPropagator") {
    const type = o.propagationType ?? 0, trigger = o.triggerMethood ?? 0;
    const source = o.effect?.type === "EveChildInstanceContainer" ? readNode(o.effect.source, skipped) : null;
    if (type !== 1 || trigger !== 2 || !source) {
      const k = `EveChildEffectPropagator:${type}/${trigger}${source ? "" : "/no-source"}`;
      skipped[k] = (skipped[k] ?? 0) + 1;
      return null;
    }
    // ProcessRefLocators: an empty name is "damage"
    const set = String(o.locatorSetName || "damage").trim();
    locatorSetsUsed.add(set);
    const m = srt(o);
    return {
      k: "propagator", id: idOf(o), name: o.name ?? null, m: identity(m) ? null : m, locatorSet: set,
      completeness: Math.min(1, Math.max(0, o.completeness ?? 1)), scaling: o.effectScaling ?? [1, 1, 1],
      randScale: [o.randScaleMin ?? 1, Math.max(o.randScaleMin ?? 1, o.randScaleMax ?? 1)], source,
    };
  }
  if (o.type === "EveChildContainer") {
    if (!HIGH_QUALITY.has(o.displayFilter ?? 5)) return null;
    const objects = (o.objects ?? []).map((c) => readNode(c, skipped)).filter(Boolean);
    // its point lights (Tr2PointLight: in the container's space); spot lights counted
    const lights = [];
    for (const l of o.lights ?? []) {
      if (l?.type === "Tr2PointLight") {
        lights.push({ position: l.position ?? [0, 0, 0], radius: l.radius ?? 1, innerRadius: l.innerRadius ?? 0, color: l.color ?? [1, 1, 1, 1], brightness: l.brightness ?? 1 });
      } else skipped[l?.type ?? "?"] = (skipped[l?.type ?? "?"] ?? 0) + 1;
    }
    const curveSets = (o.curveSets ?? []).filter((cs) => cs?.type === "TriCurveSet").map(readCurveSet);
    const controllers = (o.controllers ?? []).filter((c) => c?.type === "Tr2Controller").map((c) => readController(c, skipped, o));
    // its fx attributes (EveChildContainer.fxAttributes: their values gathered each update, read by its sets' bindings)
    const fxAttributes = (o.fxAttributes ?? []).filter((f) => /^Eve(Camera|SpaceObject)FxAttributes$/.test(f?.type ?? "")).map((f) => ({ id: idOf(f), type: f.type }));
    if (!objects.length && !lights.length && !curveSets.length && !controllers.length) return null;
    const m = srt(o);
    return {
      k: "container", id: idOf(o), name: o.name ?? null, m: identity(m) ? null : m, ...parts(o), curveSets,
      modifiers: (o.transformModifiers ?? []).map((t) => t.type), srt: srtOf(o.transformModifiers),
      objects,
      lights,
      ...(controllers.length ? { controllers } : {}),
      ...(fxAttributes.length ? { fxAttributes } : {}),
    };
  }
  skipped[o.type ?? "?"] = (skipped[o.type ?? "?"] ?? 0) + 1;
  return null;
}

/**
 * An EveChildParticleSystem drawn on the CPU path (Trinity's Particle/): its instanced mesh (the quad and the area that
 * draws the particles; its instance data the particle system the mesh names), its particle systems (Tr2ParticleSystem:
 * their element declarations, forces, constraints, flags) and its emitters (Tr2DynamicEmitter, Tr2StaticEmitter: rate,
 * limit, the system they emit to, their generators), each as the file has it (plainOf), a system named by its index.
 * The GPU emitters (Tr2GpuUniqueEmitter and the like) are counted as skipped.
 */
function readParticleSystemChild(o, skipped) {
  const systems = [];
  const sysIndex = new Map();
  const systemOf = (s) => {
    if (!s || s.type !== "Tr2ParticleSystem") return -1;
    if (!sysIndex.has(s)) {
      sysIndex.set(s, systems.length);
      systems.push(null);
      systems[sysIndex.get(s)] = plainOf(s, (x) => (x?.type === "Tr2ParticleSystem" ? { system: systemOf(x) } : null));
    }
    return sysIndex.get(s);
  };
  const emitters = [];
  const pushEmitter = (e, actionOnly) => {
    // its id: a curve set's binding may drive its rate (a Tr2ActionSpawnParticles names it)
    const plain = { id: idOf(e), ...plainOf(e, (x) => (x?.type === "Tr2ParticleSystem" ? { system: systemOf(x) } : null)), ...(actionOnly ? { actionOnly: true } : {}) };
    // its generators' ids: a curve set's binding may drive their ranges (a wreck fire's lifetimes, sizes, speeds)
    if (Array.isArray(plain.generators)) plain.generators = plain.generators.map((g, i) => (g && typeof g === "object" ? { id: idOf(e.generators[i]), ...g } : g));
    emitters.push(plain);
  };
  for (const e of o.particleEmitters ?? []) {
    if (e?.type !== "Tr2DynamicEmitter" && e?.type !== "Tr2StaticEmitter") {
      skipped[`particleEmitter:${e?.type ?? "?"}`] = (skipped[`particleEmitter:${e?.type ?? "?"}`] ?? 0) + 1;
      continue;
    }
    pushEmitter(e, false);
  }
  // the emitters only an action fires (Tr2ActionSpawnParticles' own) into this child's systems
  for (const s of [o.mesh?.instanceGeometryResource, ...(o.particleSystems ?? [])]) for (const e of actionEmitters.get(s) ?? []) if (e?.type === "Tr2DynamicEmitter" && !emitters.some((x) => x.id === idOf(e))) pushEmitter(e, true);
  const meshSystem = systemOf(o.mesh.instanceGeometryResource);
  const updated = (o.particleSystems ?? []).map(systemOf).filter((i) => i >= 0);
  if (meshSystem < 0 || !emitters.length) return null;
  const lists = [["additiveAreas", "additive"], ["transparentAreas", "transparent"], ["opaqueAreas", "opaque"]];
  const areas = [];
  for (const [list, kind] of lists) for (const a of o.mesh[list] ?? []) {
    if (!a?.effect) continue;
    areas.push({
      id: idOf(a), kind, name: a.name ?? null, index: a.index ?? 0, count: a.count ?? 1, effect: effectName(a.effect),
      // the whole path: particles/motionvector.fx and particles/dynamic/motionvector.fx are different effects
      path: String(a.effect.effectFilePath ?? "").toLowerCase(),
      // its parameters' ids: a curve set's binding may drive one (a wreck fire's Color2)
      paramIds: Object.fromEntries((a.effect.parameters ?? []).filter((p) => p?.name).map((p) => [p.name, idOf(p)])),
      options: Object.fromEntries((a.effect.options?.items ?? []).filter((r) => Array.isArray(r))),
      params: effectParams(a.effect), textures: effectTextures(a.effect),
    });
  }
  if (!areas.length) return null;
  return {
    k: "particles", id: idOf(o), name: o.name ?? null, m: srt(o), ...parts(o), geometry: String(o.mesh.geometryResPath).toLowerCase(),
    meshIndex: o.mesh.meshIndex ?? 0, minScreenSize: o.minScreenSize ?? 0, areas, meshSystem, systems, emitters,
    updated: updated.length ? updated : [meshSystem],
    modifiers: (o.transformModifiers ?? []).map((t) => t.type),
  };
}

/** A file's object as plain data (primitives and arrays; nested objects alike), `ref` replacing the objects it names. */
function plainOf(o, ref, depth = 0) {
  if (o === null || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map((x) => plainOf(x, ref, depth + 1));
  if (depth > 0) {
    const r = ref(o);
    if (r) return r;
  }
  if (depth > 8) return null;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "keys" && v && Array.isArray(v.items)) out.keys = v.items;
    else out[k] = plainOf(v, ref, depth + 1);
  }
  return out;
}

const STANDALONE = 1;
const built = (entry) => ((entry.buildFilter ?? -1) & STANDALONE) !== 0;

/** The children EveSOF builds for this hull and faction (EveSOFDataHullChild or EveSOFDataHullChildSetItem entries). */
export function hullChildEntries(sofHull, faction) {
  if (sofHull?.sof6) {
    const groups = new Set((faction?.visibilityGroupSet?.visibilityGroups ?? []).map((g) => String(g.str ?? "")));
    return (sofHull.childSets ?? []).filter((set) => groups.has(String(set.visibilityGroup ?? "primary"))).flatMap((set) => set.items ?? []).filter(built);
  }
  const shown = new Map();
  for (const c of faction?.children ?? []) shown.set(c.groupIndex ?? -1, c.isVisible === true);
  return (sofHull?.children ?? []).filter((c) => built(c) && !((c.groupIndex ?? -1) !== -1 && shown.get(c.groupIndex) === false));
}

/**
 * The hull's children as EveSOF builds them for the faction (hullChildEntries), each { res, root, skipped }: the
 * object file, its drawn graph (readNode, its root placed by the entry), and what of it is not drawn yet, by type. A
 * file the client does not ship is left out.
 */
export function readHullChildren(rf, sofHull, faction = null) {
  const out = [];
  ids = new WeakMap();
  nextId = 1;
  effectRoots = new Map();
  locatorSetsUsed = new Set();
  readRf = rf;
  for (const child of hullChildEntries(sofHull, faction)) {
    const res = String(child.redFilePath ?? "").toLowerCase().replace(/\.red$/, ".black");
    if (!res || !rf.has(res)) continue;
    const skipped = {};
    let root = null;
    try {
      const o = readBlack(rf.read(res), res);
      if (o && typeof o === "object" && o.useSRT !== false) {
        o.translation = child.translation ?? [0, 0, 0];
        o.rotation = child.rotation ?? [0, 0, 0, 1];
        o.scaling = child.scaling ?? [1, 1, 1];
      }
      shownBySet = findShownBySet(o);
      actionEmitters = findActionEmitters(o);
      root = readNode(o, skipped);
    } catch (e) {
      skipped.unread = String(e.message ?? e);
    }
    out.push({ res, root, skipped });
  }
  return out;
}

/**
 * An effect file read whole (an EveEffectRoot2: a missile's impact, an explosion): its effectChildren read as one
 * container's objects, with the root's own curve sets and controllers (their owner the root), as a hull child's root
 * is. { res, root, skipped, childEffects, duration, boundingSphereRadius } - the root's duration (-1: none given) and
 * radius as the file has them; null where the client has no such file.
 */
export function readEffectFile(rf, path) {
  const res = String(path).toLowerCase().replace(/\.red$/, ".black");
  if (!rf.has(res)) return null;
  ids = new WeakMap();
  nextId = 1;
  effectRoots = new Map();
  locatorSetsUsed = new Set();
  readRf = rf;
  const skipped = {};
  let root = null, o = null;
  try {
    o = readBlack(rf.read(res), res);
    shownBySet = findShownBySet(o);
    actionEmitters = findActionEmitters(o);
    root = o && typeof o === "object" ? readNode({ ...o, type: "EveChildContainer", objects: o.effectChildren ?? [] }, skipped) : null;
  } catch (e) {
    skipped.unread = String(e.message ?? e);
  }
  return { res, root, skipped, childEffects: childEffectRoots(), duration: o?.duration ?? -1, boundingSphereRadius: o?.boundingSphereRadius ?? 0 };
}

/**
 * The hull's own controllers (EveSOFDataHull.controllers: each a Tr2Controller's file, res:/dx9/model/controller/
 * shipstandard.red and the like), read as a child's are, their owner the space object itself. Read after
 * readHullChildren, whose ids they continue. A file the client does not ship, or not a controller, is left out.
 */
export function readHullControllers(rf, sofHull) {
  const out = [];
  const skipped = {};
  for (const c of sofHull?.controllers ?? []) {
    const res = String(c?.path ?? "").toLowerCase().replace(/\.red$/, ".black");
    if (!res || !rf.has(res)) continue;
    try {
      const o = readBlack(rf.read(res), res);
      if (o?.type === "Tr2Controller") out.push({ path: res, ...readController(o, skipped, null) });
    } catch {
      // an unreadable controller file draws nothing
    }
  }
  return out;
}

/**
 * A traffic mesh's instances (its instance geometry: Position xyzw, TextureCoordinates0 xyzw; traffic.fx's POSITION8
 * and TEXCOORD8): one row of eight numbers each - the offset (x, y, z) and the path (w); the size, the speed (its sign
 * the way along the path), the colour's mix and the phase.
 */
export async function readTrafficInstances(rf, res) {
  const { readGranny } = await import("./granny.mjs");
  const g = await readGranny(rf.read(res), res);
  const cols = g.root?.Meshes?.[0]?.PrimaryVertexData?.Vertices?.columns ?? {};
  const a = cols.Position, b = cols.TextureCoordinates0;
  if (!a || !b || a.width !== 4 || b.width !== 4) throw new Error(`${res}: not a traffic instance buffer`);
  const n = a.data.length / 4;
  const out = new Array(n * 8);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 8 + j] = Math.round(a.data[i * 4 + j] * 1e4) / 1e4;
      out[i * 8 + 4 + j] = Math.round(b.data[i * 4 + j] * 1e4) / 1e4;
    }
  }
  return out;
}
