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
import { COLOR_TYPES, colorOf } from "./sof.mjs";

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
    // a source that is the container's inherited properties (EveChildInheritProperties: the colour set EveSOF gives
    // the space object from its DNA, SetInheritProperties, handed down to every child container): the faction's colour
    // by the attribute's name (Primary .. PrimaryDockedFx), a constant for this build
    if (src && dst && src.type === "EveChildInheritProperties") {
      bindings.push({
        id: idOf(b), source: null, sourceCurve: null, sourceConst: colorOf(readFaction?.colorSet ?? null, String(b.sourceAttribute ?? "").split(".")[0]),
        sourceAttribute: b.sourceAttribute ?? "", destination: idOf(dst), destinationType: dst.type ?? null,
        destinationAttribute: b.destinationAttribute ?? "", scale: b.scale ?? 1, offset: b.offset ?? [0, 0, 0, 0],
      });
      continue;
    }
    if (src && dst?.type === "PostProcessOutput" && isCurve(src)) {
      bindings.push({
        id: idOf(b), source: index.has(src) ? index.get(src) : null, sourceCurve: index.has(src) ? null : curveData(src),
        sourceAttribute: b.sourceAttribute ?? "currentValue", destination: -1, destinationType: "PostProcessOutput",
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
// the hull's children's raw roots (each named; a hull controller's Owner.effectChildren) and its own controllers' raw
// objects (Owner.controllers), for SetValue paths
let rawHullChildren = [];
let rawHullControllers = [];
// the same files' raw roots (as read), for a SetValue that reaches into an effect a controller loads at run time
let rawEffects = new Map();
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
    rawEffects.set(key, o);
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
/**
 * A SetValue whose path starts at a child effect the controller loads at run time (Tr2ActionChildEffect childName:
 * Owner.objects["<childName>"] is that effect's root once loaded): the object the rest of the path names in each file
 * the controller may load under that name (none where a file has no such object: Trinity's binding then finds nothing).
 */
function childEffectTargets(a, childEffects) {
  const m = /^Owner\.objects\["([^"]*)"\](.*)$/.exec(String(a.path ?? ""));
  if (!m || !childEffects.has(m[1])) return [];
  const out = [];
  for (const key of childEffects.get(m[1])) {
    const root = rawEffects.get(key);
    const target = root ? setValueObject(root, { path: `Owner${m[2]}` }) : null;
    if (target) out.push(target);
  }
  return out;
}

/**
 * The object a SetValue's path names (Tr2ValueBinding's path from Owner): each step an attribute, a list's item by
 * name (["x"]) or index ([0]), or a plain attribute (.plug, .destinationObject); an object's parameters are its
 * effect's or its mesh areas' effects'. A hull controller's Owner (owner null) is the space object: its effectChildren
 * the hull's children (readHullChildren), its controllers the hull's own (readHullControllers). Null where any step
 * finds nothing (Trinity's binding is then not valid).
 */
function setValueObject(owner, a) {
  if (!a.path) return a.destination ?? null;
  const path = String(a.path);
  if (!path.startsWith("Owner")) return null;
  const rest = path.slice("Owner".length);
  const steps = [...rest.matchAll(/\.([A-Za-z_]\w*)(?:\[(?:"([^"]*)"|(\d+))\])?/g)];
  if (steps.map((s) => s[0]).join("") !== rest) return null;
  let o = owner ?? { effectChildren: rawHullChildren, controllers: rawHullControllers };
  for (const [, name, key, index] of steps) {
    const value = name === "parameters" ? effectParametersOf(o) : o?.[name];
    if (key !== undefined) o = Array.isArray(value) ? value.find((x) => x?.name === key) ?? null : null;
    else if (index !== undefined) o = Array.isArray(value) ? value[Number(index)] ?? null : null;
    else o = value ?? null;
    if (!o || typeof o !== "object") return null;
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
const OWNER_ATTRIBUTES = new Set(["activationStrength", "display", "clipSphereFactor", "clipSphereFactor2"]);
// the overlay files the hull's controllers name (Tr2ActionOverlay), read by hullOverlays
let overlayPaths = new Set();
function readController(c, skipped, owner) {
  const varNames = new Set((c.variables ?? []).filter((v) => v?.name).map((v) => v.name));
  // the child effects this controller loads, by the name each takes (read now: a SetValue may reach into them)
  const childEffects = new Map();
  const findLoads = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(findLoads); return; }
    if (n.type === "Tr2ActionChildEffect" && n.path && n.childName) {
      const key = readChildEffect(n.path, skipped);
      if (!childEffects.has(n.childName)) childEffects.set(n.childName, new Set());
      childEffects.get(n.childName).add(key);
    }
    for (const [k, v] of Object.entries(n)) if (v && typeof v === "object" && k !== "destination") findLoads(v);
  };
  findLoads(c.stateMachines);
  findLoads(c.eventHandlers);
  const readActions = (list) => (list ?? []).filter(Boolean).map((a) => {
    // Tr2ActionSetValue: into a variable (its path a variable's name, or its destination the variable), or into an
    // object's display (its path from Owner, or its destination object): the object's id
    // the space object's own attributes (a hull controller's Owner: EveSpaceObject2's activationStrength, display,
    // clipSphereFactor/2): SetValue once, AnimateValue each update (its value expression, Curve(x) its curve's value)
    if (!owner && (a.type === "Tr2ActionSetValue" || a.type === "Tr2ActionAnimateValue") && a.path === "Owner" && OWNER_ATTRIBUTES.has(a.attribute)) {
      if (a.type === "Tr2ActionSetValue") return { k: "setOwner", attribute: a.attribute, value: String(a.value ?? "") };
      return { k: "animateOwner", attribute: a.attribute, value: String(a.value ?? "Curve(StateTime())"), curve: a.curve ? curveData(a.curve) : null };
    }
    if (a.type === "Tr2ActionSetValue") {
      const value = String(a.value ?? "");
      if (a.attribute === "value" && a.path && varNames.has(a.path)) return { k: "setVar", variable: a.path, value };
      if (a.attribute === "value" && !a.path && a.destination?.type === "Tr2ControllerFloatVariable") return { k: "setVar", variable: a.destination.name, value };
      const target = a.attribute === "display" ? setValueObject(owner, a) : null;
      if (target) return { k: "setDisplay", target: idOf(target), value };
      // a curve set's time or speed (Owner...curveSets["name"]: TriCurveSet's scaledTime and scale)
      const set = a.attribute === "scaledTime" || a.attribute === "scale" ? setValueObject(owner, a) : null;
      if (set?.type === "TriCurveSet") return { k: a.attribute === "scale" ? "setSetScale" : "setSetTime", curveSet: idOf(set), value };
      // a curve's input (an expression's input1..4: Tr2CurveScalarExpression) or an effect parameter's value
      // (Tr2Vector4Parameter / Tr2FloatParameter: "value", or one component "value.w"), by id, as a binding's; in the
      // owner, or in each child effect it may load (the setter then reaches whichever is loaded)
      const isParam = (o) => /^Tr2(Vector[234]|Float)Parameter$/.test(o?.type ?? "");
      const fits = /^input[1-4]$/.test(a.attribute ?? "") ? isCurve : /^value(\.[xyzw])?$/.test(a.attribute ?? "") ? isParam : null;
      if (fits) {
        const own = setValueObject(owner, a);
        const targets = own ? [own] : childEffectTargets(a, childEffects);
        const ids = targets.filter(fits).map(idOf);
        if (ids.length) return { k: "setValue", target: ids[0], targets: ids, attribute: a.attribute, value };
      }
      // another controller's variable (Tr2ControllerFloatVariable "value", reached by its path: a child's controller,
      // the hull's other controllers, a child effect's): by the variable's id, as a binding into it is
      if (a.attribute === "value" && a.path) {
        const own = setValueObject(owner, a);
        const vars = (own ? [own] : childEffectTargets(a, childEffects)).filter((t) => t?.type === "Tr2ControllerFloatVariable");
        if (vars.length) return { k: "setValue", target: idOf(vars[0]), targets: vars.map(idOf), attribute: "value", value };
      }
      // an effect propagator's frequency (its interval triggers per second)
      if (a.attribute === "frequency") {
        const p = setValueObject(owner, a);
        if (p?.type === "EveChildEffectPropagator") return { k: "setValue", target: idOf(p), targets: [idOf(p)], attribute: "frequency", value };
      }
      // an effect propagator's trigger (EveChildEffectPropagator "trigger": non-nought reads its locators and plays)
      const propagator = a.attribute === "trigger" ? setValueObject(owner, a) : null;
      if (propagator?.type === "EveChildEffectPropagator") return { k: "trigger", target: idOf(propagator), value };
      skipped[a.type] = (skipped[a.type] ?? 0) + 1;
      return { k: a.type };
    }
    // Tr2ActionOverlay on the space object: its EveMeshOverlayEffect file (read by hullOverlays), added on start and
    // removed on stop (addOnStart / removeOnStop, true unless said)
    if (!owner && a.type === "Tr2ActionOverlay" && a.path && !a.targetAnotherOwner) {
      const res = String(a.path).toLowerCase().replace(/\.red$/, ".black");
      overlayPaths.add(res);
      return { k: "overlay", effect: res, add: a.addOnStart !== false, remove: a.removeOnStop !== false };
    }
    // Tr2ActionResetClipSphereCenter on the space object: its resetBehavior (0 the object's centre, 1 the last damage
    // locator hit, 2 a named locator set's locator; index -1 a random one)
    if (!owner && a.type === "Tr2ActionResetClipSphereCenter") return { k: "resetClipCenter", behavior: a.resetBehavior ?? 0, set: a.locatorSetName ?? "", index: a.locatorIndex ?? -1 };
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
    // Tr2ActionSetExternalControllerVariable (Start): the variable - its value, or this controller's sourceVariable -
    // set on the object bound to destinationOwner (an EveMultiEffect's parameter: "ship", "Hangar", "activeDock")
    if (a.type === "Tr2ActionSetExternalControllerVariable") {
      if (!a.destinationOwner || !a.variable) { skipped[a.type] = (skipped[a.type] ?? 0) + 1; return { k: a.type }; }
      return { k: "setExternal", other: a.destinationOwner, variable: a.variable, number: Number(a.value ?? 0), source: a.sourceVariable || null };
    }
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
// the faction the hull is built for (its colour set: Tr2FactionLight)
let readFaction = null;

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

/**
 * A Tr2Mesh's areas the page draws, each with its effect, options, parameters and textures (an EveChildMesh's mesh, a
 * behaviour group's). quadinstancedv5.fx (the behaviour groups' instanced hull shader: quadv5 with the instance's
 * transform) is read as quadv5 - the page instances the mesh itself.
 */
function meshAreas(mesh, skipped) {
  const areas = [];
  for (const [list, kind] of [["opaqueAreas", "opaque"], ["transparentAreas", "transparent"], ["additiveAreas", "additive"], ["distortionAreas", "distortion"]]) {
    for (const a of mesh[list] ?? []) {
      const named = effectName(a.effect);
      const fx = named === "quadinstancedv5" ? "quadv5" : named;
      const opts = Object.fromEntries((a.effect?.options?.items ?? []).filter((r) => Array.isArray(r)));
      // a distortion area draws into the distortion map (ubershaderdistortion.fx, the one effect such areas use)
      const drawn = kind === "distortion" ? fx === "ubershaderdistortion" : ["ubershader", "fx3dv5", "ubershadertwosided", "ubershadercube", "flare", "twocolorflare", "quadv5", "quadglassv5", "quaddetailv5", "fxv5"].includes(fx)
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
  return areas;
}

/**
 * An EveStretch3 (Eve/Renderable/Stretch/EveStretch3.cpp) as the page runs it (behaviorAgents.ts): its source, stretch,
 * move and dest objects (EveChildContainers) read as one container's children - with the stretch's own controllers and
 * curve sets, their owner the stretch - and their ids, so each update can place them; destObjectScale. Its TriFloat
 * length / moveProgression bindings are not followed. Null for another class or without objects.
 */
function readStretch3(fx) {
  if (fx?.type !== "EveStretch3") return null;
  const parts = { source: fx.sourceObject, stretch: fx.stretchObject, move: fx.moveObject, dest: fx.destObject };
  const objects = Object.values(parts).filter((p) => p && typeof p === "object");
  if (!objects.length) return null;
  const skipped = {};
  const root = readNode({ type: "EveChildContainer", objects, controllers: fx.controllers ?? [], curveSets: fx.curveSets ?? [] }, skipped);
  if (!root) return null;
  const ids = Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, p && typeof p === "object" ? idOf(p) : null]));
  // the parts are placed from outside each update (hullChildren.ts: live containers)
  for (const o of root.objects ?? []) if (o.k === "container" && Object.values(ids).includes(o.id)) o.live = true;
  return { root, destObjectScale: fx.destObjectScale ?? 1, ids };
}

/**
 * An EveTransform (the older scene object an EveStretch hangs: its SRT, children, particle emitters and systems, an
 * instanced particle mesh or a plain mesh, curve sets) as the child nodes the page builds: a container (its own id,
 * so a binding into it still finds it) holding its children, an EveChildParticleSystem of its particles (the same
 * fields) and an EveChildMesh of a plain mesh; its modifier as the child modifier that does the same.
 */
function transformAsChild(t, skipped) {
  if (!t || typeof t !== "object" || t.type !== "EveTransform") return t;
  const objects = (t.children ?? []).map((c) => transformAsChild(c, skipped));
  const instanced = t.mesh?.type === "Tr2InstancedMesh" ? t.mesh : null;
  if ((t.particleEmitters ?? []).length || (t.particleSystems ?? []).length || instanced) {
    objects.push({ type: "EveChildParticleSystem", name: t.name ?? null, particleEmitters: t.particleEmitters ?? [], particleSystems: t.particleSystems ?? [], mesh: instanced });
  }
  if (t.mesh?.type === "Tr2Mesh") objects.push({ type: "EveChildMesh", name: t.name ?? null, mesh: t.mesh });
  // its modifier (Tr2Transform_Blue.cpp's chooser: 1 Billboard, 3 Look at camera, 4 Simple halo, 8 EVE simple halo)
  // as the child modifier that makes the same world transform (Tr2Transform.cpp UpdateWorldTransform): a billboard -
  // the view's axes, each the transform's own scale - is EveChildModifierBillboard2D; a halo (that x max(z . d, 0)^2)
  // EveChildModifierHalo; look-at-camera (axes from LookAtMatrix(eye, pos, +y)) the page's EveTransformLookAtCamera;
  // another counted in skipped
  // (100, EVE camera rotation aligned: the page's EveTransformCameraRotationAligned)
  const MODIFIER = { 1: "EveChildModifierBillboard2D", 3: "EveTransformLookAtCamera", 4: "EveChildModifierHalo", 8: "EveChildModifierHalo", 100: "EveTransformCameraRotationAligned" };
  const mod = t.modifier ? MODIFIER[t.modifier] : null;
  if (t.modifier && !mod) skipped[`EveTransform.modifier:${t.modifier}`] = (skipped[`EveTransform.modifier:${t.modifier}`] ?? 0) + 1;
  const c = {
    type: "EveChildContainer", name: t.name ?? null, display: t.display, translation: t.translation, rotation: t.rotation, scaling: t.scaling,
    objects, curveSets: t.curveSets ?? [], lights: [], transformModifiers: mod ? [{ type: mod }] : [],
  };
  ids.set(c, idOf(t));
  return c;
}

/**
 * An EveStretch (Eve/Renderable/Stretch/EveStretch.cpp: a turret's firing effect of EveTransform trees - the missile
 * launchers', salvagers', tractor beams', drones'): its parts as child graphs (transformAsChild) under one container
 * with the stretch's curve sets - play_start and play_loop played as it starts (StartFiring), play_end not - and the
 * parts' ids, placed from outside (EveStretch::UpdateVisibility's rules, the page's placeEveStretch).
 */
function readEveStretch(fx) {
  if (fx?.type !== "EveStretch") return null;
  const skipped = {};
  const raw = { source: fx.sourceObject, stretch: fx.stretchObject, move: fx.moveObject, dest: fx.destObject };
  const parts = Object.fromEntries(Object.entries(raw).map(([k, p]) => [k, p && typeof p === "object" ? transformAsChild(p, skipped) : null]));
  const objects = Object.values(parts).filter(Boolean);
  if (!objects.length) return null;
  const curveSets = (fx.curveSets ?? []).map((cs) => (cs?.name === "play_end" ? { ...cs, playOnLoad: false } : cs?.name === "play_start" || cs?.name === "play_loop" ? { ...cs, playOnLoad: true } : cs));
  const root = readNode({ type: "EveChildContainer", objects, curveSets }, skipped);
  if (!root) return null;
  const ids = Object.fromEntries(Object.entries(parts).map(([k, p]) => [k, p ? idOf(p) : null]));
  for (const o of root.objects ?? []) if (o.k === "container" && Object.values(ids).includes(o.id)) o.live = true;
  return { root, destObjectScale: fx.destObjectScale ?? 1, ids, skipped };
}

/** A BehaviorGroupBooster flare's numbers (prefix haloFlare / ambientFlare; its constructor's defaults). */
const flareOf = (b, k) => ({
  offset: b[`${k}Offset`] ?? [0, 0, 0], scale: b[`${k}Scale`] ?? [1, 1, 1], brightness: b[`${k}Brightness`] ?? 0, color: b[`${k}Color`] ?? [1, 1, 1, 1],
  noiseAmplitude: b[`${k}NoiseAmplitude`] ?? 0.2, noiseSpeed: b[`${k}NoiseSpeed`] ?? 1, noiseOctaves: b[`${k}NoiseOctaves`] ?? 1,
});

// the behaviours behaviorAgents.ts runs
const AGENT_BEHAVIORS = new Set(["SpawnDrones", "ProcessLifetime", "Inertia", "DroneAvoidance", "SeekTarget", "CollisionAvoidance", "InclusionVolume", "Wander", "PlayFX"]);

/** An EveEllipsoidVolume (its constructor's defaults: all nought, no rotation). */
const readVolume = (v) => ({ position: v?.position ?? [0, 0, 0], shape: v?.shape ?? [0, 0, 0], innerShape: v?.innerShape ?? [0, 0, 0], rotation: v?.rotation ?? [0, 0, 0, 1] });

/** A behaviour's numbers, each with its constructor's default (Behaviors/*.cpp); its priority (IBehavior::ProcessPriority). */
function readBehavior(b) {
  const common = { type: b.type, id: idOf(b), enabled: b.enabled !== false, priority: b.behaviorPriority ?? 0 };
  if (b.type === "SpawnDrones") {
    return { ...common, addByCount: b.addByCount === true, addOnGrid: b.addOnGrid === true, seconds: b.seconds ?? -1, time: b.time ?? 0, count: b.count ?? 1, spawnPosition: b.spawnPosition ?? [0, 0, 0] };
  }
  if (b.type === "ProcessLifetime") {
    return {
      ...common, returningAge: b.returningAge ?? -1, behaviorWeight: b.behaviorWeight ?? 900, wanderAmount: b.wanderAmount ?? 0.3,
      respawnAgentsOnDeath: b.respawnAgentsOnDeath !== false, firstSpawnAtRandomPlaces: b.firstSpawnAtRandomPlaces !== false,
      tunnels: (b.splineTunnels ?? []).map(readTunnelGroup),
    };
  }
  if (b.type === "Inertia") return { ...common, maxRotationSpeed: b.maxRotationSpeed ?? 3.14, maxAcceleration: b.maxAcceleration ?? 60 };
  if (b.type === "DroneAvoidance") return { ...common, behaviorWeight: b.behaviorWeight ?? 300, visionRange: b.visionRange ?? 5, framesBetweenUpdates: b.framesBetweenUpdates ?? 3 };
  if (b.type === "SeekTarget") {
    // its own locator set (used where its name is locatorSetName), else the hull's set of that name
    const name = String(b.locatorSetName ?? "damage");
    locatorSetsUsed.add(name.trim());
    return {
      ...common, behaviorWeight: b.behaviorWeight ?? 1200, arrivedRadius: b.arrivedRadius ?? 10, distFromOrigin: b.distFromOrigin ?? 10,
      slowDownRadius: b.slowDownRadius ?? 33, firstSpawnAtRandomPlaces: b.firstSpawnAtRandomPlaces === true, locatorSetName: name.trim(),
      ownSet: b.locatorSet?.name != null ? String(b.locatorSet.name) : null,
      ownLocators: (b.locatorSet?.locators ?? []).map((l) => [...(l.position ?? [0, 0, 0]), ...(l.direction ?? l.rotation ?? [0, 0, 0, 1])]),
    };
  }
  if (b.type === "CollisionAvoidance") return { ...common, avoidanceScalar: b.avoidanceScalar ?? 12, volumes: (b.exclusionVolumes ?? []).filter((v) => v?.type === "EveEllipsoidVolume").map(readVolume) };
  if (b.type === "InclusionVolume") return { ...common, behaviorWeight: b.behaviorWeight ?? 60, volumes: (b.inclusionVolumes ?? []).filter((v) => v?.type === "EveEllipsoidVolume").map(readVolume) };
  if (b.type === "Wander") return { ...common, weightWander: b.weightWander ?? 240, rand1: b.rand1 ?? 0.2, rand2: b.rand2 ?? 0.8, rand3: b.rand3 ?? 1.2, freq: b.freq ?? 2 };
  if (b.type === "PlayFX") return { ...common, behaviorWeight: b.behaviorWeight ?? 20, sec: b.sec ?? 1, hasEffect: !!b.firingEffect, stretch: readStretch3(b.firingEffect) };
  return common;
}

/** A SplineTunnelGroup (its constructor's defaults): its curves (Tr2CurveVector3), sampled into tunnels by the page. */
function readTunnelGroup(t) {
  return {
    type: t?.tunnelGroupType ?? 2, breakPoints: t?.breakPoints ?? 2, width: t?.tunnelWidth ?? 15, pullSize: t?.entrancePullSize ?? 50,
    entrySize: t?.entrySize ?? 20, curves: (t?.curveSets ?? []).filter((c) => c?.type === "Tr2CurveVector3").map(curveData),
  };
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
    const areas = meshAreas(o.mesh, skipped);
    if (!areas.length) return null;
    return {
      k: "mesh", id: idOf(o), name: o.name ?? null, m: srt(o), ...parts(o), geometry: String(o.mesh.geometryResPath).toLowerCase(),
      meshIndex: o.mesh.meshIndex ?? 0, minScreenSize: o.minScreenSize ?? 0, areas,
      modifiers: (o.transformModifiers ?? []).map((t) => t.type), srt: srtOf(o.transformModifiers),
      // its lowestLodVisible (Tr2Lod: 0 low - always -, 1 medium, 2 high), where not low
      ...(o.lowestLodVisible ? { lod: o.lowestLodVisible } : {}),
    };
  }
  // EveChildBehaviorSystem (Children/EveChildBehaviorSystem.cpp, Behaviors/*): groups of agents, each drawn as the
  // group's mesh, instanced (behaviorAgents.ts). A group is drawn where the page runs all its behaviours: SpawnDrones
  // (count agents at the group's spawn position - BehaviorGroup::InitializeGeometryResource -> SetCount - or, addOnGrid,
  // SpawnDrones::UpdateGrid's grid, or more on a timer), ProcessLifetime (the spline tunnels: in, about, out), Inertia
  // DroneAvoidance, SeekTarget (to the hull's locators, which are written with the children), CollisionAvoidance,
  // InclusionVolume, Wander and PlayFX (its state only: the firing effects are not drawn).
  if (o.type === "EveChildBehaviorSystem") {
    const groups = [];
    for (const g of o.behaviorGroups ?? []) {
      const behaviors = (g?.behaviors ?? []).filter((b) => b && typeof b === "object");
      if (!behaviors.every((b) => AGENT_BEHAVIORS.has(b.type))) { skipped["BehaviorGroup:behaviors"] = (skipped["BehaviorGroup:behaviors"] ?? 0) + 1; continue; }
      if (g.mesh?.type !== "Tr2Mesh" || !g.mesh.geometryResPath) continue;
      const areas = meshAreas(g.mesh, skipped);
      if (!areas.length) continue;
      // SpawnDrones' defaults (its constructor): enabled, not on a grid, gridInfo (1, 1, 1, 10), gridSpacing 0, fullness 1
      const grid = behaviors.find((b) => b.enabled !== false && b.addOnGrid === true);
      groups.push({
        id: idOf(g), name: g.name ?? null, display: g.display !== false, count: g.count ?? 0, scale: g.scale ?? 1,
        spawnPosition: g.spawnPosition ?? [0, 0, 0], boundingSphereRadius: g.boundingSphereRadius ?? 5,
        renderThreshold: g.renderThreshold ?? 1, blendMin: g.blendScreenSizeMin ?? 5, blendMax: g.blendScreenSizeMax ?? 15,
        grid: grid ? { id: idOf(grid), info: grid.gridInfo ?? [1, 1, 1, 10], spacing: grid.gridSpacing ?? [0, 0, 0], fullness: grid.gridFullnessFactor ?? 1 } : null,
        maxVelocity: g.maxVelocity ?? 100, update: g.update !== false, behaviors: behaviors.map(readBehavior),
        // its booster (BehaviorGroupBooster: droneboostervolumetric.fx per agent), where shown and with an effect
        booster: g.boosters?.type === "BehaviorGroupBooster" && g.boosters.display !== false && g.boosters.boosterEffect ? {
          offset: g.boosters.boosterOffset ?? [0, 0, 0], atlas: [g.boosters.atlasIndex0 ?? 0, g.boosters.atlasIndex1 ?? 0],
          textures: effectTextures(g.boosters.boosterEffect), params: effectParams(g.boosters.boosterEffect),
          // its flares (FlareQuad.fx quads, where it has the effect) and lights (BehaviorGroupBooster's constructor defaults)
          halo: g.boosters.haloFlareEffect ? flareOf(g.boosters, "haloFlare") : null,
          ambient: g.boosters.ambientFlareEffect ? flareOf(g.boosters, "ambientFlare") : null,
          lightRadius: g.boosters.lightRadius ?? 3.5, lightColor: g.boosters.lightColor ?? [1, 1, 1, 1],
        } : null,
        mesh: { k: "mesh", name: g.name ?? null, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], geometry: String(g.mesh.geometryResPath).toLowerCase(), meshIndex: g.mesh.meshIndex ?? 0, minScreenSize: 0, areas, modifiers: [] },
      });
    }
    if (!groups.length) return null;
    return { k: "agents", id: idOf(o), name: o.name ?? null, m: srt(o), display: o.display !== false, groups, tunnels: (o.splineTunnels ?? []).map(readTunnelGroup) };
  }
  if (o.type === "EveChildLineSet" && o.lineSet) {
    const curves = (o.lines ?? []).filter((c) => c?.type === "EveBezierCurve" && c.display !== false).map((c) => ({
      m: srt(c), p1: c.point1 ?? [0, 0, 0], c: c.bezierPoint ?? [0, 0, 0], p2: c.point2 ?? [0, 0, 0],
      segments: c.segments ?? 24, width: c.lineWidth ?? 1,
    }));
    // its circles (EveCircle, LineSetPaths/EveCircle.cpp): GeneratePoints (once: movementSpeed moves only the mesh
    // objects) and AddLinesToSet's straight lines between them, each a one-piece curve through its midpoint
    for (const c of (o.lines ?? []).filter((x) => x?.type === "EveCircle" && x.display !== false)) curves.push(...circleLines(c));
    if (!curves.length) { skipped.EveChildLineSet = (skipped.EveChildLineSet ?? 0) + 1; return null; }
    return {
      k: "lines", id: idOf(o), name: o.name ?? null, m: srt(o), baseColor: o.baseColor ?? [1, 1, 1, 1], animColor: o.animColor ?? [0, 0, 0, 1],
      brightness: o.brightness ?? 1, additive: o.lineSet.additive === true || o.additiveBatches === true,
      widthFactor: o.lineSet.lineWidthFactor ?? 1, scrollSpeed: o.scrollSpeed ?? 0, effect: effectName(o.lineSet.lineEffect),
      textures: effectTextures(o.lineSet.lineEffect), curves,
    };
  }
  // EveChildEffectPropagator (Trinity's Eve/SpaceObject/Children/): its instance container's source copied to its
  // locators as its trigger method plays (propagator.ts): its locators (propagationType 0 its own, 1 a hull set, 2 a
  // random spread), trigger method (triggerMethood 0 sphere curve, 1 interval, 2 instant) and their settings, with
  // the class's defaults (EveChildEffectPropagator.cpp's constructor) and OnModified's clamps
  if (o.type === "EveChildEffectPropagator") {
    const type = o.propagationType ?? 0, trigger = o.triggerMethood ?? 0;
    const source = o.effect?.type === "EveChildInstanceContainer" ? readNode(o.effect.source, skipped) : null;
    if (!source) {
      skipped["EveChildEffectPropagator:no-source"] = (skipped["EveChildEffectPropagator:no-source"] ?? 0) + 1;
      return null;
    }
    // ProcessRefLocators: an empty name is "damage"
    const set = type === 1 ? String(o.locatorSetName || "damage").trim() : null;
    if (set) locatorSetsUsed.add(set);
    const m = srt(o);
    const lo = Math.max(0, o.randScaleMin ?? 1);
    return {
      k: "propagator", id: idOf(o), name: o.name ?? null, m: identity(m) ? null : m, type, trigger, locatorSet: set,
      local: type === 0 ? (o.localLocators?.locators?.items ?? []).map((l) => [...(l?.[0] ?? [0, 0, 0]), ...(l?.[1] ?? [0, 0, 0, 1])]) : null,
      numTriggers: Number(o.numTriggers ?? 10), range: o.range ?? 500, closeness: o.ClosenessPreference ?? 0.25, minRange: o.minRangeThreshold ?? 0,
      completeness: Math.min(1, Math.max(0, o.completeness ?? 1)), scaling: o.effectScaling ?? [1, 1, 1],
      randScale: [lo, Math.max(lo, o.randScaleMax ?? 1)], sphereOffset: o.triggerSphereOffset ?? [0, 0, 0],
      sphereCurve: o.triggerSphereRadiusCurve ? curveData(o.triggerSphereRadiusCurve) : null,
      skipCleanup: o.skipCleanup === true, stopToClearDelay: o.stopToClearDelay ?? 0, replayAfterDelay: o.replayAfterDelay === true,
      frequency: o.frequency ?? 1, duration: o.durationPerEffect ?? 3, stopAfter: o.stopAfterNumTriggers ?? -1, source,
    };
  }
  // EveChildProceduralContainer (ProceduralContainer/): one of its children shown at a time, chosen by its selection
  // method; read where that is EveProceduralMethodCycling (every one the SOF hulls' children have): each parameter's
  // EveChildRef file read as a child effect, its playDuration (1 unless said) and restartRequired (true unless said)
  if (o.type === "EveChildProceduralContainer") {
    const sm = o.selectionMethod;
    const items = sm?.type === "EveProceduralMethodCycling"
      ? (sm.parameters ?? []).filter((p) => p?.child?.resPath).map((p) => ({ effect: readChildEffect(String(p.child.resPath), skipped), duration: p.playDuration ?? 1, restart: p.restartRequired !== false }))
      : [];
    if (!items.length) {
      const k = `EveChildProceduralContainer:${sm?.type ?? "none"}`;
      skipped[k] = (skipped[k] ?? 0) + 1;
      return null;
    }
    const m = srt(o);
    return {
      k: "procedural", id: idOf(o), name: o.name ?? null, m: identity(m) ? null : m, display: o.display !== false,
      modifiers: (o.transformModifiers ?? []).map((t) => t.type), srt: srtOf(o.transformModifiers),
      startOffset: sm.startTimeOffset ?? 0, randomize: sm.randomizeOrder === true, items,
    };
  }
  if (o.type === "EveChildContainer") {
    if (!HIGH_QUALITY.has(o.displayFilter ?? 5)) return null;
    const objects = (o.objects ?? []).map((c) => readNode(c, skipped)).filter(Boolean);
    // its lights (in the container's space): point, spot and faction lights (readLight)
    const lights = [];
    for (const l of o.lights ?? []) {
      const light = readLight(l);
      if (light) lights.push(light);
      else skipped[l?.type ?? "?"] = (skipped[l?.type ?? "?"] ?? 0) + 1;
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
 * A child's light (Lights/Tr2Light.cpp, its defaults the constructor's: colour (0, 0, 0, 1), brightness 1, radius 0):
 * a Tr2PointLight, a Tr2SpotLight (rotation, innerAngle and outerAngle in degrees) or a Tr2FactionLight - a point or
 * (isSpotlight) spot light whose colour is the faction's colour set at factionColor (SOFDataFactionColorChooser's
 * order: COLOR_TYPES), Saturate'd by saturation (toward its intensity 0.299 r + 0.587 g + 0.114 b). Its innerRadius is
 * the source radius. Null for another type.
 */
function readLight(l) {
  if (!l || !["Tr2PointLight", "Tr2SpotLight", "Tr2FactionLight"].includes(l.type)) return null;
  let color = l.color ?? [0, 0, 0, 1];
  if (l.type === "Tr2FactionLight") {
    const name = COLOR_TYPES[l.factionColor ?? -1];
    if (name && readFaction) {
      const c = colorOf(readFaction.colorSet ?? null, name), s = l.saturation ?? 1;
      const i = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
      color = s === 1 ? c : [0, 1, 2].map((k) => i + (c[k] - i) * Math.max(0, s)).concat([c[3] ?? 1]);
    }
  }
  const spot = l.type === "Tr2SpotLight" || (l.type === "Tr2FactionLight" && l.isSpotlight === true);
  return {
    // its id: a curve set's binding may drive its brightness, colour or radius
    id: idOf(l), position: l.position ?? [0, 0, 0], radius: l.radius ?? 0, innerRadius: l.innerRadius ?? 0, color, brightness: l.brightness ?? 1,
    ...(spot ? { rotation: l.rotation ?? [0, 0, 0, 1], innerAngle: l.innerAngle ?? 0, outerAngle: l.outerAngle ?? 0 } : {}),
  };
}

/**
 * An EveCircle's straight lines (EveCircle.cpp, its defaults from the constructor and OnModified's clamps): seg points
 * (numSegments + 0.5, or that x (1 - |completeness - 1|) where scaleSegmentsByCompleteness) around the arc of
 * (1 - |completeness - 1|) x 2 pi from startPoint x 2 pi + max(completeness - 1, 0) x 2 pi + half a piece, at
 * (cos, distorted y, sin) x circleRadius; a line from each point to the next, the closing one left out where
 * completeness is not 1. Each as a one-piece curve (its control point the middle: a straight line).
 */
function circleLines(c) {
  const segments = Math.min(Math.max(1, c.numSegments ?? 64), 128);
  const completeness = Math.min(2, Math.max(0, c.completeness ?? 1));
  const startPoint = (c.startPoint ?? 0) % 1;
  const radius = c.circleRadius ?? 100;
  const distort = c.circleDistort ?? [1, 0, 1, 0];
  const anim = c.animValue ?? 0;
  const seg = c.scaleSegmentsByCompleteness === true ? Math.trunc((segments + 0.5) * (1 - Math.abs(completeness - 1))) : Math.trunc(segments + 0.5);
  if (seg <= 1) return [];
  const arc = (1 - Math.abs(completeness - 1)) * Math.PI * 2;
  const start = startPoint * Math.PI * 2 + Math.max(completeness - 1, 0) * Math.PI * 2 + arc / (2 * seg);
  const points = [];
  for (let i = 0; i < seg; i++) {
    const at = start + arc * (i / seg + anim / seg);
    let y = 0;
    if (distort[1] !== 0 || distort[3] !== 0) {
      const d1 = Math.sin(at) < 0 ? distort[0] : distort[2], d2 = Math.cos(at) < 0 ? distort[3] : distort[1];
      y = Math.sin(at) ** 2 * radius * d1 + Math.cos(at) ** 2 * radius * d2;
    }
    points.push([Math.cos(at) * radius, y, Math.sin(at) * radius]);
  }
  const m = srt(c), width = c.lineWidth ?? 1, out = [];
  for (let i = 0; i < seg; i++) {
    const next = (i + 1) % seg;
    if (completeness !== 1 && next === 0) continue;
    const p1 = points[i], p2 = points[next];
    out.push({ m, p1, c: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2], p2, segments: 1, width });
  }
  return out;
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
    // (the GPU emitters are the child's GPU node's: not skipped)
    if (e?.type === "Tr2GpuUniqueEmitter" || e?.type === "Tr2GpuSharedEmitter") continue;
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
  readFaction = faction;
  ids = new WeakMap();
  nextId = 1;
  effectRoots = new Map();
  rawEffects = new Map();
  rawHullChildren = [];
  rawHullControllers = [];
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
      if (o && typeof o === "object") rawHullChildren.push(o);
      root = readNode(o, skipped);
      // EveSOF: a hull child's Setup(..., the entry's lowestLodVisible) - a child mesh's own lodding replaced by the
      // entry's (EveChildMesh::Setup; a container's Setup keeps none of it)
      if (root?.k === "mesh") {
        if (child.lowestLodVisible) root.lod = child.lowestLodVisible;
        else delete root.lod;
      }
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
/**
 * An EveMultiEffect's own bindings (Tr2DynamicBinding: each end a path from the effect - a curve set's curve,
 * `Name.curves["curve"]`, or a parameter's object, `PostProcess.fade`), made curve-set bindings where they can be:
 * a curve to a curve of its sets (an expression's input) joins the source's set; a curve to the PostProcess
 * parameter's attribute becomes a "PostProcessOutput" binding, its destinationAttribute the path ("fade.intensity"),
 * for the page to draw. One from a parameter's inherited properties (`Hangar.inheritProperties`, its attribute a
 * colour of the object's faction colour set: PrimaryLight) into a curve of a child effect the parameter's object holds
 * (`ship.effectChildren["docker_lightRig"].curveSets["play_start"].curves["colorMixer"]`) is answered as an external
 * binding for the page to apply where both are bound. The rest are counted skipped.
 */
function joinDynamicBindings(o, skipped) {
  const external = [];
  const sets = (o.curveSets ?? []).filter((cs) => cs?.type === "TriCurveSet");
  const curveAt = (path) => {
    const m = /^([^.]+)\.curves\["(.+)"\]$/.exec(String(path ?? ""));
    if (!m) return null;
    const set = sets.find((cs) => cs.name === m[1]);
    const curve = set?.curves?.find((c) => c?.name === m[2]);
    return set && curve ? { set, curve } : null;
  };
  for (const b of o.bindings ?? []) {
    if (b?.type !== "Tr2DynamicBinding") continue;
    const src = curveAt(b.sourceObjectPath);
    const dst = curveAt(b.destinationObjectPath);
    const post = /^PostProcess\.(.+)$/.exec(String(b.destinationObjectPath ?? ""));
    if (src && (dst || post)) {
      (src.set.bindings ??= []).push({
        type: "TriValueBinding", name: b.name, sourceObject: src.curve, sourceAttribute: b.sourceObjectAttribute ?? "currentValue",
        destinationObject: dst ? dst.curve : { type: "PostProcessOutput", name: post[1] },
        destinationAttribute: dst ? b.destinationObjectAttribute ?? "" : `${post[1]}.${b.destinationObjectAttribute ?? ""}`,
        scale: 1, offset: [0, 0, 0, 0],
      });
      continue;
    }
    const inherit = /^([^.]+)\.inheritProperties$/.exec(String(b.sourceObjectPath ?? ""));
    const child = /^([^.]+)\.effectChildren\["(.+?)"\]\.curveSets\["(.+?)"\]\.curves\["(.+?)"\]$/.exec(String(b.destinationObjectPath ?? ""));
    if (inherit && child) {
      external.push({
        name: b.name ?? null, from: inherit[1], inherit: String(b.sourceObjectAttribute ?? ""),
        owner: child[1], child: child[2], set: child[3], curve: child[4], attribute: String(b.destinationObjectAttribute ?? ""),
      });
      continue;
    }
    const key = `Tr2DynamicBinding:${String(b.destinationObjectPath ?? "?").split(/[.[]/)[0]}`;
    skipped[key] = (skipped[key] ?? 0) + 1;
  }
  return external;
}

export function readEffectFile(rf, path) {
  const res = String(path).toLowerCase().replace(/\.red$/, ".black");
  if (!rf.has(res)) return null;
  ids = new WeakMap();
  nextId = 1;
  effectRoots = new Map();
  rawEffects = new Map();
  locatorSetsUsed = new Set();
  readRf = rf;
  const skipped = {};
  let root = null, o = null, external = [];
  try {
    o = readBlack(rf.read(res), res);
    shownBySet = findShownBySet(o);
    actionEmitters = findActionEmitters(o);
    if (o && typeof o === "object") external = joinDynamicBindings(o, skipped);
    // (a file whose root is an EveTransform - a ShipEffect's graphic: the web's - is that transform as a container)
    root = o?.type === "EveTransform" ? readNode(transformAsChild(o, skipped), skipped)
      : o && typeof o === "object" ? readNode({ ...o, type: "EveChildContainer", objects: o.effectChildren ?? [] }, skipped) : null;
  } catch (e) {
    skipped.unread = String(e.message ?? e);
  }
  return { res, root, skipped, external, childEffects: childEffectRoots(), duration: o?.duration ?? -1, boundingSphereRadius: o?.boundingSphereRadius ?? 0,
    firstSet: firstSetOf(o) };
}

/**
 * The root's first curve set (what a ShipEffect plays: gfx.curveSets[0]) by its name, with TriCurveSet::
 * GetMaxCurveDuration - the longest of its curves' lengths, each its last key's time (Tr2CurveScalar::Length).
 */
function firstSetOf(o) {
  const set = o?.curveSets?.[0];
  if (!set) return null;
  const lastTime = (c) => {
    const k = c?.keys;
    if (k && Array.isArray(k.items) && Array.isArray(k.structure)) {
      const at = Math.max(0, k.structure.findIndex((f) => f?.[0] === "time"));
      const last = k.items[k.items.length - 1];
      return Array.isArray(last) && typeof last[at] === "number" ? last[at] : 0;
    }
    if (Array.isArray(k)) { const last = k[k.length - 1]; return typeof last?.time === "number" ? last.time : 0; }
    return typeof c?.length === "number" ? c.length : 0;
  };
  return { name: set.name ?? null, length: Math.max(0, ...(set.curves ?? []).map(lastTime)) };
}

/**
 * A turret's firing effect file (an EveTurretFiringFX), or a file that is one EveStretch3, read for its EveStretch3s: each stretch, by its index, as
 * readStretch3 reads it (its parts' graph, ids, destObjectScale), null for another kind; with the child effects its
 * controllers load. Null where the client has no such file.
 */
export function readTurretStretch3(rf, path) {
  const res = String(path).toLowerCase().replace(/\.red$/, ".black");
  if (!rf.has(res)) return null;
  ids = new WeakMap();
  nextId = 1;
  effectRoots = new Map();
  rawEffects = new Map();
  locatorSetsUsed = new Set();
  readRf = rf;
  const o = readBlack(rf.read(res), res);
  const find = (n) => { if (!n || typeof n !== "object") return null; if (n.type === "EveTurretFiringFX") return n; for (const v of Object.values(n)) { const r = find(v); if (r) return r; } return null; };
  const fx = find(o);
  shownBySet = findShownBySet(fx ?? o);
  actionEmitters = findActionEmitters(fx ?? o);
  // a file that is one EveStretch3 or EveStretch (an effect's own graphic: the Vorton projectors' chain, a warp
  // scrambler's or a neutraliser's LocatorStretchEffect) is its one stretch; each read keeps its type
  const list = fx ? fx.stretch ?? [] : o?.type === "EveStretch3" || o?.type === "EveStretch" ? [o] : [];
  const stretches = list.map((s) => {
    const r = s?.type === "EveStretch3" ? readStretch3(s) : s?.type === "EveStretch" ? readEveStretch(s) : null;
    return r ? { type: s.type, ...r } : null;
  });
  return { res, stretches, childEffects: childEffectRoots() };
}

/**
 * The hull's own controllers (EveSOFDataHull.controllers: each a Tr2Controller's file, res:/dx9/model/controller/
 * shipstandard.red and the like), read as a child's are, their owner the space object itself. Read after
 * readHullChildren, whose ids they continue. A file the client does not ship, or not a controller, is left out.
 */
export function readHullControllers(rf, sofHull) {
  overlayPaths = new Set();
  const out = [];
  const skipped = {};
  // all read first: one may set another's variables (Owner.controllers["name"])
  const read = [];
  for (const c of sofHull?.controllers ?? []) {
    const res = String(c?.path ?? "").toLowerCase().replace(/\.red$/, ".black");
    if (!res || !rf.has(res)) continue;
    try {
      const o = readBlack(rf.read(res), res);
      if (o?.type === "Tr2Controller") read.push([res, o]);
    } catch {
      // an unreadable controller file draws nothing
    }
  }
  rawHullControllers = read.map(([, o]) => o);
  for (const [res, o] of read) out.push({ path: res, ...readController(o, skipped, null) });
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

/**
 * The overlays the hull's controllers name (EveMeshOverlayEffect: extra draws of the hull's mesh, EmitOverlayBatches -
 * the opaque effects over its opaque areas, the others over its opaque, transparent and decal areas): by path, each
 * pass's effects - the shader's file name, its parameters (constParameters / Tr2*Parameter values) and textures (res:
 * paths, copied by the caller). Read after readHullControllers. A file not shipped is null.
 */
export function hullOverlays(rf) {
  const out = {};
  for (const res of overlayPaths) {
    if (!rf.has(res)) { out[res] = null; continue; }
    try {
      const o = readBlack(rf.read(res), res);
      const effect = (e) => ({
        name: e?.name ?? null,
        shader: String(e?.effectFilePath ?? "").split("/").pop().replace(/\.fx$/i, "").toLowerCase(),
        params: { ...Object.fromEntries((e?.constParameters?.items ?? []).filter((p) => Array.isArray(p) && p[0]).map(([k, v]) => [k, v])),
          ...Object.fromEntries((e?.parameters ?? []).filter((p) => p?.name && p.value !== undefined).map((p) => [p.name, p.value])) },
        textures: Object.fromEntries((e?.resources ?? []).filter((r) => r?.name && r.resourcePath).map((r) => [r.name, String(r.resourcePath).toLowerCase()])),
      });
      const pass = (k) => (o?.[k] ?? []).filter((e) => e?.effectFilePath).map(effect);
      out[res] = { name: o?.name ?? null, opaque: pass("opaqueEffects"), transparent: pass("transparentEffects"), additive: pass("additiveEffects"),
        decal: pass("decalEffects"), distortion: pass("distortionEffects") };
    } catch {
      out[res] = null;
    }
  }
  return out;
}
