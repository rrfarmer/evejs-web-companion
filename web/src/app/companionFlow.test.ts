// The fleet companion's LIFECYCLE, driven through the real flow over a faked BFF.
//
// The unit tests beside `nav/fleetCompanionLoop.ts` prove the ladder. This file
// proves the things only the flow can answer: that the preflight refuses a start
// the companion cannot honour, and that the companion holds the ship on exactly
// the same terms as every other loop — it stops them, and they stop it.
//
// ⚠ THE EXCLUSION CASES ARE THE POINT. `createShipClaim` gives them by
// construction, but "by construction" is a claim about types, and two loops
// steering one ship is a runtime disaster. These drive it for real.

import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import {
  DEFAULT_COMPANION_SETUP,
  DEFAULT_FLEET_COMPANION_REQUEST,
  FLEET_COMPANION_CADENCE_MS,
  type FleetCompanionRequest,
} from "../nav/fleetCompanionLoop.ts";
import { FLEET_BROADCAST_TTL_MS } from "../bridge/fleetBroadcasts.ts";
import { decodeJamNotification } from "../bridge/jamNotifications.ts";
import {
  SHIP_ID,
  SOLAR_SYSTEM_ID,
  STRIP_MINER_ITEM_IDS,
  fittingBody,
  flightBody,
  holdsBody,
  namesBody,
  spaceBody,
} from "./botFixtures.ts";

const BELT = 40000123;
const STATION = 60003760;

// A chat sender the operator allowed, and a fleet-mate the roster carries as a
// human -- both synthetic, neighbours of the documented 90000001 example, per
// this repo's rule that a real character id or handle never reaches a test.
const ALLOWED_CHAT_SENDER = 90000010;
const HUMAN_FLEET_MEMBER = 90000011;

// The documented ESI example character id itself (esi.evetech.net's own
// `CharacterID` sample), used here as THIS pilot's own id -- the row
// `canTagInFleet` has to find among the roster's members to answer for.
const OWN_CHARACTER_ID = 90000001;

const MINING_REQUEST = {
  beltID: BELT,
  beltName: "Asteroid Belt 1",
  stationID: STATION,
  stationName: "Jita IV - Moon 4",
  miningModuleIDs: [7001],
  healthFloor: 0.5,
  useDrones: false,
};

function keyVal(entries: readonly (readonly [string, unknown])[]) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

/**
 * One roster row as the server's own `buildMemberPayload` would marshal it
 * (see boundFleet.ts's `decodeMember`) -- just the three fields the gate
 * reads. `job` and `role` default to 0 (FLEET_JOB_NONE / a value no
 * FLEET_CMDR_ROLES entry matches), i.e. "not a commander by either test",
 * so a fixture that only cares about `charID` stays a plain member.
 */
interface RosterMemberFixture {
  readonly charID: number;
  readonly job?: number;
  readonly role?: number;
}

/**
 * A fleet the companion can legitimately obey. Ids are synthetic on purpose.
 * `members` is empty by default (the shape every existing caller here wants
 * -- enough to pass the preflight, nothing to say about who can tag); pass
 * rows to also exercise `canTagInFleet` over a roster that has THIS pilot's
 * own row in it.
 */
function readyFleet(options: { readonly members?: readonly RosterMemberFixture[] } = {}) {
  const emptyDict = { type: "dict", entries: [] };
  const members = options.members ?? [];
  const membersDict =
    members.length === 0
      ? emptyDict
      : {
          type: "dict",
          entries: members.map((member) => [
            member.charID,
            keyVal([
              ["charID", member.charID],
              ["job", member.job ?? 0],
              ["role", member.role ?? 0],
            ]),
          ]),
        };
  return {
    ok: true,
    characterID: OWN_CHARACTER_ID,
    fleetID: null,
    reads: {
      GetInitState: {
        result: keyVal([
          ["motd", "Ready up."],
          ["fleetID", 90000002],
          ["members", membersDict],
          ["squads", emptyDict],
          ["wings", emptyDict],
        ]),
      },
      GetWings: { result: emptyDict },
      GetMotd: { result: "Ready up." },
      GetJoinRequests: { result: emptyDict },
      GetFleetComposition: { result: { type: "list", items: [] } },
    },
  };
}

/** The authoritative "you are in no fleet" answer: every read refused. */
function noFleet() {
  const refused = { error: "CALL_REFUSED", message: "FleetNotFound" };
  return {
    ok: true,
    characterID: 90000001,
    fleetID: null,
    reads: {
      GetInitState: refused,
      GetWings: refused,
      GetMotd: refused,
      GetJoinRequests: refused,
      GetFleetComposition: refused,
    },
  };
}

function harness(
  options: {
    readonly docked?: boolean;
    readonly inFleet?: boolean;
    readonly members?: readonly RosterMemberFixture[];
  } = {},
) {
  const docked = options.docked ?? false;
  const inFleet = options.inFleet ?? true;

  const posted: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    posted.push({ path, body: body as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      async json() {
        return respond(path, body as Record<string, unknown>);
      },
    };
  }) as unknown as typeof fetch;

  function respond(path: string, body: Record<string, unknown>): unknown {
    if (path === "/api/bridge/flight/status") return flightBody(docked);
    if (path === "/api/bridge/space/snapshot") return spaceBody();
    if (path === "/api/bridge/fitting") return fittingBody({});
    if (path === "/api/bridge/ship/ore-hold") return holdsBody(0, []);
    if (path === "/api/names") return namesBody(body);
    if (path === "/api/bridge/targets") return { ok: true, targetIDs: [], notifications: [] };
    if (path === "/api/bridge/bound-fleet") {
      return inFleet ? readyFleet({ members: options.members }) : noFleet();
    }
    return { ok: true };
  }

  const store = createClientStore();
  return { store, flow: createAppFlow(store, { fetch: fakeFetch }), posted };
}

/**
 * Seats a pilot online the way `flow.ts`'s own `selectCharacter` would, but
 * directly through the store -- same shortcut `lootDispatchFlow.test.ts` and
 * its siblings already take, since none of this file's tests otherwise drive
 * login. `canTagInFleet` is asked about `store.station.get().online?.characterID`
 * (flow.ts's `observe()`), so a test that wants a real `true`/`false` out of
 * the gate -- rather than the "no own id, so null" answer every other test in
 * this file has been getting all along -- has to seat one.
 */
function seatOnlineCharacter(store: ReturnType<typeof createClientStore>, characterID: number): void {
  store.apply({
    type: "character/online",
    character: {
      characterID,
      characterName: "Synthetic Pilot",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000001,
    },
    station: null,
  });
}

/**
 * As `harness()`, but for the chat-command rung: it RECORDS every request
 * path so a test can assert which endpoints were (or were not) hit, and it
 * can seat a real human in the fleet roster (`humanMemberCharacterID`).
 *
 * ⚠ WHY THE ROSTER MATTERS HERE AND NOT IN `harness()`. `readyFleet()`'s own
 * roster is empty, which is enough to pass the preflight (it only asks
 * whether the fleet is READY) but starts the abandonment protocol the moment
 * the ladder actually runs a tick -- and rung 3, "obeying the fleet", is
 * never reached from inside that protocol. The cost-gate tests only care
 * whether the chat READ happened, so the empty roster is fine for them; the
 * freshness test needs an order to actually be OBEYED, which needs a
 * supervised companion, same as a live one would be.
 */
