// Every panel must SURVIVE ITS FIRST MOUNT (goal R18).
//
// The bug this suite exists to prevent: the Fitting tab did nothing at all when
// clicked. `<Fitting>`'s template read `{activeShipName()}` — invoking a
// `$derived` STRING as if it were a function. That throws
// `TypeError: activeShipName(...) is not a function` while Svelte is creating
// the component, so Svelte abandoned the whole render, `page` never visibly
// changed, and the tab looked inert. Nothing reached `window.onerror`, so the
// failure was completely silent to the player.
//
// Nothing else in the suite could have caught it: `tsc` does not parse
// `.svelte` files (web/src/svelte-files.d.ts), and no test had ever executed a
// component. So this suite RENDERS them, using Svelte's server generator (no
// DOM needed — see svelteSsrHook.ts).
//
// Two layers, because they fail for different reasons:
//   1. render every panel against the store's INITIAL state, and the Fitting
//      panel against the RAW BFF read shapes decoded through the real flow —
//      this is the first-mount reproduction;
//   2. a static sweep asserting no `$derived` binding is ever invoked as a
//      function — this also covers template branches a render does not reach.
//
// `$effect` and `onMount` do not run under the server generator, so this pins
// RENDER-time correctness. It is the half where the R18 bug lived.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { createAppFlow } = await import("../app/flow.ts");

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Every panel App can swap in, plus the pre-login pages, App, and the
 * per-pilot Workspace (R107 — App is now the multibox roster; the docked/
 * in-space workspace it used to be lives in Workspace.svelte). */
const PANELS = [
  "App",
  "Workspace",
  "LoginForm",
  "CharacterSelect",
  // The "Inventory & Ship" panel, in BOTH states: the right-hand dock frame
  // while docked, the Neocom's floating window while flying, and the mobile
  // home. It renders with nothing but a store and a flow, exactly as it does on
  // a cold mount before the first read answers.
  "StationPanel",
  "Fitting",
  "Industry",
  "Market",
  "Activity",
  "FleetCenter",
  "Scanner",
  "Mail",
  "Contracts",
  "PersonalAssets",
  "AgentsMissions",
  "AgentFinder",
  "Flight",
  // ⚠ "Overview" WAS THE COCKPIT, and it does not exist. What it became is
  // listed instead — each of these renders on a cold store, which is exactly the
  // paint a pilot gets on the first frame after undocking.
  "SpaceOverview",
  "DronesPanel",
  "ShotsPanel",
  "EquipmentPanel",
  "MiningBot",
  "MissionBot",
  "Mining",
  "Skills",
  "Planets",
  // R108 slice 3 — the PI Manager, a global window over the whole PI roster.
  "IndustryManager",
  "Travel",
  // R43 — the launcher. It embeds MiningBot and MissionBot, so a first-mount
  // failure in either now takes this panel down too.
  "Bots",
  // The player Bot Builder editor.
  "BotBuilder",
  // The global bot script store manager.
  "BotManager",
  "Chat",
  // R50 — the two wallet tabs.
  "Wallet",
  "CorpWallet",
  // R55 — the standings page.
  "Standings",
  // R56 — the character sheet.
  "CharacterSheet",
] as const;

/**
 * A flow stub: the server generator never runs `onMount` or an event handler,
 * so no panel should call anything on it during a render. Any property reads
 * back as a no-op async function.
 */
function fakeFlow(): unknown {
  // Its stores: the drone-recovery gate, which reads ready (the flow default
  // unless the pilot opts in to browser recovery), and the pilot's waypoints,
  // none on a cold start (nav/waypoints.ts); and the image server, the owners' logos and the NPC corporations'
  // factions (the Neocom's portrait, the Standings rows' pictures and skill bonus), none.
  const droneRecovery = { subscribe: (run: (value: unknown) => void) => (run({ phase: "ready", reason: null }), () => {}) };
  const waypoints = { subscribe: (run: (value: unknown) => void) => (run([]), () => {}) };
  const none = { subscribe: (run: (value: unknown) => void) => (run(null), () => {}) };
  return new Proxy({}, { get: (_target, key) => key === "droneRecovery" ? droneRecovery : key === "waypoints" ? waypoints : key === "imageServer" || key === "ownerLogos" || key === "corporationFactions" ? none : async () => {} });
}

