import test from "node:test";
import assert from "node:assert/strict";
import {
  installTrainingAdapter,
  loginFactoryAccount,
  loadTrainingCharacters,
  loadTrainingSettingsContext,
  readTrainingFittingGoals,
  readTrainingHullGoals,
  runTrainingGoal,
  reviewIndependentSkill,
  reviewSkillAcquisition,
  acquireFactorySkills,
  applyTrainingQueue,
  trainingOnboarding,
  verifyTrainingMembership,
  loadTrainingEnrollment,
  readTrainingSkillSheet,
} from "./training.ts";
import { centerRoster, centerReview, centerInspect, centerApply } from "./provisioning.ts";
import { installPageContext, ownerOptions } from "../app/context.ts";
import { trainingWorldStorage } from "../training/worldStorage.ts";
import { checkPendingFunding, verifiedTrainingOutcome } from "./training.ts";
test("the skills panel checks first and releases only the reviewed funding reference", async () => {
  const ref = "UOC Training 12aaade3-5b8a-4370-b067-0bf856764055";
  const setups: unknown[] = [];
  installTrainingAdapter({
    authenticatedJson: async () => assert.fail("unexpected request"),
    runHosted: async (id, kind, setup, opts) => {
      assert.equal(id, 7);
      assert.equal(kind, "training");
      assert.equal(opts.token, "own");
      setups.push(setup);
      return {
        botID: "check",
        phase: "Funding checked",
        status: "stopped",
        why: "Wallets checked",
        readout: setups.length === 1 ? { reference: ref } : {},
      };
    },
  });
  try {
    const check = await checkPendingFunding(7, { token: "own" });
    assert.equal(check.reference, ref);
    const released = await checkPendingFunding(7, { token: "own" }, check.reference!);
    assert.equal(released.reference, null);
    assert.deepEqual(setups, [
      { verifyFunding: true },
      { verifyFunding: true, confirmedAbsent: ref },
    ]);
  } finally {
    installTrainingAdapter(null);
  }
});
test("verified native queue replaces an obsolete missing-book label", () => {
  const r = verifiedTrainingOutcome(
    { queue: { active: true, maxEntries: 50, entries: [{ typeID: 10, toLevel: 3 }] } },
    [{ typeID: 10, name: "Actual skill", level: 3, currentLevel: 0, bookMissing: true }],
    130,
  );
  assert.equal(r.requirements[0]?.bookMissing, false);
  assert.equal(r.requirements[0]?.reviewState, "TRAINING");
});
const fit = {
    corporationID: 5,
    fittingID: 6,
    goalTypeID: 7,
    name: "Fit",
    fingerprint: "a".repeat(64),
    estimatedCostISK: 169000,
    issue: null,
  },
  calls: any[] = [];
const options = { token: "account-token" };
const hosted = async (id: number, kind: string, setup: any) => {
  calls.push({ id, kind, setup });
  if (kind === "training-inspect" && setup.skillSheetOnly)
    return {
      botID: "sheet",
      phase: "Training skills read",
      status: "stopped",
      why: null,
      readout: {
        characterID: id,
        trained: [],
        queue: { active: false, maxEntries: 50, entries: [] },
      },
    };
  if (kind === "training-inspect")
    return {
      botID: "inspect",
      phase: "Training inspected",
      status: "stopped",
      why: null,
      readout: {
        characterID: id,
        corporationID: 5,
        skills: [],
        queue: { active: false, entries: [] },
        choices: [fit],
      },
    };
  if (kind === "training")
    return {
      botID: "train",
      phase: "Training queued",
      status: "stopped",
      why: null,
      readout: { queueVerified: true },
    };
  if (kind === "provision-inspect")
    return {
      botID: "inspect-fit",
      phase: "Provisioning inspected",
      status: "stopped",
      why: null,
      readout: {
        characterID: id,
        corporationID: 5,
        fittingID: 6,
        fingerprint: fit.fingerprint,
        shipID: 8,
        currentShipTypeID: 4,
        stationID: 9,
        skills: { missing: [] },
        plan: {
          mode: "NEW_HULL",
          targetHullTypeID: 7,
          requirements: [],
          shortages: [],
          unsupported: [],
          destructiveActions: [],
        },
        reviewedPlanFingerprint: "b".repeat(64),
        resources: {
          state: "SIMULATED",
          characterID: id,
          shipTypeID: 7,
          source: "PILOT_BRAIN_CLIENT_SIMULATION",
          fits: true,
          cpu: { used: 2, total: 4 },
          powergrid: { used: 1, total: 3 },
        },
        nativeResources: { state: "UNKNOWN", reason: "Not assembled" },
        sourceRead: {
          pin: { descriptor: { kind: setup.sourceKind ?? "corp" }, flag: 4, locationID: 9 },
          access: { query: true, take: true },
          rows: [],
        },
        pending: [],
        canApply: true,
      },
    };
  if (kind === "provision-apply")
    return {
      botID: "apply",
      phase: "Provisioning verified",
      status: "stopped",
      why: null,
      readout: {
        characterID: id,
        operationID: "native-op",
        equipment: "VERIFIED",
        shipID: 10,
        nativeReceipt: { operationID: "native-op", state: "COMPLETE" },
        finalStatus: { equipment: "VERIFIED", supplies: "LOW", targets: [] },
        nativeResources: {
          state: "NATIVE",
          cpu: { used: 2, total: 4 },
          powergrid: { used: 1, total: 3 },
          allModulesOnline: true,
        },
      },
    };
  throw Error(kind);
};
const auth = async (path: string) =>
  path.endsWith("/login")
    ? { sessionToken: "account-token", account: { username: "Pilot", accountID: 1 } }
    : path === "/api/plugins/uoc/center/account"
      ? { account: { username: "Pilot", accountID: 1 }, worldID: "a".repeat(64) }
      : path.startsWith("/api/ship-provisioning/review?")
        ? {
            definitions: {
              status: "READY",
              providerCharacterID: 3,
              corporationID: 5,
              contracts: [
                {
                  name: "Fit",
                  shipTypeID: 7,
                  definition: {
                    characterID: 3,
                    corporationID: 5,
                    fittingID: 6,
                    fingerprint: fit.fingerprint,
                  },
                },
              ],
            },
          }
        : path.endsWith("/characters")
          ? { account: "Pilot", characters: [{ characterID: 3, name: "Pilot", corporationID: 5 }] }
          : path.includes("/ownership")
            ? { ownership: { characterID: 3, owner: "OFF", online: false } }
            : {};
