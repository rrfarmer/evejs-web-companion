import test from "node:test";
import assert from "node:assert/strict";
import { createMiningFleetHost, type FleetHostServices } from "./miningHosted.ts";
import { createFleetLaunchJournal } from "./miningLaunchJournal.ts";
import type { SavedDefinition } from "./miningStore.ts";
import { assertMiningReview } from "./miningReview.ts";
const now = Date.now();
const d: SavedDefinition = {
  operationID: "op",
  revision: 1,
  createdAt: "a",
  updatedAt: "a",
  name: "Fleet",
  area: {
    anchorSystemID: 300,
    anchorSystemName: "System",
    reach: "CURRENT_SYSTEM",
    targetClasses: ["BELT"],
  },
  targetPolicy: "ANY_ELIGIBLE",
  unloadPolicy: "HAULER_SERVICE",
  unloadDestination: {
    stationID: 600,
    stationName: "Station",
    corporationDivision: 1,
    corporationID: 77,
  },
  members: [
    { characterID: 1, characterName: "one", accountName: "a", role: "MINER", automationID: "" },
    { characterID: 2, characterName: "two", accountName: "b", role: "MINER", automationID: "" },
    { characterID: 3, characterName: "three", accountName: "c", role: "HAULER", automationID: "" },
  ],
  policies: {
    version: 1,
    parking: {
      mode: "STAY_IN_PLACE",
      destination: null,
      corporationDivision: null,
      corporationID: null,
    },
    travelAssist: { mode: "DISABLED" },
    resourcePolicy: { mode: "ANY_ELIGIBLE", source: "MANUAL", typeIDs: [] },
  },
  preparation: { source: { kind: "hangar" }, suppliesRequired: false },
  oreLogistics: { version: 1, remoteCompression: false, compressedJettisonFraction: 0.5 },
};
function fixture() {
  let saved: unknown = null,
    calls: string[] = [],
    lost = false;
  const owners = new Set<number>();
  const j = createFleetLaunchJournal({
    read: () => structuredClone(saved),
    write: (v) => {
      saved = structuredClone(v);
    },
  });
  const s: FleetHostServices = {
    readDefinition: async () => structuredClone(d),
    inspect: async (m) => ({
      botID: `inspection-${m.characterID}`,
      readout: {
        characterID: m.characterID,
        shipID: 10 + m.characterID,
        systemID: 300,
        stationID: 600,
        corporationID: 77,
        officeID: 700,
        canCapacityM3: 100,
        observedAt: Date.now(),
        belts: [
          { itemID: 1, name: "Taken" },
          { itemID: 2, name: "Free" },
        ],
        fleet: { state: "not-in-fleet" },
        fitHoldQualification: {
          ORE: { miner: true, hauler: true },
          ICE: { miner: false, hauler: true },
        },
      },
    }),
    board: async () => ({
      available: true,
      targets: [{ targetKey: "BELT:300:Taken", state: "ACTIVE" }],
    }),
    parking: async () => undefined,
    confirmMoves: async () => true,
    check: async (_m, _k, setup) => ({
      setup,
      policy: { riskClasses: ["fleet"], restartSafe: false },
    }),
    review: async () => ({ planHash: "hash", candidateSupported: true }),
    before: async () => ["old"],
    journal: async (_id, cmd, body: any) => {
      if (cmd === "read") return j.read();
      if (cmd === "begin")
        return j.begin({ ...body, operationID: "op", operationRunID: "run", setupHash: "setup" });
      if (cmd === "dispatch") return j.dispatch(body.characterID);
      if (cmd === "refuse") return j.refuse(body.operationRunID, body.characterID, body);
      return j.accept(body.characterID, body.botID);
    },
    start: async (m, _setup) => {
      calls.push(`start:${m.characterID}`);
      if (lost && m.characterID === 1) throw Error("network unknown");
      owners.add(m.characterID);
      return { botID: `bot-${m.characterID}`, characterID: m.characterID, kind: m.kind };
    },
    current: async (m) =>
      owners.has(m.characterID)
        ? [
            {
              botID: `bot-${m.characterID}`,
              characterID: m.characterID,
              operationID: "op",
              operationRunID: "run",
            },
          ]
        : [],
    stop: async (m, id) => {
      calls.push(`stop:${m.characterID}:${id}`);
    },
  };
  return {
    s,
    calls,
    owners,
    lost: () => {
      lost = true;
    },
  };
}
test("actual per-member checks follow exact inspections and the first unclaimed belt", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  assert.equal(review.setup.beltID, 2);
  assert.equal(review.members.length, 3);
  const result = await host.start(review, 60);
  assert.deepEqual(
    result?.members.map((x) => x.status),
    ["ACCEPTED", "ACCEPTED", "ACCEPTED"],
  );
  assert.deepEqual(f.calls, ["start:1", "start:2", "start:3"]);
  await host.stop("op");
  assert.equal(f.calls.filter((x) => x.startsWith("stop:")).length, 3);
});
test("unknown host Start is not replayed and Stop uses only exact same-run owner", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  f.lost();
  await assert.rejects(host.start(review, 60), /network unknown/);
  f.owners.add(1);
  await host.start(review, 60);
  assert.equal((await f.s.journal("op", "read"))?.members[0]?.botID, "bot-1");
  assert.deepEqual(f.calls, ["start:1", "start:2", "start:3"]);
  await host.stop("op");
  assert.deepEqual(f.calls.slice(0, 3), ["start:1", "start:2", "start:3"]);
  assert.deepEqual(f.calls.slice(3).sort(), ["stop:1:bot-1", "stop:2:bot-2", "stop:3:bot-3"]);
});
test("unavailable board, stale definition or changed policy never dispatches", async () => {
  const f = fixture();
  f.s.board = async () => ({ available: false, targets: [] });
  await assert.rejects(createMiningFleetHost(f.s).prepare("op", "run"), /target board/);
  assert.deepEqual(f.calls, []);
});

