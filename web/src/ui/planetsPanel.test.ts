// R41 as it actually RENDERS: the colonies, and what is on a planet.
//
// Screenshots have been unavailable to every worker on this repo — and the
// browser pane never flushes async panel content — so the only honest way to
// say "this is on screen" is to render the component and read the output. That
// is what this file does, through Svelte's server generator.
//
// Four claims are load-bearing and each is checked against real markup:
//
//   1. THREE OUTCOMES, FOUR SENTENCES, NONE OF THEM ALIKE. "Still loading",
//      "that read failed", "you genuinely have no colonies", and "this server
//      reported no colony information" are distinct facts about the world, and
//      only the third is a claim about the player. This is the defect class
//      this codebase keeps reproducing (worldHasNoContracts, ownsNothing).
//
//   2. NO NUMERIC IDs REACH THE PLAYER (R7d). A planet is "Tanoo I", a
//      structure is its name. planetIDs, pinIDs and typeIDs live only in keys,
//      icon URLs and onclick arguments. The sweep at the bottom has a COMPANION
//      test proving its regex actually matches an id when one is present —
//      three sweeps in this repo were once written with a template-literal
//      `\b`, which is the BACKSPACE character and matches nothing.
//
//   3. TIME ON SCREEN COMES FROM THE SERVER. The countdown is the program's own
//      expiry against the server's clock, and a finished extractor says so
//      rather than showing a negative number. The browser clock these tests
//      render against is FROZEN, and frozen five hours wrong on purpose, so a
//      panel that read it directly would be caught rather than merely lucky.
//
//   4. THE ICONS ARE REAL PICTURES OR DELIBERATE TILES (R27). Every image on
//      the page comes from the local cache; TypeIcon's lettered fallback is the
//      only other thing allowed.
//
// The standing invariants are re-proven on the new markup: R7d, R9a (plain
// player language — no group names, no "pin", no "ECU"), R8 (touch-sized
// controls, a table that reflows).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const Planets = (await import("./Planets.svelte")).default;
const { EMPTY_RECIPE_BOOK } = await import("../bridge/piRecipes.ts");
import type { PiIngredient, PiRecipeBook, PiSchematic } from "../bridge/piRecipes.ts";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "Planets.svelte"), "utf8");

const PLANET_ID = 40000002;
const SYSTEM_ID = 30000001;
const PLANET_TYPE_ID = 11;
const COMMAND_TYPE_ID = 2254;
const ECU_TYPE_ID = 3068;
const STORAGE_TYPE_ID = 2562;
const AQUEOUS_TYPE_ID = 2268;
const PIN_ID_COMMAND = 1;
const PIN_ID_RUNNING = 2;
const PIN_ID_FINISHED = 3;
const PIN_ID_STORAGE = 6;

const NOW = Date.UTC(2026, 6, 21, 12, 0, 0);
const HOUR = 3_600_000;

// ⚠ THE BROWSER CLOCK IS FROZEN, NOT SAMPLED. The panel's reference "now" is
// `Date.now() + clockOffsetMs`, and it samples Date.now() during render — a tick
// AFTER the scene was assembled. Deriving the offset from the real clock
// (`clockOffsetMs: NOW - Date.now()`) therefore left the countdown one or two
// milliseconds short of NOW, and since formatDuration FLOORS, a "21h 30m" that
// sits exactly on a minute boundary rendered as "21h 29m" whenever those two
// samples landed in different milliseconds. That was a real intermittent red,
// three runs in twenty, and no amount of "slack" in the fixture fixes it: the
// boundary is crossed by the first millisecond of drift, not by the first
// minute. Pinning Date.now() removes the sampling instead of padding it.
//
// Frozen FIVE HOURS BEHIND the server on purpose. `clockOffsetMs` has to carry
// those five hours for any of the time words to come out right, so a panel that
// ticked off the raw browser clock could not pass by accident — see the
// companion test below, which throws the offset away and watches the words
// change.
const BROWSER_NOW = NOW - 5 * HOUR;
const CLOCK_OFFSET = NOW - BROWSER_NOW;

/** Runs `body` with Date.now() pinned to the (deliberately wrong) browser clock. */
function atFrozenBrowserClock<T>(body: () => T): T {
  const realNow = Date.now;
  Date.now = () => BROWSER_NOW;
  try {
    return body();
  } finally {
    Date.now = realNow;
  }
}

