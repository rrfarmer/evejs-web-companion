import test from "node:test";
import assert from "node:assert/strict";
import { createTargetBoard, targetKey, type SynchronousStore, type Target } from "./targetBoard.ts";
import { memoryOperationStore } from "./operationStoreFixture.ts";
import { createOperation, type JetcanProof, type Member } from "./operation.ts";
function memory(): SynchronousStore {
  let data: unknown = null;
  return {
    read: () => (data === null ? null : structuredClone(data)),
    write: (v) => {
      data = structuredClone(v);
    },
  };
}
const belt: Target = { kind: "BELT", systemID: 300, name: "Asteroid Belt 1" };
const crew: Member[] = [
  { characterID: 1, shipID: 11, role: "MINER" },
  { characterID: 2, shipID: 12, role: "MINER" },
  { characterID: 3, shipID: 13, role: "HAULER" },
  { characterID: 4, shipID: 14, role: "COMMAND" },
];
const def = { operationID: "op", runID: "run", systemID: 300, destinationID: 600, members: crew };

test("Stop during belt departure can settle after the original reservation expires", () => {
  let clock = 1000;
  const now = () => clock,
    board = createTargetBoard(memory(), now, 100),
    op = createOperation(memoryOperationStore(), board, def, now);
  assert.ok(op.reserve(1, belt));
  clock += 101;
  const other = board.reserve("other", "other-run", belt);
  assert.ok(other);
  op.noteStopRequest("RETURN_HOME");
  op.requestStop();
  assert.equal(op.snapshot().state, "SETTLING");
  assert.equal(op.snapshot().claim, null);
  assert.deepEqual(board.read(other.key)?.claim, other);
});

test("Collect Freight can scan the depleted belt if Stop interrupts a pending belt change", () => {
  const now = () => 1000,
    board = createTargetBoard(memory(), now),
    op = createOperation(memoryOperationStore(), board, def, now);
  const old = op.reserve(1, belt)!;
  assert.ok(op.activate(1));
  assert.ok(op.prepareRelocation(1, old, { kind: "BELT", systemID: 300, name: "Next" }, 99));
  assert.ok(op.drainRelocation(true));
  assert.equal(op.snapshot().state, "SETTLING");
  op.noteStopRequest("COLLECT_FREIGHT");
  assert.ok(op.cancelRelocation());
  assert.equal(op.snapshot().state, "DRAINING");
  assert.ok(op.canDiscoverGridFreight(3, old, true));
  assert.equal(op.canDiscoverGridFreight(3, { ...old, runID: "previous" }, true), false);
  assert.ok(
    op.registerGridJetcan(
      3,
      old,
      {
        containerID: 900,
        ownerID: 1,
        observedAt: now(),
        capacityM3: 100,
        items: [{ itemID: 901, typeID: 30, quantity: 10, unitVolumeM3: 1, freightKind: "RAW" }],
      },
      true,
    ),
  );
  assert.ok(op.claimContainer(3, 900));
});

test("RESERVING relocation recovery releases only an unused own reservation and fences a quarantined next target", () => {
  for (const quarantine of [false, true]) {
    let clock = 1000;
    const store = memoryOperationStore(),
      board = createTargetBoard(memory(), () => clock, 100),
      op = createOperation(store, board, def, () => clock);
    op.reserve(1, belt);
    op.activate(1);
    const old = op.snapshot().claim!,
      next: Target = { kind: "BELT", systemID: 300, name: "Next" };
    assert.ok(op.prepareRelocation(1, old, next));
    assert.ok(op.drainRelocation());
    for (const m of crew)
      assert.ok(
        op.settleMember(m.characterID, {
          source: "native-settlement",
          runID: "run",
          shipID: m.shipID,
          modulesInactive: true,
          dronesSafe: true,
          observedAt: clock,
        }),
      );
    assert.ok(board.releaseDrained(old, { allMembersSettledInPlace: true, freightSettled: true }));
    const raw = op.snapshot();
    store.write({
      ...raw,
      claim: null,
      relocation: {
        ...raw.relocation,
        phase: "RESERVING",
        proofs: crew.map((m) => ({
          characterID: m.characterID,
          shipID: m.shipID,
          source: "native-flight",
          systemID: 300,
          inSpace: false,
          docked: true,
          observedAt: clock,
        })),
      },
    });
    const claim = board.reserve("op", "run", next)!;
    if (quarantine) {
      board.activate(claim);
      clock += 101;
      assert.equal(board.read(claim.key)?.state, "QUARANTINED");
    }
    const retained = createOperation(store, board, def, () => clock);
    assert.equal(retained.cancelRelocation(), !quarantine);
    assert.equal(board.read(claim.key)?.state, quarantine ? "QUARANTINED" : undefined);
    assert.equal(!!retained.snapshot().relocation, quarantine);
  }
});