test("a saved division is bound to the common corporation of fitted pilots at readiness", async () => {
  const f = fixture(),
    definition = structuredClone(d),
    source = { kind: "corp", division: 7 };
  definition.preparation = { source, suppliesRequired: false, replenishSupplies: true };
  definition.members[0]!.preparation = { fittingID: 4 };
  definition.members[1]!.preparation = { fittingID: 5 };
  f.s.readDefinition = async () => structuredClone(definition);
  let mixed = false;
  const inspect = f.s.inspect;
  f.s.inspect = async (member, ...args) => {
    const result = await inspect(member, ...args);
    if (mixed && member.characterID === 2) result.readout.corporationID = 78;
    return result;
  };
  f.s.catalogue = async () => ({ belts: [{ itemID: 2, name: "Free" }], canCapacityM3: 100 });
  f.s.planMember = async (member, def, runID, catalogue) => ({
    ...(await f.s.inspect(member, def, runID)).readout,
    ...catalogue,
  });
  f.s.review = async (saved, setup) => {
    assertMiningReview(saved, setup);
    return { planHash: "hash", candidateSupported: true };
  };
  const host = createMiningFleetHost(f.s);
  const planned = await host.prepare("op", "run", true);
  assert.deepEqual(
    planned.setup.startupPreparation?.map((row) => [row.characterID, row.preparation.source]),
    [
      [1, { ...source, corporationID: 77 }],
      [2, { ...source, corporationID: 77 }],
    ],
  );
  assert.deepEqual(definition.preparation.source, source);
  const altered = structuredClone(planned.setup);
  Object.assign(altered.startupPreparation![0]!.preparation.source, { division: 1 });
  assert.throws(() => assertMiningReview(definition, altered), /supply preparation changed/);

  mixed = true;
  const reviewed = await host.prepare("op", "mixed");
  assert.deepEqual(
    reviewed.setup.startupPreparation?.map((row) => row.preparation.source),
    [source, source],
  );
  assert.match(
    reviewed.launchPlan.preparation?.members?.[0]?.reason ?? "",
    /No shared player corporation/,
  );
  assert.deepEqual(f.calls, []);
});