test("existing-account fitting quote and training reuse the plugin host with exact fingerprint", async () => {
  calls.length = 0;
  installTrainingAdapter({ authenticatedJson: auth, runHosted: hosted });
  assert.equal((await loginFactoryAccount("Pilot")).account, "Pilot");
  assert.equal((await loadTrainingCharacters(options)).characters[0]?.characterID, 3);
  const list = await readTrainingFittingGoals(3, options);
  assert.equal(list.choices[0]?.fittingID, 6);
  const body = {
    characterID: 3,
    goalTypeID: 7,
    mode: "PREVIEW" as const,
    goalFitting: { corporationID: 5, fittingID: 6, fingerprint: fit.fingerprint },
  };
  const preview = await runTrainingGoal(body, options);
  assert.equal(preview.outcome.requirementsUnavailable, true);
  assert.equal(preview.outcome.totalISK, "169000");
  await runTrainingGoal(
    {
      ...body,
      mode: "START",
      corporateFundingEnabled: true,
      trainingWallet: { corporationID: 5, accountKey: 1000 },
    },
    options,
  );
  assert.deepEqual(calls.at(-1).setup, {
    goalTypeID: 7,
    maxSpendISK: 169000,
    corporationID: 5,
    fittingID: 6,
    fingerprint: fit.fingerprint,
    corporateFunding: true,
  });
  await assert.rejects(
    runTrainingGoal(
      { ...body, mode: "START", goalFitting: { ...body.goalFitting, fingerprint: "changed" } },
      options,
    ),
    /exact fitting/,
  );
});
test("corporate provisioning preserves pilot-simulation and exact reviewed fingerprint", async () => {
  calls.length = 0;
  installTrainingAdapter({ authenticatedJson: auth, runHosted: hosted });
  const roster = await centerRoster(options.token);
  assert.equal(roster.pilots[0]?.control.owner, "OFF");
  const review = await centerReview(options.token, {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 0,
    sourceKind: "hangar",
    corporationID: 5,
    division: 1,
  });
  assert.equal(review.definitions.contracts.length, 1);
  const input = {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 6,
    sourceKind: "corp",
    division: 1,
    definitionFingerprint: fit.fingerprint,
  };
  const details = await centerInspect(options.token, input);
  assert.equal(details.fittingResources?.cpu?.used, 2);
  assert.equal(details.fittingResources?.status, "READY");
  assert.equal(details.applyReview.reviewHash, "b".repeat(64));
  const done = await centerApply(
    options.token,
    details.applyReview.reviewID,
    details.applyReview.reviewHash!,
  );
  assert.equal(done.outcome.nativeResources.allModulesOnline, true);
  assert.equal(done.outcome.finalReview?.status.supplies, "LOW");
  assert.equal((done.outcome.rawReadout as any).nativeReceipt.operationID, "native-op");
  assert.equal(done.outcome.release.state, "VERIFIED_OFFLINE");
  assert.equal(calls.at(-1).setup.reviewedPlanFingerprint, "b".repeat(64));
  await assert.rejects(
    centerApply(options.token, details.applyReview.reviewID, details.applyReview.reviewHash!),
    /already dispatched/,
  );
});

test("original HR controls invoke exact hosted invite, join and optional role grant with no replay", async () => {
  const events: any[] = [];
  const world = "a".repeat(64);
  const hr = async (id: number, kind: string, setup: any, options: any) => {
    events.push({ id, kind, stage: setup.stage, token: options.token });
    return {
      botID: "b",
      phase:
        setup.stage === "invite"
          ? "Invitation verified"
          : setup.stage === "join"
            ? "Membership verified"
            : "Onboarding verified",
      status: "stopped",
      why: null,
      readout: {
        traineeID: 3,
        corporationID: 5,
        ...(setup.stage === "grant" ? { roleMasksVerified: true } : {}),
      },
    };
  };
  installTrainingAdapter({ authenticatedJson: auth, runHosted: hr, worldID: async () => world });
  const body = {
    enabled: true,
    characterID: 3,
    currentCorporationID: 6,
    corporationID: 5,
    rights: "FULL_ACCESS_EXCEPT_CEO",
    authority: { characterID: 4, token: "hr" },
    worldID: world,
  };
  const review = await trainingOnboarding("review", body, options);
  const applied = await trainingOnboarding(
    "apply",
    { reviewID: review.reviewID, authority: body.authority, worldID: world, confirm: true },
    options,
  );
  assert.equal(applied.verified, true);
  assert.deepEqual(
    events.map((e) => [e.id, e.kind, e.stage, e.token]),
    [
      [4, "training-hr", "invite", "hr"],
      [3, "training-join", "join", "account-token"],
      [4, "training-hr", "grant", "hr"],
    ],
  );
  await assert.rejects(
    trainingOnboarding(
      "apply",
      { reviewID: review.reviewID, authority: body.authority, worldID: world, confirm: true },
      options,
    ),
    /already dispatched/,
  );
});
test("membership verification reads exact current corporation without HR", async () => {
  installTrainingAdapter({ authenticatedJson: auth, runHosted: hosted });
  assert.deepEqual(await verifyTrainingMembership(3, 5, options), {
    state: "READY",
    corporationID: 5,
  });
  await assert.rejects(verifyTrainingMembership(3, 99, options), /not in/);
});

test("already-member role grant verifies membership and uses only direct grant-existing", async () => {
  const events: any[] = [];
  const world = "a".repeat(64);
  installTrainingAdapter({
    authenticatedJson: auth,
    runHosted: async (id: number, kind: string, setup: any) => {
      events.push({ id, kind, stage: setup.stage });
      if (kind === "training-inspect") return hosted(id, kind, setup);
      return {
        botID: "b",
        phase: "Onboarding verified",
        status: "stopped",
        why: null,
        readout: { traineeID: 3, corporationID: 5, roleMasksVerified: true },
      };
    },
    worldID: async () => world,
  });
  const body = {
    enabled: true,
    characterID: 3,
    currentCorporationID: 5,
    corporationID: 5,
    rights: "FULL_ACCESS_EXCEPT_CEO",
    authority: { characterID: 4, token: "hr" },
    worldID: world,
  };
  const review = await trainingOnboarding("review", body, options);
  const result = await trainingOnboarding(
    "apply",
    { reviewID: review.reviewID, authority: body.authority, worldID: world, confirm: true },
    options,
  );
  assert.equal(result.verified, true);
  assert.deepEqual(
    events.map((e) => [e.kind, e.stage]),
    [
      ["training-inspect", undefined],
      ["training-hr", "grant-existing"],
    ],
  );
  await assert.rejects(
    trainingOnboarding(
      "apply",
      { reviewID: review.reviewID, authority: body.authority, worldID: world, confirm: true },
      options,
    ),
    /already dispatched/,
  );
});

test("existing native inspection exposes actual skill queue without inventing a catalogue", async () => {
  installTrainingAdapter({ authenticatedJson: auth, runHosted: hosted });
  const result = await readTrainingSkillSheet(3, options);
  assert.equal(result.sheet.characterID, 3);
  assert.deepEqual(result.sheet.queue.entries, []);
  assert.equal(result.catalogUnavailable, true);
});

