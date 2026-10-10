// R25 as it actually RENDERS: the Drones section, and the threat block that
// makes a pirate impossible to miss.
//
// Two claims are load-bearing and both are checked against real rendered
// output rather than asserted in prose:
//
//   1. LAUNCHING IS THE DEFENCE. The server auto-engages idle combat drones
//      against whatever shoots the ship, so a miner who launches is defended
//      with no further clicks. A player who does not know that will sit there
//      clicking, so the panel has to SAY it.
//
//   2. "WE COULD NOT LOOK" IS NOT "NOTHING IS OUT THERE". A null drone list
//      must never render as an empty bay or an empty sky — that is what invites
//      a player to launch a second flight on top of the one already flying.
//
// The standing invariants are re-proven on the new markup: R7d (no visible
// numeric IDs), R9a (plain player language — "Pirate", never a runtime entity
// kind), R8 (real buttons).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const SpaceOverview = (await import("./SpaceOverview.svelte")).default;
const DronesPanel = (await import("./DronesPanel.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "SpaceOverview.svelte"), "utf8");
const DRONES_SOURCE = readFileSync(path.join(UI_DIR, "DronesPanel.svelte"), "utf8");

const SHIP_ID = 9001;
const CHARACTER_ID = 7;
const DRONE_TYPE_ID = 2456;
const BAY_DRONE_ID = 7800001;
const SPACE_DRONE_ID = 9500001;
const RAT_ID = 50002001;
const ROCK_ID = 50001248;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

/** Everything a player can see, with markup and comments stripped. */
function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

interface SceneOptions {
  readonly bay?: { itemID: number; typeID: number; quantity: number }[] | null;
  readonly inSpace?:
    | {
        itemID: number;
        typeID: number | null;
        name: string | null;
        activity: string | null;
        targetID: number | null;
        shieldRatio: number | null;
        armorRatio: number | null;
        hullRatio: number | null;
      }[]
    | null;
  readonly maxActiveDrones?: number | null;
  readonly droneBandwidth?: number | null;
  readonly hostiles?: { itemID: number; name: string; npcEntityType: string | null }[];
  readonly players?: { itemID: number; name: string }[];
  /**
   * R33 — the SNAPSHOT rows for drones, which is where `controllerID` lives.
   *
   * ⚠ SEPARATE FROM `inSpace` ON PURPOSE, because the two really are separate
   * on the wire and the gap between them is the whole defect. `inSpace` is the
   * BFF's drone list (owner OR controller); the snapshot is what carries the
   * controller field. A case that supplies `inSpace` and NO snapshot row is the
   * honest "we cannot tell" case, and it must leave the control alone.
   */
  readonly droneEntities?: {
    itemID: number;
    name: string;
    controllerID: number | null;
    ownerID?: number | null;
  }[];
  readonly loadDrones?: boolean;
  readonly shieldRatio?: number;
  /**
   * R34 — the per-drone reasons the SERVER gave for the last order.
   *
   * ⚠ THE SHAPE ITSELF IS AN ASSERTION. There is no droneID in it, because
   * `flow.ts` spends that key on a name lookup and the report type has no id
   * field for the panel to render. A test cannot leak what the type cannot
   * carry — which is the strongest form the R7d guarantee can take here.
   */
  readonly orderReports?: { label: string | null; text: string }[];
}

function spaceRow(over: Record<string, unknown> & { itemID: number }): unknown {
  return {
    kind: "ship",
    typeID: 606,
    groupID: 25,
    categoryID: 6,
    name: null,
    ownerID: null,
    radius: 30,
    position: { x: 2000, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    isSelf: false,
    shieldRatio: null,
    armorRatio: null,
    hullRatio: null,
    characterID: null,
    corporationID: null,
    allianceID: null,
    securityStatus: null,
    maxVelocity: null,
    mode: null,
    capacitorRatio: null,
    remainingQuantity: null,
    miningYieldTypeID: null,
    beltID: null,
    oreGrade: null,
    isNpc: false,
    npcEntityType: null,
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...over,
  };
}

/** The panel in space, with whatever drones and hostiles the case needs. */
/** The store the scene describes — shared by both renderers below. */
function sceneStore(options: SceneOptions = {}) {
  const store = createClientStore();
  const entities: unknown[] = [];
  for (const hostile of options.hostiles ?? []) {
    entities.push(
      spaceRow({
        itemID: hostile.itemID,
        name: hostile.name,
        isNpc: true,
        npcEntityType: hostile.npcEntityType,
      }),
    );
  }
  for (const player of options.players ?? []) {
    entities.push(
      spaceRow({ itemID: player.itemID, name: player.name, characterID: 90000042 }),
    );
  }
  for (const drone of options.droneEntities ?? []) {
    entities.push(
      spaceRow({
        itemID: drone.itemID,
        kind: "drone",
        typeID: DRONE_TYPE_ID,
        name: drone.name,
        ownerID: drone.ownerID === undefined ? CHARACTER_ID : drone.ownerID,
        controllerID: drone.controllerID,
        droneActivity: "idle",
      }),
    );
  }
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: 30000142,
      shipID: SHIP_ID,
      sampledAtMs: 1,
      entities: entities as never,
      ship: {
        itemID: SHIP_ID,
        typeID: 24700,
        name: "Test Pilot's ship",
        mode: "STOP",
        maxVelocity: 300,
        radius: 30,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        shieldRatio: options.shieldRatio ?? 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        shieldCapacity: 3000,
        armorCapacity: 3000,
        hullCapacity: 3000,
        activeModuleIDs: [],
        overloadedModuleIDs: [],
        moduleDamage: {},
        weaponBanks: {},
      },
    },
  } as never);
  if (options.loadDrones !== false) {
    store.apply({
      type: "drones/loaded",
      bay: options.bay === undefined ? [] : options.bay,
      inSpace: options.inSpace === undefined ? [] : options.inSpace,
      limits: {
        // `undefined` means "the case did not care"; an explicit `null` is the
        // case being tested (a limit the ship did not report).
        maxActiveDrones: options.maxActiveDrones === undefined ? 5 : options.maxActiveDrones,
        droneBandwidth: options.droneBandwidth === undefined ? 50 : options.droneBandwidth,
      },
    } as never);
  }
  if (options.orderReports !== undefined) {
    store.apply({ type: "drones/order-reports", reports: options.orderReports } as never);
  }
  // Names the panel resolves by typeID (R7d — nothing numeric is rendered).
  store.apply({
    type: "names/resolved",
    resolved: { [`type:${DRONE_TYPE_ID}`]: "Hobgoblin I" },
  } as never);
  return store;
}