function fakeFlow(): unknown {
  // The launches the window reads as it is built (planetWindow.py ReconstructWindow; flow.planetLaunches): read, and
  // none, so the window shows its colonies alone, as the client's does without launches.
  const none = { loaded: true, launches: [], error: null };
  const planetLaunches = { get: () => none, subscribe: (listener: (value: typeof none) => void) => (listener(none), () => {}) };
  return new Proxy({ planetLaunches } as Record<string, unknown>, { get: (held, key) => (typeof key === "string" && key in held ? held[key] : async () => {}) });
}

/** Everything a player can see, with markup stripped and whitespace collapsed. */
function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

interface SceneOptions {
  readonly loaded?: boolean;
  readonly error?: string | null;
  readonly coloniesReadable?: boolean;
  readonly empty?: boolean;
  readonly open?: boolean;
  /** Only the companion test sets this, to prove the offset is load-bearing. */
  readonly clockOffsetMs?: number;
  /** A different world, for the monitor tests. Defaults to the one colony. */
  readonly colonies?: readonly unknown[];
}

/** A pin with every field the BFF answers, so nothing reads as undefined. */
function pinState(overrides: Record<string, unknown>): unknown {
  return {
    contents: [],
    usedM3: 0,
    capacityM3: null,
    schematicID: null,
    schematicName: null,
    hasReceivedInputs: null,
    receivedInputsLastCycle: null,
    lastRunAtMs: NOW - 60_000,
    lastLaunchAtMs: null,
    program: null,
    ...overrides,
  };
}

function colonyState(): unknown {
  return {
    planetID: PLANET_ID,
    planetName: "Tanoo I",
    solarSystemID: SYSTEM_ID,
    solarSystemName: "Tanoo",
    planetTypeID: PLANET_TYPE_ID,
    planetTypeName: "Planet (Temperate)",
    commandCenterLevel: 3,
    lastSimulatedAtMs: NOW - 60_000,
    linkCount: 4,
    links: [],
    pins: [
      pinState({
        pinID: PIN_ID_RUNNING,
        typeID: ECU_TYPE_ID,
        typeName: "Temperate Extractor Control Unit",
        kind: "extractor-control",
        capacityM3: null,
        program: {
          resourceTypeID: AQUEOUS_TYPE_ID,
          resourceTypeName: "Aqueous Liquids",
          cycleTimeSeconds: 3600,
          quantityPerCycle: 2841,
          installedAtMs: NOW - 3 * HOUR,
          // Half an hour off the hour boundary ON PURPOSE, but not for drift:
          // formatDuration collapses a zero remainder to a bare "21 hours", so
          // the spare 30m is what exercises the "21h 30m" shape at all. Landing
          // exactly on the boundary is safe because the clock is frozen.
          expiresAtMs: NOW + 21 * HOUR + HOUR / 2,
          headCount: 3,
        },
      }),
      pinState({
        pinID: PIN_ID_FINISHED,
        typeID: ECU_TYPE_ID,
        typeName: "Temperate Extractor Control Unit",
        kind: "extractor-control",
        program: {
          resourceTypeID: 2073,
          resourceTypeName: "Microorganisms",
          cycleTimeSeconds: 1800,
          quantityPerCycle: 1204,
          installedAtMs: NOW - 48 * HOUR,
          expiresAtMs: NOW - 2 * HOUR,
          headCount: 1,
        },
      }),
      pinState({
        pinID: PIN_ID_STORAGE,
        typeID: STORAGE_TYPE_ID,
        typeName: "Temperate Storage Facility",
        kind: "storage",
        contents: [
          { typeID: AQUEOUS_TYPE_ID, typeName: "Aqueous Liquids", quantity: 12000 },
        ],
        // 12,000 units of a 0.005 m³ commodity: the biggest pile on the
        // planet, and 60 m³ of a 12,000 m³ facility.
        usedM3: 60,
        capacityM3: 12000,
      }),
      pinState({
        pinID: PIN_ID_COMMAND,
        typeID: COMMAND_TYPE_ID,
        typeName: "Temperate Command Center",
        kind: "command",
        usedM3: 0,
        capacityM3: 500,
      }),
    ],
    routes: [
      {
        routeID: 1,
        path: [PIN_ID_RUNNING, PIN_ID_STORAGE],
        commodityTypeID: AQUEOUS_TYPE_ID,
        commodityTypeName: "Aqueous Liquids",
        commodityQuantity: 2841,
      },
    ],
  };
}