test("restored world-scoped settings do not import prior WC74 browser records", () => {
  const values = new Map([["pilot-training:world:world:settings", "old"]]);
  const store = trainingWorldStorage(
    {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => {
        values.set(k, v);
      },
    },
    () => "world",
  );
  assert.equal(store.getItem("settings"), null);
  store.setItem("settings", "new");
  assert.equal(values.get("pilot-training:world:world:settings"), "old");
  assert.equal(values.get("uoc-restored:pilot-training:world:world:settings"), "new");
});

test("settings use authenticated roster and read-only native HR inspection", async () => {
  const events: any[] = [];
  installTrainingAdapter({
    authenticatedJson: auth,
    runHosted: async (id: number, kind: string, setup: any) => {
      events.push({ id, kind, setup });
      return {
        botID: "i",
        phase: "Corporation authority inspected",
        status: "stopped",
        why: null,
        readout: {
          characterID: id,
          corporationID: 5,
          corporationName: "Example",
          eligible: true,
          roleMasks: Object.fromEntries(
            [
              "roles",
              "grantableRoles",
              "rolesAtHQ",
              "grantableRolesAtHQ",
              "rolesAtBase",
              "grantableRolesAtBase",
              "rolesAtOther",
              "grantableRolesAtOther",
            ].map((k) => [k, "1"]),
          ),
        },
      };
    },
  });
  const result = await loadTrainingSettingsContext(options, 3);
  assert.equal(result.authorities[0]!.eligible, true);
  assert.equal(result.corporations[0]!.name, "Example");
  assert.deepEqual(events, [
    { id: 3, kind: "training-hr", setup: { stage: "inspect", authorityID: 3 } },
  ]);
});

test("HR inspection rejects a pilot outside authenticated roster before hosting", async () => {
  let runs = 0;
  installTrainingAdapter({
    authenticatedJson: auth,
    runHosted: async () => {
      runs++;
      throw Error("unexpected");
    },
  });
  await assert.rejects(loadTrainingSettingsContext(options, 99), /authenticated roster/);
  assert.equal(runs, 0);
});
test("Verify HR reuses the pilot from the just verified account roster", async () => {
  let reads = 0,
    runs = 0;
  const roleMasks = Object.fromEntries(
    [
      "roles",
      "grantableRoles",
      "rolesAtHQ",
      "grantableRolesAtHQ",
      "rolesAtBase",
      "grantableRolesAtBase",
      "rolesAtOther",
      "grantableRolesAtOther",
    ].map((k) => [k, "1"]),
  );
  installTrainingAdapter({
    authenticatedJson: async () => {
      reads++;
      throw Error("Duplicate roster read");
    },
    runHosted: async (id, kind, setup) => {
      assert.deepEqual([id, kind, setup], [3, "training-hr", { stage: "inspect", authorityID: 3 }]);
      runs++;
      return {
        botID: "hr",
        phase: "Corporation authority inspected",
        status: "stopped",
        why: null,
        readout: { characterID: id, corporationID: 5, eligible: true, roleMasks },
      };
    },
  });
  const result = await loadTrainingSettingsContext(options, 3, {
    characterID: 3,
    name: "Pilot",
    corporationID: 5,
  } as any);
  assert.equal(result.authorities[0]?.name, "Pilot");
  assert.deepEqual([reads, runs], [0, 1]);
});

test("fitting preview exposes native computed prerequisites and held pilot skill levels", async () => {
  const fitWithSkills = {
    ...fit,
    prerequisites: [
      { typeID: 10, toLevel: 1 },
      { typeID: 10, toLevel: 2 },
      { typeID: 11, toLevel: 1 },
    ],
  };
  installTrainingAdapter({
    authenticatedJson: auth,
    runHosted: async (id: number, kind: string) => ({
      botID: "i",
      phase: "Training inspected",
      status: "stopped",
      why: null,
      readout: {
        characterID: id,
        corporationID: 5,
        skills: [{ typeID: 10, level: 1 }],
        queue: { active: true, entries: [{ typeID: 10, toLevel: 2 }] },
        choices: [fitWithSkills],
      },
    }),
  });
  await readTrainingFittingGoals(3, options);
  const p = await runTrainingGoal(
    {
      characterID: 3,
      goalTypeID: 7,
      mode: "PREVIEW",
      goalFitting: { corporationID: 5, fittingID: 6, fingerprint: fit.fingerprint },
    },
    options,
  );
  assert.deepEqual(p.outcome.requirements, [
    {
      typeID: 10,
      name: "Skill 10",
      level: 2,
      currentLevel: 1,
      bookMissing: false,
      queuedLevel: 2,
      reviewState: "TRAINING",
    },
    {
      typeID: 11,
      name: "Skill 11",
      level: 1,
      currentLevel: 0,
      bookMissing: true,
      reviewState: "MISSING",
    },
  ]);
  assert.equal(p.outcome.requirementsUnavailable, false);
});

test("skill catalogue uses public static published rows beside the native sheet", async () => {
  installTrainingAdapter({
    authenticatedJson: async (path: string) =>
      path === "/api/static/skill-catalogue"
        ? {
            skills: [
              { typeID: 10, name: "Mining", groupID: 1, groupName: "Mining", published: true },
              { typeID: 11, name: "Hidden", groupID: 1, groupName: "Mining", published: false },
            ],
          }
        : auth(path),
    runHosted: hosted,
  });
  const result = await readTrainingSkillSheet(3, options);
  assert.equal(result.catalogUnavailable, false);
  assert.deepEqual(
    result.catalog.map((x: any) => x.typeID),
    [10],
  );
});

test("personal hangar review retains exact source through hosted setup", async () => {
  calls.length = 0;
  installTrainingAdapter({ authenticatedJson: auth, runHosted: hosted });
  await centerRoster(options.token);
  await centerReview(options.token, {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 0,
    sourceKind: "hangar",
    corporationID: 5,
    division: 1,
  });
  const result = await centerInspect(options.token, {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 6,
    sourceKind: "hangar",
    division: 1,
    definitionFingerprint: fit.fingerprint,
  });
  assert.equal(result.candidateSource.kind, "hangar");
  assert.equal(calls.at(-1).setup.sourceKind, "hangar");
});