async function loadPanel(name: string): Promise<unknown> {
  const module = (await import(`./${name}.svelte`)) as { default: unknown };
  return module.default;
}

// --- 1. first mount against the store's initial state -----------------------

for (const name of PANELS) {
  test(`${name} renders on first mount against the store's initial state`, async () => {
    const store = createClientStore();
    const Panel = await loadPanel(name);
    // Any throw here is the R18 failure mode: the component dies during
    // creation and the page silently refuses to change.
    const output = render(Panel as never, {
      props: { store, flow: fakeFlow() },
    } as never);
    assert.equal(typeof output.body, "string");
  });
}

// --- 2. the Fitting panel against the RAW BFF read shapes -------------------

function packedRow(fields: Record<string, unknown>): unknown {
  return { type: "packedrow", fields };
}

/**
 * The exact envelope `GET /api/bridge/fitting` returns for Farmer's ship: raw
 * retail shapes, every read clean. A Punisher — 4 high / 2 mid / 5 low / 3 rig,
 * docked (so its capacitor arrives as "charge", attribute 18, not 482).
 */
function rawFittingRead(): unknown {
  const attributes: Record<number, number | null> = {
    48: 168,
    49: 3.6,
    11: 88.44,
    15: 6,
    482: null,
    18: 460,
    1132: 400,
    1152: 100,
    14: 4,
    13: 2,
    12: 5,
    1137: 3,
  };
  return {
    ok: true,
    activeShipID: 9988400029047,
    stationID: 60003760,
    slots: {
      type: "list",
      items: [
        packedRow({ itemID: 5001, typeID: 3634, groupID: 53, flagID: 27 }),
        packedRow({ itemID: 5004, typeID: 31358, groupID: 781, flagID: 92 }),
      ],
    },
    shipInfo: {
      type: "dict",
      entries: [
        [
          9988400029047,
          {
            type: "object",
            name: "util.KeyVal",
            args: {
              type: "dict",
              entries: [
                ["itemID", 9988400029047],
                [
                  "attributes",
                  {
                    type: "dict",
                    entries: Object.entries(attributes).map(([id, value]) => [
                      Number(id),
                      value,
                    ]),
                  },
                ],
              ],
            },
          },
        ],
      ],
    },
    online: { type: "list", items: [5001] },
    errors: { slots: null, shipInfo: null, online: null },
  };
}

function fittingFetch(): typeof fetch {
  return (async (input: unknown) => ({
    ok: true,
    status: 200,
    async json() {
      return String(input) === "/api/bridge/fitting"
        ? rawFittingRead()
        : { ok: true, applied: true };
    },
  })) as unknown as typeof fetch;
}

test("Fitting renders the loaded ship after the raw BFF read is decoded", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: fittingFetch() });
  await flow.loadFitting();

  const fitting = store.get().fitting;
  assert.equal(fitting.loaded, true);
  assert.equal(fitting.activeShipID, 9988400029047);
  // 4 high + 2 mid + 5 low + 3 rig.
  assert.equal(fitting.slots.length, 14);

  const Panel = await loadPanel("Fitting");
  const output = render(Panel as never, { props: { store, flow } } as never);

  // The ship header renders the derived NAME, not "[object Object]" and not a
  // crash. With no inventory row to name it from, it is the plain fallback.
  assert.match(output.body, /your ship/);
  // The slot families the decoded read produced are on screen, by plain name.
  assert.match(output.body, /High slots/);
  assert.match(output.body, /Rigs/);
  // R7d: the ship's itemID must never be rendered.
  assert.equal(output.body.includes("9988400029047"), false);
});

// --- 3. static sweep: a $derived is a VALUE, never a function ---------------

