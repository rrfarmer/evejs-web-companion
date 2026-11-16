// The R4 Agents & Missions controller against a faked BFF: loadAgents fills the
// roster, openConversation decodes the agent dialogue, accepting a courier
// pulls the briefing (the journal is the server's notice's), a refused action surfaces through the store,
// and a lost session unwinds to offline.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { agentsTableAnswer, isAgentsTableCall, pilotDockedAt } from "./agentFixtures.ts";

// --- marshaled fixtures (handler-shaped) -----------------------------------
//
// (The station's agents are the page's own read since 2026-10-11: the whole table by agentMgr.GetAgents, and
// those at the station the page has its pilot docked at. AGENTS_RESPONSE keeps the agents these tests talk to;
// each stand-in answers the table with them, and has a pilot docked at their station.)

const AGENTS_RESPONSE = {
  ok: true,
  stationID: 60000004,
  agents: [
    {
      agentID: 3008416,
      agentTypeID: 2,
      divisionID: 22,
      level: 1,
      stationID: 60000004,
      corporationID: 1000002,
      missionKind: "courier",
      missionTypeLabel: "UI/Agents/MissionTypes/Courier",
    },
  ],
};

function offeredConversation() {
  return {
    ok: true,
    result: {
      type: "tuple",
      items: [
        {
          type: "tuple",
          items: [
            { type: "tuple", items: [127958, 1382] },
            { type: "list", items: [{ type: "tuple", items: [816, 3] }, { type: "tuple", items: [817, 9] }] },
          ],
        },
        { type: "dict", entries: [["missionDeclined", false], ["loyaltyPoints", 0]] },
      ],
    },
    notifications: [],
  };
}

function acceptedConversation() {
  return {
    ok: true,
    result: {
      type: "tuple",
      items: [
        {
          type: "tuple",
          items: [
            { type: "tuple", items: [127958, 1382] },
            { type: "list", items: [{ type: "tuple", items: [819, 6] }, { type: "tuple", items: [820, 11] }] },
          ],
        },
        { type: "dict", entries: [["missionCompleted", false], ["missionDeclined", false], ["loyaltyPoints", 0]] },
      ],
    },
    notifications: [],
  };
}

const BRIEFING_RESPONSE = {
  ok: true,
  agentID: 3008416,
  briefing: {
    type: "dict",
    entries: [
      ["Mission Title ID", 58607],
      ["AcceptTimestamp", { type: "long", value: "134289174004640000" }],
      ["Expiration Time", { type: "long", value: "134295222004640000" }],
    ],
  },
  objective: {
    type: "dict",
    entries: [
      [
        "objectives",
        {
          type: "list",
          items: [
            {
              type: "tuple",
              items: [
                "transport",
                {
                  type: "tuple",
                  items: [
                    1000002,
                    { type: "dict", entries: [["typeID", 1531], ["solarsystemID", 30002780], ["locationID", 60000004]] },
                    1000002,
                    { type: "dict", entries: [["typeID", 1531], ["solarsystemID", 30001399], ["locationID", 60000256]] },
                    { type: "dict", entries: [["volume", 0.1], ["typeID", 3814], ["quantity", 1]] },
                  ],
                },
              ],
            },
          ],
        },
      ],
      ["normalRewards", { type: "list", items: [{ type: "tuple", items: [29, 102000, null] }, { type: "tuple", items: [29, 38250, null] }] }],
      ["bonusRewards", { type: "list", items: [] }],
      ["loyaltyPoints", 213],
      ["missionTitleID", 58607],
    ],
  },
  location: { type: "dict", entries: [["locationID", 60000004]] },
  errors: { briefing: null, objective: null, location: null },
};

/**
 * The journal's read, as these tests name it: agentMgr.GetMyJournalDetails() asked by the generic call as a pilot's,
 * with nothing, which is how the page reads the journal (bridge/journalReads.ts). The route the page read until
 * 2026-10-10 is not this: a request of it keeps its own path, and nothing here answers it.
 */
const JOURNAL_READ = "agentMgr.GetMyJournalDetails()";
const asRead = (path: string, body: Record<string, unknown>): string =>
  (path === "/api/bridge/call" && body.service === "agentMgr" && body.method === "GetMyJournalDetails" && JSON.stringify(body.args) === "[]" && body.kwargs === null && body.pilot === true ? JOURNAL_READ : path);

/**
 * The page's own calls on an agent's object, as these tests name them. What is said to an agent
 * (agentMgr.DoAction(actionID), a pilot's write, of that agent) and an offer taken out of the journal
 * (agentMgr.RemoveOfferFromJournal()) were routes until 2026-10-13, and these tests were written to the routes: to
 * their paths, to the action's number in the body, and to an answer that names no service. The stand-ins hand such
 * a call to a test under its route's path and body, and name the service and the method in what the test answers,
 * as the generic call's envelope does. A call that is not the page's (no agent said, not a pilot's, not said to
 * be meant) keeps the generic call's path, and nothing here answers it.
 */
function asAgentRoute(path: string, body: Record<string, unknown>): { path: string; body: Record<string, unknown>; called: { service: string; method: string } | null } {
  const anAgents = path === "/api/bridge/call" && body.service === "agentMgr" && body.pilot === true && body.confirm === true && typeof body.of === "number" && (body.kwargs === null || body.kwargs === undefined);
  if (anAgents && body.method === "DoAction" && Array.isArray(body.args) && body.args.length === 1) {
    return { path: `/api/bridge/agents/${body.of}/action`, body: { actionID: body.args[0] }, called: { service: "agentMgr", method: "DoAction" } };
  }
  if (anAgents && body.method === "RemoveOfferFromJournal" && JSON.stringify(body.args) === "[]") {
    return { path: `/api/bridge/agents/${body.of}/remove-offer`, body: { confirm: true }, called: { service: "agentMgr", method: "RemoveOfferFromJournal" } };
  }
  return { path, body, called: null };
}
/** What a test answered such a call with, in the generic call's envelope: a refusal as it is. */
function enveloped(called: { service: string; method: string } | null, answer: unknown): unknown {
  const answered = answer !== null && typeof answer === "object" && (answer as { ok?: unknown }).ok === true && !("service" in answer);
  return called !== null && answered ? { ...(answer as object), ...called } : answer;
}

/** What that call answers, in the generic call's own envelope. */
function journalResponse(active: readonly unknown[]) {
  return {
    ok: true,
    service: "agentMgr",
    method: "GetMyJournalDetails",
    result: { type: "tuple", items: [{ type: "list", items: active }, { type: "list", items: [] }] },
    notifications: [],
  };
}

const ACTIVE_MISSION_ROW = {
  type: "tuple",
  items: [2, 0, "UI/Agents/MissionTypes/Courier", 58607, 3008416, { type: "long", value: "134295222004640000" }, { type: "list", items: [] }, 0, 0, 1382],
};

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => { status: number; body: unknown },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const method = (init && init.method) || "GET";
    const sent = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    const { path: named, body, called } = asAgentRoute(String(input), sent);
    const path = asRead(named, body);
    requests.push({ path, method, body });
    let outcome: { status: number; body: unknown };
    try {
      outcome = responder(path, method, body);
    } catch (cause) {
      // The window reads the mission's briefing for every layout. A test that is not about that read is
      // given the standing one.
      if (!/\/briefing$/.test(path)) throw cause;
      outcome = { status: 200, body: BRIEFING_RESPONSE };
    }
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return enveloped(called, outcome.body);
      },
    };
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

