// What "Inventory & Ship" offers, and what it must NOT, in each state.
//
// A docked character gets the station's services — "Board your corvette",
// "Leave ship", the repair shop, the guest list — and a refused action's words
// (which land in `inventory.actionError` via the shared mutation path) surface
// on the panel.
//
// ⚠ IN SPACE, FOUR WHOLE LOCATIONS GO. Not just the services tab: the ship
// hangar, the item hangar and the corp hangar are station storage, reachable
// only from inside one. `InventoryShip.svelte` — the panel this replaced — drew
// all three while flying, and they were not empty either: they showed whatever
// the last docked read had left in the store, which is worse than empty,
// because a stale list of hulls in a station reads as something you could act
// on. That is the regression this file now guards.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

/** No panel may call the flow during a server render — reads back no-ops. */
function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function onlineStore(stationID: number | null) {
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 1, username: "rrfarmer" });
  store.apply({
    type: "character/online",
    character: {
      characterID: 90000001,
      characterName: "Farmer",
      stationID,
      structureID: null,
      solarSystemID: 30000142,
      corporationID: 1000001,
    },
    station: null,
  });
  return store;
}

async function renderInventory(store: unknown, isDocked: boolean): Promise<string> {
  const { default: StationPanel } = (await import("./StationPanel.svelte")) as { default: unknown };
  return render(StationPanel as never, {
    props: { store, flow: fakeFlow(), isDocked },
  } as never).body;
}

test("docked, the Station Services tab offers the corvette and leave-ship actions and the guests", async () => {
  const body = await renderInventory(onlineStore(60003760), true);

  // ⚠ THE WORDS ARE THE NEW PANEL'S. "Board your corvette" became "Board
  // corvette" and "Leave ship" became "Leave ship → capsule" when the panel was
  // rewritten — the second one on purpose, because leaving your ship in a
  // station puts you in a capsule and the old label did not say where you go.
  assert.match(body, /Station services/, "the Station services tab is missing");
  assert.match(body, /Board corvette/, "the corvette action is missing");
  assert.match(body, /Leave ship/, "the leave-ship action is missing");
  assert.match(body, /Repair ship/, "the repair-shop action is missing");
  assert.match(body, /Guests/, "the guest list is missing");
});

test("the repair shop is not charged until it has been asked for a quote", async () => {
  const body = await renderInventory(onlineStore(60003760), true);

  // "Repair ship" only raises the quote; the priced press appears with it.
  assert.doesNotMatch(body, /and pay/, "the paying press must not be offered before a quote");
});

test("⚠ IN SPACE, EVERY STATION-ONLY LOCATION IS ABSENT — not empty, not disabled", async () => {
  // Absent, because there is nothing honest to put behind them. A tab wearing
  // "you cannot use this right now" is a tab a pilot reads past on every visit,
  // and a tab showing the last docked read is worse than either.
  const body = await renderInventory(onlineStore(null), false);

  for (const gone of ["Ship hangar", "Item hangar", "Corp hangar", "Station services"]) {
    assert.equal(body.includes(gone), false, `"${gone}" leaked into space`);
  }
  assert.doesNotMatch(body, /Board corvette/, "the corvette action leaked into space");
  assert.doesNotMatch(body, /Repair ship/, "the repair action leaked into space");
  // Non-vacuous: docked, all four ARE there.
  const docked = await renderInventory(onlineStore(60003760), true);
  for (const shown of ["Ship hangar", "Item hangar", "Corp hangar", "Station services"]) {
    assert.ok(docked.includes(shown), `"${shown}" is missing while docked`);
  }
});

test("⚠ IN SPACE, 'Move to…' CANNOT OFFER A HANGAR EITHER", async () => {
  // The tab going is only half of it. A destination the server will refuse is
  // the silent decline again — a live control that can only bounce the stack
  // back — so the move menu is told the same thing the tab strip was.
  const model = readFileSync(path.join(UI_DIR, "inventoryModel.ts"), "utf8");
  assert.match(model, /docked = true,/, "moveDestinations was not told about being in space");
  const panel = readFileSync(path.join(UI_DIR, "StationPanel.svelte"), "utf8");
  assert.match(panel, /moveDestinations\(\$inventory, place, containerName\(\), isDocked\)/);
});