function chatHarness(
  options: {
    readonly humanMemberCharacterID?: number;
    readonly chatEntries?: readonly unknown[];
  } = {},
) {
  const calls: string[] = [];
  const chatEntries = options.chatEntries ?? [];

  function boundFleetBody(): unknown {
    if (options.humanMemberCharacterID === undefined) {
      return readyFleet();
    }
    const memberCharacterID = options.humanMemberCharacterID;
    const emptyDict = { type: "dict", entries: [] };
    return {
      ok: true,
      characterID: 90000001,
      fleetID: null,
      reads: {
        GetInitState: {
          result: keyVal([
            ["motd", "Ready up."],
            ["fleetID", 90000002],
            [
              "members",
              {
                type: "dict",
                entries: [
                  [memberCharacterID, keyVal([["charID", memberCharacterID]])],
                  // ⚠ THE CHAT SENDER IS ON THE ROSTER AS A COMMANDER, AND THAT
                  // IS NOW THE ENTIRE GATE. A chat order used to be authorised
                  // by a hand-typed list of character ids on the request; that
                  // list is gone, and the roster decides instead
                  // (docs/fleet-companion-simplification.md). FLEET_ROLE_LEADER
                  // is 1. Without this row the order is correctly IGNORED, which
                  // is what the sender-gate tests in fleetCompanionLoop.test.ts
                  // pin from the other side.
                  [
                    ALLOWED_CHAT_SENDER,
                    keyVal([
                      ["charID", ALLOWED_CHAT_SENDER],
                      ["role", 1],
                    ]),
                  ],
                ],
              },
            ],
            ["squads", emptyDict],
            ["wings", emptyDict],
          ]),
        },
        GetWings: { result: emptyDict },
        GetMotd: { result: "Ready up." },
        GetJoinRequests: { result: emptyDict },
        GetFleetComposition: { result: { type: "list", items: [] } },
      },
    };
  }

  const fakeFetch = (async (input: unknown) => {
    const path = String(input);
    calls.push(path);
    return {
      ok: true,
      status: 200,
      async json() {
        return respond(path);
      },
    };
  }) as unknown as typeof fetch;

  function respond(path: string): unknown {
    if (path === "/api/bridge/flight/status") return flightBody(false);
    if (path === "/api/bridge/space/snapshot") return spaceBody();
    if (path === "/api/bridge/targets") return { ok: true, targetIDs: [], notifications: [] };
    if (path === "/api/bridge/bound-fleet") return boundFleetBody();
    // LOCAL only, deliberately -- see flow.ts's own comment on the chat read:
    // fleet chat is unreachable on this server, so nothing here should ever
    // be asked for anything else.
    if (path === "/api/bridge/chat/local") {
      return {
        ok: true,
        chat: {
          roomName: "Local",
          corporationID: null,
          solarSystemID: null,
          messages: chatEntries,
          roster: [],
        },
      };
    }
    if (path === "/api/bridge/flight/align") return { ok: true, flight: null, notifications: [] };
    return { ok: true };
  }

  const store = createClientStore();
  return { store, flow: createAppFlow(store, { fetch: fakeFetch }), calls };
}

// --- the preflight ----------------------------------------------------------

test("a companion refuses to start outside a fleet, and says why in plain language", async () => {
  // ⚠ THIS IS THE ONE BLOCKING REQUIREMENT, and it is blocking because the
  // ladder cannot resolve it for itself. Every companion behaviour is addressed
  // to a fleet; started without one it is not a bot that will get going shortly,
  // it is a bot with nothing to obey.
  const { store, flow } = harness({ inFleet: false });

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);

  assert.equal(store.get().companion.status, "idle", "it must not be running");
  const message = store.get().companion.startError;
  assert.ok(message !== null, "a refused start must say something");
  assert.match(message, /fleet/i);
  assert.doesNotMatch(message ?? "", /[0-9]{5,}/, "no raw ids in player-facing text");
  flow.stopFleetCompanion();
});

test("a companion in a fleet starts", async () => {
  const { store, flow } = harness({ inFleet: true });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "running");
  flow.stopFleetCompanion();
});

test("an UNREADABLE fleet refuses the start too — unknown is never permission", async () => {
  // The roster read failing is not the roster saying no, but it is equally not
  // grounds to start an unattended loop nobody could check the fleet of.
  const fakeFetch = (async (input: unknown) => {
    const path = String(input);
    if (path === "/api/bridge/bound-fleet") {
      throw new Error("gateway unreachable");
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return path === "/api/bridge/flight/status" ? flightBody(false) : { ok: true };
      },
    };
  }) as unknown as typeof fetch;

  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: fakeFetch });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "idle");
  assert.ok(store.get().companion.startError !== null);
  flow.stopFleetCompanion();
});

// --- one ship, one loop -----------------------------------------------------

test("starting the companion stops a running mining bot", async () => {
  const { store, flow } = harness({ docked: false, inFleet: true });
  await flow.startMiningBot(MINING_REQUEST);
  assert.equal(store.get().bot.status, "running", "the mining bot is up");

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);

  assert.equal(store.get().bot.status, "stopped", "the mining bot must give up the ship");
  assert.equal(store.get().companion.status, "running");
  flow.stopFleetCompanion();
  flow.stopMiningBot();
});

test("starting the mining bot stops a running companion — the claim is symmetric", async () => {
  const { store, flow } = harness({ docked: false, inFleet: true });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "running", "the companion is up");

  await flow.startMiningBot(MINING_REQUEST);

  assert.equal(
    store.get().companion.status,
    "stopped",
    "the companion must be stopped by the mining bot's claim, with nobody having written that pairing",
  );
  flow.stopFleetCompanion();
  flow.stopMiningBot();
});

test("a REFUSED companion start still takes the ship off whatever was flying it", async () => {
  // The player said which loop they want. A start whose own preflight then
  // refuses must not leave the previous loop flying — that is how a click ends
  // up doing nothing visible while a bot keeps issuing orders.
  const { store, flow } = harness({ docked: false, inFleet: false });
  await flow.startMiningBot(MINING_REQUEST);
  assert.equal(store.get().bot.status, "running");

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);

  assert.equal(store.get().companion.status, "idle", "the companion was refused");
  assert.equal(store.get().bot.status, "stopped", "and the mining bot still gave up the ship");
  flow.stopMiningBot();
});

// --- pause / resume / stop --------------------------------------------------

test("pause, resume and stop move the companion through its states", async () => {
  const { store, flow } = harness({ inFleet: true });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "running");

  flow.pauseFleetCompanion();
  assert.equal(store.get().companion.status, "paused", "a pause must reach the store");

  flow.resumeFleetCompanion();
  assert.equal(store.get().companion.status, "running");

  flow.stopFleetCompanion();
  // ⚠ THIS ASSERTION IS THE ONE THAT CAUGHT A REAL BUG. The loop reported
  // nothing on stop at first, so the store went on believing the companion held
  // the ship — which would have made the next bot's claim look like it stopped
  // nothing, and left the readout stuck on "running" forever.
  assert.equal(store.get().companion.status, "stopped", "a stop must reach the store too");
});

test("clearing the character drops the companion readout", async () => {
  const { store, flow } = harness({ inFleet: true });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "running");

  store.apply({ type: "character/offline" });

  assert.equal(store.get().companion.status, "idle");
  flow.stopFleetCompanion();
});

// --- the drain is the only push a headless companion ever gets ---------------

/** Poll until `ready()`, or give up. The flow's ticks are async and untimed. */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** One pushed notification, shaped exactly as the BFF drains it onto a response. */
function inviteNotification() {
  return {
    kind: "client",
    service: null,
    method: "OnFleetInvite",
    idType: "charid",
    args: [90000050, 90000001, "AskJoinFleet", {}],
    kwargs: null,
  };
}

test("a notification DRAINED onto a bridge response reaches the push dispatch", async () => {
  // ⚠ THIS IS THE WHOLE REASON A HEADLESS COMPANION CAN HEAR ITS FLEET.
  // `applyPushedNotification` has one other caller, the SSE branch, and
  // `src/botHost.js` gives every headless bot `stubEventSource()` — a channel
  // that is never live. So on the bot host the live path never runs, and
  // anything that arrives ONLY as a push is simply never seen.
  //
  // The BFF already drains notifications onto every response for exactly this
  // case; nothing on this side consumed them until now. The event driven here
  // is a fleet INVITE because it is the push consumer that already existed —
  // and, not incidentally, the one decision 5's rejoin gate reads.
  // The bot host's `stubEventSource()`, in miniature: a channel that never
  // delivers anything, which is the whole condition under test.
  const eventSource = () => ({
    close() {},
    addEventListener() {},
    removeEventListener() {},
    onmessage: null,
    onerror: null,
    onopen: null,
  });

  let inviteDrained = false;
  const fakeFetch = (async (input: unknown, init?: { body?: string }) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(init.body) : {};
    return {
      ok: true,
      status: 200,
      async json() {
        if (path === "/api/bridge/flight/status") {
          // The drain rides along with an ordinary read. No extra route, no
          // poll of our own — this response was going to be made anyway.
          const notifications = inviteDrained ? [] : [inviteNotification()];
          inviteDrained = true;
          return {
            ...(flightBody(false) as Record<string, unknown>),
            notifications,
          };
        }
        if (path === "/api/bridge/space/snapshot") return spaceBody();
        if (path === "/api/bridge/fitting") return fittingBody({});
        if (path === "/api/names") return namesBody(body as Record<string, unknown>);
        if (path === "/api/bridge/bound-fleet") return readyFleet();
        if (path === "/api/bots/active") return { ok: true, characterIDs: [], bots: [] };
        return { ok: true };
      },
    };
  }) as unknown as typeof fetch;

  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: fakeFetch, eventSource, livePush: false });
  store.apply({ type: "character/online", character: { characterID: OWN_CHARACTER_ID, characterName: "Companion",
    stationID: null, structureID: null, solarSystemID: SOLAR_SYSTEM_ID, corporationID: null }, station: null });

  assert.equal(store.get().fleet.pendingInvite, null, "nothing has been pushed yet");
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  await waitFor(
    () => store.get().fleet.pendingInvite !== null,
    "the drained OnFleetInvite to reach the store",
  );
  assert.equal(store.get().fleet.pendingInvite?.fleetID, 90000050);
  flow.stopFleetCompanion();
});