test("retained lease restoration drains exact recorded owners but never adopts unowned legacy quarantine", () => {
  let clock = 1000;
  const board = createTargetBoard(memory(), () => clock, 100),
    claim = board.reserve("op", "run", belt)!;
  board.activate(claim);
  clock = 1200;
  assert.equal(board.resumeDraining({ ...claim, runID: "foreign" }), null);
  const resumed = board.resumeDraining(claim)!;
  assert.equal(resumed.generation, claim.generation);
  assert.equal(board.read(claim.key)?.state, "DRAINING");
  clock = 1400;
  assert.equal(board.read(claim.key)?.state, "QUARANTINED");
  assert.equal(board.resumeDraining({ ...claim, runID: "foreign" }), null);
  assert.ok(board.resumeDraining(claim));
  assert.throws(() => board.activate(claim), /not activeable/);
  const legacy = memory();
  legacy.write({
    version: 1,
    generation: claim.generation,
    entries: { [claim.key]: { target: belt, state: "QUARANTINED", claim: null, depletion: null } },
  });
  assert.equal(createTargetBoard(legacy, () => clock).resumeDraining(claim), null);
});
test("claims are exclusive, generation fenced, and expired active sites are quarantined", () => {
  let now = 1000;
  const board = createTargetBoard(memory(), () => now, 100),
    first = board.reserve("op", "run", belt)!;
  assert.ok(first);
  assert.equal(board.reserve("other", "run", belt), null);
  now += 101;
  const second = board.reserve("other", "run", belt)!;
  assert.ok(second.generation > first.generation);
  assert.equal(board.activate(first), false);
  assert.equal(board.activate(second), true);
  now += 101;
  assert.equal(board.reserve("third", "run", belt), null);
  assert.equal(board.read(targetKey(belt))?.state, "QUARANTINED");
});
test("ore anomaly claims require exact instance and finite position", () => {
  assert.equal(
    targetKey({
      kind: "ICE",
      systemID: 3,
      name: "ice",
      siteID: 8,
      instanceID: 9,
      position: { x: 1, y: 2, z: 3 },
    }),
    "ICE:3:site:8:instance:9",
  );
  assert.throws(() =>
    targetKey({
      kind: "ICE",
      systemID: 3,
      name: "ice",
      siteID: 8,
      instanceID: 9,
      position: { x: NaN, y: 2, z: 3 },
    }),
  );
});
test("two miners share one claimed target; mixed freight and stale provenance are refused", () => {
  const now = () => 1000,
    board = createTargetBoard(memory(), now),
    op = createOperation(memoryOperationStore(), board, def, now);
  assert.equal(op.reserve(3, belt), null);
  const c = op.reserve(1, belt)!;
  assert.ok(c);
  assert.equal(op.activate(1), true);
  for (const m of crew) assert.equal(op.assignment(m.characterID)?.claim?.generation, c.generation);
  const proof: JetcanProof = {
    source: "native-jetcan",
    operationID: "op",
    runID: "run",
    targetKey: c.key,
    claimGeneration: c.generation,
    characterID: 1,
    shipID: 11,
    systemID: 300,
    containerID: 100,
    intentGeneration: 1,
    observedAt: 1000,
    capacityM3: 100,
    items: [{ itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW", unitVolumeM3: 1 }],
  };
  const facts = {
    30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 },
    31: { categoryID: 25, freightKind: "COMPRESSED" as const, unitVolumeM3: 0.1 },
  };
  const source = {
    source: "checked-ship-holds" as const,
    characterID: 1,
    shipID: 11,
    systemID: 300,
    targetKey: c.key,
    claimGeneration: c.generation,
    observedAt: 1000,
    items: proof.items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 5 })),
  };
  const intent = op.prepareJetcan(1, proof.items, proof.capacityM3, facts, source)!;
  assert.equal(intent.generation, 1);
  assert.equal(op.dispatchJetcan(1, intent.generation), true);
  assert.equal(op.dispatchJetcan(1, intent.generation), false);
  assert.equal(op.registerJetcan({ ...proof, claimGeneration: c.generation + 1 }, facts), false);
  assert.equal(
    op.registerJetcan(
      {
        ...proof,
        items: [
          ...proof.items,
          { itemID: 21, typeID: 31, quantity: 5, freightKind: "COMPRESSED", unitVolumeM3: 0.1 },
        ],
      },
      facts,
    ),
    false,
  );
  assert.equal(op.registerJetcan(proof, facts), true);
  assert.equal(op.registerJetcan(proof, facts), false);
  assert.deepEqual(op.assignment(4)?.manifests, []);
  assert.equal(op.claimContainer(4, 100), null);
  const compressed = {
    ...proof,
    characterID: 2,
    shipID: 12,
    containerID: 101,
    intentGeneration: 2,
    items: [
      {
        itemID: 21,
        typeID: 31,
        quantity: 5,
        freightKind: "COMPRESSED" as const,
        unitVolumeM3: 0.1,
      },
    ],
  };
  assert.equal(
    op.prepareJetcan(2, compressed.items, compressed.capacityM3, facts, {
      ...source,
      characterID: 2,
      shipID: 12,
      items: compressed.items.map((i) => ({ ...i, ownerID: 2, locationID: 12, flagID: 5 })),
    })?.generation,
    2,
  );
  assert.equal(op.dispatchJetcan(2, 2), true);
  assert.equal(op.registerJetcan(compressed, facts), true);
  assert.deepEqual(
    op.snapshot().manifests.map((x) => x.category),
    ["RAW", "COMPRESSED"],
  );
});
test("Stop drains exact claimed freight, settles every pilot, and releases only after all dock", () => {
  const now = () => 1000,
    board = createTargetBoard(memory(), now),
    store = memoryOperationStore(),
    op = createOperation(store, board, def, now),
    c = op.reserve(1, belt)!;
  op.activate(1);
  const proof: JetcanProof = {
    source: "native-jetcan",
    operationID: "op",
    runID: "run",
    targetKey: c.key,
    claimGeneration: c.generation,
    characterID: 1,
    shipID: 11,
    systemID: 300,
    containerID: 100,
    intentGeneration: 1,
    observedAt: 1000,
    capacityM3: 100,
    items: [{ itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW", unitVolumeM3: 1 }],
  };
  const facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
  assert.equal(
    op.prepareJetcan(1, proof.items, proof.capacityM3, facts, {
      source: "checked-ship-holds",
      characterID: 1,
      shipID: 11,
      systemID: 300,
      targetKey: c.key,
      claimGeneration: c.generation,
      observedAt: 1000,
      items: proof.items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 5 })),
    })?.generation,
    1,
  );
  assert.equal(op.dispatchJetcan(1, 1), true);
  assert.equal(op.registerJetcan(proof, facts), true);
  op.requestStop();
  assert.equal(op.assignment(1)?.targetGranted, false);
  assert.equal(op.assignment(1)?.target, null);
  assert.equal(op.assignment(3)?.deliverOnly, true);
  assert.equal(op.claimContainer(1, 100), null);
  const claim = op.claimContainer(3, 100)!;
  assert.ok(claim);
  assert.equal(op.dispatchHaul(3, 100, claim.generation), true);
  assert.equal(op.dispatchHaul(3, 100, claim.generation), false);
  assert.equal(
    op.settleMember(3, {
      source: "native-settlement",
      runID: "run",
      shipID: 13,
      modulesInactive: true,
      dronesSafe: true,
      observedAt: 1000,
    }),
    false,
  );
  assert.equal(
    op.settleMember(1, {
      source: "native-settlement",
      runID: "run",
      shipID: 11,
      modulesInactive: true,
      dronesSafe: true,
      observedAt: 1000,
    }),
    true,
  );
  assert.equal(
    op.parkMember(1, {
      source: "native-flight",
      runID: "run",
      shipID: 11,
      locationID: 600,
      docked: true,
      observedAt: 1000,
    }),
    true,
  );
  assert.equal(op.snapshot().state, "DRAINING");
  assert.ok(board.read(c.key)?.claim);
  const evidence = {
    source: "native-transfer" as const,
    operationID: "op",
    runID: "run",
    containerID: 100,
    claimGeneration: claim.generation,
    shipID: 13,
    destinationID: 600,
    sourceAfter: [],
    destinationBefore: [{ typeID: 30, quantity: 5 }],
    destinationAfter: [{ typeID: 30, quantity: 15 }],
    observedAt: 1000,
  };
  assert.equal(op.markDelivered(3, { ...evidence, destinationID: 601 }), false);
  assert.equal(
    op.markDelivered(3, { ...evidence, destinationAfter: [{ typeID: 30, quantity: 14 }] }),
    false,
  );
  const row = (
    itemID: number,
    quantity: number,
    ownerID: number,
    locationID: number,
    flagID: number,
    typeID = 30,
  ) => ({ itemID, typeID, quantity, ownerID, locationID, flagID, categoryID: 25 });
  const batch1 = {
    item: { itemID: 201, typeID: 30, quantity: 6 },
    sourceBefore: [row(201, 6, 3, 13, 134)],
    sourceAfter: [],
    destinationBefore: [],
    destinationAfter: [row(301, 6, 77, 700, 115)],
  };
  const batch2 = {
    item: { itemID: 202, typeID: 30, quantity: 4 },
    sourceBefore: [row(202, 4, 3, 13, 134)],
    sourceAfter: [],
    destinationBefore: [row(301, 16, 77, 700, 115)],
    destinationAfter: [row(301, 20, 77, 700, 115)],
  };
  const interleaved = {
    ...evidence,
    destinationBefore: [],
    destinationAfter: [{ typeID: 30, quantity: 20 }],
    deliveryBatches: [batch1, batch2],
  };
  assert.equal(
    op.markDelivered(3, { ...interleaved, destinationAfter: [{ typeID: 30, quantity: 19 }] }),
    false,
  );
  assert.equal(
    op.markDelivered(3, {
      ...interleaved,
      deliveryBatches: [batch1, { ...batch2, item: { ...batch2.item, itemID: 201 } }],
    }),
    false,
  );
  assert.equal(
    op.markDelivered(3, {
      ...interleaved,
      deliveryBatches: [batch1, { ...batch2, sourceBefore: [row(202, 4, 9, 13, 134)] }],
    }),
    false,
  );
  assert.equal(
    op.markDelivered(3, {
      ...interleaved,
      deliveryBatches: [
        batch1,
        {
          ...batch2,
          destinationAfter: [row(301, 20, 77, 700, 115), row(302, 1, 77, 700, 115, 31)],
        },
      ],
    }),
    false,
  );
  assert.equal(op.markDelivered(3, interleaved), true);
  assert.equal(op.snapshot().state, "SETTLING");
  assert.deepEqual(store.readDelivery(100)?.receipt, interleaved);
  assert.equal(op.snapshot().manifests[0]?.deliveredAt, interleaved.observedAt);
  for (const m of crew)
    assert.equal(
      op.settleMember(m.characterID, {
        source: "native-settlement",
        runID: "run",
        shipID: m.shipID,
        modulesInactive: true,
        dronesSafe: true,
        observedAt: now(),
      }),
      true,
    );
  assert.equal(op.snapshot().state, "PARKING");
  for (const m of crew)
    assert.equal(
      op.parkMember(m.characterID, {
        source: "native-flight",
        runID: "run",
        shipID: m.shipID,
        locationID: 600,
        docked: true,
        observedAt: 1000,
      }),
      true,
    );
  assert.equal(op.snapshot().state, "STOPPED");
  assert.equal(board.read(c.key), null);
});
test("exact quarantined target is released only after native settlement and parking", () => {
  let clock = 1000;
  const board = createTargetBoard(memory(), () => clock, 100),
    op = createOperation(memoryOperationStore(), board, def, () => clock),
    c = op.reserve(1, belt)!;
  op.activate(1);
  clock += 101;
  assert.equal(op.assignment(1)?.targetGranted, false);
  op.requestStop();
  assert.equal(op.snapshot().state, "SETTLING");
  for (const m of crew)
    op.settleMember(m.characterID, {
      source: "native-settlement",
      runID: "run",
      shipID: m.shipID,
      modulesInactive: true,
      dronesSafe: true,
      observedAt: clock,
    });
  for (const m of crew.slice(0, -1))
    op.parkMember(m.characterID, {
      source: "native-flight",
      runID: "run",
      shipID: m.shipID,
      locationID: 600,
      docked: true,
      observedAt: clock,
    });
  assert.equal(board.read(c.key)?.state, "QUARANTINED");
  assert.equal(
    op.parkMember(4, {
      source: "native-flight",
      runID: "run",
      shipID: 14,
      locationID: 600,
      docked: true,
      observedAt: clock,
    }),
    true,
  );
  assert.equal(op.snapshot().state, "STOPPED");
  assert.equal(board.read(c.key), null);
});

