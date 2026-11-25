import test from "node:test";
import assert from "node:assert/strict";
import type { BackendRequest, BackendResponse, PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { createDistributionWorker } from "./host.ts";
import { loadFor, needs, type Config, type Office, type Stack, type Stock, type Volumes } from "./model.ts";
import { createDistributionNative, type DistributionNative } from "./native.ts";
import { createDistributionStore, type DistributionView } from "./store.ts";

const A: Office = { destinationID: 600, systemID: 300, kind: "station", division: 7, name: "Source Station" };
const B: Office = { destinationID: 700, systemID: 301, kind: "structure", division: 1, name: "Delivery Hub" };
const C: Office = { destinationID: 800, systemID: 300, kind: "station", division: 2, name: "Second Source" };
const ore: Stock = { itemID: 50, typeID: 1230, quantity: 25, categoryID: 25, groupID: 462, singleton: false };
const config: Config = { name: "Ship ore", mode: "MANUAL", corporationID: 99, source: A, destination: B,
  items: [{ typeID: ore.typeID, name: "Veldspar", quantity: 15 }], fillPercent: 0, waitMinutes: 0 };
const allItems: Config = { ...config, allItems: true, items: [] };
const minerals: Stock = { itemID: 61, typeID: 34, quantity: 3, categoryID: 4, groupID: 18, singleton: false };
const modules: Stock = { itemID: 70, typeID: 2048, quantity: 2, categoryID: 7, groupID: 60, singleton: false };
const volumes = { [ore.typeID]: { packaged: 1, assembled: 1 } };
const world = "test-world";
const roleAccount = { accountID: 2, username: "operator" };
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  type Move = Parameters<DistributionNative["move"]>[0];
  type Result = Awaited<ReturnType<DistributionNative["move"]>>;
  let persisted: unknown = null, clock = 1_000, nextItem = 100;
  const document = () => ({ read: () => structuredClone(persisted), write: (value: unknown) => { persisted = structuredClone(value); } });
  let store = createDistributionStore(document);
  const stock = new Map([[600, [{ ...ore }]], [700, [] as Stock[]], [800, [{ ...ore, itemID: 51 }]]]);
  const holds = new Map<number, Record<string, Stock[]>>();
  const location = new Map<number, number>();
  const moves: Move[] = [], routes: number[] = [];
  let remoteAllowed = true, loadCapacity = 20;
  const cargoCapacity = new Map<number, number>(), sizes: Volumes = { ...volumes };
  const oreCapacity = new Map<number, number>(), shipTypes = new Map<number, number>();
  const specialCapacity = new Map<number, Record<string, number>>();
  let onMove: (move: Move, physical: () => Result) => Promise<Result> = async (_move, physical) => physical();
  let onRead: (dock: Office, id: number) => Promise<void> = async () => {};

  function request(key: keyof typeof store.routes, body?: unknown, id?: string, account = roleAccount) {
    const result = store.routes[key]({ worldID: world, account, body, params: id ? { id } : {} } as unknown as BackendRequest) as BackendResponse;
    return result.body as unknown as DistributionView & { message?: string };
  }

  function add(id: number) {
    if (!location.has(id)) { location.set(id, 900); holds.set(id, { ore: [], cargo: [] }); }
    assert.equal(request("POST /logistics/roster", { characterID: id, name: "Hauler " + id, corporationID: 99 }).ok, true);
  }
  const view = () => store.view(world);
  function save(cfg = config) {
    const data = request("POST /logistics/save", { config: cfg });
    assert.ok(data.ok, data.message ?? "Saving the operation failed");
    return data.operations.at(-1)!;
  }
  function start(id: string) { assert.equal(request("POST /logistics/:id/start", {}, id).ok, true); }
  function stop(id: string) {
    const op = store.operation(world, id)!;
    assert.equal(request("POST /logistics/:id/stop", { executionID: op.execution?.id }, id).ok, true);
  }
  function worker(id: number) {
    const shipID = id + 1_000, cargo = holds.get(id)!;
    store.attach(world, id, "bot-" + id, "pilot-" + id);
    const io = {
      async flight() { return { f: { solarSystemID: 300 }, locationID: location.get(id), shipID,
        shipTypeID: shipTypes.get(id) ?? 648, corporationID: 99 }; },
      async bays(_ship: number, keys: string[]) {
        const capacities: Record<string, number> = { ore: oreCapacity.get(id) ?? loadCapacity, cargo: cargoCapacity.get(id) ?? 0, ...specialCapacity.get(id) };
        const bays = keys.filter(key => (capacities[key] ?? 0) > 0);
        return { volumes: bays.map(key => ({ key, capacity: capacities[key],
          used: cargo[key]!.reduce((count, row) => count + row.quantity * (sizes[row.typeID]?.[row.singleton ? "assembled" : "packaged"] ?? 0), 0) })),
          rows: Object.fromEntries(bays.map(key => [key, structuredClone(cargo[key])])), unreadable: [] };
      },
      async local(dock: Office) {
        assert.equal(location.get(id), dock.destinationID, "physically docked at the requested endpoint");
        await onRead(dock, id);
        return structuredClone(stock.get(dock.destinationID)!);
      },
      async remote(dock: Office) {
        if (!remoteAllowed) throw Error("Access to remote corporation assets was denied");
        return structuredClone(stock.get(dock.destinationID)!);
      },
      async volumes() { return sizes; },
      async move(move: Move) {
        moves.push(structuredClone(move));
        assert.equal(location.get(id), move.office.destinationID);
        assert.equal(move.shipID, shipID);
        const bay = cargo[move.line.bay]!;
        return onMove(move, () => {
          const station = stock.get(move.office.destinationID)!;
          const [from, to] = move.leg === "pickup" ? [station, bay] : [bay, station];
          const index = from.findIndex(row => row.itemID === move.source.itemID);
          assert.ok(index >= 0);
          const row = from[index]!;
          assert.equal(row.quantity, move.source.quantity, "expected source stack quantity is current");
          assert.ok(row.quantity >= move.line.quantity);
          row.quantity -= move.line.quantity;
          if (row.quantity === 0) from.splice(index, 1);
          const merged = to.find(row => !row.singleton && row.typeID === move.line.typeID);
          if (merged) merged.quantity += move.line.quantity;
          else to.push({ ...row, itemID: row.singleton ? row.itemID : nextItem++, quantity: move.line.quantity });
          return { kind: "confirmed", quantity: move.line.quantity, keptID: row.singleton };
        });
      },
    } as unknown as DistributionNative;
    return createDistributionWorker({ store, world, characterID: id, io, current: () => {}, now: () => clock, report: () => {},
      travel: async (dock, expectedShip, guard) => {
        guard(); assert.equal(expectedShip, shipID); routes.push(dock.destinationID); location.set(id, dock.destinationID);
      } });
  }

  return { add, request, save, start, stop, worker, view, stock, holds, moves, routes, location,
    remoteAllowed(value: boolean) { remoteAllowed = value; },
    capacity(value: number) { loadCapacity = value; },
    cargoCapacity(id: number, value: number) { cargoCapacity.set(id, value); },
    oreCapacity(id: number, value: number) { oreCapacity.set(id, value); },
    specialBay(id: number, key: string, capacity: number) {
      specialCapacity.set(id, { ...specialCapacity.get(id), [key]: capacity });
      holds.get(id)![key] ??= [];
    },
    shipType(id: number, typeID: number) { shipTypes.set(id, typeID); },
    size(typeID: number, packaged: number, assembled = packaged) { sizes[typeID] = { packaged, assembled }; },
    onMove(hook: typeof onMove) { onMove = hook; }, onRead(hook: typeof onRead) { onRead = hook; },
    advance(ms: number) { clock += ms; }, restart() { store = createDistributionStore(document); },
    persisted: () => persisted,
  };
}

