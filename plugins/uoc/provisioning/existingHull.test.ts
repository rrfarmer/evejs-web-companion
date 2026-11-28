import assert from "node:assert/strict";
import test from "node:test";
import { applyExistingHull, reviewExistingHull } from "./existingHull.ts";

const pilot = 7, corporation = 98, station = 600, office = 800, wantedHull = 17476;
const initialShip = 9, moduleType = 20, rigType = 21, droneType = 2203;
const packagedHull = 900, moduleStack = 901, rigStack = 902, drones = 903;
const requirements = [
  { flag: 27, typeID: moduleType, quantity: 1, kind: "FITTED" },
  { flag: 92, typeID: rigType, quantity: 1, kind: "FITTED" },
  { flag: 87, typeID: droneType, quantity: 5, kind: "LOADED" },
];
type Installed = [typeID: number, flag: number, quantity?: number];
const complete: Installed[] = [[moduleType, 27], [rigType, 92], [droneType, 87, 5]];
type Hull = { id: number; corporate?: boolean; typeID?: number; fit: Installed[]; unreadable?: boolean };
type InventoryRow = { itemID: number; typeID: number; locationID: number; ownerID: number; flagID: number; quantity: number; singleton: boolean; categoryID: number };
const packed = (row: InventoryRow) => ({ type: "packedrow", fields: {
  ...row, singleton: Number(row.singleton), stacksize: row.quantity, quantity: row.singleton ? -1 : row.quantity,
} });
const list = (rows: InventoryRow[]) => ({ type: "list", items: rows.map(packed) });