test("a drained response with no notifications changes nothing", async () => {
  // The empty case has to stay free: this runs on every read of every tick.
  const { store, flow } = harness({ inFleet: true });
  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get().fleet.pendingInvite, null);
  flow.stopFleetCompanion();
});

// --- the chat read: a cost gate, and the stale-capture trap it depends on --

/**
 * `store.companion.why` starts `null` on every fresh `companion/started` and
 * every branch of the ladder fills it in — so this is true only once a tick
 * has fully DECIDED something, which is after `observe()`'s whole
 * `Promise.all` (chat included) has resolved and `issue()` (if any) has
 * already landed, not merely been dispatched.
 */
async function waitForCompanionTick(
  companionWhy: () => string | null,
): Promise<void> {
  await waitFor(() => companionWhy() !== null, "the tick to decide something");
}

// --- freshness: a lapsed chat order must fall back to the pilot's own ladder --

/** An `align <belt>` chat line from the allowed sender, `ageMs` old. */
function alignChatLine(ageMs: number): unknown {
  return {
    characterID: ALLOWED_CHAT_SENDER,
    // Obviously synthetic on purpose: a plausible-looking capsuleer name in a
    // fixture is indistinguishable from a real one lifted out of a live session.
    characterName: "Allowed Commander",
    message: `align <url=showinfo:15//${BELT}>Asteroid Belt 1</url>`,
    createdAtMs: Date.now() - ageMs,
  };
}

test("every companion reads LOCAL chat, and never any other room", async () => {
  // ⚠ THIS REPLACES FIVE COST-GATE TESTS FOR A GATE THAT WAS A BUG. Chat used
  // to be read only when the operator had ticked a channel AND hand-typed at
  // least one character id -- so the settings screen's own promise that
  // "whoever the fleet roster names a commander is obeyed regardless" was false
  // twice over: nothing consulted the roster, and with an empty list the read
  // never happened at all. A companion now always listens, and the ROSTER
  // decides who it hears (see the sender-gate tests in fleetCompanionLoop.test.ts).
  //
  // ⚠ AND IT MUST ASK LOCAL, NEVER "FLEET". Fleet chat is unreachable on this
  // server -- the gateway only ever computes local and corp rooms -- so a read
  // of anything else is a read that can never answer.
  const { store, flow, calls } = chatHarness();

  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.ok(calls.includes("/api/bridge/chat/local"));
  assert.ok(
    !calls.some((path) => path.startsWith("/api/bridge/chat/") && path !== "/api/bridge/chat/local"),
  );
  flow.stopFleetCompanion();
});

test("every companion reads its own drone bay, with nothing to switch on", async () => {
  // ⚠ THE OLD GATE WAS `useDrones`, AND THERE IS NO SUCH SETTING. A pilot flies
  // the drones it is carrying, so "is it carrying any" is precisely what this
  // read answers and cannot be skipped on the strength of an answer nobody gave.
  const { store, flow, calls } = chatHarness();

  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.ok(calls.some((path) => path.startsWith("/api/bridge/drones")));
  flow.stopFleetCompanion();
});

test("a chat order older than FLEET_BROADCAST_TTL_MS does not reach the loop", async () => {
  const { store, flow, calls } = chatHarness({
    humanMemberCharacterID: HUMAN_FLEET_MEMBER,
    chatEntries: [alignChatLine(FLEET_BROADCAST_TTL_MS + 5_000)],
  });
  const request: FleetCompanionRequest = {
    ...DEFAULT_FLEET_COMPANION_REQUEST,
  };

  await flow.startFleetCompanion(request);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.ok(calls.includes("/api/bridge/chat/local"), "the read itself still happens");
  assert.ok(
    !calls.includes("/api/bridge/flight/align"),
    "a chat order past its TTL must not be obeyed -- a lapsed order is exactly as stale as a lapsed broadcast",
  );
  assert.equal(
    store.get().companion.phase,
    "Standing by",
    "with the order dropped as stale, this supervised pilot has nothing to obey",
  );
  flow.stopFleetCompanion();
});

test("a chat order inside FLEET_BROADCAST_TTL_MS reaches the loop and is obeyed", async () => {
  const { store, flow, calls } = chatHarness({
    humanMemberCharacterID: HUMAN_FLEET_MEMBER,
    chatEntries: [alignChatLine(1_000)],
  });
  const request: FleetCompanionRequest = {
    ...DEFAULT_FLEET_COMPANION_REQUEST,
  };

  await flow.startFleetCompanion(request);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.ok(
    calls.includes("/api/bridge/flight/align"),
    "a fresh chat order must reach the loop and be obeyed",
  );
  assert.equal(
    store.get().companion.followingOrderFrom,
    "chat",
    "and the readout must attribute it to chat, not the fleet's own ladder",
  );
  flow.stopFleetCompanion();
});

// --- the tagging gate: the flow feeds canTagInFleet the right row, and the --
// --- verdict reaches the readout ---------------------------------------------
//
// `canTagInFleet` itself is proven pure, in isolation, beside `fleetCommand.ts`.
// What is NOT proven there is that `flow.ts`'s `observe()` actually hands it
// THIS pilot's own roster row and THIS pilot's own character id, and that the
// answer survives the trip through `onProgress` into `store.companion.canTag`
// -- the only place a player (or the ladder's own UI) ever reads it. Every
// test below asserts on `store.get().companion.canTag`, never on a bare call
// to the gate function, for exactly that reason: a test that only re-invoked
// `canTagInFleet` would pass even if `flow.ts` fed it the wrong snapshot, the
// wrong character id, or never wired the result into `onProgress` at all.

test("this pilot's own row holding a commander ROLE reaches the readout as canTag true", async () => {
  const { store, flow } = harness({
    inFleet: true,
    members: [{ charID: OWN_CHARACTER_ID, role: 2 }], // FLEET_ROLE_WING_COMMANDER
  });
  seatOnlineCharacter(store, OWN_CHARACTER_ID);

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.equal(store.get().companion.canTag, true);
  flow.stopFleetCompanion();
});

test("this pilot's own row as a plain member (role 4, job 0) reaches the readout as canTag false", async () => {
  const { store, flow } = harness({
    inFleet: true,
    members: [{ charID: OWN_CHARACTER_ID, role: 4, job: 0 }], // FLEET_ROLE_MEMBER, FLEET_JOB_NONE
  });
  seatOnlineCharacter(store, OWN_CHARACTER_ID);

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.equal(store.get().companion.canTag, false);
  flow.stopFleetCompanion();
});

test("THE BITMASK TRAP: a plain member (role 4) carrying the CREATOR job bit (job 2) still reaches the readout as canTag true", async () => {
  // A `member.job === FLEET_JOB_CREATOR` at the call site, or the wrong
  // constant, would get this row wrong in exactly the way the server's own
  // silent refusal would then hide from a player forever: the seat sits at
  // role 4 (a plain member, by role alone) but the fleet creator's job bit is
  // set -- FLEET_CMDR_ROLES.includes(4) is false, so only the `&` test on
  // `job` can find this one. A wrong constant (e.g. FLEET_JOB_CREATOR
  // mistakenly reading 1, the value it shares with FLEET_JOB_SCOUT) would
  // flip this to false; a `===` in place of `&` would flip it too, since this
  // row's `job` here is exactly 2 and would still pass a `=== 2` check by
  // accident -- see the next test for the case that catches THAT mistake.
  const { store, flow } = harness({
    inFleet: true,
    members: [{ charID: OWN_CHARACTER_ID, role: 4, job: 2 }], // member seat, FLEET_JOB_CREATOR bit
  });
  seatOnlineCharacter(store, OWN_CHARACTER_ID);

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.equal(store.get().companion.canTag, true);
  flow.stopFleetCompanion();
});

