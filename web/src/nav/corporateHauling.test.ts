import test from "node:test";
import assert from "node:assert/strict";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import { haulingLeg } from "./corporateHauling.ts";
import { decodeScriptValue, encodeScriptDoc } from "../bots/scriptCodec.ts";
import { validateScript } from "../bots/validateScript.ts";
import type { MacroMemory } from "./scriptDecide.ts";
import type { MacroStep } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { InventoryItemRow, ShipBay } from "../store/types.ts";

const row = (itemID: number, quantity: number, typeID = 34): InventoryItemRow => ({ itemID, typeID, quantity, groupID: 18, categoryID: 4, flagID: null, singleton: false, volume: 1 });
const station = (id: number) => ({ kind: "station" as const, ref: { entity: "station" as const, id, name: `Station ${id}`, systemName: null } });
const structure = (id: number) => ({ kind: "station" as const, ref: { entity: "structure" as const, id, name: `Structure ${id}`, systemName: null } });
const div = (division: number) => ({ kind: "corpDivision" as const, division, name: null });
const all: MacroStep = { id: "h", kind: "macro", macro: "haul-all", args: {
  pickupStation: station(1), deliveryStation: station(2), pickupCorpDivision: div(1), deliveryCorpDivision: div(2),
} };
const route: MacroStep = { id: "h", kind: "macro", macro: "route-hauler", args: {
  stationA: station(1), stationB: station(2), pickupDivisionA: div(1), deliveryDivisionB: div(2),
  returnCargo: { kind: "toggle", enabled: true }, pickupDivisionB: div(3), deliveryDivisionA: div(4),
} };
function obs(at: number, corp: Record<number, readonly InventoryItemRow[] | null>, cargo: readonly InventoryItemRow[] = [], bays: readonly ShipBay[] = []): ScriptObservation {
  return { inSpace: false, docked: true, inWarp: false, shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    myCorporationID: 98000123,
    oreHoldFraction: 0, holdEmpty: cargo.length === 0, hostileOnGrid: false, dronesOut: false,
    flightStatus: { inSpace: false, docked: true, solarSystemID: 9, stationID: at, structureID: null, shipID: 50,
      shipTypeID: 51, shipIsCapsule: false, shipMode: null, shipSpeedFraction: null },
    haulDivisions: corp, cargo: { rows: cargo, capacity: { capacity: 100, used: cargo.reduce((n,r)=>n+r.quantity,0) } }, shipBays: bays };
}
function driver(step = all) {
  let mem: MacroMemory = {};
  return (o: ScriptObservation) => { const result = SCRIPT_MACROS[step.macro]!(step,o,mem,{}); mem=result.nextMem; return result; };
}
test("corp haul owns only verified quantity, even when it merged into unrelated cargo", () => {
  const tick=driver();
  const load=tick(obs(1,{1:[row(10,20)]},[row(99,30)]));
  assert.equal(load.action.kind,"haulTransfer");
  assert.equal(load.action.kind === "haulTransfer" && load.action.quantity,20);
  tick(obs(1,{1:[]},[row(99,50)])); // merged into old stack, own only 20
  tick(obs(1,{1:[]},[row(99,50)])); // choose delivery
  assert.equal(tick(obs(1,{1:[]},[row(99,50)])).action.kind,"startRoute");
  const unload=tick(obs(2,{2:[]},[row(99,50)]));
  assert.deepEqual(unload.action,{kind:"haulTransfer",itemID:99,quantity:20,from:{kind:"cargo"},to:{kind:"corp",division:2},stationID:2,locationKind:"station",corporationID:98000123,division:2,typeID:34,sourceQuantity:50});
  tick(obs(2,{2:[row(1000,20)]},[row(99,30)]));
  tick(obs(2,{2:[row(1000,20)]},[row(99,30)]));
  assert.equal(tick(obs(1,{1:[]},[row(99,30)])).outcome.kind,"done");
});
test("strict corporate route keeps structure identity through load and delivery", () => {
  const a = 1_000_000_000_001, b = 1_000_000_000_002;
  const step: MacroStep = { ...all, args: { ...all.args, pickupStation: structure(a), deliveryStation: structure(b) } };
  const saved = decodeScriptValue({ format: "evejs-bot-script", version: 1, name: "Upwell route", notes: "",
    home: structure(a).ref, interrupts: [], program: [step] });
  assert.equal(saved.ok, true);
  assert.equal(haulingLeg(step)?.sourceKind, "structure");
  assert.equal(haulingLeg(step)?.destinationKind, "structure");
  const at = (id: number, corp: Record<number, readonly InventoryItemRow[] | null>, cargo: readonly InventoryItemRow[] = []) => {
    const o = obs(id, corp, cargo);
    return { ...o, flightStatus: { ...o.flightStatus!, stationID: null, structureID: id } };
  };
  const tick = driver(step);
  const load = tick(at(a, { 1: [row(10, 20)] }));
  assert.equal(load.action.kind === "haulTransfer" && load.action.locationKind, "structure");
  tick(at(a, { 1: [] }, [row(99, 20)]));
  tick(at(a, { 1: [] }, [row(99, 20)]));
  const trip = tick(at(a, { 1: [] }, [row(99, 20)]));
  assert.equal(trip.action.kind, "startRoute");
  const delivery = tick(at(b, { 2: [] }, [row(99, 20)]));
  assert.equal(delivery.action.kind === "haulTransfer" && delivery.action.stationID, b);
  assert.equal(delivery.action.kind === "haulTransfer" && delivery.action.locationKind, "structure");
});
test("partial movement, lost cargo and a personal-hangar fallback cannot count as delivery", () => {
  for(const amount of [0,5,21]) {
    const tick=driver(); tick(obs(1,{1:[row(10,20)]}));
    const result=tick(obs(1,{1: amount===0 ? [row(10,20)] : [row(10,20-Math.min(amount,20))]},amount ? [row(100,amount)] : []));
    assert.equal(result.outcome.kind,"blocked");
  }
  const tick=driver();tick(obs(1,{1:[row(10,20)]}));tick(obs(1,{1:[]},[row(100,20)]));tick(obs(1,{1:[]},[row(100,20)]));
  tick(obs(2,{2:[]},[row(100,20)]));
  assert.equal(tick(obs(2,{2:[]},[])).outcome.kind,"blocked","source disappearance is not a corp receipt");
});
test("bidirectional route loads B to A from its configured division after A delivery", () => {
  const tick=driver(route);tick(obs(1,{1:[row(10,20)]}));tick(obs(1,{1:[]},[row(100,20)]));tick(obs(1,{1:[]},[row(100,20)]));
  tick(obs(2,{2:[]},[row(100,20)]));tick(obs(2,{2:[row(200,20)]}));tick(obs(2,{2:[row(200,20)]}));
  const back=tick(obs(2,{3:[row(300,8,35)]}));
  assert.equal(back.action.kind,"haulTransfer");
  assert.deepEqual(back.action.kind === "haulTransfer" && back.action.from,{kind:"corp",division:3});
  tick(obs(2,{3:[]},[row(301,8,35)]));tick(obs(2,{3:[]},[row(301,8,35)]));
  const delivery=tick(obs(1,{4:[]},[row(301,8,35)]));
  assert.deepEqual(delivery.action.kind === "haulTransfer" && delivery.action.to,{kind:"corp",division:4});
});
test("filters use upstream item rules and never select unrelated inventory", () => {
  const step: MacroStep={...route,args:{...route.args,itemsAToB:{kind:"itemList",items:[{match:"type",typeID:35,name:"wanted"}]}}};
  const t=driver(step)(obs(1,{1:[row(10,20),row(11,5,35)]},[row(77,3,35)]));
  assert.equal(t.action.kind === "haulTransfer" && t.action.itemID,11);
});