test("dispatched jetcan uncertainty survives restart and blocks replay and stop completion", () => {
  const now = () => 1000,
    boardStore = memory(),
    opStore = memoryOperationStore(),
    board = createTargetBoard(boardStore, now),
    op = createOperation(opStore, board, def, now),
    c = op.reserve(1, belt)!;
  op.activate(1);
  const items = [
      { itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
    ],
    facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
  const source = {
    source: "checked-ship-holds" as const,
    characterID: 1,
    shipID: 11,
    systemID: 300,
    targetKey: c.key,
    claimGeneration: c.generation,
    observedAt: 1000,
    items: items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 5 })),
  };
  const intent = op.prepareJetcan(1, items, 100, facts, source)!;
  assert.equal(op.dispatchJetcan(1, intent.generation), true);
  const recovered = createOperation(opStore, createTargetBoard(boardStore, now), def, now);
  assert.equal(recovered.dispatchJetcan(1, intent.generation), false);
  assert.equal(recovered.cancelPreparedJetcan(1, intent.generation), false);
  recovered.requestStop();
  assert.equal(recovered.snapshot().state, "DRAINING");
  assert.equal(recovered.assignment(1)?.productiveReady, false);
});
test("expired belt reuse preserves a dispatched inventory intent and fences its replay", () => {
  let clock = 1000;
  const now = () => clock,
    opStore = memoryOperationStore(),
    board = createTargetBoard(memory(), now, 100, () => true);
  const old = createOperation(opStore, board, def, now),
    claim = old.reserve(1, belt)!;
  assert.ok(old.activate(1));
  const items = [
    { itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
  ];
  const facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
  const source = {
    source: "checked-ship-holds" as const,
    characterID: 1,
    shipID: 11,
    systemID: 300,
    targetKey: claim.key,
    claimGeneration: claim.generation,
    observedAt: clock,
    items: items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 5 })),
  };
  const intent = old.prepareJetcan(1, items, 100, facts, source)!;
  assert.ok(old.dispatchJetcan(1, intent.generation));
  old.noteStopRequest("RETURN_HOME");
  old.requestStop();
  clock += 101;
  const next = board.reserve("other", "new", belt)!;
  assert.ok(board.activate(next));
  const restored = createOperation(opStore, board, def, now);
  assert.equal(restored.resumeStopping(), true);
  assert.equal(restored.heartbeat(), true);
  assert.equal(restored.dispatchJetcan(1, intent.generation), false);
  assert.equal(restored.cancelPreparedJetcan(1, intent.generation), false);
  assert.equal(restored.completeStop(), false);
  assert.equal(restored.snapshot().jetcanIntents["1"]?.dispatched, true);
  assert.deepEqual(board.read(claim.key)?.claim, next);
});