test("in space the ship's own bays are still there — this is not a blank panel", async () => {
  const body = await renderInventory(onlineStore(null), false);
  assert.match(body, /Ship bays|bays/, "a flying pilot must still see their own holds");
});

test("a refused ship action's words surface on the panel", async () => {
  const store = onlineStore(60003760);
  store.apply({
    type: "inventory/action-error",
    message: "You are already in your corvette.",
  });
  const body = await renderInventory(store, true);

  assert.match(body, /You are already in your corvette\./, "the refusal words are not shown");
});

// --- two things the live run in space found ---------------------------------

test("⚠ THE EMPTY-CARGO SENTENCE DOES NOT NAME A PLACE A FLYING PILOT LACKS", async () => {
  // It read "Empty — move things here from the hangar." That sentence was
  // written for the docked panel, where the hangar is one tab away. Out on a
  // belt it points at a place the pilot cannot reach and the server will not
  // move anything into.
  const inSpace = await renderInventory(onlineStore(null), false);
  assert.equal(
    /move things here from the hangar/.test(inSpace),
    false,
    "the panel told a flying pilot to use a hangar",
  );
  // Docked, the original sentence is the right one and stays. Asserted at the
  // source, because this fixture's hull has no open bays for it to render into
  // and a render check would pass for the wrong reason.
  const panel = readFileSync(path.join(UI_DIR, "StationPanel.svelte"), "utf8");
  assert.match(panel, /isDocked\s*\?\s*"Empty — move things here from the hangar\."/);
  assert.match(panel, /from your other bays, or from a container on the grid/);
});

test("⚠ THE HULL IS NAMED IN SPACE, from the snapshot when the hangar cannot", async () => {
  // `openShip.typeID` is read off the row the player clicked the hull FROM — a
  // ship-hangar or cargo row — and in space there is no ship hangar to click
  // one in, so it is 0 and the tab read "your ship bays". The snapshot has the
  // same hull's type, and it is only used when the open ship IS that ship, so
  // it can never name one hull with another's type.
  const panel = readFileSync(path.join(UI_DIR, "StationPanel.svelte"), "utf8");
  assert.match(panel, /const hullTypeID = \$derived\.by<number>/);
  assert.match(
    panel,
    /ship\.itemID === open\.itemID \? ship\.typeID : 0/,
    "the snapshot fallback must be gated on it being the SAME hull",
  );
  assert.match(panel, /typeName\(hullTypeID\)/, "the tab must use the resolved hull type");
});

test("⚠ THE HEADER DOES NOT SAY 'STATION' TO A PILOT IN SPACE", async () => {
  // A header naming a station the pilot has undocked from is exactly the stale
  // label this rewrite exists to remove.
  const inSpace = await renderInventory(onlineStore(null), false);
  assert.doesNotMatch(inSpace, /class="stn-head-title">Station</);
  assert.match(inSpace, /class="stn-head-title">Ship</);
  const docked = await renderInventory(onlineStore(60003760), true);
  assert.match(docked, /class="stn-head-title">Station</);
});

test("aboard a corvette the corvette's button cannot be pressed, as the client's cannot; in another hull, or with the hull not known, it can", async () => {
  // corvetteButton.py (_update_enabled): is_enabled = not is_aboard_corvette, by the group of godma's ship item.
  const flightIn = (shipGroupID: number | null) => ({ inSpace: false, docked: true, solarSystemID: 30000142, stationID: 60003760, structureID: null, shipID: 9001, shipTypeID: 588, shipGroupID, shipIsCapsule: shipGroupID === 29, shipMode: null, shipSpeedFraction: null });
  const pressable = async (shipGroupID: number | null | undefined): Promise<boolean> => {
    const store = onlineStore(60003760);
    if (shipGroupID !== undefined) {
      store.apply({ type: "flight/status", status: flightIn(shipGroupID) });
    }
    const body = await renderInventory(store, true);
    const button = /<button[^>]*>\s*Board corvette\s*<\/button>/.exec(body);
    assert.ok(button, "the corvette's button is there");
    return !/\bdisabled\b/.test(button![0]);
  };

  assert.deepEqual([await pressable(237), await pressable(25), await pressable(29), await pressable(null), await pressable(undefined)], [false, true, true, true, true]);
});