function scene(options: SceneOptions = {}) {
  return atFrozenBrowserClock(() => {
    const store = createClientStore();
    if (options.loaded !== false) {
      store.apply({
        type: "planets/loaded",
        colonies: (options.empty
          ? []
          : (options.colonies ?? [colonyState()])) as never,
        coloniesReadable: options.coloniesReadable ?? true,
        // The panel's "now" is Date.now() + this. Date.now() is pinned to a
        // browser five hours behind, so this offset is what puts "now" on NOW.
        clockOffsetMs: options.clockOffsetMs ?? CLOCK_OFFSET,
      });
      if (options.error) {
        store.apply({ type: "planets/error", message: options.error });
      }
      if (options.open) {
        store.apply({ type: "planets/selected", planetID: PLANET_ID });
      }
    }
    const output = render(Planets as never, {
      props: { store, flow: fakeFlow() },
    } as never);
    return { body: output.body, text: visibleText(output.body) };
  });
}

// --- 1. Four outcomes, four sentences ---------------------------------------

test("before the first read the page says it is looking, and claims nothing", () => {
  const { text } = scene({ loaded: false });
  assert.match(text, /Looking for your colonies/i);
  assert.doesNotMatch(text, /have not built/i);
  assert.doesNotMatch(text, /could not be read/i);
});

test("a FAILED read never says the player has no colonies", () => {
  const { text } = scene({ error: "Your colonies could not be read: the gateway is down" });
  assert.match(text, /could not be read/i);
  // ⚠ THE DEFECT THIS GUARDS. A failed read must not render as an empty world.
  assert.doesNotMatch(text, /have not built/i);
  assert.doesNotMatch(text, /no colon/i);
});

test("a SUCCESSFUL empty read is the only thing that tells a player they own nothing", () => {
  const { text } = scene({ empty: true, coloniesReadable: true });
  assert.match(text, /have not built on any planet/i);
  assert.doesNotMatch(text, /could not be read/i);
  // And it says what to do about it, rather than just stating a void (R9a).
  assert.match(text, /command centre/i);
});

test("a server that reported no colony information says exactly that, and no more", () => {
  const { text } = scene({ empty: true, coloniesReadable: false });
  assert.match(text, /did not report any colony information/i);
  // ⚠ The fourth case. It must NOT be worded as a fact about the player.
  assert.doesNotMatch(text, /have not built/i);
  // And it must say so out loud, because an absence is not evidence.
  assert.match(text, /not the same as having no colonies/i);
});

// --- 2. What a colony looks like --------------------------------------------

test("a colony is a place with a name, and its state in a sentence", () => {
  const { text } = scene();
  assert.match(text, /Tanoo I/);
  assert.match(text, /Tanoo/);
  // One extractor has finished; that is what a player needs to know first.
  assert.match(text, /finished its program/i);
});

// --- 2b. The monitor: which planet needs you, without opening one -----------

/** A colony of exactly these pins, for the monitor's own scenes. */
function worldColony(pins: readonly unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
    ...(colonyState() as Record<string, unknown>),
    pins,
    routes: [],
    linkCount: pins.length,
    links: [],
    ...overrides,
  };
}

function healthyExtractor(): unknown {
  return pinState({
    pinID: PIN_ID_RUNNING,
    typeID: ECU_TYPE_ID,
    typeName: "Temperate Extractor Control Unit",
    kind: "extractor-control",
    program: {
      resourceTypeID: AQUEOUS_TYPE_ID,
      resourceTypeName: "Aqueous Liquids",
      cycleTimeSeconds: 3600,
      quantityPerCycle: 2841,
      installedAtMs: NOW - 3 * HOUR,
      expiresAtMs: NOW + 48 * HOUR,
      headCount: 3,
    },
  });
}

