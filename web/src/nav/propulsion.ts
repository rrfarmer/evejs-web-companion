// One policy, two callers: what to do with a fitted afterburner or
// microwarpdrive once somebody has decided whether this ship needs to cover
// distance right now.
//
// This is a fleet-following plugin's `decidePropulsion`, lifted whole
// rather than re-derived. That loop asks "am I travelling, or did a
// commander type `props on`?"; the drone-boat block asks "is the gap between
// where I am and where I want to be bigger than five km?" -- and from that
// answer onwards the two want exactly the same thing, down to which module to
// name and when to leave the rack alone. Two copies of a scram rule with
// nothing to fail if one drifted is a bug waiting to happen, so there is one
// copy and it is here.
//
// ⚠ PURE, AND THAT IS LOAD-BEARING. No store, no bridge, no loop import: the
// caller reads the grid, this decides, the caller words it. `wantBurn` is the
// ONLY thing the two callers disagree about, and it arrives already answered.

/**
 * One fitted afterburner or microwarpdrive: what to cycle, what to name when
 * stopping it, and which of the two it is.
 *
 * ⚠ `typeID` IS NOT DECORATION. Deactivate stops a prop mod only when it names
 * the propulsion effect -- the server infers a prop mod's default effect on
 * ACTIVATE and not on deactivate -- so a bare Deactivate returns success with
 * the burner still cycling. Whoever resolves the effect name does it from the
 * typeID, so the id has to travel with the module and out again in the
 * decision.
 *
 * `kind` is `null` when the SDE effect read did not arrive. That is a third
 * state and not a default -- "the group said propulsion module and the effect
 * did not answer" -- and this policy fails OPEN on it, treating the module as
 * the scram-vulnerable half. SDE group 46 holds BOTH kinds and no group name
 * can separate them; the answer comes from the SDE's own dogmaEffects
 * (6730/6731).
 */
export interface PropulsionModule {
  readonly itemID: number;
  readonly typeID: number;
  readonly kind: "afterburner" | "microwarpdrive" | null;
}

/** Everything the policy reads. Nothing here is upstream of `wantBurn`. */
export interface PropulsionInputs {
  /**
   * The prop mods fitted to this hull, in whatever order the caller's fit read
   * produced them. Empty is a real answer and a common one: plenty of hulls fly
   * without one.
   */
  readonly modules: readonly PropulsionModule[];
  /**
   * What is cycling right now.
   *
   * ⚠ A SET, NEVER A NULL, AND THE CALLER OWNS THAT DISTINCTION. An unreadable
   * module snapshot must not be read here as "nothing is running" -- that would
   * re-activate a burner that is already lit, every tick, for as long as the
   * read stayed down. A caller whose snapshot cannot say must not call at all.
   */
  readonly activeModuleIDs: ReadonlySet<number>;
  /** Null = unreadable, which must NOT gate (fail open). */
  readonly capacitorRatio: number | null;
  /** Three-state: only an explicit true stands a microwarpdrive down. */
  readonly scrammed: boolean | null;
  /** The caller's answer to "do I need to cover distance right now?". */
  readonly wantBurn: boolean;
  readonly capFloor: number;
}

/**
 * One call, or none. `"none"` is the ordinary answer: the rack already agrees
 * with what is wanted, so the rung has nothing to do and whatever the caller
 * runs below it gets the tick.
 */
export type PropulsionDecision =
  | { readonly kind: "light"; readonly module: PropulsionModule }
  | { readonly kind: "stop"; readonly module: PropulsionModule }
  | { readonly kind: "none" };

const NONE: PropulsionDecision = Object.freeze({ kind: "none" as const });