test("a roster entry cannot claim an account or prevent the real carrier from joining the shared fleet", () => {
  const f = fixture(), alpha = { accountID: 101, username: "Alpha" }, beta = { accountID: 102, username: "Beta" };
  const hauler = { characterID: 12, name: "Hauler", corporationID: 99 };
  const add = (account: typeof alpha, body: unknown) => f.request("POST /logistics/roster", body, undefined, account);
  assert.equal(add(alpha, { ...hauler, account: "Beta" }).ok, false);
  assert.deepEqual(f.view().roster, []);
  assert.equal(add(alpha, { ...hauler, account: "Alpha", name: "Old label" }).ok, true);
  assert.equal(f.view().roster[0]?.account, undefined);
  assert.equal(add(beta, hauler).ok, true);
  assert.equal(f.view().roster[0]?.name, hauler.name);
  assert.equal(add(alpha, { ...hauler, characterID: 11, name: "Second hauler" }).ok, true);
  const op = f.save();
  for (const account of [beta, alpha]) {
    f.restart();
    const shared = f.request("GET /logistics", undefined, undefined, account);
    assert.deepEqual(shared.roster.map(row => row.characterID).sort(), [11, 12]);
    assert.deepEqual(shared.operations.map(row => row.id), [op.id]);
  }
  assert.equal(f.request("POST /logistics/:id/start", {}, op.id, beta).ok, true);
  const run = f.request("GET /logistics", undefined, undefined, alpha).operations[0]!.execution!;
  assert.equal(f.request("POST /logistics/:id/stop", { executionID: run.id }, op.id, alpha).ok, true);
  assert.equal(f.request("GET /logistics", undefined, undefined, beta).operations[0]?.execution?.state, "STOPPED");
});

test("a legacy account hint cannot block the verified owner or be overwritten by a roster request", () => {
  let data: unknown = { roster: [{ characterID: 12, name: "Carrier", account: "old-label" }], operations: [], trips: [] };
  const document = () => ({read: () => structuredClone(data), write: (v: unknown) => { data = structuredClone(v); }});
  const store = createDistributionStore(document);
  assert.equal(store.view(world).roster[0]?.account,undefined);
  store.attach(world, 12, "held-12", "beta");
  assert.equal(store.view(world).roster[0]?.account, "beta");
  store.release(world, 12, "held-12");
  const again = createDistributionStore(document);
  again.routes["POST /logistics/roster"]({worldID:world, account:roleAccount,body:{
    characterID:12,name:"Carrier",account:roleAccount.username
  }} as unknown as BackendRequest);
  assert.equal(again.view(world).roster[0]?.account, "beta");
  assert.equal(again.view(world).roster.length, 1);
});

test("Manual hauls only the requested ore and counts the trip after confirmed unloading", async () => {
  const f = fixture();
  f.add(1);
  assert.equal(f.request("GET /logistics", undefined, undefined, { accountID: 3, username: "another-saved-account" }).roster.length, 1);
  f.holds.get(1)!.ore!.push({ ...ore, itemID: 90, quantity: 3 });
  const op = f.save(); f.start(op.id);
  const worker = f.worker(1);
  await worker.step();
  assert.deepEqual(f.routes, [A.destinationID, B.destinationID]);
  assert.deepEqual(f.moves.map(move => [move.leg, move.line.quantity]), [["pickup", 12], ["delivery", 15]]);
  assert.deepEqual(f.holds.get(1)!.ore, [], "the three units already aboard count toward the order");
  assert.equal(f.stock.get(B.destinationID)![0]?.quantity, 15);
  assert.deepEqual(f.view().operations[0]!.execution, { id: f.view().operations[0]!.execution!.id, state: "COMPLETED",
    delivered: { [ore.typeID]: 15 }, trips: 1, deliveredVolumeM3: 15 });
  assert.equal(f.view().roster[0]!.trip, null);
  assert.equal(f.view().roster[0]!.hosted?.phase, "Idle");
  await worker.step();
  assert.equal(f.moves.length, 2);
});