test("the page names the planet that needs you before anything is opened", () => {
  const { text } = scene();
  assert.match(text, /One planet needs you now/i);
  assert.match(text, /Tanoo I/);
  // The REASON, not just the alarm: which extractor, and what it was pulling.
  assert.match(text, /finished pulling Microorganisms/i);
  // And how stale it is, on the server's clock — the browser's is 5h wrong.
  assert.match(text, /2 hours ago/);
});

test("a full hold is visible even when every extractor is healthy", () => {
  // ⚠ THE CASE THE OLD LINE COULD NOT DESCRIBE. Before the monitor, this
  // colony read as "Extracting — next program ends in 2 days" and the pad
  // backing up behind it was invisible until the player opened the planet.
  const { text } = scene({
    colonies: [worldColony([
      healthyExtractor(),
      pinState({
        pinID: PIN_ID_STORAGE,
        typeID: STORAGE_TYPE_ID,
        typeName: "Temperate Launchpad",
        kind: "launchpad",
        usedM3: 9900,
        capacityM3: 10000,
      }),
    ])],
  });

  assert.match(text, /One planet needs you now/i);
  assert.match(text, /Temperate Launchpad is 99% full/);
  assert.match(text, /1 hold is full/);
  assert.doesNotMatch(text, /next program ends/i);
});

test("a colony with nothing waiting gets no notice at all", () => {
  // Silence is the answer a player has to be able to trust — no "all good"
  // banner, because a banner that is always there stops being read.
  const { text } = scene({
    colonies: [worldColony([
      healthyExtractor(),
      pinState({
        pinID: PIN_ID_COMMAND,
        typeID: COMMAND_TYPE_ID,
        typeName: "Temperate Command Center",
        kind: "command",
        usedM3: 0,
        capacityM3: 500,
      }),
    ])],
  });

  assert.doesNotMatch(text, /needs you/i);
  assert.doesNotMatch(text, /coming up/i);
  assert.doesNotMatch(text, /% full/);
  // The colony is still listed, with the sentence it always had.
  assert.match(text, /Tanoo I/);
  assert.match(text, /next program ends/i);
});

test("a hold reads as a volume, not only as a pile of units", () => {
  const { text } = scene({ open: true });
  // ⚠ The separator is deliberately loose: this repo's host renders grouped
  // numbers with a narrow no-break space and CI with a comma, and that
  // difference is not what this test is about.
  assert.match(text, /60 of 12.000 m3 - 0% full/);
  // The unit count is still there beside it — both readings are useful, and
  // only together do they say "the biggest pile here is half a percent".
  assert.match(text, /Aqueous Liquids \(12.000 units\)/);
  // A pin with no capacity at all (an extractor) says nothing about fill.
  assert.doesNotMatch(text, /Temperate Extractor Control Unit[\s\S]{0,120}% full/);
});

test("a factory says what it makes, and is only called starved when the server said so", () => {
  const fed = pinState({
    pinID: 4,
    typeID: 2481,
    typeName: "Temperate Basic Industry Facility",
    kind: "factory",
    schematicID: 65,
    schematicName: "Superconductors",
    hasReceivedInputs: true,
    receivedInputsLastCycle: true,
  });
  const openScene = scene({ open: true, colonies: [worldColony([healthyExtractor(), fed])] });
  assert.match(openScene.text, /Making Superconductors/);
  assert.doesNotMatch(openScene.text, /fed nothing/i);

  // ⚠ Only an explicit false. A null flag — which every non-factory pin
  // carries — must never render as starvation.
  const starved = pinState({
    pinID: 4,
    typeID: 2481,
    typeName: "Temperate Basic Industry Facility",
    kind: "factory",
    schematicID: 65,
    schematicName: "Superconductors",
    hasReceivedInputs: true,
    receivedInputsLastCycle: false,
  });
  const dry = scene({ open: true, colonies: [worldColony([healthyExtractor(), starved])] });
  // No route and no recipe table: nothing can be feeding it, which is a fault.
  assert.match(dry.text, /No route brings anything to the factory making Superconductors/);
  assert.match(dry.text, /1 factory has nothing coming in/);
});

// --- 2c. R108 slice 2: a factory's recipe (rate and ingredients) ------------

