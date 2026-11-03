// Bundled EXAMPLE BOTS — one per play style, each a complete wired program a
// player can load, glance over, and start. They are typed against the format
// (a block renamed without updating an example fails to compile) and a test
// round-trips each through the CODEC and the VALIDATOR, so a bundled example
// can never be a program the import gate would refuse or the editor would
// flag. Every world slot uses a runtime binding ("nearest", "starting
// station", find-an-agent) so the examples work on ANY character, anywhere.

import { startingStation, type BotScript } from "./botScript.ts";

export interface ExampleBot {
  readonly key: string;
  /** The preset button label (R9a — play language). */
  readonly label: string;
  /** One line under the button. */
  readonly blurb: string;
  readonly doc: BotScript;
}

const FORMAT = { format: "evejs-bot-script", version: 1 } as const;

/** Mine → haul home → refine, forever; reps when shot, guns and drones on rats. */
const MINING_DAY: BotScript = {
  ...FORMAT,
  name: "Mining day",
  notes: "Mines the nearest belt, hauls home, refines, repeats.",
  home: startingStation(),
  interrupts: [
    { id: "w-shield", when: { kind: "shield-below", fraction: 0.5 }, respond: "repair" },
    { id: "w-rats", when: { kind: "hostile-on-grid" }, respond: "fight-back" },
    { id: "w-hull", when: { kind: "hull-below", fraction: 0.5 }, respond: "dock-and-pause" },
  ],
  program: [
    {
      id: "loop",
      kind: "loop",
      repeat: { kind: "forever" },
      body: [
        { id: "s1", kind: "macro", macro: "undock", args: {} },
        {
          id: "s2",
          kind: "macro",
          macro: "mine-at-belt",
          args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
          until: { kind: "ore-hold-at-least", fraction: 0.9 },
        },
        { id: "s3", kind: "macro", macro: "deliver-ore", args: { station: { kind: "station", ref: startingStation() } } },
        { id: "s4", kind: "macro", macro: "refine-ore", args: {} },
      ],
    },
  ],
};

/** The distribution-mission loop: find an agent once, then run deliveries. */
const DELIVERY_RUNS: BotScript = {
  ...FORMAT,
  name: "Delivery runs",
  notes: "Finds a delivery agent and runs missions back to back.",
  home: startingStation(),
  interrupts: [
    { id: "w-hull", when: { kind: "hull-below", fraction: 0.5 }, respond: "dock-and-pause" },
  ],
  program: [
    {
      id: "loop",
      kind: "loop",
      repeat: { kind: "times", count: 20 },
      body: [
        // Finding the agent is instant on every lap after the first (the run
        // remembers who it works with), so it lives inside the loop.
        { id: "s1", kind: "macro", macro: "find-distribution-agent", args: { level: { kind: "count", value: 1 } } },
        { id: "s2", kind: "macro", macro: "request-mission", args: {} },
        { id: "s3", kind: "macro", macro: "accept-mission", args: { maxJumps: { kind: "count", value: 6 } } },
        { id: "s4", kind: "macro", macro: "load-mission-cargo", args: {} },
        { id: "s5", kind: "macro", macro: "travel-to-dropoff", args: {} },
        { id: "s6", kind: "macro", macro: "turn-in-mission", args: {} },
        { id: "s7", kind: "macro", macro: "return-to-agent", args: {} },
      ],
    },
  ],
};

/** The ratting loop: den to den, guns + drones, loot then salvage the field. */
const RATTING_NIGHT: BotScript = {
  ...FORMAT,
  name: "Ratting night",
  notes: "Anomaly to anomaly: clear it, loot it, salvage it, next.",
  home: startingStation(),
  interrupts: [
    { id: "w-shield", when: { kind: "shield-below", fraction: 0.6 }, respond: "repair" },
    { id: "w-armor", when: { kind: "armor-below", fraction: 0.5 }, respond: "dock-and-pause" },
  ],
  program: [
    {
      id: "loop",
      kind: "loop",
      repeat: { kind: "forever" },
      body: [
        // Undock/hardeners finish instantly on every lap after the first, so
        // the whole night fits one loop (which is also the editor's shape).
        { id: "s1", kind: "macro", macro: "undock", args: {} },
        { id: "s2", kind: "macro", macro: "hardeners-on", args: {} },
        { id: "s3", kind: "macro", macro: "warp-to-anomaly", args: {} },
        { id: "s4", kind: "macro", macro: "fight-the-rats", args: {} },
        // Loot BEFORE salvaging: a salvaged wreck is gone and cannot be opened.
        { id: "s5", kind: "macro", macro: "loot-wrecks", args: {} },
        { id: "s6", kind: "macro", macro: "salvage-wrecks", args: {} },
      ],
    },
  ],
};