test("All Items loads mixed stacks into compatible holds and finishes after the last unload", async () => {
  const f = fixture();
  f.add(1); f.cargoCapacity(1, 30);
  f.size(minerals.typeID, 2); f.size(modules.typeID, 5);
  const ammo = { itemID: 81, typeID: 185, quantity: 8, categoryID: 8, groupID: 83, singleton: false };
  const component = { itemID: 82, typeID: 11399, quantity: 1, categoryID: 4, groupID: 334, singleton: false };
  const hull = { itemID: 83, typeID: 648, quantity: 1, categoryID: 6, groupID: 28, singleton: false };
  f.size(ammo.typeID, 0.5); f.size(component.typeID, 0); f.size(hull.typeID, 2);
  f.stock.set(A.destinationID, [{ ...ore, quantity: 6 }, { ...ore, itemID: 51, quantity: 2 },
    { ...minerals }, { ...modules }, ammo, component, hull]);
  const op = f.save(allItems); f.start(op.id);
  await f.worker(1).step();
  const pickup = f.moves.filter(move => move.leg === "pickup");
  assert.equal(pickup.length, 7);
  assert.ok(pickup.every(move => move.line.bay === (move.line.typeID === ore.typeID ? "ore" : "cargo")));
  assert.deepEqual(f.routes, [A.destinationID, B.destinationID]);
  const run = f.view().operations[0]!.execution!;
  assert.equal(run.state, "COMPLETED");
  assert.deepEqual(run.delivered, { [ore.typeID]: 8, [minerals.typeID]: 3, [modules.typeID]: 2, [ammo.typeID]: 8,
    [component.typeID]: 1, [hull.typeID]: 1 });
  assert.equal(run.deliveredVolumeM3, 30);
  assert.equal(run.trips, 1);
});

test("All Items gives FixtureHauler the ore and Bestower and Sigil the hulls, with ore as fallback", async () => {
  const f = fixture();
  const specializedHauler = 1, bestower = 2, sigil = 3;
  for (const id of [specializedHauler, bestower, sigil]) f.add(id);
  f.shipType(specializedHauler, 2100000919); f.shipType(bestower, 1944); f.shipType(sigil, 19744);
  f.capacity(0); f.oreCapacity(specializedHauler, 163_800);
  f.cargoCapacity(specializedHauler, 1100); f.cargoCapacity(bestower, 24_726.258568); f.cargoCapacity(sigil, 9606.871968);
  const inquisitor = { itemID: 73, typeID: 590, quantity: 30, categoryID: 6, groupID: 25, singleton: false };
  const venture = { ...inquisitor, itemID: 75, typeID: 32880, quantity: 60 };
  const assembled = { ...inquisitor, itemID: 80, quantity: 1, singleton: true };
  f.size(inquisitor.typeID, 2500, 28_700); f.size(venture.typeID, 2500, 29_500); f.size(ore.typeID, 0.1);
  f.stock.set(A.destinationID, [{ ...ore, quantity: 4_000_000 }, inquisitor, venture, assembled]);
  const op = f.save({ ...allItems, mode: "COLLECTION" }); f.start(op.id);
  const oreHauler = f.worker(specializedHauler), bigHauler = f.worker(bestower), smallHauler = f.worker(sigil);
  const pickups = (id: number) => f.moves.filter(move => move.shipID === id + 1000 && move.leg === "pickup");

  await oreHauler.step();
  assert.equal(pickups(specializedHauler)[0]?.line.bay, "ore");
  assert.ok(pickups(specializedHauler).every(move => move.line.typeID === ore.typeID));
  assert.deepEqual(f.view().operations[0]!.execution?.unshipped?.map(row => [row.typeID, row.quantity]), [[inquisitor.typeID, 1]]);

  await bigHauler.step();
  await smallHauler.step();
  for (const [id, fits] of [[bestower, 9], [sigil, 3]] as const) {
    const [hull, overflow] = pickups(id);
    assert.equal(hull?.line.itemID, inquisitor.itemID);
    assert.equal(hull?.line.quantity, fits);
    assert.equal(hull?.line.singleton, false);
    assert.equal(hull?.line.unitVolumeM3, 2500);
    assert.equal(overflow?.line.typeID, ore.typeID);
    assert.equal(overflow?.line.bay, "cargo");
  }

  for (let round = 0; round < 7; round++) {
    await bigHauler.step();
    await smallHauler.step();
  }
  const run = f.view().operations[0]!.execution!;
  assert.equal(run.delivered[inquisitor.typeID], 30);
  assert.equal(run.delivered[venture.typeID], 60);
  assert.ok(f.stock.get(A.destinationID)!.some(row => row.itemID === assembled.itemID));
  assert.equal(run.unshipped?.find(row => row.typeID === inquisitor.typeID)?.quantity, 1);
  assert.doesNotMatch(run.unshipped?.[0]?.reason ?? "", /does not fit/);

  f.stock.set(A.destinationID, [{ ...ore, quantity: 4_000_000 }]);
  const previous = [pickups(specializedHauler).length, pickups(bestower).length, pickups(sigil).length];
  await oreHauler.step();
  await bigHauler.step();
  await smallHauler.step();
  assert.equal(pickups(specializedHauler)[previous[0]!]?.line.bay, "ore");
  assert.equal(pickups(bestower)[previous[1]!]?.line.typeID, ore.typeID);
  assert.equal(pickups(sigil)[previous[2]!]?.line.typeID, ore.typeID);
  assert.deepEqual(f.view().operations[0]!.execution?.unshipped, []);
});

test("All Items makes another trip for the remainder after the configured wait", async () => {
  const f = fixture();
  f.add(1); f.capacity(10);
  const op = f.save({ ...allItems, fillPercent: 80, waitMinutes: 1 }); f.start(op.id);
  const worker = f.worker(1);
  await worker.step();
  await worker.step();
  await worker.step();
  assert.equal(f.view().operations[0]!.execution?.state, "RUNNING");
  assert.equal(f.stock.get(A.destinationID)![0]?.quantity, 5);
  assert.match(f.view().roster[0]!.hosted!.detail!, /fuller load/);
  f.advance(60_000);
  await worker.step();
  const run = f.view().operations[0]!.execution!;
  assert.equal(run.state, "COMPLETED");
  assert.equal(run.delivered[ore.typeID], 25);
  assert.equal(run.trips, 3);
});