const FACTORY_PIN_ID = 4;
const FACTORY_TYPE_ID = 2481;
const SCHEMATIC_ID = 65;
const OUTPUT_TYPE_ID = 9838;
const INGREDIENT_TYPE_ID = 2389;

/** A factory pin with sane defaults, matching the fixture already used above. */
function factoryPin(overrides: Record<string, unknown> = {}): unknown {
  return pinState({
    pinID: FACTORY_PIN_ID,
    typeID: FACTORY_TYPE_ID,
    typeName: "Temperate Basic Industry Facility",
    kind: "factory",
    schematicID: SCHEMATIC_ID,
    schematicName: "Superconductors",
    hasReceivedInputs: true,
    receivedInputsLastCycle: null,
    ...overrides,
  });
}

/** A recipe book that names Superconductors' rate and one ingredient. */
function recipeBook(): PiRecipeBook {
  const input: PiIngredient = { typeID: INGREDIENT_TYPE_ID, typeName: "Plasmoids", quantity: 40 };
  const output: PiIngredient = { typeID: OUTPUT_TYPE_ID, typeName: "Superconductors", quantity: 5 };
  const sch: PiSchematic = {
    schematicID: SCHEMATIC_ID,
    name: "Superconductors",
    cycleTimeSeconds: 3600,
    factoryTypeIDs: [],
    inputs: [input],
    output,
  };
  return {
    schematics: Object.freeze([sch]),
    bySchematicID: new Map([[SCHEMATIC_ID, sch]]),
    byOutputTypeID: new Map([[OUTPUT_TYPE_ID, sch]]),
    commodities: new Map(),
    readable: true,
  };
}

/**
 * An open colony holding exactly these pins, with the recipe book applied
 * (or not) AFTER the colony read — mirroring how the real app lands the two
 * reads separately (see bridge/piFactoryWords.ts's header).
 */
function sceneWithRecipes(pins: readonly unknown[], recipes: PiRecipeBook | null) {
  return atFrozenBrowserClock(() => {
    const store = createClientStore();
    store.apply({
      type: "planets/loaded",
      colonies: [worldColony(pins)] as never,
      coloniesReadable: true,
      clockOffsetMs: CLOCK_OFFSET,
    });
    if (recipes) {
      store.apply({ type: "planets/recipes", recipes });
    }
    store.apply({ type: "planets/selected", planetID: PLANET_ID });
    const output = render(Planets as never, { props: { store, flow: fakeFlow() } } as never);
    return { body: output.body, text: visibleText(output.body) };
  });
}

test("a factory with a recipe in the book renders what it makes, its rate and its ingredients", () => {
  const { text } = sceneWithRecipes([healthyExtractor(), factoryPin()], recipeBook());
  assert.match(text, /Making Superconductors/);
  assert.match(text, /5 every 1 hour/);
  assert.match(text, /needs 40 Plasmoids/);
});

test("an unreadable recipe book still shows Making <name> exactly as before, with no rate and no ingredients line", () => {
  // ⚠ THE DEGRADE CASE. A missing/empty book must never blank the line that
  // already worked — it may only take away the rate and the ingredients.
  const { text } = sceneWithRecipes([healthyExtractor(), factoryPin()], EMPTY_RECIPE_BOOK);
  assert.match(text, /Making Superconductors/);
  assert.doesNotMatch(text, /every/);
  assert.doesNotMatch(text, /needs \d/);
});

test('"fed nothing last cycle" still appears alongside the new clauses when the server said false, and not when it is null', () => {
  const starved = sceneWithRecipes(
    [healthyExtractor(), factoryPin({ receivedInputsLastCycle: false })],
    recipeBook(),
  );
  assert.match(starved.text, /Making Superconductors/);
  assert.match(starved.text, /5 every 1 hour/);
  assert.match(starved.text, /fed nothing last cycle/i);
  // With the recipe table the panel judges by what the factory NEEDS, so the
  // missing input is named rather than "anything".
  assert.match(starved.text, /No route brings \S.* to the factory making Superconductors/);
  assert.doesNotMatch(starved.text, /No route brings anything/);

  const fed = sceneWithRecipes(
    [healthyExtractor(), factoryPin({ receivedInputsLastCycle: null })],
    recipeBook(),
  );
  assert.doesNotMatch(fed.text, /fed nothing/i);
});