/** A branch demo, forever: mine a belt, haul home, then FORK on the ship's
 * shields — repair if it took a beating this lap, otherwise refine what it
 * mined. The branch lives INSIDE the loop, so the choice is made fresh each lap. */
const SMART_MINER: BotScript = {
  ...FORMAT,
  name: "Smart miner",
  notes: "Mines and hauls on a loop, then each lap either repairs the ship (if it got hurt) or refines the ore.",
  home: startingStation(),
  interrupts: [{ id: "w-hull", when: { kind: "hull-below", fraction: 0.4 }, respond: "dock-and-pause" }],
  program: [
    {
      id: "loop",
      kind: "loop",
      repeat: { kind: "forever" },
      body: [
        { id: "s1", kind: "macro", macro: "undock", args: {} },
        {
          id: "s2",
          kind: "macro",
          macro: "mine-at-belt",
          args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
          until: { kind: "ore-hold-at-least", fraction: 0.9 },
        },
        { id: "s3", kind: "macro", macro: "deliver-ore", args: { station: { kind: "station", ref: startingStation() } } },
        // Docked at home now — fork on how the shields held up THIS lap.
        {
          id: "br",
          kind: "branch",
          when: { kind: "shield-below", fraction: 0.6 },
          then: [{ id: "t1", kind: "macro", macro: "repair-ship", args: {} }],
          else: [{ id: "e1", kind: "macro", macro: "refine-ore", args: {} }],
        },
      ],
    },
  ],
};

/** A logistics pilot that joins the fleet, then keeps cycling reps and cap. */
const FLEET_MEDIC: BotScript = {
  ...FORMAT,
  name: "Fleet medic",
  notes: "Waits for a fleet invite, undocks, and keeps fleet-mates repaired and supplied with capacitor.",
  home: startingStation(),
  interrupts: [
    { id: "w-armor", when: { kind: "armor-below", fraction: 0.5 }, respond: "dock-and-pause" },
    { id: "w-cap", when: { kind: "capacitor-below", fraction: 0.2 }, respond: "pause" },
  ],
  program: [
    {
      id: "loop",
      kind: "loop",
      repeat: { kind: "forever" },
      body: [
        { id: "s1", kind: "macro", macro: "join-fleet", args: {} },
        { id: "s2", kind: "macro", macro: "undock", args: {} },
        { id: "s3", kind: "macro", macro: "hardeners-on", args: {} },
        { id: "s4", kind: "macro", macro: "remote-rep", args: {} },
        { id: "s5", kind: "macro", macro: "remote-cap", args: {} },
        { id: "s6", kind: "macro", macro: "wait", args: { seconds: { kind: "count", value: 4 } } },
      ],
    },
  ],
};

/** A close-orbit logistics anchor: sustained support until a watch or player stops it. */
const FLEET_ANCHOR: BotScript = {
  ...FORMAT,
  name: "Fleet anchor",
  notes: "Joins the fleet, hardens up, then stays close to a fleet-mate and keeps remote repairs running.",
  home: startingStation(),
  interrupts: [
    { id: "w-shield", when: { kind: "shield-below", fraction: 0.5 }, respond: "repair" },
    { id: "w-hull", when: { kind: "hull-below", fraction: 0.5 }, respond: "dock-and-pause" },
  ],
  program: [
    { id: "s1", kind: "macro", macro: "join-fleet", args: {} },
    { id: "s2", kind: "macro", macro: "undock", args: {} },
    { id: "s3", kind: "macro", macro: "hardeners-on", args: {} },
    { id: "s4", kind: "macro", macro: "orbit-and-boost", args: {} },
  ],
};

/** Explore a system's anomalies, with loot/salvage and a docked turnaround each lap. */
const ANOMALY_EXPEDITION: BotScript = {
  ...FORMAT,
  name: "Anomaly expedition",
  notes: "Clears up to six combat anomalies, brings the loot in, repairs, and heads back out.",
  home: startingStation(),
  interrupts: [
    { id: "w-armor", when: { kind: "armor-below", fraction: 0.5 }, respond: "dock-and-pause" },
    { id: "w-rats", when: { kind: "hostile-on-grid" }, respond: "alert" },
  ],
  program: [
    {
      id: "loop",
      kind: "loop",
      repeat: { kind: "times", count: 6 },
      body: [
        { id: "s1", kind: "macro", macro: "undock", args: {} },
        { id: "s2", kind: "macro", macro: "hardeners-on", args: {} },
        { id: "s3", kind: "macro", macro: "warp-to-anomaly", args: {} },
        { id: "s4", kind: "macro", macro: "fight-the-rats", args: {} },
        { id: "s5", kind: "macro", macro: "loot-wrecks", args: {} },
        { id: "s6", kind: "macro", macro: "salvage-wrecks", args: {} },
        { id: "s7", kind: "macro", macro: "dock-at-nearest", args: {} },
        { id: "s8", kind: "macro", macro: "unload-cargo", args: {} },
        { id: "s9", kind: "macro", macro: "repair-ship", args: {} },
      ],
    },
  ],
};

