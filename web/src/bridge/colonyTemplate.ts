import type { Colony } from "../store/types.ts";
import type { PiRecipeBook } from "./piRecipes.ts";
import type { JsonValue } from "./wire.ts";

// 3698585 planetConst.PLANET_TYPE_TO_PIN. Columns are basic, advanced, high-tech,
// command centre, storage, spaceport and extractor control unit.
const PIN_TYPES: Readonly<Record<number, readonly number[]>> = {
  11: [2481, 2480, 2482, 2254, 2562, 2256, 3068],
  12: [2493, 2491, 0, 2533, 2257, 2552, 3061],
  13: [2492, 2494, 0, 2534, 2536, 2543, 3060],
  2014: [2490, 2485, 0, 2525, 2535, 2542, 3063],
  2015: [2469, 2470, 0, 2549, 2558, 2555, 3062],
  2016: [2473, 2474, 2475, 2524, 2541, 2544, 2848],
  2017: [2483, 2484, 0, 2550, 2561, 2557, 3067],
  2063: [2471, 2472, 0, 2551, 2560, 2556, 3064],
};
const PIN_COLUMN = new Map(Object.values(PIN_TYPES).flatMap(types => types.flatMap((id, column) => id ? [[id, column] as const] : [])));
const COMMAND = 3;
const EXTRACTOR = 6;
const COMMAND_ENDPOINT = "CmdCtr";
const TAU = Math.PI * 2;
// planetStaticData's cumulative build costs for the native command-centre levels.
const UPGRADE_COST = [0, 580000, 1510000, 2710000, 4210000, 6310000] as const;

type Endpoint = number | typeof COMMAND_ENDPOINT;
interface TemplatePin {
  readonly typeID: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly product: number | null;
  readonly heads: number;
}
interface TemplateLink { readonly from: Endpoint; readonly to: Endpoint; readonly level: number }
interface TemplateRoute { readonly path: readonly Endpoint[]; readonly typeID: number; readonly quantity: number }
export interface ColonyTemplate {
  readonly planetTypeID: number;
  readonly diameter: number;
  readonly level: number;
  readonly comment: string;
  readonly pins: readonly TemplatePin[];
  readonly links: readonly TemplateLink[];
  readonly routes: readonly TemplateRoute[];
}

function invalid(field: string): never {
  throw new Error(`The planetary template could not be verified. Check ${field}.`);
}
function record(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(name);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || !fields.every(field => Object.hasOwn(row, field))) invalid(name);
  return row;
}
function integer(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(label);
  return value;
}
function real(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) invalid(name);
  return value;
}
function rows(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(label);
  return value;
}
function endpoint(value: unknown): Endpoint {
  return value === COMMAND_ENDPOINT ? value : integer(value, "pin references", 1);
}

/** Native clipboard JSON and the game's packed base64 colonytemplate link. */
export function readColonyTemplate(source: string): ColonyTemplate {
  let text = source.trim();
  let value: unknown;
  try {
    if (text.startsWith("colonytemplate:")) {
      let packed = "";
      for (let index = "colonytemplate:".length; index < text.length; index++) {
        const pair = text.charCodeAt(index);
        packed += String.fromCharCode(pair >> 8, pair & 255);
      }
      text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(packed.replace(/\0+$/, "")), c => c.charCodeAt(0)));
    }
    value = JSON.parse(text);
  } catch {
    throw new Error("The clipboard or file does not contain a readable planetary template.");
  }
  const root = record(value, ["Pln", "Diam", "CmdCtrLv", "Cmt", "P", "L", "R"], "the template fields");
  const planetTypeID = integer(root.Pln, "the planet type", 1);
  if (!PIN_TYPES[planetTypeID] || typeof root.Cmt !== "string") invalid("the planet type and description");
  const pins = rows(root.P, "installations").map((pin, i): TemplatePin => {
    const row = record(pin, ["T", "La", "Lo", "S", "H"], `installation ${i + 1}`);
    return { typeID: integer(row.T, "installation type", 1), latitude: real(row.La, "latitude", 0, Math.PI),
      longitude: real(row.Lo, "longitude", 0, TAU), product: row.S === null ? null : integer(row.S, "product type", 1),
      heads: integer(row.H, "the extractor head count", 0) };
  });
  if (pins.length === 0 || pins.filter(pin => PIN_COLUMN.get(pin.typeID) === COMMAND).length > 1) invalid("the installation list");
  const links = rows(root.L, "links").map((link): TemplateLink => {
    const row = record(link, ["S", "D", "Lv"], "link fields");
    return { from: endpoint(row.S), to: endpoint(row.D), level: integer(row.Lv, "link level", 0, 10) };
  });
  const routes = rows(root.R, "routes").map((route): TemplateRoute => {
    const row = record(route, ["P", "T", "Q"], "route fields");
    const path = rows(row.P, "route path").map(endpoint);
    if (path.length < 2) invalid("route endpoints");
    return { path, typeID: integer(row.T, "route commodity", 1), quantity: integer(row.Q, "route quantity", 1) };
  });
  return { planetTypeID, diameter: real(root.Diam, "planet diameter", Number.MIN_VALUE, Number.MAX_VALUE),
    level: integer(root.CmdCtrLv, "command centre level", 0, 5), comment: root.Cmt, pins, links, routes };
}

