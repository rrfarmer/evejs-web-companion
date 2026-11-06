// The RUN-APPROVAL path for a saved bot — extracted ONCE so the Bots launcher
// and the Bot Manager's pilot rows share it rather than fork it, per this
// codebase's rule that a launcher "embeds the real components and forks
// nothing." No component, no fetch of its own, no clock — exactly the house
// style set by libraryView.ts and pilotRoster.ts: a pure core, unit-tested
// without a DOM, with a thin caller supplying the real fetch/confirm/starters.
//
// Both callers go through the SAME two steps for the SAME reason: decode the
// stored doc (decode-on-read — a saved bot is executable authority, and every
// byte reaching a runner passes the codec, never the caller's own trust of
// what it once wrote), then get the player's explicit approval before
// anything starts. Skipping either step here would silently re-introduce the
// fork this module exists to prevent.

import type { BotScript } from "./botScript.ts";
import { startForGroup, type GroupStartEntry } from "./groupStart.ts";
import { decodeScriptValue } from "./scriptCodec.ts";
import {
  analyzeBotRunPolicy,
  BOT_RISK_LABELS,
  createBotLaunchGrant,
  type BotLaunchGrant,
  type BotRunPolicy,
} from "./runPolicy.ts";

/** What became of a start attempt. Never throws — every failure is a value. */
export type StartOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "declined" } // the player said no at the confirm
  | { readonly kind: "refused"; readonly sentence: string }; // not found, codec refusal, or a failed call

/** What both start paths need to fetch the record and get player approval. */
export interface ApprovalDeps {
  fetchScript(scriptID: string): Promise<{ scriptID: string; rev: number; doc: unknown } | null>;
  confirm(message: string): boolean;
}

/** Deps for starting a bot IN THIS TAB. */
export interface LocalStartDeps extends ApprovalDeps {
  startCustomBot(doc: BotScript, scriptID: string): Promise<void>;
}

/** Deps for starting a bot ON THE SERVER, flying the caller's current character. */
export interface ServerStartDeps extends ApprovalDeps {
  startServerBot(characterID: number, scriptID: string, grant: BotLaunchGrant): Promise<unknown>;
  releaseSession(): Promise<void>;
}

/**
 * The confirm text. Pure — no window, no clock. Player-facing wording, copied
 * verbatim from Bots.svelte's `approveRun`: the no-risk sentence, the
 * sub-bot sentence, and the runtime-limit sentence with its minutes-vs-hours
 * phrasing are all already reviewed and must not drift between callers.
 *
 * ⚠ `pilotCount` IS HOW MANY HULLS THIS ONE YES COMMITS, and it exists because
 * a group start asks ONCE for a whole group. Six confirms for one button is not
 * six times the consent, it is a dialog a player clicks through without
 * reading; but a prompt that says "Run X?" while starting six pilots would hide
 * the scale of what was agreed to. Absent (or 1) keeps the single-pilot wording
 * that every existing caller and its tests already pin.
 */
export function runApprovalPrompt(
  name: string,
  policy: BotRunPolicy,
  runtimeMinutes: number | null,
  pilotCount?: number | null,
): string {
  const permissions =
    policy.riskClasses.length === 0
      ? "No spending, destructive, social, fleet, mission, colony, inventory, or combat permission was found."
      : `This run may ${policy.riskClasses.map((risk) => BOT_RISK_LABELS[risk]).join("; ")}.`;
  const included = policy.containsSubBots
    ? "\n\nIt includes other saved bots, whose current contents will be loaded when it starts."
    : "";
  const limit =
    runtimeMinutes === null
      ? ""
      : `\n\nThe server will stop it after ${runtimeMinutes < 60 ? `${runtimeMinutes} minutes` : `${runtimeMinutes / 60} hours`}.`;
  const on =
    pilotCount !== undefined && pilotCount !== null && pilotCount > 1
      ? ` on ${pilotCount} pilots`
      : "";
  return `Run “${name}”${on}?\n\n${permissions}${included}${limit}`;
}

/**
 * What the approval step alone can produce.
 *
 * ⚠ NEVER "started" — approval starts nothing. Saying so in the type is what
 * lets a group start hand a refusal or a decline straight back as its own
 * outcome; with the whole `StartOutcome` here, a "started" that cannot happen
 * would still have to be handled by every caller, carrying no entries.
 */
type ApprovalOutcome = Exclude<StartOutcome, { readonly kind: "started" }>;