test("an empty All Items Manual finishes while Collection waits and hauls new arrivals", async () => {
  const manual = fixture();
  manual.add(1);
  manual.stock.get(A.destinationID)!.length = 0;
  const once = manual.save(allItems); manual.start(once.id);
  await manual.worker(1).step();
  assert.equal(manual.view().operations[0]!.execution?.state, "COMPLETED");
  assert.equal(manual.moves.length, 0);

  const collection = fixture();
  collection.add(1);
  collection.stock.get(A.destinationID)!.length = 0;
  const repeat = collection.save({ ...allItems, mode: "COLLECTION" }); collection.start(repeat.id);
  const worker = collection.worker(1);
  await worker.step();
  assert.equal(collection.view().operations[0]!.execution?.state, "RUNNING");
  collection.stock.get(A.destinationID)!.push({ ...ore, quantity: 7 });
  collection.advance(20_000);
  await worker.step();
  assert.equal(collection.view().operations[0]!.execution?.delivered[ore.typeID], 7);
  assert.equal(collection.view().operations[0]!.execution?.state, "RUNNING");
});

test("All Items waits for both haulers' freight after the source has emptied", async () => {
  const f = fixture();
  f.add(1); f.add(2); f.capacity(10);
  f.stock.get(A.destinationID)![0]!.quantity = 15;
  const op = f.save(allItems); f.start(op.id);
  const one = f.worker(1), two = f.worker(2);
  const unloading = signal(), resume = signal();
  f.onMove(async (move, physical) => {
    if (move.shipID === 1001 && move.leg === "delivery") { unloading.resolve(); await resume.promise; }
    return physical();
  });
  const firstTrip = one.step();
  await unloading.promise;
  await two.step();
  assert.equal(f.stock.get(A.destinationID)!.length, 0);
  assert.equal(f.view().operations[0]!.execution?.state, "RUNNING");
  assert.equal(f.view().roster.filter(row => row.trip?.cargo.length).length, 2);
  resume.resolve();
  await firstTrip;
  await two.step();
  const run = f.view().operations[0]!.execution!;
  assert.equal(run.state, "COMPLETED");
  assert.equal(run.delivered[ore.typeID], 15);
  assert.equal(run.trips, 2);
  assert.deepEqual(f.moves.filter(move => move.leg === "pickup").map(move => move.line.quantity), [10, 5]);
});

test("unshippable items stay in the source division and are excluded from delivered totals", async () => {
  const f = fixture();
  f.add(1); f.cargoCapacity(1, 20);
  const assembled = { itemID: 83, typeID: 648, quantity: 1, categoryID: 6, groupID: 28, singleton: true };
  f.size(minerals.typeID, 50); f.size(assembled.typeID, 2);
  f.stock.set(A.destinationID, [{ ...ore, quantity: 8 }, { ...minerals }, { ...modules }, assembled]);
  const op = f.save(allItems); f.start(op.id);
  await f.worker(1).step();
  const run = f.view().operations[0]!.execution!;
  assert.equal(run.state, "INCOMPLETE");
  assert.deepEqual(run.delivered, { [ore.typeID]: 8 });
  assert.deepEqual(f.stock.get(A.destinationID), [minerals, modules, assembled]);
  assert.match(run.unshipped!.find(item => item.typeID === minerals.typeID)!.reason, /does not fit/);
  assert.match(run.unshipped!.find(item => item.typeID === modules.typeID)!.reason, /no verified volume/);
  assert.match(run.unshipped!.find(item => item.typeID === assembled.typeID)!.reason, /Assembled ships/);
});

test("a hauler with a larger hold can take items the first ship could not fit", async () => {
  const f = fixture();
  f.add(1); f.add(2);
  f.cargoCapacity(1, 10); f.cargoCapacity(2, 100);
  f.size(minerals.typeID, 25);
  f.stock.set(A.destinationID, [{ ...minerals }]);
  const op = f.save(allItems); f.start(op.id);
  await f.worker(1).step();
  assert.equal(f.moves.length, 0);
  assert.equal(f.view().operations[0]!.execution?.state, "RUNNING");
  assert.deepEqual(f.view().operations[0]!.execution?.unshipped ?? [], []);
  await f.worker(2).step();
  const run = f.view().operations[0]!.execution!;
  assert.equal(run.state, "COMPLETED");
  assert.equal(run.delivered[minerals.typeID], 3);
  assert.deepEqual(run.unshipped, []);
});

test("an oversized stack is reported only after both eligible haulers rule it out", async () => {
  const f = fixture();
  f.add(1); f.add(2); f.cargoCapacity(1, 10); f.cargoCapacity(2, 15);
  f.size(minerals.typeID, 25);
  f.stock.set(A.destinationID, [{ ...minerals }]);
  const op = f.save({ ...allItems, mode: "COLLECTION" }); f.start(op.id);
  const first = f.worker(1), second = f.worker(2);
  await first.step();
  assert.deepEqual(f.view().operations[0]!.execution?.unshipped ?? [], []);
  await second.step();
  assert.match(f.view().operations[0]!.execution?.unshipped?.[0]?.reason ?? "", /eligible fleet/);
  f.cargoCapacity(2, 30);
  f.advance(21_000);
  await second.step();
  assert.equal(f.view().operations[0]!.execution?.delivered[minerals.typeID], 1);
  assert.deepEqual(f.view().operations[0]!.execution?.unshipped, []);
});

test("a confirmed refusal can fall back to cargo and leaves other stacks eligible", async () => {
  const f = fixture();
  f.add(1); f.cargoCapacity(1, 50);
  f.size(minerals.typeID, 2); f.size(modules.typeID, 1);
  f.stock.set(A.destinationID, [{ ...ore, quantity: 4 }, { ...minerals }, { ...modules }]);
  const op = f.save(allItems); f.start(op.id);
  f.onMove(async (move, physical) => move.leg === "pickup" && (move.line.bay === "ore" || move.line.typeID === minerals.typeID)
    ? { kind: "refused", reason: "Native transfer refused", unchanged: true } : physical());
  await f.worker(1).step();
  const run = f.view().operations[0]!.execution!;
  assert.deepEqual(run.delivered, { [ore.typeID]: 4, [modules.typeID]: 2 });
  assert.deepEqual(f.moves.filter(row => row.leg === "pickup" && row.line.typeID === ore.typeID).map(row => row.line.bay), ["ore", "cargo"]);
  assert.deepEqual(f.stock.get(A.destinationID), [minerals]);
  assert.match(run.unshipped![0]!.reason, /game refused/);
  assert.equal(run.state, "RUNNING");
});

