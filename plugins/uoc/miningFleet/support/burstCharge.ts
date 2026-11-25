import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import {
  loadFitting,
  buildSlots,
  slotFlagOf,
  boundDogma,
  getFlightStatus,
  decodeFlightStatus,
} from "../../../../web/src/plugin-api/flying.ts";
import { readKeyVal, readRowField } from "../../shared/wire.ts";
const id = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const integer = (x: any): number | null => {
  const v = x?.type === "long" ? x.value : x;
  if (id(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    return id(n) && String(n) === v ? n : null;
  }
  return null;
};
const dict = (v: any) =>
  v?.type === "dict" &&
  Array.isArray(v.entries) &&
  v.entries.every((x: any) => Array.isArray(x) && x.length === 2)
    ? v.entries
    : null;
const tuple = (x: any) =>
  Array.isArray(x) ? x : x?.type === "tuple" && Array.isArray(x.items) ? x.items : null;
export type BurstChargeRead =
  | { state: "EMPTY"; quantity: 0 }
  | { state: "LOADED"; quantity: number; typeID: number; itemID: readonly [number, number, number] }
  | { state: "UNKNOWN"; reason: string };
type Deps = {
  loadFitting: typeof loadFitting;
  buildSlots: typeof buildSlots;
  boundDogma: typeof boundDogma;
  getFlightStatus: typeof getFlightStatus;
  decodeFlightStatus: typeof decodeFlightStatus;
};
/** Read the exact held module charge; dual complete native views distinguish empty from unreadable. */
export async function observeBurstCharge(
  c: {
    run: Pick<PluginRunContext, "characterID" | "baseUrl" | "fetch">;
    session: PilotSession;
    shipID: number;
    moduleID: number;
    typeID: number;
    current: () => void;
  },
  overrides: Partial<Deps> = {},
): Promise<BurstChargeRead> {
  const d = {
      loadFitting,
      buildSlots,
      boundDogma,
      getFlightStatus,
      decodeFlightStatus,
      ...overrides,
    },
    generation = c.session.flow.flying.sessionGeneration(),
    opts = { ...c.session.flow.requestOptions(), baseUrl: c.run.baseUrl, fetch: c.run.fetch };
  const guard = () => {
    c.current();
    if (
      ![c.run.characterID, c.shipID, c.moduleID, c.typeID].every(id) ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      c.session.flow.flying.isSessionClosing() ||
      c.session.flow.flying.sessionGeneration() !== generation ||
      c.session.store.station.get().online?.characterID !== c.run.characterID
    )
      throw Error("Burst held owner changed.");
  };
  try {
    guard();
    const before = d.decodeFlightStatus((await d.getFlightStatus(opts)).flight);
    guard();
    const fitting = await d.loadFitting(opts);
    guard();
    if (
      fitting.activeShipID !== c.shipID ||
      Object.values(fitting.errors).some((e) => e !== null) ||
      !fitting.chargeFits ||
      typeof fitting.chargeFits !== "object" ||
      Array.isArray(fitting.chargeFits)
    )
      throw Error("Fitting or charge metadata is unavailable.");
    const fit = (fitting.chargeFits as any)[c.typeID];
    if (
      !fit ||
      !Array.isArray(fit.groups) ||
      !fit.groups.length ||
      fit.groups.some((x: unknown) => !id(x))
    )
      throw Error("Burst charge fitment is unavailable.");
    const raw = fitting.slots as any;
    if (raw?.type !== "list" || !Array.isArray(raw.items))
      throw Error("Fitted slots are unreadable.");
    const rowIDs = new Set<string>(),
      flags = new Set<string>();
    for (const x of raw.items) {
      const row = x?.type === "packedrow" ? x.fields : x,
        key = tuple(row?.itemID),
        rawQuantity = row?.quantity ?? row?.stacksize,
        quantity = rawQuantity === -1 || rawQuantity === -2 ? (row?.stacksize ?? 1) : rawQuantity,
        rowID = key ? JSON.stringify(key) : String(row?.itemID),
        flagKey = `${row?.categoryID === 8 ? "charge" : "module"}:${row?.flagID}`;
      if (
        !row ||
        !(id(row.itemID) || (key && key.length === 3 && key.every(id))) ||
        !id(row.typeID) ||
        !id(row.flagID) ||
        !id(row.categoryID) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 0 ||
        rowIDs.has(rowID) ||
        flags.has(flagKey)
      )
        throw Error("Fitted slot row is malformed or ambiguous.");
      rowIDs.add(rowID);
      flags.add(flagKey);
    }
    const slots = d.buildSlots(fitting.slots, fitting.shipInfo, fitting.online),
      matches = slots.filter(
        (s) =>
          s.family === "high" && s.module?.itemID === c.moduleID && s.module.typeID === c.typeID,
      );
    if (matches.length !== 1 || matches[0]!.module?.groupID !== 1770)
      throw Error("Exact mining Burst module is unavailable.");
    const slot = matches[0]!,
      flagID = slotFlagOf(slot.family, slot.index);
    if (!id(flagID)) throw Error("Burst slot is unavailable.");
    const response = await c.run.fetch(new URL("/api/bridge/bound-dogma", c.run.baseUrl)),
      payload = (await response.json()) as any;
    guard();
    const cell = payload?.reads?.GetAllInfo,
      top = cell?.result;
    if (!response.ok || payload?.ok === false || !cell || cell.error || !top)
      throw Error("Native dogma snapshot is unavailable.");
    const rawInfo: any = readKeyVal(top, "shipInfo"),
      entries = dict(rawInfo),
      charInfo: any = readKeyVal(top, "charInfo"),
      chars = Array.isArray(charInfo) ? dict(charInfo[0]) : null;
    if (
      !entries ||
      !chars ||
      chars.length !== 1 ||
      integer(chars[0][0]) !== c.run.characterID ||
      integer(readKeyVal(top, "activeShipID")) !== c.shipID
    )
      throw Error("Native dogma owner or ship is unavailable.");
    let ownShip = 0,
      ownModule = 0;
    const targetTuples: number[][] = [],
      targetEntries: any[] = [],
      seen = new Set<string>();
    for (const [k, v] of entries) {
      const t = tuple(k);
      if (t) {
        if (t.length !== 3 || !t.every(id) || t[0] !== c.shipID || seen.has(JSON.stringify(t)))
          throw Error("Native dogma sublocations are malformed.");
        seen.add(JSON.stringify(t));
        if (t[1] === flagID) {
          targetTuples.push(t);
          targetEntries.push(v);
        }
        if (!v || typeof v !== "object") throw Error("Native dogma sublocation is unreadable.");
      } else {
        const key = integer(k);
        if (!key || seen.has(String(key)) || !v || typeof v !== "object")
          throw Error("Native dogma item identity is malformed.");
        seen.add(String(key));
        if (key === c.shipID) ownShip++;
        if (key === c.moduleID) {
          ownModule++;
          const inv: any = readKeyVal(v, "invItem");
          if (
            integer(readRowField(inv, "itemID")) !== c.moduleID ||
            integer(readRowField(inv, "typeID")) !== c.typeID ||
            integer(readRowField(inv, "locationID")) !== c.shipID ||
            integer(readRowField(inv, "flagID")) !== flagID
          )
            throw Error("Native dogma module identity differs.");
        }
      }
    }
    if (ownShip !== 1 || ownModule !== 1 || targetTuples.length > 1)
      throw Error("Native dogma slot identity is ambiguous.");
    const dogma = await d.boundDogma(opts);
    guard();
    const after = d.decodeFlightStatus((await d.getFlightStatus(opts)).flight);
    guard();
    if (
      before.shipID !== c.shipID ||
      after.shipID !== c.shipID ||
      !id(before.solarSystemID) ||
      typeof before.docked !== "boolean" ||
      typeof before.inSpace !== "boolean" ||
      before.docked === before.inSpace ||
      before.solarSystemID !== after.solarSystemID ||
      before.inSpace !== after.inSpace ||
      before.docked !== after.docked ||
      before.stationID !== after.stationID ||
      before.structureID !== after.structureID
    )
      throw Error("Burst held flight changed.");
    const view = dogma?.allInfo;
    if (
      !view ||
      view.error !== null ||
      !view.value ||
      integer(view.value.activeShipID) !== c.shipID ||
      integer(view.value.characterID) !== c.run.characterID ||
      !Array.isArray(view.value.ships)
    )
      throw Error("Decoded dogma snapshot is unavailable.");
    if (
      view.value.ships.length !== entries.length ||
      view.value.ships.some((x: any) => {
        const k = Array.isArray(x.sublocation)
          ? JSON.stringify(x.sublocation)
          : String(integer(x.itemID));
        return !seen.has(k);
      })
    )
      throw Error("Native dogma rows were dropped or changed.");
    const decoded = view.value.ships.filter(
      (x: any) =>
        Array.isArray(x.sublocation) &&
        x.sublocation[0] === c.shipID &&
        x.sublocation[1] === flagID,
    );
    if (decoded.length !== targetTuples.length) throw Error("Native charge views differ.");
    if (!targetTuples.length) {
      if (slot.module?.charge) throw Error("Fitting and native dogma charge views differ.");
      return { state: "EMPTY", quantity: 0 };
    }
    const item = decoded[0]!,
      itemID = targetTuples[0]!;
    if (
      JSON.stringify(item.sublocation) !== JSON.stringify(itemID) ||
      item.typeID !== itemID[2] ||
      integer(item.locationID) !== c.shipID ||
      item.flagID !== flagID ||
      !Array.isArray(item.attributes)
    )
      throw Error("Native charge identity changed.");
    const attributes = dict(readKeyVal(targetEntries[0], "attributes"));
    if (
      !attributes ||
      attributes.some((x: any) => !id(integer(x[0]))) ||
      new Set(attributes.map((x: any) => integer(x[0]))).size !== attributes.length
    )
      throw Error("Native charge attributes are unreadable.");
    const nativeQuantity = attributes.filter((x: any) => integer(x[0]) === 805);
    const values = item.attributes.filter((x: any) => x.attributeID === 805);
    if (
      nativeQuantity.length !== 1 ||
      values.length !== 1 ||
      !Number.isSafeInteger(values[0]?.value) ||
      values[0]!.value < 0 ||
      Number(nativeQuantity[0][1]) !== values[0]!.value
    )
      throw Error("Native charge quantity is unreadable.");
    const quantity = values[0]!.value,
      cached = slot.module?.charge;
    if (cached && (cached.typeID !== item.typeID || cached.quantity !== quantity))
      throw Error("Fitting and native dogma charge quantities differ.");
    return quantity === 0
      ? { state: "EMPTY", quantity: 0 }
      : { state: "LOADED", quantity, typeID: item.typeID!, itemID: [c.shipID, flagID, itemID[2]!] };
  } catch (error) {
    guard();
    return {
      state: "UNKNOWN",
      reason: error instanceof Error ? error.message : "Burst charge is unreadable.",
    };
  }
}