/**
 * The prop mod: on while this ship needs to cover distance, off when it does
 * not, with a scram and a capacitor floor between the wanting and the doing.
 *
 * These are the five rules `decidePropulsion` shipped with, in its own words,
 * because the reasoning is worth more than the branches:
 *
 * ⚠ AN ORBIT IS NOT CLOSING. A ship holding station has ARRIVED, so the burner
 * goes out rather than circling on full power for ever. That judgement belongs
 * to the caller -- it is the whole content of `wantBurn` -- but it is written
 * here because it is the rule most easily lost when a second caller answers the
 * question for itself. A loop reads it off the ship's movement mode; the
 * drone boat reads it off the gap to the range it wants to hold. Neither may
 * read "I am moving" as "I am closing".
 *
 * ⚠ THE OVERRIDE IS THREE-STATE AND `null` IS NOT "OFF". Where a caller lets an
 * operator force the burner on or off, null means nobody has said anything and
 * the caller's own travel test decides; `true`/`false` are a standing
 * instruction in either direction. Reading null as off would ship every pilot
 * with a permanent order never to use its prop mod. That fold happens upstream,
 * in `wantBurn`, and this is the note that says it must.
 *
 * ⚠ A SCRAM STANDS DOWN A MICROWARPDRIVE AND ONLY A MICROWARPDRIVE. The server
 * turns an MWD off under a warp scrambler, so re-activating one every tick is a
 * call spent to be refused; an AFTERBURNER is untouched by any jam in that
 * vocabulary and is exactly what a tackled ship needs. This is the whole reason
 * `PropulsionModule` carries a `kind` at all. `scrammed` is three-state and
 * only an explicit `true` gates, so a jam slice that could not be read never
 * takes the speed off a ship. A scrammed MWD is skipped rather than the whole
 * rung, so a ship carrying both keeps its afterburner.
 *
 * ⚠ AN UNKNOWN `kind` IS TREATED AS A MICROWARPDRIVE, which is the cheap half of
 * the wrong answer. The alternative -- assume afterburner -- keeps re-activating
 * a dead MWD under a scram; this one costs at most a stationary afterburner on a
 * pilot that is already tackled and that a commander can re-light by typing.
 *
 * ⚠ THE CAPACITOR FLOOR GATES ONLY THE LIGHTING, NEVER THE STOPPING. An MWD
 * runs at roughly ninety per cent of a frigate's capacitor per cycle, so
 * lighting one below the operator's own floor is how a pilot caps itself out
 * and then cannot warp. But a module already running must always be stoppable:
 * gating the off-half on the same floor would strand a burner ON at exactly the
 * capacitor level that made it dangerous. Null capacitor is unreadable and does
 * not gate, the same fail-open rule the rest of this codebase follows.
 *
 * ⚠ IT ISSUES ONE CALL AND THEN FALLS THROUGH. This policy has something to do
 * only while the rack disagrees with what is wanted, so the cost to everything
 * below it is a tick or two after the state changes and nothing at all the rest
 * of the time.
 *
 * ⚠ WHICH MODULE, WHEN SEVERAL ARE FITTED, IS THE CALLER'S FIT ORDER AND
 * NOTHING CLEVERER -- first one that qualifies wins, both halves. That is what
 * the first caller has always done and it is not a considered ranking: hulls carry
 * one prop mod in practice, and the one place the choice is ever forced (a
 * scram, with both kinds aboard) the skip decides it rather than the order. If
 * a caller ever needs "the biggest" or "the cheapest", that is a new rule and it
 * should be argued for rather than discovered here.
 */
export function decidePropulsionModule(inputs: PropulsionInputs): PropulsionDecision {
  const { modules, activeModuleIDs, capacitorRatio, wantBurn, capFloor } = inputs;
  if (modules.length === 0) {
    return NONE;
  }

  if (!wantBurn) {
    // The off-half. Only what is actually cycling, and one module per call: a
    // caller that stops two in a tick has spent a call it did not need to.
    // ⚠ NO CAPACITOR TEST ON THIS PATH, DELIBERATELY. See the header.
    const lit = modules.find((module) => activeModuleIDs.has(module.itemID));
    return lit === undefined ? NONE : { kind: "stop", module: lit };
  }

  // The on-half. `scrammed` is three-state; only an explicit `true` gates, and
  // it gates the MWD half of the rack rather than the rung.
  const scrammed = inputs.scrammed === true;
  const idle = modules.find(
    (module) => !activeModuleIDs.has(module.itemID) && !(scrammed && module.kind !== "afterburner"),
  );
  if (idle === undefined) {
    return NONE;
  }
  // ⚠ THE FLOOR IS THE OPERATOR'S OWN and it gates lighting ONLY. Unreadable
  // capacitor does not gate.
  if (capacitorRatio !== null && capacitorRatio < capFloor) {
    return NONE;
  }
  return { kind: "light", module: idle };
}