test("a refused unload does not stop the other items on the same trip from being delivered", async () => {
  const f = fixture();
  f.add(1); f.cargoCapacity(1, 20); f.size(minerals.typeID, 1);
  f.stock.set(A.destinationID, [{ ...ore, quantity: 4 }, { ...minerals }]);
  const op = f.save(allItems); f.start(op.id);
  f.onMove(async (move, physical) => move.leg === "delivery" && move.line.typeID === ore.typeID
    ? { kind: "refused", reason: "Native transfer refused", unchanged: true } : physical());
  const worker = f.worker(1);
  await worker.step();
  const run = f.view().operations[0]!.execution!;
  assert.equal(run.state, "RUNNING");
  assert.deepEqual(run.delivered, { [minerals.typeID]: 3 });
  assert.deepEqual(f.view().roster[0]!.trip?.cargo, [{ typeID: ore.typeID, quantity: 4 }]);
  assert.match(f.view().roster[0]!.trip!.issue!, /remaining freight is still on board/);
  f.onMove(async (_move, physical) => physical());
  f.advance(15_000);
  await worker.step();
  assert.equal(f.view().operations[0]!.execution?.state, "COMPLETED");
  assert.equal(f.view().operations[0]!.execution?.trips, 1);
});

test("Manual observes new stock that arrived before the final source check", async () => {
  const f = fixture();
  f.add(1); f.cargoCapacity(1, 20); f.size(minerals.typeID, 1);
  f.stock.set(A.destinationID, [{ ...ore, quantity: 4 }]);
  const op = f.save(allItems); f.start(op.id);
  f.onMove(async (move, physical) => {
    const response = physical();
    if (move.leg === "pickup" && move.line.typeID === ore.typeID) f.stock.get(A.destinationID)!.push({ ...minerals });
    return response;
  });
  const worker = f.worker(1);
  await worker.step();
  assert.equal(f.view().operations[0]!.execution?.state, "RUNNING");
  await worker.step();
  assert.equal(f.view().operations[0]!.execution?.state, "COMPLETED");
  assert.deepEqual(f.view().operations[0]!.execution?.delivered, { [ore.typeID]: 4, [minerals.typeID]: 3 });
});

test("All Items Stop retains already loaded cargo and skips the rest of the load plan", async () => {
  const f = fixture();
  f.add(1); f.cargoCapacity(1, 20); f.size(minerals.typeID, 1);
  f.stock.set(A.destinationID, [{ ...ore, quantity: 4 }, { ...minerals }]);
  const op = f.save(allItems); f.start(op.id);
  f.onMove(async (move, physical) => {
    if (move.leg === "pickup") f.stop(op.id);
    return physical();
  });
  await f.worker(1).step();
  const run = f.view().operations[0]!.execution!;
  assert.equal(run.state, "STOPPED");
  assert.deepEqual(run.delivered, { [ore.typeID]: 4 });
  assert.deepEqual(f.stock.get(A.destinationID), [minerals]);
});

test("Supply still requires selected types", () => {
  const f = fixture();
  const save = f.request("POST /logistics/save", { config: { ...allItems, mode: "SUPPLY" } });
  assert.equal(save.ok, false);
  assert.equal(f.save({ ...config, mode: "SUPPLY" }).config.allItems, undefined);
});

test("a saved catalog item can be absent and edited, and is picked up when it appears", async () => {
  const f = fixture();
  f.add(1);
  f.stock.get(A.destinationID)!.length = 0;
  const op = f.save();
  assert.equal(f.request("POST /logistics/save", { id: op.id, config: { ...config, name: "Restock later" } }).ok, true);
  f.start(op.id);
  const worker = f.worker(1);
  await worker.step();
  assert.equal(f.moves.length, 0);
  assert.match(f.view().roster[0]!.hosted!.detail!, /Waiting for selected stock/);
  f.stock.get(A.destinationID)!.push({ ...ore });
  f.advance(21_000);
  await worker.step();
  assert.equal(f.view().operations[0]!.execution?.state, "COMPLETED");
});

test("Collection honors the source reserve and the configurable wait for an incomplete load", async () => {
  const f = fixture();
  f.add(1);
  const op = f.save({ ...config, mode: "COLLECTION", items: [{ ...config.items[0]!, quantity: 18 }], fillPercent: 85, waitMinutes: 1 });
  f.start(op.id);
  const worker = f.worker(1);
  await worker.step();
  assert.deepEqual(f.moves, []);
  assert.match(f.view().roster[0]!.hosted!.detail!, /fuller load/);
  f.advance(60_000);
  await worker.step();
  assert.equal(f.stock.get(A.destinationID)![0]?.quantity, 18);
  assert.equal(f.stock.get(B.destinationID)![0]?.quantity, 7);
  assert.equal(f.view().operations[0]!.execution?.state, "RUNNING");
});

test("Supply can inspect the destination in person and delivers only the missing stock", async () => {
  const f = fixture();
  f.add(1);
  f.remoteAllowed(false);
  f.stock.get(B.destinationID)!.push({ ...ore, itemID: 70, quantity: 11 });
  const op = f.save({ ...config, mode: "SUPPLY" });
  f.start(op.id);
  const worker = f.worker(1);
  await worker.step();
  assert.deepEqual(f.routes, [B.destinationID, A.destinationID, B.destinationID]);
  assert.equal(f.stock.get(B.destinationID)![0]?.quantity, 15);
  assert.equal(f.view().operations[0]!.execution?.delivered[ore.typeID], 4);
  assert.equal(f.view().operations[0]!.execution?.state, "RUNNING");
  await worker.step();
  assert.equal(f.moves.length, 2);
});