/**
 * The scene as the OVERVIEW PANEL renders it — the threat strip's home.
 *
 * ⚠ IT USED TO BE THE COCKPIT, AND THE COCKPIT IS GONE. The threat claims below
 * are the originals; only the wording they match moved with the panel, because
 * the redesign says "N hostiles on grid" where the cockpit said "Hostiles
 * nearby". What must not change is WHICH things are called threats.
 */
function scene(options: SceneOptions = {}): string {
  return render(SpaceOverview, {
    props: { store: sceneStore(options), flow: fakeFlow() },
  }).body;
}

/**
 * The same scene, rendered through the DRONES WINDOW.
 *
 * ⚠ THE DRONE CLAIMS BELOW MOVED HERE, ONE FOR ONE, WHEN THE SECTION BECAME A
 * WINDOW — every assertion is the one that was made against the cockpit, and it
 * is made against the new component unchanged. That is the whole point: a lift
 * proves itself by the old suite passing against the new home, not by a new
 * suite written to fit whatever was built.
 *
 * The threat-block tests still render `Overview` (`scene` above), because the
 * threat strip's new home is `SpaceOverview` and it is re-anchored there when
 * the cockpit is deleted.
 */
function droneScene(options: SceneOptions = {}): string {
  const store = sceneStore(options);
  return render(DronesPanel, {
    props: { store, flow: fakeFlow() },
  }).body;
}

const A_SPACE_DRONE = {
  itemID: SPACE_DRONE_ID,
  typeID: DRONE_TYPE_ID,
  name: "Hobgoblin I",
  activity: "idle",
  targetID: null,
  shieldRatio: 1,
  armorRatio: 1,
  hullRatio: 1,
  controlled: true,
};

/** The same drone, orphaned: owned by this character, flown by no hull of theirs. */
const AN_ORPHANED_DRONE = { ...A_SPACE_DRONE, controlled: false };

// --- The Drones section ------------------------------------------------------

test("⚠ THE PANEL EXPLAINS NOTHING — no paragraph on how drones work", () => {
  // ⚠ THIS TEST USED TO ASSERT THE OPPOSITE, AND THE REVERSAL IS THE
  // OPERATOR'S CALL: "UI is not a place to explain how drones work".
  //
  // It read "the panel says LAUNCHING is the defence, in a player's words", and
  // pinned two sentences telling the player that launched drones auto-engage
  // whatever shoots them. The fact is true and still worth knowing — a panel is
  // not where someone learns it, and a paragraph a player reads once is a
  // paragraph they read past forever afterwards.
  //
  // What must NOT come back is prose about the game's rules. What stays is
  // state and refusals, and the two tests below hold those.
  const text = visibleText(droneScene({ inSpace: [A_SPACE_DRONE] }));
  for (const prose of [
    "defend you on their own",
    "without you doing anything else",
    "Use Attack to pick a target",
    "call them back",
  ]) {
    assert.equal(text.includes(prose), false, `the panel explains again: "${prose}"`);
  }
});

test("what SURVIVED the cull is state and refusals, not prose", () => {
  // The distinction that decides what a panel may say. The server's limits are
  // a reading; "Lock something first" is why a button will not do anything, and
  // R30 puts that ON the button rather than in a line underneath it.
  const text = visibleText(droneScene({ inSpace: [A_SPACE_DRONE], maxActiveDrones: 5 }));
  assert.match(text, /Drones at once/, "the server's own limit is state, and stays");
  const body = droneScene({ inSpace: [A_SPACE_DRONE] });
  assert.match(body, /<button[^>]*disabled[^>]*>[\s\S]{0,60}Lock something first/);
  // ...and never as a paragraph under the controls again.
  assert.equal(
    /class="note">Lock something first/.test(body),
    false,
    "the reason went back to being a note instead of the button's own words",
  );
});

test("the bay and what is in space are shown SEPARATELY, both by name", () => {
  const text = visibleText(
    droneScene({
      bay: [{ itemID: BAY_DRONE_ID, typeID: DRONE_TYPE_ID, quantity: 1 }],
      inSpace: [A_SPACE_DRONE],
    }),
  );
  assert.match(text, /In space/);
  assert.match(text, /In the bay/);
  // R7d: the drone reads as its NAME, and neither its itemID nor its typeID
  // appears anywhere a player can see.
  assert.match(text, /Hobgoblin I/);
  assert.doesNotMatch(text, new RegExp(String(BAY_DRONE_ID)));
  assert.doesNotMatch(text, new RegExp(String(SPACE_DRONE_ID)));
  assert.doesNotMatch(text, new RegExp(String(DRONE_TYPE_ID)));
});

