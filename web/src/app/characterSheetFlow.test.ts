// loadCharacterSheet (goal R56), with the page asking for the sheet itself.
//
// Until 2026-10-10 the flow read one route (GET /api/bridge/character-sheet),
// which made four calls. It now makes the calls (bridge/characterSheetReads.ts):
// the character's public info and its bio, each naming the character; the home
// station; and the implants in its head, which the clone on show is made of,
// each in the slot the static data has for its type. The flow decodes them and —
// the crux — RESOLVES every id to a name through /api/names.
//
// ⚠ R7d is the invariant under test: the flow must ask /api/names for the
// corporation, the alliance (when present), the home station and EVERY implant
// typeID — under the right kind. An id static data cannot name (a player corp)
// resolves to null and is cached as a definitive unknown, never re-rendered raw.
// ⚠ empty ≠ failed: a FAILED read leaves its field null (with its *Error); a
// clean clone (no implants) is a real [] answer.

import test from "node:test";
import assert from "node:assert/strict";

import { createClientStore } from "../store/clientStore.ts";
import { createAppFlow } from "./flow.ts";
import { nameKey } from "../store/names.ts";
import { memberDetailsSavedTab } from "../bridge/corporationMemberDetails.ts";
import type { JsonValue } from "../bridge/wire.ts";

function keyval(entries: readonly (readonly [string, JsonValue])[]): JsonValue {
  return {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries: entries as JsonValue },
  };
}
function dict(entries: readonly (readonly [JsonValue, JsonValue])[]): JsonValue {
  return { type: "dict", entries: entries as JsonValue };
}

const PILOT = 140000005;

// Tranquility's GetPublicInfo (a KeyVal, with no security status among its fields); alliance/corporation overridable.
function publicInfo(
  over: { allianceID?: JsonValue; corporationID?: number } = {},
): JsonValue {
  return keyval([
    ["characterID", PILOT],
    ["characterName", "Farmer"],
    ["corporationID", over.corporationID ?? 98000001],
    ["allianceID", over.allianceID ?? null],
  ]);
}

/** homestation.types.StationData, as the home station service answers: what the sheet reads the home station from. */
const HOME_STATION: JsonValue = {
  type: "objectex2",
  header: [[{ type: "token", value: "homestation.types.StationData" }], dict([["is_fallback", false], ["solar_system_id", 30003504], ["id", 60015249], ["type_id", 52678]])],
  list: [],
  dict: [],
};
/** charMgr.GetHomeStationRow, which is read where that service's call is not carried (the web gateway). */
const HOME_STATION_ROW: JsonValue = keyval([
  ["stationID", 60015249],
  ["name", "Manifest V - AIR Laboratories Trade Center"],
]);

/** skillHandler.GetImplants as the server answers it: each implant by its type, under the server's own key. */
const IMPLANTS_NONE: JsonValue = dict([]);
const IMPLANTS: JsonValue = dict([
  [1, keyval([["typeID", 9941], ["itemID", 990000001]])],
  [2, keyval([["typeID", 9899], ["itemID", 990000002]])],
]);
/** What the static data has for each implant type's slot (dogma attribute 331). */
const SLOTS: Record<number, number> = { 9941: 1, 9899: 6 };

