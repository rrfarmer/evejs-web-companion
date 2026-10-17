import test from "node:test";
import assert from "node:assert/strict";
import { createTravelAssist, type TravelAssistInput } from "./travelAssist.ts";
import type { SpaceSnapshot } from "../store/types.ts";
import type { PropulsionModule } from "./propulsion.ts";

// The salvager's scope has no mining target in it: step path only. The approached
// entity or point is the assist's own key.
const ab: PropulsionModule = { itemID: 2, typeID: 439, kind: "afterburner" };
const mwd: PropulsionModule = { itemID: 1, typeID: 440, kind: "microwarpdrive" };
const SCOPE = "salvager:0";
function world(over: Partial<TravelAssistInput> = {}, x = 50_000, active: number[] = []): TravelAssistInput {
  return { enabled: true, scope: SCOPE, action: { kind: "approach", targetID: 10 }, inWarp: false, docked: false, modules: [ab], scrammed: false,
    snapshot: { inSpace: true, shipID: 9, solarSystemID: 30000142, sampledAtMs: 1, ship: { position: { x: 0, y: 0, z: 0 }, radius: 100, activeModuleIDs: active, capacitorRatio: 1 },
      entities: [{ itemID: 10, position: { x, y: 0, z: 0 }, radius: 100 }] } as unknown as SpaceSnapshot, ...over };
}
function harness() {
  const changes: { module: PropulsionModule; on: boolean }[] = [];
  const assist = createTravelAssist({ change: async (module, on) => { changes.push({ module, on }); return true; }, log: () => {} });
  return { assist, changes };
}
const point = (x: number) => ({ kind: "gotoPoint", position: { x, y: 0, z: 0 } });

test("salvager: a far wreck approach lights the afterburner", async () => {
  const h = harness();
  assert.equal(await h.assist.beforeAction(world()), true);
  assert.deepEqual(h.changes, [{ module: ab, on: true }]);
});

test("salvager: a near wreck approach does not light it", async () => {
  const h = harness();
  assert.equal(await h.assist.beforeAction(world({}, 8_000)), false);
  assert.deepEqual(h.changes, []);
});

test("salvager: off on arrival, and while closing it stays on without flapping", async () => {
  const h = harness();
  await h.assist.beforeAction(world());
  await h.assist.beforeAction(world({}, 20_000, [2]));
  assert.deepEqual(h.changes.map(c => c.on), [true]);
  assert.equal(await h.assist.beforeAction(world({ action: { kind: "wait" } }, 3_000, [2])), true);
  assert.deepEqual(h.changes.map(c => c.on), [true, false]);
  assert.equal(h.assist.pending(), false);
});

test("salvager: a switch to the next wreck, a salvager cycle, a warp or a dock turns it off", async () => {
  for (const change of [{ action: { kind: "approach", targetID: 11 } }, { action: { kind: "activate" } }, { action: { kind: "warpToBookmark" } },
    { action: { kind: "dock" } }, { inWarp: true }, { docked: true }, { enabled: false, scope: null }]) {
    const h = harness();
    await h.assist.beforeAction(world());
    await h.assist.beforeAction(world(change as Partial<TravelAssistInput>, 50_000, [2]));
    assert.deepEqual(h.changes.map(c => c.on), [true, false], JSON.stringify(change));
  }
});

test("salvager: no fitted propulsion changes nothing", async () => {
  const h = harness();
  assert.equal(await h.assist.beforeAction(world({ modules: [] })), false);
  assert.deepEqual(h.changes, []);
});

test("salvager: scrammed lights an afterburner but never a microwarpdrive, and drops an owned one", async () => {
  const a = harness();
  await a.assist.beforeAction(world({ scrammed: true }));
  assert.deepEqual(a.changes.map(c => c.module.kind), ["afterburner"]);
  const m = harness();
  await m.assist.beforeAction(world({ modules: [mwd], scrammed: true }));
  assert.deepEqual(m.changes, []);
  const owned = harness();
  await owned.assist.beforeAction(world({ modules: [mwd] }));
  await owned.assist.beforeAction(world({ modules: [mwd], scrammed: true }, 50_000, [1]));
  assert.deepEqual(owned.changes.map(c => c.on), [true, false]);
});

test("salvager: a propulsion module the pilot already runs is left alone", async () => {
  const h = harness();
  await h.assist.beforeAction(world({}, 50_000, [2]));
  assert.deepEqual(h.changes, []);
});

test("salvager: gotoPoint far lights it, near does not, and arrival or a new point ends it", async () => {
  const near = harness();
  assert.equal(await near.assist.beforeAction(world({ action: point(8_000) })), false);
  assert.deepEqual(near.changes, []);
  const h = harness();
  assert.equal(await h.assist.beforeAction(world({ action: point(60_000) })), true);
  await h.assist.beforeAction(world({ action: point(60_000) }, 50_000, [2]));
  assert.deepEqual(h.changes.map(c => c.on), [true]);
  await h.assist.beforeAction(world({ action: point(2_000) }, 50_000, [2]));
  assert.deepEqual(h.changes.map(c => c.on), [true, false]);
  const moved = harness();
  await moved.assist.beforeAction(world({ action: point(60_000) }));
  await moved.assist.beforeAction(world({ action: point(90_000) }, 50_000, [2]));
  assert.deepEqual(moved.changes.map(c => c.on), [true, false]);
});