test("Return Home finishes physical parking after an expired belt has a new owner", () => {
  let clock = 1000;
  const now = () => clock,
    board = createTargetBoard(memory(), now, 100, () => true);
  const old = createOperation(memoryOperationStore(), board, def, now),
    claim = old.reserve(1, belt)!;
  assert.ok(old.activate(1));
  old.noteStopRequest("RETURN_HOME");
  old.requestStop();
  clock += 101;
  const next = board.reserve("other", "new", belt)!;
  assert.ok(board.activate(next));
  assert.ok(old.resumeStopping());
  for (const m of crew) {
    assert.ok(
      old.settleMember(m.characterID, {
        source: "native-settlement",
        runID: "run",
        shipID: m.shipID,
        modulesInactive: true,
        dronesSafe: true,
        observedAt: clock,
      }),
    );
    assert.ok(
      old.parkMember(m.characterID, {
        source: "native-flight",
        runID: "run",
        shipID: m.shipID,
        locationID: 600,
        docked: true,
        observedAt: clock,
      }),
    );
  }
  assert.equal(old.snapshot().state, "STOPPED");
  assert.deepEqual(board.read(claim.key)?.claim, next);
});

test("undispatched jetcan intent is cancellable after Stop without inventing a container", () => {
  const now = () => 1000,
    board = createTargetBoard(memory(), now),
    store = memoryOperationStore(),
    op = createOperation(store, board, def, now),
    c = op.reserve(1, belt)!;
  op.activate(1);
  const items = [
      { itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
    ],
    facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
  const source = {
    source: "checked-ship-holds" as const,
    characterID: 1,
    shipID: 11,
    systemID: 300,
    targetKey: c.key,
    claimGeneration: c.generation,
    observedAt: 1000,
    items: items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 5 })),
  };
  const intent = op.prepareJetcan(1, items, 100, facts, source)!;
  op.requestStop();
  assert.equal(op.snapshot().state, "DRAINING");
  assert.equal(op.dispatchJetcan(1, intent.generation), false);
  assert.equal(op.cancelPreparedJetcan(1, intent.generation), true);
  assert.equal(op.snapshot().state, "SETTLING");
  assert.equal(op.snapshot().manifests.length, 0);
});

test("a failed durable claim write grants nothing", () => {
  const backing = memory();
  let fail = true;
  const board = createTargetBoard(
    {
      read: backing.read,
      write: (value) => {
        if (fail) throw Error("storage failure");
        backing.write(value);
      },
    },
    () => 1000,
  );
  assert.throws(() => board.reserve("op", "run", belt), /storage failure/);
  assert.equal(board.read(targetKey(belt)), null);
  fail = false;
  assert.ok(board.reserve("op", "run", belt));
});
test("a parked observation must follow that pilot's native settlement", () => {
  const now = () => 2000,
    board = createTargetBoard(memory(), now),
    op = createOperation(memoryOperationStore(), board, def, now);
  op.requestStop();
  for (const m of crew)
    assert.equal(
      op.settleMember(m.characterID, {
        source: "native-settlement",
        runID: "run",
        shipID: m.shipID,
        modulesInactive: true,
        dronesSafe: true,
        observedAt: 1900,
      }),
      true,
    );
  assert.equal(
    op.parkMember(1, {
      source: "native-flight",
      runID: "run",
      shipID: 11,
      locationID: 600,
      docked: true,
      observedAt: 1800,
    }),
    false,
  );
  assert.equal(
    op.parkMember(1, {
      source: "native-flight",
      runID: "other",
      shipID: 11,
      locationID: 600,
      docked: true,
      observedAt: 2000,
    }),
    false,
  );
  assert.equal(
    op.parkMember(1, {
      source: "native-flight",
      runID: "run",
      shipID: 11,
      locationID: 600,
      docked: true,
      observedAt: 2000,
    }),
    true,
  );
});
import { createStockPilotReads } from "./nativeAdapters.ts";
test("stock read adapter fences a replaced held pilot or retired session", () => {
  let generation = 1,
    online = 1,
    closing = false;
  const session: any = {
    flow: { flying: { sessionGeneration: () => generation, isSessionClosing: () => closing } },
    store: { station: { get: () => ({ online: { characterID: online } }) } },
  };
  const reads = createStockPilotReads(
    { characterID: 1, baseUrl: "http://bff", fetch: fetch },
    session,
  );
  assert.doesNotThrow(() => reads.current());
  generation++;
  assert.throws(() => reads.current(), /custody/);
  generation = 1;
  online = 2;
  assert.throws(() => reads.current(), /custody/);
  online = 1;
  closing = true;
  assert.throws(() => reads.current(), /custody/);
});