function world(hulls: Hull[], { corporate = false, take = true, lost = "", refuse = "", partialLoad = false, slotChanged = false } = {}) {
  let active = initialShip;
  const writes: Array<{ method: string; body: any }> = [];
  const assembled = new Map<number, { root: InventoryRow; contents: InventoryRow[]; unreadable: boolean }>();
  for (const hull of [{ id: initialShip, typeID: 89240, fit: [] as Installed[] }, ...hulls]) {
    const inCorp = "corporate" in hull && hull.corporate;
    const ownerID = inCorp ? corporation : pilot;
    assembled.set(hull.id, {
      root: { itemID: hull.id, typeID: hull.typeID ?? wantedHull, ownerID, locationID: inCorp ? office : station,
        flagID: inCorp ? 121 : 4, singleton: true, categoryID: 6, quantity: 1 },
      contents: hull.fit.map(([typeID, flagID, quantity = 1], i) => ({ itemID: hull.id * 100 + i, typeID, ownerID, locationID: hull.id,
        flagID, quantity, singleton: flagID !== 87, categoryID: flagID === 87 ? 18 : 7 })),
      unreadable: "unreadable" in hull && hull.unreadable === true,
    });
  }
  const stock = new Map<number, InventoryRow>([
    [packagedHull, wantedHull, 6, 1], [moduleStack, moduleType, 7, 1], [rigStack, rigType, 7, 1], [drones, droneType, 18, 6],
  ].map(([itemID, typeID, categoryID, quantity]) => [itemID!, {
    itemID: itemID!, typeID: typeID!, categoryID: categoryID!, quantity: quantity!,
    ownerID: corporate ? corporation : pilot, locationID: corporate ? office : station, flagID: corporate ? 121 : 4, singleton: false,
  }]));
  const roots = (ownerID: number) => [...assembled.values()].map(ship => ship.root).filter(row => row.ownerID === ownerID);
  const native = () => {
    const ship = assembled.get(active)!;
    const shipTypeID = ship.root.typeID;
    const already = shipTypeID === wantedHull && requirements.every(need => ship.contents
      .filter(item => item.flagID === need.flag && item.typeID === need.typeID)
      .reduce((total, item) => total + item.quantity, 0) === need.quantity);
    const canApply = take && stock.has(packagedHull);
    return {
      context: { characterID: pilot, corporationID: corporation, locationID: station, shipID: active, shipTypeID, recoveryReady: true },
      status: { equipment: already ? "VERIFIED" : "MODIFIED" }, canApply: already || canApply,
      source: {
        pin: { descriptor: corporate ? { kind: "corp", corporationID: corporation, division: 7 } : { kind: "hangar" },
          ownerID: corporate ? corporation : pilot, locationID: corporate ? office : station, flag: corporate ? 121 : 4,
          office: corporate ? "corpOffice:800" : null, dockedLocationID: station },
        access: { query: true, take }, rows: [...roots(corporate ? corporation : pilot), ...stock.values()].map(row => ({ ...row })),
      },
      plan: { mode: already ? "ALREADY_SATISFIED" : "NEW_HULL", targetHullTypeID: wantedHull, targetHullID: null,
        hullQuantity: already ? 0 : 1, hullSourceItemID: packagedHull, requirements, unsupported: [], destructiveActions: [],
        shortages: canApply ? [] : ["A packaged target hull is unavailable at the selected source."] },
    };
  };

  const mutation = (method: string, body: any, run: () => void) => {
    writes.push({ method, body });
    if (refuse !== method) run();
    if (lost === method || refuse === method) throw Error("No response from the game transport");
    return { ok: true };
  };
  const read = async (path: string, body?: any) => {
    if (path === "/api/bridge/flight/status") return { flight: { docked: true, stationID: station, shipID: active } };
    if (path === "/api/bridge/inventory/transfer") {
      const itemID = body.itemIDs[0], hull = assembled.get(itemID);
      if (hull) {
        assert.deepEqual(body, { itemIDs: [itemID], from: { kind: "corp", division: 7 }, to: { kind: "hangar" } });
        return mutation("withdraw", body, () => {
          Object.assign(hull.root, { ownerID: pilot, locationID: station, flagID: 4 });
          for (const row of hull.contents) row.ownerID = pilot;
        });
      }
      return mutation("load", body, () => {
        assert.deepEqual(body.to, { kind: "shipBay", bay: "drone" });
        const row = stock.get(itemID)!;
        const quantity = partialLoad ? 1 : body.qty;
        row.quantity -= quantity;
        assembled.get(active)!.contents.push({ ...row, itemID: 10000 + writes.length, ownerID: pilot, locationID: active, flagID: 87, quantity });
      });
    }
    assert.equal(path, "/api/bridge/call");
    if (body.method === "InvalidateLocationCache") {
      assert.equal(body.confirm, true);
      return { result: null };
    }
    const hull = assembled.get(body.of);
    if (body.method === "List") {
      if (body.of === "hangar") return { result: list(roots(pilot)) };
      assert.ok(hull && hull.root.ownerID === pilot, "The personal List cannot prove a corporate fitting");
      return { result: hull.unreadable ? null : list(hull.contents) };
    }
    if (body.method === "GetSelfInvItem") return { result: hull ? packed(hull.root) : null };
    if (body.method === "GetAssetInventoryForLocation") {
      assert.deepEqual(body.args, [corporation, station, "offices"]);
      const contents = [...assembled.values()].filter(ship => ship.root.ownerID === corporation)
        .flatMap(ship => [ship.root, ...ship.contents]);
      return { result: { type: "object", name: "util.objectCaching.CachedMethodCallResult",
        args: [null, { type: "substream", value: { type: "objectex2", list: contents.map(packed) } }] } };
    }
    if (body.method === "Board") return mutation("board", body, () => {
      const [incoming, old] = body.args;
      assert.equal(old, active);
      assert.equal(assembled.get(incoming)?.root.ownerID, pilot);
      active = incoming;
    });
    if (body.method === "FitFitting") return mutation("fit", body, () => {
      const [hullID, hullType, byType, locationID, slots, cargo, fitRigs] = body.args;
      const [[flag, typeID]] = Object.entries(slots) as [[string, number]];
      const row = stock.get(byType[typeID][0])!;
      assert.deepEqual([hullID, hullType, body.of, locationID, row.typeID, cargo, fitRigs],
        [active, wantedHull, active, row.locationID, typeID, {}, true]);
      assert.equal(Number(flag), 92);
      assert.ok(!hull!.contents.some(item => item.flagID === Number(flag)), "Never replace a fitted module or rig");
      hull!.contents.push({ ...row, itemID: 10000 + writes.length, ownerID: pilot, locationID: active, flagID: Number(flag), quantity: 1 });
    });
    if (body.method === "Add") return mutation("fit", body, () => {
      const [itemID, locationID] = body.args, row = stock.get(itemID)!;
      assert.deepEqual([body.of, locationID, row.typeID, body.kwargs, body.confirm],
        [active, row.locationID, moduleType, { qty: 1, flag: 27 }, true]);
      const fitted = { ...row, itemID: 10000 + writes.length, ownerID: pilot, locationID: active, flagID: 27, quantity: 1 };
      if (slotChanged) hull!.contents.push({ ...fitted, itemID: 4000, typeID: moduleType + 5 });
      if (hull!.contents.some(item => item.flagID === 27)) throw Error("SLOT_OCCUPIED");
      hull!.contents.push(fitted);
    });
    assert.fail(`Unexpected method ${body.method}`);
  };
  return { read, native, writes, assembled, stock, active: () => active };
}

