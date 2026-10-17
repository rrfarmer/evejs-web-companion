// A2 — the Bot Builder codec: the ONE gate every document passes through, from a
// paste, a file, the BFF, or localStorage, before anything trusts it.
//
// ⚠ EVERY BYTE IS UNTRUSTED — imported or stored. A script drives an unattended
// ship; a malformed one must never reach the runner. So this reads the raw value
// FIELD BY FIELD in the bridge-decoder style (own properties only, no spread, no
// copy), and answers in exactly two ways:
//
//   • REFUSE the whole file, with one plain sentence (R9a). There is NO
//     import-with-holes: a script with a silently dropped action is a different
//     program, and "every branch bounded" reasoning dies the moment a hole
//     exists. First failure refuses.
//   • ACCEPT, with WARNINGS for the things it safely fixed — an out-of-range
//     number clamped to the same bound the editor uses, control characters
//     stripped, an absurd saved location forgotten, a missing safety cut-off
//     added. Clamp-with-a-spoken-warning beats a silent clamp (dishonest) and a
//     refusal (hostile to a hand-edited share).
//
// The refusal and warning sentences are player-facing, so they are plain and —
// critically — they NEVER echo an attacker's string unsanitised (an unknown
// macro name is stripped to a short safe token before it is quoted). There is no
// injected safety floor any more — watches are entirely the player's — but an
// OLD document that still carries the retired `builtIn` flag on an interrupt
// must still LOAD: the key is accepted and simply dropped, never preserved and
// never grounds for refusal.

import {
  MAX_DOC_BYTES,
  MAX_INTERRUPTS,
  MAX_NAME_LEN,
  MAX_NOTES_LEN,
  MAX_ORE_HOLD_FRACTION,
  MAX_PROGRAM_NODES,
  MAX_REPEAT_TIMES,
  MAX_TOTAL_STEPS,
  INTERRUPT_RESPONSES,
  MAX_CONDITION_FRACTION,
  MAX_COUNT_ARG,
  MAX_DISTANCE_KM_ARG,
  MAX_ISK_ARG,
  MAX_QTY_ARG,
  MIN_CONDITION_FRACTION,
  MIN_COUNT_ARG,
  MIN_DISTANCE_KM_ARG,
  MIN_ISK_ARG,
  MIN_QTY_ARG,
  MIN_REPEAT_TIMES,
  ITEM_PLACES,
  MAX_CORP_DIVISION,
  MIN_CORP_DIVISION,
  ROCK_PICKS,
  PROP_MODE_ARGS,
  TARGET_CLASS_ARGS,
  SQUAD_ROLE_ARGS,
  type ItemMatchArg,
  type PlanetPickArg,
  MAX_BAY_LIST,
  MAX_ITEM_LIST,
  MAX_PLANET_LIST,
  MAX_ITEM_PATTERN_LEN,
  MAX_ORE_LIST,
  MAX_TARGET_LIST,
  MAX_TEXT_ARG_LEN,
  SCRIPT_FORMAT,
  SCRIPT_VERSION,
  conditionAllowedAt,
  BOARD_SLOTS,
  countProgramNode,
  type Arg,
  type RockPick,
  type PropModeArg,
  type TargetClassArg,
  type SquadRoleArg,
  type OreFamilyArg,
  type BoardSlot,
  type BeltArg,
  type BotScript,
  type BranchBlock,
  type Condition,
  type LoopBodyNode,
  type SubBotNode,
  type ConditionSite,
  type InterruptResponse,
  type InterruptRow,
  type ItemPlace,
  type LoopBlock,
  type MacroID,
  type MacroStep,
  type ProgramNode,
  type Repeat,
  type WorldEntity,
  type WorldRef,
} from "./botScript.ts";
import { MACRO_SPECS, type MacroSpec } from "./macroSpecs.ts";

// ─── Result ──────────────────────────────────────────────────────────────────

export type DecodeResult =
  | { readonly ok: true; readonly doc: BotScript; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly refusal: string };

// ─── What the codec knows a valid document may contain ───────────────────────
//
// The RUNTIME behaviour of each macro is a later slice (nav/macros); this is only
// the structural spec — which arguments a macro takes, and whether it must carry
// an `until`. It lives with the codec because "what a valid file may hold" is the
// codec's question, and a macro added to the runner without a spec entry here
// simply cannot be imported until it gets one.

const KNOWN_MACROS = new Set<string>(Object.keys(MACRO_SPECS));
// These were valid v1 script constructs while the browser owned chat. Preserve
// their names only to refuse old saved/imported documents plainly; never add
// them back to the authoring schema.
const RETIRED_WEB_COMPANION_MACROS = new Set(["attack-player", "hunt-player", "send-chat"]);
const RETIRED_WEB_COMPANION_CHAT_CONDITIONS = new Set(["players-in-system-above"]);
// Derived from the format's own list, so a new response can never be forgotten here.
const KNOWN_RESPONSES = new Set<InterruptResponse>(INTERRUPT_RESPONSES);
const WORLD_ENTITIES = new Set<WorldEntity>(["station", "structure", "belt", "agent", "system"]);
const DOC_KEYS = new Set(["format", "version", "name", "notes", "home", "interrupts", "program"]);

const MAX_ID_LEN = 40;
const STRUCTURE_ID_FLOOR = 1_000_000_000_000;
export const MAX_WORLD_NAME_LEN = 100;
const MAX_ECHO_LEN = 24;

// ─── Player sentences ────────────────────────────────────────────────────────

const SAY = {
  tooBig: "This file is too big to be a bot script.",
  notJson: "This file is not a bot script.",
  notObject: "This file is not a bot script.",
  wrongFormat: "This file is not a bot script.",
  newerVersion:
    "This script was made with a newer version of the Bot Builder. Update this app, or export the script again from the version you are running.",
  badVersion: "This file is not a bot script.",
  unknownKey: "This script has parts this app does not recognise.",
  noName: "This script has no name.",
  noHome: "This script does not say which station to dock at when it breaks off.",
  emptyProgram: "This script has no steps.",
  tooManyNodes: "This script has too many steps.",
  tooManySteps: "This script has too many steps.",
  tooManyInterrupts: "This script is watching for too many things at once.",
  unknownNode: "This script has a step this app does not understand.",
  unknownMacro: (safe: string): string =>
    safe.length > 0
      ? `This script uses an action this app does not have: "${safe}".`
      : "This script uses an action this app does not have.",
  retiredWebCompanionFeature: (safe: string): string =>
    safe.length > 0
      ? `This script uses "${safe}", which is no longer available in the web companion.`
      : "This script uses a feature that is no longer available in the web companion.",
  unknownCondition: "This script uses a check this app does not have.",
  conditionOffSite:
    "This script checks for something out in space at a point where the ship may not be there yet.",
  missingArg: (label: string): string => `A step is missing something it needs: ${label}.`,
  unknownArg: "A step has a setting this app does not recognise.",
  badArg: (label: string): string => `A step's ${label} is not set up correctly.`,
  badNumber: "A number in this script is not a real number.",
  untilRequired: "A mining step must say when to stop.",
  noRepeat: "Every loop must say how many times it may repeat.",
  emptyLoop: "A loop has no steps inside it.",
  nestedLoop: "A loop cannot contain another loop.",
  nestedBranch: "A branch cannot contain a loop or another branch.",
  emptyBranch: "A branch has no steps in either choice.",
  subBotInLoop: "A saved bot can only be run as a step of its own, not inside a repeat or a branch.",
  badResponse: "This script answers a warning in a way this app does not know.",
} as const;