test("saved haul-all distinguishes omitted, selected and explicitly unresolved item filters", () => {
  const atPickup = obs(1, { 1: [row(10, 20), row(11, 5, 35)] });
  const omitted = driver(all)(atPickup);
  assert.equal(omitted.action.kind === "haulTransfer" && omitted.action.itemID, 10);
  assert.deepEqual(haulingLeg(all)?.rules, [], "only an omitted filter means all eligible items");

  const selected: MacroStep = { ...all, args: { ...all.args, item: { kind: "itemType", typeID: 35, name: "Selected" } } };
  const filtered = driver(selected)(atPickup);
  assert.equal(filtered.action.kind === "haulTransfer" && filtered.action.itemID, 11);
  assert.deepEqual(haulingLeg(selected)?.rules, [{ match: "type", typeID: 35 }]);

  const saved = decodeScriptValue({ format: "evejs-bot-script", version: 1, name: "Saved haul", notes: "",
    home: station(1).ref, interrupts: [], program: [{ ...all, args: { ...all.args,
      item: { kind: "itemType", typeID: null, name: null } } }] });
  assert.equal(saved.ok, true, "the saved-script codec accepts an unbound picker");
  if (!saved.ok) return;
  const unresolved = saved.doc.program[0];
  assert.ok(unresolved?.kind === "macro");
  assert.equal(haulingLeg(unresolved), null, "an explicit unresolved filter is never an empty match-all list");
  const blocked = driver(unresolved)(atPickup);
  assert.equal(blocked.outcome.kind, "blocked");
  assert.equal(blocked.action.kind, "wait");
});
test("full preferred specialised bay never spills into generic cargo", () => {
  const ore={...row(10,20,1230),categoryID:25,groupID:462};
  const bay: ShipBay={key:"ore",label:"Ore hold",present:true,items:[],capacity:{capacity:10,used:10},error:null};
  const result=driver()(obs(1,{1:[ore]},[],[bay]));
  assert.equal(result.outcome.kind,"blocked");
  const partial=driver()(obs(1,{1:[ore]},[],[{...bay,capacity:{capacity:10,used:0}}]));
  assert.equal(partial.action.kind === "haulTransfer" && partial.action.quantity,10);
  assert.deepEqual(partial.action.kind === "haulTransfer" && partial.action.to,{kind:"shipBay",bay:"ore"});
});
test("unreadable or unavailable corporate destination blocks without personal fallback", () => {
  const tick=driver();tick(obs(1,{1:[row(10,20)]}));tick(obs(1,{1:[]},[row(100,20)]));tick(obs(1,{1:[]},[row(100,20)]));
  let result;
  for(let i=0;i<6;i++) result=tick(obs(2,{2:null},[row(100,20)]));
  assert.equal(result!.outcome.kind,"blocked");
});