test("hull search and training use published ship metadata and real hosted skills quote", async () => {
  const invoked: any[] = [];
  const api = async (path: string) => {
    if (path.startsWith("/api/market/find"))
      return {
        matches: [
          { typeID: 7, name: "Fixture Venture" },
          { typeID: 8, name: "Not a ship" },
        ],
        capped: false,
      };
    if (path.includes("type-prices?typeIDs=7,8"))
      return { available: true, categoryID: { 7: 6, 8: 7 }, published: { 7: true, 8: true } };
    if (path.includes("type-prices?typeIDs=7"))
      return { available: true, categoryID: { 7: 6 }, published: { 7: true } };
    if (path.includes("required-skills"))
      return { available: true, required: { 7: { 10: 2 }, 10: { 11: 1 }, 11: {} } };
    if (path.includes("type-prices?typeIDs=11,10"))
      return { available: true, basePrice: { 10: 100, 11: 50 }, published: { 10: true, 11: true } };
    if (path.includes("type-lists")) return { lists: { 10: [93], 11: [93] } };
    throw Error(path);
  };
  installTrainingAdapter({
    authenticatedJson: api,
    runHosted: async (id, kind, setup, opts) => {
      invoked.push({ kind, setup });
      return hosted(id, kind, setup);
    },
  });
  assert.deepEqual((await readTrainingHullGoals("Vent", options)).goals, [
    { typeID: 7, name: "Fixture Venture" },
  ]);
  const body = { characterID: 3, goalTypeID: 7, mode: "PREVIEW" as const };
  const result = await runTrainingGoal(body, options);
  assert.equal(result.outcome.totalISK, "195");
  assert.deepEqual(
    result.outcome.requirements.map((r) => [r.typeID, r.level, r.bookMissing]),
    [
      [11, 1, true],
      [10, 2, true],
    ],
  );
  await runTrainingGoal({ ...body, mode: "START" }, options);
  assert.deepEqual(invoked.at(-1).setup, { goalTypeID: 7, maxSpendISK: 195 });
});
test("hull search rejects capped results rather than hiding candidates", async () => {
  installTrainingAdapter({
    authenticatedJson: async () => ({ matches: [], capped: true }),
    runHosted: hosted,
  });
  await assert.rejects(readTrainingHullGoals("vent", options), /refine/);
});

test("independent skill Apply uses one held run and returns the confirmed sheet", async () => {
  const calls: any[] = [];
  let learned = false;
  const api = async (path: string) => {
    if (path.includes("type-prices?typeIDs=10"))
      return {
        available: true,
        categoryID: { 10: 16 },
        basePrice: { 10: 100 },
        published: { 10: true },
      };
    if (path.includes("required-skills")) return { available: true, required: { 10: {} } };
    if (path.includes("type-lists")) return { lists: { 10: [93] } };
    throw Error(path);
  };
  const queue = { active: false, entries: [], maxEntries: 50 };
  installTrainingAdapter({
    authenticatedJson: api,
    runHosted: async (id, kind, setup: any) => {
      calls.push({ kind, setup });
      if (kind === "training-inspect")
        return {
          botID: "i",
          phase: "Training skills read",
          status: "stopped",
          why: null,
          readout: {
            characterID: id,
            corporationID: 5,
            balanceISK: 200,
            trained: learned ? [[10, 0]] : [],
            queue,
          },
        };
      assert.equal(typeof setup.skillReviewKey, "string");
      if (setup.skillAction === "purchase-only") {
        learned = true;
        return {
          botID: "p",
          phase: "Skillbooks verified",
          status: "stopped",
          why: null,
          readout: {
            characterID: id,
            purchaseVerified: true,
            purchased: [10],
            trained: [[10, 0]],
            queue,
          },
        };
      }
      return {
        botID: "q",
        phase: "Training queued",
        status: "stopped",
        why: null,
        readout: {
          characterID: id,
          queueVerified: true,
          trained: [[10, 0]],
          queue: { ...queue, active: true, entries: [{ typeID: 10, toLevel: 1 }] },
        },
      };
    },
  });
  const first = await reviewIndependentSkill(3, 10, 1, options);
  assert.equal(first.blockers[0].code, "SKILLBOOK_REQUIRED");
  assert.deepEqual(calls.at(-1).setup, { skillSheetOnly: true, skillReview: "queue" });
  const quote = await reviewSkillAcquisition(
    { characterID: 3, typeID: 10, level: 1, independent: true, policy: "CHARACTER_WALLET_ONLY" },
    options,
  );
  assert.equal(quote.total, "130");
  assert.deepEqual(calls.at(-1).setup, { skillSheetOnly: true, skillReview: "purchase" });
  calls.length = 0;
  const purchased = await acquireFactorySkills(quote.reviewID!, null, options);
  assert.deepEqual(
    calls.map((c) => [c.kind, c.setup.skillAction]),
    [["training", "purchase-only"]],
  );
  assert.deepEqual(purchased.sheet?.skills, [{ typeID: 10, level: 0 }]);
  await assert.rejects(acquireFactorySkills(quote.reviewID!, null, options), /already dispatched/);
  const review = await reviewIndependentSkill(3, 10, 1, options);
  assert.equal(review.canApply, true);
  calls.length = 0;
  const applied = await applyTrainingQueue(review.reviewID, options);
  assert.deepEqual(
    calls.map((c) => [c.kind, c.setup.skillAction]),
    [["training", "queue-only"]],
  );
  assert.deepEqual(applied.sheet?.queue.entries, [{ typeID: 10, toLevel: 1 }]);
});

test("a corporation-only independent purchase carries the reviewed funding and refuses another corporation’s wallet", async () => {
  const calls: { kind: string; setup: any }[] = [];
  const queue = { active: false, entries: [], maxEntries: 50 };
  const authenticatedJson = async (path: string) => {
    if (path.includes("type-prices?typeIDs=10"))
      return {
        available: true,
        categoryID: { 10: 16 },
        basePrice: { 10: 100 },
        published: { 10: true },
      };
    if (path.includes("required-skills")) return { available: true, required: { 10: {} } };
    if (path.includes("type-lists")) return { lists: { 10: [93] } };
    throw Error(path);
  };
  installTrainingAdapter({
    authenticatedJson,
    runHosted: async (id, kind, setup) => {
      calls.push({ kind, setup });
      return kind === "training-inspect"
        ? {
            botID: "i",
            phase: "Training inspected",
            status: "stopped",
            why: null,
            readout: {
              characterID: id,
              corporationID: 5,
              skills: [],
              choices: [],
              balanceISK: 200,
              corporateWallet: { balanceISK: 500 },
              queue,
            },
          }
        : {
            botID: "p",
            phase: "Skillbooks verified",
            status: "stopped",
            why: null,
            readout: {
              characterID: id,
              purchaseVerified: true,
              purchased: [10],
              trained: [[10, 0]],
              queue,
            },
          };
    },
  });
  const body = {
    characterID: 3,
    typeID: 10,
    level: 1,
    independent: true,
    policy: "CORPORATION_WALLET_ONLY",
  };
  const denied = await reviewSkillAcquisition(
    { ...body, trainingWallet: { corporationID: 6, accountKey: 1000 } },
    options,
  );
  assert.equal(denied.canAcquire, false);
  assert.match(denied.blockers[0]!, /trainee’s current corporation/);
  const quote = await reviewSkillAcquisition(
    { ...body, trainingWallet: { corporationID: 5, accountKey: 1000 } },
    options,
  );
  assert.equal(quote.canAcquire, true);
  assert.deepEqual(quote.fundingEstimate, {
    personalISK: 0,
    corporateISK: 130,
    shortfallISK: 0,
    reason: null,
  });
  await acquireFactorySkills(quote.reviewID!, null, options);
  const dispatched = calls.filter((row) => row.kind === "training");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.setup.skillAction, "purchase-only");
  assert.equal(dispatched[0]!.setup.fundingPolicy, "CORPORATION_WALLET_ONLY");
  assert.equal(dispatched[0]!.setup.corporationID, 5);
});