/**
 * The bay keys a document may name. The BFF's own vocabulary (R40's SHIP_BAYS),
 * spelled out here because the codec must be able to refuse a key the runner
 * would silently ignore — a "leave my ammo alone" that protects nothing is worse
 * than a rejected import.
 */
const KNOWN_BAY_KEYS: ReadonlySet<string> = new Set([
  "cargo", "drone", "shipMaintenance", "fuel", "ore", "gas", "mineral", "salvage",
  "ship", "smallShip", "mediumShip", "largeShip", "industrialShip", "ammo",
  "commandCenter", "planetary", "quafe", "fleet", "fighter", "corpse", "booster",
  "subsystem", "ice", "asteroid", "mobileDepot", "colony", "expedition",
]);

const WARN = {
  strippedControl: "Removed some characters from a name that cannot be shown.",
  clampFraction: (label: string, toFraction: number): string =>
    `${label} was brought back to ${Math.round(toFraction * 100)}%.`,
  clampRepeat: (to: number): string => `A loop's repeat count was brought into range (now ${to}).`,
  clampCount: (label: string, to: number): string => `A step's ${label} was brought into range (now ${to}).`,
  clampIsk: (to: number): string => `A wallet amount was brought into range (now ${to.toLocaleString()} ISK).`,
  forgotWorldId: "A saved location did not look valid and was forgotten — pick it again.",
  reassignedIds: "Renamed some step handles that were missing or repeated.",
  droppedDuplicateOres: "Removed repeated entries from an ore priority list.",
  droppedUnknownBays: "Removed bays this app does not know from a step's leave-alone list.",
  droppedUnknownTargets: "Removed kinds of target this app does not know from a step's priority list.",
  droppedWatchCombatSettings: "A watch that does not fight carried fighting settings; they were removed.",
  truncatedOreList: (max: number): string => `An ore priority list was cut down to ${max} entries.`,
} as const;

// ─── Refusal as control flow ─────────────────────────────────────────────────
// A first-failure-refuses reader is far clearer with an internal throw caught at
// the boundary than with a result monad threaded through forty helpers.

class ScriptRefusal extends Error {
  readonly sentence: string;
  constructor(sentence: string) {
    super(sentence);
    this.name = "ScriptRefusal";
    this.sentence = sentence;
  }
}
function refuse(sentence: string): never {
  throw new ScriptRefusal(sentence);
}

interface Ctx {
  warn(sentence: string): void;
}

// ─── Entry points ────────────────────────────────────────────────────────────

/** Decode from raw TEXT (a paste, a file, a localStorage string). Caps bytes before parsing. */
export function decodeScriptText(text: string): DecodeResult {
  if (byteLength(text) > MAX_DOC_BYTES) {
    return { ok: false, refusal: SAY.tooBig };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, refusal: SAY.notJson };
  }
  return decodeScriptValue(raw);
}

/** Decode from an already-parsed value (a BFF row, a bundled template). */
export function decodeScriptValue(raw: unknown): DecodeResult {
  const warnings: string[] = [];
  const ctx: Ctx = { warn: (s) => warnings.push(s) };
  try {
    const doc = readDocument(raw, ctx);
    return { ok: true, doc, warnings };
  } catch (err) {
    if (err instanceof ScriptRefusal) {
      return { ok: false, refusal: err.sentence };
    }
    // A reader threw something unexpected — treat the file as unreadable rather
    // than leaking a stack. This should not happen; the readers refuse cleanly.
    return { ok: false, refusal: SAY.notObject };
  }
}

/**
 * Serialise a document to stable, diff-able text — fixed key order, two-space
 * indent. Storage metadata never lives in a ScriptDoc, so there is nothing to
 * strip; what goes out is exactly the shareable document.
 */
export function encodeScriptDoc(doc: BotScript): string {
  return JSON.stringify(orderDoc(doc), null, 2);
}

// ─── Document ────────────────────────────────────────────────────────────────

function readDocument(raw: unknown, ctx: Ctx): BotScript {
  const obj = asObject(raw, SAY.notObject);

  for (const key of Object.keys(obj)) {
    if (!DOC_KEYS.has(key)) {
      refuse(SAY.unknownKey);
    }
  }

  if (obj["format"] !== SCRIPT_FORMAT) {
    refuse(SAY.wrongFormat);
  }

  const version = obj["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    refuse(SAY.badVersion);
  }
  if (version > SCRIPT_VERSION) {
    refuse(SAY.newerVersion);
  }
  // version < SCRIPT_VERSION would migrate here; v1 is the first, so no file can
  // carry a lower version and there is nothing to migrate yet.

  const name = readText(obj["name"], { min: 1, max: MAX_NAME_LEN, allowNewline: false }, ctx, SAY.noName);
  const notes =
    obj["notes"] === undefined
      ? ""
      : readText(obj["notes"], { min: 0, max: MAX_NOTES_LEN, allowNewline: true }, ctx, SAY.notObject);
  // A missing home defaults to the starting station — the portable default that
  // needs no picking. A present home is read normally (chosen / starting / unbound).
  const home =
    obj["home"] === undefined
      ? { entity: "station" as const, id: null, name: null, systemName: null, starting: true }
      : readWorldRef(obj["home"], "station", ctx, SAY.noHome, ["station", "structure"]);
  const interrupts = readInterrupts(obj["interrupts"], ctx);
  const program = readProgram(obj["program"], ctx);

  const doc: BotScript = {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name,
    notes,
    home,
    interrupts,
    program,
  };
  return withValidIds(doc, ctx);
}

// ─── Interrupts, and the guaranteed safety floor ─────────────────────────────

function readInterrupts(raw: unknown, ctx: Ctx): readonly InterruptRow[] {
  const arr = asArray(raw, SAY.notObject);
  if (arr.length > MAX_INTERRUPTS) {
    refuse(SAY.tooManyInterrupts);
  }
  return arr.map((row) => readInterruptRow(row, ctx));
}