test("the other half of the trap: a plain member (role 4) carrying only the SCOUT job bit (job 1) reaches the readout as canTag false", async () => {
  // The bit FLEET_JOB_SCOUT (1) and the role FLEET_ROLE_LEADER (1) share a
  // number, and FLEET_JOB_CREATOR is 2 -- so a constant that got
  // "simplified" to FLEET_JOB_CREATOR = 1 would let THIS row (job 1, a mere
  // scout) through as a commander. Paired with the previous test, these two
  // rows are identical but for one bit each side of the real cut: this is
  // what proves the module is testing the CREATOR bit specifically, not just
  // "job is nonzero".
  const { store, flow } = harness({
    inFleet: true,
    members: [{ charID: OWN_CHARACTER_ID, role: 4, job: 1 }], // member seat, FLEET_JOB_SCOUT bit
  });
  seatOnlineCharacter(store, OWN_CHARACTER_ID);

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.equal(store.get().companion.canTag, false);
  flow.stopFleetCompanion();
});

/**
 * A bound-fleet responder that answers `readyFleet(...)` to the FIRST call
 * (the preflight `startFleetCompanion` makes on its own, before the loop
 * ever runs a tick) and something else -- an unreadable roster, or a settled
 * "not in a fleet" -- to every call after that (the running loop's own
 * per-tick read). Needed because both scenarios below are about the RUNNING
 * loop's read going bad WHILE the companion is already flying, not about a
 * preflight that refuses to start in the first place (that path is already
 * covered above, by "an UNREADABLE fleet refuses the start too" and "a
 * companion refuses to start outside a fleet").
 */
function harnessWithRosterGoingBadMidRun(afterPreflight: () => unknown) {
  const store = createClientStore();
  seatOnlineCharacter(store, OWN_CHARACTER_ID);
  let boundFleetCalls = 0;

  const fakeFetch = (async (input: unknown, init?: { body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (path === "/api/bridge/bound-fleet") {
      boundFleetCalls += 1;
      if (boundFleetCalls === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return readyFleet({ members: [{ charID: OWN_CHARACTER_ID, role: 1 }] });
          },
        };
      }
      // Every call after the preflight's own: the RUNNING loop's read, and
      // the one under test.
      const answer = afterPreflight();
      if (answer instanceof Error) {
        throw answer;
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return answer;
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        if (path === "/api/bridge/flight/status") return flightBody(false);
        if (path === "/api/bridge/space/snapshot") return spaceBody();
        if (path === "/api/bridge/fitting") return fittingBody({});
        if (path === "/api/names") return namesBody(body as Record<string, unknown>);
        if (path === "/api/bridge/targets") return { ok: true, targetIDs: [], notifications: [] };
        return { ok: true };
      },
    };
  }) as unknown as typeof fetch;

  return { store, flow: createAppFlow(store, { fetch: fakeFetch }) };
}

test("a roster read that FAILS mid-run answers canTag null, never false — could-not-look is not a verdict", async () => {
  // ⚠ THIS IS THE TEST THAT PROVES THE THREE-STATE RETURN SURVIVES THE FLOW.
  // `canTagInFleet` itself already refuses to guess on an unreadable
  // snapshot; what this proves is that `flow.ts` actually PASSES it the
  // failed read as `null` (via the caught exception clearing `fleetSnapshot`)
  // rather than, say, reusing last tick's snapshot or defaulting to `false`
  // on a caught error. Either of those bugs would make this test read `false`
  // or `true` instead of `null`, while every other test in this file kept
  // passing.
  const { store, flow } = harnessWithRosterGoingBadMidRun(() => new Error("gateway unreachable"));

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "running", "the preflight's own read succeeded");

  await waitForCompanionTick(() => store.get().companion.why);

  assert.equal(
    store.get().companion.canTag,
    null,
    "the roster read failed this tick — unreadable is not evidence of anything, least of all 'not a commander'",
  );
  flow.stopFleetCompanion();
});

test("the roster settling on NOT-IN-FLEET mid-run (not a failure) answers canTag false", async () => {
  // The other settled state: every bound read explicitly refused with
  // FleetNotFound, which is `canTagInFleet`'s OWN `false` branch, not its
  // `null` one — proven reached here by feeding the running loop a genuine
  // `noFleet()` answer on its own tick, after a preflight that found a fleet.
  const { store, flow } = harnessWithRosterGoingBadMidRun(() => noFleet());

  await flow.startFleetCompanion(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(store.get().companion.status, "running", "the preflight's own read succeeded");

  await waitForCompanionTick(() => store.get().companion.why);

  assert.equal(
    store.get().companion.canTag,
    false,
    "not in a fleet at all is a settled, safe-to-remember 'no', not a could-not-look",
  );
  flow.stopFleetCompanion();
});

// --- rung 4: tackle -> tag, end to end --------------------------------------
//
// The rung itself is proven pure beside fleetCompanionLoop.ts. What is NOT
// proven there is that flow.ts's observe() folds the jam slice into
// `tackledBy`, that the ladder's write reaches `api.setFleetTargetTag`, and
// that the exhaustive dispatcher has a case for the new action kind at all --
// a missing case throws at runtime and compiles fine only until someone
// widens the union, which is exactly how `deactivate` once landed unwired.

/** A ship on grid for the jam to name, alongside this pilot's own hull. */
const TACKLER_ITEM_ID = 200001;

function taggingHarness(own: RosterMemberFixture = { charID: OWN_CHARACTER_ID, role: 1 }) {
  const calls: { readonly path: string; readonly body: Record<string, unknown> }[] = [];

  function spaceWithTackler(): unknown {
    return {
      ok: true,
      space: {
        inSpace: true,
        solarSystemID: SOLAR_SYSTEM_ID,
        shipID: SHIP_ID,
        sampledAtMs: 0,
        ship: {
          itemID: SHIP_ID,
          typeID: 17480,
          mode: "STOP",
          radius: 60,
          position: { x: 0, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          shieldRatio: 1,
          armorRatio: 1,
          hullRatio: 1,
          capacitorRatio: 1,
          activeModuleIDs: [],
        },
        entities: [
          {
            itemID: TACKLER_ITEM_ID,
            kind: "ship",
            typeID: 587,
            radius: 30,
            position: { x: 9000, y: 0, z: 0 },
            velocity: { x: 0, y: 0, z: 0 },
          },
        ],
      },
      notifications: [],
    };
  }

  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ path, body: body as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      async json() {
        if (path === "/api/bridge/flight/status") return flightBody(false);
        if (path === "/api/bridge/space/snapshot") return spaceWithTackler();
        if (path === "/api/bridge/targets") {
          return { ok: true, targetIDs: [], notifications: [] };
        }
        // The server's answer to a broadcast: whether it sent it.
        if (path === "/api/bridge/call" && body.method === "BroadcastToBubble") {
          return { ok: true, service: body.service, method: body.method, result: true, notifications: [] };
        }
        if (path === "/api/bridge/bound-fleet") {
          return readyFleet({
            members: [
              // THIS pilot, holding FLEET_ROLE_LEADER unless the test says
              // otherwise -- the roster row canTagInFleet has to find and approve.
              own,
              // A human, so the supervision gate passes and the ladder runs at
              // all rather than getting safe.
              { charID: HUMAN_FLEET_MEMBER },
            ],
          });
        }
        return { ok: true };
      },
    };
  }) as unknown as typeof fetch;

  const store = createClientStore();
  return { store, flow: createAppFlow(store, { fetch: fakeFetch }), calls };
}

/** The scram push, as the wire delivers it, folded onto the space slice. */
function scramble(store: ReturnType<typeof createClientStore>): void {
  const event = decodeJamNotification(
    "OnJamStart",
    [TACKLER_ITEM_ID, 7777, SHIP_ID, "warpScramblerMWD", 0, 5000],
    Date.now(),
  );
  assert.notEqual(event, null, "the fixture must decode, or this test proves nothing");
  store.apply({ type: "space/jam", event: event! });
}