test("self-unload roster keeps target until both exact final raw holds settle", () => {
  const now = () => 1000,
    board = createTargetBoard(memory(), now),
    members = crew.slice(0, 2),
    store = memoryOperationStore();
  assert.throws(
    () => createOperation(memoryOperationStore(), board, { ...def, members }, now),
    /Roster/,
  );
  const op = createOperation(store, board, { ...def, members, haulMode: "SELF_UNLOAD" }, now);
  assert.ok(op.reserve(1, belt));
  assert.equal(op.activate(1), true);
  assert.throws(() => op.requestStop(), /final raw hold/i);
  assert.equal(
    op.recordSelfUnloadFinal(1, {
      source: "native-self-unload",
      runID: "run",
      shipID: 11,
      rawRemaining: [],
      observedAt: 1000,
    }),
    true,
  );
  assert.throws(() => op.requestStop(), /final raw hold/i);
  assert.equal(
    op.recordSelfUnloadFinal(2, {
      source: "native-self-unload",
      runID: "run",
      shipID: 12,
      rawRemaining: [1],
      observedAt: 1000,
    }),
    false,
  );
  assert.equal(
    op.recordSelfUnloadFinal(2, {
      source: "native-self-unload",
      runID: "run",
      shipID: 12,
      rawRemaining: [],
      observedAt: 1000,
    }),
    true,
  );
  op.requestStop();
  assert.equal(op.snapshot().state, "SETTLING");
  for (const m of members)
    assert.equal(
      op.settleMember(m.characterID, {
        source: "native-settlement",
        runID: "run",
        shipID: m.shipID,
        modulesInactive: true,
        dronesSafe: true,
        observedAt: 1000,
      }),
      true,
    );
  for (const m of members)
    assert.equal(
      op.parkMember(m.characterID, {
        source: "native-flight",
        runID: "run",
        shipID: m.shipID,
        locationID: 600,
        docked: true,
        observedAt: 1000,
      }),
      true,
    );
  assert.equal(op.snapshot().state, "STOPPED");
  assert.equal(op.snapshot().claim, null);
  assert.deepEqual(op.snapshot().manifests, []);
});
test("Stop before activation settles a self-unload miner without claiming old cargo was delivered", () => {
  const members: Member[] = [{ characterID: 1, shipID: 11, role: "MINER" }],
    now = () => 1000;
  const op = createOperation(
    memoryOperationStore(),
    createTargetBoard(memory(), now),
    { ...def, members, haulMode: "SELF_UNLOAD" },
    now,
  );
  op.requestStop();
  assert.equal(
    op.settleMember(1, {
      source: "native-settlement",
      runID: "run",
      shipID: 11,
      modulesInactive: true,
      dronesSafe: true,
      observedAt: now(),
    }),
    true,
  );
  assert.equal(op.snapshot().state, "PARKING");
  assert.equal(op.snapshot().selfUnloadFinal, undefined);
  assert.deepEqual(op.snapshot().manifests, []);
});
test("stay-in-place releases only after each exact member is physically settled without pretending to dock", () => {
  let now = 10000;
  const board = createTargetBoard(memory(), () => now),
    members: Member[] = [
      { characterID: 1, shipID: 11, role: "MINER" },
      { characterID: 2, shipID: 12, role: "MINER" },
      { characterID: 3, shipID: 13, role: "HAULER" },
    ],
    op = createOperation(
      memoryOperationStore(),
      board,
      {
        operationID: "stay",
        runID: "run",
        systemID: 300,
        destinationID: 600,
        members,
        stopMode: "STAY_IN_PLACE",
      },
      () => now,
    );
  assert.ok(op.reserve(1, belt));
  assert.equal(op.activate(1), true);
  op.requestStop();
  for (const m of members)
    assert.equal(
      op.settleMember(m.characterID, {
        source: "native-settlement",
        runID: "run",
        shipID: m.shipID,
        modulesInactive: true,
        dronesSafe: true,
        observedAt: now,
      }),
      true,
    );
  assert.equal(op.snapshot().state, "PARKING");
  assert.equal(
    op.stayMember(1, {
      source: "native-flight",
      runID: "run",
      shipID: 99,
      systemID: 300,
      inSpace: true,
      docked: false,
      observedAt: now,
    }),
    false,
  );
  for (const m of members)
    assert.equal(
      op.stayMember(m.characterID, {
        source: "native-flight",
        runID: "run",
        shipID: m.shipID,
        systemID: 300,
        inSpace: true,
        docked: false,
        observedAt: now,
      }),
      true,
    );
  assert.equal(op.snapshot().state, "STOPPED");
  assert.deepEqual(op.snapshot().parked, []);
  assert.deepEqual(op.snapshot().stayed, [1, 2, 3]);
  assert.equal(board.read(targetKey(belt)), null);
});
test("in-place proof cannot bypass an unfinished freight or unsafe member settlement", () => {
  let now = 10000;
  const board = createTargetBoard(memory(), () => now),
    members: Member[] = [
      { characterID: 1, shipID: 11, role: "MINER" },
      { characterID: 2, shipID: 12, role: "MINER" },
      { characterID: 3, shipID: 13, role: "HAULER" },
    ],
    op = createOperation(
      memoryOperationStore(),
      board,
      {
        operationID: "stay-fence",
        runID: "run",
        systemID: 300,
        destinationID: 600,
        members,
        stopMode: "STAY_IN_PLACE",
      },
      () => now,
    );
  assert.ok(op.reserve(1, belt));
  assert.equal(op.activate(1), true);
  op.requestStop();
  assert.equal(
    op.stayMember(1, {
      source: "native-flight",
      runID: "run",
      shipID: 11,
      systemID: 300,
      inSpace: true,
      docked: false,
      observedAt: now,
    }),
    false,
  );
  assert.notEqual(op.snapshot().state, "STOPPED");
});