/** Python's verifier distinguishes a floating-point value in the JSON from an integer. */
export function writeColonyTemplate(template: ColonyTemplate): string {
  const float = (value: number) => Number.isInteger(value) && !String(value).includes("e") ? `${value}.0` : String(value);
  const header = JSON.stringify({ Pln: template.planetTypeID, CmdCtrLv: template.level, Cmt: template.comment }).slice(0, -1);
  const pins = template.pins.map(pin =>
    `{"T":${pin.typeID},"La":${float(pin.latitude)},"Lo":${float(pin.longitude)},"S":${pin.product},"H":${pin.heads}}`);
  const links = template.links.map(link => ({ S: link.from, D: link.to, Lv: link.level }));
  const routes = template.routes.map(route => ({ P: route.path, T: route.typeID, Q: route.quantity }));
  return `${header},"Diam":${float(template.diameter)},"P":[${pins.join(",")}],"L":${JSON.stringify(links)},"R":${JSON.stringify(routes)}}`
    .replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function colonyTemplateLink(template: ColonyTemplate): string {
  const base = btoa(writeColonyTemplate(template));
  let packed = "colonytemplate:";
  for (let i = 0; i < base.length; i += 2) {
    packed += String.fromCharCode(base.charCodeAt(i) * 256 + (i + 1 < base.length ? base.charCodeAt(i + 1) : 0));
  }
  return packed;
}

/** Tranquility's export omits the command centre and refuses a colony linked to it. */
export function exportColonyTemplate(colony: Colony, recipes: PiRecipeBook, description: string): ColonyTemplate {
  const { radius } = colony;
  if (!radius) throw new Error("The planet's diameter is unavailable.");
  const centre = colony.pins.find(pin => pin.kind === "command");
  if (!centre) throw new Error("An established command centre is required to export a planetary template.");
  if (colony.links.some(link => link.endpoint1 === centre.pinID || link.endpoint2 === centre.pinID)) {
    throw new Error("A colony with links to its command centre cannot be exported.");
  }
  const endpoints = new Map<number, number>();
  const roundCoordinate = (coordinate: number) => Math.round(coordinate * 100000) / 100000;
  const pins = colony.pins.filter(pin => pin.kind !== "command").map((pin, i): TemplatePin => {
    endpoints.set(pin.pinID, i + 1);
    if (pin.latitude == null || pin.longitude == null) throw new Error("An installation's location is unavailable.");
    const recipe = pin.schematicID == null ? null : recipes.bySchematicID.get(pin.schematicID);
    if (pin.schematicID != null && !recipe) throw new Error("An installation's recipe is unavailable.");
    return { typeID: pin.typeID, latitude: roundCoordinate(pin.latitude),
      longitude: roundCoordinate(pin.longitude) % TAU, product: recipe?.output.typeID ?? pin.program?.resourceTypeID ?? null,
      heads: pin.program?.headCount ?? 0 };
  });
  if (!pins.length) throw new Error("Build an installation before exporting this colony.");
  const endpointOf = (id: number) => {
    const index = endpoints.get(id);
    if (index === undefined) throw new Error("A connection refers to an unavailable installation.");
    return index;
  };
  return { planetTypeID: colony.planetTypeID, diameter: radius * 2 / 1000, level: colony.commandCenterLevel,
    comment: description.replace(/<[^>]*>/g, "").trim(), pins,
    links: colony.links.map(link => ({ from: endpointOf(link.endpoint1), to: endpointOf(link.endpoint2), level: link.level })),
    routes: colony.routes.map(route => ({ path: route.path.map(endpointOf), typeID: route.commodityTypeID, quantity: route.commodityQuantity })) };
}

export type TemplateRotation = readonly [number, number, number];
type SurfacePosition = readonly [latitude: number, longitude: number];
function surfaceVector([latitude, longitude]: SurfacePosition): readonly [number, number, number] {
  return [Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), Math.sin(latitude) * Math.sin(longitude)];
}