function tagWrites(calls: readonly { readonly path: string; readonly body: Record<string, unknown> }[]) {
  return calls.filter((call) => call.path === "/api/bridge/flight/fleet-tag-target");
}

test("a scram push reaches the ladder and the tackler is lettered for the fleet", async () => {
  const { store, flow, calls } = taggingHarness();
  seatOnlineCharacter(store, OWN_CHARACTER_ID);
  // The fleet has tagged nothing yet -- a real, empty answer, which is what
  // lets the rung know which letters are free.
  store.apply({ type: "fleet/target-tags", tags: new Map() });
  scramble(store);

  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  await waitFor(() => tagWrites(calls).length > 0, "a tag write to reach the BFF");

  const write = tagWrites(calls)[0];
  assert.equal(write?.body.itemID, TACKLER_ITEM_ID, "the ship that named itself is the one tagged");
  assert.equal(write?.body.tag, "A");
  assert.equal(write?.body.confirm, true);
  flow.stopFleetCompanion();
});

// ⚠ The dead-config check, end to end this time. attemptsTagging shipped as a
// checkbox with no reader; a regression that unwired it again would leave every
// unit test above passing.
// ⚠ THE NEGATIVE CASE THE PHASE TABLE ASKS FOR. The server drops a
// non-commander's tag silently, so a test that only ever exercised the happy
// path could not tell a working gate from one that always says yes.
test("a plain member writes no tag, however hard it is being scrambled", async () => {
  const calls: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ path, body: body as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      async json() {
        if (path === "/api/bridge/flight/status") return flightBody(false);
        if (path === "/api/bridge/space/snapshot") return spaceBody();
        if (path === "/api/bridge/targets") return { ok: true, targetIDs: [], notifications: [] };
        if (path === "/api/bridge/bound-fleet") {
          return readyFleet({
            members: [
              // FLEET_ROLE_MEMBER, FLEET_JOB_NONE -- looked at, and no.
              { charID: OWN_CHARACTER_ID, role: 4, job: 0 },
              { charID: HUMAN_FLEET_MEMBER },
            ],
          });
        }
        return { ok: true };
      },
    };
  }) as unknown as typeof fetch;

  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: fakeFetch });
  seatOnlineCharacter(store, OWN_CHARACTER_ID);
  store.apply({ type: "fleet/target-tags", tags: new Map() });
  scramble(store);

  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  await waitFor(() => store.get().companion.canTag !== null, "the tagging gate to answer");

  assert.equal(store.get().companion.canTag, false);
  assert.equal(
    calls.filter((call) => call.path === "/api/bridge/flight/fleet-tag-target").length,
    0,
  );
  flow.stopFleetCompanion();
});

// ⚠ AND WHAT THE PLAIN MEMBER DOES INSTEAD, which is the arm that runs in
// nearly every real fleet. The rung is proven pure beside the loop; that the
// flow's dispatcher sends anything for it was reached by no test. It is the
// client's own call (fleetSvc.py 1050 and 998: SendBroadcast_Target reaches
// fleetMgr.BroadcastToBubble(name, scope, itemID, None)), made by the page
// itself, and never by the route it went by until 2026-10-10.
test("a plain member being scrambled calls the tackler out to the fleet, by the page's own call", async () => {
  const { store, flow, calls } = taggingHarness({ charID: OWN_CHARACTER_ID, role: 4, job: 0 });
  seatOnlineCharacter(store, OWN_CHARACTER_ID);
  store.apply({ type: "fleet/target-tags", tags: new Map() });
  scramble(store);

  const broadcasts = () => calls.filter((call) => call.path === "/api/bridge/call" && call.body.method === "BroadcastToBubble");
  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  // The companion is stopped whatever is found: one left flying keeps this file's process from ending.
  try {
    await waitFor(() => broadcasts().length > 0 || calls.some((call) => call.path === "/api/bridge/fleet/broadcast/bubble"), "a target call to reach the BFF");

    // "Target", to everyone (the client's default scope), the ship that named itself, and no type.
    assert.deepEqual(broadcasts().map((call) => call.body), [
      { service: "fleetMgr", method: "BroadcastToBubble", args: ["Target", 3, TACKLER_ITEM_ID, null], kwargs: null, pilot: true, confirm: true },
    ]);
    assert.equal(calls.filter((call) => call.path === "/api/bridge/fleet/broadcast/bubble").length, 0, "the route is not asked");
    assert.equal(tagWrites(calls).length, 0, "and a plain member letters nothing");
  } finally {
    flow.stopFleetCompanion();
  }
});

// --- rung 5: the drone bay cost gate ----------------------------------------
//
// ⚠ THE SAME TRAP THE CHAT READ WAS BUILT AROUND, and the reason that gate has
// its own test. The drone BAY is the one thing the drone rung needs that the
// space snapshot does not already carry, and it is a whole extra round trip on
// every tick of every companion. A pilot whose operator never ticked useDrones
// must not pay for a listing no rung will read.
//
// What the snapshot gives free -- which drones are out, and how hurt they are --
// is built ungated, because it costs nothing.

// ⚠ THE STALE-CAPTURE TRAP, the same one the chat gate carries a pair of tests
// for. The gate reads the LIVE request, not the one captured when the deps were
// built, so flipping the setting between two runs of the SAME companion has to
// change what the next run reads.
// --- the two grid reads observe() owes the ladder ----------------------------
//
// ⚠ THIS SECTION EXISTS BECAUSE THE LADDER'S OWN UNIT TESTS CANNOT SEE THIS
// BUG. `fleetCompanionLoop.test.ts` builds its observations by hand, so it sets
// `targetedByPlayer` and `targetGroupNames` itself and passes just as happily
// against a `makeFleetCompanionDeps()` whose `observe()` populated neither.
// Both fields really were declared and never filled, and both rungs that read
// them degraded in silence. Only a test that drives the REAL `observe()` over a
// faked BFF can catch that.
//
// ⚠ AND BOTH ASSERT ON A DECISION, NEVER ON THE READ THAT FEEDS IT. A test
// that only checked "the group lookup was requested" would still pass against
// an `observe()` that computed the answer and then dropped it on the floor on
// its way out -- which is a mistake exactly one line away from the one being
// fixed here. What is asserted is which module was switched on and which ship
// was lettered, because those are false unless the value reached the ladder.

// Rival capsuleers, synthetic ids throughout. The hull type ids are this
// file's own and are answered by this file's own /api/names stub.
const RIVAL_CHARACTER_ID = 90000012;
const RIVAL_SHIP_ITEM_ID = 90000013;
const RIVAL_HULL_TYPE_ID = 90000014;
/**
 * A hardener on this pilot's own fit, for the tank rung to switch on.
 *
 * ⚠ IT IS ON THE FIT NOW, NOT ON THE REQUEST. These tests used to hand the
 * itemID straight to `startFleetCompanion` in `defenseModuleIDs`. There is no
 * such field to hand it to any more -- a companion derives every module list
 * from the hull it is sitting in -- so the fixture has to put a real hardener
 * on a real fit and let the classifier find it. That makes these tests cover
 * MORE than they used to: the derivation and the rung, not just the rung.
 */
const HARDENER_ITEM_ID = 7101;
const HARDENER_TYPE_ID = 90000030;

/** The hardener as a fitted row, in a mid slot the Procurer fixture leaves free. */
const HARDENER_ROW = Object.freeze({
  itemID: HARDENER_ITEM_ID,
  typeID: HARDENER_TYPE_ID,
  flagID: 22,
  groupID: 77,
  name: "Kinetic Deflection Field II",
  groupName: "Shield Hardener",
});

// The two tacklers of the ranking test. The NEARER one is the bigger hull, so
// nearest-first and class-first disagree about which to letter -- which is the
// only arrangement that can tell them apart.
const NEAR_BRICK_ITEM_ID = 90000020;
const NEAR_BRICK_TYPE_ID = 90000021;
const FAR_CEPTOR_ITEM_ID = 90000022;
const FAR_CEPTOR_TYPE_ID = 90000023;

/**
 * The SDE's own ship-group names, exactly as `targetPriority.ts` matches them
 * (trimmed, lowercased, never a substring test). "Interceptor" is the `tackle`
 * class, the top of the shipped priority order; "Battleship" is not in any
 * class list and ranks with `other`, at the bottom.
 */