test("a drone in space says WHAT IT IS DOING, and names what it is doing it to", () => {
  const text = visibleText(
    droneScene({
      inSpace: [{ ...A_SPACE_DRONE, activity: "fighting", targetID: RAT_ID }],
      hostiles: [{ itemID: RAT_ID, name: "Serpentis Scout", npcEntityType: "npc" }],
    }),
  );
  assert.match(text, /Attacking/);
  // The target by NAME, never by id.
  assert.match(text, /Serpentis Scout/);
  assert.doesNotMatch(text, new RegExp(String(RAT_ID)));
});

test("an activity the gateway could not read says Unknown — never Waiting", () => {
  // A player told their drones are idle when nobody looked will not launch the
  // ones that would have saved them.
  const text = visibleText(droneScene({ inSpace: [{ ...A_SPACE_DRONE, activity: null }] }));
  assert.match(text, /Unknown/);
});

test("⚠ a FAILED read renders as 'could not be read', never as 'none out'", () => {
  const text = visibleText(droneScene({ bay: null, inSpace: null }));
  assert.match(text, /drones in space could not be read/i);
  assert.match(text, /drone bay could not be read/i);
  // The empty-state wording must NOT appear: it would invite a second launch.
  assert.doesNotMatch(text, /No drones out\./);
  assert.doesNotMatch(text, /Nothing in the drone bay\./);
});

test("a genuinely empty bay and sky say so plainly", () => {
  const text = visibleText(droneScene({ bay: [], inSpace: [] }));
  assert.match(text, /No drones out\./);
  assert.match(text, /Nothing in the drone bay\./);
});

test("the server's limits are SHOWN, and unknown reads as unknown", () => {
  const shown = visibleText(droneScene({ inSpace: [A_SPACE_DRONE], maxActiveDrones: 5, droneBandwidth: 50 }));
  assert.match(shown, /Drones at once:\s*1 of 5/);
  assert.match(shown, /Bandwidth:\s*50 Mbit\/sec/);

  // ⚠ null is "not known" — a hull with no drone bay and a read that failed
  // look identical from here, and neither may be shown as a hard zero.
  const unknown = visibleText(droneScene({ maxActiveDrones: null, droneBandwidth: null }));
  assert.match(unknown, /Drones at once: not known/);
  assert.match(unknown, /Bandwidth: not known/);
  assert.doesNotMatch(unknown, /Drones at once:\s*\d+ of 0/);
});

// --- The threat block --------------------------------------------------------

test("a pirate is called a Pirate, and a player ship gets no badge", () => {
  const text = visibleText(
    scene({
      hostiles: [{ itemID: RAT_ID, name: "Serpentis Scout", npcEntityType: "npc" }],
      players: [{ itemID: 60001, name: "Some Pilot" }],
    }),
  );
  assert.match(text, /hostiles? on grid/i);
  // R9a: the word a player uses. Never "NPC entity kind", never "nativeNpc".
  assert.match(text, /Pirate/);
  assert.doesNotMatch(text, /nativeNpc|npcEntityType|NPC entity/i);
  // R7d: the rat is named, its itemID is not shown.
  assert.match(text, /Serpentis Scout/);
  assert.doesNotMatch(text, new RegExp(String(RAT_ID)));
});

test("police and drifters are labelled honestly — and only threats are listed", () => {
  const police = visibleText(
    scene({ hostiles: [{ itemID: 60002, name: "CONCORD Police", npcEntityType: "concord" }] }),
  );
  // Law enforcement is an NPC that does not shoot a miner. Painting it as a
  // threat would make the colour meaningless.
  assert.doesNotMatch(police, /hostiles? on grid/i);

  const drifter = visibleText(
    scene({ hostiles: [{ itemID: 60003, name: "Drifter Battleship", npcEntityType: "drifter" }] }),
  );
  assert.match(drifter, /hostiles? on grid/i);
  assert.match(drifter, /Drifter/);
});

test("with nothing hostile around, no threat block is rendered at all", () => {
  const text = visibleText(scene({ players: [{ itemID: 60004, name: "Some Pilot" }] }));
  assert.doesNotMatch(text, /hostiles? on grid/i);
  assert.doesNotMatch(text, /You are taking damage/);
});

test("the threat badge is a WORD, so colour is never the only signal", () => {
  // A player who cannot distinguish the red still reads "Pirate".
  const body = scene({
    hostiles: [{ itemID: RAT_ID, name: "Serpentis Scout", npcEntityType: "npc" }],
  });
  assert.match(body, /class="spc-threat-kind"[^>]*>\s*Pirate/);
});

test("a hostile is marked in the ordinary overview list too", () => {
  // Rocks and rats are always in the overview list, so a rat shows both in the
  // loud threat strip AND as a marked row in the list a player is reading.
  //
  // ⚠ THIS CAUGHT A REAL LOSS WHEN IT WAS RE-POINTED AT THE NEW PANEL. The
  // redesign had dropped the row marking entirely — and the strip is capped at
  // six, so a hostile outside the top six had become invisible in the one place
  // a miner actually looks.
  const body = scene({
    hostiles: [{ itemID: RAT_ID, name: "Serpentis Scout", npcEntityType: "npc" }],
  });
  assert.match(body, /class="spc-name hostile"/, "the row does not mark the hostile");
  // And it carries the WORD, so the colour is never the only signal.
  assert.match(body, /class="spc-row-badge">Pirate</);
});

