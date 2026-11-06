// PILOT GROUPS — what the Bot Manager launches a bot FOR, when the thing being
// launched is not one pilot.
//
// ⚠ A GROUP IS A HANGAR SQUAD. There is no second grouping model: the player
// already makes, names, colours and fills squads on the landing screen
// (app/hangarPrefs.ts, docs/pilot-hangar.md), and a Bot Manager that invented
// its own "bot groups" beside them would ask the same player to arrange the
// same pilots twice and then keep the two arrangements in step by hand. This
// module is a VIEW over those prefs.
//
// Everything here is PURE over a prefs snapshot and a few readings the panel
// already has. No storage, no fetch, no clock, no component.

import type { ServerBot } from "../app/api.ts";
import type { HangarPrefs } from "../app/hangarPrefs.ts";
import { serverBotFor } from "./pilotRoster.ts";

/**
 * The built-in group's id.
 *
 * ⚠ IT MUST NOT COLLIDE WITH A SQUAD ID. `nextSquadId()` mints `squad-<uuid>`,
 * so a bare word cannot be one; the prefix is kept anyway so a stored value
 * that somehow reaches this namespace is still obviously not a squad.
 */

/** What kind of thing a group is, which is the same as what it can launch. */
export type GroupKind = "squad";

export interface PilotGroup {
  readonly id: string;
  readonly name: string;
  /**
   * The squad's chip colour, so a group reads as the same thing here as on the
   * hangar.
   */
  readonly color: string | null;
  readonly kind: GroupKind;
  /** characterIDs, in the order the player arranged them. */
  readonly members: readonly number[];
}

/**
 * Every group the Bot Manager offers.
 */
export function pilotGroups(prefs: HangarPrefs): readonly PilotGroup[] {
  const squads = prefs.squads.map<PilotGroup>((squad) => ({
    id: squad.id,
    name: squad.name,
    color: squad.color,
    kind: "squad",
    members: prefs.members[squad.id] ?? [],
  }));
  return squads;
}

// --- what each member is doing right now ------------------------------------

/**
 * Where one member of a group stands, from the launcher's point of view.
 *
 * ⚠ FOUR STATES, BECAUSE TWO WOULD LOSE THE ONE THAT DECIDES THE BUTTONS.
 * "Running" and "not running" is not enough: a pilot a tab here HOLDS but is
 * not flying is the only kind that both buttons can act on, and a pilot with no
 * tab here is the only kind "Run here" cannot touch at all. Collapsing them
 * would make one of the two buttons silently do nothing for some members.
 *
 *  • `running-server` — a live server bot has the hull. Nothing can start.
 *  • `running-here`   — a tab in this browser is flying it. Nothing can start.
 *  • `held`           — a tab here holds it, idle. Either button can start it.
 *  • `free`           — nothing here holds it. Only the server can start it.
 */
export type MemberWhere = "running-server" | "running-here" | "held" | "free";

export interface GroupMemberState {
  readonly characterID: number;
  /** The pilot's name, or a plain stand-in -- never a raw id (R7d). */
  readonly name: string;
  readonly where: MemberWhere;
  /** What is flying it, when something is. */
  readonly botName: string | null;
}

export interface GroupRosterInputs {
  /** The server's roster, as the panel already polls it. Ended runs ignored. */
  readonly serverBots: readonly ServerBot[];
  /** characterIDs a tab in THIS browser tab holds, whatever they are doing. */
  readonly heldCharacterIDs: readonly number[];
  /** Of those, the ones whose tab is already flying a bot of its own. */
  readonly busyHereCharacterIDs: readonly number[];
  /** A pilot's name, or null when this browser has never seen it. */
  readonly nameOf: (characterID: number) => string | null;
}

/** What the group's roster looks like right now, one row per member. */
export function groupMemberStates(
  members: readonly number[],
  inputs: GroupRosterInputs,
): readonly GroupMemberState[] {
  const held = new Set(inputs.heldCharacterIDs);
  const busyHere = new Set(inputs.busyHereCharacterIDs);
  return members.map((characterID) => {
    const name = inputs.nameOf(characterID) ?? "Unknown pilot";
    // ⚠ THE SERVER'S CLAIM WINS, the same rule `pilotRunState` states for one
    // pilot: a tab can hold a character's LOGIN while the host flies the hull.
    const serverBot = serverBotFor(inputs.serverBots, characterID);
    if (serverBot !== null) {
      return {
        characterID,
        name,
        where: "running-server" as const,
        botName: serverBot.scriptName,
      };
    }
    if (busyHere.has(characterID)) {
      return { characterID, name, where: "running-here" as const, botName: null };
    }
    return {
      characterID,
      name,
      where: held.has(characterID) ? ("held" as const) : ("free" as const),
      botName: null,
    };
  });
}

// --- what a start would actually do -----------------------------------------

export interface GroupLaunchPlan {
  /** Who "Run on server" would start, in member order. */
  readonly onServer: readonly number[];
  /** Who "Run here" would start. A subset of the above. */
  readonly here: readonly number[];
  /** Who neither button touches, because something already has the hull. */
  readonly busy: readonly number[];
}