/** TemplatePreviewWindow compresses towards the first pin, closest pins first. */
export function compressColonyTemplate(template: ColonyTemplate): ColonyTemplate {
  const [first, ...rest] = template.pins;
  if (!first || rest.length === 0) return template;
  const anchor: SurfacePosition = [first.latitude, first.longitude];
  const centre = surfaceVector(anchor);
  const distanceDot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const minDistance = 0.012;
  const threshold = Math.cos(minDistance);
  const step = minDistance * 0.01;
  const positions = rest.map((pin, i) => {
    const original: SurfacePosition = [pin.latitude, pin.longitude];
    const position: SurfacePosition = [2 * pin.latitude - anchor[0], 2 * pin.longitude - anchor[1]];
    return { index: i + 1, position, order: distanceDot(centre, surfaceVector(original)), vector: surfaceVector(position) };
  }).sort((a, b) => b.order - a.order);
  let unchanged = 0;
  for (let iteration = 0; iteration < 10000 && unchanged <= 20; iteration++) {
    let moved = false;
    for (const point of positions) {
      const [latitude, longitude] = point.position;
      const latDelta = anchor[0] - latitude, lonDelta = anchor[1] - longitude;
      const distance = Math.hypot(latDelta, lonDelta);
      if (distance === 0) continue;
      const position: SurfacePosition = [latitude + step * latDelta / distance, longitude + step * lonDelta / distance];
      const vector = surfaceVector(position);
      if (distanceDot(vector, centre) > threshold ||
        positions.some(other => other !== point && distanceDot(vector, other.vector) > threshold)) continue;
      point.position = position;
      point.vector = vector;
      moved = true;
    }
    unchanged = moved ? 1 : unchanged + 1;
  }
  const pins = [...template.pins];
  for (const { index, position: [latitude, longitude] } of positions) {
    pins[index] = { ...pins[index]!, latitude, longitude };
  }
  return { ...template, pins };
}

function rotatedPoint(latitude: number, longitude: number, rotation: TemplateRotation): readonly [number, number] {
  const [a, b, c] = rotation.map(degrees => degrees * Math.PI / 180) as [number, number, number];
  const [x, y, z] = surfaceVector([latitude, longitude]);
  // SurfacePoint.GetRotatedSurfacePoint applies Z, then X, then Y.
  const x1 = x * Math.cos(c) - y * Math.sin(c), y1 = x * Math.sin(c) + y * Math.cos(c);
  const y2 = y1 * Math.cos(a) - z * Math.sin(a), z2 = y1 * Math.sin(a) + z * Math.cos(a);
  return [Math.acos(Math.max(-1, Math.min(1, y2))),
    (Math.atan2(z2 * Math.cos(b) - x1 * Math.sin(b), x1 * Math.cos(b) + z2 * Math.sin(b)) + TAU) % TAU];
}

