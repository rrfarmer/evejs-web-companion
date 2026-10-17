// The fleet companion panel as it actually RENDERS — third instance of the
// MiningBot.svelte / MissionBot.svelte pattern.
//
// ⚠ 2026-09-11 SIMPLIFICATION — SEE docs/fleet-companion-simplification.md.
// The panel no longer picks a role, a module, or an order channel: those
// sections are gone for good, and the regression guards near the bottom of
// this file exist so they cannot quietly come back.
//
// What this panel can still get wrong is narrow but expensive, same shape as
// its siblings:
//
//   1. GATING ON THE WRONG THING. "In a fleet" is the one requirement the
//      ladder cannot resolve for itself, so it must actually block Start.
//      "Docked" is the companion's own first move, so it must NEVER block
//      Start — an advisory requirement that blocks is a launcher narrower
//      than the bot it launches.
//   2. Never showing internal vocabulary ("blocking", "cannot-tell") to the
//      player — it must always be translated into plain words.
//   3. The standing invariants — R7d (no visible numeric IDs), R9a (plain
//      player language), R8 (data-label on every cell of a reflow table).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { decodeFleetCenter } = await import("../bridge/fleetCenter.ts");
const FleetCompanion = (await import("./FleetCompanion.svelte")).default;
const { DEFAULT_COMPANION_SETUP } = await import("../nav/fleetCompanionLoop.ts");

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "FleetCompanion.svelte"), "utf8");

// Obviously synthetic ids throughout — nothing here was captured from a real
// account. 90000001-and-up mirrors ESI's own documented example CharacterID.
const CHARACTER_ID = 90000001;
const FLEET_ID = 90000010;
const SHIP_ID = 90000020;
const STATION_ID = 90000030;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function renderPanel(store: ReturnType<typeof createClientStore>): string {
  // ⚠ THE SETUP COMES FROM ABOVE NOW. The six limits are one answer for the
  // whole op, set in FleetCompanions.svelte, because adding a pilot there is
  // what starts it — this panel has no form of its own any more and must not
  // grow one back. The form's own tests moved to fleetCompanionsPanel.test.ts.
  return render(FleetCompanion as never, {
    props: { store, flow: fakeFlow(), setup: DEFAULT_COMPANION_SETUP },
  } as never).body;
}

function keyVal(entries: readonly (readonly [string, unknown])[]) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

const FLEET_READ_NAMES = [
  "GetInitState",
  "GetWings",
  "GetMotd",
  "GetJoinRequests",
  "GetFleetComposition",
] as const;

/** A fleet snapshot the pilot is genuinely a member of. */
function readyFleetSnapshot() {
  return decodeFleetCenter({
    ok: true,
    characterID: CHARACTER_ID,
    fleetID: null,
    reads: {
      GetInitState: {
        result: keyVal([
          ["motd", ""],
          ["fleetID", FLEET_ID],
          ["members", { type: "dict", entries: [] }],
          ["squads", { type: "dict", entries: [] }],
          ["wings", { type: "dict", entries: [] }],
        ]),
      },
      GetWings: { result: { type: "dict", entries: [] } },
      GetMotd: { result: "" },
      GetJoinRequests: { result: { type: "dict", entries: [] } },
      GetFleetComposition: { result: { type: "list", items: [] } },
    },
  } as never);
}

/** Every bound read explicitly answering FleetNotFound. */
function notInFleetSnapshot() {
  return decodeFleetCenter({
    ok: true,
    characterID: CHARACTER_ID,
    fleetID: null,
    reads: Object.fromEntries(
      FLEET_READ_NAMES.map((name) => [name, { error: "CALL_REFUSED", message: "FleetNotFound" }]),
    ),
  } as never);
}

function applyFleet(
  store: ReturnType<typeof createClientStore>,
  snapshot: ReturnType<typeof decodeFleetCenter>,
): void {
  store.apply({
    type: "fleet/loaded",
    ...snapshot,
    readError: snapshot.availability === "unavailable" ? "Fleet membership could not be read just now." : null,
    refreshedAtMs: 100,
  });
}

function applyFlight(
  store: ReturnType<typeof createClientStore>,
  options: { docked: boolean; inSpace: boolean },
): void {
  store.apply({
    type: "flight/status",
    status: {
      inSpace: options.inSpace,
      docked: options.docked,
      solarSystemID: 30000001,
      stationID: options.docked ? STATION_ID : null,
      structureID: null,
      shipID: SHIP_ID,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: null,
      shipSpeedFraction: null,
    },
  });
}