test("Review can choose a reopened belt recorded as AVAILABLE on the board", async () => {
  const f = fixture();
  f.s.board = async () => ({
    available: true,
    targets: [
      { targetKey: "BELT:300:Taken", state: "AVAILABLE" },
      { targetKey: "BELT:300:Free", state: "DRAINING" },
    ],
  });
  const review = await createMiningFleetHost(f.s).prepare("op", "run");
  assert.equal(review.setup.beltID, 1);
  assert.deepEqual(f.calls, []);
});

test("docked launch uses WC74 named-target fallback rather than numeric belt order", async () => {
  const f = fixture(),
    inspect = f.s.inspect;
  f.s.inspect = async (...args) => {
    const proof = await inspect(...args);
    return {
      ...proof,
      readout: {
        ...proof.readout,
        belts: [
          { itemID: 2, name: "Zulu" },
          { itemID: 90, name: "Alpha" },
        ],
      },
    };
  };
  const reviewed = await createMiningFleetHost(f.s).prepare("op", "run");
  assert.equal(reviewed.setup.beltID, 90);
  assert.equal(reviewed.setup.beltName, "Alpha");
});

test("normal Review and Start admit the same ships in space, including a Hauler in the delivery system", async () => {
  const f = fixture(),
    inspect = f.s.inspect;
  const phases: string[] = [];
  f.s.inspect = async (...args) => {
    const { botID, readout } = await inspect(...args);
    phases.push(args[2]);
    return {
      botID,
      readout: {
        ...readout,
        inSpace: true,
        stationID: null,
        systemID: readout.characterID === 3 ? 301 : 300,
        targetSystemID: 300,
      },
    };
  };
  f.s.delivery = async () => ({
    kind: "station",
    destinationID: 600,
    systemID: 301,
    corporationID: 77,
    division: 1,
  });
  const host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  assert.deepEqual(
    review.inspections.map((x) => x.systemID),
    [300, 300, 301],
  );
  assert.ok(review.inspections.every((x) => x.inSpace && x.stationID === null));
  assert.equal(review.setup.delivery?.systemID, 301);
  const launched = await host.start(review, 720);
  assert.deepEqual(
    launched?.members.map((m) => m.status),
    ["ACCEPTED", "ACCEPTED", "ACCEPTED"],
  );
  assert.deepEqual(f.calls, ["start:1", "start:2", "start:3"]);
  assert.deepEqual(phases, ["run", "run", "run"]);
});

test("a retried Stop cannot touch another generation and succeeds if the original launch has just retired", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s);
  await host.start(await host.prepare("op", "run"), 60);
  await assert.rejects(host.stop("op", undefined, "prior"), /fleet generation changed/);
  f.s.journal = async () => null;
  assert.equal(await host.stop("op", undefined, "run"), null);
  assert.deepEqual(f.calls, ["start:1", "start:2", "start:3"]);
});

test("Stop never adopts a retained FINISH actor as an unresolved original Start owner", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  f.lost();
  await assert.rejects(host.start(review, 60), /network unknown/);
  f.s.current = async (m) => [
    {
      botID: "finish-" + m.characterID,
      characterID: m.characterID,
      operationID: "op",
      operationRunID: "run",
      purpose: "mcc-finish",
    },
  ];
  await assert.rejects(host.stop("op"), /Pilot 1: The current hosted controller/);
  assert.deepEqual(f.calls, [
    "start:1",
    "start:2",
    "start:3",
    "stop:2:finish-2",
    "stop:3:finish-3",
  ]);
  assert.equal((await f.s.journal("op", "read"))?.members[0]?.botID, null);
});

test("Stop retries the exact retained FINISH owner of an accepted member and reports partial dispatch", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run"),
    requested: number[] = [];
  const original = await host.start(review, 60);
  f.s.current = async (m) =>
    m.characterID === 1
      ? [
          {
            botID: "finish-1",
            characterID: 1,
            operationID: "op",
            operationRunID: "run",
            purpose: "mcc-finish",
          },
        ]
      : [];
  await assert.rejects(
    host.stop("op", (id) => requested.push(id)),
    /Pilot 2: The current hosted controller/,
  );
  assert.deepEqual(requested, [1]);
  assert.deepEqual(f.calls.slice(3), ["stop:1:finish-1"]);
  assert.deepEqual(await f.s.journal("op", "read"), original);
});