/** A fetched, decoded, approved bot — what every starter below needs. */
interface Approved {
  readonly kind: "approved";
  readonly doc: BotScript;
  readonly rev: number;
  readonly policy: BotRunPolicy;
}

/**
 * Fetch, decode, and get approval for one saved bot — the part shared by every
 * start path. Returns the decoded doc and the fetched record's rev on
 * success, so a caller-specific "started" outcome from here on is just
 * calling its own starter.
 */
async function loadAndApprove(
  deps: ApprovalDeps,
  scriptID: string,
  runtimeMinutes: number | null,
  pilotCount?: number | null,
): Promise<Approved | ApprovalOutcome> {
  const record = await deps.fetchScript(scriptID);
  if (record === null) {
    return { kind: "refused", sentence: "That bot could not be found." };
  }
  const decoded = decodeScriptValue(record.doc);
  if (!decoded.ok) {
    return { kind: "refused", sentence: decoded.refusal };
  }
  const policy = analyzeBotRunPolicy(decoded.doc);
  if (!deps.confirm(runApprovalPrompt(decoded.doc.name, policy, runtimeMinutes, pilotCount))) {
    return { kind: "declined" };
  }
  return { kind: "approved", doc: decoded.doc, rev: record.rev, policy };
}

/** Start a saved bot IN THIS TAB, flying the ship it already controls. */
export async function startHere(deps: LocalStartDeps, scriptID: string): Promise<StartOutcome> {
  let step: Approved | ApprovalOutcome;
  try {
    step = await loadAndApprove(deps, scriptID, null);
  } catch {
    return { kind: "refused", sentence: "Could not start that bot." };
  }
  if (step.kind !== "approved") {
    return step;
  }
  try {
    await deps.startCustomBot(step.doc, scriptID);
  } catch (cause) {
    // Say why, as the server path does: a fit refusal names what to fit.
    return { kind: "refused", sentence: cause instanceof Error ? cause.message : "Could not start that bot." };
  }
  return { kind: "started" };
}

/**
 * Run a saved bot ON THE SERVER, flying THIS caller's current character.
 *
 * The handover is the SERVER's, in one request: /api/bots/start releases the
 * caller's own held session and claims the character for the bot atomically.
 * Started-first matters twice over — the login/select screens a tab falls to
 * poll the bot-flying marks, and a bot that already exists is on their FIRST
 * read (release-first left them blank until the next poll); and a refused
 * start changes nothing, so the caller just keeps flying (no take-the-hull-
 * back dance). `releaseSession` afterwards only syncs the caller's own UI —
 * its server-side session is already gone, so a failure there is NOT a failed
 * start: the bot has the hull either way.
 */
export async function startOnServer(
  deps: ServerStartDeps,
  scriptID: string,
  characterID: number,
  runtimeMinutes: number,
): Promise<StartOutcome> {
  let step: Approved | ApprovalOutcome;
  try {
    step = await loadAndApprove(deps, scriptID, runtimeMinutes);
  } catch {
    return { kind: "refused", sentence: "Could not start that bot on the server." };
  }
  if (step.kind !== "approved") {
    return step;
  }
  const grant = createBotLaunchGrant(step.rev, step.policy, runtimeMinutes);
  try {
    // START FIRST. See the doc comment above — a refused start must change
    // nothing, so the release only happens once the server has accepted.
    await deps.startServerBot(characterID, scriptID, grant);
  } catch (cause) {
    return {
      kind: "refused",
      sentence: cause instanceof Error ? cause.message : "Could not start that bot on the server.",
    };
  }
  try {
    await deps.releaseSession();
  } catch {
    // The bot has the hull either way; the caller's next read notices.
  }
  return { kind: "started" };
}

// --- the same two paths, for a whole GROUP of pilots ------------------------
//
// ⚠ ONE APPROVAL FOR THE GROUP, NOT ONE PER PILOT, and the prompt says how many
// hulls the yes covers (`runApprovalPrompt`'s `pilotCount`). Six confirms in a
// row is not six times the consent -- it is a dialog that gets clicked through
// -- and the decision a player is actually making is about the BOT, which is
// the same bot for every member.
//
// ⚠ ONE FETCH AND ONE GRANT TOO. A group start runs ONE script, so its rev and
// its risk classes are the same for every pilot; re-fetching per pilot would
// also let the library change underneath a run that the player approved once,
// so what flies on pilot six would not be what was agreed to for pilot one.