/** In a real fleet, in space. */
function readyStore(): ReturnType<typeof createClientStore> {
  const store = createClientStore();
  applyFleet(store, readyFleetSnapshot());
  applyFlight(store, { docked: false, inSpace: true });
  return store;
}

// --- 1. blocking vs advisory, and the gate that actually gates --------------

test("R18 — the panel renders against a completely empty store", () => {
  const body = renderPanel(createClientStore());
  assert.equal(typeof body, "string");
  assert.match(visibleText(body), /Fleet companion/);
});

test("not in a fleet: the blocking requirement says so, and Start is disabled", () => {
  const store = createClientStore();
  applyFleet(store, notInFleetSnapshot());
  applyFlight(store, { docked: false, inSpace: true });
  const body = renderPanel(store);
  const text = visibleText(body);
  assert.match(text, /Join a fleet first/i);
  assert.match(text, /\(required\)/);
  // The Start button itself must carry the disabled attribute.
  const startButton = body.match(/<button[^>]*class="primary"[^>]*>\s*Start\s*<\/button>/)?.[0] ?? "";
  assert.match(startButton, /disabled/, "Start must be disabled while the blocking requirement fails");
});

test("a fleet that could not be read is UNKNOWN, never reported as 'not in a fleet'", () => {
  // Nothing has loaded the fleet slice at all — its own default is "unknown",
  // not "not-in-fleet". Reporting the wrong one sends a player to fix a
  // problem they do not have.
  const store = createClientStore();
  applyFlight(store, { docked: false, inSpace: true });
  const text = visibleText(renderPanel(store));
  assert.match(text, /could not be read/i);
  assert.doesNotMatch(text, /Join a fleet first/i);
});

test("in a fleet and docked: the advisory requirement describes what will happen, and never blocks Start", () => {
  const store = createClientStore();
  applyFleet(store, readyFleetSnapshot());
  applyFlight(store, { docked: true, inSpace: false });
  const body = renderPanel(store);
  const text = visibleText(body);
  assert.match(text, /it will undock/i);
  assert.match(text, /\(worth knowing\)/);
  assert.doesNotMatch(text, /\(required\)/, "an advisory line must not read as required");
  const startButton = body.match(/<button[^>]*class="primary"[^>]*>\s*Start\s*<\/button>/)?.[0] ?? "";
  assert.doesNotMatch(
    startButton,
    /disabled/,
    "docked is the companion's own first move — it must never block Start",
  );
});

test("in a fleet and already out in space: both requirements read Ready", () => {
  const text = visibleText(renderPanel(readyStore()));
  assert.match(text, /Ready.*You are in a fleet/);
  assert.match(text, /Ready.*Your ship is out in space/);
});

// --- 2. the setup form only offers what nobody could derive -----------------

test("the setup form offers no control for anything the pilot derives itself", () => {
  // ⚠ THIS USED TO PIN THE PARAGRAPH THAT EXPLAINED ALL THAT, and the paragraph
  // is gone at the operator's call: a "What it uses" section whose every line
  // ended in "nothing here to switch on" is a page of settings that are not
  // settings. The RULE it was protecting is unchanged and is what is pinned
  // now — the fit and the order channels are read, never offered.
  const text = visibleText(renderPanel(readyStore()));
  assert.doesNotMatch(text, /What it uses/i);
  assert.doesNotMatch(text, /nothing here to switch on/i);
  const body = renderPanel(readyStore());
  for (const control of ["companion-role", "companion-module", "companion-order-source"]) {
    assert.doesNotMatch(body, new RegExp(control));
  }
});

test("Start flies the op's setup, exactly as handed down — nothing invented here", () => {
  // ⚠ THE PANEL NO LONGER BUILDS THE REQUEST, and that is the change. It passes
  // the op's `CompanionSetup` through untouched; the module lists that complete
  // a request are read off the hull by `flow.startFleetCompanion` at the moment
  // of the start, because an itemID picked in a panel is stale the moment
  // somebody refits.
  assert.match(SOURCE, /flow\.startFleetCompanion\(setup satisfies CompanionSetup\)/);
});