test("loadAgents fills the store's agent roster", async () => {
  const store = createClientStore();
  store.apply(pilotDockedAt(60000004));
  const { fetch } = makeFakeFetch((path, _method, body) => {
    if (isAgentsTableCall(path, body)) {
      return { status: 200, body: agentsTableAnswer(AGENTS_RESPONSE.agents) };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadAgents();

  const agents = store.agents.get();
  assert.equal(agents.loaded, true);
  assert.equal(agents.stationID, 60000004);
  assert.equal(agents.agents.length, 1);
  assert.equal(agents.agents[0]!.agentID, 3008416);
  assert.equal(agents.agents[0]!.missionKind, "courier");
});

test("openConversation decodes the agent dialogue into the store", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/agents/3008416/action") {
      return { status: 200, body: offeredConversation() };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.openConversation(3008416);

  // DoAction(None) opens the conversation; an offer is on the table, so nothing is pressed for the pilot.
  assert.deepEqual(requests[0]!.body, { actionID: null });
  // Then the layout: the briefing reads, and nothing else.
  assert.deepEqual(requests.map((request) => request.path), ["/api/bridge/agents/3008416/action", "/api/bridge/agents/3008416/briefing"]);
  const agents = store.agents.get();
  assert.equal(agents.activeAgentID, 3008416);
  assert.equal(agents.conversation!.actions.length, 2);
  assert.equal(agents.conversation!.actions[0]!.buttonType, 3);
  assert.equal(agents.actionError, null);
  // The offer's objectives are on show before it is accepted, as in the client's window.
  assert.equal(agents.briefing!.cargoTypeID, 3814);
});

test("accepting a courier posts DoAction(accept) then pulls the briefing, and no journal of its own", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/agents/3008416/action") {
      return { status: 200, body: acceptedConversation() };
    }
    if (path === "/api/bridge/agents/3008416/briefing") {
      return { status: 200, body: BRIEFING_RESPONSE };
    }
    if (path === JOURNAL_READ) {
      return { status: 200, body: journalResponse([ACTIVE_MISSION_ROW]) };
    }
    throw new Error(`unexpected ${path} ${JSON.stringify(body)}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.chooseAction(3008416, { actionID: 816, buttonType: 3, label: "Accept" });

  // The accept posted the token, then the briefing was pulled. The journal is the server's notice's to read again
  // (OnAgentMissionChange "accepted"): agentDialogueWindow.ExecuteAgentAction reads nothing of its own.
  const action = requests.find((r) => r.path === "/api/bridge/agents/3008416/action");
  assert.deepEqual(action!.body, { actionID: 816 });
  assert.ok(requests.some((r) => r.path === "/api/bridge/agents/3008416/briefing"));
  assert.equal(requests.some((r) => r.path === JOURNAL_READ), false);

  const agents = store.agents.get();
  // Briefing shows the courier cargo / destination / reward / time bonus.
  assert.equal(agents.briefing!.cargoTypeID, 3814);
  assert.equal(agents.briefing!.destinationLocationID, 60000256);
  assert.equal(agents.briefing!.rewardISK, "102000");
  assert.equal(agents.briefing!.bonusISK, "38250");
});

test("declining clears the briefing, and reads no journal of its own", async () => {
  const store = createClientStore();
  // Seed a stale briefing so the decline must clear it.
  store.apply({
    type: "agents/briefing",
    briefing: {
      missionTitleID: 1,
      cargoTypeID: 3814,
      cargoQuantity: 1,
      cargoVolume: 0.1,
      pickupLocationID: 1,
      pickupSystemID: 1,
      destinationLocationID: 2,
      destinationSystemID: 2,
      rewardISK: "1",
      bonusISK: null,
      loyaltyPoints: 1,
      expirationTime: null,
      acceptTimestamp: null,
    },
  });
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/agents/3008416/action") {
      return {
        status: 200,
        body: {
          ok: true,
          result: { type: "tuple", items: [{ type: "tuple", items: [{ type: "tuple", items: ["idle", { type: "dict", entries: [] }] }, { type: "list", items: [] }] }, { type: "dict", entries: [["missionDeclined", true]] }] },
          notifications: [],
        },
      };
    }
    if (path === JOURNAL_READ) {
      return { status: 200, body: journalResponse([]) };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.chooseAction(3008416, { actionID: 817, buttonType: 9, label: "Decline" });

  assert.equal(store.agents.get().briefing, null, "the stale briefing is cleared");
  // The server's OnAgentMissionChange "declined" reads the journal again, not the press.
  assert.equal(requests.some((r) => r.path === JOURNAL_READ), false);
});

test("a refused agent action is surfaced through the store, not thrown", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/agents/3008416/action") {
      return { status: 403, body: { ok: false, error: "CALL_NOT_ALLOWED", message: "nope" } };
    }
    return { status: 200, body: journalResponse([]) };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.openConversation(3008416);

  // R31 — the player reads the refusal, not the wire code that carried it.
  assert.equal(
    store.agents.get().actionError,
    "This client is not allowed to ask the game server for that.",
  );
});

// A completed-courier conversation: the agent re-offers (Request(821,2)) and
// lastActionInfo.missionCompleted is true.
function completedConversation() {
  return {
    ok: true,
    result: {
      type: "tuple",
      items: [
        {
          type: "tuple",
          items: [
            { type: "tuple", items: [127959, 1383] },
            { type: "list", items: [{ type: "tuple", items: [821, 2] }] },
          ],
        },
        { type: "dict", entries: [["missionCompleted", true], ["missionDeclined", false], ["loyaltyPoints", 213]] },
      ],
    },
    notifications: [],
  };
}

// The reward reads BFF response (wallet / LP / standings), retail-shaped.
const REWARDS_RESPONSE = {
  ok: true,
  cash: 1000165000,
  lp: {
    type: "objectex2",
    header: [],
    list: [
      { type: "packedrow", columns: [["issuerCorpID", 3], ["loyaltyPoints", 3]], values: [1000002, 213] },
    ],
    dict: [],
  },
  standings: {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [
        ["header", { type: "list", items: ["fromID", "standing"] }],
        ["RowClass", { type: "token", value: "util.Row" }],
        ["lines", { type: "list", items: [{ type: "list", items: [1000002, 0.42] }] }],
      ],
    },
  },
  errors: { cash: null, lp: null, standings: null },
};

test("completing a courier posts DoAction(complete), clears the briefing, and pulls the reward reads, and no journal", async () => {
  const store = createClientStore();
  // Seed a stale briefing so completion must clear it.
  store.apply({
    type: "agents/briefing",
    briefing: {
      missionTitleID: 58607, cargoTypeID: 3814, cargoQuantity: 1, cargoVolume: 0.1,
      pickupLocationID: 60000004, pickupSystemID: 30002780, destinationLocationID: 60000256,
      destinationSystemID: 30001399, rewardISK: "102000", bonusISK: null, loyaltyPoints: 213,
      expirationTime: null, acceptTimestamp: null,
    },
  });
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/agents/3008416/action") {
      return { status: 200, body: completedConversation() };
    }
    if (path === "/api/bridge/rewards") {
      return { status: 200, body: REWARDS_RESPONSE };
    }
    if (path === JOURNAL_READ) {
      return { status: 200, body: journalResponse([]) };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  // The Complete button is buttonType 6.
  await flow.chooseAction(3008416, { actionID: 819, buttonType: 6, label: "Complete Mission" });

  // Complete posted the token, then the reward reads were pulled; the journal is the server's notice's to read again.
  const action = requests.find((r) => r.path === "/api/bridge/agents/3008416/action");
  assert.deepEqual(action!.body, { actionID: 819 });
  assert.ok(requests.some((r) => r.path === "/api/bridge/rewards"), "rewards pulled");
  assert.equal(requests.some((r) => r.path === JOURNAL_READ), false, "no journal read of the press's own");

  const agents = store.agents.get();
  assert.equal(agents.briefing, null, "the briefing is cleared after completion");

  // The reward readout reflects the payout.
  const rewards = store.rewards.get();
  assert.equal(rewards.loaded, true);
  assert.equal(rewards.cashBalance, "1000165000");
  assert.deepEqual(rewards.lpBalances, [{ issuerCorpID: 1000002, loyaltyPoints: "213" }]);
  assert.deepEqual(rewards.standings, [{ fromID: 1000002, standing: 0.42 }]);
  assert.equal(rewards.error, null);
});

test("loadPackageIntoShip finds the matching hangar stack and moves it to cargo", async () => {
  const store = createClientStore();
  const inventoryResponse = {
    ok: true,
    stationID: 60000004,
    activeShipID: 9001,
    hangar: {
      list: {
        type: "list",
        items: [
          { type: "packedrow", fields: { itemID: 7777, typeID: 3814, quantity: 1, flagID: 4 } },
          { type: "packedrow", fields: { itemID: 8888, typeID: 34, quantity: 500, flagID: 4 } },
        ],
      },
      capacity: null,
      error: null,
    },
    cargo: { shipID: 9001, list: { type: "list", items: [] }, capacity: null, error: null },
  };
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/inventory") {
      return { status: 200, body: inventoryResponse };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return {
        status: 200,
        body: { ok: true, applied: true, moved: [7777], reminted: [], declined: [], declinedSilently: false, notFound: [] },
      };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadPackageIntoShip(3814, 1);

  // R35: the move now goes through the VERIFYING /transfer route, and the stack
  // is chosen by the mission's type AND quantity.
  const move = requests.find((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(move, "the matching package was moved");
  assert.deepEqual(move!.body.itemIDs, [7777]);
  assert.deepEqual(move!.body.to, { kind: "cargo" });
  assert.equal(store.agents.get().actionError, null);
});

test("loadPackageIntoShip surfaces a clear error when the package is not in the hangar", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/inventory") {
      return {
        status: 200,
        body: {
          ok: true, stationID: 60000004, activeShipID: 9001,
          hangar: { list: { type: "list", items: [] }, capacity: null, error: null },
          cargo: { shipID: 9001, list: { type: "list", items: [] }, capacity: null, error: null },
        },
      };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadPackageIntoShip(3814, 1);

  assert.ok(!requests.some((r) => r.path === "/api/bridge/inventory/transfer"), "no move issued");
  assert.match(store.agents.get().actionError ?? "", /not in the station hangar/);
});

test("a lost session during an agent read flips the character offline and rethrows", async () => {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: 140000003,
      characterName: "Test Three",
      stationID: 60000004,
      structureID: null,
      solarSystemID: 30002780,
      corporationID: 1000002,
    },
    station: null,
  });
  const { fetch } = makeFakeFetch(() => ({
    status: 404,
    body: { ok: false, error: "SESSION_NOT_FOUND", message: "gone" },
  }));
  const flow = createAppFlow(store, { fetch });

  await assert.rejects(() => flow.loadAgents());
  assert.equal(store.station.get().online, null, "character flipped offline");
});

// --- R35: the three predicates that used to lie ----------------------------
// Every fixture below is built from bytes CAPTURED on the live rail (agent
// 3008416 Antaken Kamola, mission "Tidings of Conflict (1 of 2)", package
// Reports x1 from Muvolailen 60000004 to Elonaya 60000256), not from a guess.

/**
 * The REFUSED Complete, exactly as the live server answered it when the button
 * was pressed docked at the PICKUP station instead of the dropoff.
 *
 * Note what this actually is, because it is not what the code assumed:
 *   * HTTP 200, ok:true — a refusal is indistinguishable from success by status
 *   * missionCompleted is `null`, NOT `false`
 *   * the available-actions list is EMPTY (no Complete, no Quit)
 *   * the only reason given is an OnMissionsUpdated notification naming the
 *     unmet objective: ["TransportItemsPresent", "3814", "60000256", "1"]
 */
function refusedCompleteConversation() {
  return {
    ok: true,
    result: {
      type: "tuple",
      items: [
        {
          type: "tuple",
          items: [
            { type: "tuple", items: [127958, 1382] },
            { type: "list", items: [] },
          ],
        },
        {
          type: "dict",
          entries: [
            ["missionCompleted", null],
            ["missionQuit", null],
            ["missionCantReplay", null],
            ["loyaltyPoints", 0],
            ["missionDeclined", null],
          ],
        },
      ],
    },
    notifications: [
      {
        kind: "client",
        service: null,
        method: "OnMissionsUpdated",
        idType: "charid",
        args: [
          [
            {
              type: "dict",
              entries: [
                ["info", { type: "list", items: ["TransportItemsPresent", "3814", "60000256", "1"] }],
                ["agentID", 3008416],
              ],
            },
          ],
        ],
        kwargs: null,
      },
    ],
  };
}

const LIVE_BRIEFING = {
  missionTitleID: 58607, cargoTypeID: 3814, cargoQuantity: 1, cargoVolume: 0.1,
  pickupLocationID: 60000004, pickupSystemID: 30002780, destinationLocationID: 60000256,
  destinationSystemID: 30001399, rewardISK: "102000", bonusISK: null, loyaltyPoints: 213,
  expirationTime: null, acceptTimestamp: null,
};

test("R35 predicate 1: a REFUSED Complete keeps the briefing and pulls no reward reads", async () => {
  const store = createClientStore();
  store.apply({ type: "agents/briefing", briefing: { ...LIVE_BRIEFING } });
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/agents/3008416/action") {
      return { status: 200, body: refusedCompleteConversation() };
    }
    if (path === JOURNAL_READ) {
      return { status: 200, body: journalResponse([ACTIVE_MISSION_ROW]) };
    }
    if (path === "/api/bridge/rewards") {
      return { status: 200, body: REWARDS_RESPONSE };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.chooseAction(3008416, { actionID: 819, buttonType: 6, label: "Complete Mission" });

  // The mission did NOT complete, so nothing may be reported as if it had.
  assert.ok(
    !requests.some((r) => r.path === "/api/bridge/rewards"),
    "a refused Complete must not pull the payout reads — there was no payout",
  );
  const agents = store.agents.get();
  // Read again for this layout, and still shown: the last action ended nothing.
  assert.ok(requests.some((r) => r.path === "/api/bridge/agents/3008416/briefing"));
  assert.equal(agents.briefing!.cargoTypeID, LIVE_BRIEFING.cargoTypeID, "the mission is still accepted, so its briefing must survive a refusal");
  assert.equal(agents.briefing!.destinationLocationID, LIVE_BRIEFING.destinationLocationID);
  // Nor is the journal read: a refusal changes nothing in it, and the press reads none of its own.
  assert.equal(requests.some((r) => r.path === JOURNAL_READ), false);
});

test("R35 predicate 1: a SUCCESSFUL Complete (missionCompleted true) still clears and pays out", async () => {
  const store = createClientStore();
  store.apply({ type: "agents/briefing", briefing: { ...LIVE_BRIEFING } });
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/agents/3008416/action") {
      return { status: 200, body: completedConversation() };
    }
    if (path === "/api/bridge/rewards") {
      return { status: 200, body: REWARDS_RESPONSE };
    }
    if (path === JOURNAL_READ) {
      return { status: 200, body: journalResponse([]) };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.chooseAction(3008416, { actionID: 821, buttonType: 6, label: "Complete Mission" });

  assert.ok(requests.some((r) => r.path === "/api/bridge/rewards"), "rewards pulled on a real completion");
  assert.equal(store.agents.get().briefing, null, "a real completion clears the briefing");
});

test("R35 predicate 2: loadPackageIntoShip picks the mission's stack, not the first of that type", async () => {
  const store = createClientStore();
  // The player's OWN Reports sit in the hangar first (a bigger stack, and the
  // one `.find(row => row.typeID === cargoTypeID)` used to grab). The mission
  // package is the stack whose quantity is the mission's quantity.
  const inventoryResponse = {
    ok: true,
    stationID: 60000004,
    activeShipID: 9988400091900,
    hangar: {
      list: {
        type: "list",
        items: [
          { type: "packedrow", fields: { itemID: 5555, typeID: 3814, quantity: 40, flagID: 4 } },
          { type: "packedrow", fields: { itemID: 9988400091901, typeID: 3814, quantity: 1, flagID: 4 } },
        ],
      },
      capacity: null,
      error: null,
    },
    cargo: { shipID: 9988400091900, list: { type: "list", items: [] }, capacity: null, error: null },
  };
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/inventory") {
      return { status: 200, body: inventoryResponse };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return {
        status: 200,
        body: { ok: true, applied: true, moved: [9988400091901], reminted: [], declined: [], declinedSilently: false, notFound: [] },
      };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadPackageIntoShip(3814, 1);

  const transfer = requests.find((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfer, "the package was transferred");
  assert.deepEqual(
    transfer!.body.itemIDs,
    [9988400091901],
    "the stack matching the MISSION quantity is the package — not the player's own 40",
  );
  assert.equal(transfer!.body.qty, 1, "exactly the mission quantity moves");
  assert.equal(store.agents.get().actionError, null);
});

test("R35 predicate 3: the courier load goes through the VERIFYING transfer route", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/inventory") {
      return {
        status: 200,
        body: {
          ok: true, stationID: 60000004, activeShipID: 9988400091900,
          hangar: {
            list: { type: "list", items: [{ type: "packedrow", fields: { itemID: 9988400091901, typeID: 3814, quantity: 1, flagID: 4 } }] },
            capacity: null, error: null,
          },
          cargo: { shipID: 9988400091900, list: { type: "list", items: [] }, capacity: null, error: null },
        },
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [9988400091901], reminted: [], declined: [], declinedSilently: false, notFound: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadPackageIntoShip(3814, 1);

  assert.ok(
    !requests.some((r) => r.path === "/api/bridge/inventory/move"),
    "the unverified /move route must no longer carry the mission package",
  );
  const transfer = requests.find((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfer, "the verifying /transfer route carries it instead");
  assert.deepEqual(transfer!.body.from, { kind: "hangar" });
  assert.deepEqual(transfer!.body.to, { kind: "cargo" });
});

test("R35 predicate 3: a SILENTLY DECLINED package move is reported, not passed off as loaded", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/inventory") {
      return {
        status: 200,
        body: {
          ok: true, stationID: 60000004, activeShipID: 9988400091900,
          hangar: {
            list: { type: "list", items: [{ type: "packedrow", fields: { itemID: 9988400091901, typeID: 3814, quantity: 1, flagID: 4 } }] },
            capacity: null, error: null,
          },
          cargo: { shipID: 9988400091900, list: { type: "list", items: [] }, capacity: null, error: null },
        },
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      // The shape /move could never see: a 200 in which nothing moved.
      return {
        status: 200,
        body: { ok: true, applied: false, moved: [], reminted: [], declined: [9988400091901], declinedSilently: true, notFound: [] },
      };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadPackageIntoShip(3814, 1);

  assert.match(
    store.agents.get().actionError ?? "",
    /did not move|could not be loaded|refused/i,
    "a silent decline must reach the player, not be reported as a successful load",
  );
});

// --- the window as the client lays it out ------------------------------------

/** A conversation with these (actionID, buttonType) on offer and this said of the last action. */
function conversationWith(actions: readonly (readonly [number, number])[], info: readonly (readonly [string, unknown])[] = [["loyaltyPoints", 0]]) {
  return {
    ok: true,
    result: {
      type: "tuple",
      items: [
        {
          type: "tuple",
          items: [
            { type: "tuple", items: [127958, 1382] },
            { type: "list", items: actions.map(([actionID, buttonType]) => ({ type: "tuple", items: [actionID, buttonType] })) },
          ],
        },
        { type: "dict", entries: info.map(([name, value]) => [name, value]) },
      ],
    },
    notifications: [],
  };
}

/** A flow whose agent answers each DoAction from `answers`, by the action pressed (null for the opening). */
async function talking(answers: Record<string, ReturnType<typeof conversationWith>>, agentTypeID: number | null = 2) {
  const store = createClientStore();
  store.apply(pilotDockedAt(60000004));
  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (isAgentsTableCall(path, body)) {
      return { status: 200, body: agentsTableAnswer(agentTypeID === null ? [] : [{ ...AGENTS_RESPONSE.agents[0]!, agentTypeID }]) };
    }
    if (path === "/api/bridge/agents/3008416/action") {
      const answer = answers[String(body.actionID)];
      if (!answer) throw new Error(`no answer for action ${String(body.actionID)}`);
      return { status: 200, body: answer };
    }
    if (path === JOURNAL_READ) {
      return { status: 200, body: journalResponse([]) };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });
  await flow.loadAgents();
  requests.length = 0;
  const pressed = () => requests.filter((request) => request.path.endsWith("/action")).map((request) => request.body.actionID);
  return { store, flow, requests, pressed };
}

test("opening an agent's window presses Request Mission at once, as the client's window does", async () => {
  const { store, flow, requests, pressed } = await talking({
    null: conversationWith([[821, 2]]),
    821: conversationWith([[816, 3], [817, 9]]),
  });
  await flow.openConversation(3008416);
  assert.deepEqual(pressed(), [null, 821]);
  // The briefing's times are kept with the layout.
  assert.deepEqual(store.agents.get().missionTimes, { declineTime: null, expirationTime: 134295222004640000n });
  // One layout, of what came of the press: the briefing read once, after both. The journal the press changed is the
  // server's notice's to read again (OnAgentMissionChange "offered"), not the window's.
  assert.deepEqual(requests.map((request) => request.path.split("/").at(-1)), ["action", "action", "briefing"]);
  assert.equal(store.agents.get().journal, null);
  const agents = store.agents.get();
  assert.deepEqual(agents.conversation!.actions.map((action) => action.buttonType), [3, 9]);
  assert.equal(agents.briefing!.cargoTypeID, 3814);
  assert.equal(agents.actionError, null);
});

test("the opening press is for an agent with nothing else to do: not a locator, not a research agent, unless it is all there is", async () => {
  const offer = conversationWith([[816, 3], [817, 9]]);
  // View Mission first, with more on offer, from an ordinary agent: pressed.
  const ordinary = await talking({ null: conversationWith([[900, 1], [901, 10]]), 900: offer });
  await ordinary.flow.openConversation(3008416);
  assert.deepEqual(ordinary.pressed(), [null, 900]);
  // The same from a research agent: left for the pilot.
  const research = await talking({ null: conversationWith([[900, 1], [901, 13], [902, 14]]) }, 4);
  await research.flow.openConversation(3008416);
  assert.deepEqual(research.pressed(), [null]);
  assert.deepEqual(research.store.agents.get().conversation!.actions.map((action) => action.buttonType), [1, 13, 14]);
  // And from an agent that also locates characters.
  const locator = await talking({ null: conversationWith([[900, 2], [903, 15]]) });
  await locator.flow.openConversation(3008416);
  assert.deepEqual(locator.pressed(), [null]);
  // A research agent with only the mission on offer: pressed.
  const only = await talking({ null: conversationWith([[900, 2]]), 900: offer }, 4);
  await only.flow.openConversation(3008416);
  assert.deepEqual(only.pressed(), [null, 900]);
  // Something other than a mission first: nothing is pressed.
  const other = await talking({ null: conversationWith([[816, 3], [900, 2]]) });
  await other.flow.openConversation(3008416);
  assert.deepEqual(other.pressed(), [null]);
  // An agent the roster does not have: only when it is all there is.
  const unknown = await talking({ null: conversationWith([[900, 2], [901, 10]]) }, null);
  await unknown.flow.openConversation(3008416);
  assert.deepEqual(unknown.pressed(), [null]);
  // Nothing on offer at all.
  const silent = await talking({ null: conversationWith([]) });
  await silent.flow.openConversation(3008416);
  assert.deepEqual(silent.pressed(), [null]);
  // With nothing pressed, nothing changed, and the journal is not read again.
  assert.equal(silent.requests.some((request) => request.path === JOURNAL_READ), false);
});

test("the briefing and the objectives are read for every layout, whatever was pressed", async () => {
  const { store, flow, requests } = await talking({ 818: conversationWith([[816, 3], [817, 9]]) });
  // Defer: not an accept, a decline or a completion.
  await flow.chooseAction(3008416, { actionID: 818, buttonType: 10, label: "Defer" });
  assert.deepEqual(requests.map((request) => request.path.split("/").at(-1)), ["action", "briefing"]);
  assert.equal(store.agents.get().briefing!.cargoTypeID, 3814);
});

test("the objectives are not shown when the last action ended the mission, or the agent said not yet", async () => {
  for (const [name, value] of [["missionCompleted", true], ["missionDeclined", true], ["missionQuit", true], ["missionCantReplay", 3_600_000]] as const) {
    const { store, flow, requests } = await talking({ 820: conversationWith([[821, 2]], [[name, value], ["loyaltyPoints", 0]]) });
    await flow.chooseAction(3008416, { actionID: 820, buttonType: 11, label: "Quit" });
    // Read all the same, as the client reads it; it is the showing that the rule decides.
    assert.ok(requests.some((request) => request.path.endsWith("/briefing")), name);
    assert.equal(store.agents.get().briefing, null, name);
  }
  // None of them said: shown.
  const still = await talking({ 820: conversationWith([[819, 6]], [["missionCompleted", false], ["missionDeclined", null], ["missionCantReplay", 0]]) });
  await still.flow.chooseAction(3008416, { actionID: 820, buttonType: 8, label: "Continue" });
  assert.equal(still.store.agents.get().briefing!.cargoTypeID, 3814);
});

test("a briefing that cannot be read leaves the conversation on show and says what went wrong", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/agents/3008416/action") return { status: 200, body: offeredConversation() };
    if (path === "/api/bridge/agents/3008416/briefing") return { status: 502, body: { ok: false, error: "CALL_FAILED", message: "no" } };
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });
  await flow.openConversation(3008416);
  const agents = store.agents.get();
  assert.equal(agents.conversation!.actions.length, 2);
  assert.equal(agents.briefing, null);
  assert.notEqual(agents.actionError, null);
});

// --- the window listens, as the client's does ---------------------------------
//
// agentDialogueWindow has two notify events: OnAgentMissionChange and OnSessionChanged. These tests push
// them down the live channel, as the server does.

const LISTENING_PILOT = 140000002;
const OTHER_AGENT = 3008417;

interface PushSource {
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

/**
 * A pilot online with its live channel open and the Agents panel loaded. Its agents answer each DoAction
 * from `answers`, by the action pressed (null for the opening). `hold` makes every DoAction wait.
 */
async function listening(
  answers: Record<string, ReturnType<typeof conversationWith>>,
  /** `routes` answers a path before anything here does: [status, body], or undefined to leave it to what is here. */
  options: { journal?: boolean; routes?: (path: string, body: Record<string, unknown>) => Promise<[number, unknown] | undefined> | [number, unknown] | undefined } = {},
) {
  const store = createClientStore();
  const requests: Recorded[] = [];
  const state: {
    hold: Promise<void> | null;
    /** One action made to wait, by what was pressed (null for the opening). */
    holdAction: { actionID: number | null; wait: Promise<void> } | null;
    journalHold: Promise<void> | null;
    failAction: boolean;
    sessionGone: boolean;
    failJournal: boolean;
    /** How many more DoActions the BFF refuses because the pilot is busy, and with which of its two refusals. */
    busyFor: number;
    busyCode: "SESSION_CHANGE_IN_PROGRESS" | "CHARACTER_IN_USE";
  } = { hold: null, holdAction: null, journalHold: null, failAction: false, sessionGone: false, failJournal: false, busyFor: 0, busyCode: "SESSION_CHANGE_IN_PROGRESS" };
  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const sent = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    const { path: named, body, called } = asAgentRoute(String(input), sent);
    const path = asRead(named, body);
    requests.push({ path, method: (init && init.method) || "GET", body });
    let status = 200;
    let answer: unknown = { ok: true };
    const routed = options.routes ? await options.routes(path, body) : undefined;
    if (routed !== undefined) {
      [status, answer] = routed;
    } else if (isAgentsTableCall(path, body)) {
      answer = agentsTableAnswer([AGENTS_RESPONSE.agents[0]!, { ...AGENTS_RESPONSE.agents[0]!, agentID: OTHER_AGENT }]);
    } else if (path === "/api/bridge/call") {
      // What coming online reads of the station: answered with nothing, in the route's own envelope.
      answer = { ok: true, service: body.service, method: body.method, result: null, notifications: [] };
    } else if (path === "/api/bridge/select") {
      answer = {
        ok: true,
        character: { characterID: LISTENING_PILOT, characterName: "Test Two", stationID: 60000004, structureID: null, solarSystemID: 30002780, corporationID: 1000002 },
        station: null,
        notifications: [],
      };
    } else if (/^\/api\/bridge\/agents\/\d+\/action$/.test(path)) {
      if (state.hold) await state.hold;
      if (state.holdAction && state.holdAction.actionID === body.actionID) await state.holdAction.wait;
      if (state.busyFor > 0) {
        state.busyFor -= 1;
        status = 409;
        answer = { ok: false, error: state.busyCode, message: "This pilot is busy with another action." };
      } else if (state.sessionGone) {
        status = 404;
        answer = { ok: false, error: "SESSION_NOT_FOUND", message: "The game session is gone." };
      } else if (state.failAction) {
        status = 409;
        answer = { ok: false, error: "CALL_REFUSED", message: "The agent will not talk now." };
      } else {
        answer = answers[String(body.actionID)];
        if (!answer) throw new Error(`no answer for action ${String(body.actionID)}`);
      }
    } else if (/\/briefing$/.test(path)) {
      answer = BRIEFING_RESPONSE;
    } else if (path === JOURNAL_READ) {
      if (state.journalHold) await state.journalHold;
      if (state.failJournal) {
        status = 502;
        answer = { ok: false, error: "EVE_GATEWAY_UNREACHABLE", message: "The game server is unreachable." };
      } else {
        answer = journalResponse([ACTIVE_MISSION_ROW]);
      }
    }
    return { ok: status >= 200 && status < 300, status, async json() { return enveloped(called, answer); } };
  }) as unknown as typeof fetch;
  const sources: PushSource[] = [];
  const eventSource = (): PushSource => {
    const source: PushSource = { onmessage: null, onopen: null, onerror: null, close() {} };
    sources.push(source);
    return source;
  };
  const flow = createAppFlow(store, { fetch: fetchImpl, eventSource, agentTalkAgainWaitMs: 2 });
  await flow.selectCharacter(LISTENING_PILOT);
  const source = sources[0];
  assert.ok(source, "coming online opens the live channel");
  source.onopen?.();
  await flow.loadAgents();
  if (options.journal !== false) await flow.loadJournal();
  requests.length = 0;
  let sequence = 0;
  /** The server pushes a notification, and what it sets going is given time to finish. */
  const push = async (method: string, args: readonly unknown[], kind = "client") => {
    sequence += 1;
    source.onmessage?.({
      data: JSON.stringify({
        source: "evejs-web-gateway",
        apiVersion: 1,
        type: "event",
        cursor: { epoch: "epoch-1", sequence },
        event: { kind: "notification", notification: { kind, service: null, method, args, kwargs: null } },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
  };
  /** What was asked about agents and the journal, each by its last word (and the action pressed), sorted. */
  const asked = () => requests
    .filter((request) => request.path.startsWith("/api/bridge/agents/") || request.path === JOURNAL_READ)
    .map((request) => (request.path === JOURNAL_READ ? "journal" : request.path.endsWith("/action") ? `${request.path.split("/").at(-2)}:action:${String(request.body.actionID)}` : request.path.split("/").at(-1) ?? ""))
    .sort();
  return { store, flow, requests, push, asked, state };
}

const ACCEPTED = conversationWith([[819, 6], [822, 11]]);

/** Waits until something is so, for two seconds at most. */
async function until(what: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2000 && !what(); waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("told its mission was modified, the open window talks to its agent again, and the journal is read again", async () => {
  const { store, flow, requests, push, asked } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  requests.length = 0;

  await push("OnAgentMissionChange", ["modified", 3008416]);
  // The whole opening again, and its layout: what the agent says, then the mission beside it.
  assert.deepEqual(asked(), ["3008416:action:null", "briefing", "journal"]);
  assert.equal(store.agents.get().activeAgentID, 3008416);
  assert.deepEqual(store.agents.get().conversation?.actions.map((action) => action.buttonType), [6, 11]);
  assert.equal(store.agents.get().actionError, null);
});

test("talking again is the opening again: a mission to view is pressed for, as when the window opened", async () => {
  const { flow, requests, push, asked } = await listening({ null: conversationWith([[900, 1]]), 900: ACCEPTED });
  await flow.openConversation(3008416);
  requests.length = 0;
  await push("OnAgentMissionChange", ["modified", 3008416]);
  // The journal once, for the change the server told of: the window's own press reads none.
  assert.deepEqual(asked(), ["3008416:action:900", "3008416:action:null", "briefing", "journal"]);
});

test("another agent's mission modified leaves the window alone; the journal is still out of date", async () => {
  const { flow, requests, push, asked } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  requests.length = 0;
  await push("OnAgentMissionChange", ["modified", OTHER_AGENT]);
  assert.deepEqual(asked(), ["journal"]);
});

test("what else the server says of a mission leaves the window as it is, and the journal is read again each time", async () => {
  const { store, flow, requests, push, asked } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  for (const action of ["accepted", "completed", "offered", "offer_declined", "quit", "failed", "prolong"]) {
    requests.length = 0;
    await push("OnAgentMissionChange", [action, 3008416]);
    assert.deepEqual(asked(), ["journal"], action);
    assert.equal(store.agents.get().activeAgentID, 3008416, action);
  }
});

test("the offer taken away, the mission reset, or the talk done: the window on that agent closes", async () => {
  for (const action of ["offer_removed", "reset", "talk_to_completed"]) {
    const { store, flow, requests, push, asked } = await listening({ null: ACCEPTED });
    await flow.openConversation(3008416);
    assert.notEqual(store.agents.get().briefing, null, "a mission is laid out beside what the agent says");
    requests.length = 0;

    // About another agent: nothing closes.
    await push("OnAgentMissionChange", [action, OTHER_AGENT]);
    assert.equal(store.agents.get().activeAgentID, 3008416, action);

    await push("OnAgentMissionChange", [action, 3008416]);
    const agents = store.agents.get();
    assert.equal(agents.activeAgentID, null, action);
    assert.equal(agents.conversation, null, action);
    assert.equal(agents.briefing, null, action);
    // The roster and the journal are still there, and nothing was asked of the agent.
    assert.equal(agents.agents.length, 2);
    assert.notEqual(agents.journal, null);
    assert.deepEqual(asked(), ["journal", "journal"], action);
  }
});

test("with no window open a mission change is the journal's alone, and a journal never read is not read", async () => {
  const read = await listening({ null: ACCEPTED });
  await read.push("OnAgentMissionChange", ["modified", 3008416]);
  assert.deepEqual(read.asked(), ["journal"]);

  const unread = await listening({ null: ACCEPTED }, { journal: false });
  await unread.push("OnAgentMissionChange", ["modified", 3008416]);
  await unread.push("OnAgentMissionChange", ["reset", null]);
  assert.deepEqual(unread.asked(), []);
});

test("a window that is talking to its agent is not made to start again", async () => {
  const { flow, requests, push, asked, state } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  requests.length = 0;

  let release!: () => void;
  state.hold = new Promise<void>((resolve) => { release = resolve; });
  const opening = flow.openConversation(3008416);
  // While that DoAction is out: the server says modified twice, and the pilot changes station.
  await push("OnAgentMissionChange", ["modified", 3008416]);
  await push("OnAgentMissionChange", ["modified", 3008416]);
  await push("OnSessionChanged", [{ stationid: [60000004, null] }], "sessionchange");
  release();
  await opening;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(asked().filter((word) => word !== "journal"), ["3008416:action:null", "briefing"]);

  // Once it has finished, it can be told again.
  state.hold = null;
  requests.length = 0;
  await push("OnAgentMissionChange", ["modified", 3008416]);
  assert.deepEqual(asked(), ["3008416:action:null", "briefing", "journal"]);
});

test("a button pressed while the window is talking to that agent does nothing; another agent's window is its own", async () => {
  const { store, flow, requests, asked, state } = await listening({ null: ACCEPTED, 819: conversationWith([], [["missionCompleted", true]]) });
  let release!: () => void;
  state.hold = new Promise<void>((resolve) => { release = resolve; });
  const opening = flow.openConversation(3008416);
  const pressed = flow.chooseAction(3008416, { actionID: 819, buttonType: 6, label: "Complete Mission" });
  const other = flow.openConversation(OTHER_AGENT);
  release();
  await Promise.all([opening, pressed, other]);
  assert.deepEqual(asked().filter((word) => word.includes(":action:")), ["3008416:action:null", "3008417:action:null"]);
  // Afterwards the button works.
  state.hold = null;
  requests.length = 0;
  await flow.chooseAction(3008416, { actionID: 819, buttonType: 6, label: "Complete Mission" });
  assert.deepEqual(asked().filter((word) => word.includes(":action:")), ["3008416:action:819"]);
  assert.equal(store.agents.get().actionError, null);
});

test("changes that come while the journal is being read are answered by one more read, not one each", async () => {
  const { push, asked, state } = await listening({ null: ACCEPTED });
  let release!: () => void;
  state.journalHold = new Promise<void>((resolve) => { release = resolve; });
  await push("OnAgentMissionChange", ["completed", 3008416]);
  await push("OnAgentMissionChange", ["offered", OTHER_AGENT]);
  await push("OnAgentMissionChange", ["accepted", OTHER_AGENT]);
  assert.deepEqual(asked(), ["journal"], "one read is out");
  state.journalHold = null;
  release();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(asked(), ["journal", "journal"]);
  // And the next change after that is read for as usual.
  await push("OnAgentMissionChange", ["quit", OTHER_AGENT]);
  assert.deepEqual(asked(), ["journal", "journal", "journal"]);
});

test("the pilot changes station, and the open window talks to its agent again", async () => {
  const { store, flow, requests, push, asked } = await listening({ null: ACCEPTED });
  // No window open: a change of station asks nothing of any agent.
  await push("OnSessionChanged", [{ stationid: [60000004, null], solarsystemid: [null, 30002780] }], "sessionchange");
  assert.deepEqual(asked(), []);

  await flow.openConversation(3008416);
  requests.length = 0;
  // Undocked: the station is one of the things that changed.
  await push("OnSessionChanged", [{ stationid: [60000004, null], solarsystemid: [null, 30002780] }], "sessionchange");
  assert.deepEqual(asked(), ["3008416:action:null", "briefing"]);
  // Something else changed (another ship boarded): the window stays as it is.
  requests.length = 0;
  await push("OnSessionChanged", [{ shipid: [1, 2] }], "sessionchange");
  await push("OnSessionChanged", [null], "sessionchange");
  assert.deepEqual(asked(), []);
  assert.equal(store.agents.get().activeAgentID, 3008416);
});

test("the agent refusing to talk again is shown where the conversation is, and nothing is thrown", async () => {
  const { store, flow, push, state } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  state.failAction = true;
  await push("OnAgentMissionChange", ["modified", 3008416]);
  assert.match(store.agents.get().actionError ?? "", /will not talk now/);
  // The conversation that was on show stays on show.
  assert.equal(store.agents.get().activeAgentID, 3008416);
  assert.deepEqual(store.agents.get().conversation?.actions.map((action) => action.buttonType), [6, 11]);
});

test("the session going while the window talks again takes the pilot offline, and nothing is left unhandled", async () => {
  const { store, flow, push, state } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  assert.notEqual(store.station.get().online, null);
  state.sessionGone = true;
  await push("OnSessionChanged", [{ stationid: [60000004, null] }], "sessionchange");
  assert.equal(store.station.get().online, null);
});

test("a journal that cannot be read stays as it was, and the next change reads it again", async () => {
  const { store, push, asked, state } = await listening({ null: ACCEPTED });
  const before = store.agents.get().journal;
  state.failJournal = true;
  await push("OnAgentMissionChange", ["offered", OTHER_AGENT]);
  assert.deepEqual(asked(), ["journal"]);
  assert.equal(store.agents.get().journal, before);
  state.failJournal = false;
  await push("OnAgentMissionChange", ["accepted", OTHER_AGENT]);
  assert.deepEqual(asked(), ["journal", "journal"]);
  assert.notEqual(store.agents.get().journal, null);
});

test("a window the server closes while its own press is out is not opened again by the answer", async () => {
  // Declining: the server answers with the agent's parting words, and on the way says the mission was reset.
  const { store, flow, requests, push, asked, state } = await listening({ null: ACCEPTED, 817: conversationWith([[821, 2]], [["missionDeclined", true]]) });
  await flow.openConversation(3008416);
  requests.length = 0;

  let release!: () => void;
  state.hold = new Promise<void>((resolve) => { release = resolve; });
  const pressed = flow.chooseAction(3008416, { actionID: 817, buttonType: 9, label: "Decline" });
  await push("OnAgentMissionChange", ["reset", 3008416]);
  assert.equal(store.agents.get().activeAgentID, null, "the window closed when it was told");
  release();
  await pressed;
  const agents = store.agents.get();
  assert.equal(agents.activeAgentID, null, "and the answer did not open it again");
  assert.equal(agents.conversation, null);
  assert.equal(agents.briefing, null);
  // Nothing was read for a layout nobody will see.
  assert.deepEqual(asked().filter((word) => word !== "journal"), ["3008416:action:817"]);

  // Clicked again, the agent is talked to as from new.
  state.hold = null;
  requests.length = 0;
  await flow.openConversation(3008416);
  assert.equal(store.agents.get().activeAgentID, 3008416);
  assert.deepEqual(asked(), ["3008416:action:null", "briefing"]);
});

test("a window closed while it was opening stays closed, at either of its two questions", async () => {
  for (const under of [null, 900]) {
    const { store, flow, push, asked, state } = await listening({ null: conversationWith([[900, 1]]), 900: ACCEPTED });
    let release!: () => void;
    state.holdAction = { actionID: under, wait: new Promise<void>((resolve) => { release = resolve; }) };
    const opening = flow.openConversation(3008416);
    // Time for the window to reach the question it is to be closed under.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await push("OnAgentMissionChange", ["reset", 3008416]);
    release();
    await opening;
    assert.equal(store.agents.get().activeAgentID, null, String(under));
    assert.equal(store.agents.get().conversation, null, String(under));
    assert.equal(store.agents.get().actionError, null, "and stopping there is not a failure");
    // It stopped where it was closed: no further question, and nothing read for a layout.
    assert.deepEqual(asked().filter((word) => word !== "journal"), under === null ? ["3008416:action:null"] : ["3008416:action:900", "3008416:action:null"], String(under));
  }
});

test("a close told of another agent, or with nothing out, does not swallow the next answer", async () => {
  const { store, flow, push, state } = await listening({ null: ACCEPTED, 819: conversationWith([], [["missionCompleted", true]]) });
  await flow.openConversation(3008416);
  // Closed with nothing out, then opened again: the opening is laid out.
  await push("OnAgentMissionChange", ["reset", 3008416]);
  await flow.openConversation(3008416);
  assert.equal(store.agents.get().activeAgentID, 3008416);

  // A press is out, and ANOTHER agent's mission is reset: this window's answer is laid out.
  let release!: () => void;
  state.hold = new Promise<void>((resolve) => { release = resolve; });
  const pressed = flow.chooseAction(3008416, { actionID: 819, buttonType: 6, label: "Complete Mission" });
  await push("OnAgentMissionChange", ["reset", OTHER_AGENT]);
  release();
  await pressed;
  assert.equal(store.agents.get().activeAgentID, 3008416);
  assert.equal(store.agents.get().conversation?.lastActionInfo.missionCompleted, true);
});

test("one agent's window closed under its question leaves another's answer to be laid out", async () => {
  const { store, flow, push, state } = await listening({ null: ACCEPTED });
  let release!: () => void;
  state.hold = new Promise<void>((resolve) => { release = resolve; });
  const first = flow.openConversation(3008416);
  const second = flow.openConversation(OTHER_AGENT);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await push("OnAgentMissionChange", ["reset", 3008416]);
  release();
  await Promise.all([first, second]);
  assert.equal(store.agents.get().activeAgentID, OTHER_AGENT);
  assert.notEqual(store.agents.get().conversation, null);
});

test("told to talk again while the pilot's own action is out, the window asks until the pilot is free", async () => {
  // The session is changing place (seen live on an undock), or another write of the pilot's is out.
  for (const code of ["SESSION_CHANGE_IN_PROGRESS", "CHARACTER_IN_USE"] as const) {
    const { store, flow, requests, push, asked, state } = await listening({ null: ACCEPTED });
    await flow.openConversation(3008416);
    requests.length = 0;
    // The BFF refuses twice, then answers.
    state.busyCode = code;
    state.busyFor = 2;
    await push("OnSessionChanged", [{ stationid: [60000004, null] }], "sessionchange");
    await until(() => asked().includes("briefing"));
    assert.deepEqual(asked(), ["3008416:action:null", "3008416:action:null", "3008416:action:null", "briefing"], code);
    assert.equal(store.agents.get().actionError, null, code);
    assert.equal(store.agents.get().activeAgentID, 3008416, code);
  }
});

test("a pilot that stays busy is given up on after fifteen tries, and the window says why", async () => {
  const { store, flow, requests, push, asked, state } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  requests.length = 0;
  state.busyFor = 100;
  await push("OnAgentMissionChange", ["modified", 3008416]);
  await until(() => store.agents.get().actionError !== null);
  assert.equal(asked().filter((word) => word === "3008416:action:null").length, 15);
  // In the page's own words for a session that is changing place.
  assert.match(store.agents.get().actionError ?? "", /still settling/);
});

test("an agent clicked while the pilot is busy is refused at once, as any click is", async () => {
  const { store, flow, requests, asked, state } = await listening({ null: ACCEPTED });
  state.busyFor = 1;
  await flow.openConversation(3008416);
  assert.deepEqual(asked(), ["3008416:action:null"]);
  assert.match(store.agents.get().actionError ?? "", /still settling/);
  assert.equal(store.agents.get().activeAgentID, null);
  void requests;
});

test("only being busy is waited out: any other refusal of the window's own question is shown at once", async () => {
  const { store, flow, requests, push, asked, state } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  requests.length = 0;
  state.failAction = true;
  await push("OnAgentMissionChange", ["modified", 3008416]);
  assert.deepEqual(asked().filter((word) => word.includes(":action:")), ["3008416:action:null"]);
  assert.match(store.agents.get().actionError ?? "", /will not talk now/);
});

// --- the mission's time, read with every layout --------------------------------

/** The briefing answer with these two times in it. */
const briefingWith = (declineTime: unknown, expirationTime: unknown) => ({
  ...BRIEFING_RESPONSE,
  briefing: { type: "dict", entries: [["Mission Title ID", 58607], ["Decline Time", declineTime], ["Expiration Time", expirationTime]] },
});

test("each layout keeps what its own briefing says of time, whatever the last action was", async () => {
  const store = createClientStore();
  store.apply(pilotDockedAt(60000004));
  let briefingAnswer: unknown = briefingWith(-1, null);
  const answers: Record<string, ReturnType<typeof conversationWith>> = {
    null: conversationWith([[816, 3], [817, 9]]),
    816: conversationWith([[819, 6], [822, 11]]),
    822: conversationWith([[821, 2]], [["missionQuit", true]]),
  };
  const { fetch } = makeFakeFetch((path, _method, body) => {
    if (isAgentsTableCall(path, body)) return { status: 200, body: agentsTableAnswer(AGENTS_RESPONSE.agents) };
    if (path === "/api/bridge/agents/3008416/action") return { status: 200, body: answers[String(body.actionID)]! };
    if (path === "/api/bridge/agents/3008416/briefing") return { status: 200, body: briefingAnswer };
    if (path === JOURNAL_READ) return { status: 200, body: journalResponse([]) };
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });
  await flow.loadAgents();
  assert.equal(store.agents.get().missionTimes, null, "nothing is known of a mission's time before a window is open");

  // An offer, no decline timer running.
  await flow.openConversation(3008416);
  assert.deepEqual(store.agents.get().missionTimes, { declineTime: -1n, expirationTime: null });

  // Accepted: read again, and now it expires.
  briefingAnswer = briefingWith(null, { type: "long", value: "134365346460600000" });
  await flow.chooseAction(3008416, { actionID: 816, buttonType: 3, label: "Accept" });
  assert.deepEqual(store.agents.get().missionTimes, { declineTime: null, expirationTime: 134365346460600000n });

  // Quit: the objectives are not shown, but what the briefing still says of time is kept.
  briefingAnswer = briefingWith(55_712_640_218, null);
  await flow.chooseAction(3008416, { actionID: 822, buttonType: 11, label: "Quit" });
  assert.equal(store.agents.get().briefing, null);
  assert.deepEqual(store.agents.get().missionTimes, { declineTime: 55_712_640_218n, expirationTime: null });

  // No mission, no briefing: no times.
  briefingAnswer = { ...BRIEFING_RESPONSE, briefing: null };
  await flow.openConversation(3008416);
  assert.equal(store.agents.get().missionTimes, null);
});

test("a window that closes takes its mission's time with it", async () => {
  const { store, flow, push } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  assert.notEqual(store.agents.get().missionTimes, null);
  await push("OnAgentMissionChange", ["reset", 3008416]);
  assert.equal(store.agents.get().missionTimes, null);
});

// --- the objectives, kept with every layout -----------------------------------

test("each layout keeps the mission's objectives, and an action that ends the mission clears them", async () => {
  const store = createClientStore();
  store.apply(pilotDockedAt(60000004));
  let reads: unknown = BRIEFING_RESPONSE;
  const answers: Record<string, ReturnType<typeof conversationWith>> = {
    null: conversationWith([[816, 3], [817, 9]]),
    816: conversationWith([[819, 6], [822, 11]]),
    822: conversationWith([[821, 2]], [["missionQuit", true]]),
  };
  const { fetch } = makeFakeFetch((path, _method, body) => {
    if (isAgentsTableCall(path, body)) return { status: 200, body: agentsTableAnswer(AGENTS_RESPONSE.agents) };
    if (path === "/api/bridge/agents/3008416/action") return { status: 200, body: answers[String(body.actionID)]! };
    if (path === "/api/bridge/agents/3008416/briefing") return { status: 200, body: reads };
    if (path === JOURNAL_READ) return { status: 200, body: journalResponse([]) };
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });
  await flow.loadAgents();
  assert.equal(store.agents.get().objectives, null);

  // An offer: its objectives are on show before it is taken.
  await flow.openConversation(3008416);
  const offered = store.agents.get().objectives;
  assert.equal(offered?.objectives[0]?.kind, "transport");
  assert.equal(offered?.loyaltyPoints, 213);
  assert.equal(offered?.missionTitleID, 58607);

  // Accepted: read again for the new layout.
  reads = { ...BRIEFING_RESPONSE, objective: { type: "dict", entries: [["missionState", 2], ["missionTitleID", 58607], ["loyaltyPoints", 5]] } };
  await flow.chooseAction(3008416, { actionID: 816, buttonType: 3, label: "Accept" });
  assert.equal(store.agents.get().objectives?.missionState, 2);
  assert.equal(store.agents.get().objectives?.loyaltyPoints, 5);

  // Quit: the client shows no objectives after an action that ended the mission, whatever the read says.
  await flow.chooseAction(3008416, { actionID: 822, buttonType: 11, label: "Quit" });
  assert.equal(store.agents.get().objectives, null);

  // No mission: the read has no objectives.
  reads = { ...BRIEFING_RESPONSE, objective: null };
  await flow.openConversation(3008416);
  assert.equal(store.agents.get().objectives, null);
});

test("a window that closes takes its objectives with it", async () => {
  const { store, flow, push } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  assert.notEqual(store.agents.get().objectives, null);
  await push("OnAgentMissionChange", ["reset", 3008416]);
  assert.equal(store.agents.get().objectives, null);
});

// --- the journal's "Remove Offer" ----------------------------------------------

test("removing an offer is the one call; what the server says of it does the rest", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/bridge/agents/3008416/remove-offer") return { status: 200, body: { ok: true, result: null, notifications: [] } };
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });
  await flow.removeOffer(3008416);
  // Confirmed by the click, to the agent's own route, and nothing read after it: the journal is read when the server says the offer is gone.
  assert.deepEqual(requests.map((request) => [request.method, request.path, request.body]), [["POST", "/api/bridge/agents/3008416/remove-offer", { confirm: true }]]);
  assert.equal(store.agents.get().actionError, null);
});

test("an offer that will not be removed says why, where the agents are", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({ status: 409, body: { ok: false, error: "CALL_REFUSED", message: "There is no offer to remove." } }));
  const flow = createAppFlow(store, { fetch });
  await flow.removeOffer(3008416);
  assert.match(store.agents.get().actionError ?? "", /no offer to remove/);
});

test("the server saying the offer is gone closes the window on that agent and reads the journal again", async () => {
  const { store, flow, requests, push, asked } = await listening({ null: ACCEPTED });
  await flow.openConversation(3008416);
  requests.length = 0;
  await flow.removeOffer(3008416);
  await push("OnAgentMissionChange", ["offer_removed", 3008416]);
  assert.equal(store.agents.get().activeAgentID, null);
  assert.equal(store.agents.get().objectives, null);
  assert.deepEqual(asked(), ["journal", "remove-offer"]);
});

// --- the journal's "Read Details": the mission's page -----------------------------

/** The server's answer about mission 1382 (the journal's line for 3008416), in the state given. */
const pageAnswer = (missionState: number, contentID = 1382) => ({
  type: "dict",
  entries: [["contentID", contentID], ["missionState", missionState], ["completionStatus", 0], ["loyaltyPoints", 49]],
});
const PAGE_RECORD = { contentTemplate: "agent.missionTemplatizedContent_BasicCourierMission", messages: { "messages.mission.briefing": 900954 }, nameID: 900260 };

/** standingMgr.GetCharStandings as the server answers it: who the pilot stands with, and how. */
const STANDINGS_ROWSET = {
  type: "object",
  name: "util.Rowset",
  args: { type: "dict", entries: [["header", { type: "list", items: ["fromID", "standing"] }], ["lines", { type: "list", items: [{ type: "list", items: [1000002, 3.5] }, { type: "list", items: [3008416, -0.5] }] }]] },
};

/** A pilot with a mission's page to open: the objectives and the client's record are answered from `state`. */
async function withMissionPage() {
  const page: { objective: unknown; record: unknown; recordFails: boolean; objectiveFails: boolean; hold: Promise<void> | null; agent: unknown; agentFails: boolean; standingsFail: boolean } = {
    objective: pageAnswer(2), record: PAGE_RECORD, recordFails: false, objectiveFails: false, hold: null,
    agent: { agentID: 3008416, agentTypeID: 2, divisionID: 22, level: 1, stationID: 60000004, corporationID: 1000002, factionID: 500001, divisionNameID: 900109 },
    agentFails: false,
    standingsFail: false,
  };
  const made = await listening({ null: ACCEPTED }, {
    routes: async (path, body) => {
      if (/\/mission-objectives$/.test(path)) {
        if (page.hold) await page.hold;
        return page.objectiveFails ? [409, { ok: false, error: "CALL_REFUSED", message: "The agent has nothing to say of it." }] : [200, { ok: true, agentID: 3008416, objective: page.objective, notifications: [] }];
      }
      if (path.startsWith("/api/client-data/missions/")) {
        return page.recordFails ? [502, { ok: false, error: "UNREACHABLE", message: "No answer." }] : [200, { ok: true, available: page.record !== null, mission: page.record }];
      }
      if (/\/keywords\?/.test(path)) return [200, { ok: true, keywords: { type: "dict", entries: [["objectiveQuantity", 1]] }, notifications: [] }];
      if (/\/record$/.test(path)) return page.agentFails ? [502, { ok: false, error: "UNREACHABLE", message: "No answer." }] : [200, { ok: true, agent: page.agent }];
      // The pilot's standings, asked by the page itself (bridge/standingsReads.ts). The pilot is in an NPC
      // corporation, so its corporation's are not asked for at all.
      if (path === "/api/bridge/call" && body.service === "standingMgr") {
        // (Failing, the BFF is not reached at all: the reading fails as a whole, as the route's request did.)
        if (page.standingsFail) throw new TypeError("fetch failed");
        return [200, { ok: true, service: body.service, method: body.method, result: body.method === "GetCharStandings" ? STANDINGS_ROWSET : null, notifications: [] }];
      }
      // The pilot's skills, asked by the page itself (bridge/skillReads.ts): nothing queued, and no skills.
      if (path === "/api/bridge/call" && body.service === "skillHandler") {
        const none = { type: "dict", entries: [] };
        const answers: Record<string, unknown> = { GetSkillQueueAndFreePoints: [{ type: "list", items: [] }, 0], GetSkills: none, GetAllSkills: none, GetFreeSkillPoints: 0 };
        return [200, { ok: true, service: body.service, method: body.method, result: answers[String(body.method)] ?? null, notifications: [] }];
      }
      return undefined;
    },
  });
  /** What was asked for the page, in the order it was asked. */
  const pageAsked = () => made.requests.map((request) => request.path).filter((path) => /mission-objectives|client-data|keywords/.test(path));
  /** The calls made of the standings' service, each as service.method(args). */
  const callsOf = (service: string) => made.requests.filter((request) => request.path === "/api/bridge/call" && request.body.service === service)
    .map((request) => `${String(request.body.service)}.${String(request.body.method)}(${JSON.stringify(request.body.args).slice(1, -1)})`);
  const standingsAsked = () => callsOf("standingMgr");
  /** The calls made of the skill handler, the same way. */
  const skillsAsked = () => callsOf("skillHandler");
  return { ...made, page, pageAsked, standingsAsked, skillsAsked };
}

test("Read Details opens the mission's page: one read of the agent's object, the mission's keywords, and the client's own record", async () => {
  const { store, flow, requests, pageAsked, standingsAsked, skillsAsked } = await withMissionPage();
  await flow.openMissionDetails(3008416);
  await until(() => store.agents.get().missionPage?.record != null);
  assert.deepEqual(pageAsked().sort(), ["/api/bridge/agents/3008416/keywords?contentID=1382", "/api/bridge/agents/3008416/mission-objectives", "/api/client-data/missions/1382"]);
  // Reads, all of them: nothing is asked of the agent that changes anything. (Names are asked for by POST, and change
  // nothing; so are the page's own calls for the pilot's standings and skills, which the generic call would refuse were they writes.)
  const unread = (path: string): boolean => path !== "/api/names" && path !== "/api/bridge/call";
  assert.deepEqual([...new Set(requests.filter((request) => unread(request.path)).map((request) => request.method))], ["GET"]);
  assert.deepEqual(requests.filter((request) => request.method !== "GET").map((request) => request.path).filter(unread), []);
  assert.deepEqual([...new Set(requests.filter((request) => request.path === "/api/bridge/call").map((request) => String(request.body.service)))].sort(), ["skillHandler", "standingMgr"]);
  assert.deepEqual(standingsAsked(), ["standingMgr.GetCharStandings()"]);
  await until(() => skillsAsked().length === 4);
  assert.deepEqual(skillsAsked(), ["skillHandler.GetSkillQueueAndFreePoints()", "skillHandler.GetSkills()", "skillHandler.GetAllSkills()", "skillHandler.GetFreeSkillPoints()"]);
  // And what the client's agents service knows of the agent, for its card.
  assert.deepEqual(requests.map((request) => request.path).filter((path) => path.endsWith("/record")), ["/api/bridge/agents/3008416/record"]);
  const held = store.agents.get().missionPage;
  assert.ok(held);
  // What the journal's line said, kept as the job is made from it.
  assert.deepEqual({ ...held, objectives: null, record: null }, {
    agentID: 3008416, contentID: 1382, missionState: 2, important: false, expirationTime: "134295222004640000", missionTitleID: 58607, missionTitle: null, objectives: null, record: null,
  });
  assert.equal(held.objectives?.contentID, 1382);
  assert.equal(held.objectives?.loyaltyPoints, 49);
  assert.deepEqual(held.record, { nameID: 900260, messages: { "messages.mission.briefing": 900954 } });
  assert.deepEqual(store.agents.get().missionKeywords["3008416:1382"], { objectiveQuantity: 1 });
  assert.equal(store.agents.get().actionError, null);
  // The agent's window is another thing, and stays shut.
  assert.equal(store.agents.get().activeAgentID, null);
});

test("the page is on show before its reads answer, and an agent with no mission in the journal has none", async () => {
  const { store, flow, page, pageAsked } = await withMissionPage();
  let release = (): void => {};
  page.hold = new Promise<void>((resolve) => { release = resolve; });
  const opening = flow.openMissionDetails(3008416);
  await until(() => store.agents.get().missionPage !== null);
  assert.equal(store.agents.get().missionPage?.objectives, null);
  release();
  await opening;
  assert.equal(store.agents.get().missionPage?.objectives?.contentID, 1382);

  flow.closeMissionDetails();
  assert.equal(store.agents.get().missionPage, null);
  const before = pageAsked().length;
  await flow.openMissionDetails(OTHER_AGENT);
  assert.equal(store.agents.get().missionPage, null);
  assert.equal(pageAsked().length, before);
});

test("the client's record of a mission is asked for once; its keywords once; the agent every time the page opens", async () => {
  const { store, flow, pageAsked } = await withMissionPage();
  await flow.openMissionDetails(3008416);
  await until(() => store.agents.get().missionPage?.record != null);
  flow.closeMissionDetails();
  await flow.openMissionDetails(3008416);
  await until(() => store.agents.get().missionPage?.record != null);
  const count = (part: string) => pageAsked().filter((path) => path.includes(part)).length;
  assert.equal(count("client-data"), 1);
  assert.equal(count("keywords"), 1);
  assert.equal(count("mission-objectives"), 2);
  // The record lands on the page opened the second time too.
  assert.deepEqual(store.agents.get().missionPage?.record?.nameID, 900260);
});

test("a record that could not be asked for is asked for again; one the client does not have is not", async () => {
  const { store, flow, page, pageAsked } = await withMissionPage();
  const count = () => pageAsked().filter((path) => path.includes("client-data")).length;
  page.recordFails = true;
  await flow.openMissionDetails(3008416);
  await until(() => count() === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.agents.get().missionPage?.record, null);
  // The page is there all the same.
  assert.equal(store.agents.get().missionPage?.objectives?.contentID, 1382);
  page.recordFails = false;
  page.record = null;
  await flow.openMissionDetails(3008416);
  await until(() => count() === 2);
  await flow.openMissionDetails(3008416);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(count(), 2);
  assert.equal(store.agents.get().missionPage?.record, null);
});

test("an agent that will not answer leaves the page with what the journal said, and says why", async () => {
  const { store, flow, page } = await withMissionPage();
  page.objectiveFails = true;
  await flow.openMissionDetails(3008416);
  assert.equal(store.agents.get().missionPage?.missionState, 2);
  assert.equal(store.agents.get().missionPage?.objectives, null);
  assert.match(store.agents.get().actionError ?? "", /nothing to say of it/);
});

test("an answer about another mission, or no answer, leaves the page's objectives as they were", async () => {
  const { store, flow, page, push } = await withMissionPage();
  await flow.openMissionDetails(3008416);
  const first = store.agents.get().missionPage?.objectives;
  assert.ok(first);
  page.objective = pageAnswer(2, 9999);
  await push("OnAgentMissionChange", ["modified", 3008416]);
  assert.equal(store.agents.get().missionPage?.objectives, first);
  page.objective = null;
  await push("OnAgentMissionChange", ["modified", 3008416]);
  assert.equal(store.agents.get().missionPage?.objectives, first);
});

test("told its mission changed, the page reads it again; completed or accepted, it takes that state first", async () => {
  const { store, flow, page, push, pageAsked } = await withMissionPage();
  await flow.openMissionDetails(3008416);
  const reads = () => pageAsked().filter((path) => path.includes("mission-objectives")).length;
  assert.equal(reads(), 1);

  page.objective = pageAnswer(3);
  await push("OnAgentMissionChange", ["failed", 3008416]);
  assert.equal(reads(), 2);
  assert.equal(store.agents.get().missionPage?.objectives?.missionState, 3);
  // The journal's state is left as it was: only the objectives say what became of it.
  assert.equal(store.agents.get().missionPage?.missionState, 2);

  // A mission that is over answers nothing: the state is the one the server named, and what was read stays.
  page.objective = null;
  await push("OnAgentMissionChange", ["completed", 3008416]);
  assert.equal(reads(), 3);
  assert.equal(store.agents.get().missionPage?.missionState, 4);
  assert.equal(store.agents.get().missionPage?.objectives?.missionState, 3);

  page.objective = pageAnswer(2);
  await push("OnAgentMissionChange", ["accepted", 3008416]);
  assert.equal(reads(), 4);
  assert.equal(store.agents.get().missionPage?.missionState, 2);
  assert.equal(store.agents.get().missionPage?.objectives?.missionState, 2);

  // A change that is another agent's is not this page's; one that names no agent is everyone's.
  await push("OnAgentMissionChange", ["modified", OTHER_AGENT]);
  assert.equal(reads(), 4);
  await push("OnAgentMissionChange", ["modified", null]);
  assert.equal(reads(), 5);
  // And one the job board does nothing with reads nothing.
  await push("OnAgentMissionChange", ["prolong", 3008416]);
  assert.equal(reads(), 5);
});

test("told the mission is gone, its page closes; another agent's page stays", async () => {
  for (const action of ["offered", "declined", "offer_declined", "offer_removed", "quit", "reset"]) {
    const { store, flow, push } = await withMissionPage();
    await flow.openMissionDetails(3008416);
    await push("OnAgentMissionChange", [action, OTHER_AGENT]);
    assert.equal(store.agents.get().missionPage?.agentID, 3008416, action);
    await push("OnAgentMissionChange", [action, 3008416]);
    assert.equal(store.agents.get().missionPage, null, action);
  }
});

test("a change of ship or of station reads the page's mission again; any other change of session does not", async () => {
  const { store, flow, push, pageAsked } = await withMissionPage();
  const reads = () => pageAsked().filter((path) => path.includes("mission-objectives")).length;
  // With no page on show there is nothing to read.
  await push("OnSessionChanged", [{ shipid: [1, 2] }], "sessionchange");
  assert.equal(reads(), 0);
  await flow.openMissionDetails(3008416);
  assert.equal(reads(), 1);
  await push("OnSessionChanged", [{ shipid: [1, 2] }], "sessionchange");
  assert.equal(reads(), 2);
  await push("OnSessionChanged", [{ stationid: [60000004, null], solarsystemid: [null, 30002780] }], "sessionchange");
  assert.equal(reads(), 3);
  await push("OnSessionChanged", [{ solarsystemid: [30002780, 30002778] }], "sessionchange");
  assert.equal(reads(), 3);
  assert.equal(store.agents.get().missionPage?.agentID, 3008416);
});

test("an answer that comes after the page was closed is not written to it", async () => {
  const { store, flow, page } = await withMissionPage();
  let release = (): void => {};
  page.hold = new Promise<void>((resolve) => { release = resolve; });
  const opening = flow.openMissionDetails(3008416);
  await until(() => store.agents.get().missionPage !== null);
  flow.closeMissionDetails();
  release();
  await opening;
  assert.equal(store.agents.get().missionPage, null);
});

test("an answer for one agent's mission is not written to another agent's page, even of the same mission", async () => {
  // Two agents with the same mission on the journal, which nothing forbids.
  const second = { ...ACTIVE_MISSION_ROW, items: ACTIVE_MISSION_ROW.items.map((item, index) => (index === 4 ? OTHER_AGENT : item)) };
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { store, flow } = await listening({ null: ACCEPTED }, {
    routes: async (path) => {
      if (path === JOURNAL_READ) return [200, journalResponse([ACTIVE_MISSION_ROW, second])];
      if (path === "/api/bridge/agents/3008416/mission-objectives") {
        await held;
        return [200, { ok: true, objective: pageAnswer(3), notifications: [] }];
      }
      if (/\/mission-objectives$/.test(path)) return [200, { ok: true, objective: pageAnswer(2), notifications: [] }];
      if (path.startsWith("/api/client-data/missions/")) return [200, { ok: true, available: true, mission: PAGE_RECORD }];
      return undefined;
    },
  });
  const first = flow.openMissionDetails(3008416);
  await until(() => store.agents.get().missionPage?.agentID === 3008416);
  await flow.openMissionDetails(OTHER_AGENT);
  assert.equal(store.agents.get().missionPage?.agentID, OTHER_AGENT);
  assert.equal(store.agents.get().missionPage?.objectives?.missionState, 2);
  release();
  await first;
  // The first agent's answer came, and the page on show is still the second's, as it answered.
  assert.equal(store.agents.get().missionPage?.agentID, OTHER_AGENT);
  assert.equal(store.agents.get().missionPage?.objectives?.missionState, 2);
});

test("only an epic journal notice invalidates the epic arc views", async () => {
  const { flow, push } = await listening({ null: ACCEPTED });
  const original = flow.epicArcsChanged.get();
  await push("OnAgentMissionChange", ["accepted", 3008416]);
  assert.equal(flow.epicArcsChanged.get(), original);
  await push("OnEpicJournalChange", []);
  assert.equal(flow.epicArcsChanged.get(), original + 1);
});

// --- what the server says once, taken once ---------------------------------------------
//
// The stream's frames in these tests are numbered from 1 in epoch "epoch-1" (the helper's push). An answer
// that brings the same push says so by carrying the same cursor, as the game port's answers do.

/** A pilot whose "Remove Offer" is answered with the push it caused, numbered as given (or not numbered). */
async function withAnsweredPush(cursor: { epoch: string; sequence: number } | null) {
  const drained = { kind: "service", service: "agentMgr", method: "OnAgentMissionChange", idType: null, args: ["offer_removed", 3008416], kwargs: null, ...(cursor === null ? {} : { cursor }) };
  const made = await listening({ null: ACCEPTED }, {
    routes: (path) => (/\/remove-offer$/.test(path) ? [200, { ok: true, result: null, notifications: [drained] }] : undefined),
  });
  /** How often the journal has been read since the page loaded: once for each push acted on. */
  const journalReads = () => made.requests.filter((request) => request.path === JOURNAL_READ).length;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
  return { ...made, journalReads, settle };
}

test("a push that came on the stream is not acted on again when an answer brings it", async () => {
  const { store, flow, push, journalReads, settle } = await withAnsweredPush({ epoch: "epoch-1", sequence: 1 });
  await flow.openConversation(3008416);
  await push("OnAgentMissionChange", ["offer_removed", 3008416]);
  assert.equal(journalReads(), 1);
  assert.equal(store.agents.get().activeAgentID, null);
  await flow.removeOffer(3008416);
  await settle();
  assert.equal(journalReads(), 1);
});

test("a push an answer brought is not acted on again when the stream brings it, and the stream still records it", async () => {
  const { store, flow, push, journalReads, settle } = await withAnsweredPush({ epoch: "epoch-1", sequence: 1 });
  await flow.removeOffer(3008416);
  await settle();
  assert.equal(journalReads(), 1);
  await push("OnAgentMissionChange", ["offer_removed", 3008416]);
  assert.equal(journalReads(), 1);
  // What came on the stream is kept as what came on the stream, and where it has read to.
  const live = store.live.get();
  assert.equal(live.sequence, 1);
  assert.deepEqual(live.notifications.map((notification) => notification.method), ["OnAgentMissionChange"]);
});

test("two pushes that say the same thing are two pushes: each is acted on", async () => {
  // The answer's is the stream's second event, not its first.
  const { flow, push, journalReads, settle } = await withAnsweredPush({ epoch: "epoch-1", sequence: 2 });
  await push("OnAgentMissionChange", ["offer_removed", 3008416]);
  assert.equal(journalReads(), 1);
  await flow.removeOffer(3008416);
  await settle();
  assert.equal(journalReads(), 2);
  // And then that second event comes on the stream too.
  await push("OnAgentMissionChange", ["offer_removed", 3008416]);
  assert.equal(journalReads(), 2);
});

test("an answer's push that is not numbered cannot be told from the stream's, and both are acted on", async () => {
  // The web gateway's answers: nothing says which stream event a drained push is.
  const { flow, push, journalReads, settle } = await withAnsweredPush(null);
  await push("OnAgentMissionChange", ["offer_removed", 3008416]);
  await flow.removeOffer(3008416);
  await settle();
  assert.equal(journalReads(), 2);
});

test("the same answer twice is one push; after the pilot is selected again its numbers are new ones", async () => {
  const { flow, requests, journalReads, settle } = await withAnsweredPush({ epoch: "epoch-1", sequence: 1 });
  await flow.removeOffer(3008416);
  await settle();
  await flow.removeOffer(3008416);
  await settle();
  assert.equal(journalReads(), 1);

  await flow.selectCharacter(LISTENING_PILOT);
  await flow.loadJournal();
  requests.length = 0;
  await flow.removeOffer(3008416);
  await settle();
  assert.equal(journalReads(), 1);
});

test("what the client knows of an agent is asked for once, kept by its ID, and asked for again only if it could not be had", async () => {
  const { store, flow, requests, page } = await withMissionPage();
  const asked = () => requests.filter((request) => request.path.endsWith("/record")).map((request) => request.path);
  await flow.openMissionDetails(3008416);
  await until(() => store.agents.get().agentRecords[3008416] !== undefined);
  assert.deepEqual(store.agents.get().agentRecords[3008416], { agentID: 3008416, agentTypeID: 2, divisionID: 22, level: 1, stationID: 60000004, corporationID: 1000002, factionID: 500001, divisionNameID: 900109, solarSystemID: null });
  flow.closeMissionDetails();
  await flow.openMissionDetails(3008416);
  flow.requestAgentRecord(3008416);
  assert.deepEqual(asked(), ["/api/bridge/agents/3008416/record"]);

  // An agent the server does not list is remembered as none, and not asked about again.
  page.agent = null;
  flow.requestAgentRecord(OTHER_AGENT);
  await until(() => store.agents.get().agentRecords[OTHER_AGENT] !== undefined);
  assert.equal(store.agents.get().agentRecords[OTHER_AGENT], null);
  flow.requestAgentRecord(OTHER_AGENT);
  assert.equal(asked().length, 2);
  // The first agent's record is still there.
  assert.equal(store.agents.get().agentRecords[3008416]?.level, 1);

  // One that could not be asked for is asked for again.
  page.agentFails = true;
  flow.requestAgentRecord(3009999);
  await until(() => asked().length === 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.agents.get().agentRecords[3009999], undefined);
  page.agentFails = false;
  page.agent = { agentID: 3009999, level: 4 };
  flow.requestAgentRecord(3009999);
  await until(() => store.agents.get().agentRecords[3009999] !== undefined);
  assert.equal(store.agents.get().agentRecords[3009999]?.level, 4);
  // Nothing is asked for what is not an agent.
  for (const not of [0, -1, 1.5, Number.NaN]) flow.requestAgentRecord(not);
  assert.equal(asked().length, 4);
});

test("opening a mission's page reads the pilot's standings and skills if they have not been read, and not again once they have", async () => {
  const { store, flow, requests, standingsAsked, skillsAsked } = await withMissionPage();
  const reads = (path: string) => requests.filter((request) => request.path === path).length;
  assert.equal(store.standings.get().loaded, false);
  await flow.openMissionDetails(3008416);
  await until(() => store.standings.get().loaded && store.skills.get().loaded);
  // The character's, and not its corporation's: an NPC corporation's standings are none (standingsvc.py 118).
  assert.deepEqual(standingsAsked(), ["standingMgr.GetCharStandings()"]);
  // The skills by the page's own reads, each once, and not by the route.
  assert.deepEqual([skillsAsked().length, new Set(skillsAsked()).size, reads("/api/bridge/skills")], [4, 4, 0]);
  assert.deepEqual(store.standings.get().char, [{ fromID: 1000002, standing: 3.5 }, { fromID: 3008416, standing: -0.5 }]);
  // Opened again: the standings are held, and are not read again.
  flow.closeMissionDetails();
  await flow.openMissionDetails(3008416);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(standingsAsked().length, 1);
});

test("told the pilot's standings changed, the flow changes what it holds from what it was told, and reads nothing", async () => {
  const { store, flow, push, standingsAsked } = await withMissionPage();
  const reads = () => standingsAsked().length;
  // Before they have been read there is nothing to change.
  await push("OnStandingSet", [1000002, LISTENING_PILOT, 4.0]);
  assert.equal(store.standings.get().char, null);
  assert.equal(store.standings.get().loaded, false);
  await flow.openMissionDetails(3008416);
  await until(() => store.standings.get().loaded);
  assert.equal(reads(), 1);

  // Set outright.
  await push("OnStandingSet", [1000002, LISTENING_PILOT, 4.0]);
  assert.deepEqual(store.standings.get().char, [{ fromID: 1000002, standing: 4.0 }, { fromID: 3008416, standing: -0.5 }]);
  // Moved by a share: 4.0 rises a tenth of the way to ten, and a faction not yet listed starts at ten times its change.
  await push("OnStandingsModified", [[[1000002, LISTENING_PILOT, 0.1, 0, 10], [500001, LISTENING_PILOT, -0.05, -10, 0]]]);
  const held = store.standings.get().char ?? [];
  assert.deepEqual(held.map((row) => row.fromID), [1000002, 3008416, 500001]);
  assert.ok(Math.abs(held[0]!.standing - 4.6) < 1e-9);
  assert.ok(Math.abs(held[2]!.standing - -0.5) < 1e-9);
  // Another pilot's standing, and anything else the server says, change nothing.
  await push("OnStandingSet", [1000002, 140000001, 9.0]);
  await push("OnItemsChanged", [1, 2]);
  assert.equal(store.standings.get().char, held);
  // And none of it read the standings again: 197 of these come at once when a game master sets them all.
  assert.equal(reads(), 1);
  assert.equal(store.standings.get().loaded, true);
});

test("standings that could not be read leave the page as it is, and are tried again when it is next opened", async () => {
  const { store, flow, page, standingsAsked } = await withMissionPage();
  const reads = () => standingsAsked().length;
  page.standingsFail = true;
  await flow.openMissionDetails(3008416);
  await until(() => reads() === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.standings.get().loaded, false);
  assert.equal(store.agents.get().missionPage?.agentID, 3008416);
  assert.equal(store.agents.get().actionError, null);
  page.standingsFail = false;
  flow.closeMissionDetails();
  await flow.openMissionDetails(3008416);
  await until(() => store.standings.get().loaded);
  assert.equal(reads(), 2);
});

// --- a solar system's security, asked for like a name ---------------------------------

test("systems' security is asked for once each, in one request for all that are wanted together", async () => {
  const bodies: number[][] = [];
  let fails = false;
  const { store, flow, requests } = await listening({ null: ACCEPTED }, {
    routes: (path) => {
      if (path !== "/api/map/security") return undefined;
      const body = requests[requests.length - 1]!.body as { ids: number[] };
      bodies.push(body.ids);
      return fails ? [502, { ok: false, error: "UNREACHABLE", message: "No answer." }] : [200, { ok: true, security: Object.fromEntries(body.ids.map((id) => [id, id === 30009999 ? null : (id % 100) / 100])) }];
    },
  });
  flow.requestSystemSecurity([30002780, 30002778, 30002780]);
  flow.requestSystemSecurity([30002778, 30002779]);
  await until(() => store.names.get().systemSecurity[30002779] !== undefined);
  // One request, each system once.
  assert.deepEqual(bodies, [[30002780, 30002778, 30002779]]);
  assert.deepEqual(store.names.get().systemSecurity, { 30002780: 0.8, 30002778: 0.78, 30002779: 0.79 });
  // Asked again: nothing goes out. What is not a system is not asked about at all.
  flow.requestSystemSecurity([30002780, 30002779, 0, -1, 1.5]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bodies.length, 1);
  // A system the BFF does not know is remembered as none; names already held are left alone.
  flow.requestSystemSecurity([30009999]);
  await until(() => store.names.get().systemSecurity[30009999] !== undefined);
  assert.equal(store.names.get().systemSecurity[30009999], null);
  assert.equal(store.names.get().systemSecurity[30002780], 0.8);
  // One that could not be asked for is asked for again.
  fails = true;
  flow.requestSystemSecurity([30001111]);
  await until(() => bodies.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.names.get().systemSecurity[30001111], undefined);
  fails = false;
  flow.requestSystemSecurity([30001111]);
  await until(() => store.names.get().systemSecurity[30001111] !== undefined);
  assert.deepEqual(bodies[3], [30001111]);
  assert.equal(store.names.get().systemSecurity[30001111], 0.11);
});

test("names resolved after a system's security has been read leave it where it is, and the other way round", async () => {
  const store = createClientStore();
  store.apply({ type: "names/resolved", entries: { "system:30002780": "Muvolailen" } });
  store.apply({ type: "names/system-security", security: { 30002780: 0.708087 } });
  store.apply({ type: "names/resolved", entries: { "system:30002778": "Tasabeshi" } });
  store.apply({ type: "names/autopilot-jumps", jumps: { "30002780:30002778": 2 } });
  store.apply({ type: "names/system-security", security: { 30002778: 0.830855 } });
  store.apply({ type: "names/autopilot-jumps", jumps: { "30002778:30002780": 2, "30002780:31000005": null } });
  assert.deepEqual(store.names.get(), {
    resolved: { "system:30002780": "Muvolailen", "system:30002778": "Tasabeshi" },
    systemSecurity: { 30002780: 0.708087, 30002778: 0.830855 },
    autopilotJumps: { "30002780:30002778": 2, "30002778:30002780": 2, "30002780:31000005": null },
  });
  // The jumps forgotten, as when the autopilot's settings change, leave the rest.
  store.apply({ type: "names/autopilot-jumps-cleared" });
  assert.deepEqual(store.names.get(), {
    resolved: { "system:30002780": "Muvolailen", "system:30002778": "Tasabeshi" },
    systemSecurity: { 30002780: 0.708087, 30002778: 0.830855 },
    autopilotJumps: {},
  });
});

// --- what is asked once, after the pilot is selected again ------------------------------

test("selecting the pilot again empties what the store held of agents, and what the page asks once is asked again", async () => {
  const { store, flow, requests } = await withMissionPage();
  const count = (part: RegExp) => requests.filter((request) => part.test(request.path)).length;
  const answered = () => store.agents.get().agentRecords[3008416] !== undefined && Object.keys(store.agents.get().missionKeywords).length === 1;
  await flow.openMissionDetails(3008416);
  await until(answered);
  await flow.selectCharacter(LISTENING_PILOT);
  assert.deepEqual(store.agents.get().agentRecords, {});
  assert.deepEqual(store.agents.get().missionKeywords, {});
  await flow.loadJournal();
  await flow.openMissionDetails(3008416);
  await until(answered);
  assert.equal(count(/\/record$/), 2);
  assert.equal(count(/\/keywords\?/), 2);
  // And still once only while the pilot stays.
  flow.closeMissionDetails();
  await flow.openMissionDetails(3008416);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(count(/\/record$/), 2);
  assert.equal(count(/\/keywords\?/), 2);
});

// --- where an agent is ------------------------------------------------------------------

test("where an agent is, is asked of the server once for each agent, and again only if it could not be had", async () => {
  let fails = false;
  const { store, flow, requests } = await listening({ null: ACCEPTED }, {
    routes: (path) => {
      const asked = /^\/api\/bridge\/agents\/(\d+)\/solar-system$/.exec(path);
      if (asked === null) return undefined;
      if (fails) return [502, { ok: false, error: "UNREACHABLE", message: "No answer." }];
      const agentID = Number(asked[1]);
      return [200, { ok: true, agentID, solarSystemID: agentID === OTHER_AGENT ? null : 30000000 + (agentID % 1000), notifications: [] }];
    },
  });
  const asked = () => requests.filter((request) => request.path.endsWith("/solar-system")).map((request) => request.path);
  const held = () => store.agents.get().agentSolarSystems;
  const agentsListed = store.agents.get().agents.length;
  assert.ok(agentsListed > 0);
  flow.requestAgentSolarSystem(3008416);
  flow.requestAgentSolarSystem(3008416);
  await until(() => held()[3008416] !== undefined);
  // What else the store holds of agents is as it was.
  assert.equal(store.agents.get().agents.length, agentsListed);
  flow.requestAgentSolarSystem(3008416);
  assert.deepEqual(asked(), ["/api/bridge/agents/3008416/solar-system"]);
  assert.deepEqual(held(), { 3008416: 30000416 });

  // An agent the server places nowhere is kept as none, and not asked about again.
  flow.requestAgentSolarSystem(OTHER_AGENT);
  await until(() => held()[OTHER_AGENT] !== undefined);
  flow.requestAgentSolarSystem(OTHER_AGENT);
  assert.deepEqual(held(), { 3008416: 30000416, [OTHER_AGENT]: null });
  assert.equal(asked().length, 2);

  // One that could not be asked for is asked for again.
  fails = true;
  flow.requestAgentSolarSystem(3009123);
  await until(() => asked().length === 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(held()[3009123], undefined);
  fails = false;
  flow.requestAgentSolarSystem(3009123);
  await until(() => held()[3009123] !== undefined);
  assert.equal(held()[3009123], 30000123);
  // Nothing is asked for what is not an agent.
  for (const not of [0, -1, 1.5, Number.NaN]) flow.requestAgentSolarSystem(not);
  assert.equal(asked().length, 4);
  // Where an agent is and what the client knows of it are two asks: one on its way does not stand for the other.
  flow.requestAgentSolarSystem(3008777);
  flow.requestAgentRecord(3008777);
  await until(() => held()[3008777] !== undefined);
  assert.equal(requests.filter((request) => request.path === "/api/bridge/agents/3008777/record").length, 1);
  assert.equal(asked().length, 5);

  // Selecting the pilot again empties what was kept, and then it is asked again.
  await flow.selectCharacter(LISTENING_PILOT);
  assert.deepEqual(held(), {});
  flow.requestAgentSolarSystem(3008416);
  await until(() => held()[3008416] !== undefined);
  assert.equal(asked().length, 6);
});

test("an answer that is not a solar system's ID is kept as none", async () => {
  let answer: unknown = "30002780";
  const { store, flow } = await listening({ null: ACCEPTED }, {
    routes: (path) => (path.endsWith("/solar-system") ? [200, { ok: true, solarSystemID: answer, notifications: [] }] : undefined),
  });
  const agents = [3008001, 3008002, 3008003, 3008004, 3008005];
  for (const [index, each] of ["30002780", 0, -5, 1.5, undefined].entries()) {
    answer = each;
    flow.requestAgentSolarSystem(agents[index]!);
    await until(() => store.agents.get().agentSolarSystems[agents[index]!] !== undefined);
    assert.equal(store.agents.get().agentSolarSystems[agents[index]!], null, String(each));
  }
});

// --- how many jumps away, by the autopilot's route ---------------------------------------

/**
 * A made-up map: five safe systems in a line (A to E); two ways across from A to D that are a jump shorter,
 * one through a low-security system and one through Jita, which the autopilot avoids; and one system apart.
 */
const JUMPS_MAP = {
  ok: true,
  systems: { 30000001: "A", 30000002: "B", 30000003: "C", 30000004: "D", 30000005: "E", 30000006: "Low", 30000007: "Apart", 30000142: "Jita" },
  edges: [[1, 2], [2, 3], [3, 4], [4, 5], [1, 6], [6, 4], [1, 142], [142, 4]].flatMap(([a, b], at) => [[30000000 + a!, 30000000 + b!, 50000000 + at * 2, 50000001 + at * 2], [30000000 + b!, 30000000 + a!, 50000001 + at * 2, 50000000 + at * 2]]),
  security: { 30000001: 1, 30000002: 0.9, 30000003: 0.8, 30000004: 0.7, 30000005: 0.6, 30000006: 0.3, 30000007: 1, 30000142: 0.9 },
};

test("the jumps on the autopilot's route are worked out here from the map, read once, and each pair once", async () => {
  let fails = false;
  let hold: Promise<void> | null = null;
  const { store, flow, requests } = await listening({ null: ACCEPTED }, {
    routes: async (path) => {
      if (path !== "/api/map/graph") return undefined;
      if (hold) await hold;
      return fails ? [502, { ok: false, error: "UNREACHABLE", message: "No answer." }] : [200, JUMPS_MAP];
    },
  });
  const reads = () => requests.filter((request) => request.path === "/api/map/graph").length;
  const held = () => store.names.get().autopilotJumps;

  // A map that cannot be read leaves nothing, and is read again when next wanted.
  fails = true;
  flow.requestAutopilotJumps(30000001, [30000004]);
  await until(() => reads() === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(held(), {});
  fails = false;

  // Asked twice while the map is on its way: one read, and each pair worked out once.
  let release = () => {};
  hold = new Promise((resolve) => { release = resolve; });
  flow.requestAutopilotJumps(30000001, [30000004, 30000004, 30000006]);
  flow.requestAutopilotJumps(30000001, [30000004, 30000007, 30000001, 30000142]);
  flow.requestAutopilotJumps(30000004, [30000001]);
  release();
  hold = null;
  await until(() => "30000004:30000001" in held() && "30000001:30000007" in held());
  assert.equal(reads(), 2);
  // With the settings as the client has them at first: the three safe jumps, not the two through low security
  // or through Jita; a low system or Jita gone to is one jump; none to a system apart.
  assert.deepEqual(held(), { "30000001:30000004": 3, "30000001:30000006": 1, "30000001:30000007": null, "30000001:30000001": 0, "30000001:30000142": 1, "30000004:30000001": 3 });

  // Asked again, nothing is read and nothing changes; what is not a system is not asked about.
  const before = held();
  flow.requestAutopilotJumps(30000001, [30000004, 30000006]);
  flow.requestAutopilotJumps(0, [30000004]);
  flow.requestAutopilotJumps(1.5, [30000004]);
  flow.requestAutopilotJumps(30000001, [0, -1, 1.5, Number.NaN]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reads(), 2);
  assert.equal(held(), before);
  // Another pair is worked out from the map already held.
  flow.requestAutopilotJumps(30000002, [30000005]);
  await until(() => "30000002:30000005" in held());
  assert.equal(held()["30000002:30000005"], 3);
  assert.equal(reads(), 2);
  // What was held before is still there.
  assert.equal(held()["30000001:30000004"], 3);
});

test("the journal is read by the page's own call, agentMgr.GetMyJournalDetails with nothing, as a pilot's; the route is not read", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === JOURNAL_READ) return { status: 200, body: journalResponse([ACTIVE_MISSION_ROW]) };
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });
  await flow.loadJournal();
  assert.deepEqual(requests.map((request) => [request.method, request.path, request.body]), [["POST", JOURNAL_READ, { service: "agentMgr", method: "GetMyJournalDetails", args: [], kwargs: null, pilot: true }]]);
  assert.equal(store.agents.get().journal?.active.length, 1);
  // A call of the same name asked any other way is not the journal's read, and neither is the route.
  assert.deepEqual([asRead("/api/bridge/journal", {}), asRead("/api/bridge/call", { service: "agentMgr", method: "GetMyJournalDetails", args: [3008416], kwargs: null, pilot: true }), asRead("/api/bridge/call", { service: "agentMgr", method: "GetMyJournalDetails", args: [], kwargs: null })], ["/api/bridge/journal", "/api/bridge/call", "/api/bridge/call"]);
  // The read failing fails the reading, with the call's own code.
  const failing = makeFakeFetch(() => ({ status: 502, body: { ok: false, error: "EVE_GATEWAY_UNREACHABLE", message: "The game server is unreachable." } }));
  await assert.rejects(createAppFlow(createClientStore(), { fetch: failing.fetch }).loadJournal(), (error: { code?: string }) => error.code === "EVE_GATEWAY_UNREACHABLE");
});