/** What became of a group start. Never throws — every failure is a value. */
export type GroupStartOutcome =
  | { readonly kind: "declined" }
  /** Nothing was started at all: the bot could not be fetched or decoded. */
  | { readonly kind: "refused"; readonly sentence: string }
  /** The group was worked through; each pilot's own fate is in `entries`. */
  | { readonly kind: "ran"; readonly entries: readonly GroupStartEntry[] };

/** Deps for starting a saved bot on a group IN THIS TAB. */
export interface LocalGroupStartDeps extends ApprovalDeps {
  /**
   * Start the bot on the tab session holding THIS character.
   *
   * ⚠ ADDRESSED BY CHARACTER, unlike `LocalStartDeps.startCustomBot`. A pilot
   * row acts on its own session and needs no address; a group spans sessions,
   * so a starter that ran against "the active pilot" would start the same bot
   * on one hull as many times as the group has members.
   */
  startCustomBotFor(characterID: number, doc: BotScript, scriptID: string): Promise<void>;
}

/** Deps for starting a saved bot on a group ON THE SERVER. */
export interface ServerGroupStartDeps extends ApprovalDeps {
  startServerBot(characterID: number, scriptID: string, grant: BotLaunchGrant): Promise<unknown>;
  /**
   * Sync this tab's own UI after the host took a character a session here was
   * holding. A no-op for a member with no tab open here.
   *
   * ⚠ NOT THE HANDOVER ITSELF. `/api/bots/start` releases the CALLER's held
   * session and claims the character atomically, so the caller for a held
   * member must be that member's own session (its token is what the server
   * releases). This only catches the tab up; a failure here is not a failed
   * start, the same as in `startOnServer`.
   */
  releaseHeld(characterID: number): Promise<void>;
}

/**
 * Run a saved bot on every named pilot, ON THE SERVER, one at a time.
 *
 * The ordering and the never-strand-the-rest rule are `startForGroup`'s.
 * Callers pass only the members a start can actually reach — see
 * `planGroupLaunch` in bots/pilotGroups.ts, which drops the ones already flying
 * rather than queueing them up to refuse.
 */
export async function startGroupOnServer(
  deps: ServerGroupStartDeps,
  scriptID: string,
  characterIDs: readonly number[],
  runtimeMinutes: number,
  onProgress?: (entries: readonly GroupStartEntry[]) => void,
): Promise<GroupStartOutcome> {
  let step: Approved | ApprovalOutcome;
  try {
    step = await loadAndApprove(deps, scriptID, runtimeMinutes, characterIDs.length);
  } catch {
    return { kind: "refused", sentence: "Could not start that bot on the server." };
  }
  if (step.kind !== "approved") {
    return step;
  }
  const grant = createBotLaunchGrant(step.rev, step.policy, runtimeMinutes);
  const entries = await startForGroup(
    characterIDs,
    async (characterID) => {
      // START FIRST, then sync — the same order and the same reason as the
      // single-pilot path: a refused start must change nothing.
      await deps.startServerBot(characterID, scriptID, grant);
      try {
        await deps.releaseHeld(characterID);
      } catch {
        // The bot has the hull either way; the tab's next read notices.
      }
    },
    onProgress,
  );
  return { kind: "ran", entries };
}

/**
 * Run a saved bot on every named pilot IN THIS TAB.
 *
 * ⚠ EVERY MEMBER HERE MUST ALREADY HAVE A SESSION IN THIS TAB — a tab run flies
 * a ship the tab already controls, and there is nothing to sign a pilot in
 * with from a bot panel. `planGroupLaunch().here` is that list; a member
 * without one is dropped there, with a sentence, rather than queued to fail.
 *
 * ⚠ AND THESE RUNS DIE WITH THE TAB, all of them at once. That is the whole
 * difference from the server path and it is why both buttons exist.
 */
export async function startGroupHere(
  deps: LocalGroupStartDeps,
  scriptID: string,
  characterIDs: readonly number[],
  onProgress?: (entries: readonly GroupStartEntry[]) => void,
): Promise<GroupStartOutcome> {
  let step: Approved | ApprovalOutcome;
  try {
    step = await loadAndApprove(deps, scriptID, null, characterIDs.length);
  } catch {
    return { kind: "refused", sentence: "Could not start that bot." };
  }
  if (step.kind !== "approved") {
    return step;
  }
  const approved = step;
  const entries = await startForGroup(
    characterIDs,
    (characterID) => deps.startCustomBotFor(characterID, approved.doc, scriptID),
    onProgress,
  );
  return { kind: "ran", entries };
}