test("fitting picker reads definitions without adopting native Apply history", async () => {
  const events: string[] = [];
  const read = async (path: string) => {
    const result = await auth(path);
    return path.startsWith("/api/ship-provisioning/review?")
      ? { ...result, pendingNative: [{ operationID: "old-native", state: "BLOCKED" }] }
      : result;
  };
  installTrainingAdapter({
    authenticatedJson: read,
    runHosted: async (id, kind, setup) => {
      events.push(kind);
      return hosted(id, kind, setup);
    },
  });
  await centerRoster(options.token);
  const input = {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 0,
    sourceKind: "corp",
    corporationID: 5,
    division: 7,
  };
  await centerReview(options.token, input);
  assert.deepEqual(events, []);
  const { applyReview } = await centerInspect(options.token, {
    ...input,
    fittingID: 6,
    definitionFingerprint: fit.fingerprint,
  });
  assert.equal(applyReview.canApply, true);
  assert.equal(
    (await centerApply(options.token, applyReview.reviewID, applyReview.reviewHash!)).outcome.state,
    "COMPLETE",
  );
  assert.deepEqual(events, ["provision-inspect", "provision-apply"]);
  assert.equal(calls.at(-1).setup.division, 7);
});

test("different fitting provider uses account preflight and preserves held source corp", async () => {
  const seen: any[] = [];
  const authProvider = async (path: string) => {
    if (path.endsWith("/characters"))
      return {
        account: "Pilot",
        characters: [
          { characterID: 3, name: "Pilot", corporationID: 5 },
          { characterID: 4, name: "Provider", corporationID: 9 },
        ],
      };
    if (path.startsWith("/api/ship-provisioning/review?"))
      return {
        definitions: {
          status: "READY",
          providerCharacterID: 4,
          corporationID: 9,
          contracts: [
            {
              name: "Provider fit",
              shipTypeID: 7,
              definition: {
                characterID: 4,
                corporationID: 9,
                fittingID: 6,
                fingerprint: fit.fingerprint,
              },
            },
          ],
        },
      };
    return auth(path);
  };
  installTrainingAdapter({
    authenticatedJson: authProvider,
    runHosted: async (id, kind, setup) => {
      seen.push({ kind, setup });
      if (kind === "provision-inspect")
        return {
          botID: "i",
          phase: "Provisioning inspected",
          status: "stopped",
          why: null,
          readout: {
            characterID: id,
            corporationID: 9,
            fittingID: 6,
            fingerprint: fit.fingerprint,
            shipID: 8,
            currentShipTypeID: 4,
            stationID: 9,
            skills: { missing: [] },
            plan: {
              mode: "NEW_HULL",
              targetHullTypeID: 7,
              requirements: [],
              shortages: [],
              unsupported: [],
              destructiveActions: [],
            },
            reviewedPlanFingerprint: "b".repeat(64),
            resources: { state: "UNKNOWN" },
            pending: [],
            canApply: true,
          },
        };
      throw Error(kind);
    },
  });
  await centerRoster(options.token);
  const list = await centerReview(options.token, {
    characterID: 3,
    providerCharacterID: 4,
    fittingID: 0,
    sourceKind: "hangar",
    corporationID: 5,
    division: 1,
  });
  assert.equal(list.definitions.contracts[0]?.definition.characterID, 4);
  await centerInspect(options.token, {
    characterID: 3,
    providerCharacterID: 4,
    fittingID: 6,
    sourceKind: "hangar",
    division: 1,
    definitionFingerprint: fit.fingerprint,
  });
  assert.deepEqual(seen.at(-1).setup, {
    corporationID: 9,
    fittingID: 6,
    goalTypeID: 7,
    fingerprint: fit.fingerprint,
    division: 1,
    sourceKind: "hangar",
    providerCharacterID: 4,
    sourceCorporationID: 5,
  });
});

test("verified source projects native query/take and exact whole-source quantities", async () => {
  const run = async (id: number, kind: string, setup: any) => {
    const base = await hosted(id, kind, setup);
    if (kind === "provision-inspect") {
      const r = base.readout as any;
      r.sourceRead = {
        pin: { descriptor: { kind: "hangar" }, flag: 4, locationID: 9 },
        access: { query: true, take: false },
        rows: [
          {
            itemID: 88,
            typeID: 7,
            quantity: 2,
            flagID: 4,
            ownerID: 3,
            locationID: 9,
            singleton: false,
          },
        ],
      };
      r.status = { equipment: "MODIFIED", supplies: "LOW", targets: [] };
      r.fittingService = "AVAILABLE";
    }
    return base;
  };
  installTrainingAdapter({ authenticatedJson: auth, runHosted: run });
  await centerRoster(options.token);
  await centerReview(options.token, {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 0,
    sourceKind: "hangar",
    corporationID: 5,
    division: 1,
  });
  const result = await centerInspect(options.token, {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 6,
    sourceKind: "hangar",
    division: 1,
    definitionFingerprint: fit.fingerprint,
  });
  assert.equal(result.fittingService, "AVAILABLE");
  assert.equal(result.candidateSource.query, "ALLOWED");
  assert.equal(result.candidateSource.take, "DENIED");
  assert.equal(result.applyReview.canApply, false);
  await assert.rejects(
    centerApply(options.token, result.applyReview.reviewID, result.applyReview.reviewHash!),
    /unavailable/,
  );
  assert.equal(result.stockAuthority, "VERIFIED_SOURCE");
  assert.equal(result.relevantStock?.[0]?.quantity, 2);
  assert.equal(result.status.supplies, "LOW");
  assert.equal(result.pilot.dockState, "DOCKED");
  assert.equal(result.hullReview?.packagedQuantity, 2);
  assert.equal(result.hullReview?.preserveCurrentShip, true);
});

test("training reports remaining time only from a verified native active queue timestamp", async () => {
  const end = Date.now() + 120000;
  installTrainingAdapter({
    authenticatedJson: auth,
    runHosted: async (id, kind, setup) => {
      if (kind === "training")
        return {
          botID: "t",
          phase: "Training queued",
          status: "stopped",
          why: null,
          readout: {
            queueVerified: true,
            queue: {
              active: true,
              maxEntries: 50,
              endTimeMs: end,
              entries: [{ typeID: 10, toLevel: 1, startTimeMs: end - 120000, endTimeMs: end }],
            },
            totalCents: 13000,
          },
        };
      return hosted(id, kind, setup);
    },
  });
  await readTrainingFittingGoals(3, options);
  const v = await runTrainingGoal(
    {
      characterID: 3,
      goalTypeID: 7,
      mode: "START",
      goalFitting: { corporationID: 5, fittingID: 6, fingerprint: fit.fingerprint },
    },
    options,
  );
  assert.equal(v.outcome.estimatedCost, false);
  assert.ok((v.outcome.remainingTrainingMs ?? 0) > 100000);
  assert.equal(v.outcome.queue?.entries[0]?.endTimeMs, end);
});

