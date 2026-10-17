import test from "node:test";
import assert from "node:assert/strict";
import {
  planSalvageTick,
  type SalvageAction,
  type SalvageCan,
  type SalvageModule,
  type SalvagePlan,
  type SalvagePlanInput,
  type SalvageVec,
  type SalvageWreck,
} from "./salvageSitePlan.ts";

// Synthetic ids only. The ship sits at the origin unless a test says otherwise.
const at = (x: number, y = 0, z = 0): SalvageVec => ({ x, y, z });
const STILL = at(0);

function wreck(itemID: number, x: number, over: Partial<SalvageWreck> = {}): SalvageWreck {
  return { itemID, position: at(x), lootable: false, looted: false, tractorable: true, setAside: false, ...over };
}
function can(itemID: number, x: number, over: Partial<SalvageCan> = {}): SalvageCan {
  return { itemID, position: at(x), lootable: true, looted: false, tractorable: true, ...over };
}
const mod = (moduleID: number, active = false, targetID: number | null = null): SalvageModule => ({ moduleID, active, targetID });

function input(over: Partial<SalvagePlanInput> = {}): SalvagePlanInput {
  return {
    ship: { position: at(0), velocity: STILL },
    wrecks: [],
    containers: [],
    tractors: [mod(1), mod(2)],
    salvagers: [mod(11), mod(12)],
    lockedTargetIDs: [],
    maxLockedTargets: 5,
    lockRangeM: 60_000,
    tractorRangeM: 40_000,
    salvageRangeM: 5_000,
    lootRangeM: 2_500,
    ...over,
  };
}

function act(p: SalvagePlan): SalvageAction {
  assert.ok("action" in p, `expected an action, got ${JSON.stringify(p)}`);
  return p.action;
}

test("done when nothing is left, set-aside wrecks and looted cans excluded", () => {
  const p = planSalvageTick(input({ wrecks: [wreck(100, 1000, { setAside: true })], containers: [can(200, 1000, { looted: true })] }));
  assert.ok("done" in p);
});

test("modules are started first; a lootable wreck or can in range is looted in the ticks between", () => {
  // A salvager can start on a locked wreck: that first, then the loot.
  const p = planSalvageTick(input({ wrecks: [wreck(100, 3000), wreck(101, 2000, { lootable: true })], lockedTargetIDs: [100] }));
  assert.deepEqual(act(p), { kind: "activate", moduleID: 11, targetID: 100 });
  // Every salvager busy: the other wreck is locked ahead for the next free one, and then looted meanwhile.
  const busy = [mod(11, true, 100), mod(12, true, 100)];
  const ahead = planSalvageTick(input({ wrecks: [wreck(100, 3000), wreck(101, 2000, { lootable: true })], salvagers: busy, lockedTargetIDs: [100] }));
  assert.deepEqual(act(ahead), { kind: "lock", targetID: 101 });
  const after = planSalvageTick(input({ wrecks: [wreck(100, 3000), wreck(101, 2000, { lootable: true })], salvagers: busy, lockedTargetIDs: [100], pendingLockIDs: [101] }));
  assert.deepEqual(act(after), { kind: "lootWreck", wreckID: 101, isContainer: false });
  // Nothing to start: the can is looted.
  const c = planSalvageTick(input({ containers: [can(200, 1500)], wrecks: [] }));
  assert.deepEqual(act(c), { kind: "lootWreck", wreckID: 200, isContainer: true });
});

test("every idle tractor is put to work before the loot: a fast pull never starves the other beams or the salvagers", () => {
  // Seen live: one beam pulled, the wreck was looted, the beam freed and taken again; three beams and four salvagers idle.
  const far = [wreck(300, 8_000, { lootable: true }), wreck(301, 9_000, { lootable: true }), wreck(302, 10_000, { lootable: true })];
  const near = wreck(303, 1_000, { lootable: true });
  const tractors = [mod(1, true, 300), mod(2), mod(3)];
  const p = planSalvageTick(input({ wrecks: [...far, near], tractors, salvagers: [] }));
  assert.deepEqual(act(p), { kind: "activate", moduleID: 2, targetID: 301 });
  const q = planSalvageTick(input({ wrecks: [...far, near], tractors: [mod(1, true, 300), mod(2, true, 301), mod(3)], salvagers: [] }));
  assert.deepEqual(act(q), { kind: "activate", moduleID: 3, targetID: 302 });
  // All three pulling: now the loot.
  const r = planSalvageTick(input({ wrecks: [...far, near], tractors: [mod(1, true, 300), mod(2, true, 301), mod(3, true, 302)], salvagers: [] }));
  assert.deepEqual(act(r), { kind: "lootWreck", wreckID: 303, isContainer: false });
});