test("the native exact active fit remains the ready path without touching stock or boarding", async () => {
  const f = world([{ id: initialShip, fit: complete }, { id: 55, fit: complete }]);
  const { review, selection } = await reviewExistingHull(() => assert.fail("A ready active fit needs no candidate reads"), f.native());
  assert.equal(review.plan.mode, "ALREADY_SATISFIED");
  assert.equal(selection, null);
  assert.deepEqual(f.writes, []);
});

test("a ready personal ship beats an incomplete active ship and stays ahead of packaged stock", async () => {
  const f = world([{ id: initialShip, fit: complete.slice(0, 1) }, { id: 55, fit: complete }, { id: 56, fit: complete }]);
  const { review, selection } = await reviewExistingHull(f.read, f.native());
  assert.equal(selection?.itemID, 55);
  assert.equal(selection.kind, "READY");
  assert.equal(review.plan.hullQuantity, 0);
  assert.ok(review.plan.requirements.every((row: any) => row.missing === 0));
  assert.deepEqual(await applyExistingHull(f.read, review, selection), { ok: true });
  assert.equal(f.active(), 55);
  assert.deepEqual(f.writes.map(row => row.method), ["board"]);
  assert.equal(f.assembled.get(initialShip)?.root.flagID, 4);
});

test("a ready assembled ship in Division 7 is withdrawn by exact Item ID and boarded", async () => {
  const f = world([{ id: 55, corporate: true, fit: complete }, { id: 56, fit: [] }], { corporate: true, lost: "withdraw" });
  f.stock.delete(packagedHull);
  const { review, selection } = await reviewExistingHull(f.read, f.native());
  assert.ok(selection);
  assert.deepEqual(review.plan.hullSelection, { kind: "READY", origin: "corp", division: 7 });
  assert.equal(review.canApply, true);
  const before = f.assembled.get(55)!.contents.map(row => row.itemID);
  assert.deepEqual(await applyExistingHull(f.read, review, selection), { ok: true });
  assert.deepEqual(f.writes.map(row => row.method), ["withdraw", "board"]);
  assert.equal(f.active(), 55);
  assert.deepEqual(f.assembled.get(55)?.contents.map(row => row.itemID), before);
});

test("complete the current partial fit with a missing rig and two drones while retaining installed items", async () => {
  const f = world([{ id: initialShip, fit: [[moduleType, 27], [droneType, 87, 3]] }, { id: 55, fit: [] }], { lost: "fit" });
  const { review, selection } = await reviewExistingHull(f.read, f.native());
  assert.equal(selection?.itemID, initialShip);
  assert.equal(selection.kind, "PARTIAL");
  const installedModule = f.assembled.get(initialShip)!.contents[0]!.itemID;
  assert.deepEqual(selection.moves.map(row => [row.itemID, row.flag, row.quantity]), [[rigStack, 92, 1], [drones, 87, 2]]);
  assert.deepEqual(await applyExistingHull(f.read, review, selection), { ok: true });
  assert.equal(f.assembled.get(initialShip)!.contents.find(row => row.flagID === 27)?.itemID, installedModule);
  assert.deepEqual(f.writes.map(row => row.method), ["fit", "load"]);
});

test("a physically empty assembled hull is boarded and fitted in rig-first order", async () => {
  const f = world([{ id: 55, fit: [] }], { lost: "board" });
  const { review, selection } = await reviewExistingHull(f.read, f.native());
  assert.equal(selection?.kind, "EMPTY");
  assert.deepEqual(await applyExistingHull(f.read, review, selection), { ok: true });
  assert.deepEqual(f.writes.map(row => row.method), ["board", "fit", "fit", "load"]);
  assert.deepEqual(f.writes.filter(row => row.method === "fit").map(row => row.body.method), ["FitFitting", "Add"]);
  assert.equal(f.active(), 55);
});

