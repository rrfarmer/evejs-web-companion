// R108 slice 3: the Planetary Industry window, rendered.
//
// The board's logic is pinned in bridge/piBoard.test.ts; this proves the
// window actually PRINTS it — from a roster and readings stored the way the
// window stores them, through the same decoder — and that what it prints obeys
// the house rules: every colony row with its own age, the four per-pilot
// outcomes in words, no id as data (R7d), no machinery words (R9a), and no
// character select anywhere in the source.
//
// (`onMount` does not run under the server generator, so rendering here never
// reads; that is also why these tests can hold stored readings still.)

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const PiManager = (await import("./PiManager.svelte")).default;
const { setKnownCharacterStorage } = await import("../app/knownCharacters.ts");
const { setHangarPrefsStorage, saveHangarPrefs, addSquad, EMPTY_PREFS } = await import(
  "../app/hangarPrefs.ts"
);
const { setPiRosterStorage, savePiRoster, recordPiAnswer, addPiMembers, EMPTY_PI_ROSTER } =
  await import("../app/piRosterPrefs.ts");

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "PiManager.svelte"), "utf8");

const FARMER = 90000001;
const NEWBIE = 90000002;
const STRANGER = 90000003;
const SPARE = 90000004;
const MINUTE = 60_000;

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function knownPilot(characterID: number, characterName: string) {
  return {
    accountName: "alpha",
    characterID,
    characterName,
    shipName: null,
    skillPoints: null,
    balance: null,
    lastSeen: 1,
  };
}

function colonyWire(planetID: number, planetName: string, expiresAtMs: number) {
  return {
    planetID,
    planetName,
    solarSystemID: 30000001,
    solarSystemName: "Alpha",
    planetTypeID: 2016,
    planetTypeName: "Planet (Barren)",
    commandCenterLevel: 5,
    lastSimulatedAtMs: expiresAtMs - 10 * MINUTE,
    linkCount: 0,
    links: [],
    routes: [],
    pins: [
      {
        pinID: 900000000000,
        typeID: 2848,
        typeName: "Barren Extractor Control Unit",
        kind: "extractor-control",
        contents: [],
        usedM3: null,
        capacityM3: null,
        schematicID: null,
        schematicName: null,
        hasReceivedInputs: null,
        receivedInputsLastCycle: null,
        lastRunAtMs: null,
        lastLaunchAtMs: null,
        program: {
          resourceTypeID: 2268,
          resourceTypeName: "Aqueous Liquids",
          cycleTimeSeconds: 7200,
          quantityPerCycle: 4591,
          installedAtMs: expiresAtMs - 48 * 60 * MINUTE,
          expiresAtMs,
          headCount: 7,
        },
      },
    ],
  };
}

/** Seed all three stores the window reads, then render it. */
function renderSeeded(): string {
  const shared = memoryStorage();
  setKnownCharacterStorage(shared);
  setHangarPrefsStorage(shared);
  setPiRosterStorage(shared);
  shared.setItem(
    "evejs-web-known-characters:v1",
    JSON.stringify([
      knownPilot(FARMER, "Ada Farmer"),
      knownPilot(NEWBIE, "Cy Newbie"),
      knownPilot(SPARE, "Eve Spare"),
    ]),
  );
  saveHangarPrefs(addSquad(EMPTY_PREFS, { id: "sq1", name: "Miners", color: "#fff" }, [SPARE]));

  const now = Date.now();
  // Read two hours ago: one colony's program already ran out, one is running.
  const readAt = now - 2 * 60 * MINUTE;
  const answer = {
    ok: true,
    serverNowMs: readAt,
    pilots: [
      {
        characterID: FARMER,
        readAtMs: readAt,
        coloniesReadable: true,
        colonies: [
          colonyWire(40000002, "Alpha I", now + 30 * 60 * MINUTE),
          colonyWire(40000004, "Alpha II", now - 30 * MINUTE),
        ],
        stock: [
          {
            typeID: 2268,
            typeName: "Aqueous Liquids",
            quantity: 5000,
            locationID: 60000004,
            locationName: "Alpha I - Moon 1 - Station",
            holder: "ship",
            holderName: "Hauler One",
          },
        ],
      },
      { characterID: NEWBIE, readAtMs: readAt, coloniesReadable: true, colonies: [] },
    ],
  };
  savePiRoster(recordPiAnswer(addPiMembers(EMPTY_PI_ROSTER, [FARMER, NEWBIE, STRANGER]), answer as never, readAt));
  try {
    return render(PiManager as never, { props: {} } as never).body;
  } finally {
    setKnownCharacterStorage(null);
    setHangarPrefsStorage(null);
    setPiRosterStorage(null);
  }
}