interface SheetBody {
  readonly corporationMemberIDs?: readonly number[];
  readonly publicInfo?: JsonValue;
  readonly description?: JsonValue;
  readonly homeStation?: JsonValue;
  /** The row, for a BFF that does not carry the home station service's call. */
  readonly homeStationRow?: JsonValue;
  readonly implants?: JsonValue;
  /** crimewatch.GetMySecurityStatus's float (0.1404 where none is given). */
  readonly securityStatus?: JsonValue;
  /** Why a call fails, by its method. */
  readonly errors?: Record<string, readonly [number, string]>;
}
interface Asked {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

// A fetch answering the choosing of a pilot, the sheet's five calls by the generic call, the static data's
// attributes, and /api/names. The names route captures the request refs and, unless an id is in `unnameable`,
// echoes a name. With nobody chosen a pilot's call is refused, as the BFF refuses it.
function sheetFetch(
  body: SheetBody,
  nameRequests: { kind: string; id: number }[] = [],
  unnameable: ReadonlySet<number> = new Set(),
  asked: Asked[] = [],
): typeof fetch {
  let chosen = false;
  const answers: Record<string, JsonValue> = {
    GetPublicInfo: body.publicInfo ?? null,
    GetMySecurityStatus: body.securityStatus ?? 0.1404,
    GetCharacterDescription: body.description ?? null,
    get_home_station: body.homeStation ?? null,
    GetHomeStationRow: body.homeStationRow ?? null,
    GetImplants: body.implants ?? null,
  };
  const json = (status: number, payload: unknown) => ({ ok: status >= 200 && status < 300, status, async json() { return payload; } });
  return (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    const sent = init && init.body ? JSON.parse(init.body) : {};
    asked.push({ path: url, body: sent });
    if (url === "/api/names") {
      const names: Record<string, string | null> = {};
      for (const item of sent.items ?? []) {
        nameRequests.push({ kind: String(item.kind), id: Number(item.id) });
        names[`${item.kind}:${item.id}`] = unnameable.has(Number(item.id))
          ? null
          : `Name ${item.id}`;
      }
      return json(200, { ok: true, names, unresolved: [] });
    }
    if (url === "/api/bridge/select") {
      chosen = true;
      return json(200, { ok: true, character: { characterID: PILOT, characterName: "Farmer", stationID: 60015249, structureID: null, solarSystemID: 30000142, corporationID: 98000001 }, station: null, notifications: [] });
    }
    if (url === "/api/bridge/corporation/member-ids") {
      return json(200, { ok: true, corporationID: 98000001, memberIDs: body.corporationMemberIDs ?? [] });
    }
    if (url === "/api/bridge/call") {
      if (sent.pilot === true && !chosen) return json(409, { ok: false, error: "NO_LIVE_SESSION", message: "No pilot is selected." });
      // (A BFF given the row and not the service's answer is one that does not carry the service's call.)
      if (sent.method === "get_home_station" && body.homeStationRow !== undefined) return json(403, { ok: false, error: "CALL_NOT_ALLOWED", message: "home_station.get_home_station is not on the web-call allowlist." });
      const failure = body.errors?.[String(sent.method)];
      if (failure) return json(failure[0], { ok: false, error: failure[1], message: `${String(sent.method)} failed.` });
      return json(200, { ok: true, service: sent.service, method: sent.method, result: answers[String(sent.method)] ?? null, notifications: [] });
    }
    if (url === "/api/types/dogma") {
      return json(200, { ok: true, attributes: Object.fromEntries((sent.typeIDs as number[]).map((typeID) => [typeID, typeID in SLOTS ? { 331: SLOTS[typeID] } : {}])) });
    }
    return json(200, { ok: true });
  }) as unknown as typeof fetch;
}

const noStream = () => ({ onmessage: null, onopen: null, onerror: null, close() {} });
/** The sheet's own calls, each as service.method(args), in the order they were asked. */
const sheetCalls = (asked: readonly Asked[]): string[] => asked
  .filter((request) => request.path === "/api/bridge/call" && (request.body.service === "charMgr" || request.body.service === "home_station" || request.body.method === "GetImplants" || request.body.method === "GetMySecurityStatus"))
  .map((request) => `${String(request.body.service)}.${String(request.body.method)}(${JSON.stringify(request.body.args).slice(1, -1)})`);

/** A flow with the pilot chosen, as the page has whenever the sheet is on show. */
async function withPilot(body: SheetBody, nameRequests: { kind: string; id: number }[] = [], unnameable: ReadonlySet<number> = new Set()) {
  const store = createClientStore();
  const asked: Asked[] = [];
  const flow = createAppFlow(store, { fetch: sheetFetch(body, nameRequests, unnameable, asked), eventSource: noStream });
  await flow.selectCharacter(PILOT);
  asked.length = 0;
  nameRequests.length = 0;
  return { store, flow, asked };
}

