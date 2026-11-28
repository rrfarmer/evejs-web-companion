import test from "node:test";
import assert from "node:assert/strict";
import { createSecurityFighter, type FighterFrame } from "./fighter.ts";
const id = {} as never;
function fixture() {
  let now = 0,
    calls: string[] = [];
  let frame: FighterFrame = {
    bay: [{ itemID: 7, quantity: 2 }],
    combatBay: [7],
    drones: [],
    combatOut: [],
    targets: [{ itemID: 42, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
  };
  const fighter = createSecurityFighter({
    now: () => now,
    read: async () => frame,
    launch: async () => {
      calls.push("launch");
    },
    engage: async (ids, t) => {
      calls.push(`engage:${ids.join(",")}:${t}`);
    },
    settle: async () => {
      calls.push("settle");
    },
  });
  return { fighter, calls, set: (f: FighterFrame) => (frame = f), time: (n: number) => (now = n) };
}
const drone = (targetID: number | null) => ({
  itemID: 8,
  controlled: true,
  targetID,
  shieldRatio: 1,
  armorRatio: 1,
  hullRatio: 1,
});
test("launches classified combat drones, engages once without lock cache, and settles before next room", async () => {
  const x = fixture();
  await x.fighter.tick(id, () => {});
  x.set({
    bay: [],
    combatBay: [],
    combatOut: [8],
    drones: [drone(null)],
    targets: [{ itemID: 42, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
  });
  await x.fighter.tick(id, () => {});
  x.set({
    bay: [],
    combatBay: [],
    combatOut: [8],
    drones: [drone(42)],
    targets: [{ itemID: 42, shieldRatio: 0.8, armorRatio: 1, hullRatio: 1 }],
  });
  await x.fighter.tick(id, () => {});
  await x.fighter.settle(() => {});
  assert.deepEqual(x.calls, ["launch", "engage:8:42", "settle"]);
});
test("uncertain drone activity and stalled damage stop instead of replaying", async () => {
  const x = fixture();
  x.set({
    bay: [],
    combatBay: [],
    combatOut: [8],
    drones: [drone(null)],
    targets: [{ itemID: 42, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
  });
  await x.fighter.tick(id, () => {});
  await assert.rejects(
    x.fighter.tick(id, () => {}),
    /no longer observable/,
  );
  assert.deepEqual(x.calls, ["engage:8:42"]);
  const y = fixture();
  y.set({
    bay: [],
    combatBay: [],
    combatOut: [8],
    drones: [drone(42)],
    targets: [{ itemID: 42, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
  });
  await y.fighter.tick(id, () => {});
  y.time(90001);
  await assert.rejects(
    y.fighter.tick(id, () => {}),
    /damage/,
  );
  assert.deepEqual(y.calls, ["engage:8:42"]);
});
test("a confirmed absent target is retired without claiming a kill or replaying its order", async () => {
  const calls: number[] = [];
  let targets = [{ itemID: 42, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }];
  const fighter = createSecurityFighter({
    now: () => 1,
    read: async () => ({ bay: [], combatBay: [], combatOut: [8], drones: [drone(null)], targets }),
    launch: async () => {},
    engage: async (_ids: readonly number[], t: number) => {
      calls.push(t);
      return t === 42 ? "target-absent" : undefined;
    },
    settle: async () => {},
  } as never);
  await fighter.tick(id, () => {});
  targets = [{ itemID: 43, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }];
  await fighter.tick(id, () => {});
  assert.deepEqual(calls, [42, 43]);
});

test("a retired target cannot be reattacked after settlement if it reappears", async () => {
  let target = 42;
  const fighter = createSecurityFighter({
    now: () => 1,
    read: async () => ({
      bay: [],
      combatBay: [],
      combatOut: [8],
      drones: [drone(null)],
      targets: [{ itemID: target, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    }),
    launch: async () => {},
    engage: async () => "target-absent" as const,
    settle: async () => {},
  });
  await fighter.tick(id, () => {});
  await fighter.settle(() => {});
  await assert.rejects(
    fighter.tick(id, () => {}),
    /reappeared/,
  );
});
test("damage reaching new lows sustains a fight beyond three minutes without reissuing", async () => {
  const x = fixture();
  const frame = (shield: number) => ({
    bay: [],
    combatBay: [],
    combatOut: [8],
    drones: [drone(42)],
    targets: [{ itemID: 42, shieldRatio: shield, armorRatio: 1, hullRatio: 1 }],
  });
  x.set(frame(1));
  await x.fighter.tick(id, () => {});
  for (const [time, shield] of [
    [80000, 0.9],
    [160000, 0.8],
    [240000, 0.7],
  ]) {
    x.time(time!);
    x.set(frame(shield!));
    await x.fighter.tick(id, () => {});
  }
  assert.deepEqual(x.calls, ["engage:8:42"]);
});
test("regeneration jitter and missing health cannot extend the no-progress deadline", async () => {
  const x = fixture();
  const frame = (shield: number | null) => ({
    bay: [],
    combatBay: [],
    combatOut: [8],
    drones: [drone(42)],
    targets: [{ itemID: 42, shieldRatio: shield, armorRatio: 1, hullRatio: 1 }],
  });
  x.set(frame(1));
  await x.fighter.tick(id, () => {});
  x.time(40000);
  x.set(frame(0.8));
  await x.fighter.tick(id, () => {});
  x.time(80000);
  x.set(frame(0.9));
  await x.fighter.tick(id, () => {});
  x.time(100000);
  x.set(frame(0.81));
  await x.fighter.tick(id, () => {});
  x.time(130001);
  x.set(frame(null));
  await assert.rejects(
    x.fighter.tick(id, () => {}),
    /damage/,
  );
  assert.deepEqual(x.calls, ["engage:8:42"]);
});

test("repeated proven pre-dispatch unavailability is bounded without native replay", async () => {
  let now = 0,
    checks = 0;
  const fighter = createSecurityFighter({
    now: () => now,
    read: async () => ({
      bay: [],
      combatBay: [],
      combatOut: [8],
      drones: [drone(null)],
      targets: [{ itemID: 42, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    }),
    launch: async () => {},
    engage: async () => {
      checks++;
      return "not-dispatched" as const;
    },
    settle: async () => {},
  });
  await fighter.tick(id, () => {});
  now = 89999;
  await fighter.tick(id, () => {});
  now = 90000;
  await assert.rejects(
    fighter.tick(id, () => {}),
    /unavailable before dispatch/,
  );
  assert.equal(checks, 3);
});

test("a non-mission identity is delivered unchanged to the shared fighter", async () => {
  const identity = { kind: "combat-anomaly" as const, instanceID: 77 };
  let observed: typeof identity | null = null;
  const fighter = createSecurityFighter<typeof identity>({
    now: () => 1,
    read: async (id) => {
      observed = id;
      return { bay: [], combatBay: [], drones: [], combatOut: [], targets: [] };
    },
    launch: async () => {},
    engage: async () => {},
    settle: async () => {},
  });
  await assert.rejects(
    fighter.tick(identity, () => {}),
    /No classified combat drones/,
  );
  assert.equal(observed, identity);
});
test("the existing target planner runs a verified weapon-only fit without launching drones", async () => {
  const calls: string[] = [];
  let health = 1;
  const fighter = createSecurityFighter({
    now: () => 0,
    read: async () => ({
      bay: [],
      combatBay: [],
      drones: [],
      combatOut: [],
      weaponIDs: [11],
      targets: [{ itemID: 42, shieldRatio: health, armorRatio: 1, hullRatio: 1 }],
    }),
    launch: async () => {
      calls.push("launch");
    },
    engage: async () => {
      calls.push("drones");
    },
    engageWeapons: async (ids, target) => {
      calls.push(`weapon:${ids[0]}:${target}`);
    },
    weaponsActive: async () => true,
    settle: async () => {},
  });
  await fighter.tick(id, () => {});
  health = 0.9;
  await fighter.tick(id, () => {});
  assert.deepEqual(calls, ["weapon:11:42"]);
});
test("a weapon fit without an effect observer cannot start", async () => {
  const fighter = createSecurityFighter({
    now: () => 0,
    read: async () => ({
      bay: [],
      combatBay: [],
      drones: [],
      combatOut: [],
      weaponIDs: [11],
      targets: [],
    }),
    launch: async () => {},
    engage: async () => {},
    engageWeapons: async () => {},
    settle: async () => {},
  });
  await assert.rejects(
    fighter.tick(id, () => {}),
    /verified weapons/,
  );
});

test("late Defender drone readback does not hold the tick open or replay its order", async () => {
  let assignment: number | null = null,
    orders = 0;
  const fighter = createSecurityFighter({
    now: () => 1000,
    prepareTarget: async () => "ready",
    read: async () => ({
      bay: [],
      combatBay: [],
      combatOut: [8],
      drones: [drone(assignment)],
      targets: [{ itemID: 42, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    }),
    launch: async () => {},
    engage: async () => {
      orders++;
      return "pending";
    },
    settle: async () => {},
  });
  assert.equal(await fighter.tick(id, () => {}), "combat-wait");
  assert.equal(await fighter.tick(id, () => {}), "combat-wait");
  assignment = 42;
  assert.equal(await fighter.tick(id, () => {}), "engaged");
  assert.equal(orders, 1);
});

test("a definite drone refusal falls back to weapons and lock loss uses the existing engagement hook", async () => {
  const calls: string[] = [];
  let launched = false,
    locked = true,
    active = false,
    attempts = 0;
  const fighter = createSecurityFighter({
    now: () => 0,
    read: async () => ({
      bay: [],
      combatBay: [],
      drones: [],
      combatOut: [],
      weaponIDs: [11],
      droneLaunch: launched ? [] : [{ itemID: 7, quantity: 2 }],
      targets: [{ itemID: 42, shieldRatio: 1, armorRatio: 1, hullRatio: 1 }],
    }),
    launch: async () => {
      launched = true;
      calls.push("launch");
      return "Not enough drone bandwidth to launch that drone.";
    },
    engage: async () => {
      assert.fail("No drone launched");
    },
    engageWeapons: async () => {
      calls.push("weapon");
      if (++attempts === 2) return "waiting-lock" as const;
      active = true;
    },
    canReacquire: async () => !locked,
    weaponsActive: async () => active,
    settle: async () => {},
  });
  assert.equal(await fighter.tick(id, () => {}), "engaged");
  active = false;
  locked = false;
  assert.equal(await fighter.tick(id, () => {}), "waiting-lock");
  assert.equal(await fighter.tick(id, () => {}), "waiting-lock");
  locked = true;
  assert.equal(await fighter.tick(id, () => {}), "engaged");
  assert.deepEqual(calls, ["launch", "weapon", "weapon", "weapon"]);
});