function visibleText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ");
}

test("an empty roster says what to do, and offers the hangar's pilots", () => {
  setKnownCharacterStorage(null);
  setPiRosterStorage(null);
  const text = visibleText(render(PiManager as never, { props: {} } as never).body);
  assert.match(text, /No pilots are on planetary industry yet\. Add one below\./);
  assert.match(text, /Pilots come from the Pilot hangar/);
});

test("stored readings are printed by pilot: worst first, under the pilot's age", () => {
  const text = visibleText(renderSeeded());
  // The age of a pilot's one reading is said once, on the pilot's own line,
  // with what needs the player and the fullest store.
  assert.match(text, /Ada Farmer 2 colonies, Alpha 1 needs you Read 2 hours ago/);
  // What needs you is said on the colony's own row, and that row comes first.
  const stopped = text.indexOf("Alpha II Barren - CC 5");
  const running = text.indexOf("Alpha I Barren - CC 5");
  assert.ok(stopped >= 0 && running > stopped, text);
  assert.match(text, /Alpha II Barren - CC 5 Aqueous Liquids 1 extractor has finished its program/);
  assert.match(text, /Alpha I Barren - CC 5 Aqueous Liquids Ends in (\d+d )?\d+h/);
});

test("the strip counts the estate before any row", () => {
  const text = visibleText(renderSeeded());
  assert.match(text, /Colonies 2 Extracting 1 Need you now 1 Next program ends (\d+d )?\d+h/);
});