test("Stop targets the original launch roster after the saved roster is edited", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  const receipt = await host.start(review, 60);
  f.s.readDefinition = async () => ({
    ...review.definition,
    members: review.definition.members.slice(1),
  });
  await host.stop("op");
  assert.deepEqual(f.calls.filter((c) => c.startsWith("stop:")).sort(), [
    "stop:1:bot-1",
    "stop:2:bot-2",
    "stop:3:bot-3",
  ]);
  assert.deepEqual(await f.s.journal("op", "read"), receipt);
});

const fifteenPilotDefinition: SavedDefinition = {
  ...structuredClone(d),
  members: Array.from({ length: 15 }, (_, i) => ({
    ...d.members[0]!,
    characterID: i + 1,
    characterName: "Pilot " + (i + 1),
    accountName: "account-" + (i + 1),
    role: i < 8 ? ("MINER" as const) : i < 12 ? ("DEFENDER" as const) : ("HAULER" as const),
  })),
};

test("Start plans all fifteen pilots without temporary sessions and leaves an HTTP lane for Stop", async () => {
  const f = fixture(),
    inspect = f.s.inspect,
    start = f.s.start;
  f.s.readDefinition = async () => structuredClone(fifteenPilotDefinition);
  let starting = 0,
    startPeak = 0,
    temporary = 0,
    planned = 0;
  const grants: number[] = [];
  f.s.inspect = async () => {
    temporary++;
    throw Error("Start must not log in to inspect");
  };
  f.s.catalogue = async () => ({ belts: [{ itemID: 2, name: "Free" }], canCapacityM3: 100 });
  f.s.planMember = async (m, d, id, catalogue) => {
    planned++;
    const { readout } = await inspect(m, d, id);
    return { ...readout, ...catalogue, fleet: null };
  };
  f.s.start = async (...args) => {
    grants.push(args[2]);
    startPeak = Math.max(startPeak, ++starting);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await start(...args);
    } finally {
      starting--;
    }
  };
  const host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run", true);
  const result = await host.start(review, 720);
  assert.equal(result?.members.length, 15);
  assert.ok(result?.members.every((m) => m.status === "ACCEPTED"));
  assert.equal(temporary, 0);
  assert.equal(planned, 15);
  assert.equal(startPeak, 3);
  assert.equal(f.calls.length, 15);
  assert.deepEqual(grants, Array(15).fill(735));
  assert.equal(review.launchPlan.preparation?.state, "PENDING");
});

test("verified owners with pending Start replies do not strand the other thirteen pilots", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(),
    start = f.s.start;
  f.s.readDefinition = async () => structuredClone(fifteenPilotDefinition);
  let releaseReplies!: () => void;
  const replies = new Promise<void>((resolve) => {
    releaseReplies = resolve;
  });
  f.s.start = async (...args) => {
    const bot = await start(...args);
    if (bot.characterID <= 2) await replies;
    return bot;
  };
  const host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  const launched = host.start(review, 60);
  const nextTurn = () =>
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")));
  try {
    await nextTurn();
    assert.deepEqual(
      f.calls,
      fifteenPilotDefinition.members.map((m) => `start:${m.characterID}`),
    );
    assert.deepEqual(
      (await f.s.journal("op", "read"))?.members.map((m) => m.status),
      ["DISPATCHED", "DISPATCHED", ...Array(13).fill("ACCEPTED")],
    );
    t.mock.timers.tick(10_000);
    const result = await Promise.race([launched, nextTurn()]);
    assert.ok(
      result && result !== "pending",
      "the launch should finish before the first two replies arrive",
    );
    assert.deepEqual(
      result.members.map((m) => m.botID),
      fifteenPilotDefinition.members.map((m) => `bot-${m.characterID}`),
    );
    assert.deepEqual(
      f.calls,
      fifteenPilotDefinition.members.map((m) => `start:${m.characterID}`),
    );
  } finally {
    releaseReplies();
    await launched;
  }
});