test("an occupied wrong slot, a wrong hull type or too many drones cannot qualify; use the packaged plan", async () => {
  const f = world([{ id: 55, fit: [[moduleType + 4, 27], [rigType, 92]] }, { id: 56, fit: complete, typeID: 89240 },
    { id: 57, fit: [[droneType, 87, 6]] }]);
  const native = f.native(), result = await reviewExistingHull(f.read, native);
  assert.equal(result.review, native);
  assert.equal(result.selection, null);
  assert.equal(result.review.plan.mode, "NEW_HULL");
  assert.deepEqual(f.writes, []);
});

test("the planner compares missing actions and prefers the active ship on a tie", async () => {
  const f = world([{ id: initialShip, fit: [[droneType, 87, 5]] }, { id: 55, fit: [[moduleType, 27], [droneType, 87, 5]] },
    { id: 57, fit: [[moduleType, 27], [rigType, 92], [droneType, 87, 3]] }]);
  assert.equal((await reviewExistingHull(f.read, f.native())).selection?.itemID, initialShip);
  f.assembled.get(initialShip)!.contents[0]!.quantity = 3;
  assert.equal((await reviewExistingHull(f.read, f.native())).selection?.itemID, 55);
});

test("unreadable hull contents never authorize an empty fit or a duplicate assembly", async () => {
  const f = world([{ id: 55, fit: [], unreadable: true }]);
  const result = await reviewExistingHull(f.read, f.native());
  assert.equal(result.selection, null);
  assert.equal(result.review.canApply, false);
  assert.match(result.review.plan.unsupported.join(" "), /could not be checked/);
  assert.deepEqual(f.writes, []);
});

test("corporate Take applies to withdrawals and stock, and a ready personal hull needs no withdrawal", async () => {
  const f = world([{ id: 55, corporate: true, fit: complete }, { id: 56, fit: complete }], { corporate: true, take: false });
  const result = await reviewExistingHull(f.read, f.native());
  assert.equal(result.selection?.itemID, 56);
  assert.equal(result.selection.requiresTake, false);
  assert.equal(result.review.canApply, true);
});

test("a refused fit is read back, reports the boarded ship and stops without resending or adding drones", async () => {
  const f = world([{ id: 55, fit: [[moduleType, 27]] }], { refuse: "fit" });
  const { review, selection } = await reviewExistingHull(f.read, f.native());
  assert.ok(selection);
  const result = await applyExistingHull(f.read, review, selection);
  assert.equal(result.ok, false);
  assert.equal(result.activeShipID, 55);
  assert.match(result.reason, /equipment change could not be confirmed/);
  assert.deepEqual(f.writes.map(row => row.method), ["board", "fit"]);
});

test("a new conflicting slot after corporate Review stops before boarding or fitting", async () => {
  const f = world([{ id: 55, corporate: true, fit: [[moduleType, 27]] }], { corporate: true });
  const { review, selection } = await reviewExistingHull(f.read, f.native());
  assert.ok(selection);
  f.assembled.get(55)!.contents[0]!.typeID = moduleType + 4;
  const result = await applyExistingHull(f.read, review, selection);
  assert.equal(result.ok, false);
  assert.deepEqual(f.writes.map(row => row.method), ["withdraw"]);
  assert.match(result.reason, /fitting changed/);
});

test("a partial drone transfer is left in place; the next Review sees only the actual remainder", async () => {
  const f = world([{ id: initialShip, fit: [[moduleType, 27], [rigType, 92]] }], { lost: "load", partialLoad: true });
  const { review, selection } = await reviewExistingHull(f.read, f.native());
  assert.equal(selection?.moves[0]?.quantity, 5);
  assert.equal((await applyExistingHull(f.read, review, selection)).ok, false);
  assert.deepEqual(f.writes.map(row => row.method), ["load"]);
  const next = await reviewExistingHull(f.read, f.native());
  assert.equal(next.selection?.moves[0]?.quantity, 4);
});

test("an occupied module slot is refused without displacing the occupant even if it changed at dispatch", async () => {
  const f = world([{ id: initialShip, fit: [[rigType, 92], [droneType, 87, 5]] }], { slotChanged: true });
  const { review, selection } = await reviewExistingHull(f.read, f.native());
  assert.ok(selection);
  const result = await applyExistingHull(f.read, review, selection);
  assert.equal(result.ok, false);
  assert.match(result.reason, /SLOT_OCCUPIED/);
  assert.equal(f.assembled.get(initialShip)?.contents.find(row => row.flagID === 27)?.itemID, 4000);
  assert.deepEqual(f.writes.map(row => row.body.method), ["Add"]);
});