const HULL_GROUPS: Readonly<Record<number, string>> = Object.freeze({
  [NEAR_BRICK_TYPE_ID]: "Battleship",
  [FAR_CEPTOR_TYPE_ID]: "Interceptor",
  // ⚠ THE CLASSIFIER SKIPS ANY MODULE WHOSE GROUP HAS NOT RESOLVED -- "never
  // run a mystery module" -- so without this row the hardener is on the fit and
  // in no list, and the tank rung has nothing to light.
  [HARDENER_TYPE_ID]: "Shield Hardener",
});

/** One ship row, as the space bridge marshals a PLAYER hull on grid. */
function rivalShip(options: {
  readonly itemID: number;
  readonly typeID: number;
  readonly characterID: number;
  readonly distance: number;
  /** Set when this one is holding a lock on THIS pilot. */
  readonly locking?: boolean;
}): unknown {
  return {
    itemID: options.itemID,
    kind: "ship",
    typeID: options.typeID,
    radius: 30,
    position: { x: options.distance, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    shieldRatio: 1,
    armorRatio: 1,
    hullRatio: 1,
    // A person, not a rat -- the whole point of this section. `isHostile` says
    // no to this row, so `hostileRows` never returns it and `hostileOnGrid`
    // stays a flat `false` however many of these are on the grid.
    isNpc: false,
    isSelf: false,
    characterID: options.characterID,
    targetEntityID: options.locking === true ? SHIP_ID : null,
  };
}

/** One recorded request: the path asked, and the body it was asked with. */
interface RecordedCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/**
 * `POST /api/names` answering GROUP names for this section's own hull types,
 * and nothing else -- a type it has no entry for comes back unresolved, which
 * is how `targetPriority.ts`'s "cannot tell ranks with other" arm gets reached
 * rather than stubbed past.
 */
function hullGroupNamesBody(body: Record<string, unknown>): unknown {
  const items = Array.isArray(body.items) ? (body.items as { kind?: string; id?: number }[]) : [];
  const names: Record<string, string> = {};
  for (const item of items) {
    const group = item.kind === "typeGroup" && item.id !== undefined ? HULL_GROUPS[item.id] : undefined;
    if (group !== undefined) {
      names[`typeGroup:${item.id}`] = group;
    }
  }
  return { ok: true, source: "static-data", count: Object.keys(names).length, names, unresolved: [] };
}

/**
 * A harness whose grid is the caller's, recording each request's BODY as well
 * as its path -- `/api/names` is one endpoint asked many different questions,
 * so "was it called" says nothing and only the items asked for do.
 *
 * A human is always seated in the roster, because every rung reached here sits
 * below the supervision gate. `commander` additionally gives THIS pilot the
 * leader role, which rung 4 needs before it will write anything.
 */
function gridHarness(options: {
  readonly entities: readonly unknown[];
  readonly commander?: boolean;
  /**
   * Put a real Shield Hardener on this pilot's fit.
   *
   * ⚠ OPT-IN, AND IT HAS TO BE. Every module list is DERIVED from the hull
   * now, so a hardener served to every test in this harness arms the tank rung
   * everywhere -- and the tank rung sits ABOVE tagging in the ladder. The
   * interceptor-ranking test below would then spend its first ticks lighting a
   * hardener instead of writing the letter it is about. A fixture that changes
   * which rung fires is not a neutral fixture.
   */
  readonly hardener?: boolean;
}) {
  const calls: RecordedCall[] = [];

  function spaceBodyWithGrid(): unknown {
    return {
      ok: true,
      space: {
        inSpace: true,
        solarSystemID: SOLAR_SYSTEM_ID,
        shipID: SHIP_ID,
        sampledAtMs: 0,
        ship: {
          itemID: SHIP_ID,
          typeID: 17480,
          mode: "STOP",
          radius: 60,
          position: { x: 0, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          shieldRatio: 1,
          armorRatio: 1,
          hullRatio: 1,
          capacitorRatio: 1,
          // Nothing running, so the tank rung's `active` set is a real empty:
          // a hardener it leaves dark was left dark by the fight test itself.
          activeModuleIDs: [],
        },
        entities: [...options.entities],
      },
      notifications: [],
    };
  }

  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const parsed =
      init && typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    calls.push({ path, body: parsed });
    return {
      ok: true,
      status: 200,
      async json() {
        if (path === "/api/bridge/flight/status") return flightBody(false);
        if (path === "/api/bridge/space/snapshot") return spaceBodyWithGrid();
        if (path === "/api/names") return hullGroupNamesBody(parsed);
        if (path === "/api/bridge/fitting") {
          return fittingBody(options.hardener === true ? { extraModules: [HARDENER_ROW] } : {});
        }
        if (path === "/api/bridge/targets") return { ok: true, targetIDs: [], notifications: [] };
        if (path === "/api/bridge/bound-fleet") {
          return readyFleet({
            members: [
              // FLEET_ROLE_LEADER when asked for, otherwise no row for this
              // pilot at all -- which is the ordinary case for the tank rung.
              ...(options.commander === true ? [{ charID: OWN_CHARACTER_ID, role: 1 }] : []),
              // A human, so the supervision gate passes and the ladder runs at
              // all rather than getting safe.
              { charID: HUMAN_FLEET_MEMBER },
            ],
          });
        }
        return { ok: true };
      },
    };
  }) as unknown as typeof fetch;

  const store = createClientStore();
  return { store, flow: createAppFlow(store, { fetch: fakeFetch }), calls };
}

/** Did anything ask `/api/names` for THIS type id's group name? */
function askedForGroupOf(calls: readonly RecordedCall[], typeID: number): boolean {
  return calls.some((call) => {
    if (call.path !== "/api/names") {
      return false;
    }
    const items = Array.isArray(call.body.items)
      ? (call.body.items as { kind?: string; id?: number }[])
      : [];
    return items.some((item) => item.kind === "typeGroup" && item.id === typeID);
  });
}

test("a PLAYER lock alone lights a hardener, through the real observe()", async () => {
  // ⚠ THE REGRESSION THIS SECTION IS FOR. `decideTankUp`'s fight test is
  // `hostileOnGrid === true || targetedByPlayer === true`, and on this grid the
  // first half is a read that came back `false`: there is not one NPC out
  // there. An `observe()` that stops filling `targetedByPlayer` leaves BOTH
  // halves false, and this pilot then sits in a player gatecamp with its
  // hardeners dark -- which is the state the companion shipped in until now.
  const { store, flow, calls } = gridHarness({
    hardener: true,
    entities: [
      rivalShip({
        itemID: RIVAL_SHIP_ITEM_ID,
        typeID: RIVAL_HULL_TYPE_ID,
        characterID: RIVAL_CHARACTER_ID,
        distance: 9000,
        locking: true,
      }),
    ],
  });

  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.equal(
    store.get().companion.phase,
    "Tanking up",
    "a player holding a lock on this hull is a fight, and a fight means hardeners",
  );
  const activated = calls.filter((call) => call.path === "/api/bridge/modules/activate");
  assert.equal(activated.length, 1, "exactly the one idle hardener");
  assert.equal(activated[0]?.body.itemID, HARDENER_ITEM_ID);
  flow.stopFleetCompanion();
});

test("the same grid with NOBODY locking leaves the hardener alone", async () => {
  // The other half of the pair: with the lock gone this is the same player on
  // the same grid, and `hostileOnGrid` reads `false` for it just as before. A
  // rung that lit up here would be firing on the mere presence of a stranger,
  // which would make the test above prove nothing.
  const { store, flow, calls } = gridHarness({
    hardener: true,
    entities: [
      rivalShip({
        itemID: RIVAL_SHIP_ITEM_ID,
        typeID: RIVAL_HULL_TYPE_ID,
        characterID: RIVAL_CHARACTER_ID,
        distance: 9000,
      }),
    ],
  });

  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.equal(store.get().companion.phase, "Standing by");
  assert.equal(
    calls.filter((call) => call.path === "/api/bridge/modules/activate").length,
    0,
    "nobody is shooting at this pilot, so nothing should be burning capacitor",
  );
  flow.stopFleetCompanion();
});