test("a missing launch journal response leaves its dispatch retained and releases later pilots", async (t) => {
  const f = fixture(),
    journal = f.s.journal;
  f.s.readDefinition = async () => structuredClone(fifteenPilotDefinition);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  f.s.journal = async (id, command, body, signal) => {
    if (command !== "accept" || (body as { characterID: number }).characterID > 2)
      return journal(id, command, body);
    assert.equal(signal, deadline.signal);
    return new Promise((_, reject) =>
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
    );
  };
  const host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  const rejected = assert.rejects(host.start(review, 60), /missing journal response/);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.calls,
      fifteenPilotDefinition.members.map((m) => `start:${m.characterID}`),
    );
  } finally {
    deadline.abort(Error("missing journal response"));
  }
  await rejected;
  const receipt = await journal("op", "read");
  assert.deepEqual(
    receipt?.members.map((m) => m.status),
    ["DISPATCHED", "DISPATCHED", ...Array(13).fill("ACCEPTED")],
  );
  assert.deepEqual(
    f.calls,
    fifteenPilotDefinition.members.map((m) => `start:${m.characterID}`),
  );
});

test("confirmed Bot Host acquisition failure closes DISPATCHED without an automatic restart", async () => {
  const f = fixture(),
    start = f.s.start,
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  f.s.start = async (m, ...args) => {
    if (m.characterID === 3) {
      f.calls.push("failed:3");
      throw Object.assign(Error("Select never got a request lane."), {
        code: "BOT_START_FAILED",
        status: 502,
      });
    }
    return start(m, ...args);
  };
  await assert.rejects(host.start(review, 60), /Select never got/);
  const failed = (await f.s.journal("op", "read"))?.members[2];
  assert.equal(failed?.status, "PREPARED");
  assert.match(failed?.refusal ?? "", /Select never got/);
  assert.equal(f.calls.filter((c) => c === "failed:3").length, 1);
  f.s.start = start;
  assert.ok((await host.start(review, 60))?.members.every((m) => m.status === "ACCEPTED"));
  assert.equal(f.calls.filter((c) => c === "start:1").length, 1);
});

test("an unclassified Gateway 502 does not close or replay a dispatched Start", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  f.s.start = async () => {
    throw Object.assign(Error("Gateway response lost"), { status: 502 });
  };
  await assert.rejects(host.start(review, 60), /Gateway response lost/);
  assert.ok((await f.s.journal("op", "read"))?.members.every((m) => m.status === "DISPATCHED"));
});

test("Stop cancels preparation while independent owner reads are pending", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    reviewed = await host.prepare("op", "run"),
    pending = new Set<number>();
  let open!: () => void, all!: () => void;
  const gate = new Promise<void>((r) => {
      open = r;
    }),
    entered = new Promise<void>((r) => {
      all = r;
    });
  f.s.before = async (m) => {
    pending.add(m.characterID);
    if (pending.size === 3) all();
    await gate;
    return [];
  };
  const cancel = new AbortController(),
    start = host.start(reviewed, 60, cancel.signal);
  await entered;
  cancel.abort();
  open();
  assert.equal(await start, null);
  assert.deepEqual(f.calls, []);
});

test("Stop during concurrent acquisition stops acknowledged runs immediately and later owners once", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    reviewed = await host.prepare("op", "run"),
    original = f.s.start,
    stop = f.s.stop;
  let allowLate!: () => void, observedEarly!: () => void, stoppedEarly!: () => void;
  const late = new Promise<void>((r) => {
      allowLate = r;
    }),
    early = new Promise<void>((r) => {
      observedEarly = r;
    }),
    firstStop = new Promise<void>((r) => {
      stoppedEarly = r;
    });
  f.s.start = async (m, setup, minutes) => {
    if (m.characterID !== 1) await late;
    const started = await original(m, setup, minutes);
    if (m.characterID === 1) observedEarly();
    return started;
  };
  f.s.stop = async (m, id) => {
    await stop(m, id);
    if (m.characterID === 1) stoppedEarly();
  };
  const cancel = new AbortController(),
    start = host.start(reviewed, 60, cancel.signal);
  await early;
  cancel.abort();
  await firstStop;
  assert.deepEqual(f.calls, ["start:1", "stop:1:bot-1"]);
  allowLate();
  await start;
  assert.deepEqual(f.calls.filter((x) => x.startsWith("stop:")).sort(), [
    "stop:1:bot-1",
    "stop:2:bot-2",
    "stop:3:bot-3",
  ]);
});