test("a wreck still holding loot is salvaged without waiting for its loot: the loot goes into the can it leaves", () => {
  const p = planSalvageTick(input({ wrecks: [wreck(100, 4000, { lootable: true, tractorable: false })], lockedTargetIDs: [100], tractors: [] }));
  assert.deepEqual(act(p), { kind: "activate", moduleID: 11, targetID: 100 });
});

test("every wreck in reach is locked ahead, before any is looted, so the salvagers spread instead of piling onto one", () => {
  // Seen live 2026-10-16: wrecks pulled in, looted one by one, each locked only as a salvager came free, and all five
  // salvagers on the one wreck that was ready.
  const L = { lootable: true } as const;
  const w = [wreck(100, 1000, L), wreck(101, 1200, L), wreck(102, 1400, L), wreck(103, 1600, L), wreck(104, 1800, L)];
  const five = [mod(11), mod(12), mod(13), mod(14), mod(15)];
  let plan = planSalvageTick(input({ wrecks: w, tractors: [], salvagers: five, maxLockedTargets: 10 }));
  assert.deepEqual(act(plan), { kind: "lock", targetID: 100 });
  plan = planSalvageTick(input({ wrecks: w, tractors: [], salvagers: five, maxLockedTargets: 10, pendingLockIDs: [100, 101, 102, 103] }));
  assert.deepEqual(act(plan), { kind: "lock", targetID: 104 });
  // The locks are coming: the loot meanwhile, and no salvager doubled onto a wreck that is already locked.
  plan = planSalvageTick(input({ wrecks: w, tractors: [], salvagers: [mod(11, true, 100), mod(12), mod(13), mod(14), mod(15)], maxLockedTargets: 10,
    lockedTargetIDs: [100], pendingLockIDs: [101, 102, 103, 104] }));
  assert.deepEqual(act(plan), { kind: "lootWreck", wreckID: 100, isContainer: false });
  // Locked: one salvager each.
  plan = planSalvageTick(input({ wrecks: w, tractors: [], salvagers: [mod(11, true, 100), mod(12), mod(13), mod(14), mod(15)], maxLockedTargets: 10,
    lockedTargetIDs: [100, 101, 102, 103, 104] }));
  assert.deepEqual(act(plan), { kind: "activate", moduleID: 12, targetID: 101 });
});

test("at the lock cap with more wrecks than locks, a spare salvager doubles up rather than waiting for a lock that is not coming", () => {
  const w = [wreck(100, 1000), wreck(101, 1200), wreck(102, 1400)];
  const plan = planSalvageTick(input({ wrecks: w, tractors: [], salvagers: [mod(11, true, 100), mod(12, true, 101), mod(13)], maxLockedTargets: 2, lockedTargetIDs: [100, 101] }));
  assert.deepEqual(act(plan), { kind: "activate", moduleID: 13, targetID: 100 });
});

test("multiple salvagers get distinct locked wrecks", () => {
  const w = [wreck(100, 3000), wreck(101, 3500), wreck(102, 4000)];
  let plan = planSalvageTick(input({ wrecks: w, tractors: [], lockedTargetIDs: [100, 101, 102] }));
  assert.deepEqual(act(plan), { kind: "activate", moduleID: 11, targetID: 100 });
  plan = planSalvageTick(input({ wrecks: w, tractors: [], salvagers: [mod(11, true, 100), mod(12)], lockedTargetIDs: [100, 101, 102] }));
  assert.deepEqual(act(plan), { kind: "activate", moduleID: 12, targetID: 101 });
});

test("multiple tractors get distinct targets, nearest first, with no lock needed", () => {
  const L = { lootable: true } as const;
  const w = [wreck(100, 20_000, L), wreck(101, 12_000, L), wreck(102, 30_000, L)];
  let plan = planSalvageTick(input({ wrecks: w, salvagers: [] }));
  assert.deepEqual(act(plan), { kind: "activate", moduleID: 1, targetID: 101 });
  plan = planSalvageTick(input({ wrecks: w, salvagers: [], tractors: [mod(1, true, 101), mod(2)] }));
  assert.deepEqual(act(plan), { kind: "activate", moduleID: 2, targetID: 100 });
});