test("REGRESSION — the limits form does not grow back on the per-pilot panel", () => {
  // Two forms for one run is two answers to one question, of which only one
  // would ever reach the loop. The op's form lives in FleetCompanions.svelte.
  const body = renderPanel(readyStore());
  for (const control of [
    "companion-flee-floor",
    "companion-cap-floor",
    "companion-flee-attempts",
    "companion-drone-floor",
    "companion-drone-holdoff",
  ]) {
    assert.doesNotMatch(body, new RegExp(control), `${control} belongs to the op, not the pilot`);
  }
});

// --- 3. the readout, once running -------------------------------------------

function startedStore(): ReturnType<typeof createClientStore> {
  const store = readyStore();
  store.apply({ type: "companion/started", fitWarnings: [], startedAt: Date.now() });
  store.apply({
    type: "companion/progress",
    status: "running",
    phase: "Holding formation",
    action: "Wait",
    why: "Nothing has asked for anything yet.",
    inFleet: true,
    followingOrderFrom: "broadcast",
    lastOrderHeard: "Orbit the fleet commander",
    targetMode: "called",
    canTag: false,
    abandonment: null,
    failureReason: null,
    selfPaused: false,
  });
  return store;
}

test("the readout shows the WHY, which is the whole point of the panel", () => {
  const text = visibleText(renderPanel(startedStore()));
  assert.match(text, /Why:/);
  assert.match(text, /Nothing has asked for anything yet/);
});

test("the readout translates order source and the three-state canTag into player words", () => {
  const text = visibleText(renderPanel(startedStore()));
  assert.match(text, /a fleet broadcast/);
  assert.match(text, /Orbit the fleet commander/);
  // ⚠ A PLAIN MEMBER'S ROW SAYS WHAT IT DOES, NOT WHAT IT CANNOT DO. This
  // used to assert "no - not a fleet commander" against a pilot that calls its
  // targets out by broadcast perfectly well. See `canTagWords`.
  assert.match(text, /broadcasts targets/);
  assert.doesNotMatch(text, /not a fleet commander/);
});

test("canTag is three-state: null reads as 'not known', never as a settled method", () => {
  const store = startedStore();
  store.apply({
    type: "companion/progress",
    status: "running",
    phase: "Holding formation",
    action: "Wait",
    why: "Nothing has asked for anything yet.",
    inFleet: true,
    followingOrderFrom: null,
    lastOrderHeard: null,
    targetMode: "called",
    canTag: null,
    abandonment: null,
    failureReason: null,
    selfPaused: false,
  });
  const text = visibleText(renderPanel(store));
  assert.match(text, /Calls targets.*not known/);
  assert.doesNotMatch(text, /Calls targets.*(tags|broadcasts) targets/);
});

test("a start error is surfaced", () => {
  const store = readyStore();
  store.apply({ type: "companion/start-error", message: "Join a fleet first - a companion takes its orders from one." });
  const text = visibleText(renderPanel(store));
  assert.match(text, /Join a fleet first/);
});

test("a PAUSED companion still reads as holding the ship, with the standard paused note", () => {
  const store = startedStore();
  store.apply({
    type: "companion/progress",
    status: "paused",
    phase: "Holding formation",
    action: null,
    why: "You paused it.",
    inFleet: true,
    followingOrderFrom: null,
    lastOrderHeard: null,
    targetMode: "called",
    canTag: null,
    abandonment: null,
    failureReason: null,
    selfPaused: false,
  });
  const text = visibleText(renderPanel(store));
  assert.match(text, /Paused/);
  assert.match(text, /press Carry\s*on/i);
});

test("a failure reason is shown while running", () => {
  const store = readyStore();
  store.apply({ type: "companion/started", fitWarnings: [], startedAt: Date.now() });
  store.apply({
    type: "companion/progress",
    status: "error",
    phase: null,
    action: null,
    why: null,
    inFleet: null,
    followingOrderFrom: null,
    lastOrderHeard: null,
    targetMode: "called",
    canTag: null,
    abandonment: null,
    failureReason: "The fleet roster could not be read.",
    selfPaused: false,
  });
  // status "error" is not active, so this renders the SET-UP view's own
  // "last time it stopped" line.
  const text = visibleText(renderPanel(store));
  assert.match(text, /Last time it stopped/);
  assert.match(text, /fleet roster could not be read/);
});