/**
 * Blank out comments, keeping every byte offset and line break intact.
 *
 * ⚠ THE SWEEP BELOW MUST NOT READ PROSE. It looks for `name(` anywhere in the
 * file, and a comment is the easiest place in a codebase to write a word
 * followed by a bracket — "the ship readout (goal R71)" tripped it against a
 * `$derived` called `readout`, reporting a call that did not exist and could
 * not. A false positive in a guard is worse than a gap: it teaches whoever hits
 * it that the guard is noise, and the next real offence gets waved through with
 * the same shrug.
 *
 * Replacing with spaces rather than deleting keeps `hit.index` pointing at the
 * true source position, so the reported line numbers stay honest.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead: string) => lead + " ".repeat(match.length - lead.length));
}

test("no component invokes a $derived binding as a function", () => {
  const offences: string[] = [];
  const files = readdirSync(UI_DIR).filter((name) => name.endsWith(".svelte"));
  assert.ok(files.length > 0, "expected .svelte components to sweep");

  for (const file of files) {
    const source = withoutComments(readFileSync(path.join(UI_DIR, file), "utf8"));
    const declarations = source.matchAll(
      /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=\s*\$derived\b/g,
    );
    for (const declaration of declarations) {
      const name = declaration[1]!;
      const called = new RegExp(String.raw`\b${name}\s*\(`, "g");
      for (const hit of source.matchAll(called)) {
        // Skip the declaration itself (`const x = $derived.by(...)`).
        if (hit.index === declaration.index! + declaration[0].indexOf(name)) {
          continue;
        }
        const line = source.slice(0, hit.index).split("\n").length;
        offences.push(`${file}:${line} calls the $derived '${name}' as a function`);
      }
    }
  }

  assert.deepEqual(offences, []);
});

// --- 4. The workspace's first paint matches WHERE the character is.
//
// The whole UI follows the docked/in-space flag — not a filtered tab bar. (This
// subsumes the old R50 login-default bug, where a character in space wrongly
// landed on the Station tab.) R107 moved this out of App (now the multibox
// roster) into Workspace, so render Workspace against an online store whose
// flight flag says docked / in space and check what landed.
//
// ⚠ THIS USED TO SAY "renders the SHELL": docked paints `StationShell`, in space
// paints `SpaceShell`. Both components were deleted — they were reachable only
// from their own test, having been superseded by the windowing workspace. The
// state split is now which CHROME appears (the HUD bar and the targets panel are
// in-space only) and which tabs the rail offers. The live chrome's own contents
// are covered by `chromeRender.test.ts`.

function onlineStore(over: Partial<Record<string, unknown>>): unknown {
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 1, username: "rrfarmer" });
  store.apply({
    type: "character/online",
    character: {
      characterID: 90000001,
      characterName: "Farmer",
      stationID: 60003760,
      structureID: null,
      solarSystemID: 30000142,
      corporationID: 1000001,
    },
    station: null,
  });
  store.apply({
    type: "flight/status",
    status: {
      inSpace: false,
      docked: false,
      solarSystemID: 30000142,
      stationID: null,
      structureID: null,
      shipID: null,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: null,
      shipSpeedFraction: null,
      ...over,
    },
  });
  return store;
}

test("the workspace's first paint on a DOCKED character renders the station shell, not the space HUD", async () => {
  const store = onlineStore({ docked: true, inSpace: false, stationID: 60003760 });
  const Workspace = await loadPanel("Workspace");
  const body = render(Workspace as never, { props: { store, flow: fakeFlow() } } as never).body;

  // The docked workspace: the docked badge, the docked-only Undock action, the
  // online pilot. (Post-windowing, the docked chrome is the header + station dock
  // panel rather than a services rail, but the docked-not-space guarantee holds.)
  assert.match(body, /Docked/, "no docked state badge");
  assert.match(body, /Undock/, "the docked Undock action is missing");
  // (No pilot-name assertion: the header deliberately does not repeat the
  // character bar's chip — the chip is the one "who am I flying" indicator.)
  // And NOT the in-space HUD.
  assert.doesNotMatch(body, /In Space/, "the space HUD leaked into the docked workspace");
});

test("the workspace's first paint on an IN-SPACE character renders the space HUD, not the station shell", async () => {
  const store = onlineStore({ docked: false, inSpace: true, stationID: null });
  const Workspace = await loadPanel("Workspace");
  const body = render(Workspace as never, { props: { store, flow: fakeFlow() } } as never).body;

  // The flight HUD: the in-space badge and the ship gauges.
  assert.match(body, /In Space/, "no in-space state badge");
  assert.match(body, /Shield/, "the ship HUD gauges are missing");
  // The exact old regression, re-expressed: an in-space character must NOT get
  // the docked station shell (its services rail / docked badge).
  assert.doesNotMatch(body, /Services/, "the station services rail leaked into space");
  assert.doesNotMatch(body, /Docked/, "the docked badge leaked into space");
});