test("a wreck we may only salvage is never tractored", () => {
  const plan = planSalvageTick(input({ wrecks: [wreck(100, 20_000, { tractorable: false })], salvagers: [mod(11, true, 999)] }));
  assert.ok("wait" in plan || act(plan).kind !== "activate");
});

test("a tractor whose target has arrived inside loot range is deactivated (after looting)", () => {
  const w = [wreck(100, 2400, { lootable: true, looted: true }), wreck(101, 30_000, { lootable: true })];
  const plan = planSalvageTick(input({ wrecks: w, tractors: [mod(1, true, 100), mod(2)], salvagers: [] }));
  assert.deepEqual(act(plan), { kind: "deactivate", moduleID: 1 });
});

test("locks go to salvagers only and the cap is respected, counting pending", () => {
  const w = [wreck(100, 3000), wreck(101, 3500)];
  assert.deepEqual(act(planSalvageTick(input({ wrecks: w, tractors: [], maxLockedTargets: 2 }))), { kind: "lock", targetID: 100 });
  const full = planSalvageTick(input({ wrecks: w, tractors: [], maxLockedTargets: 1, lockedTargetIDs: [100], salvagers: [mod(11), mod(12)] }));
  // 100 is locked and wanted by the first salvager; the second wants 101 but the cap is full and 100 is in use.
  assert.deepEqual(act(full), { kind: "activate", moduleID: 11, targetID: 100 });
  const pendingFull = planSalvageTick(input({ wrecks: w, tractors: [], maxLockedTargets: 1, pendingLockIDs: [100] }));
  assert.ok("wait" in pendingFull, "the pending lock holds the whole budget");
  assert.ok(!("action" in pendingFull));
});

test("at the cap a lock nothing wants is released for a wanted wreck", () => {
  const w = [wreck(100, 3000), wreck(555, 3200)];
  const plan = planSalvageTick(input({ wrecks: [w[0]!], tractors: [], lockedTargetIDs: [555, 556], maxLockedTargets: 2, salvagers: [mod(11)] }));
  assert.deepEqual(act(plan), { kind: "unlock", targetID: 555 });
});

test("unknown tractor target counts as busy and claims the nearest pulled wreck", () => {
  const moving = wreck(100, 10_000, { velocity: at(-500), lootable: true });
  const other = wreck(101, 15_000, { lootable: true });
  // one tractor busy (unknown), one idle: the idle one must take 101, not the wreck already coming in
  const plan = planSalvageTick(input({ wrecks: [moving, other], salvagers: [], tractors: [mod(1, true, null), mod(2)] }));
  assert.deepEqual(act(plan), { kind: "activate", moduleID: 2, targetID: 101 });
});

test("unknown salvager target counts as busy: it is not handed another wreck", () => {
  const plan = planSalvageTick(input({ wrecks: [wreck(100, 3000)], tractors: [], salvagers: [mod(11, true, null)], lockedTargetIDs: [100] }));
  assert.ok("wait" in plan);
});

test("far from everything: moves to the station covering the densest cluster", () => {
  // Cluster A of 2 at x=100km, cluster B of 5 at y=-120km. Tractor reach 40km, margin 1km.
  const w: SalvageWreck[] = [wreck(1, 100_000), { ...wreck(2, 100_000), position: at(100_000, 3000) }];
  for (let i = 0; i < 5; i++) w.push({ ...wreck(10 + i, 0), position: at(0, -120_000 + i * 2000) });
  const plan = planSalvageTick(input({ wrecks: w }));
  const a = act(plan);
  assert.equal(a.kind, "gotoPoint");
  if (a.kind === "gotoPoint") assert.ok(a.position.y < -100_000, `went to ${JSON.stringify(a.position)}`);
});