function readInterruptRow(raw: unknown, ctx: Ctx): InterruptRow {
  const obj = asObject(raw, SAY.notObject);
  const id = readRawId(obj["id"]);
  const when = readCondition(obj["when"], "interrupt", ctx);
  const respond = obj["respond"];
  if (typeof respond !== "string" || !KNOWN_RESPONSES.has(respond as InterruptResponse)) {
    refuse(SAY.badResponse);
  }
  // `builtIn` is legacy (the old auto-injected, non-deletable safety floor, removed
  // 2026-07-23). An old document may still carry it — accepted so the file still
  // loads, then simply dropped: nothing in the current format reads it, and a
  // round-trip through this codec never writes it back.
  const builtIn = obj["builtIn"];
  if (builtIn !== undefined && builtIn !== "safety-floor") {
    refuse(SAY.unknownKey);
  }
  // How this watch FIGHTS — only a fight-back row does any fighting, so the two
  // combat settings are read only there. On any other response they are dropped
  // with a spoken warning rather than refused: a hand-edited file that says
  // "dock and pause, calling the primary" is confused, not hostile, and keeping
  // a setting the runner will never read would be the dishonest half.
  const isFight = respond === "fight-back";
  let squad: SquadRoleArg | undefined;
  let targets: readonly TargetClassArg[] | undefined;
  if (obj["squad"] !== undefined || obj["targets"] !== undefined) {
    if (!isFight) {
      ctx.warn(WARN.droppedWatchCombatSettings);
    } else {
      if (obj["squad"] !== undefined) {
        const role = obj["squad"];
        if (typeof role !== "string" || !SQUAD_ROLE_ARGS.includes(role as SquadRoleArg)) {
          refuse(SAY.badResponse);
        }
        squad = role as SquadRoleArg;
      }
      if (obj["targets"] !== undefined) {
        const arr = asArray(obj["targets"], SAY.badResponse);
        const seen = new Set<string>();
        const classes: TargetClassArg[] = [];
        let droppedUnknown = false;
        for (const item of arr) {
          const key = readText(item, { min: 1, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badResponse);
          if (!TARGET_CLASS_ARGS.includes(key as TargetClassArg)) {
            droppedUnknown = true;
            continue;
          }
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          classes.push(key as TargetClassArg);
        }
        if (droppedUnknown) {
          ctx.warn(WARN.droppedUnknownTargets);
        }
        targets = classes.slice(0, MAX_TARGET_LIST);
      }
    }
  }
  const base: InterruptRow = { id, when, respond: respond as InterruptResponse };
  return {
    ...base,
    ...(squad === undefined ? {} : { squad }),
    ...(targets === undefined ? {} : { targets }),
  };
}

// ─── Program ─────────────────────────────────────────────────────────────────

function readProgram(raw: unknown, ctx: Ctx): readonly ProgramNode[] {
  const arr = asArray(raw, SAY.notObject);
  if (arr.length === 0) {
    refuse(SAY.emptyProgram);
  }
  if (arr.length > MAX_PROGRAM_NODES) {
    refuse(SAY.tooManyNodes);
  }
  const program = arr.map((node) => readProgramNode(node, ctx));

  let steps = 0;
  for (const node of program) {
    steps += countProgramNode(node);
  }
  if (steps > MAX_TOTAL_STEPS) {
    refuse(SAY.tooManySteps);
  }
  return program;
}

function readProgramNode(raw: unknown, ctx: Ctx): ProgramNode {
  const obj = asObject(raw, SAY.unknownNode);
  const kind = obj["kind"];
  if (kind === "macro") {
    return readMacroStep(obj, ctx);
  }
  if (kind === "loop") {
    return readLoopBlock(obj, ctx);
  }
  if (kind === "branch") {
    return readBranchBlock(obj, ctx);
  }
  if (kind === "sub-bot") {
    return readSubBotNode(obj, ctx);
  }
  return refuse(SAY.unknownNode);
}

/** "Run one of my saved bots here" — exact id first, unique-name fallback only. */
function readSubBotNode(obj: Readonly<Record<string, unknown>>, ctx: Ctx): SubBotNode {
  const id = readRawId(obj["id"]);
  const rawScriptID = obj["scriptID"];
  if (rawScriptID !== null && rawScriptID !== undefined && typeof rawScriptID !== "string") {
    refuse(SAY.badArg("saved bot"));
  }
  const scriptID =
    typeof rawScriptID === "string" ? stripControl(rawScriptID, false).slice(0, MAX_ID_LEN) : null;
  const nameRaw = obj["name"];
  const name =
    nameRaw === null || nameRaw === undefined
      ? null
      : readText(nameRaw, { min: 0, max: MAX_NAME_LEN, allowNewline: false }, ctx, SAY.badArg("saved bot"));
  return { id, kind: "sub-bot", scriptID: scriptID === null || scriptID.length === 0 ? null : scriptID, name };
}

// ─── Branch blocks ───────────────────────────────────────────────────────────

function readBranchBlock(obj: Readonly<Record<string, unknown>>, ctx: Ctx): BranchBlock {
  const id = readRawId(obj["id"]);
  // A branch tests an own-ship condition at a program point — the same site rule
  // as an `until` (so a grid-only read like hostile-on-grid is refused here).
  const when = readCondition(obj["when"], "until", ctx);
  const thenSide = readBranchSide(obj["then"], ctx);
  const elseSide = readBranchSide(obj["else"], ctx);
  if (thenSide.length === 0 && elseSide.length === 0) {
    refuse(SAY.emptyBranch);
  }
  return { id, kind: "branch", when, then: thenSide, else: elseSide };
}

/** One side of a branch: a list of macro steps only (no loop, no nested branch);
 * absent or empty is allowed ("do nothing on that side"). */
function readBranchSide(raw: unknown, ctx: Ctx): readonly MacroStep[] {
  if (raw === undefined) {
    return [];
  }
  const arr = asArray(raw, SAY.unknownNode);
  return arr.map((node) => {
    const nodeObj = asObject(node, SAY.unknownNode);
    if (nodeObj["kind"] === "loop" || nodeObj["kind"] === "branch") {
      refuse(SAY.nestedBranch);
    }
    if (nodeObj["kind"] === "sub-bot") {
      refuse(SAY.subBotInLoop);
    }
    if (nodeObj["kind"] !== "macro") {
      refuse(SAY.unknownNode);
    }
    return readMacroStep(nodeObj, ctx);
  });
}

function readMacroStep(obj: Readonly<Record<string, unknown>>, ctx: Ctx): MacroStep {
  const macro = obj["macro"];
  if (typeof macro === "string" && RETIRED_WEB_COMPANION_MACROS.has(macro)) {
    refuse(SAY.retiredWebCompanionFeature(safeToken(macro)));
  }
  if (typeof macro !== "string" || !KNOWN_MACROS.has(macro)) {
    refuse(SAY.unknownMacro(safeToken(macro)));
  }
  const id = readRawId(obj["id"]);
  const spec = MACRO_SPECS[macro as MacroID];
  // A count normally clamps into its broad document range. Mission level is a
  // policy choice: an explicit 0 or 5 must never decode as another level.
  if (macro === "find-distribution-agent" && obj["args"] !== undefined) {
    const rawArgs = asObject(obj["args"], SAY.unknownArg);
    if (rawArgs["level"] !== undefined) {
      const rawLevel = asObject(rawArgs["level"], SAY.badArg("level"));
      const value = rawLevel["value"];
      if (rawLevel["kind"] !== "count" || typeof value !== "number" ||
          !Number.isSafeInteger(value) || value < 1 || value > 4) refuse(SAY.badArg("level"));
    }
  }
  const args = readArgs(obj["args"], spec, ctx);

  let until: Condition | undefined;
  if (obj["until"] !== undefined) {
    until = readCondition(obj["until"], "until", ctx);
  } else if (spec.untilRequired) {
    refuse(SAY.untilRequired);
  }

  return until === undefined
    ? { id, kind: "macro", macro: macro as MacroID, args }
    : { id, kind: "macro", macro: macro as MacroID, args, until };
}

function readArgs(
  raw: unknown,
  spec: MacroSpec,
  ctx: Ctx,
): Readonly<Record<string, Arg>> {
  const obj = raw === undefined ? {} : asObject(raw, SAY.unknownArg);
  const allowed = new Set(spec.args.map((a) => a.key));
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      refuse(SAY.unknownArg);
    }
  }
  const out: Record<string, Arg> = {};
  for (const argSpec of spec.args) {
    const value = obj[argSpec.key];
    if (value === undefined) {
      if (argSpec.required) {
        refuse(SAY.missingArg(argSpec.key));
      }
      continue;
    }
    out[argSpec.key] = readArg(value, argSpec.kind, argSpec.key, ctx, argSpec.dockable === true);
  }
  return out;
}