/** Let the queued name-resolution microtask + its fetch settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("the Memberships link requests Roles Summary for a verified corporation member", async () => {
  const { flow } = await withPilot({ corporationMemberIDs: [PILOT] });
  await flow.openCorporationMemberDetails(PILOT, "roles_summary");
  const first = flow.memberDetailsShown.get();
  assert.deepEqual(first, { characterID: PILOT, tabID: "roles_summary", n: 1 });
  await flow.openCorporationMemberDetails(PILOT + 1, "roles_summary");
  assert.equal(flow.memberDetailsShown.get(), first);
  await flow.openCorporationMemberDetails(PILOT);
  assert.deepEqual(flow.memberDetailsShown.get(), { characterID: PILOT, n: 2 });
  await flow.openCorporationMemberDetails(PILOT, "roles_summary");
  assert.deepEqual(flow.memberDetailsShown.get(), { characterID: PILOT, tabID: "roles_summary", n: 3 });
});

test("member editor selects saved tabs and restores the earlier summary preference", () => {
  assert.equal(memberDetailsSavedTab("roles"), "roles");
  assert.equal(memberDetailsSavedTab("titles"), "titles");
  assert.equal(memberDetailsSavedTab("roles_summary"), "roles_summary");
  assert.equal(memberDetailsSavedTab("summary"), "roles_summary");
  assert.equal(memberDetailsSavedTab(null), "general");
  assert.equal(memberDetailsSavedTab("other"), "general");
});

test("loadCharacterSheet decodes identity, bio, home station and a clean clone", async () => {
  const { store, flow, asked } = await withPilot({
    publicInfo: publicInfo(),
    description: "Character created via EveJS Elysian",
    homeStation: HOME_STATION,
    implants: IMPLANTS_NONE,
  });

  await flow.loadCharacterSheet();

  // The client's own calls: the character named where the client names it, the rest with nothing. Each is asked
  // as a pilot's call; the route is not read, and with no implants nothing is asked of the static data.
  assert.deepEqual(sheetCalls(asked), [`charMgr.GetPublicInfo(${PILOT})`, `charMgr.GetCharacterDescription(${PILOT})`, "home_station.get_home_station()", "skillHandler.GetImplants()", "crimewatch.GetMySecurityStatus()"]);
  assert.deepEqual(asked.filter((request) => request.path === "/api/bridge/call").map((request) => request.body.pilot), [true, true, true, true, true]);
  assert.deepEqual(asked.map((request) => request.path).filter((path) => path.startsWith("/api/bridge/character-sheet") || path === "/api/types/dogma"), []);

  const sheet = store.characterSheet.get();
  assert.equal(sheet.loaded, true);
  assert.equal(sheet.identity?.characterName, "Farmer");
  assert.equal(sheet.identity?.corporationID, 98000001);
  assert.equal(sheet.identity?.allianceID, null);
  assert.equal(sheet.identity?.securityStatus, 0.1404);
  assert.equal(sheet.description, "Character created via EveJS Elysian");
  assert.equal(sheet.homeStationID, 60015249);
  // A clean clone is [] implants — a real answer, not a failure.
  assert.deepEqual(sheet.clone?.implants, []);
  assert.equal(sheet.cloneError, null);
  // What only charMgr.GetCloneInfo says, which the client's sheet never asks, is not said.
  assert.deepEqual([sheet.clone?.jumpCloneCount, sheet.clone?.homeStationID, sheet.clone?.cloneStationID], [null, null, null]);
});

test("the clone on show is the implants the skill handler answers, each in the slot the static data has for its type", async () => {
  const { store, flow, asked } = await withPilot({ publicInfo: publicInfo(), description: "hi", homeStation: HOME_STATION, implants: IMPLANTS });
  await flow.loadCharacterSheet();
  // The two types' slots, asked for once, by the attribute the client sorts its implants by.
  assert.deepEqual(asked.filter((request) => request.path === "/api/types/dogma").map((request) => request.body), [{ typeIDs: [9941, 9899], attributeIDs: [331] }]);
  assert.deepEqual(store.characterSheet.get().clone?.implants, [{ typeID: 9941, slot: 1 }, { typeID: 9899, slot: 6 }]);
  // Read again: the calls again, and nothing of the static data, which does not change.
  asked.length = 0;
  await flow.loadCharacterSheet();
  assert.deepEqual([sheetCalls(asked).length, asked.filter((request) => request.path === "/api/types/dogma").length], [5, 0]);
  assert.deepEqual(store.characterSheet.get().clone?.implants, [{ typeID: 9941, slot: 1 }, { typeID: 9899, slot: 6 }]);
});

test("R7d: loadCharacterSheet asks /api/names for corp, alliance, station and every implant type", async () => {
  const nameRequests: { kind: string; id: number }[] = [];
  const { flow } = await withPilot({
    publicInfo: publicInfo({ allianceID: 99000001 }),
    description: "hi",
    homeStation: HOME_STATION,
    implants: IMPLANTS,
  }, nameRequests);

  await flow.loadCharacterSheet();
  await settle();

  assert.deepEqual(nameRequests.find((r) => r.id === 98000001), { kind: "corporation", id: 98000001 });
  assert.deepEqual(nameRequests.find((r) => r.id === 99000001), { kind: "alliance", id: 99000001 });
  assert.deepEqual(nameRequests.find((r) => r.id === 60015249), { kind: "station", id: 60015249 });
  // Every implant typeID is requested as a `type`.
  assert.deepEqual(nameRequests.find((r) => r.id === 9941), { kind: "type", id: 9941 });
  assert.deepEqual(nameRequests.find((r) => r.id === 9899), { kind: "type", id: 9899 });
});

test("R7d: a player corp that resolves to null is cached as a definitive unknown (never the id)", async () => {
  // 98000001 is a player corp: /api/names answers null for it.
  const { store, flow } = await withPilot(
    { publicInfo: publicInfo(), description: "", homeStation: HOME_STATION, implants: IMPLANTS_NONE },
    [],
    new Set([98000001]),
  );

  await flow.loadCharacterSheet();
  await settle();

  // The store caches the miss as null (a definitive unknown) — the panel shows a
  // fallback, and the id 98000001 is never rendered.
  assert.equal(store.names.get().resolved[nameKey("corporation", 98000001)], null);
  // The station, which DOES resolve, carries a real name.
  assert.equal(store.names.get().resolved[nameKey("station", 60015249)], "Name 60015249");
});

test("loadCharacterSheet: a FAILED clone read leaves clone null with cloneError; identity survives", async () => {
  // The call refused, and an answer that is no implants: each is the clone's own failure, with why.
  for (const [body, why] of [
    [{ errors: { GetImplants: [502, "CALL_REFUSED"] } }, /your clone: CALL_REFUSED/],
    [{ implants: "none to speak of" }, /your clone: READ_FAILED/],
    [{ implants: dict([[1, keyval([["itemID", 990000001]])]]) }, /your clone: READ_FAILED/],
  ] as const) {
    const { store, flow } = await withPilot({ publicInfo: publicInfo(), description: "bio", homeStation: HOME_STATION, implants: IMPLANTS_NONE, ...body } as SheetBody);

    await flow.loadCharacterSheet();

    const sheet = store.characterSheet.get();
    // ⚠ null, NOT an empty clone — a failed read must never look like a clean clone.
    assert.equal(sheet.clone, null);
    assert.match(sheet.cloneError ?? "", why);
    // The identity read survived the clone-side failure.
    assert.equal(sheet.identity?.characterName, "Farmer");
    assert.equal(sheet.identityError, null);
  }
});

test("each of the other reads fails by itself too, with why, and the rest are on show", async () => {
  const { store, flow } = await withPilot({ publicInfo: publicInfo(), description: "bio", homeStation: HOME_STATION, implants: IMPLANTS, errors: { GetPublicInfo: [502, "CALL_REFUSED"], get_home_station: [504, "EVE_GATEWAY_TIMEOUT"] } });
  await flow.loadCharacterSheet();
  const sheet = store.characterSheet.get();
  assert.deepEqual([sheet.loaded, sheet.identity, sheet.identityError, sheet.homeStationID, sheet.homeStationError], [true, null, "your character info: CALL_REFUSED", null, "your home station: EVE_GATEWAY_TIMEOUT"]);
  assert.deepEqual([sheet.description, sheet.descriptionError, sheet.clone?.implants.length, sheet.cloneError], ["bio", null, 2, null]);
});

test("loadCharacterSheet keeps an empty bio ('') distinct from a failed bio read", async () => {
  const { store, flow } = await withPilot({
    publicInfo: publicInfo(),
    description: "",
    homeStation: HOME_STATION,
    implants: IMPLANTS_NONE,
  });

  await flow.loadCharacterSheet();

  const sheet = store.characterSheet.get();
  // "" is a real empty bio; null would mean unread/failed.
  assert.equal(sheet.description, "");
  assert.equal(sheet.descriptionError, null);

  const failed = await withPilot({ publicInfo: publicInfo(), description: "", homeStation: HOME_STATION, implants: IMPLANTS_NONE, errors: { GetCharacterDescription: [502, "CALL_REFUSED"] } });
  await failed.flow.loadCharacterSheet();
  assert.deepEqual([failed.store.characterSheet.get().description, failed.store.characterSheet.get().descriptionError], [null, "your bio: CALL_REFUSED"]);
});

test("with nobody chosen there is no sheet: the BFF says there is no pilot, and nothing is landed", async () => {
  const store = createClientStore();
  const asked: Asked[] = [];
  const flow = createAppFlow(store, { fetch: sheetFetch({ publicInfo: publicInfo(), description: "bio", homeStation: HOME_STATION, implants: IMPLANTS_NONE }, [], new Set(), asked), eventSource: noStream });
  await assert.rejects(flow.loadCharacterSheet(), (error: { code?: string }) => error.code === "NO_LIVE_SESSION");
  // Asked with no one named, since there is no one; and the BFF is what refuses.
  assert.deepEqual(sheetCalls(asked), ["charMgr.GetPublicInfo()", "charMgr.GetCharacterDescription()", "home_station.get_home_station()", "skillHandler.GetImplants()", "crimewatch.GetMySecurityStatus()"]);
  assert.equal(store.characterSheet.get().loaded, false);
});

test("the pilot's session gone fails the whole sheet, whichever read met it", async () => {
  for (const method of ["GetPublicInfo", "GetImplants"]) {
    const { store, flow } = await withPilot({ publicInfo: publicInfo(), description: "bio", homeStation: HOME_STATION, implants: IMPLANTS_NONE, errors: { [method]: [404, "SESSION_NOT_FOUND"] } });
    await assert.rejects(flow.loadCharacterSheet(), (error: { code?: string }) => error.code === "SESSION_NOT_FOUND", method);
    assert.equal(store.characterSheet.get().loaded, false, method);
  }
});

test("through a BFF that does not carry the home station service's call, the sheet's home station is the row's", async () => {
  const { store, flow, asked } = await withPilot({ publicInfo: publicInfo(), description: "bio", homeStationRow: HOME_STATION_ROW, implants: IMPLANTS_NONE });
  await flow.loadCharacterSheet();
  assert.deepEqual(sheetCalls(asked), [`charMgr.GetPublicInfo(${PILOT})`, `charMgr.GetCharacterDescription(${PILOT})`, "home_station.get_home_station()", "skillHandler.GetImplants()", "crimewatch.GetMySecurityStatus()", "charMgr.GetHomeStationRow()"]);
  const sheet = store.characterSheet.get();
  assert.deepEqual([sheet.loaded, sheet.homeStationID, sheet.homeStationError, sheet.identity?.characterName], [true, 60015249, null, "Farmer"]);
});
