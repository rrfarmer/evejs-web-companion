// A planet, moon or sun as the client builds it (EvePlanet, EveSun and the effects their .red/.black object
// files name): every texture parameter (TriTextureParameter: name, resourcePath) and every constant shader
// parameter (Tr2Effect.constParameters items: name, value), with the effect files that use them. The client's
// planet shaders are procedural and compiled; the play page draws a likeness from these.

import { readBlack } from "./black.mjs";

/**
 * { effects: [path], textures: { name: res }, params: { name: [x, y, z, w] }, geometry: res } of an object file; the
 * geometry is the first mesh's (Tr2Mesh.geometryResPath: the planets' PlanetSphere.gr2, whose second UV set is the
 * polar projection the planet shaders blend in at the poles).
 */
export function readCelestial(rf, graphicFile) {
  const res = graphicFile.replace(/\.red$/i, ".black");
  const obj = readBlack(rf.read(res), res);
  const effects = [], textures = {}, params = {};
  let geometry = null;
  const walk = (x) => {
    if (!x || typeof x !== "object" || x instanceof Uint8Array) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.type === "TriTextureParameter" && x.name && x.resourcePath && !(x.name in textures)) textures[x.name] = x.resourcePath;
    if (x.effectFilePath) effects.push(x.effectFilePath);
    if (!geometry && typeof x.geometryResPath === "string" && x.geometryResPath) geometry = x.geometryResPath.toLowerCase();
    if (x.constParameters?.items) for (const [name, value] of x.constParameters.items) if (!(name in params)) params[name] = value;
    for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
  };
  walk(obj);
  return { type: obj.type, effects: [...new Set(effects)], textures, params, geometry };
}