test("personal delivery requires exact owned hangar batch proof", () => {
  const now = () => 1000,
    board = createTargetBoard(memory(), now),
    op = createOperation(
      memoryOperationStore(),
      board,
      {
        ...def,
        delivery: {
          kind: "structure",
          destinationID: 600,
          systemID: 300,
          corporationID: null,
          division: null,
        },
      },
      now,
    ),
    c = op.reserve(1, belt)!;
  op.activate(1);
  const items = [
      { itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
    ],
    facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } };
  const proof: JetcanProof = {
    source: "native-jetcan",
    operationID: "op",
    runID: "run",
    targetKey: c.key,
    claimGeneration: c.generation,
    characterID: 1,
    shipID: 11,
    systemID: 300,
    containerID: 100,
    intentGeneration: 1,
    observedAt: 1000,
    capacityM3: 100,
    items,
  };
  assert.ok(
    op.prepareJetcan(1, items, 100, facts, {
      source: "checked-ship-holds",
      characterID: 1,
      shipID: 11,
      systemID: 300,
      targetKey: c.key,
      claimGeneration: c.generation,
      observedAt: 1000,
      items: items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 5 })),
    }),
  );
  assert.ok(op.dispatchJetcan(1, 1));
  assert.ok(op.registerJetcan(proof, facts));
  const claim = op.claimContainer(3, 100)!;
  assert.ok(op.dispatchHaul(3, 100, claim.generation));
  const row = (itemID: number, ownerID: number, locationID: number, flagID: number) => ({
    itemID,
    typeID: 30,
    quantity: 10,
    ownerID,
    locationID,
    flagID,
    categoryID: 25,
  });
  const evidence = {
    source: "native-transfer" as const,
    operationID: "op",
    runID: "run",
    containerID: 100,
    claimGeneration: claim.generation,
    shipID: 13,
    destinationID: 600,
    sourceAfter: [],
    destinationBefore: [],
    destinationAfter: [row(21, 3, 600, 4)],
    observedAt: 1000,
  };
  const batch = {
    item: { itemID: 20, typeID: 30, quantity: 10 },
    sourceBefore: [row(20, 3, 13, 134)],
    sourceAfter: [],
    destinationBefore: [],
    destinationAfter: [row(21, 3, 600, 4)],
  };
  assert.equal(op.markDelivered(3, evidence), false);
  assert.equal(
    op.markDelivered(3, {
      ...evidence,
      deliveryBatches: [{ ...batch, destinationAfter: [row(21, 77, 600, 4)] }],
    }),
    false,
  );
  assert.equal(op.markDelivered(3, { ...evidence, deliveryBatches: [batch] }), true);
});
const commandCaps = { characterID: 4, selfMining: true, tractor: true, collect: false };
test("COMMAND producer is enabled only by exact persisted capability and tractor custody stays exclusive until native inactivity", () => {
  let now = 1000;
  const store = memoryOperationStore(),
    board = createTargetBoard(memory(), () => now),
    definition = { ...def, commandCapabilities: commandCaps },
    op = createOperation(store, board, definition, () => now),
    c = op.reserve(1, belt)!;
  op.activate(1);
  const items = [
      { itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
    ],
    facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } },
    source = {
      source: "checked-ship-holds" as const,
      characterID: 4,
      shipID: 14,
      systemID: 300,
      targetKey: c.key,
      claimGeneration: c.generation,
      observedAt: now,
      items: items.map((i) => ({ ...i, ownerID: 4, locationID: 14, flagID: 5 })),
    };
  const intent = op.prepareJetcan(4, items, 100, facts, source)!;
  assert.ok(intent);
  assert.equal(op.dispatchJetcan(4, intent.generation), true);
  const proof: JetcanProof = {
    source: "native-jetcan",
    operationID: "op",
    runID: "run",
    targetKey: c.key,
    claimGeneration: c.generation,
    characterID: 4,
    shipID: 14,
    systemID: 300,
    containerID: 100,
    intentGeneration: intent.generation,
    observedAt: now,
    capacityM3: 100,
    items,
  };
  assert.equal(op.registerJetcan(proof, facts), true);
  assert.equal(op.claimContainer(4, 100), null);
  assert.equal(op.claimContainer(4, 100, "tractor"), null);
  const binding = { moduleID: 501, typeID: 502, botID: "command-run", sessionGeneration: 7 },
    claim = op.claimContainer(4, 100, "tractor", binding)!;
  assert.ok(claim);
  assert.equal(op.claimContainer(4, 100, "tractor", { ...binding, moduleID: 999 }), null);
  assert.equal(
    createOperation(store, board, definition, () => now).snapshot().haulClaims["100"]?.purpose,
    "tractor",
  );
  assert.equal(op.claimContainer(3, 100), null);
  assert.equal(op.dispatchHaul(4, 100, claim.generation), false);
  const delivery = {
    source: "native-transfer" as const,
    operationID: "op",
    runID: "run",
    containerID: 100,
    claimGeneration: claim.generation,
    shipID: 14,
    destinationID: 600,
    sourceAfter: [],
    destinationBefore: [],
    destinationAfter: [{ typeID: 30, quantity: 10 }],
    observedAt: now,
  };
  assert.equal(op.markDelivered(4, delivery), false);
  const inactive = {
    version: 1,
    identity: {
      operationID: "op",
      runID: "run",
      botID: "command-run",
      sessionGeneration: 7,
      characterID: 4,
      shipID: 14,
      moduleID: 501,
      typeID: 502,
      flagID: 27,
      canID: 100,
      systemID: 300,
      claimGeneration: claim.generation,
      targetGeneration: c.generation,
    },
    qualification: { typeID: 502, effectID: 99, effectName: "tractorBeamCan" },
    activation: null,
    active: null,
    deactivation: null,
    inactive: {
      at: now,
      module: {
        moduleID: 501,
        typeID: 502,
        ownerID: 4,
        shipID: 14,
        flagID: 27,
        timeFiletime: "134385165369180001",
        wallclockFiletime: "134385165369179999",
        effects: [],
        activeTargets: [],
      },
    },
  };
  assert.equal(
    op.releaseTractor(4, 100, claim.generation, {
      ...inactive,
      identity: { ...inactive.identity, moduleID: 999 },
    }),
    false,
  );
  assert.equal(
    op.releaseTractor(4, 100, claim.generation, {
      ...inactive,
      identity: { ...inactive.identity, botID: "foreign" },
    }),
    false,
  );
  assert.equal(
    op.releaseTractor(4, 100, claim.generation, {
      ...inactive,
      activation: { issuedAt: now, acknowledged: false },
      active: null,
    }),
    false,
  );
  assert.equal(
    op.releaseTractor(4, 100, claim.generation, {
      ...inactive,
      inactive: {
        ...inactive.inactive,
        module: { ...inactive.inactive.module, effects: [{ effectID: 99 }] },
      },
    }),
    false,
  );
  assert.equal(op.releaseTractor(4, 100, claim.generation, inactive), true);
  assert.ok(op.claimContainer(3, 100));
  assert.equal(op.snapshot().manifests[0]?.delivered, false);
  assert.throws(
    () =>
      createOperation(
        store,
        board,
        { ...definition, commandCapabilities: { ...commandCaps, tractor: false } },
        () => now,
      ),
    /custody/,
  );
});
test("COMMAND collection needs explicit policy and cannot bypass hauler ledger", () => {
  const board = createTargetBoard(memory(), () => 1000),
    op = createOperation(
      memoryOperationStore(),
      board,
      { ...def, commandCapabilities: { ...commandCaps, collect: true } },
      () => 1000,
    ),
    c = op.reserve(1, belt)!;
  op.activate(1);
  const items = [
      { itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
    ],
    facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } },
    src = {
      source: "checked-ship-holds" as const,
      characterID: 1,
      shipID: 11,
      systemID: 300,
      targetKey: c.key,
      claimGeneration: c.generation,
      observedAt: 1000,
      items: items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 5 })),
    },
    intent = op.prepareJetcan(1, items, 100, facts, src)!;
  op.dispatchJetcan(1, intent.generation);
  op.registerJetcan(
    {
      source: "native-jetcan",
      operationID: "op",
      runID: "run",
      targetKey: c.key,
      claimGeneration: c.generation,
      characterID: 1,
      shipID: 11,
      systemID: 300,
      containerID: 100,
      intentGeneration: intent.generation,
      observedAt: 1000,
      capacityM3: 100,
      items,
    },
    facts,
  );
  const binding = { moduleID: 501, typeID: 502, botID: "command-run", sessionGeneration: 7 },
    tractor = op.claimContainer(4, 100, "tractor", binding)!;
  assert.equal(op.dispatchHaul(4, 100, tractor.generation), false);
  assert.equal(
    op.markDelivered(4, {
      source: "native-transfer",
      operationID: "op",
      runID: "run",
      containerID: 100,
      claimGeneration: tractor.generation,
      shipID: 14,
      destinationID: 600,
      sourceAfter: [],
      destinationBefore: [],
      destinationAfter: [{ typeID: 30, quantity: 10 }],
      observedAt: 1000,
    }),
    false,
  );
  const inactive = {
    version: 1,
    identity: {
      operationID: "op",
      runID: "run",
      botID: "command-run",
      sessionGeneration: 7,
      characterID: 4,
      shipID: 14,
      moduleID: 501,
      typeID: 502,
      flagID: 27,
      canID: 100,
      systemID: 300,
      claimGeneration: tractor.generation,
      targetGeneration: c.generation,
    },
    qualification: { typeID: 502, effectID: 99, effectName: "tractorBeamCan" },
    activation: null,
    active: null,
    deactivation: null,
    inactive: {
      at: 1000,
      module: {
        moduleID: 501,
        typeID: 502,
        ownerID: 4,
        shipID: 14,
        flagID: 27,
        timeFiletime: "134385165369180001",
        wallclockFiletime: "134385165369179999",
        effects: [],
        activeTargets: [],
      },
    },
  };
  assert.equal(op.releaseTractor(4, 100, tractor.generation, inactive), true);
  const claim = op.claimContainer(4, 100)!;
  assert.ok(claim);
  assert.equal(op.claimContainer(3, 100), null);
  assert.equal(op.dispatchHaul(4, 100, claim.generation), true);
  assert.equal(
    op.markDelivered(4, {
      source: "native-transfer",
      operationID: "op",
      runID: "run",
      containerID: 100,
      claimGeneration: claim.generation,
      shipID: 14,
      destinationID: 600,
      sourceAfter: [],
      destinationBefore: [],
      destinationAfter: [{ typeID: 30, quantity: 10 }],
      observedAt: 1000,
    }),
    true,
  );
});
test("self-mining COMMAND needs fresh empty own hold receipt after Stop before settlement", () => {
  const board = createTargetBoard(memory(), () => 1000),
    store = memoryOperationStore(),
    definition = {
      ...def,
      commandCapabilities: { characterID: 4, selfMining: true, tractor: false, collect: false },
    },
    op = createOperation(store, board, definition, () => 1000),
    claim = op.reserve(1, belt)!;
  op.activate(1);
  op.requestStop();
  const settled = {
    source: "native-settlement" as const,
    runID: "run",
    shipID: 14,
    modulesInactive: true,
    dronesSafe: true,
    observedAt: 1000,
  };
  assert.equal(op.settleMember(4, settled), false);
  const proof = {
    source: "native-command-mining-final" as const,
    runID: "run",
    shipID: 14,
    rawRemaining: [],
    observedAt: 1000,
  };
  assert.equal(op.recordCommandMiningFinal(4, { ...proof, shipID: 99 }), false);
  assert.equal(op.recordCommandMiningFinal(4, { ...proof, rawRemaining: [{ typeID: 1 }] }), false);
  assert.equal(op.recordCommandMiningFinal(4, proof), true);
  assert.equal(op.settleMember(4, settled), true);
  assert.equal(
    createOperation(store, board, definition, () => 1000).snapshot().commandMiningFinal
      ?.characterID,
    4,
  );
});