/**
 * Mine the system's ORE anomalies rather than its belts — the asteroid clusters
 * the scanner shows, which hold more and better rock than a belt does.
 *
 * ⚠ THE MINING STEP IS SET TO "SITE" MODE, NOT "NEAREST", AND THAT IS THE FIX
 * FOR A RUN THIS EXAMPLE USED TO LOSE. With `mode: "nearest"` the mine-at-belt
 * block's OWN rotation — not the warp-to-ore-anomaly step ahead of it — took
 * over the moment the anomaly it was parked in ran out of the wanted ore, and
 * "nearest" tours the system's asteroid BELTS, never its ore sites. A bot
 * whose blurb promised "the scanner's ore sites, not the belts" quietly became
 * a belt bot the instant one site ran dry, and a repair trip that relocated it
 * to its highsec home system — where the wanted ore cannot spawn on a belt
 * either — ended the run outright. `mode: "site"` makes that same mid-lap
 * rotation tour ore sites instead, so warp-to-ore-anomaly is still how the
 * ship reaches the first site each lap, but mine-at-belt itself now finishes
 * the lap without ever looking at a belt.
 */
const ANOMALY_MINING: BotScript = {
  ...FORMAT,
  name: "Anomaly mining",
  notes: "Flies the scanner's ore sites, mines each one out, hauls home and refines.",
  home: startingStation(),
  interrupts: [
    { id: "w-shield", when: { kind: "shield-below", fraction: 0.5 }, respond: "repair" },
    { id: "w-rats", when: { kind: "hostile-on-grid" }, respond: "fight-back" },
    { id: "w-hull", when: { kind: "hull-below", fraction: 0.5 }, respond: "dock-and-pause" },
  ],
  program: [
    {
      id: "loop",
      kind: "loop",
      repeat: { kind: "forever" },
      body: [
        { id: "s1", kind: "macro", macro: "undock", args: {} },
        { id: "s2", kind: "macro", macro: "warp-to-ore-anomaly", args: {} },
        {
          id: "s3",
          kind: "macro",
          macro: "mine-at-belt",
          args: { belt: { kind: "belt", belt: { mode: "site" } } },
          until: { kind: "ore-hold-at-least", fraction: 0.9 },
        },
        { id: "s4", kind: "macro", macro: "deliver-ore", args: { station: { kind: "station", ref: startingStation() } } },
        { id: "s5", kind: "macro", macro: "refine-ore", args: {} },
      ],
    },
  ],
};

/** A one-shot housekeeping run for the end of a session. */
const OPERATIONS_CLOSEOUT: BotScript = {
  ...FORMAT,
  name: "Operations closeout",
  notes: "Docks, unloads, repairs, and tidies the hangar.",
  home: startingStation(),
  interrupts: [],
  program: [
    { id: "s1", kind: "macro", macro: "dock-at-nearest", args: {} },
    { id: "s2", kind: "macro", macro: "unload-cargo", args: {} },
    { id: "s3", kind: "macro", macro: "repair-ship", args: {} },
    { id: "s4", kind: "macro", macro: "tidy-hangar", args: {} },
  ],
};

export const EXAMPLE_BOTS: readonly ExampleBot[] = Object.freeze([
  { key: "mining", label: "Mining day", blurb: "Mine, haul home, refine — forever.", doc: MINING_DAY },
  { key: "delivery", label: "Delivery runs", blurb: "Find an agent, run 20 deliveries.", doc: DELIVERY_RUNS },
  { key: "ratting", label: "Ratting night", blurb: "Den to den: fight, loot, salvage.", doc: RATTING_NIGHT },
  { key: "smart", label: "Smart miner", blurb: "Mine, haul, then repair or refine.", doc: SMART_MINER },
  { key: "fleet-medic", label: "Fleet medic", blurb: "Cycle remote repairs and capacitor support.", doc: FLEET_MEDIC },
  { key: "fleet-anchor", label: "Fleet anchor", blurb: "Stay close and keep fleet-mates repaired.", doc: FLEET_ANCHOR },
  { key: "anomaly-expedition", label: "Anomaly expedition", blurb: "Explore, clear, loot, salvage, turn around.", doc: ANOMALY_EXPEDITION },
  { key: "anomaly-mining", label: "Anomaly mining", blurb: "Mine the scanner's ore sites, not the belts.", doc: ANOMALY_MINING },
  { key: "operations-closeout", label: "Operations closeout", blurb: "Dock, unload, repair, tidy.", doc: OPERATIONS_CLOSEOUT },
]);