test("⚠ the window draws one frame, not a box per section", () => {
  // The components layer frames every `section`; this window resets its own.
  assert.match(SOURCE, /\.pi-manager section \{\s*border: 0;/);
});

test("⚠ each pilot's outcome is said about that pilot", () => {
  const text = visibleText(renderSeeded());
  // Read and found with no colony: folded to a name, not a sentence per alt.
  assert.match(text, /Not on a planet yet Cy Newbie/);
  assert.doesNotMatch(text, /has not built on a planet yet/);
  assert.match(
    text,
    /A pilot no longer in the hangar This pilot is no longer in the hangar, so there is no account to read with\./,
  );
});

test("taking a pilot off the list is called Remove, never 'Take off'", () => {
  // In a game about ships "Take off" reads as launching the ship. This button
  // only edits the list: nothing is signed in, selected or undocked.
  const body = renderSeeded();
  // A quiet glyph, named for the pilot it removes, on rows and on names alike.
  assert.match(body, /aria-label="Remove Ada Farmer"/);
  assert.match(body, /aria-label="Remove Cy Newbie"/);
  assert.doesNotMatch(body, /take off/i);
});

test("adding to the list reads the newcomers' colonies, with no Refresh", () => {
  // onMount and clicks do not run under the server generator, so the wiring is
  // read off the source. gridcheck's pi-add-pilot clicks it in a real browser.
  const body = /function add\(\): void \{[\s\S]*?\n  \}\n/.exec(SOURCE)?.[0] ?? "";
  // In this order: a list taken after keep() has everybody on it, and reads nobody.
  assert.match(
    body,
    /const before = new Set\(roster\.members\);[\s\S]*keep\([\s\S]*const newcomers = roster\.members\.filter\(\(member\) => !before\.has\(member\)\);[\s\S]*void reread\(newcomers\);/,
  );
  // A newcomer waiting behind a read in progress already says it is being looked at.
  assert.match(body, /for \(const member of newcomers\) marked\.set\(member, "reading"\);/);
});

test("whoever waits behind a read is read after it fails, and not after the window closes", () => {
  assert.match(SOURCE, /\} finally \{[^}]*if \(rereadPending\.size > 0\) void reread\(\[\]\);\s*\}/);
  assert.match(SOURCE, /if \(reading \|\| closed\) return;/);
  assert.match(SOURCE, /return \(\) => \{\s*closed = true;/);
});

test("the add list offers pilots not yet on it, and a squad with someone new", () => {
  const body = renderSeeded();
  assert.match(body, /<option value="pilot:90000004">Eve Spare<\/option>/);
  assert.doesNotMatch(body, /<option value="pilot:90000001">/, "already on the roster");
  assert.match(body, /<option value="squad:sq1">Miners<\/option>/);
});

test("no id as data and no machinery words in anything a player reads", () => {
  const text = visibleText(renderSeeded());
  assert.doesNotMatch(text, /\d{5,}/, "no id-length number is printed");
  assert.doesNotMatch(text, /schematic|\bpins?\b|\bECU\b|character ?ID/i);
  // And the sweep does catch an id when one is there.
  assert.match(`Pilot ${FARMER}`, /\d{5,}/);
});

test("a pilot with an ended extractor is offered a restart, its count on the button", () => {
  const body = renderSeeded();
  // The count is on the button; the full sentence is its tooltip.
  assert.match(
    body,
    /title="1 extractor has ended on 1 colony\. This starts a server run for Ada Farmer that restarts every ended extractor on all of its colonies, re-sizes the storage routes of any extractor that yields more than they carry, then stops\. It changes nothing else and runs for an hour at most\."[^>]*>\s*Restart 1 extractor\s*</,
  );
  // Only one pilot has anything to restart.
  assert.equal(visibleText(body).match(/Restart 1 extractor/g)?.length, 1);
});

test("the restart is offered on the pilot's colonies, not on the roster", () => {
  const body = renderSeeded();
  const colonies = body.slice(body.indexOf('id="pi-view-colonies"'), body.indexOf('id="pi-view-pilots"'));
  const pilots = body.slice(body.indexOf('id="pi-view-pilots"'), body.indexOf('id="pi-view-stock"'));
  assert.match(visibleText(colonies), /Ada Farmer 2 colonies, Alpha .*Restart 1 extractor To the pilot's station/);
  assert.doesNotMatch(pilots, /Restart \d+ extractor/);
});

test("how things work is one help for the window; a pilot's line keeps only its particulars", () => {
  const body = renderSeeded();
  const colonies = body.slice(body.indexOf('id="pi-view-colonies"'), body.indexOf('id="pi-view-pilots"'));
  // One "?" beside Refresh opens it, on the view the window shows.
  assert.match(body, /aria-label="How Planetary Industry works"/);
  assert.match(SOURCE, /<PiHelp open=\{helpOpen\} section=\{view\}/);
  assert.doesNotMatch(colonies, /What this does/);
  // Where this pilot's haul goes stays on its line, before its button; what to
  // do first sits by the button, so a disabled Haul still says why.
  assert.match(visibleText(colonies), /To the pilot's station, the pilot's own hangar Change Tick colonies 70%\+ full Tick the colonies to haul\. Haul/);
});

test("a pilot that needs the player opens by itself; the rest are one line", () => {
  // onMount does not run under SSR, so the rule is pinned where it is decided.
  assert.match(SOURCE, /return needYouNow > 0 \|\| \(run !== null && \(!run\.over \|\| run\.tone === "stopped"\)\);/);
  const body = renderSeeded();
  assert.match(body, /aria-expanded="true"[^>]*>[\s\S]*?Ada Farmer/);
});

test("the roster is grouped by account, and a shared age is said once", () => {
  const body = renderSeeded();
  const text = visibleText(body.slice(body.indexOf('id="pi-view-pilots"'), body.indexOf('id="pi-view-stock"')));
  assert.match(text, /alpha 2 pilots, 2 colonies - Read 2 hours ago Ada Farmer 2 colonies, Alpha/);
  // A pilot whose account is not known any more is still listed.
  assert.match(text, /No longer in the hangar 1 pilot A pilot no longer in the hangar/);
});

test("⚠ a restart goes through the server bot host, never a select in this tab", () => {
  assert.match(SOURCE, /restartExtractorsFor\(accountName, characterID\)/);
  assert.doesNotMatch(SOURCE, /startLocal|runHere|flow\.start/);
  // The flying-bot list loads in onMount, which SSR never runs, so the
  // disabled state is pinned where it is decided: the board's own verdict.
  assert.match(SOURCE, /disabled=\{!pilot\.restart\.enabled\}/);
});

test("the board is given the recipe table the read fetched", () => {
  // onMount does not run under the server generator, so this is pinned at the
  // source: without it the board judges starved factories by routes alone.
  assert.match(SOURCE, /buildPiBoard\(\{[^}]*\brecipes\b[^}]*\}\)/);
  assert.match(SOURCE, /onRecipes:/);
});

test("⚠ the window never selects a character, and never reads on a timer", () => {
  assert.doesNotMatch(SOURCE, /selectCharacter|\/api\/bridge\/select|flow\.select/);
  // The one interval moves the ages on; it must not be the thing that reads.
  const interval = SOURCE.match(/setInterval\(([^;]*)\);/);
  assert.ok(interval, "the age tick exists");
  assert.doesNotMatch(interval![1]!, /refresh|readPiRoster/);
});