test("no oscillation between two equal clusters: it commits, then finishes one before the other", () => {
  const w: SalvageWreck[] = [];
  for (let i = 0; i < 3; i++) w.push({ ...wreck(10 + i, 0), position: at(100_000 + i * 1000) });
  for (let i = 0; i < 3; i++) w.push({ ...wreck(20 + i, 0), position: at(-100_000 - i * 1000) });
  const first = act(planSalvageTick(input({ wrecks: w })));
  assert.equal(first.kind, "gotoPoint");
  if (first.kind !== "gotoPoint") return;
  // En route, ship nearer the OTHER cluster's side by a hair would flip a naive planner: the commitment holds.
  const enRoute = planSalvageTick(input({ wrecks: w, ship: { position: at(first.position.x * 0.5), velocity: at(first.position.x > 0 ? 300 : -300) }, committedAnchor: first.position }));
  assert.ok("wait" in enRoute, JSON.stringify(enRoute));
  // Arrived, cluster 1 is in reach: it works, never moves.
  const arrived = planSalvageTick(input({ wrecks: w, ship: { position: first.position, velocity: STILL }, committedAnchor: first.position }));
  assert.notEqual(act(arrived).kind, "gotoPoint");
});

test("never moves while a module is active or work is in reach", () => {
  const far = [wreck(100, 200_000)];
  // A spare salvager doubles up on the wreck in reach; the ship does not fly off.
  const busy = planSalvageTick(input({ wrecks: [...far, wreck(101, 3000)], tractors: [], salvagers: [mod(11, true, 101), mod(12)], lockedTargetIDs: [101] }));
  assert.deepEqual(act(busy), { kind: "activate", moduleID: 12, targetID: 101 });
  const both = planSalvageTick(input({ wrecks: [...far, wreck(101, 3000)], tractors: [], salvagers: [mod(11, true, 101), mod(12, true, 101)], lockedTargetIDs: [101] }));
  assert.ok("wait" in both);
  const idleWithWork = planSalvageTick(input({ wrecks: [...far, wreck(101, 3000)], tractors: [], salvagers: [mod(11, true, 101)], lockedTargetIDs: [101] }));
  assert.ok("wait" in idleWithWork);
});

test("a salvage-only hull (no tractors) closes on a far wreck", () => {
  const plan = planSalvageTick(input({ wrecks: [wreck(100, 50_000)], tractors: [] }));
  assert.equal(act(plan).kind, "gotoPoint");
});

test("spare salvagers double up: five salvagers on three wrecks run 2/2/1, the least-worked wreck first", () => {
  const w = [wreck(100, 3000), wreck(101, 3500), wreck(102, 4000)];
  const locks = [100, 101, 102];
  // Three busy on the three wrecks, two idle: the fourth goes on the nearest wreck with one.
  let salvagers = [mod(11, true, 100), mod(12, true, 101), mod(13, true, 102), mod(14), mod(15)];
  let plan = planSalvageTick(input({ wrecks: w, tractors: [], salvagers, lockedTargetIDs: locks }));
  assert.deepEqual(act(plan), { kind: "activate", moduleID: 14, targetID: 100 });
  // The fifth goes on the next wreck with only one, not on the one that already has two.
  salvagers = [mod(11, true, 100), mod(12, true, 101), mod(13, true, 102), mod(14, true, 100), mod(15)];
  plan = planSalvageTick(input({ wrecks: w, tractors: [], salvagers, lockedTargetIDs: locks }));
  assert.deepEqual(act(plan), { kind: "activate", moduleID: 15, targetID: 101 });
  // A wreck in reach with nobody on it still comes first: no doubling while one is free.
  const free = [...w, wreck(103, 2000)];
  plan = planSalvageTick(input({ wrecks: free, tractors: [], salvagers: [mod(11, true, 100), mod(12, true, 101), mod(13, true, 102), mod(14)], lockedTargetIDs: [...locks, 103] }));
  assert.deepEqual(act(plan), { kind: "activate", moduleID: 14, targetID: 103 });
  // A wreck not yet locked is locked for its own salvager rather than doubling elsewhere.
  plan = planSalvageTick(input({ wrecks: free, tractors: [], salvagers: [mod(11, true, 100), mod(12, true, 101), mod(13, true, 102), mod(14)], lockedTargetIDs: locks }));
  assert.deepEqual(act(plan), { kind: "lock", targetID: 103 });
});

test("a tractor whose pull has stalled is switched off, to be taken again", () => {
  const w = [wreck(100, 8_000, { lootable: true })];
  const plan = planSalvageTick(input({ wrecks: w, tractors: [mod(1, true, 100)], salvagers: [], stalledTractorIDs: [1] }));
  assert.deepEqual(act(plan), { kind: "deactivate", moduleID: 1 });
});