test("an unresolved name cannot silently turn a filtered haul into an empty success", () => {
  const step: MacroStep = { ...route, args: { ...route.args,
    itemsAToB: { kind: "itemList", items: [{ match: "name", pattern: "Tritanium", name: "Tritanium" }] } } };
  const result = driver(step)({ ...obs(1, { 1: [row(10, 20)] }), typeNames: {} });
  assert.equal(result.outcome.kind, "blocked");
});

test("v1 route with a return leg round-trips without changing station references", () => {
  const script = { format: "evejs-bot-script" as const, version: 1 as const, name: "Route", notes: "",
    home: station(1).ref, interrupts: [], program: [route] };
  const decoded = decodeScriptValue(JSON.parse(encodeScriptDoc(script)));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  const step = decoded.doc.program[0];
  assert.ok(step?.kind === "macro");
  assert.equal(step.macro, "route-hauler");
  assert.deepEqual(haulingLeg(step), haulingLeg(route));
});

test("an explicitly empty saved route filter cannot mean all cargo", () => {
  const step: MacroStep = { ...route, args: { ...route.args, itemsAToB: { kind: "itemList", items: [] } } };
  assert.equal(haulingLeg(step), null);
  assert.equal(driver(step)(obs(1, { 1: [row(10, 20)] })).outcome.kind, "blocked");
  const script = { format: "evejs-bot-script" as const, version: 1 as const, name: "Invalid", notes: "",
    home: station(1).ref, interrupts: [], program: [step] };
  assert.ok(validateScript(script).some((problem) => problem.severity === "blocking"));
});