/**
 * Who each button would start.
 *
 * ⚠ A PILOT ALREADY FLYING IS SKIPPED, NOT FAILED. Starting a group when two of
 * it are already up must bring the other four -- exactly the rule the hangar's
 * `targetsFor` states for bringing pilots online. Queueing the busy ones so
 * they can refuse would turn a normal state of affairs into two red rows.
 *
 * ⚠ AND `here` IS A SUBSET OF `onServer`, NOT A DISJOINT HALF. A pilot this tab
 * holds can go either way: run it in the tab, or hand its hull to the host
 * (which releases that tab session as part of the start). The difference
 * between the two buttons is what happens when the tab closes, and that is a
 * choice, not a property of the pilot.
 */
export function planGroupLaunch(states: readonly GroupMemberState[]): GroupLaunchPlan {
  return {
    onServer: states
      .filter((s) => s.where === "held" || s.where === "free")
      .map((s) => s.characterID),
    here: states.filter((s) => s.where === "held").map((s) => s.characterID),
    busy: states
      .filter((s) => s.where === "running-server" || s.where === "running-here")
      .map((s) => s.characterID),
  };
}

function pilotWords(count: number): string {
  return count === 1 ? "1 pilot" : `${count} pilots`;
}

/** The group's one-line readout: how many, how many are up, how many are free. */
export function groupStatusWords(states: readonly GroupMemberState[]): string {
  if (states.length === 0) {
    return "No pilots";
  }
  const plan = planGroupLaunch(states);
  const parts = [pilotWords(states.length)];
  if (plan.busy.length > 0) {
    parts.push(`${plan.busy.length} already flying`);
  }
  parts.push(plan.onServer.length === 0 ? "none free" : `${plan.onServer.length} free`);
  return parts.join(" - ");
}

// --- stopping a group ---------------------------------------------------------

export interface GroupStopPlan {
  /** Script bots the server is flying for members, by the id to stop them with. */
  readonly onServer: readonly { readonly characterID: number; readonly botID: string }[];
  /** Members whose tab here is flying a bot of its own. */
  readonly here: readonly number[];
}

/**
 * Who the group's Stop would stop.
 *
 * ⚠ ONLY WHAT IS FLYING NOW, AND ONLY THIS GROUP'S MEMBERS. A group Stop is the
 * pilot row's Stop pressed once per member; it reaches no pilot outside the
 * group, and a member that is idle is simply not in the plan.
 */
export function planGroupStop(
  states: readonly GroupMemberState[],
  serverBots: readonly ServerBot[],
): GroupStopPlan {
  const onServer: { characterID: number; botID: string }[] = [];
  for (const state of states) {
    if (state.where !== "running-server") continue;
    const bot = serverBotFor(serverBots, state.characterID);
    if (bot === null) continue;
    onServer.push({ characterID: state.characterID, botID: bot.botID });
  }
  return {
    onServer,
    here: states.filter((s) => s.where === "running-here").map((s) => s.characterID),
  };
}

/**
 * The group's members as one line of names, and the bot they fly when it is
 * the same one.
 *
 * ⚠ THE BOT IS SAID ONCE, NOT BESIDE EVERY NAME. A group started together flies
 * one bot, and "Name (Belt loop)" five times over said it five times. It
 * is named per pilot only when the flying members differ -- one started on its
 * own from the Pilots view, say -- because that is the one case the per-pilot
 * name tells a player something.
 */
export function groupRosterWords(states: readonly GroupMemberState[]): {
  readonly names: string;
  readonly commonBot: string | null;
} {
  const bots = new Set(states.flatMap((s) => (s.botName === null ? [] : [s.botName])));
  if (bots.size <= 1) {
    return { names: states.map((s) => s.name).join(", "), commonBot: [...bots][0] ?? null };
  }
  return {
    names: states.map((s) => (s.botName === null ? s.name : `${s.name} (${s.botName})`)).join(", "),
    commonBot: null,
  };
}

/** Whether the row's one button is Stop rather than Start. */
export function groupCanStop(plan: GroupStopPlan): boolean {
  return plan.onServer.length + plan.here.length > 0;
}

/**
 * The row's status when nothing is starting: who is flying, or why Start
 * reaches fewer pilots than the group has.
 *
 * ⚠ THE "NO TAB OPEN HERE" CASE IS THE ONE THAT MATTERS. With Server unticked,
 * Start can only reach pilots signed in to this tab; with none, the button is
 * disabled, and a disabled button with no sentence beside it reads as broken.
 */
export function groupRunStatusWords(launch: GroupLaunchPlan, onServer: boolean): string {
  const flying = launch.busy.length;
  if (flying > 0) {
    return `${flying} flying`;
  }
  if (launch.onServer.length === 0) {
    return "Nobody free";
  }
  if (!onServer) {
    if (launch.here.length === 0) return "No tab open here";
    if (launch.here.length < launch.onServer.length) {
      return `${launch.here.length} of ${launch.onServer.length} here`;
    }
  }
  return "Idle";
}

/**
 * The sentence a start prints when it turns out there was nobody to start.
 *
 * ⚠ IT TAKES THE KIND, because different kinds of group can be empty for
 * different reasons and only some are fixable in the Bot Manager. An empty
 * squad wants pilots.
 */
export function groupStartEmptyWords(_kind: GroupKind, memberCount: number): string {
  if (memberCount === 0) {
    return "This group has no pilots yet. Add some to the squad on the Pilot Hangar.";
  }
  return "Every pilot in this group is already flying something.";
}