test("haulers never read and load the same source division concurrently", async () => {
  const f = fixture();
  f.add(1); f.add(2); f.capacity(10);
  const op = f.save(); f.start(op.id);
  const first = f.worker(1), second = f.worker(2);
  const entered = signal(), resume = signal();
  f.onRead(async (dock, id) => {
    if (id === 1 && dock.destinationID === A.destinationID) { entered.resolve(); await resume.promise; }
  });
  const firstTrip = first.step();
  await entered.promise;
  await second.step();
  assert.equal(f.moves.length, 0);
  resume.resolve();
  await firstTrip;
  f.advance(21_000);
  await second.step();
  assert.deepEqual(f.moves.map(move => move.line.quantity), [10, 10, 5, 5]);
  assert.equal(f.stock.get(B.destinationID)![0]?.quantity, 15);
  assert.equal(f.view().operations[0]!.execution?.trips, 2);
});

test("Supply counts freight already on its way from a different source", async () => {
  const f = fixture();
  f.add(1); f.add(2);
  f.stock.get(B.destinationID)!.push({ ...ore, itemID: 70, quantity: 11 });
  const first = f.save({ ...config, mode: "SUPPLY" });
  const second = f.save({ ...config, source: C, mode: "SUPPLY" });
  f.start(first.id); f.start(second.id);
  const one = f.worker(1), two = f.worker(2);
  const entered = signal(), resume = signal();
  f.onMove(async (move, physical) => {
    if (move.leg === "pickup" && move.shipID === 1_001) { entered.resolve(); await resume.promise; }
    return physical();
  });
  const firstTrip = one.step();
  await entered.promise;
  // The second hauler considers both saved routes while the first pickup is in flight.
  await two.step();
  f.advance(1_000);
  await two.step();
  assert.equal(f.moves.length, 1);
  resume.resolve();
  await firstTrip;
  assert.equal(f.stock.get(B.destinationID)![0]?.quantity, 15);
});

test("Stop during pickup drains confirmed freight and prevents further pickup", async () => {
  const f = fixture();
  f.add(1); f.add(2); f.capacity(10);
  const op = f.save(); f.start(op.id);
  f.onMove(async (move, apply) => {
    if (move.leg === "pickup") {
      f.stop(op.id);
      assert.equal(f.view().operations[0]!.execution?.state, "STOPPING");
    }
    return apply();
  });
  await f.worker(1).step();
  await f.worker(2).step();
  assert.deepEqual(f.moves.map(move => move.leg), ["pickup", "delivery"]);
  assert.equal(f.view().operations[0]!.execution?.state, "STOPPED");
  assert.equal(f.view().operations[0]!.execution?.delivered[ore.typeID], 10);
});

test("an unknown response is reconciled exactly once, including after the hosted worker reconnects", async () => {
  const f = fixture();
  f.add(1);
  const op = f.save(); f.start(op.id);
  let disconnected = false;
  f.onMove(async (move, apply) => {
    apply();
    if (move.leg === "pickup") disconnected = true;
    return { kind: "unknown", reason: "Reply lost" };
  });
  f.onRead(async () => { if (disconnected) throw Error("Pilot disconnected before readback"); });
  await f.worker(1).step();
  assert.equal(f.moves.length, 1);
  assert.equal(f.view().roster[0]!.trip?.checking?.quantity, 15);
  f.restart();
  disconnected = false;
  const resumed = f.worker(1);
  await resumed.step();
  await resumed.step();
  assert.deepEqual(f.moves.map(move => move.leg), ["pickup", "delivery"]);
  assert.equal(f.stock.get(B.destinationID)![0]?.quantity, 15);
  assert.equal(f.view().operations[0]!.execution?.delivered[ore.typeID], 15);
  assert.equal(f.view().operations[0]!.execution?.trips, 1);
  assert.doesNotMatch(JSON.stringify(f.persisted()), /"claims"|"history"|"targetRows"/);
});

test("a refused unload leaves the cargo visible and the other hauler can finish a different operation", async () => {
  const f = fixture();
  f.add(1); f.add(2);
  const first = f.save(); const second = f.save({ ...config, source: C });
  f.start(first.id); f.start(second.id);
  f.onMove(async (move, physical) => move.leg === "delivery" && move.shipID === 1_001
    ? { kind: "refused", reason: "Division rejected the items" } : physical());
  const one = f.worker(1);
  await one.step();
  f.stop(first.id);
  assert.match(f.view().roster[0]!.trip!.issue!, /Division rejected/);
  assert.equal(f.view().roster[0]!.trip!.cargo[0]?.quantity, 15);
  await f.worker(2).step();
  assert.equal(f.view().operations[1]!.execution?.delivered[ore.typeID], 15);
  assert.equal(f.view().operations[0]!.execution?.state, "STOPPING");
  f.onMove(async (_move, physical) => physical());
  f.advance(16_000);
  await one.step();
  assert.equal(f.view().operations[0]!.execution?.state, "STOPPED");
  assert.equal(f.view().operations[0]!.execution?.delivered[ore.typeID], 15);
});

test("unchanged inventory after a lost reply retains the only pending transfer without replay", async () => {
  const f = fixture();
  f.add(1);
  const op = f.save(); f.start(op.id);
  f.onMove(async () => ({ kind: "unknown", reason: "Reply lost before its outcome could be observed" }));
  const worker = f.worker(1);
  await worker.step();
  f.stop(op.id); f.advance(16_000);
  await worker.step();
  assert.equal(f.moves.length, 1);
  assert.equal(f.stock.get(A.destinationID)![0]?.quantity, 25);
  assert.equal(f.view().roster[0]!.trip?.checking?.quantity, 15);
  assert.equal(f.view().operations[0]!.execution?.state, "STOPPING");
  assert.deepEqual(f.view().operations[0]!.execution?.delivered, {});
});