// --- 4. regression guards: the deleted controls must not come back ---------

test("REGRESSION — no module-picking control renders anywhere in the panel", () => {
  for (const store of [readyStore(), startedStore()]) {
    const body = renderPanel(store);
    assert.doesNotMatch(body, /companion-role/, "the role picker must not come back");
    assert.doesNotMatch(body, /<h3>Defensive equipment<\/h3>/i);
    assert.doesNotMatch(body, /<h3>Self repair<\/h3>/i);
    assert.doesNotMatch(body, /<h3>Remote repair<\/h3>/i);
    assert.doesNotMatch(body, /<h3>Weapons<\/h3>/i);
    assert.doesNotMatch(body, /<h3>Target tagging<\/h3>/i);
    assert.doesNotMatch(body, /Nothing powered up/i, "there is no equipment list left to be empty");
  }
});

test("REGRESSION — no channel toggle renders anywhere in the panel", () => {
  for (const store of [readyStore(), startedStore()]) {
    const body = renderPanel(store);
    assert.doesNotMatch(body, /What it listens to/i);
    assert.doesNotMatch(body, /Fleet broadcasts/);
    assert.doesNotMatch(body, /Local chat commands/);
    assert.doesNotMatch(body, /The squad board/i);
    assert.doesNotMatch(body, /companion-chat-senders/);
    assert.doesNotMatch(body, /Use drones to defend itself/i);
  }
});

test("REGRESSION — the safe-spot bookmark picker is gone, and nothing replaced it", () => {
  // The picker asked a player to choose where a fleeing pilot should hide. The
  // loop answers that itself (a station, or this system's star when there is
  // none in reach), so there was nothing left to pick.
  //
  // ⚠ THE PANEL NO LONGER SAYS SO EITHER, and that is deliberate: a sentence
  // about a fallback with no control attached is a sentence a player reads once
  // and looks past forever after. What must not come back is the CONTROL.
  const text = visibleText(renderPanel(readyStore()));
  assert.doesNotMatch(text, /companion-safe-spot/);
  assert.doesNotMatch(text, /nowhere - stop and say so/i);
});

// --- 5. the standing invariants ---------------------------------------------

test("R7d — no numeric id reaches the player, running or not", () => {
  for (const store of [readyStore(), startedStore()]) {
    const text = visibleText(renderPanel(store));
    for (const id of [CHARACTER_ID, FLEET_ID, SHIP_ID, STATION_ID]) {
      assert.equal(text.includes(String(id)), false, `numeric id leaked: ${id}`);
    }
  }
});

test("R9a — no raw vocabulary reaches the player", () => {
  const text = visibleText(renderPanel(readyStore()));
  for (const raw of [
    "blocking",
    "advisory",
    "cannot-tell",
    "not-met",
    "FleetCompanionRunState",
    "followingOrderFrom",
    "defenseModuleIDs",
    "useDrones",
    "attemptsTagging",
    "obeys",
    "safeSpotBookmarkID",
  ]) {
    assert.equal(text.includes(raw), false, `raw vocabulary leaked: ${raw}`);
  }
  const running = visibleText(renderPanel(startedStore()));
  for (const raw of ["own-ladder", "squad-board", "CALL_REFUSED"]) {
    assert.equal(running.includes(raw), false, `raw vocabulary leaked: ${raw}`);
  }
});

test("R8 — every cell of the readout table carries a data-label", () => {
  const body = renderPanel(startedStore());
  const cells = body.match(/<td[^>]*>/g) ?? [];
  assert.ok(cells.length > 0, "the running readout must render its table");
  for (const cell of cells) {
    assert.match(cell, /data-label=/, `every <td> needs a data-label: ${cell}`);
  }
});

test("plain ASCII only — no decorative non-ASCII character reaches the player", () => {
  for (const store of [createClientStore(), readyStore(), startedStore()]) {
    const text = visibleText(renderPanel(store));
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      assert.ok(
        code < 128,
        `non-ASCII character in player-facing text: ${JSON.stringify(ch)} (U+${code.toString(16)})`,
      );
    }
  }
});

test("R43 — the launcher's checklist and this panel's checklist both come from FLEET_COMPANION_REQUIREMENTS", () => {
  assert.match(SOURCE, /FLEET_COMPANION_REQUIREMENTS/);
  assert.match(SOURCE, /evaluateRequirements/);
});