test("member enrollment uses exact held native role masks and rejects another world", async () => {
  const world = "a".repeat(64),
    keys = [
      "roles",
      "grantableRoles",
      "rolesAtHQ",
      "grantableRolesAtHQ",
      "rolesAtBase",
      "grantableRolesAtBase",
      "rolesAtOther",
      "grantableRolesAtOther",
    ],
    roleMasks = Object.fromEntries(keys.map((k) => [k, "0"]));
  let observedWorld = world;
  installTrainingAdapter({
    authenticatedJson: auth,
    worldID: async () => world,
    runHosted: async (id, kind, setup) => {
      assert.equal(kind, "training-hr");
      assert.deepEqual(setup, { stage: "member-inspect", authorityID: 3 });
      return {
        botID: "r",
        phase: "Training membership inspected",
        status: "stopped",
        why: null,
        readout: {
          characterID: id,
          corporationID: 5,
          roleMasks,
          rights: "OTHER",
          enrollmentState: "PENDING",
          worldID: observedWorld,
        },
      };
    },
  });
  const result = await loadTrainingEnrollment(3, options);
  assert.equal(result.state, "READY");
  assert.equal(result.enrollmentState, "PENDING");
  assert.deepEqual(result.roleMasks, roleMasks);
  observedWorld = "b".repeat(64);
  await assert.rejects(loadTrainingEnrollment(3, options), /unavailable/);
});
test("grouped equipment keeps missing per-slot observations unknown", async () => {
  const { groupEquipment } = await import("../provisioning/centerTypes.ts");
  const [row] = groupEquipment([
    { typeID: 7, kind: "module", flagID: 27, quantity: 1, current: 1, missing: 0 },
    { typeID: 7, kind: "module", flagID: 28, quantity: 1 },
  ]);
  assert.ok(row);
  assert.equal(row.quantity, 2);
  assert.equal(row.current, undefined);
  assert.equal(row.missing, undefined);
});

test("Provisioning roster opens with Farmer authorization without login or pilot acquisition", async () => {
  const paths: string[] = [];
  installTrainingAdapter({
    authenticatedJson: async (path: string) => {
      paths.push(path);
      if (path.endsWith("/login")) throw Error("No re-login");
      return auth(path);
    },
    runHosted: async () => {
      throw Error("No pilot acquisition");
    },
  });
  installPageContext({
    readAccounts: () => [{ accountID: 1, username: "Pilot", options: { token: "farmer-token" } }],
  });
  try {
    const r = await centerRoster((await ownerOptions("Pilot")).token!);
    assert.equal(r.pilots[0]?.characterID, 3);
    assert.ok(paths.includes("/api/plugins/uoc/center/account"));
    assert.equal(
      paths.some((p) => p.endsWith("/login")),
      false,
    );
  } finally {
    installPageContext({});
  }
});

test("ordinary fitting funding uses held pilot authority without HR configuration", async () => {
  const events: any[] = [];
  installTrainingAdapter({
    authenticatedJson: auth,
    runHosted: async (id, kind, setup) => {
      events.push({ kind, setup });
      return hosted(id, kind, setup);
    },
  });
  await readTrainingFittingGoals(3, options);
  await runTrainingGoal(
    {
      characterID: 3,
      goalTypeID: 7,
      mode: "START",
      goalFitting: { corporationID: 5, fittingID: 6, fingerprint: fit.fingerprint },
      corporateFundingEnabled: true,
    },
    options,
  );
  assert.equal(events.at(-1).setup.corporateFunding, true);
  assert.equal(
    events.some((x) => x.kind === "training-hr"),
    false,
  );
});

test("skills refresh reads native state again after book acquisition", async () => {
  let level = 0,
    reads = 0;
  installTrainingAdapter({
    authenticatedJson: auth,
    runHosted: async (id, kind, setup) => {
      assert.equal(kind, "training-inspect");
      assert.deepEqual(setup, { skillSheetOnly: true });
      reads++;
      return {
        botID: "sheet",
        phase: "Training skills read",
        status: "stopped",
        why: null,
        readout: {
          characterID: id,
          trained: [[10, level]],
          queue: { active: false, maxEntries: 50, entries: [] },
        },
      };
    },
  });
  assert.equal((await readTrainingSkillSheet(3, options)).sheet.skills[0]?.level, 0);
  level = 1;
  assert.equal((await readTrainingSkillSheet(3, options)).sheet.skills[0]?.level, 1);
  assert.equal(reads, 2);
});

test("active owner permits inspection with exact source and CPU evidence but cannot authorize Apply", async () => {
  const api = async (path: string) =>
    path.includes("/ownership")
      ? { ownership: { characterID: 3, owner: "BOT", online: true } }
      : path.includes("/provisioning/3/service")
        ? { available: true, access: "READ_ONLY_ACTIVE_UOC" }
        : auth(path);
  installTrainingAdapter({ authenticatedJson: api, runHosted: hosted });
  await centerRoster("active-roster");
  await centerReview("active-roster", {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 0,
    sourceKind: "corp",
    corporationID: 5,
    division: 7,
  });
  const r = await centerInspect("active-roster", {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 6,
    sourceKind: "corp",
    division: 7,
    definitionFingerprint: fit.fingerprint,
  });
  assert.equal(r.pilot.serviceAccess, "READ_ONLY_ACTIVE_UOC");
  assert.equal(r.fittingResources?.status, "READY");
  assert.equal(r.applyReview.canApply, false);
  assert.match(r.applyReview.reasons.join(" "), /actual idle, docked Cockpit/);
  await assert.rejects(
    centerApply("active-roster", r.applyReview.reviewID, r.applyReview.reviewHash!),
    /unavailable/,
  );
});

test("an incomplete hosted Apply shows the native blocked result", async () => {
  let applies = 0;
  installTrainingAdapter({
    authenticatedJson: auth,
    runHosted: async (id, kind, setup) => {
      if (kind !== "provision-apply") return hosted(id, kind, setup);
      applies++;
      return {
        botID: "original",
        phase: "Session release blocked",
        status: "paused",
        why: "Equipment custody is unresolved.",
        readout: {
          characterID: id,
          operationID: "native-uncertain",
          nativeState: "BLOCKED",
          nativeReason: "OUTCOME_AMBIGUOUS",
          targetHullID: 10,
        },
      };
    },
  });
  const sessionToken = options.token;
  await centerRoster(sessionToken);
  const selection = {
    characterID: 3,
    providerCharacterID: 3,
    sourceKind: "corp",
    corporationID: 5,
    division: 7,
  };
  await centerReview(sessionToken, { ...selection, fittingID: 0 });
  const { applyReview } = await centerInspect(sessionToken, {
    ...selection,
    fittingID: 6,
    definitionFingerprint: fit.fingerprint,
  });
  const { outcome } = await centerApply(
    sessionToken,
    applyReview.reviewID,
    applyReview.reviewHash!,
  );
  assert.equal(outcome.operationID, "native-uncertain");
  assert.equal(outcome.state, "BLOCKED");
  assert.equal(outcome.reason, "OUTCOME_AMBIGUOUS");
  assert.equal(outcome.provisioning?.manifest?.targetHullID, 10);
  await assert.rejects(
    centerApply(sessionToken, applyReview.reviewID, applyReview.reviewHash!),
    /already dispatched/,
  );
  assert.equal(applies, 1);
});