test("a factory with no recipe set at all still reads No recipe set", () => {
  const { text } = sceneWithRecipes(
    [healthyExtractor(), factoryPin({ schematicID: null, schematicName: null })],
    recipeBook(),
  );
  assert.match(text, /No recipe set/);
  assert.doesNotMatch(text, /every/);
  assert.doesNotMatch(text, /needs \d/);
});

test("COMPANION: the factory id sweep's regex really does match a string containing an id", () => {
  // ⚠ Same trap as the sweep below: a template-literal `\b` is the BACKSPACE
  // character, not a word boundary, and would match nothing at all.
  const pattern = new RegExp(`\\b${SCHEMATIC_ID}\\b`);
  assert.match(` schematic ${SCHEMATIC_ID} here `, pattern);
  assert.doesNotMatch(" schematic Superconductors here ", pattern);
  assert.equal(pattern.source.charCodeAt(0), "\\".charCodeAt(0));
  assert.notEqual(pattern.source.charCodeAt(0), 8);
});

test("no schematicID or ingredient typeID leaks onto the factory line", () => {
  const { text } = sceneWithRecipes([healthyExtractor(), factoryPin()], recipeBook());
  for (const id of [SCHEMATIC_ID, INGREDIENT_TYPE_ID, OUTPUT_TYPE_ID, FACTORY_TYPE_ID]) {
    assert.doesNotMatch(
      text,
      new RegExp(`\\b${id}\\b`),
      `id ${id} leaked to the player`,
    );
  }
});

test("opening a colony shows what is on the planet, in player words", () => {
  const { text } = scene({ open: true });
  assert.match(text, /Temperate Command Center/);
  assert.match(text, /Temperate Storage Facility/);
  assert.match(text, /Aqueous Liquids/);
  assert.match(text, /12,000 units/);
  assert.match(text, /command centre level 3/i);
  assert.match(text, /4 links/);
});

test("a running program counts down, and a finished one says finished", () => {
  const { text } = scene({ open: true });
  // 21h 30m left on the server's clock — never a raw instant, never negative.
  assert.match(text, /Running — 21h 30m left/);
  assert.match(text, /Finished — this extractor has stopped/);
  assert.doesNotMatch(text, /-\d+ (hour|minute|day)/);
  // The server's own cycle numbers are shown as given.
  assert.match(text, /2,841 per 1 hour cycle/);
  assert.match(text, /3 heads/);
});

test("COMPANION: that countdown is the SERVER's clock, not the frozen browser's", () => {
  // ⚠ THE MINUTE-EXACT ASSERTION ABOVE IS ONLY MEANINGFUL IF THE OFFSET IS
  // CARRYING THE FIVE HOURS. Throw it away and the same fixture must read
  // differently: the running program is five hours further out, and the
  // extractor that finished two hours ago has not finished yet. Without this,
  // a future "simplification" to clockOffsetMs: 0 — or a panel that started
  // ticking off Date.now() directly — could pass for the wrong reason.
  assert.equal(BROWSER_NOW + CLOCK_OFFSET, NOW);
  assert.notEqual(CLOCK_OFFSET, 0);

  const { text } = scene({ open: true, clockOffsetMs: 0 });
  assert.doesNotMatch(text, /Running — 21h 30m left/);
  assert.doesNotMatch(text, /Finished — this extractor has stopped/);
});

test("commodities pool into one \"everything stored here\" list", () => {
  const { text } = scene({ open: true });
  assert.match(text, /Everything stored here/i);
  assert.match(text, /Aqueous Liquids — 12,000 units/);
});

// --- 3. R27: real pictures, from the local cache only -----------------------