function readArg(raw: unknown, expected: Arg["kind"], label: string, ctx: Ctx, dockable = false): Arg {
  const obj = asObject(raw, SAY.badArg(label));
  if (obj["kind"] !== expected) {
    refuse(SAY.badArg(label));
  }
  if (expected === "belt") {
    return { kind: "belt", belt: readBelt(obj["belt"], label, ctx) };
  }
  if (expected === "station") {
    return { kind: "station", ref: readWorldRef(obj["ref"], "station", ctx, SAY.badArg(label),
      dockable ? ["station", "structure"] : null) };
  }
  if (expected === "agent") {
    return { kind: "agent", ref: readWorldRef(obj["ref"], "agent", ctx, SAY.badArg(label)) };
  }
  if (expected === "toggle") {
    if (typeof obj["enabled"] !== "boolean") refuse(SAY.badArg(label));
    return { kind: "toggle", enabled: obj["enabled"] as boolean };
  }
  if (expected === "count") {
    const value = obj["value"];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      refuse(SAY.badArg(label));
    }
    // Out-of-range counts CLAMP with a warning (the number rule the thresholds
    // follow) rather than refusing the whole file over an editable number.
    const clamped = Math.min(MAX_COUNT_ARG, Math.max(MIN_COUNT_ARG, value));
    if (clamped !== value) {
      ctx.warn(WARN.clampCount(label, clamped));
    }
    return { kind: "count", value: clamped };
  }
  if (expected === "distanceKm") {
    // ⚠ THE SAME RULE AS `count` ABOVE, AND FOR THE SAME REASON: an out-of-range
    // distance CLAMPS with a warning rather than refusing the whole document
    // over one editable number. A refusal here would make a bot a player typed
    // 500 into unopenable, including for the player who typed it.
    //
    // ⚠ AND THE UNIT IS KILOMETRES ON BOTH SIDES OF THIS LINE. The bound is
    // 1..300 KM; the runtime multiplies by a thousand exactly once, in the
    // block's adapter. Clamping a metre value against a kilometre bound would
    // silently turn "hold at 25 km" into "hold at 300 km", which is a ship
    // parked outside its own drone leash and a fight that never starts.
    const value = obj["value"];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      refuse(SAY.badArg(label));
    }
    const clamped = Math.min(MAX_DISTANCE_KM_ARG, Math.max(MIN_DISTANCE_KM_ARG, value));
    if (clamped !== value) {
      ctx.warn(WARN.clampCount(label, clamped));
    }
    return { kind: "distanceKm", value: clamped };
  }
  if (expected === "propMode") {
    // A CLOSED VOCABULARY, checked here rather than trusted — the same rule as
    // `place`, `rockPick` and `squadRole`. An unrecognised mode is REFUSED and
    // never quietly defaulted to "auto": defaulting would turn a document that
    // says "never light the burner" into one that lights it, and the player
    // would only find out from the signature bloom on a ship they had told not
    // to bloom.
    const mode = obj["mode"];
    if (typeof mode !== "string" || !PROP_MODE_ARGS.includes(mode as PropModeArg)) {
      refuse(SAY.badArg(label));
    }
    return { kind: "propMode", mode: mode as PropModeArg };
  }
  if (expected === "isk") {
    const value = obj["value"];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      refuse(SAY.badArg(label));
    }
    const clamped = Math.min(MAX_ISK_ARG, Math.max(MIN_ISK_ARG, value));
    if (clamped !== value) {
      ctx.warn(WARN.clampCount(label, clamped));
    }
    return { kind: "isk", value: clamped };
  }
  if (expected === "qty") {
    const value = obj["value"];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      refuse(SAY.badArg(label));
    }
    const clamped = Math.min(MAX_QTY_ARG, Math.max(MIN_QTY_ARG, value));
    if (clamped !== value) {
      ctx.warn(WARN.clampCount(label, clamped));
    }
    return { kind: "qty", value: clamped };
  }
  if (expected === "character") {
    const id = obj["charID"];
    if (id !== null && id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
      refuse(SAY.badArg(label));
    }
    const nameRaw = obj["name"];
    const name =
      nameRaw === null || nameRaw === undefined
        ? null
        : readText(nameRaw, { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
    return { kind: "character", charID: id === null || id === undefined ? null : (id as number), name };
  }
  if (expected === "fitting") {
    const id = obj["fittingID"];
    if (id !== null && id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
      refuse(SAY.badArg(label));
    }
    const nameRaw = obj["name"];
    const name =
      nameRaw === null || nameRaw === undefined
        ? null
        : readText(nameRaw, { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
    return { kind: "fitting", fittingID: id === null || id === undefined ? null : (id as number), name };
  }
  if (expected === "itemType") {
    const id = obj["typeID"];
    if (id !== null && id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
      refuse(SAY.badArg(label));
    }
    const nameRaw = obj["name"];
    const name =
      nameRaw === null || nameRaw === undefined
        ? null
        : readText(nameRaw, { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
    return { kind: "itemType", typeID: id === null || id === undefined ? null : (id as number), name };
  }
  if (expected === "place") {
    const place = obj["place"];
    if (typeof place !== "string" || !ITEM_PLACES.includes(place as ItemPlace)) {
      refuse(SAY.badArg(label));
    }
    return { kind: "place", place: place as ItemPlace };
  }
  if (expected === "corpDivision") {
    // REFUSED, NOT CLAMPED — and this is the one place in this file where a
    // number out of range is not simply pulled back to the nearest bound. A
    // clamp is honest when the bounds are a matter of degree (how far to hold
    // off, how much to pay): the player asked for too much of the right thing.
    // A division is an ADDRESS. "Division 9" clamped to 7 would deliver a hold
    // of ore into a corporation hangar nobody chose, and the player would learn
    // it from the wrong division being full. There is no nearest right answer to
    // a wrong address.
    const division = obj["division"];
    if (
      typeof division !== "number" ||
      !Number.isSafeInteger(division) ||
      division < MIN_CORP_DIVISION ||
      division > MAX_CORP_DIVISION
    ) {
      refuse(SAY.badArg(label));
    }
    const nameRaw = obj["name"];
    const name =
      nameRaw === null || nameRaw === undefined
        ? null
        : readText(nameRaw, { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
    return { kind: "corpDivision", division: division as number, name };
  }
  if (expected === "destination") {
    // A station OR a system — and which one it is decides how the autopilot flies
    // it, so the entity is validated against exactly those two (never "belt").
    const ref = readWorldRef(obj["ref"], "station", ctx, SAY.badArg(label), ["station", "structure", "system"]);
    return { kind: "destination", ref };
  }
  if (expected === "system") {
    // Systems ONLY — no widened set, so a station in this slot is refused rather
    // than kept as a station the block could not fly to (see the `system` arg
    // in botScript.ts).
    const ref = readWorldRef(obj["ref"], "system", ctx, SAY.badArg(label));
    return { kind: "system", ref };
  }
  if (expected === "text") {
    // A blank name is a fixable draft problem (the validator lists it), not a
    // refusal — min 0 keeps an in-progress save loadable.
    const text = readText(obj["text"], { min: 0, max: MAX_TEXT_ARG_LEN, allowNewline: false }, ctx, SAY.badArg(label));
    return { kind: "text", text };
  }
  if (expected === "rockPick") {
    const pick = obj["pick"];
    if (typeof pick !== "string" || !ROCK_PICKS.includes(pick as RockPick)) {
      refuse(SAY.badArg(label));
    }
    return { kind: "rockPick", pick: pick as RockPick };
  }
  if (expected === "oreList") {
    const arr = asArray(obj["ores"], SAY.badArg(label));
    const seen = new Set<number>();
    const ores: OreFamilyArg[] = [];
    let droppedDuplicate = false;
    for (const item of arr) {
      const oreObj = asObject(item, SAY.badArg(label));
      const groupID = oreObj["groupID"];
      if (typeof groupID !== "number" || !Number.isSafeInteger(groupID) || groupID <= 0) {
        refuse(SAY.badArg(label));
      }
      const name = readText(oreObj["name"], { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
      if (seen.has(groupID)) {
        droppedDuplicate = true;
        continue;
      }
      seen.add(groupID);
      ores.push({ groupID, name });
    }
    if (droppedDuplicate) {
      ctx.warn(WARN.droppedDuplicateOres);
    }
    if (ores.length > MAX_ORE_LIST) {
      ctx.warn(WARN.truncatedOreList(MAX_ORE_LIST));
    }
    return { kind: "oreList", ores: ores.slice(0, MAX_ORE_LIST) };
  }
  if (expected === "squadRole") {
    const role = obj["role"];
    if (typeof role !== "string" || !SQUAD_ROLE_ARGS.includes(role as SquadRoleArg)) {
      refuse(SAY.badArg(label));
    }
    return { kind: "squadRole", role: role as SquadRoleArg };
  }
  if (expected === "targetList") {
    // A CLOSED VOCABULARY, checked here rather than trusted — the same rule as
    // the bay list below. An unknown class is dropped rather than carried into
    // the runner, which would rank it "unlisted" and silently change the
    // ordering the player thought they saved. Duplicates are dropped too: a
    // class twice in one ladder is a second rung that can never be reached.
    const arr = asArray(obj["classes"], SAY.badArg(label));
    const seen = new Set<string>();
    const classes: TargetClassArg[] = [];
    let droppedUnknown = false;
    for (const item of arr) {
      const key = readText(item, { min: 1, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
      if (!TARGET_CLASS_ARGS.includes(key as TargetClassArg)) {
        droppedUnknown = true;
        continue;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      classes.push(key as TargetClassArg);
    }
    if (droppedUnknown) {
      ctx.warn(WARN.droppedUnknownTargets);
    }
    return { kind: "targetList", classes: classes.slice(0, MAX_TARGET_LIST) };
  }
  if (expected === "bayList") {
    // A CLOSED VOCABULARY, checked here rather than trusted. Bay keys are the
    // BFF's own names ("ore", "ammo"), so an unknown one is a document from
    // somewhere else and is dropped rather than carried into the runner, which
    // would silently protect nothing.
    const arr = asArray(obj["bays"], SAY.badArg(label));
    const seen = new Set<string>();
    const bays: string[] = [];
    let droppedUnknown = false;
    for (const item of arr) {
      const key = readText(item, { min: 1, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
      if (!KNOWN_BAY_KEYS.has(key)) {
        droppedUnknown = true;
        continue;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      bays.push(key);
    }
    if (droppedUnknown) {
      ctx.warn(WARN.droppedUnknownBays);
    }
    return { kind: "bayList", bays: bays.slice(0, MAX_BAY_LIST) };
  }
  if (expected === "itemList") {
    const arr = asArray(obj["items"], SAY.badArg(label));
    const seen = new Set<string>();
    const items: ItemMatchArg[] = [];
    for (const entry of arr) {
      const itemObj = asObject(entry, SAY.badArg(label));
      const match = itemObj["match"];
      const name = readText(itemObj["name"], { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
      if (match !== "type" && match !== "group" && match !== "name") {
        refuse(SAY.badArg(label));
      }
      if (match === "name") {
        // A pattern is the player's own words, so it is READ like text (control
        // characters stripped, length clamped) rather than refused. A blank one
        // matches nothing at run time and the validator lists it as fixable.
        const pattern = readText(
          itemObj["pattern"],
          { min: 0, max: MAX_ITEM_PATTERN_LEN, allowNewline: false },
          ctx,
          SAY.badArg(label),
        );
        const key = `name:${pattern.trim().toLowerCase()}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        items.push({ match: "name", pattern, name: name.length > 0 ? name : pattern });
        continue;
      }
      const idField = match === "type" ? "typeID" : "groupID";
      const id = itemObj[idField];
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
        refuse(SAY.badArg(label));
      }
      const key = `${match}:${id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push(
        match === "type"
          ? { match: "type", typeID: id as number, name }
          : { match: "group", groupID: id as number, name },
      );
    }
    return { kind: "itemList", items: items.slice(0, MAX_ITEM_LIST) };
  }
  if (expected === "planetList") {
    const arr = asArray(obj["planets"], SAY.badArg(label));
    const seen = new Set<number>();
    const planets: PlanetPickArg[] = [];
    for (const entry of arr) {
      const planetObj = asObject(entry, SAY.badArg(label));
      const id = planetObj["planetID"];
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
        refuse(SAY.badArg(label));
      }
      if (seen.has(id as number)) {
        continue;
      }
      seen.add(id as number);
      const name = planetObj["name"] === null || planetObj["name"] === undefined
        ? ""
        : readText(planetObj["name"], { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
      planets.push({ planetID: id as number, name: name.length > 0 ? name : null });
    }
    return { kind: "planetList", planets: planets.slice(0, MAX_PLANET_LIST) };
  }
  if (expected === "bookmark") {
    const id = obj["bookmarkID"];
    if (id !== null && id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
      refuse(SAY.badArg(label));
    }
    const nameRaw = obj["name"];
    const name =
      nameRaw === null || nameRaw === undefined
        ? null
        : readText(nameRaw, { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
    return { kind: "bookmark", bookmarkID: id === null || id === undefined ? null : (id as number), name };
  }
  if (expected === "bookmarkFolder") {
    const id = obj["folderID"];
    if (id !== null && id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
      refuse(SAY.badArg(label));
    }
    const nameRaw = obj["name"];
    const name =
      nameRaw === null || nameRaw === undefined
        ? null
        : readText(nameRaw, { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
    return { kind: "bookmarkFolder", folderID: id === null || id === undefined ? null : (id as number), name };
  }
  if (expected === "corp") {
    const id = obj["id"];
    if (id !== null && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
      refuse(SAY.badArg(label));
    }
    const nameRaw = obj["name"];
    const name =
      nameRaw === null || nameRaw === undefined
        ? null
        : readText(nameRaw, { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
    return { kind: "corp", id: id === null || id === undefined ? null : id, name };
  }
  // equipment
  const equip = asObject(obj["equipment"], SAY.badArg(label));
  const groupID = equip["groupID"];
  if (typeof groupID !== "number" || !Number.isSafeInteger(groupID) || groupID <= 0) {
    refuse(SAY.badArg(label));
  }
  const equipLabel = readText(equip["label"], { min: 0, max: MAX_WORLD_NAME_LEN, allowNewline: false }, ctx, SAY.badArg(label));
  return { kind: "equipment", equipment: { groupID, label: equipLabel } };
}

function readBelt(raw: unknown, label: string, ctx: Ctx): BeltArg {
  const obj = asObject(raw, SAY.badArg(label));
  const mode = obj["mode"];
  if (mode === "nearest") {
    return { mode: "nearest" };
  }
  if (mode === "site" || mode === "ice-site") {
    return { mode };
  }
  if (mode === "chosen") {
    return { mode: "chosen", ref: readWorldRef(obj["ref"], "belt", ctx, SAY.badArg(label)) };
  }
  return refuse(SAY.badArg(label));
}

// ─── Loop blocks ─────────────────────────────────────────────────────────────

function readLoopBlock(obj: Readonly<Record<string, unknown>>, ctx: Ctx): LoopBlock {
  const id = readRawId(obj["id"]);
  const repeat = readRepeat(obj["repeat"], ctx);

  let until: Condition | undefined;
  if (obj["until"] !== undefined) {
    until = readCondition(obj["until"], "until", ctx);
  }

  const bodyRaw = asArray(obj["body"], SAY.emptyLoop);
  if (bodyRaw.length === 0) {
    refuse(SAY.emptyLoop);
  }
  // A loop body holds steps and BRANCHES (a fork each pass) — but never another
  // loop, and a branch's own sides stay step-only, so nesting is capped at two.
  const body = bodyRaw.map((node): LoopBodyNode => {
    const nodeObj = asObject(node, SAY.unknownNode);
    if (nodeObj["kind"] === "loop") {
      refuse(SAY.nestedLoop);
    }
    if (nodeObj["kind"] === "branch") {
      return readBranchBlock(nodeObj, ctx);
    }
    if (nodeObj["kind"] === "sub-bot") {
      // An included bot may carry loops of its own, so inlining one here could
      // make a loop inside a loop. Top level only.
      refuse(SAY.subBotInLoop);
    }
    if (nodeObj["kind"] !== "macro") {
      refuse(SAY.unknownNode);
    }
    return readMacroStep(nodeObj, ctx);
  });

  return until === undefined
    ? { id, kind: "loop", repeat, body }
    : { id, kind: "loop", repeat, until, body };
}

function readRepeat(raw: unknown, ctx: Ctx): Repeat {
  const obj = asObject(raw, SAY.noRepeat);
  const kind = obj["kind"];
  if (kind === "forever") {
    return { kind: "forever" };
  }
  if (kind === "times") {
    const count = obj["count"];
    if (typeof count !== "number" || !Number.isFinite(count)) {
      refuse(SAY.noRepeat);
    }
    let n = Math.trunc(count);
    if (n < MIN_REPEAT_TIMES) {
      n = MIN_REPEAT_TIMES;
      ctx.warn(WARN.clampRepeat(n));
    } else if (n > MAX_REPEAT_TIMES) {
      n = MAX_REPEAT_TIMES;
      ctx.warn(WARN.clampRepeat(n));
    }
    return { kind: "times", count: n };
  }
  return refuse(SAY.noRepeat);
}

// ─── Conditions ──────────────────────────────────────────────────────────────

function readCondition(raw: unknown, site: ConditionSite, ctx: Ctx): Condition {
  const obj = asObject(raw, SAY.unknownCondition);
  const kind = obj["kind"];

  const condition = buildCondition(obj, kind, ctx);
  if (!conditionAllowedAt(condition.kind, site)) {
    refuse(SAY.conditionOffSite);
  }
  return condition;
}

function buildCondition(obj: Readonly<Record<string, unknown>>, kind: unknown, ctx: Ctx): Condition {
  if (typeof kind === "string" && RETIRED_WEB_COMPANION_CHAT_CONDITIONS.has(kind)) {
    refuse(SAY.retiredWebCompanionFeature(safeToken(kind)));
  }
  switch (kind) {
    case "hold-empty":
      return { kind: "hold-empty" };
    case "hostile-on-grid":
      return { kind: "hostile-on-grid" };
    case "ore-hold-at-least":
      return {
        kind: "ore-hold-at-least",
        fraction: readFraction(obj["fraction"], MIN_CONDITION_FRACTION, MAX_ORE_HOLD_FRACTION, "The ore-hold level", ctx),
      };
    case "shield-below":
    case "armor-below":
    case "hull-below":
    case "health-below":
    case "capacitor-below":
      return {
        kind,
        fraction: readFraction(obj["fraction"], MIN_CONDITION_FRACTION, MAX_CONDITION_FRACTION, thresholdLabel(kind), ctx),
      };
    case "wallet-below":
    case "wallet-above":
      return { kind, isk: readIskThreshold(obj["isk"], ctx) };
    case "cargo-full":
      return {
        kind,
        // Same ceiling as the ore hold, for the same reason: a bot must not be
        // asked to fill a mixed hold to the last cubic metre.
        fraction: readFraction(obj["fraction"], MIN_CONDITION_FRACTION, MAX_ORE_HOLD_FRACTION, "The cargo-hold level", ctx),
      };
    case "drone-health-below":
      return {
        kind,
        fraction: readFraction(obj["fraction"], MIN_CONDITION_FRACTION, MAX_CONDITION_FRACTION, "The drone-health threshold", ctx),
      };
    case "targeted-by-player":
      return { kind: "targeted-by-player" };
    // "Something is holding this ship so it cannot warp" — no threshold and no
    // argument, exactly like `hostile-on-grid` above, so nothing is read off the
    // object and nothing can be defaulted into it. A `tackled` carrying junk
    // fields loses them (they were never part of the shape); a document naming
    // any OTHER kind still falls to the `default` below and is REFUSED, which is
    // the property that matters: an unrecognised check never becomes a silent
    // "false" that turns a safety row into decoration.
    case "tackled":
      return { kind: "tackled" };
    default:
      return refuse(SAY.unknownCondition);
  }
}

/** A wallet ISK threshold: a real integer, clamped into range with a warning. */
function readIskThreshold(raw: unknown, ctx: Ctx): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    refuse(SAY.badNumber);
  }
  const n = Math.trunc(raw);
  const clamped = Math.min(MAX_ISK_ARG, Math.max(MIN_ISK_ARG, n));
  if (clamped !== n) {
    ctx.warn(WARN.clampIsk(clamped));
  }
  return clamped;
}

function thresholdLabel(
  kind: "shield-below" | "armor-below" | "hull-below" | "health-below" | "capacitor-below",
): string {
  switch (kind) {
    case "shield-below":
      return "The shield threshold";
    case "armor-below":
      return "The armor threshold";
    case "hull-below":
      return "The hull threshold";
    case "health-below":
      return "The ship-health threshold";
    case "capacitor-below":
      return "The capacitor threshold";
  }
}

// ─── World references ────────────────────────────────────────────────────────

/**
 * Read a world reference. `expected` is the entity a plain ref must be, and the
 * one an unbound ref is stamped with. `alsoAllowed` widens that to a small SET for
 * a slot that legitimately takes more than one kind of place (the destination arg:
 * a station or a system) — still a closed list, so a file can never smuggle in a
 * belt id where a station is meant.
 */
function readWorldRef(
  raw: unknown,
  expected: WorldEntity,
  ctx: Ctx,
  refuseSentence: string,
  alsoAllowed: readonly WorldEntity[] | null = null,
): WorldRef {
  const obj = asObject(raw, refuseSentence);
  const entity = obj["entity"];
  const permitted = alsoAllowed ?? [expected];
  if (
    typeof entity !== "string" ||
    !WORLD_ENTITIES.has(entity as WorldEntity) ||
    !permitted.includes(entity as WorldEntity)
  ) {
    refuse(refuseSentence);
  }
  // With a widened set, the ref keeps its OWN entity (a system stays a system);
  // the branches below that are station-only still test `expected`.
  if (alsoAllowed !== null && entity !== expected) {
    if (obj["slot"] !== undefined || obj["starting"] !== undefined) refuse(refuseSentence);
    const otherID = obj["id"];
    const otherName = readNullableText(obj["name"], MAX_WORLD_NAME_LEN, ctx);
    const otherSystemName = readNullableText(obj["systemName"], MAX_WORLD_NAME_LEN, ctx);
    let resolvedID: number | null = null;
    if (typeof otherID === "number" && Number.isSafeInteger(otherID) && otherID > 0) {
      if (entity === "structure" && otherID < STRUCTURE_ID_FLOOR) refuse(refuseSentence);
      resolvedID = otherID;
    } else if (otherID !== null && otherID !== undefined) {
      ctx.warn(WARN.forgotWorldId);
    }
    return { entity: entity as WorldEntity, id: resolvedID, name: otherName, systemName: otherSystemName };
  }

  let id: number | null = null;
  const rawId = obj["id"];
  if (rawId === null || rawId === undefined) {
    id = null;
  } else if (typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0) {
    if (entity === "station" && rawId >= STRUCTURE_ID_FLOOR) refuse(refuseSentence);
    id = rawId;
  } else {
    id = null;
    ctx.warn(WARN.forgotWorldId);
  }

  const name = readNullableText(obj["name"], MAX_WORLD_NAME_LEN, ctx);
  const systemName = readNullableText(obj["systemName"], MAX_WORLD_NAME_LEN, ctx);
  // A named BOARD SLOT ("the station the find-agent block found") is a runtime
  // binding like `starting`, and station-only. An unknown slot name is refused
  // rather than silently dropped — a bot that flew to "whatever" is not this bot.
  const rawSlot = obj["slot"];
  if (rawSlot !== undefined && rawSlot !== null) {
    if (expected !== "station" || typeof rawSlot !== "string" || !BOARD_SLOTS.includes(rawSlot as BoardSlot)) {
      refuse(refuseSentence);
    }
    return { entity: "station", id: null, name, systemName, slot: rawSlot as BoardSlot };
  }
  // "starting" (station only) is included only when literally true, so a plain
  // chosen/unbound ref round-trips without an extra field.
  if (expected === "station" && obj["starting"] === true) {
    return { entity: "station", id: null, name, systemName, starting: true };
  }
  return { entity: expected, id, name, systemName };
}

// ─── Ids ─────────────────────────────────────────────────────────────────────
// Ids are local handles, referenced by nothing in the format. Read what came,
// then a single pass guarantees they are non-empty and unique — reassigning all
// of them deterministically if any is bad, so a hostile duplicate cannot make
// two rows indistinguishable and a hand-edited file need not invent them.

function readRawId(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return stripControl(raw, false).slice(0, MAX_ID_LEN);
}

function withValidIds(doc: BotScript, ctx: Ctx): BotScript {
  const ids: string[] = [];
  for (const row of doc.interrupts) {
    ids.push(row.id);
  }
  for (const node of doc.program) {
    ids.push(node.id);
    if (node.kind === "loop") {
      for (const element of node.body) {
        ids.push(element.id);
        if (element.kind === "branch") {
          for (const step of [...element.then, ...element.else]) {
            ids.push(step.id);
          }
        }
      }
    } else if (node.kind === "branch") {
      for (const step of [...node.then, ...node.else]) {
        ids.push(step.id);
      }
    }
  }
  const clean = ids.every((id) => id.length > 0) && new Set(ids).size === ids.length;
  if (clean) {
    return doc;
  }
  ctx.warn(WARN.reassignedIds);

  let n = 0;
  const nextId = (): string => `n${(n += 1)}`;
  const interrupts = doc.interrupts.map((row) => ({ ...row, id: nextId() }));
  const program = doc.program.map((node) => {
    if (node.kind === "loop") {
      return {
        ...node,
        id: nextId(),
        body: node.body.map((element) =>
          element.kind === "branch"
            ? {
                ...element,
                id: nextId(),
                then: element.then.map((step) => ({ ...step, id: nextId() })),
                else: element.else.map((step) => ({ ...step, id: nextId() })),
              }
            : { ...element, id: nextId() },
        ),
      };
    }
    if (node.kind === "branch") {
      return {
        ...node,
        id: nextId(),
        then: node.then.map((step) => ({ ...step, id: nextId() })),
        else: node.else.map((step) => ({ ...step, id: nextId() })),
      };
    }
    return { ...node, id: nextId() };
  });
  return { ...doc, interrupts, program };
}

// ─── Primitive readers ───────────────────────────────────────────────────────

function asObject(raw: unknown, refuseSentence: string): Readonly<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    refuse(refuseSentence);
  }
  // Own enumerable properties only — a `__proto__` or `constructor` key is just
  // an unknown key to be rejected by whatever validates this object's key set;
  // it is never followed.
  return raw as Readonly<Record<string, unknown>>;
}

function asArray(raw: unknown, refuseSentence: string): readonly unknown[] {
  if (!Array.isArray(raw)) {
    refuse(refuseSentence);
  }
  return raw;
}

interface TextSpec {
  readonly min: number;
  readonly max: number;
  readonly allowNewline: boolean;
}

function readText(raw: unknown, spec: TextSpec, ctx: Ctx, refuseSentence: string): string {
  if (typeof raw !== "string") {
    refuse(refuseSentence);
  }
  const cleaned = stripControl(raw, spec.allowNewline);
  if (cleaned !== raw) {
    ctx.warn(WARN.strippedControl);
  }
  const trimmed = cleaned.trim().slice(0, spec.max);
  if (trimmed.length < spec.min) {
    refuse(refuseSentence);
  }
  return trimmed;
}

function readNullableText(raw: unknown, max: number, ctx: Ctx): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "string") {
    return null;
  }
  const cleaned = stripControl(raw, false);
  if (cleaned !== raw) {
    ctx.warn(WARN.strippedControl);
  }
  const trimmed = cleaned.trim().slice(0, max);
  return trimmed.length === 0 ? null : trimmed;
}

function readFraction(raw: unknown, min: number, max: number, label: string, ctx: Ctx): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    refuse(SAY.badNumber);
  }
  if (raw < min) {
    ctx.warn(WARN.clampFraction(label, min));
    return min;
  }
  if (raw > max) {
    ctx.warn(WARN.clampFraction(label, max));
    return max;
  }
  return raw;
}

function stripControl(text: string, allowNewline: boolean): string {
  // Drop C0/C1 control characters and bidi overrides that could reshape a line on
  // screen. Tab/newline/carriage-return are kept only where a field allows them.
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (allowNewline && (code === 0x09 || code === 0x0a || code === 0x0d)) {
      out += ch;
      continue;
    }
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    const isBidi =
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    if (isControl || isBidi) {
      continue;
    }
    out += ch;
  }
  return out;
}

/** A hostile string, reduced to a short safe token before it may be quoted on screen. */
function safeToken(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, MAX_ECHO_LEN);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ─── Stable serialisation ────────────────────────────────────────────────────

function orderDoc(doc: BotScript): unknown {
  return {
    format: doc.format,
    version: doc.version,
    name: doc.name,
    notes: doc.notes,
    home: orderRef(doc.home),
    interrupts: doc.interrupts.map(orderInterrupt),
    program: doc.program.map(orderNode),
  };
}

function orderRef(ref: WorldRef): unknown {
  const base: Record<string, unknown> = { entity: ref.entity, id: ref.id, name: ref.name, systemName: ref.systemName };
  if (ref.starting === true) {
    base["starting"] = true;
  }
  if (ref.slot !== undefined) {
    base["slot"] = ref.slot;
  }
  return base;
}

function orderCondition(condition: Condition): unknown {
  if ("fraction" in condition) {
    return { kind: condition.kind, fraction: condition.fraction };
  }
  if ("isk" in condition) {
    return { kind: condition.kind, isk: condition.isk };
  }
  return { kind: condition.kind };
}

function orderInterrupt(row: InterruptRow): unknown {
  const base: Record<string, unknown> = {
    id: row.id,
    when: orderCondition(row.when),
    respond: row.respond,
  };
  // Written only when set, so a watch that flies alone round-trips byte-identical.
  if (row.squad !== undefined) {
    base["squad"] = row.squad;
  }
  if (row.targets !== undefined) {
    base["targets"] = [...row.targets];
  }
  return base;
}

function orderArg(arg: Arg): unknown {
  switch (arg.kind) {
    case "belt":
      return arg.belt.mode === "chosen"
        ? { kind: "belt", belt: { mode: "chosen", ref: orderRef(arg.belt.ref) } }
        : { kind: "belt", belt: { mode: arg.belt.mode } };
    case "station":
      return { kind: "station", ref: orderRef(arg.ref) };
    case "toggle":
      return { kind: "toggle", enabled: arg.enabled };
    case "agent":
      return { kind: "agent", ref: orderRef(arg.ref) };
    case "equipment":
      return { kind: "equipment", equipment: { groupID: arg.equipment.groupID, label: arg.equipment.label } };
    case "count":
      return { kind: "count", value: arg.value };
    case "corp":
      return { kind: "corp", id: arg.id, name: arg.name };
    case "fitting":
      return { kind: "fitting", fittingID: arg.fittingID, name: arg.name };
    case "itemType":
      return { kind: "itemType", typeID: arg.typeID, name: arg.name };
    case "place":
      return { kind: "place", place: arg.place };
    case "corpDivision":
      return { kind: "corpDivision", division: arg.division, name: arg.name };
    case "bookmark":
      return { kind: "bookmark", bookmarkID: arg.bookmarkID, name: arg.name };
    case "bookmarkFolder":
      return { kind: "bookmarkFolder", folderID: arg.folderID, name: arg.name };
    case "isk":
      return { kind: "isk", value: arg.value };
    case "qty":
      return { kind: "qty", value: arg.value };
    case "character":
      return { kind: "character", charID: arg.charID, name: arg.name };
    case "destination":
      return { kind: "destination", ref: orderRef(arg.ref) };
    case "system":
      return { kind: "system", ref: orderRef(arg.ref) };
    case "text":
      return { kind: "text", text: arg.text };
    case "rockPick":
      return { kind: "rockPick", pick: arg.pick };
    case "oreList":
      return {
        kind: "oreList",
        ores: arg.ores.map((ore) => ({ groupID: ore.groupID, name: ore.name })),
      };
    case "targetList":
      return { kind: "targetList", classes: [...arg.classes] };
    case "squadRole":
      return { kind: "squadRole", role: arg.role };
    case "distanceKm":
      return { kind: "distanceKm", value: arg.value };
    case "propMode":
      return { kind: "propMode", mode: arg.mode };
    case "bayList":
      return { kind: "bayList", bays: [...arg.bays] };
    case "itemList":
      return {
        kind: "itemList",
        // ⚠ A SWITCH, NOT A TERNARY. This used to be "type ? … : group", which
        // was total right up until a third match arrived — at which point a
        // pattern would have been written out as a group and read back as one.
        items: arg.items.map((item) => {
          switch (item.match) {
            case "type":
              return { match: "type", typeID: item.typeID, name: item.name };
            case "group":
              return { match: "group", groupID: item.groupID, name: item.name };
            case "name":
              return { match: "name", pattern: item.pattern, name: item.name };
            default: {
              const _exhaustive: never = item;
              return _exhaustive;
            }
          }
        }),
      };
    case "planetList":
      return {
        kind: "planetList",
        planets: arg.planets.map((planet) => ({ planetID: planet.planetID, name: planet.name })),
      };
    default: {
      // ⚠ EXHAUSTIVE ON PURPOSE. Every Arg kind MUST serialise here, or an export
      // silently drops it (the reader accepts an arg the writer forgets). A new
      // kind added to the union without a case above fails to compile, exactly as
      // it should — a dropped action is a different, unsafe program.
      const _exhaustive: never = arg;
      return _exhaustive;
    }
  }
}

function orderArgs(args: Readonly<Record<string, Arg>>): unknown {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) {
    const arg = args[key];
    if (arg !== undefined) {
      out[key] = orderArg(arg);
    }
  }
  return out;
}

function orderRepeat(repeat: Repeat): unknown {
  return repeat.kind === "forever" ? { kind: "forever" } : { kind: "times", count: repeat.count };
}

function orderNode(node: ProgramNode): unknown {
  if (node.kind === "loop") {
    const base: Record<string, unknown> = {
      id: node.id,
      kind: "loop",
      repeat: orderRepeat(node.repeat),
    };
    if (node.until !== undefined) {
      base["until"] = orderCondition(node.until);
    }
    base["body"] = node.body.map(orderNode);
    return base;
  }
  if (node.kind === "branch") {
    return {
      id: node.id,
      kind: "branch",
      when: orderCondition(node.when),
      then: node.then.map(orderNode),
      else: node.else.map(orderNode),
    };
  }
  if (node.kind === "sub-bot") {
    return { id: node.id, kind: "sub-bot", scriptID: node.scriptID, name: node.name };
  }
  const base: Record<string, unknown> = {
    id: node.id,
    kind: "macro",
    macro: node.macro,
    args: orderArgs(node.args),
  };
  if (node.until !== undefined) {
    base["until"] = orderCondition(node.until);
  }
  return base;
}