test("cargo selection prioritizes compatible holds per hull", () => {
  const material = { itemID: 88, typeID: 34, quantity: 10, categoryID: 4, groupID: 18, singleton: false };
  const stock = [ore, material];
  const wanted = needs({ ...config, items: [{ typeID: ore.typeID, quantity: 7 }, { typeID: material.typeID, quantity: 8 }] }, stock, {}, {});
  const planned = loadFor(wanted, [{ key: "ore", capacity: 12, used: 0 }, { key: "cargo", capacity: 5, used: 0 }],
    { ...volumes, 34: { packaged: 1, assembled: 1 } });
  assert.deepEqual(planned.lines.map(row => [row.typeID, row.bay, row.quantity]), [[1230, "ore", 7], [34, "cargo", 5]]);
  const general = loadFor(needs(allItems, stock, {}, {}), [{ key: "cargo", capacity: 5, used: 0 }],
    { ...volumes, 34: { packaged: 1, assembled: 1 } }, [], [{ key: "ore", capacity: 12, used: 0 }]);
  assert.deepEqual(general.lines.map(row => [row.typeID, row.bay, row.quantity]), [[34, "cargo", 5]]);
});

test("Distribution fills verified resource holds before using fleet space with a full cargo hold", () => {
  const cases = [
    [25, 462, "asteroid"], [25, 903, "ice"], [2, 4168, "gas"], [4, 4932, "mineral"],
    [4, 966, "salvage"], [4, 423, "fuel"], [4, 1136, "colony"], [43, 1042, "planetary"],
  ] as const;
  for (const [categoryID, groupID, specialty] of cases) {
    const stock = { ...ore, categoryID, groupID, quantity: 9 };
    const bays = [{ key: "cargo", capacity: 4, used: 4 }, { key: specialty, capacity: 5, used: 1 }];
    const wanted = needs(allItems, [stock], {}, {});
    const { lines } = loadFor(wanted, [...bays, { key: "fleet", capacity: 5, used: 0 }], volumes);
    assert.deepEqual(lines.map(line => [line.bay, line.quantity]), [[specialty, 4], ["fleet", 5]], specialty);
    assert.deepEqual(loadFor(wanted, bays, volumes).lines.map(line => line.bay), [specialty]);
  }
  const block = { ...ore, categoryID: 4, groupID: 1136 };
  assert.deepEqual(loadFor(needs(allItems, [block], {}, {}), [{key:"fuel", capacity:100, used:0}], volumes).lines, []);
});

test("an interrupted Distribution delivery drains eligible carry-in from fleet and ore holds once", async () => {
  const f = fixture(); f.add(1); f.specialBay(1, "fleet", 100); f.oreCapacity(1, 5); f.cargoCapacity(1, 2);
  f.size(modules.typeID, 1);
  const aboard = f.holds.get(1)!;
  aboard.ore!.push({ ...ore, itemID: 88, quantity: 5 });
  aboard.fleet!.push({ ...ore, itemID: 89, quantity: 45 }, { ...modules, itemID: 90, quantity: 2 });
  aboard.cargo!.push({ ...modules, itemID: 91, quantity: 2 });
  f.stock.set(A.destinationID, [{...ore, quantity:10}]);
  const op = f.save(allItems); f.start(op.id);
  let interrupted = false;
  f.onMove(async (move, physical) => {
    const result = physical();
    if (move.leg === "delivery" && move.line.bay === "fleet" && !interrupted) {
      interrupted = true;
      throw Error("Lost unload response");
    }
    return result;
  });
  await f.worker(1).step();
  assert.equal(interrupted, true);
  assert.ok(f.view().roster[0]?.trip?.checking);
  f.restart();
  const worker = f.worker(1);
  await worker.step(); await worker.step();
  assert.deepEqual(f.moves.map(m => [m.leg, m.line.bay, m.line.quantity]),
    [["pickup","fleet",10], ["delivery","ore",5], ["delivery","fleet",55]]);
  assert.deepEqual(f.view().operations[0]?.execution?.delivered, {[ore.typeID]:60});
  assert.equal(f.view().operations[0]?.execution?.trips,1);
  assert.equal(f.view().operations[0]?.execution?.state,"COMPLETED");
  assert.equal(f.stock.get(B.destinationID)?.[0]?.quantity,60);
  assert.deepEqual(aboard.ore,[]);
  assert.deepEqual(aboard.fleet?.map(row=>row.itemID),[90]);
  assert.deepEqual(aboard.cargo?.map(row=>row.itemID),[91]);
});

test("Collection keeps its source reserve and departure threshold when resources are already aboard", async () => {
  const f=fixture(); f.add(1); f.oreCapacity(1,100);
  f.holds.get(1)!.ore!.push({...ore,itemID:90,quantity:5});
  f.stock.set(A.destinationID,[{...ore,quantity:14}]);
  const op=f.save({...config,mode:"COLLECTION",items:[{typeID:ore.typeID,quantity:4}],fillPercent:80,waitMinutes:1});
  f.start(op.id); const worker=f.worker(1);
  await worker.step();
  assert.equal(f.moves.length,0); assert.equal(f.view().roster[0]?.trip,null);
  f.advance(60_001); await worker.step();
  assert.deepEqual(f.moves.map(m=>[m.leg,m.line.quantity]),[["pickup",10],["delivery",15]]);
  assert.equal(f.stock.get(A.destinationID)?.[0]?.quantity,4);
  assert.deepEqual(f.holds.get(1)!.ore,[]);
});

test("Supply counts selected mineral carry-in against the destination target even when A is empty", async () => {
  const f = fixture(); f.add(1); f.specialBay(1,"mineral",20); f.size(minerals.typeID,1);
  f.holds.get(1)!.mineral!.push({...minerals,quantity:9,volume:1});
  f.stock.set(A.destinationID,[]);
  f.stock.set(B.destinationID,[{...minerals,itemID:83,quantity:4}]);
  const op = f.save({...config,mode:"SUPPLY",items:[{typeID:minerals.typeID,quantity:10}]}); f.start(op.id);
  await f.worker(1).step();
  assert.deepEqual(f.moves.map(m=>[m.leg,m.line.bay,m.line.quantity]),[["delivery","mineral",6]]);
  assert.equal(f.stock.get(B.destinationID)?.[0]?.quantity,10);
  assert.equal(f.holds.get(1)!.mineral?.[0]?.quantity,3);
  assert.equal(f.view().operations[0]?.execution?.deliveredVolumeM3,6);
});