test("every picture on the page comes from the LOCAL icon cache", () => {
  const { body } = scene({ open: true });
  const sources = [...body.matchAll(/<img[^>]*src="([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(sources.length > 0, "the panel renders no pictures at all");
  for (const source of sources) {
    assert.ok(
      source.startsWith("/client-res/type-picture/"),
      `icon must come from the local cache, got ${source}`,
    );
  }
});

test("the planet and its structures ask for their OWN type icons", () => {
  const { body } = scene({ open: true });
  for (const typeID of [PLANET_TYPE_ID, COMMAND_TYPE_ID, ECU_TYPE_ID, STORAGE_TYPE_ID]) {
    assert.ok(
      body.includes(`/client-res/type-picture/${typeID}/64.png`),
      `no icon requested for type ${typeID}`,
    );
  }
});

// --- 4. R7d: nothing numeric reaches the player -----------------------------

test("COMPANION: the id sweep's regex really does match a string containing an id", () => {
  // ⚠ THIS TEST EXISTS BECAUSE THE SWEEP BELOW CANNOT PROVE ITSELF. Three
  // sweeps in this repo were once written as `\b${id}\b` inside a TEMPLATE
  // literal, where `\b` is the BACKSPACE character (charCode 8) and the pattern
  // matched nothing at all — so the sweep passed while asserting nothing.
  const pattern = new RegExp(`\\b${PLANET_ID}\\b`);
  assert.match(` the planet is ${PLANET_ID} here `, pattern);
  assert.doesNotMatch(" the planet is Tanoo I here ", pattern);
  // And the escape really is a word boundary, not a control character.
  assert.equal(pattern.source.charCodeAt(0), "\\".charCodeAt(0));
  assert.notEqual(pattern.source.charCodeAt(0), 8);
});

test("no planetID, pinID, systemID or typeID is ever visible to the player", () => {
  const { text } = scene({ open: true });
  for (const id of [
    PLANET_ID,
    SYSTEM_ID,
    PLANET_TYPE_ID,
    COMMAND_TYPE_ID,
    ECU_TYPE_ID,
    STORAGE_TYPE_ID,
    AQUEOUS_TYPE_ID,
  ]) {
    assert.doesNotMatch(
      text,
      new RegExp(`\\b${id}\\b`),
      `id ${id} leaked to the player`,
    );
  }
});

test("an unnamed planet still reads as a place, not as a number", () => {
  const text = atFrozenBrowserClock(() => {
    const store = createClientStore();
    const unnamed = { ...(colonyState() as Record<string, unknown>), planetName: null };
    store.apply({
      type: "planets/loaded",
      colonies: [unnamed] as never,
      coloniesReadable: true,
      clockOffsetMs: CLOCK_OFFSET,
    });
    return visibleText(
      render(Planets as never, { props: { store, flow: fakeFlow() } } as never).body,
    );
  });
  assert.match(text, /a planet in Tanoo/);
  assert.doesNotMatch(text, new RegExp(`\\b${PLANET_ID}\\b`));
});

// --- 5. R9a plain language, R8 real controls --------------------------------

test("the page never uses the emulator's vocabulary", () => {
  const { text } = scene({ open: true });
  for (const jargon of [
    "pinID",
    "planetID",
    "ECU",
    "Extractor Control Unit pin",
    "coloniesByKey",
    "schematicID",
    "programType",
    "FILETIME",
  ]) {
    assert.doesNotMatch(
      text,
      new RegExp(jargon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `${jargon} is emulator vocabulary and must not be on screen`,
    );
  }
});

test("the controls are real buttons, and the table reflows on a phone (R8)", () => {
  const { body } = scene();
  assert.match(body, /<button[^>]*>\s*Refresh/);
  assert.match(body, /<button[^>]*>\s*See this colony/);
  // The wide record table scrolls inside its own box and reflows to cards,
  // so the page body never scrolls sideways.
  assert.match(body, /class="[^"]*table-wrap[^"]*overflow-x-auto/);
  assert.match(body, /class="[^"]*reflow/);
  // Every cell carries the label its card form shows.
  assert.match(body, /data-label="Planet"/);
  assert.match(body, /data-label="System"/);
  assert.match(body, /data-label="State"/);
});

test("the panel reads state and never computes a colony itself", () => {
  // A grep-level guard: the arithmetic lives in bridge/planets.ts, and the
  // panel must not grow its own yield/cycle maths.
  for (const forbidden of ["Math.pow", "yieldPerCycle", "* 0.99", "richness"]) {
    assert.ok(
      !SOURCE.includes(forbidden),
      `${forbidden} is a colony mechanic and does not belong in the panel`,
    );
  }
  // And it must go through the shared decoder's helpers rather than reinvent.
  assert.match(SOURCE, /from "\.\.\/bridge\/planets\.ts"/);
});