test("relocation drains old custody and physically settled roster before reserving next generation", () => {
  const now = () => 1000,
    store = memoryOperationStore(),
    board = createTargetBoard(memory(), now),
    op = createOperation(store, board, def, now),
    old = op.reserve(1, belt)!;
  assert.ok(op.activate(1));
  const next = { kind: "BELT" as const, systemID: 300, name: "Belt 2" };
  assert.equal(op.prepareRelocation(1, { ...old, generation: old.generation + 1 }, next), false);
  assert.equal(op.prepareRelocation(1, old, next), true);
  assert.equal(op.relocateAfterSettlement([]), false);
  assert.equal(op.drainRelocation(), true);
  for (const m of crew)
    assert.equal(
      op.settleMember(m.characterID, {
        source: "native-settlement",
        runID: "run",
        shipID: m.shipID,
        modulesInactive: true,
        dronesSafe: true,
        observedAt: 1000,
      }),
      true,
    );
  const proofs = crew.map((m) => ({
    source: "native-flight" as const,
    characterID: m.characterID,
    shipID: m.shipID,
    systemID: 300,
    inSpace: true,
    docked: false,
    observedAt: 1000,
  }));
  assert.equal(op.relocateAfterSettlement(proofs.slice(1)), false);
  assert.ok(board.read(old.key)?.claim);
  assert.equal(op.relocateAfterSettlement(proofs), true);
  assert.equal(board.read(old.key), null);
  const fresh = op.snapshot().claim!;
  assert.equal(fresh.key, targetKey(next));
  assert.ok(fresh.generation > old.generation);
  assert.equal(op.snapshot().state, "READY");
  assert.equal(op.activate(1), true);
  assert.equal(op.assignment(1)?.claim?.key, fresh.key);
  assert.ok(createOperation(store, board, def, now));
});

for (const depleted of [false, true])
  test(`emergency dock survives ${depleted ? "depleted-belt rotation" : "site relocation"} and reloading the record`, () => {
    const now = () => 1000,
      store = memoryOperationStore(),
      board = createTargetBoard(memory(), now),
      op = createOperation(store, board, def, now);
    const old = op.reserve(1, belt)!;
    assert.ok(old && op.activate(1));
    const next: Target = { kind: "BELT", systemID: 300, name: "Belt 2" };
    assert.ok(op.prepareRelocation(2, old, next, depleted ? 99 : undefined));
    assert.ok(op.drainRelocation());
    const moving = crew.filter((m) => m.characterID !== 1 && (!depleted || m.role !== "HAULER"));
    for (const m of moving)
      assert.ok(
        op.settleMember(m.characterID, {
          source: "native-settlement",
          runID: "run",
          shipID: m.shipID,
          modulesInactive: true,
          dronesSafe: true,
          observedAt: now(),
        }),
      );
    assert.equal(op.snapshot().state, "SETTLING");
    const emergency = {
      source: "native-capsule-dock" as const,
      runID: "run",
      shipID: 901,
      locationID: 600,
      docked: true,
      observedAt: now(),
    };
    assert.equal(op.parkMember(1, emergency), false);
    assert.equal(op.parkMember(1, { ...emergency, locationID: 601 }, true), false);
    assert.equal(op.parkMember(1, emergency, true), true);
    assert.equal(op.snapshot().state, "PARKING");
    assert.equal(op.snapshot().stopRequested, undefined);
    assert.deepEqual(
      op.movingMembers().map((m) => m.characterID),
      moving.map((m) => m.characterID),
    );
    assert.ok(
      op.relocateAfterSettlement(
        moving.map((m) => ({
          source: "native-flight",
          characterID: m.characterID,
          shipID: m.shipID,
          systemID: 300,
          inSpace: true,
          docked: false,
          observedAt: now(),
        })),
      ),
    );
    assert.ok(op.activate(2));
    const restored = createOperation(store, board, def, now);
    assert.deepEqual(restored.snapshot().parked, [1]);
    assert.deepEqual(restored.snapshot().settled, [1]);
    assert.equal(restored.assignment(1)?.targetGranted, false);
    assert.equal(restored.assignment(2)?.target?.name, next.name);
  });