test("invalid catalogue diagnostics preserve native fitting IDs without guessing their identity", async () => {
  installTrainingAdapter({
    authenticatedJson: async (path: string) => {
      const r = await auth(path);
      if (path.startsWith("/api/ship-provisioning/review?"))
        (r as any).definitions.invalid = [{ fittingID: 99, reason: "INVALID_FIT" }];
      return r;
    },
    runHosted: hosted,
  });
  await centerRoster("invalid-library");
  const r = await centerReview("invalid-library", {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 0,
    sourceKind: "hangar",
    corporationID: 5,
    division: 1,
  });
  assert.deepEqual(r.definitions.invalid, [{ fittingID: 99, reason: "INVALID_FIT" }]);
  assert.equal(r.definitions.contracts[0]?.name, "Fit");
});

test("Training keeps Bestower and FixtureHauler when validated and reports a rejected corporate fitting", async () => {
  const provider = { characterID: 3, corporationID: 5 };
  const bestower = {
    name: "Corp Bestower Hauler",
    shipTypeID: 1944,
    definition: { ...provider, fittingID: 34, fingerprint: "a".repeat(64) },
  };
  const fixtureHauler = {
    name: "Corp FixtureHauler",
    shipTypeID: 2100000919,
    definition: { ...provider, fittingID: 32, fingerprint: "b".repeat(64) },
  };
  let haulerValidated = false;
  installTrainingAdapter({
    authenticatedJson: async (path) => {
      if (path.startsWith("/api/ship-provisioning/review?")) {
        return {
          definitions: {
            status: "READY",
            providerCharacterID: provider.characterID,
            corporationID: provider.corporationID,
            contracts: haulerValidated ? [bestower, fixtureHauler] : [bestower],
            invalid: haulerValidated
              ? []
              : [{ fittingID: fixtureHauler.definition.fittingID, reason: "INVALID_FIT" }],
          },
        };
      }
      if (path.startsWith("/api/client-data/type-meta?")) {
        return { available: true, types: { 1944: { groupID: 28 }, 2100000919: { groupID: 28 } } };
      }
      if (path === "/api/names") {
        return {
          names: {
            "type:1944": "Bestower",
            "type:2100000919": "FixtureHauler",
            "group:28": "Hauler",
          },
        };
      }
      assert.fail(`Unexpected library request ${path}`);
    },
    runHosted: async () => {
      assert.fail("Opening the library must not acquire the pilot");
    },
  });

  const partialLibrary = await readTrainingFittingGoals(provider.characterID, options);
  assert.deepEqual(
    partialLibrary.choices.map((choice) => choice.name),
    ["Corp Bestower Hauler"],
  );
  assert.deepEqual(partialLibrary.unavailableFittingIDs, [32]);

  haulerValidated = true;
  const fullLibrary = await readTrainingFittingGoals(provider.characterID, options);
  assert.deepEqual(fullLibrary.unavailableFittingIDs, []);
  assert.deepEqual(
    fullLibrary.choices.map(({ fittingID, name, hullName, groupID, fingerprint }) => [
      fittingID,
      name,
      hullName,
      groupID,
      fingerprint,
    ]),
    [
      [34, "Corp Bestower Hauler", "Bestower", 28, bestower.definition.fingerprint],
      [32, "Corp FixtureHauler", "FixtureHauler", 28, fixtureHauler.definition.fingerprint],
    ],
  );
});

test("a new world requires a fresh inspection for the current Apply", async () => {
  let world = "a".repeat(64);
  installTrainingAdapter({
    authenticatedJson: async (path: string) =>
      path === "/api/plugins/uoc/center/account"
        ? { account: { username: "Pilot", accountID: 1 }, worldID: world }
        : auth(path),
    runHosted: hosted,
  });
  const token = "world-switch-token";
  const selection = {
    characterID: 3,
    providerCharacterID: 3,
    sourceKind: "corp",
    corporationID: 5,
    division: 7,
  };
  await centerRoster(token);
  await centerReview(token, { ...selection, fittingID: 0 });
  const checked = await centerInspect(token, {
    ...selection,
    fittingID: 6,
    definitionFingerprint: fit.fingerprint,
  });
  world = "b".repeat(64);
  await centerRoster(token);
  await assert.rejects(
    centerApply(token, checked.applyReview.reviewID, checked.applyReview.reviewHash!),
    /unavailable/,
  );
  await centerReview(token, { ...selection, fittingID: 0 });
  const fresh = await centerInspect(token, {
    ...selection,
    fittingID: 6,
    definitionFingerprint: fit.fingerprint,
  });
  assert.equal(fresh.applyReview.canApply, true);
});