/** The scram push for one named ship, as the wire delivers it. */
function scrambledBy(store: ReturnType<typeof createClientStore>, tacklerItemID: number): void {
  const event = decodeJamNotification(
    "OnJamStart",
    [tacklerItemID, 7777, SHIP_ID, "warpScramblerMWD", 0, 5000],
    Date.now(),
  );
  assert.notEqual(event, null, "the fixture must decode, or this test proves nothing");
  store.apply({ type: "space/jam", event: event! });
}

/** Both tacklers of the ranking test, on one grid. */
const TWO_TACKLERS: readonly unknown[] = [
  rivalShip({
    itemID: NEAR_BRICK_ITEM_ID,
    typeID: NEAR_BRICK_TYPE_ID,
    characterID: RIVAL_CHARACTER_ID,
    distance: 5_000,
    locking: true,
  }),
  rivalShip({
    itemID: FAR_CEPTOR_ITEM_ID,
    typeID: FAR_CEPTOR_TYPE_ID,
    characterID: RIVAL_CHARACTER_ID + 1,
    distance: 40_000,
    locking: true,
  }),
];

test("the fleet's letter goes to the INTERCEPTOR four times further out, not the nearest hull", async () => {
  // ⚠ THE TEST THAT MAKES `targetGroupNames` LOAD-BEARING. `pickPrimary` ranks
  // by CLASS first and distance only within a class, so with the groups in hand
  // the interceptor wins outright. Without them every candidate ranks `other`
  // and the tie breaks on distance -- so an `observe()` that stops filling this
  // field letters the battleship sitting on top of this pilot, and does it with
  // no error anywhere. That is the degradation, and this is what catches it.
  //
  // Both ships are PLAYERS, which is the other half of what is being proved:
  // `hostileRows` cannot see either of them, so the group names can only have
  // come from the player-hull half of `classifyTargetGroups`.
  const { store, flow, calls } = gridHarness({ entities: TWO_TACKLERS, commander: true });
  seatOnlineCharacter(store, OWN_CHARACTER_ID);
  // A real, empty answer -- which is what lets the rung know every letter is free.
  store.apply({ type: "fleet/target-tags", tags: new Map() });
  scrambledBy(store, NEAR_BRICK_ITEM_ID);
  scrambledBy(store, FAR_CEPTOR_ITEM_ID);

  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  await waitFor(() => tagWrites(calls).length > 0, "a tag write to reach the BFF");

  const write = tagWrites(calls)[0];
  assert.equal(
    write?.body.itemID,
    FAR_CEPTOR_ITEM_ID,
    "tackle outranks everything, and the interceptor is the tackle here",
  );
  assert.equal(write?.body.tag, "A");
  flow.stopFleetCompanion();
});


// --- reading the ship it is actually in -------------------------------------

test("a deriving start WARMS THE GROUP NAMES before it classifies the fit", async () => {
  // ⚠ THE SILENT-NAKED-SHIP BUG THIS EXISTS TO CATCH. Both classifiers skip any
  // module whose typeGroup is not already in the name cache -- deliberately,
  // "never run a mystery module" -- and on the BOT HOST that cache starts
  // EMPTY. Without the warming call, a headless deriving start classifies
  // nothing, flies with no tank and no guns, and reports no error at all: every
  // list is legitimately empty, so nothing downstream can tell the difference.
  //
  // Pinned on the observable call rather than on the derived lists, because a
  // fit fixture whose modules match no category gives empty lists whether the
  // names were warmed or not -- a test asserting those would pass over the bug.
  const { flow, posted } = harness();
  await flow.startFleetCompanion({
    ...DEFAULT_FLEET_COMPANION_REQUEST,
  });
  flow.stopFleetCompanion();

  const nameCalls = posted.filter((call) => call.path === "/api/names");
  assert.ok(nameCalls.length > 0, "a deriving start must resolve names at all");
  const askedForGroups = nameCalls.some((call) => {
    const items = call.body.items;
    return (
      Array.isArray(items) &&
      items.some((item) => (item as { kind?: string }).kind === "typeGroup")
    );
  });
  assert.ok(askedForGroups, "it must ask for typeGroup names, which is what the classifiers read");
});

test("fit warnings never refuse a start", async () => {
  // ⚠ ADVISORY BY THE OPERATOR'S OWN RULE: warn, and let a human either load
  // the missing thing or ignore it and fly. A run that refused on a warning
  // would ground a squad over one empty ammo bay.
  const { store, flow } = harness();
  await flow.startFleetCompanion({
    ...DEFAULT_FLEET_COMPANION_REQUEST,
  });
  const slice = store.companion.get();
  assert.equal(slice.status, "running", "warnings must not stop the run");
  assert.equal(slice.startError, null);
  flow.stopFleetCompanion();
});


test("the LOOP is started on the derived request, not the one that came in", () => {
  // ⚠ PINNED AGAINST THE SOURCE, AND THE REASON MATTERS. This is the central
  // claim of the whole feature -- the pilot must fly the lists read off its
  // hull, not the empty ones the squad stored -- and it is the one claim this
  // suite cannot observe behaviourally. The harness's fit fixture (a Procurer:
  // strip miners, a web, a scrambler) classifies to EMPTY for every category
  // the companion uses, so the derived request and the incoming one are
  // identical in this harness and a behavioural test would pass either way.
  // Verified by mutation: swapping `flownRequest` back to `request` breaks no
  // test in this file, which is exactly why this one is written differently.
  //
  // ⚠ THAT IS NO LONGER THE ONLY PROOF, AND THIS TEST IS NOW THE BACKSTOP.
  // This comment used to end "proving it behaviourally needs a fit fixture
  // carrying a hardener or a gun, which means widening the shared
  // botFixtures". That fixture now exists: `fittingBody({ extraModules })`,
  // and the two hardener tests above fly a Procurer with a real Shield
  // Hardener on it and watch the tank rung light a module NOBODY passed in.
  // Those cover the claim end to end. This one stays because it is cheap and
  // it catches the narrower mistake they cannot: handing the loop the
  // un-derived value while the derivation itself still works.
  const source = readFileSync(new URL("./flow.ts", import.meta.url), "utf8");
  assert.match(source, /const flownRequest = requestForFit\(setup, fitFacts\);/);
  assert.match(source, /liveCompanionRequest = flownRequest;/);
  assert.match(source, /fleetCompanion\.start\(flownRequest, resuming\);/);
  assert.doesNotMatch(
    source,
    /fleetCompanion\.start\(setup, resuming\);/,
    "the loop must never be handed the un-derived setup",
  );
});

// --- the shared loot memory ------------------------------------------------
//
// A wreck's contents are unreadable past 2,500 m and the slim item's `isEmpty`
// -- the field the retail client draws its hollow-wreck bracket from -- rides
// DoDestinyUpdate, the one notification the web gateway suppresses. So a pilot
// learns a wreck is empty by FLYING TO IT, and the only saving available is that
// the next pilot reads what the first one found. These pin the READ half: what
// the observation asks for, and when it does not ask at all.