test("the window has its own menu, and shows one view at a time", () => {
  const body = renderSeeded();
  for (const id of ["colonies", "stock", "coverage", "planner", "pilots"]) {
    assert.match(body, new RegExp(`<button[^>]*role="tab"[^>]*id="pi-tab-${id}"`));
  }
  // A roster with pilots opens on Colonies; the other views are hidden, not
  // left out, so a restart already started keeps saying so.
  assert.match(body, /id="pi-tab-colonies"[^>]*aria-selected="true"/);
  assert.doesNotMatch(body, /<section[^>]*id="pi-view-colonies"[^>]*hidden/);
  assert.match(body, /<section[^>]*id="pi-view-pilots"[^>]*hidden/);
  assert.match(body, /<section[^>]*id="pi-view-planner"[^>]*hidden/);
  assert.match(body, /<section[^>]*id="pi-view-stock"[^>]*hidden/);
  assert.match(body, /<section[^>]*id="pi-view-coverage"[^>]*hidden/);
});

test("the menu badges say what waits in each view", () => {
  const text = visibleText(renderSeeded());
  // One colony needs you. The restart waits on the colonies too, so Pilots
  // has no badge of its own.
  assert.match(text, /Colonies 1 Stock Coverage Planner Pilots (?!\d)/);
});

test("coverage says plainly when it has no recipe table to weigh with", () => {
  // Rendering never reads, so there is no table: no table of coverage either.
  const body = renderSeeded();
  const coverage = body.slice(body.indexOf('id="pi-view-coverage"'), body.indexOf('id="pi-view-planner"'));
  assert.match(visibleText(coverage), /The recipe table has not been read yet\. Refresh reads it\./);
  assert.doesNotMatch(coverage, /<table/);
});

test("an empty roster opens on Pilots, where a pilot is added", () => {
  setKnownCharacterStorage(null);
  setPiRosterStorage(null);
  const body = render(PiManager as never, { props: {} } as never).body;
  assert.match(body, /id="pi-tab-pilots"[^>]*aria-selected="true"/);
  assert.match(body, /<section[^>]*id="pi-view-colonies"[^>]*hidden/);
});

test("the planner says plainly when it has no recipe table to plan with", () => {
  // Rendering never reads, so the table was never read: say so, offer no form.
  const body = renderSeeded();
  assert.match(visibleText(body), /The recipe table has not been read yet\. Refresh reads it\./);
  assert.doesNotMatch(body, /id="pi-plan-quantity"/);
});

test("stock says where every unit sits, and what each part of the total rests on", () => {
  const body = renderSeeded();
  const text = visibleText(body);
  // The line, in the hangar column, with the colony column empty.
  assert.match(text, /Aqueous Liquids - 5,000 - 5,000/);
  // What each part of the total rests on, said beside the numbers.
  assert.match(text, /Colonies and personal hangars - 1 pilot, oldest read 2 hours ago/);
  assert.match(text, /Personal hangars of Cy Newbie not read yet\. Refresh reads them\./);
  assert.match(text, /A pilot no longer in the hangar not read, so nothing they hold is counted\./);
});

test("the corp hangar read rides a session already online, and never selects anyone", () => {
  // A tab pilot is read on its own options; a bot-flown pilot through the
  // bot's session, on a throwaway sign-in that leaves the tab's own untouched.
  assert.match(SOURCE, /session\.flow\.requestOptions\(\)/);
  const corpRead = readFileSync(path.join(UI_DIR, "../app/piCorpRead.ts"), "utf8");
  assert.doesNotMatch(corpRead, /selectCharacter|\/api\/bridge\/select|startServerBot|stopServerBot/);
  assert.match(corpRead, /apiLogin\(accountName, "", \{ token: null \}\)/);
  const api = readFileSync(path.join(UI_DIR, "../app/api.ts"), "utf8");
  assert.match(api, /getJson\(`\/api\/bots\/corp-assets\?/, "the bot read is a GET");
});

test("a paused run's box says what to do and opens the Bot Manager from both mounts", () => {
  // A paused server run has no Resume, so the box never promises it carries on.
  assert.doesNotMatch(SOURCE, /it carries on/);
  assert.match(SOURCE, /\{run\.todo \?\? "The run waits where it is and does not carry on by itself\./);
  assert.match(SOURCE, /onclick=\{\(\) => onOpen\("botManager"\)\}>Bot Manager<\/button>/);
  // The floating window and a phone's panel both hand the window its opener.
  const globalPanel = readFileSync(path.join(UI_DIR, "GlobalPanel.svelte"), "utf8");
  const panelHost = readFileSync(path.join(UI_DIR, "PanelHost.svelte"), "utf8");
  assert.match(globalPanel, /<PiManager \{sessions\} \{onOpen\} \/>/);
  assert.match(panelHost, /<PiManager \{sessions\} onOpen=\{/);
});