// --- Source-level guarantees -------------------------------------------------

test("threats are read from the SNAPSHOT, not from the filtered overview rows", () => {
  // ⚠ The overview is searchable, filterable and capped at 200 rows. A miner
  // who searched for "Veldspar" while mining would have filtered away the thing
  // shooting them, so the threat list must never be derived from it.
  assert.match(SOURCE, /hostileRows\(snapshot, origin\)/);
  assert.doesNotMatch(SOURCE, /hostileRows\(overview/);
});

test("the panel calls one flow method per drone verb, and no others", () => {
  // ⚠ THE COUNTS MOVED WITH THE MARKUP, and one of them CHANGED — deliberately.
  //
  // In the cockpit, Engage had two call sites: one on a threat row ("send drones
  // at this pirate") and one on the locked target. The threat rows went to
  // `SpaceOverview`, which does not command drones, so the window has one. That
  // is a capability question, not a bookkeeping one, and it is written down
  // here rather than absorbed into a smaller number: sending drones straight
  // from a threat row is a thing the cockpit could do and the window cannot.
  const callSites: Readonly<Record<string, number>> = {
    // Launch appears twice on purpose: per-stack, and for the picked set.
    "flow.launchDrones(": 2,
    "flow.engageDrones(": 1,
    "flow.mineWithDrones(": 1,
    // Recall appears twice: one drone, and all of them.
    "flow.recallDrones(": 2,
    // Recovery for a drone this hull does not fly — one each.
    "flow.reconnectDrones(": 1,
    "flow.scoopDrones(": 1,
  };
  for (const [call, expected] of Object.entries(callSites)) {
    assert.equal(
      DRONES_SOURCE.split(call).length - 1,
      expected,
      `${call} must have exactly ${expected} call site(s)`,
    );
  }
  // ⚠ The verbs with NO server handler (CmdAssist / CmdGuard / CmdUnanchor) and
  // the one that permanently disowns drones (CmdAbandonDrone) must not appear
  // anywhere in this panel.
  for (const forbidden of ["assistDrones", "guardDrones", "abandonDrone", "unanchor"]) {
    assert.doesNotMatch(DRONES_SOURCE, new RegExp(forbidden, "i"), `${forbidden} must not exist`);
  }
});

test("R8: every drone and threat control is a real button", () => {
  // ⚠ TWO RENDERS, BECAUSE THE CONTROLS LIVE IN TWO PANELS NOW. The drone verbs
  // are the drones window's; Lock and Send drones are the threat strip's. One
  // render could only have covered whichever half happened to be in the file
  // this test still pointed at.
  const drones = droneScene({
    bay: [{ itemID: BAY_DRONE_ID, typeID: DRONE_TYPE_ID, quantity: 1 }],
    inSpace: [A_SPACE_DRONE],
  });
  const threats = scene({
    inSpace: [A_SPACE_DRONE],
    droneEntities: [{ itemID: SPACE_DRONE_ID, name: "Hobgoblin I", controllerID: SHIP_ID }],
    hostiles: [{ itemID: RAT_ID, name: "Serpentis Scout", npcEntityType: "npc" }],
  });
  for (const [body, label] of [
    [drones, "Launch"],
    [drones, "Bring home"],
    [drones, "Bring them all home"],
    [threats, "Send drones"],
    [threats, "Lock"],
  ] as const) {
    assert.match(
      body,
      new RegExp("<button[^>]*>[\s\S]{0,80}" + label),
      `"${label}" must be a real button`,
    );
  }
});

test("R7d: no numeric ID reaches the rendered drone or threat markup", () => {
  const text = visibleText(
    scene({
      bay: [{ itemID: BAY_DRONE_ID, typeID: DRONE_TYPE_ID, quantity: 1 }],
      inSpace: [{ ...A_SPACE_DRONE, activity: "mining", targetID: ROCK_ID }],
      hostiles: [{ itemID: RAT_ID, name: "Serpentis Scout", npcEntityType: "npc" }],
    }),
  );
  for (const id of [BAY_DRONE_ID, SPACE_DRONE_ID, RAT_ID, ROCK_ID, DRONE_TYPE_ID, SHIP_ID, CHARACTER_ID]) {
    assert.doesNotMatch(
      text,
      new RegExp(`\\b${id}\\b`),
      `the id ${id} must never be visible to a player`,
    );
  }
});

// --- R33: a control that cannot work must not look like one -----------------
//
// THE CASE, MEASURED LIVE, NOT IMAGINED. An abandoned `Ice Harvesting Drone II`
// (`controllerID: null`) was left in Perimeter II - Asteroid Belt 1.
// `entity.CmdReturnBay` on it answers 200, and the drone does not move — the
// ninth confirmed silent decline on this server. eve.js DOES refuse it, with a
// reason ("That drone is not currently under this ship's control."), but the
// reason is an entry in the call RESULT dict and the BFF forwards only
// `notifications`, so nothing whatsoever reaches the player.
//
// So R31 cannot save this one: there is no refusal to render. The client has to
// see it coming, and it can — `controllerID` is decoded and sitting there.
//
// ⚠ THE OTHER HALF OF THE RULE IS TESTED JUST AS HARD. Where the client CANNOT
// source the reason it must leave the control alone. Three of the tests below
// exist only to stop this fix over-correcting into a guess.

const ABANDONED_DRONE_ID = 9500002;
const OTHER_SHIPS_DRONE_ID = 9500003;

/** The live fixture: mine by ownership, flown by nobody. */
const AN_ABANDONED_DRONE = {
  itemID: ABANDONED_DRONE_ID,
  typeID: DRONE_TYPE_ID,
  name: "Ice Harvesting Drone II",
  activity: "idle",
  targetID: null,
  shieldRatio: 0,
  armorRatio: 0.25,
  hullRatio: 1,
};

test("R33: a drone this ship does not fly renders DISABLED, wearing the reason", () => {
  const body = droneScene({
    inSpace: [AN_ABANDONED_DRONE],
    droneEntities: [
      { itemID: ABANDONED_DRONE_ID, name: "Ice Harvesting Drone II", controllerID: null },
    ],
  });
  // The reason is the LABEL, not a tooltip. A `title` alone is invisible on a
  // touch screen and only arrives after the press on every other device.
  assert.match(visibleText(body), /Your ship is not flying this drone/);
  assert.match(
    body,
    /<button[^>]*disabled[^>]*>[\s\S]{0,120}Your ship is not flying this drone/,
    "the control must be disabled, not merely captioned",
  );
  // And it must NOT still be offering the action it cannot perform.
  //
  // ⚠ Scoped to the BUTTON, not to the page text: the panel's standing help
  // note ("…or Bring home to call them back") names the verb in prose, and that
  // sentence describes the feature rather than promising this drone.
  assert.doesNotMatch(
    body,
    /<button[^>]*>[\s\S]{0,80}Bring home\s*<\/button>/,
    "no live Bring home control may survive for a drone we cannot order",
  );
});

test("R33: the drone is still LISTED, by name — honest is not hidden", () => {
  // Removing the row would be a different lie: the drone is really out there,
  // it is really yours, and a panel that hides it invites a player to wonder
  // where it went.
  const text = visibleText(
    droneScene({
      inSpace: [AN_ABANDONED_DRONE],
      droneEntities: [
        { itemID: ABANDONED_DRONE_ID, name: "Ice Harvesting Drone II", controllerID: null },
      ],
    }),
  );
  assert.match(text, /Ice Harvesting Drone II/);
  assert.match(text, /1 out/, "it still counts as a drone in space");
});

test("R33: the gate is THIS HULL, not merely 'has a controller'", () => {
  // A drone under ANOTHER ship's control fails eve.js's check exactly as an
  // abandoned one does. A `controllerID !== null` test would wave it through.
  const body = droneScene({
    inSpace: [{ ...AN_ABANDONED_DRONE, itemID: OTHER_SHIPS_DRONE_ID, name: "Someone's Warrior" }],
    droneEntities: [
      { itemID: OTHER_SHIPS_DRONE_ID, name: "Someone's Warrior", controllerID: SHIP_ID + 1 },
    ],
  });
  assert.match(visibleText(body), /Your ship is not flying this drone/);
});

test("R33: a drone this ship DOES fly is untouched", () => {
  const body = droneScene({
    inSpace: [A_SPACE_DRONE],
    droneEntities: [{ itemID: SPACE_DRONE_ID, name: "Hobgoblin I", controllerID: SHIP_ID }],
  });
  assert.match(visibleText(body), /Bring home/);
  assert.doesNotMatch(visibleText(body), /Your ship is not flying/);
  assert.match(
    body,
    /<button(?![^>]*disabled)[^>]*>[\s\S]{0,80}Bring home/,
    "a drone we DO control must keep a live button",
  );
});

test("R33: capability is NOT removed — one dead drone does not disable the flight", () => {
  // The rule that matters most. A mixed flight must still recall everything it
  // legitimately can; disabling the group because one drone is unreachable
  // would cost a player the drones they still own.
  const body = droneScene({
    inSpace: [A_SPACE_DRONE, AN_ABANDONED_DRONE],
    droneEntities: [
      { itemID: SPACE_DRONE_ID, name: "Hobgoblin I", controllerID: SHIP_ID },
      { itemID: ABANDONED_DRONE_ID, name: "Ice Harvesting Drone II", controllerID: null },
    ],
  });
  const text = visibleText(body);
  // The group verbs are still offered, and still say what they do.
  assert.match(text, /Bring them all home/);
  assert.doesNotMatch(text, /Your ship is not flying any of these drones/);
  assert.match(
    body,
    /<button(?![^>]*disabled)[^>]*>[\s\S]{0,80}Bring them all home/,
    "the group order must stay live for the drones it can reach",
  );
  // And the dead one still says its piece, in the same panel.
  assert.match(text, /Your ship is not flying this drone/);
});

test("R33: when NOT ONE drone is ours to fly, the group order says so too", () => {
  const body = droneScene({
    inSpace: [AN_ABANDONED_DRONE],
    droneEntities: [
      { itemID: ABANDONED_DRONE_ID, name: "Ice Harvesting Drone II", controllerID: null },
    ],
  });
  assert.match(visibleText(body), /Your ship is not flying any of these drones/);
  assert.doesNotMatch(visibleText(body), /Bring them all home/);
});

// --- R33, the other side of the line: DO NOT GUESS --------------------------

test("R33: a drone the snapshot does not carry keeps its LIVE button", () => {
  // ⚠ THIS IS THE ANTI-OVER-CORRECTION TEST. `inSpace` lists the drone; the
  // snapshot has no row for it, so `controllerID` is not merely null — it is
  // UNKNOWN. A disabled button here would assert a reason we cannot source,
  // which is a worse failure than an enabled one that gets a real answer.
  const body = droneScene({ inSpace: [A_SPACE_DRONE] });
  assert.match(visibleText(body), /Bring home/);
  assert.doesNotMatch(visibleText(body), /Your ship is not flying/);
  assert.match(
    body,
    /<button(?![^>]*disabled)[^>]*>[\s\S]{0,80}Bring home/,
    "unknown must leave the control alone",
  );
});

test("R33: an unknown drone is still included in the GROUP order", () => {
  // The same rule, applied to the list the group buttons send: "we could not
  // check" must not quietly shrink what a group order acts on.
  const body = droneScene({
    inSpace: [A_SPACE_DRONE, AN_ABANDONED_DRONE],
    droneEntities: [
      // Only the abandoned one has a snapshot row; A_SPACE_DRONE is unknown.
      { itemID: ABANDONED_DRONE_ID, name: "Ice Harvesting Drone II", controllerID: null },
    ],
  });
  assert.match(
    body,
    /<button(?![^>]*disabled)[^>]*>[\s\S]{0,80}Bring them all home/,
    "the unknown drone keeps the group order live",
  );
});

test("R33: R9a — the reason is a sentence, and names no id and no remedy we lack", () => {
  const text = visibleText(
    droneScene({
      inSpace: [AN_ABANDONED_DRONE],
      droneEntities: [
        { itemID: ABANDONED_DRONE_ID, name: "Ice Harvesting Drone II", controllerID: null },
      ],
    }),
  );
  assert.doesNotMatch(text, /controllerID|CmdReturnBay|CALL_REFUSED|null/i);
  for (const id of [ABANDONED_DRONE_ID, SHIP_ID, CHARACTER_ID, DRONE_TYPE_ID]) {
    // ⚠ `\\b`, NOT `\b`. In a template literal `\b` is the BACKSPACE character,
    // so this assertion — and two more like it in overviewActions.test.ts —
    // searched rendered text for a control code and could never fail. R34 fixed
    // all three rather than adding a fourth, because a vacuous R7d sweep is
    // worse than none: it reads as proof.
    assert.doesNotMatch(text, new RegExp(`\\b${id}\\b`), `id ${id} leaked to the player`);
  }
  // ⚠ NO INVENTED REMEDY. Regaining control is `CmdReconnectToDrones`, which is
  // NOT in the gateway's allowlist — this client cannot dispatch it, so the
  // sentence must not send a player looking for a button that is not there.
  assert.doesNotMatch(text, /reconnect|regain control|take control/i);
});

// --- R34: the reason the SERVER wrote, per drone ----------------------------
//
// R33 predicted one refusal because the BFF was throwing the server's own
// answer away. R34 stopped throwing it away, and these tests are about the
// difference between the two — which is not cosmetic:
//
//   R33's PREDICTION fires BEFORE a call, on a control the client can already
//   tell will fail. It is a button LABEL and its job is to stop a press that
//   would go nowhere. It covers exactly ONE of the thirteen cases.
//
//   R34's SENTENCE arrives AFTER a call the server actually refused. It is the
//   server's own words, per drone, and it covers all thirteen — including the
//   twelve no client could ever predict.
//
// They cannot contradict each other because they cannot both describe the same
// event: a control R33 disables is never pressed, so the server is never asked
// and there is no sentence to conflict with. The tests below pin that, and pin
// that where the server HAS spoken it is the server that is quoted.

/** The exact bytes the emulator sent for the abandoned drone (R33's capture). */
const SERVERS_OWN_SENTENCE = "That drone is not currently under this ship's control.";
/** R33's client-side prediction of the same fact, worded for a button. */
const R33_PREDICTION = "Your ship is not flying this drone";

test("R34: the server's sentence reaches the player VERBATIM, next to the drone's name", () => {
  const text = visibleText(
    droneScene({
      inSpace: [A_SPACE_DRONE],
      orderReports: [{ label: "Hobgoblin I", text: SERVERS_OWN_SENTENCE }],
    }),
  );
  // Not paraphrased, not truncated, not wrapped in our own framing.
  assert.match(text, new RegExp(SERVERS_OWN_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Attributed to a drone BY NAME.
  assert.match(text, /Hobgoblin I/);
});

test("R34: the server's sentence is what is quoted — NOT R33's prediction", () => {
  // ⚠ THE ORDERING RULE. Where both mechanisms have something to say about the
  // same fact, the authority wins: the server's wording is the server's rule,
  // and ours can drift from it. R33's phrasing must not appear in a report.
  const text = visibleText(
    droneScene({
      inSpace: [AN_ABANDONED_DRONE],
      orderReports: [{ label: "Ice Harvesting Drone II", text: SERVERS_OWN_SENTENCE }],
    }),
  );
  assert.match(text, new RegExp(SERVERS_OWN_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const reportRegion = text.slice(text.indexOf("Drones"), text.indexOf("In space"));
  assert.equal(
    reportRegion.includes(R33_PREDICTION),
    false,
    "a received refusal must be quoted from the server, never re-worded as the prediction",
  );
});

test("R34: R33's prediction still does its own job — disabling a control up front", () => {
  // The two mechanisms coexist. With NO server report at all, the abandoned
  // drone's button is still disabled wearing the predicted reason, because
  // nothing has been pressed and there is nothing for the server to have said.
  const body = droneScene({
    inSpace: [AN_ABANDONED_DRONE],
    droneEntities: [
      { itemID: ABANDONED_DRONE_ID, name: "Ice Harvesting Drone II", controllerID: null },
    ],
  });
  assert.match(
    body,
    new RegExp(`<button[^>]*disabled[^>]*>[\\s\\S]{0,120}${R33_PREDICTION}`),
    "the predicted refusal still renders on the control, before any call",
  );
  // And no server report is invented to sit beside it.
  assert.equal(visibleText(body).includes(SERVERS_OWN_SENTENCE), false);
});

test("R34: EVERY refused drone gets its own line — R30's collapse cannot happen", () => {
  // ⚠ THE EXACT FAILURE R30 MEASURED, IN ITS DRONE FORM. Two drones that share
  // a name and are refused for the same reason are still two drones; a panel
  // that merged them would report one refusal where there were two, and a panel
  // that used one slot would report the last and lose the first.
  const text = visibleText(
    droneScene({
      inSpace: [A_SPACE_DRONE],
      orderReports: [
        { label: "Hobgoblin I", text: SERVERS_OWN_SENTENCE },
        { label: "Hobgoblin I", text: SERVERS_OWN_SENTENCE },
      ],
    }),
  );
  const occurrences = text.split(SERVERS_OWN_SENTENCE).length - 1;
  assert.equal(occurrences, 2, "both refusals must be on screen, not merged into one");
});

test("R34: drones refused for DIFFERENT reasons each keep their own reason", () => {
  const text = visibleText(
    droneScene({
      inSpace: [A_SPACE_DRONE],
      orderReports: [
        { label: "Hobgoblin I", text: SERVERS_OWN_SENTENCE },
        { label: "Ice Harvesting Drone II", text: "That drone cannot mine the selected resource." },
      ],
    }),
  );
  assert.match(text, /That drone is not currently under this ship's control\./);
  assert.match(text, /That drone cannot mine the selected resource\./);
});

test("R34: an UNKNOWN sentence is shown, not swallowed and not genericised", () => {
  // The fourteenth sentence eve.js adds must reach the player as written. A
  // lookup table would have blanked it; the pass-through shows it.
  const novel = "That drone has run out of something this client has never heard of.";
  const text = visibleText(
    droneScene({ inSpace: [A_SPACE_DRONE], orderReports: [{ label: "Hobgoblin I", text: novel }] }),
  );
  assert.match(text, new RegExp(novel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("R34: a drone we cannot name reads as words — NEVER as its id (R7d)", () => {
  const text = visibleText(
    droneScene({ inSpace: [A_SPACE_DRONE], orderReports: [{ label: null, text: SERVERS_OWN_SENTENCE }] }),
  );
  assert.match(text, /One of your drones/);
  assert.match(text, new RegExp(SERVERS_OWN_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("R34: R7d — the droneID that KEYS the server's dict never reaches the screen", () => {
  // ⚠ THIS IS THE INVARIANT MOST AT RISK IN THIS GOAL. The server attributes
  // each sentence by droneID, so the id is genuinely load-bearing data that has
  // to travel from the wire into the browser. It dies in `flow.ts`, which
  // spends it on a name lookup — and `DroneOrderReport` has no id field for it
  // to survive in, which is why this cannot regress by accident.
  //
  // The id used here is the REAL one from the live capture, not a placeholder.
  const LIVE_DRONE_ID = 9988400023314;
  const text = visibleText(
    droneScene({
      inSpace: [AN_ABANDONED_DRONE],
      orderReports: [{ label: "Ice Harvesting Drone II", text: SERVERS_OWN_SENTENCE }],
    }),
  );
  assert.match(text, /Ice Harvesting Drone II/);
  for (const id of [LIVE_DRONE_ID, ABANDONED_DRONE_ID, SPACE_DRONE_ID, SHIP_ID, DRONE_TYPE_ID]) {
    assert.doesNotMatch(text, new RegExp(`\\b${id}\\b`), `id ${id} reached the screen`);
  }
  // No digits at all in the reports block — the strongest form of the claim.
  const reports = text.slice(text.indexOf(SERVERS_OWN_SENTENCE) - 60);
  assert.doesNotMatch(reports.slice(0, 120), /\d{4,}/, "a long number appeared beside the reason");
});

test("R34: the report markup can only render a label and a sentence", () => {
  // A structural guarantee rather than a sampled one: the block renders exactly
  // `report.label` and `report.text`, and the type carries nothing else. There
  // is no field an id could hide in.
  const block = DRONES_SOURCE.slice(
    DRONES_SOURCE.indexOf(`{#each $drones.orderReports`),
    DRONES_SOURCE.indexOf("<h3>In space</h3>"),
  );
  assert.notEqual(block, "");
  const referenced = [...block.matchAll(/report\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(referenced)].sort(), ["label", "text"]);
});

test("R34: the report type itself carries no id (R7d, at the source)", () => {
  const types = readFileSync(path.join(UI_DIR, "..", "store", "types.ts"), "utf8");
  const start = types.indexOf("export interface DroneOrderReport");
  const declaration = types.slice(start, types.indexOf("}", start));
  assert.notEqual(start, -1);
  assert.doesNotMatch(declaration, /ID\b|Id\b|\bid\b/, "an id field appeared on a rendered report");
});

// --- Recovery: the way back for a drone this hull cannot fly ------------------
//
// An orphaned drone — owned by this character, controlled by no hull of theirs
// after a lost session, a ship swap, or a pod and reboard — used to be a dead
// end. The panel listed it, refused Bring home (correctly: the server obeys
// only the controlling hull), and offered nothing else. That is ISK sitting in
// space with no way to reach it.

test("an orphaned drone offers Reconnect and Scoop; a flown one does not", () => {
  const orphaned = visibleText(droneScene({ inSpace: [AN_ORPHANED_DRONE] }));
  assert.match(orphaned, /Reconnect/);
  assert.match(orphaned, /Scoop/);

  const flown = visibleText(droneScene({ inSpace: [A_SPACE_DRONE] }));
  assert.doesNotMatch(flown, /Reconnect/, "a drone you already fly needs no recovery");
  assert.doesNotMatch(flown, /Scoop/);
});

test("⚠ the orphaned drone still refuses Bring home, and now says why AND what to do", () => {
  const body = droneScene({ inSpace: [AN_ORPHANED_DRONE] });
  const text = visibleText(body);
  // The existing R33 guarantee: the reason IS the label, never a tooltip. The
  // BFF's `controlled:false` is now enough on its own to earn it — before, this
  // needed a snapshot row carrying a foreign controllerID, and a drone the
  // snapshot did not carry showed a live button that would have failed.
  assert.match(text, /Your ship is not flying this drone/i);
  // And the two new controls are LIVE — the whole point is that they work when
  // the order button cannot.
  const reconnect = body.slice(0, body.indexOf("Reconnect"));
  const openingTag = reconnect.slice(reconnect.lastIndexOf("<button"));
  assert.doesNotMatch(
    openingTag,
    /disabled/,
    "Reconnect must not be disabled on the drone it exists for",
  );
});

test("recovery controls are real buttons (R8), and carry no ids (R7d)", () => {
  const body = droneScene({ inSpace: [AN_ORPHANED_DRONE] });
  assert.match(body, /<button[^>]*>\s*Reconnect\s*<\/button>/);
  assert.match(body, /<button[^>]*>\s*Scoop\s*<\/button>/);
  const text = visibleText(body);
  for (const id of [SPACE_DRONE_ID, SHIP_ID, DRONE_TYPE_ID]) {
    assert.doesNotMatch(text, new RegExp(`\b${id}\b`), `id ${id} reached the screen`);
  }
});

// --- A salvage drone's own order ---------------------------------------------
//
// The client offers Salvage for a salvage drone its ship controls (droneCheckers.OfferSalvage), and sends the
// order with the pilot's active target, or with none where it has nothing targeted (droneFunctions.py 156 to
// 161). The window had no such order until 2026-10-10.

const SALVAGE_DRONE_TYPE_ID = 32787;
const A_SALVAGE_DRONE = { ...A_SPACE_DRONE, itemID: SPACE_DRONE_ID + 1, typeID: SALVAGE_DRONE_TYPE_ID, name: "Salvage Drone I" };
const KINDS_READ: Record<number, string> = { [SALVAGE_DRONE_TYPE_ID]: "Salvage Drone", [DRONE_TYPE_ID]: "Combat Drone" };

/** The drones window with these drones out, the kinds of drone that have been read, and what is locked. */
function salvageScene(inSpace: readonly unknown[], locked: readonly number[] = [], kinds: Record<number, string> = KINDS_READ): string {
  const store = sceneStore({ inSpace: inSpace as never });
  store.apply({ type: "names/resolved", entries: Object.fromEntries(Object.entries(kinds).map(([typeID, name]) => [`typeGroup:${typeID}`, name])) } as never);
  if (locked.length > 0) store.apply({ type: "targeting/targets", targetIDs: locked } as never);
  return render(DronesPanel, { props: { store, flow: fakeFlow() } }).body;
}
const LIVE_SALVAGE_BUTTON = /<button(?![^>]*\bdisabled\b)[^>]*>\s*Salvage ([a-z ]+?)\s*<\/button>/i;

test("a salvage drone out is offered its own order: for any wreck where nothing is locked", () => {
  const body = salvageScene([A_SPACE_DRONE, A_SALVAGE_DRONE]);
  assert.equal(LIVE_SALVAGE_BUTTON.exec(body)?.[1], "any wreck");
});

test("with something locked the salvage order is for what is locked", () => {
  const body = salvageScene([A_SALVAGE_DRONE], [424242]);
  assert.equal(LIVE_SALVAGE_BUTTON.exec(body)?.[1], "what I have locked");
});

test("with no salvage drone out, no salvage order is offered at all", () => {
  // A combat drone alone: the client offers it no salvage (OfferSalvage is for a salvage drone).
  assert.doesNotMatch(visibleText(salvageScene([A_SPACE_DRONE])), /Salvage/);
  assert.doesNotMatch(visibleText(salvageScene([])), /Salvage/);
});

test("a drone whose kind has not been read is not offered the order, and one the ship may not fly is not either", () => {
  assert.doesNotMatch(visibleText(salvageScene([A_SALVAGE_DRONE], [], {})), /Salvage (any|what)/);
  assert.doesNotMatch(visibleText(salvageScene([{ ...A_SALVAGE_DRONE, controlled: false }])), /Salvage (any|what)/);
});