/** A wreck row on the grid, as the snapshot projects one. */
function wreckRow(itemID: number, distance: number): unknown {
  return {
    itemID,
    kind: "wreck",
    typeID: 26468,
    radius: 0,
    position: { x: distance, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    isSelf: false,
    ownerID: null,
  };
}

test("a grid with a wreck on it asks the BFF what other pilots have already emptied", async () => {
  const { store, flow, calls } = gridHarness({ entities: [wreckRow(80020, 25_000)] });

  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.ok(
    calls.some((call) => call.path.startsWith("/api/bots/loot-memory?system=")),
    "the shared board is what stops four pilots each flying to the same emptied wreck",
  );
  flow.stopFleetCompanion();
});

test("a grid with nothing lootable on it never asks — a read nobody could use is not made", async () => {
  const { store, flow, calls } = gridHarness({
    entities: [
      rivalShip({
        itemID: RIVAL_SHIP_ITEM_ID,
        typeID: RIVAL_HULL_TYPE_ID,
        characterID: RIVAL_CHARACTER_ID,
        distance: 9000,
      }),
    ],
  });

  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  await waitForCompanionTick(() => store.get().companion.why);

  assert.equal(
    calls.filter((call) => call.path.startsWith("/api/bots/loot-memory")).length,
    0,
    "same rule as the gated drone-bay read: a companion never pays for an answer no rung will read",
  );
  flow.stopFleetCompanion();
});

// --- waking the companion on a push -------------------------------------------
//
// ⚠ WHAT THIS PINS IS THE REACTION TIME ITSELF. Every fact a companion obeys --
// a fleet broadcast, a commander's target tag, a landed lock, a tackle jam --
// reaches the browser as a PUSH and lands in the store fully decoded the
// instant the server sends it. The loop then sat out the remainder of its
// cadence before it so much as looked, which is where "they take too long to
// react to broadcasts" came from: the order was already here, and the pilot was
// asleep on top of it. The sleep is a CEILING now rather than a fixed beat.
//
// ⚠ AND THE FLOOR IS PART OF THE CONTRACT, not an implementation detail. A
// fleet fight pushes a great many of these -- every tag change, every cycle of
// every tackle module -- and a wake that ran the tick outright on each one
// would fire the tick's six round trips as fast as the wire could deliver them.
// A wake brings the sleep's end forward TO the floor, never to zero.

function makeFakeCompanionSource(): {
  factory: (url: string) => {
    onmessage: ((event: { data: string }) => void) | null;
    onopen: (() => void) | null;
    onerror: ((event?: unknown) => void) | null;
    close(): void;
  };
  sources: { emit(frame: unknown): void }[];
} {
  const sources: { emit(frame: unknown): void }[] = [];
  const factory = () => {
    const source = {
      onmessage: null as ((event: { data: string }) => void) | null,
      onopen: null as (() => void) | null,
      onerror: null as ((event?: unknown) => void) | null,
      emit(frame: unknown) {
        source.onmessage?.({ data: JSON.stringify(frame) });
      },
      close() {},
    };
    sources.push(source);
    return source;
  };
  return { factory, sources };
}

/** The gateway's own push frame shape, as `fleetFlow.test.ts` builds it. */
function companionPushFrame(method: string, sequence: number, args: readonly unknown[]) {
  return {
    source: "evejs-web-gateway",
    apiVersion: 1,
    type: "event",
    cursor: { epoch: "companion-epoch", sequence },
    event: {
      kind: "notification",
      notification: { kind: "client", service: null, method, args, kwargs: null },
    },
  };
}

/**
 * A companion already past its first tick, with a live channel to push at and
 * a record of when each tick's first read went out.
 *
 * ⚠ THE STREAM IS OPENED THROUGH `setLivePush`, because these tests seat their
 * pilot straight into the store rather than through `selectCharacter` -- which
 * is the only other thing that opens one.
 */
async function companionAwaitingOrders() {
  const { factory, sources } = makeFakeCompanionSource();
  const readsAtMs: number[] = [];
  const fakeFetch = (async (input: unknown, init?: { body?: unknown }) => {
    const path = String(input);
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (path === "/api/bridge/flight/status") {
      readsAtMs.push(Date.now());
    }
    return {
      ok: true,
      status: 200,
      async json() {
        // Out in space on a quiet grid, and in a fleet with a human in it: the
        // ladder has nothing dramatic to do, so every tick ends in `wait` and
        // sleeps the FULL cadence — which is exactly the baseline these tests
        // measure against.
        //
        // ⚠ IT USED TO BE DOCKED, AND THAT STOPPED BEING A QUIET TICK. A docked
        // companion now has one thing it always wants to do -- leave (rung 5b)
        // -- so a station is the one place this fixture could not say "nothing
        // to do" from. Being in space says it honestly.
        if (path === "/api/bridge/flight/status") return flightBody(false);
        if (path === "/api/bridge/space/snapshot") return spaceBody();
        if (path === "/api/bridge/fitting") return fittingBody({});
        if (path === "/api/names") return namesBody(body as Record<string, unknown>);
        if (path === "/api/bridge/targets") return { ok: true, targetIDs: [], notifications: [] };
        if (path === "/api/bridge/bound-fleet") {
          // ⚠ A HUMAN ON THE ROSTER, OR THE SUPERVISION GATE ENDS THE RUN. An
          // unsupervised companion runs the abandonment protocol instead of the
          // ladder, and these tests would be measuring a loop already stopped.
          return readyFleet({
            members: [
              { charID: OWN_CHARACTER_ID, role: 4, job: 0 },
              { charID: ALLOWED_CHAT_SENDER, role: 1 },
            ],
          });
        }
        if (path === "/api/bots/active") return { ok: true, characterIDs: [], bots: [] };
        return { ok: true };
      },
    };
  }) as unknown as typeof fetch;

  const store = createClientStore();
  seatOnlineCharacter(store, OWN_CHARACTER_ID);
  const flow = createAppFlow(store, {
    fetch: fakeFetch,
    eventSource: factory,
    livePush: false,
  });
  flow.setLivePush(true);
  await waitFor(() => sources.length > 0, "the live channel to open");
  await flow.startFleetCompanion(DEFAULT_COMPANION_SETUP);
  await waitForCompanionTick(() => store.get().companion.why);
  // ⚠ ASSERTED, NOT ASSUMED. A REFUSED start also sets `why`, so without this
  // the wake tests below would be measuring a loop that never ran and would
  // report "the push did not wake it" for the wrong reason entirely.
  assert.equal(
    store.get().companion.status,
    "running",
    `the companion must actually be flying: ${String(store.get().companion.why)}`,
  );
  // The tick is done and the loop is now asleep on its cadence.
  const ticksBefore = readsAtMs.length;
  return { store, flow, readsAtMs, ticksBefore, source: sources[0]! };
}

/** Resolves once another tick's reads have gone out, or after `budgetMs`. */
async function nextTickWithin(readsAtMs: number[], before: number, budgetMs: number) {
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < budgetMs) {
    if (readsAtMs.length > before) {
      return Date.now() - startedAtMs;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

test("a pushed fleet broadcast wakes the companion instead of waiting out its cadence", async () => {
  const { flow, readsAtMs, ticksBefore, source } = await companionAwaitingOrders();

  // The wire is positional: [name, scope, senderCharID, senderSolarSystemID,
  // itemID, typeID] — see `decodeFleetBroadcastNotification`.
  source.emit(
    companionPushFrame("OnFleetBroadcast", 1, [
      "Target",
      3,
      ALLOWED_CHAT_SENDER,
      30000142,
      9001,
      null,
    ]),
  );

  const wokeAfterMs = await nextTickWithin(readsAtMs, ticksBefore, 1_200);
  flow.stopFleetCompanion();
  assert.notEqual(wokeAfterMs, null, "the pushed broadcast never woke the loop");
  assert.ok(
    wokeAfterMs !== null && wokeAfterMs < FLEET_COMPANION_CADENCE_MS,
    `a broadcast must not wait out the cadence, took ${String(wokeAfterMs)} ms`,
  );
});

// ⚠ THE OTHER HALF OF THE FIGHT CHAIN. Obeying a target call is lock, then WAIT
// FOR THE LOCK, then drones and guns -- and until `OnTarget` was decoded the
// only way to learn the lock had landed was the next tick's GetTargets poll. So
// the pilot paid a whole cadence between "the lock landed" and "anything used
// it", every single fight.
test("a pushed lock landing wakes the companion too", async () => {
  const { flow, readsAtMs, ticksBefore, source } = await companionAwaitingOrders();

  source.emit(companionPushFrame("OnTarget", 1, ["add", 9001]));

  const wokeAfterMs = await nextTickWithin(readsAtMs, ticksBefore, 1_200);
  flow.stopFleetCompanion();
  assert.notEqual(wokeAfterMs, null, "the landed lock never woke the loop");
  assert.ok(
    wokeAfterMs !== null && wokeAfterMs < FLEET_COMPANION_CADENCE_MS,
    `a landed lock must not wait out the cadence, took ${String(wokeAfterMs)} ms`,
  );
});

// ⚠ AND A PUSH THE LADDER CANNOT ACT ON MUST NOT WAKE IT. `otheradd` says
// somebody locked US; it changes no decision, so spending a tick's six round
// trips on it would be pure cost. The same rule keeps a storm of them from
// running the loop flat out.
test("a push with nothing for the ladder to do leaves the cadence alone", async () => {
  const { flow, readsAtMs, ticksBefore, source } = await companionAwaitingOrders();

  source.emit(companionPushFrame("OnTarget", 1, ["otheradd", 9001]));

  const wokeAfterMs = await nextTickWithin(readsAtMs, ticksBefore, 700);
  flow.stopFleetCompanion();
  assert.equal(wokeAfterMs, null, "a push the ladder cannot act on must not buy a tick");
});