test("a repeated Stop skips only the exact member already parked under this generation", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s);
  const reviewed = await host.prepare("op", "run");
  await host.start(reviewed, 60);
  const current = f.s.current;
  f.s.current = (m) => (m.characterID === 1 ? Promise.resolve([]) : current(m));
  f.s.isSettled = async (operation, run, member, bot) =>
    operation === "op" && run === "run" && member === 1 && bot === "bot-1";
  await host.stop("op");
  assert.ok(!f.calls.includes("stop:1:bot-1"));
  assert.ok(f.calls.includes("stop:2:bot-2") && f.calls.includes("stop:3:bot-3"));
  f.s.isSettled = async () => false;
  await assert.rejects(host.stop("op"), /Pilot 1: The current hosted controller/);
});

test("a slow owner lookup does not delay Stop for another exact live owner", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  await host.start(review, 60);
  let unblock!: () => void;
  const pending = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const current = f.s.current;
  f.s.current = async (member) => {
    if (member.characterID === 1) await pending;
    return current(member);
  };
  const work = host.stop("op");
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(f.calls.includes("stop:2:bot-2"));
    assert.ok(!f.calls.includes("stop:1:bot-1"));
  } finally {
    unblock();
  }
  await work;
});

test("a definite grant refusal reopens only its pilot and permits a checked retry", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run"),
    start = f.s.start;
  let refused = false;
  f.s.start = async (m, setup, minutes) => {
    if (m.characterID === 3 && !refused) {
      refused = true;
      f.calls.push("refusal:3");
      throw Object.assign(Error("Grant expired before creation."), {
        code: "BOT_GRANT_EXPIRED",
        status: 409,
      });
    }
    return start(m, setup, minutes);
  };
  const receipt = await host.start(review, 60);
  assert.ok(receipt?.members.every((m) => m.status === "ACCEPTED"));
  assert.deepEqual(f.calls.sort(), ["refusal:3", "start:1", "start:2", "start:3"]);
});

test("a failed owner read leaves only that pilot unstarted and retryable", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run"),
    before = f.s.before;
  let available = false;
  f.s.before = async (m) => {
    if (m.characterID === 3 && !available) throw Error("Hauler host roster unavailable.");
    return before(m);
  };
  await assert.rejects(host.start(review, 60), /three: Hauler host roster unavailable/);
  const receipt = await f.s.journal("op", "read");
  assert.deepEqual(
    receipt?.members.map((m) => m.status),
    ["ACCEPTED", "ACCEPTED", "PREPARED"],
  );
  assert.equal(receipt?.members[2]?.refusal, "Hauler host roster unavailable.");
  available = true;
  assert.ok((await host.start(review, 60))?.members.every((m) => m.status === "ACCEPTED"));
  assert.deepEqual(f.calls, ["start:1", "start:2", "start:3"]);
});

test("unknown hosted Start cannot retry on absence or another generation", async () => {
  const f = fixture(),
    host = createMiningFleetHost(f.s),
    review = await host.prepare("op", "run");
  f.lost();
  await assert.rejects(host.start(review, 60), /network unknown/);
  f.s.current = async (m) => [
    { botID: "unrelated", characterID: m.characterID, operationID: "op", operationRunID: "other" },
  ];
  await assert.rejects(host.start(review, 60), /previous fleet Start remains unconfirmed/);
  assert.equal(f.calls.filter((c) => c === "start:1").length, 1);
});