test("the native path uses MCC division authority and quotes the exact source, ship and dock to WC", async () => {
  const calls: string[] = [];
  let rolesAtHQ = (1048576 + 8192) * 64;
  let activeShipID = 1001, fleetCapacity = 0, moveBay = "ore";
  const session = {
    store: { station: { get: () => ({ online: { characterID: 1, corporationID: 99 } }) } },
    flow: { flying: {
      bridgeAsk: async (service: string, method: string, args: unknown[], keywords?: unknown, id?: number) => {
        calls.push(service + "." + method);
        if (method === "GetCorporation") return { type: "packedrow", fields: { corporationID: 99, ceoID: 2, stationID: 600 } };
        if (method === "GetMember") return { type: "packedrow", fields: { corporationID: 99, characterID: 1,
          roles: 0, titleMask: 0, rolesAtHQ, baseID: null } };
        if (method === "GetMyCorporationsOffices") return { list: [{ fields: { stationID: 600, officeID: 601 } }] };
        assert.equal(method, "List"); assert.deepEqual(args, []); assert.deepEqual(keywords, { flag: 121 }); assert.equal(id, 601);
        return { type: "list", items: [{ type: "packedrow", fields: { ...ore, locationID: 601, flagID: 121, ownerID: 99 } }] };
      },
      bridgeDo: async (service: string, method: string) => { calls.push(service + "." + method); },
    } },
  } as unknown as PilotSession;
  const fetcher: typeof fetch = async (url, init) => {
    const { pathname, search } = new URL(String(url));
    calls.push(pathname + search);
    if (pathname === "/api/bridge/flight/status")
      return Response.json({ ok: true, flight: { shipID: activeShipID, shipTypeID: 648, solarSystemID: 300, stationID: 600, docked: true, inSpace: false } });
    if (pathname === "/api/bridge/corp-offices")
      return Response.json({ ok: true, error: null, stationIDs: [600], divisions: Array.from({ length: 7 }, (_, i) => ({ division: i + 1, name: null })) });
    if (pathname === "/api/bridge/ship/1001/bays") return Response.json({ok:true, shipID:1001, activeShipID, bays:[
      {key:"fleet",present:fleetCapacity>0,capacity:{capacity:fleetCapacity,used:0},items:fleetCapacity>0?[]:null,error:null},
      {key:"cargo",present:true,capacity:{capacity:5,used:5},items:[modules],error:null},
    ]});
    assert.equal(pathname, "/api/bridge/inventory/transfer");
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.expectedScope, undefined, "WC only accepts expectedScope in space");
    assert.deepEqual(payload.haulContract, { stationID: 600, locationKind: "station", corporationID: 99, division: 7, typeID: ore.typeID, sourceQuantity: 25 });
    assert.deepEqual(payload.from, { kind: "corp", division: 7 });
    assert.deepEqual(payload.to, { kind: "shipBay", bay: moveBay });
    return Response.json({ ok: true, applied: true, transferStatus: "SUCCESS", moved: [] });
  };
  const io = createDistributionNative({ characterID: 1, baseUrl: "http://fixture", fetch: fetcher } as unknown as PluginRunContext, session, () => {});
  assert.deepEqual(await io.local(A, 99, 1001, true), [ore]);
  assert.ok(calls.includes("invbroker.List"));
  assert.ok(calls.every(call => !call.includes("divisionAccess")));
  rolesAtHQ = 1048576 * 64;
  await assert.rejects(io.local(A, 99, 1001, true), /requires Query and Take/);
  const move = { leg: "pickup" as const, office: A, shipID: 1001, source: ore, corporationID: 99,
    line: { ...ore, quantity: 5, bay: "ore" } };
  assert.equal((await io.move(move)).kind, "confirmed");
  assert.deepEqual((await io.bays(1001,["fleet","cargo"])).volumes.map(b=>b.key),["cargo"]);
  fleetCapacity = 80;
  assert.deepEqual((await io.bays(1001,["fleet","cargo"])).volumes.find(b=>b.key==="fleet"),{key:"fleet",capacity:80,used:0});
  moveBay = "fleet";
  assert.equal((await io.move({...move,line:{...move.line,bay:moveBay}})).kind,"confirmed");
  activeShipID = 1002;
  await assert.rejects(io.bays(1001,["fleet","cargo"]),/current holds/);
  assert.equal((await io.move(move)).kind, "refused");
  assert.equal(calls.filter(call => call === "/api/bridge/inventory/transfer").length, 2);
});

test("legacy data stays intact while saved routes and unsettled cargo enter the compact document", () => {
  const previous = { roster: { "account:old": [{ characterID: 1, account: "P1", name: "Hauler" }] },
    operations: [{ id: "op", config: { ...config, source: undefined, sources: [A] },
      execution: { id: "run", state: "STOPPING", delivered: { [ore.typeID]: 5 } } }],
    claims: [{ operationID: "op", executionID: "run", source: A, carrier: { characterID: 1 }, endedAt: null,
      shipID: 1001, issue: "Previous transfer interrupted", pending: null,
      lines: [{ ...ore, bay: "ore", state: "LOADED", cargoID: 30, quantity: 8 }] }],
    executions: [{ historical: true }],
  };
  const before = structuredClone(previous);
  let compact: unknown = null;
  const store = createDistributionStore(() => ({ read: () => compact, write: data => { compact = data; } }),
    () => ({ read: () => previous, write: () => assert.fail("legacy document must stay intact") }));
  assert.equal(store.view(world).roster[0]!.trip!.cargo[0]!.quantity, 8);
  assert.equal(store.view(world).operations[0]!.execution?.delivered[ore.typeID], 5);
  store.reportIssue(world, 1, "Could not read the hold");
  assert.deepEqual(previous, before);
  assert.doesNotMatch(JSON.stringify(compact), /"claims"|"executions"/);
});