test("Stop can cancel relocation while an occupied next target is pending", () => {
  const now = () => 1000,
    board = createTargetBoard(memory(), now),
    op = createOperation(memoryOperationStore(), board, def, now),
    old = op.reserve(1, belt)!;
  op.activate(1);
  const next = { kind: "BELT" as const, systemID: 300, name: "Belt 2" };
  assert.ok(op.prepareRelocation(1, old, next));
  assert.ok(board.reserve("other", "other", next));
  assert.ok(op.drainRelocation());
  for (const m of crew)
    assert.ok(
      op.settleMember(m.characterID, {
        source: "native-settlement",
        runID: "run",
        shipID: m.shipID,
        modulesInactive: true,
        dronesSafe: true,
        observedAt: 1000,
      }),
    );
  const proofs = crew.map((m) => ({
    source: "native-flight" as const,
    characterID: m.characterID,
    shipID: m.shipID,
    systemID: 300,
    inSpace: true,
    docked: false,
    observedAt: 1000,
  }));
  assert.equal(op.relocateAfterSettlement(proofs), false);
  assert.equal(op.snapshot().relocation?.phase, "RESERVING");
  assert.equal(op.snapshot().claim, null);
  assert.equal(op.cancelRelocation(), true);
  assert.equal(op.snapshot().state, "PARKING");
  assert.equal(op.snapshot().relocation, undefined);
});

test("collected compression receipt conserves original can quantity into exact delivered output", () => {
  const now = () => 1000,
    board = createTargetBoard(memory(), now),
    op = createOperation(
      memoryOperationStore(),
      board,
      {
        ...def,
        commandCapabilities: { characterID: 4, selfMining: false, tractor: true, collect: true },
      },
      now,
    ),
    claim = op.reserve(1, belt)!;
  op.activate(1);
  const items = [
      { itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 },
    ],
    facts = { 30: { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3: 1 } },
    src = {
      source: "checked-ship-holds" as const,
      characterID: 1,
      shipID: 11,
      systemID: 300,
      targetKey: claim.key,
      claimGeneration: claim.generation,
      observedAt: 1000,
      items: items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 5 })),
    },
    intent = op.prepareJetcan(1, items, 100, facts, src)!;
  op.dispatchJetcan(1, intent.generation);
  op.registerJetcan(
    {
      source: "native-jetcan",
      operationID: "op",
      runID: "run",
      targetKey: claim.key,
      claimGeneration: claim.generation,
      characterID: 1,
      shipID: 11,
      systemID: 300,
      containerID: 100,
      intentGeneration: intent.generation,
      observedAt: 1000,
      capacityM3: 100,
      items,
    },
    facts,
  );
  const haul = op.claimContainer(4, 100)!;
  assert.ok(op.dispatchHaul(4, 100, haul.generation));
  const row = (
      itemID: number,
      typeID: number,
      quantity: number,
      ownerID: number,
      locationID: number,
      flagID: number,
    ) => ({ itemID, typeID, quantity, ownerID, locationID, flagID, categoryID: 25 }),
    raw = row(20, 30, 10, 4, 14, 5),
    output = row(20, 31, 10, 4, 14, 5),
    sourceBefore = [row(20, 30, 10, 1, 100, 0)],
    conversion: any = {
      item: { itemID: 20, typeID: 30, quantity: 10, flagID: 5 },
      output: { itemID: 20, typeID: 31, quantity: 10, flagID: 5 },
      before: [raw],
      after: [output],
      rawUnitVolumeM3: 1,
      compressedUnitVolumeM3: 0.1,
      issuedAt: 900,
      observedAt: 950,
      facility: {
        systemID: 300,
        coreModuleID: 10,
        compressorModuleID: 11,
        compressorEffectID: 12,
        facilityTypeListIDs: [1],
        matchingTypeListIDs: [1],
        rangeMeters: 100,
        surfaceDistanceMeters: 0,
        observedAt: 850,
        operationID: "op",
        runID: "run",
        claimKey: claim.key,
        claimGeneration: claim.generation,
        commanderCharacterID: 4,
        commanderShipID: 14,
        minerCharacterID: 4,
        minerShipID: 14,
        sourceTypeID: 30,
        compressedTypeID: 31,
      },
    },
    delivery: any = {
      source: "native-transfer",
      operationID: "op",
      runID: "run",
      containerID: 100,
      claimGeneration: haul.generation,
      shipID: 14,
      destinationID: 600,
      sourceProof: {
        kind: "native-batches",
        batches: [
          {
            sourceBefore,
            itemID: 20,
            typeID: 30,
            quantity: 10,
            sourceAfter: [],
            canAbsence: null,
            shipBefore: [],
            shipAfter: [raw],
          },
        ],
      },
      destinationBefore: [],
      destinationAfter: [row(21, 31, 10, 77, 700, 115)],
      deliveryBatches: [
        {
          item: { itemID: 20, typeID: 31, quantity: 10 },
          sourceBefore: [output],
          sourceAfter: [],
          destinationBefore: [],
          destinationAfter: [row(21, 31, 10, 77, 700, 115)],
          conversion,
        },
      ],
      observedAt: 1000,
    };
  assert.equal(
    op.markDelivered(4, {
      ...delivery,
      deliveryBatches: [
        {
          ...delivery.deliveryBatches[0],
          conversion: { ...conversion, output: { ...conversion.output, quantity: 9 } },
        },
      ],
    }),
    false,
  );
  assert.equal(
    op.markDelivered(4, {
      ...delivery,
      deliveryBatches: [
        {
          ...delivery.deliveryBatches[0],
          conversion: { ...conversion, facility: { ...conversion.facility, minerShipID: 99 } },
        },
      ],
    }),
    false,
  );
  assert.equal(op.markDelivered(4, delivery), true);
});

test("Stop can settle a productive partial roster when the exact launch receipt proves a pilot never started", () => {
  const now = () => 1000,
    board = createTargetBoard(memory(), now),
    document = memoryOperationStore("partial-start", "partial-run");
  const config = {
    operationID: "partial-start",
    runID: "partial-run",
    systemID: 300,
    destinationID: 600,
    members: crew,
  };
  const op = createOperation(document, board, config, now);
  const claim = op.reserve(1, { kind: "BELT", systemID: 300, name: "Partial belt" })!;
  assert.ok(claim && op.activate(1));
  op.noteStopRequest("RETURN_HOME");
  op.recordNeverStarted([2]);
  op.requestStop();
  const restored = createOperation(document, board, config, now);
  for (const m of crew.filter((m) => m.characterID !== 2)) {
    assert.ok(
      restored.settleMember(m.characterID, {
        source: "native-settlement",
        runID: config.runID,
        shipID: m.shipID,
        modulesInactive: true,
        dronesSafe: true,
        observedAt: now(),
      }),
    );
    assert.ok(
      restored.parkMember(m.characterID, {
        source: "native-flight",
        runID: config.runID,
        shipID: m.shipID,
        locationID: 600,
        docked: true,
        observedAt: now(),
      }),
    );
  }
  assert.equal(restored.snapshot().state, "STOPPED");
  assert.deepEqual(restored.snapshot().neverStarted, [2]);
  assert.equal(restored.snapshot().parked.includes(2), false);
});