test("fitting Review toggles reclose prerequisites and reprice before the exact queue dispatch", async () => {
  const fitted = {
    ...fit,
    goalTypeID: 32880,
    items: [[483, 27, 1]],
    prerequisites: [{ typeID: 3386, toLevel: 1 }],
  };
  const read = async (path: string, _options: unknown, body?: any) => {
    const ids =
      new URL(path, "http://fixture").searchParams.get("typeIDs")?.split(",").map(Number) ?? [];
    const byID = (v: unknown) => Object.fromEntries(ids.map((id) => [id, v]));
    if (path.includes("dogma-types"))
      return {
        available: true,
        types: {
          32880: {
            attributes: [[192, 5]],
            effects: [5139],
            requiredSkills: [32918],
            categoryID: 6,
          },
          483: { attributes: [[50, 60]], effects: [67], requiredSkills: [3386], categoryID: 7 },
        },
        effects: { 5139: { name: "miningFrigateBonusOreMiningYield" } },
      };
    if (path.includes("required-skills"))
      return {
        available: true,
        required: { ...byID({}), 3410: { 3386: 4, 3402: 4 }, 3386: {}, 3402: {} },
      };
    if (path.includes("type-prices"))
      return { available: true, basePrice: byID(100), published: byID(true) };
    if (path.includes("type-lists")) return { lists: byID([93]) };
    if (path === "/api/types/dogma")
      return {
        attributes: Object.fromEntries(
          body.typeIDs.map((id: number) => [id, { 275: 1, 180: 165, 181: 166 }]),
        ),
      };
    if (path === "/api/names")
      return {
        names: Object.fromEntries(body.items.map((r: any) => [`type:${r.id}`, `Book ${r.id}`])),
      };
    throw Error(path);
  };
  const writes: any[] = [];
  installTrainingAdapter({
    authenticatedJson: read,
    runHosted: async (id, kind, setup) => {
      if (kind === "training") {
        writes.push(setup);
        return {
          botID: "q",
          phase: "Training queued",
          status: "stopped",
          why: null,
          readout: { queueVerified: true },
        };
      }
      return {
        botID: "i",
        phase: "Training inspected",
        status: "stopped",
        why: null,
        readout: {
          characterID: id,
          corporationID: 5,
          choices: [fitted],
          balanceISK: 100,
          corporateWallet: { balanceISK: 10000 },
          cloneGrade: 1,
          characterAttributes: { 165: 24, 166: 20 },
          skills: [{ typeID: 3386, level: 1, skillPoints: 250 }],
          queue: { active: true, entries: [{ typeID: 3386, toLevel: 2 }] },
        },
      };
    },
  });
  const body = {
    characterID: 3,
    goalTypeID: 32880,
    mode: "PREVIEW" as const,
    planDepth: "ELITE" as const,
    corporateFundingEnabled: true,
    goalFitting: { corporationID: 5, fittingID: 6, fingerprint: fit.fingerprint },
  };
  const full = (await runTrainingGoal(body, options)).outcome;
  assert.equal(full.requirements.find((r) => r.typeID === 3386)?.level, 5);
  const keepPrerequisite = (
    await runTrainingGoal({ ...body, excludedOptionalTypeIDs: [3386] }, options)
  ).outcome;
  assert.equal(keepPrerequisite.requirements.find((r) => r.typeID === 3386)?.level, 4);
  const selection = [3386, 3410],
    reduced = (await runTrainingGoal({ ...body, excludedOptionalTypeIDs: selection }, options))
      .outcome;
  assert.equal(reduced.requirements.find((r) => r.typeID === 3386)?.level, 1);
  assert.equal(
    reduced.requirements.some((r) => r.typeID === 3402),
    false,
  );
  assert.equal(reduced.recommendations?.find((r) => r.typeID === 3410)?.bookCostISK, 130);
  assert.ok(Number(reduced.totalISK) < Number(full.totalISK));
  assert.ok(reduced.additionalSP! < full.additionalSP!);
  assert.ok(reduced.additionalTrainingMs! < full.additionalTrainingMs!);
  assert.ok(reduced.fundingEstimate!.corporateISK! < full.fundingEstimate!.corporateISK!);
  assert.equal(reduced.fundingEstimate?.personalISK, 100);
  await assert.rejects(
    runTrainingGoal(
      { ...body, mode: "START", reviewKey: full.reviewKey, excludedOptionalTypeIDs: selection },
      options,
    ),
    /quote changed/,
  );
  assert.equal(writes.length, 0);
  await runTrainingGoal(
    { ...body, mode: "START", reviewKey: reduced.reviewKey, excludedOptionalTypeIDs: selection },
    options,
  );
  assert.equal(writes.length, 1);
  assert.ok(writes[0].skillGoals.every((g: { typeID: number }) => !selection.includes(g.typeID)));
});

test("Review resolves the exact previous hull type name even when the roster had no ship", async () => {
  const token = "provisioning-names",
    lookups: number[][] = [];
  const typeNames = new Map([
    [89240, "Pioneer"],
    [2006, "Omen"],
    [7, "Selected hull"],
  ]);
  let currentShipTypeID = 89240;
  installTrainingAdapter({
    authenticatedJson: async (path, opts, body) => {
      if (path !== "/api/names") return auth(path);
      assert.equal(opts.token, token);
      const items = (body as { items: { kind: string; id: number }[] }).items;
      assert.ok(items.every((item) => item.kind === "type"));
      lookups.push(items.map((item) => item.id));
      return {
        names: Object.fromEntries(items.map((item) => [`type:${item.id}`, typeNames.get(item.id)])),
      };
    },
    runHosted: async (id, kind, setup) => {
      const result = await hosted(id, kind, setup);
      return { ...result, readout: { ...result.readout, currentShipTypeID } };
    },
  });
  const input = {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 6,
    sourceKind: "corp",
    corporationID: 5,
    division: 7,
    definitionFingerprint: fit.fingerprint,
  };
  const roster = await centerRoster(token);
  assert.equal(roster.pilots[0]?.shipID, null);
  await centerReview(token, input);
  const pioneer = await centerInspect(token, input);
  assert.equal(pioneer.hullReview?.current, "Pioneer");
  assert.equal(pioneer.pilot.hullName, "Pioneer");
  currentShipTypeID = 2006;
  assert.equal((await centerInspect(token, input)).hullReview?.current, "Omen");
  assert.deepEqual(lookups, [[7], [89240], [2006]]);
});

test("changing storage requires Review and a transfer refusal preserves the verified replacement", async () => {
  const token = "provisioning-storage-selection";
  calls.length = 0;
  installTrainingAdapter({
    authenticatedJson: auth,
    runHosted: async (id, kind, setup) => {
      const result = await hosted(id, kind, setup);
      return kind === "provision-apply" && (setup as any).oldShipDivision === 7
        ? {
            ...result,
            phase: "Previous ship storage incomplete",
            status: "error",
            readout: {
              ...result.readout,
              nativeReceipt: {
                operationID: "native-op",
                state: "COMPLETE",
                manifest: { originalShipID: 8 },
              },
              previousShipStorageReason:
                "Previous ship #8 is still in the personal hangar. The inventory transfer was declined.",
            },
          }
        : result;
    },
  });
  const input = {
    characterID: 3,
    providerCharacterID: 3,
    fittingID: 6,
    sourceKind: "corp",
    corporationID: 5,
    division: 1,
    definitionFingerprint: fit.fingerprint,
  };
  await centerRoster(token);
  await centerReview(token, input);
  const personal = (await centerInspect(token, { ...input, oldShipDivision: 0 })).applyReview;
  await assert.rejects(
    centerApply(token, personal.reviewID, personal.reviewHash!, 7),
    /Previous ship destination changed/,
  );
  const corporate = (await centerInspect(token, { ...input, oldShipDivision: 7 })).applyReview;
  assert.equal(calls.at(-1).setup.oldShipDivision, 7);
  assert.equal(corporate.canApply, true);
  await assert.rejects(
    centerApply(token, corporate.reviewID, corporate.reviewHash!, 0),
    /Previous ship destination changed/,
  );
  assert.equal(calls.filter((call) => call.kind === "provision-apply").length, 0);
  const { outcome } = await centerApply(token, corporate.reviewID, corporate.reviewHash!, 7);
  assert.equal(outcome.state, "PARTIAL");
  assert.equal(outcome.provisioning?.manifest?.targetHullID, 10);
  assert.equal(outcome.finalReview?.status.equipment, "VERIFIED");
  assert.match(outcome.reason ?? "", /still in the personal hangar/);
  await assert.rejects(
    centerApply(token, corporate.reviewID, corporate.reviewHash!, 7),
    /already dispatched/,
  );
  assert.equal(calls.filter((call) => call.kind === "provision-apply").length, 1);
});