export interface TemplatePlacement {
  readonly pins: readonly (TemplatePin & { readonly index: Endpoint; readonly existing: boolean })[];
  readonly links: readonly TemplateLink[];
  readonly routes: number;
  readonly skipped: readonly TemplateRoute[];
  readonly requestedLevel: number;
  readonly upgradeCost: number;
  readonly changes: readonly JsonValue[];
}
type PinID = number | readonly [1, number];

/** Build one native submission against a command centre the pilot already owns. */
export function planColonyTemplate(template: ColonyTemplate, colony: Colony, recipes: PiRecipeBook, rotation: TemplateRotation): TemplatePlacement {
  const centre = colony.pins.find(pin => pin.kind === "command");
  if (!centre) throw new Error("An established command centre is required to load a planetary template.");
  const types = PIN_TYPES[colony.planetTypeID];
  if (!types) throw new Error("This planet cannot accept a planetary template.");
  const changes: JsonValue[] = [];
  const level = Math.max(colony.commandCenterLevel, template.level);
  const upgradeCost = UPGRADE_COST[level]! - UPGRADE_COST[colony.commandCenterLevel]!;
  if (level > colony.commandCenterLevel) changes.push([9, [centre.pinID, level]]);
  const ids = new Map<Endpoint, PinID>([[COMMAND_ENDPOINT, centre.pinID]]);
  const columnByIndex = new Map<Endpoint, number>();
  let next = 1;
  const pins: TemplatePlacement["pins"][number][] = [];
  for (const source of template.pins) {
    const column = PIN_COLUMN.get(source.typeID);
    const typeID = column === undefined ? 0 : types[column];
    if (!typeID || column === undefined) throw new Error(`This planet has no corresponding installation for type ${source.typeID}.`);
    const [latitude, longitude] = rotatedPoint(source.latitude, source.longitude, rotation);
    const index = column === COMMAND ? COMMAND_ENDPOINT : next++;
    pins.push({ ...source, index, typeID, latitude: column === COMMAND ? centre.latitude ?? latitude : latitude,
      longitude: column === COMMAND ? centre.longitude ?? longitude : longitude, existing: column === COMMAND });
    if (column === COMMAND) continue;
    const id = [1, index as number] as const;
    columnByIndex.set(index, column);
    ids.set(index, id);
    changes.push([1, [id, typeID, latitude, longitude]]);
    if (column < COMMAND && source.product !== null) {
      const recipe = recipes.byOutputTypeID.get(source.product);
      if (!recipe?.factoryTypeIDs.includes(typeID)) throw new Error(`The selected installation cannot make product ${source.product}.`);
      changes.push([8, [id, recipe.schematicID]]);
    }
  }
  if (!pins.some(pin => pin.existing) && centre.latitude != null && centre.longitude != null) {
    pins.push({ index: COMMAND_ENDPOINT, typeID: centre.typeID, latitude: centre.latitude, longitude: centre.longitude, product: null, heads: 0, existing: true });
  }
  const neighbors = new Map<Endpoint, Set<Endpoint>>();
  for (const link of template.links) {
    const from = ids.get(link.from), to = ids.get(link.to);
    if (from === undefined || to === undefined || from === to || neighbors.get(link.from)?.has(link.to)) invalid("link endpoints");
    if (!neighbors.has(link.from)) neighbors.set(link.from, new Set());
    if (!neighbors.has(link.to)) neighbors.set(link.to, new Set());
    neighbors.get(link.from)!.add(link.to);
    neighbors.get(link.to)!.add(link.from);
    changes.push([3, [from, to, 0]]);
    if (link.level > 0) changes.push([5, [from, to, link.level]]);
  }
  const skipped: TemplateRoute[] = [];
  let routeID = 0;
  for (const route of template.routes) {
    if (route.path.some((index, i) => index === COMMAND_ENDPOINT || columnByIndex.get(index) === EXTRACTOR ||
      !ids.has(index) || (i > 0 && !neighbors.get(route.path[i - 1]!)?.has(index)))) {
      skipped.push(route);
      continue;
    }
    changes.push([6, [[2, ++routeID], route.path.map(index => ids.get(index)!), route.typeID, route.quantity]]);
  }
  return { pins, links: template.links, routes: routeID, skipped, requestedLevel: level, upgradeCost, changes };
}