// Work while moving: the salvager interleaves module work with a long leg.
const work = (action: TravelAssistInput["action"], x: number, active: number[] = [2], over: Partial<TravelAssistInput> = {}) =>
  world({ action, workWhileMoving: true, ...over }, x, active);
test("salvager: lock, activate, loot and unlock ticks keep a lit approach owned without flapping", async () => {
  const h = harness();
  await h.assist.beforeAction(world({ workWhileMoving: true }));
  for (const action of [{ kind: "lock", targetID: 11 }, { kind: "activate", moduleID: 30, targetID: 11 }, { kind: "lootWreck" }, { kind: "lootContainer" },
    { kind: "unlock", targetID: 11 }, { kind: "deactivate", moduleID: 30 }, { kind: "salvageDrones" }, { kind: "launchDrones" }, { kind: "recallDrones" }, { kind: "wait" }]) {
    assert.equal(await h.assist.beforeAction(work(action, 40_000)), false, action.kind);
  }
  assert.deepEqual(h.changes.map(c => c.on), [true]);
});
test("salvager: arrival during an activate tick turns it off", async () => {
  const h = harness();
  await h.assist.beforeAction(world({ workWhileMoving: true }));
  // Off, and the activate still goes: a salvager's tick is never taken by its prop.
  assert.equal(await h.assist.beforeAction(work({ kind: "activate", moduleID: 30, targetID: 11 }, 3_000)), false);
  assert.deepEqual(h.changes.map(c => c.on), [true, false]);
});
test("salvager: a work tick never lights the prop; activating the propulsion module itself is not work", async () => {
  const h = harness();
  assert.equal(await h.assist.beforeAction(work({ kind: "activate", moduleID: 30, targetID: 11 }, 50_000, [])), false);
  assert.deepEqual(h.changes, []);
  const p = harness();
  await p.assist.beforeAction(world({ workWhileMoving: true }));
  await p.assist.beforeAction(work({ kind: "deactivate", moduleID: 2 }, 40_000));
  assert.deepEqual(p.changes.map(c => c.on), [true, false]);
});
test("salvager: a new gotoPoint re-keys through work ticks, and a warp or dock still ends it", async () => {
  const h = harness();
  await h.assist.beforeAction(world({ action: point(60_000), workWhileMoving: true }));
  await h.assist.beforeAction(work({ kind: "lootWreck" }, 50_000));
  assert.deepEqual(h.changes.map(c => c.on), [true]);
  await h.assist.beforeAction(work(point(90_000), 50_000));
  assert.deepEqual(h.changes.map(c => c.on), [true, false]);
  for (const kind of ["warp", "dock", "undock", "stopShip", "jump"]) {
    const w = harness();
    await w.assist.beforeAction(world({ workWhileMoving: true }));
    await w.assist.beforeAction(work({ kind, targetID: 10 }, 50_000));
    assert.deepEqual(w.changes.map(c => c.on), [true, false], kind);
  }
});
test("salvager: the leg target vanishing from the scene ends it during work ticks", async () => {
  const h = harness();
  await h.assist.beforeAction(world({ workWhileMoving: true }));
  const gone = work({ kind: "lootWreck" }, 50_000);
  await h.assist.beforeAction({ ...gone, snapshot: { ...gone.snapshot!, entities: [] } });
  assert.deepEqual(h.changes.map(c => c.on), [true, false]);
});

test("salvager: lighting or ending the prop never swallows the tick's own order to fly on", async () => {
  // Seen live 2026-10-14: the order to fly to the next spot was dropped each time the prop came on or off.
  const h = harness();
  assert.equal(await h.assist.beforeAction(world({ action: point(60_000), workWhileMoving: true })), false, "lit, and the gotoPoint still goes");
  assert.deepEqual(h.changes.map((c) => c.on), [true]);
  assert.equal(await h.assist.beforeAction(world({ action: point(90_000), workWhileMoving: true }, 50_000, [2])), false, "ended for a new spot, and that gotoPoint still goes");
  assert.deepEqual(h.changes.map((c) => c.on), [true, false]);
});

test("salvager: the next spot worked out again a few metres on is the same leg, so the prop stays lit", async () => {
  const h = harness();
  await h.assist.beforeAction(world({ action: point(60_000), workWhileMoving: true }));
  for (const x of [60_003, 59_996, 60_450, 60_900]) {
    await h.assist.beforeAction(world({ action: point(x), workWhileMoving: true }, 50_000, [2]));
  }
  assert.deepEqual(h.changes.map((c) => c.on), [true]);
});
