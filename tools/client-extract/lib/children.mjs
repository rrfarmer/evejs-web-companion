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
//   with ubershader.fx or fx3dv5.fx (kind, index, count, the effect's options, constants and textures); its other
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
  const out = typeof c.type === "string" && c.type.startsWith("Tr2Curve") ? { id: idOf(c) } : {};
  for (const [k, v] of Object.entries(c)) {
    if (k === "keys" && v && Array.isArray(v.items)) out.keys = v.items;
    else if (v && typeof v === "object") out[k] = curveData(v);
    else out[k] = v;
  }
  return out;
}

/**
 * A curve set that plays on load (TriCurveSet: playOnLoad, true unless said; the others wait for a controller's state
 * machine): its scale, its curves, and the bindings whose source is one of its curves (or any curve), each naming its
 * destination by id.
 */
function readCurveSet(cs) {
  const curves = (cs.curves ?? []).filter((c) => typeof c?.type === "string" && c.type.startsWith("Tr2Curve"));
  const index = new Map(curves.map((c, i) => [c, i]));
  const bindings = [];
  for (const b of cs.bindings ?? []) {
    const src = b?.sourceObject, dst = b?.destinationObject;
    if (!src || !dst || typeof src.type !== "string" || !src.type.startsWith("Tr2Curve")) continue;
    bindings.push({
      // a binding may be another's destination (its scale)
      id: idOf(b), source: index.has(src) ? index.get(src) : null, sourceCurve: index.has(src) ? null : curveData(src),
      sourceAttribute: b.sourceAttribute ?? "currentValue", destination: idOf(dst), destinationType: dst.type ?? null,
      destinationAttribute: b.destinationAttribute ?? "", scale: b.scale ?? 1, offset: b.offset ?? [0, 0, 0, 0],
    });
  }
  return { name: cs.name ?? null, scale: cs.scale ?? 1, curves: curves.map(curveData), bindings };
}

// The objects whose display a curve set that plays on load drives (in the file being read): one hidden in the file
// (display false) is read all the same, marked display false, for the set to show.
let shownBySet = new Set();
function findShownBySet(root) {
  const out = new Set(), seen = new Set();
  const walk = (o) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (o.type === "TriCurveSet" && o.playOnLoad !== false) {
      for (const b of o.bindings ?? []) if (b?.destinationObject && String(b.destinationAttribute ?? "").split(".")[0] === "display") out.add(b.destinationObject);
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
  if (o.type === "EveChildMesh" && o.mesh?.type === "Tr2Mesh" && o.mesh.geometryResPath) {
    const areas = [];
    for (const [list, kind] of [["opaqueAreas", "opaque"], ["transparentAreas", "transparent"], ["additiveAreas", "additive"]]) {
      for (const a of o.mesh[list] ?? []) {
        const fx = effectName(a.effect);
        if (fx !== "ubershader" && fx !== "fx3dv5") { skipped[`area:${fx}`] = (skipped[`area:${fx}`] ?? 0) + 1; continue; }
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
    const curveSets = (o.curveSets ?? []).filter((cs) => cs?.playOnLoad !== false).map(readCurveSet);
    const waiting = (o.curveSets ?? []).length - curveSets.length;
    if (waiting) skipped.TriCurveSet = (skipped.TriCurveSet ?? 0) + waiting;
    if (o.controllers?.length) skipped.Tr2Controller = (skipped.Tr2Controller ?? 0) + o.controllers.length;
    if (!objects.length && !lights.length && !curveSets.length) return null;
    const m = srt(o);
    return {
      k: "container", id: idOf(o), name: o.name ?? null, m: identity(m) ? null : m, ...parts(o), curveSets,
      modifiers: (o.transformModifiers ?? []).map((t) => t.type), srt: srtOf(o.transformModifiers),
      objects,
      lights,
    };
  }
  skipped[o.type ?? "?"] = (skipped[o.type ?? "?"] ?? 0) + 1;
  return null;
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
      root = readNode(o, skipped);
    } catch (e) {
      skipped.unread = String(e.message ?? e);
    }
    out.push({ res, root, skipped });
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
