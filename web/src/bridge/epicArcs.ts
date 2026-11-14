// The epic arcs as the retail client's epic arc service makes them (eve/client/script/ui/shared/epicArcSvc.py,
// epicArcs/epicArcController.py: EpicArcController, EpicArcMissionNode, EpicArc).
//
// - The arcs and their missions are the client's built data (evemissions/common/epic_arcs_data: iter_epic_arcs,
//   arcRestartInterval, each mission's agentID and nextMissions); an arc counts where its restart interval is above
//   1 (IsValidArc).
// - The pilot's part is agentMgr.GetMyEpicArcStatus(): by arc, by mission, acceptedDate, completedDate, quitDate and
//   nameID (the mission offered).
// - The chapters are agentMgr.GetMessagesForEpicArcMissions()' chapter titles by mission
//   (messages.epicMission.journalText.chapterTitle).
// - A node's next ones are its mission's nextMissions; the arc's start nodes those no other mission leads to.
//
// Not as the client: a mission's destination agent (GetDestinationAgentID asks the journal's active mission for the
// agent's destination agent) is the mission's own agent here; the research agent's corporation rule of CanUseAgent
// is not needed for the arcs' agents and is left out.

import type { JsonValue } from "./wire.ts";

/** epicArcConst. */
export const ARC_STARTED = 1, ARC_AVAILABLE = 2, ARC_UNAVAILABLE = 3, ARC_COMPLETE = 4;
export type EpicArcState = typeof ARC_STARTED | typeof ARC_AVAILABLE | typeof ARC_UNAVAILABLE | typeof ARC_COMPLETE;

/** epicArcConst's tables by arc: the tag line, the hero card's picture, the faction's logo (eveicon). */
export const EPIC_ARC_LOOKS: Readonly<Record<number, { readonly tagLine: string; readonly background: string; readonly logo: string }>> = Object.freeze({
  52: { tagLine: "UI/Agency/FlavorLines/EpicGallenteTagline1", background: "hero_card_epic_arc_gallente", logo: "gallente_logo" },
  40: { tagLine: "UI/Agency/FlavorLines/EpicCaldariTagline1", background: "hero_card_epic_arc_caldari", logo: "caldari_logo" },
  53: { tagLine: "UI/Agency/FlavorLines/EpicMinmatarTagline1", background: "hero_card_epic_arc_minmatar", logo: "minmatar_logo" },
  48: { tagLine: "UI/Agency/FlavorLines/EpicAmarrTagline1", background: "hero_card_epic_arc_amarr", logo: "amarr_logo" },
  55: { tagLine: "UI/Agency/FlavorLines/EpicGuristasTagline1", background: "hero_card_epic_arc_guristas", logo: "guristas_logo" },
  29: { tagLine: "UI/Agency/FlavorLines/EpicSistersTagline1", background: "hero_card_epic_arc_soe", logo: "soe_logo" },
  56: { tagLine: "UI/Agency/FlavorLines/EpicAngelTagline1", background: "hero_card_epic_arc_angel", logo: "angel_cartel_logo" },
  128: { tagLine: "UI/Agency/FlavorLines/EpicORETagline1", background: "hero_card_epic_arc_ore_nologo", logo: "ore_logo" },
  132: { tagLine: "UI/Agency/FlavorLines/EpicAIRTagline1", background: "hero_card_epic_arc_air", logo: "air_logo" },
});

export interface EpicArcSource {
  readonly epicArcID: number; readonly nameID: number | null; readonly factionID: number | null; readonly restartInterval: number | null;
  readonly missions: Readonly<Record<string, { readonly agentID: number | null; readonly nextMissions: readonly number[] }>>;
}
/** A mission's status: the dates as FILETIMEs (strings), null where unset. */
export interface EpicArcMissionStatus { readonly acceptedDate: string | null; readonly completedDate: string | null; readonly quitDate: string | null; readonly nameID: number | null }

type DictEntry = readonly [JsonValue, JsonValue];
function entries(value: JsonValue | undefined): readonly DictEntry[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { type?: unknown; name?: unknown; entries?: unknown; args?: unknown };
    if (v.type === "dict" && Array.isArray(v.entries)) return v.entries as DictEntry[];
    if (v.type === "object" && v.name === "util.KeyVal") return entries(v.args as JsonValue);
  }
  return [];
}
function scalar(value: JsonValue | undefined): string | null {
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) return scalar((value as { value: JsonValue }).value);
  return null;
}
const present = (v: string | null) => (v === null || v === "" || v === "0" ? null : v);

/** GetMyEpicArcStatus' answer: by arc, by mission. */
export function decodeEpicArcStatus(value: JsonValue | undefined): ReadonlyMap<number, ReadonlyMap<number, EpicArcMissionStatus>> {
  const out = new Map<number, Map<number, EpicArcMissionStatus>>();
  for (const [arc, missions] of entries(value)) {
    const byMission = new Map<number, EpicArcMissionStatus>();
    for (const [mission, row] of entries(missions)) {
      const field = (k: string) => entries(row).find((e) => e[0] === k)?.[1];
      byMission.set(Number(scalar(mission)), { acceptedDate: present(scalar(field("acceptedDate"))), completedDate: present(scalar(field("completedDate"))), quitDate: present(scalar(field("quitDate"))), nameID: Number(scalar(field("nameID"))) || null });
    }
    out.set(Number(scalar(arc)), byMission);
  }
  return out;
}

/** GetMessagesForEpicArcMissions' chapter titles by mission. */
export function decodeEpicArcChapterTitles(value: JsonValue | undefined): ReadonlyMap<number, number> {
  const titles = entries(value).find((e) => e[0] === "messages.epicMission.journalText.chapterTitle")?.[1];
  return new Map(entries(titles).map(([mission, message]) => [Number(scalar(mission)), Number(scalar(message))]));
}

interface Node {
  readonly epicArcID: number; readonly missionID: number; readonly agentID: number;
  readonly status: EpicArcMissionStatus | null;
  readonly next: Node[]; readonly previous: Node[];
  chapterID: number | null;
}

/** An arc as the job board's EpicArcJob reads it. */
export interface EpicArcView {
  readonly epicArcID: number; readonly nameID: number | null; readonly factionID: number | null;
  readonly state: EpicArcState;
  /** GetNumMissions, GetNumMissionsCompleted. */
  readonly missions: number; readonly missionsCompleted: number;
  /** GetActiveAgent's: the active mission's agent. */
  readonly activeAgentID: number | null;
  /** GetCompleteTime as ms (the last mission's completedDate), null where not complete. */
  readonly completeTimeMs: number | null;
  /** is_replayable: complete, and the restart interval (minutes) gone since. */
  readonly replayable: boolean;
  /** GetChapterIDs (the chapter title messages, in order) and GetCurrentChapterID. */
  readonly chapterIDs: readonly number[]; readonly currentChapterID: number | null;
}

const filetimeMs = (ft: string | null) => (ft !== null && /^\d+$/.test(ft) ? Number((BigInt(ft) - 116_444_736_000_000_000n) / 10_000n) : null);

/**
 * The arcs (EpicArcController), each read as the job board reads it. `canUseAgent` is standingSvc.CanUseAgent for an
 * agent (IsAgentStandingSufficientToUse); null where the agent is not yet known (it counts as not usable).
 */
export function epicArcViews(
  arcs: readonly EpicArcSource[], statuses: ReadonlyMap<number, ReadonlyMap<number, EpicArcMissionStatus>>, chapterTitles: ReadonlyMap<number, number>,
  canUseAgent: (agentID: number) => boolean, nowMs: number,
): EpicArcView[] {
  const views: EpicArcView[] = [];
  for (const arc of arcs) {
    if (!((arc.restartInterval ?? 0) > 1)) continue;
    const nodes = new Map<number, Node>();
    for (const [key, m] of Object.entries(arc.missions)) {
      const missionID = Number(key);
      nodes.set(missionID, { epicArcID: arc.epicArcID, missionID, agentID: m.agentID ?? 0, status: statuses.get(arc.epicArcID)?.get(missionID) ?? null, next: [], previous: [], chapterID: chapterTitles.get(missionID) ?? null });
    }
    for (const node of nodes.values()) for (const n of arc.missions[String(node.missionID)]?.nextMissions ?? []) {
      const next = nodes.get(n);
      if (next && next !== node) { node.next.push(next); next.previous.push(node); }
    }
    const starts = [...nodes.values()].filter((n) => !n.previous.length);
    if (!starts.length) continue;
    const accepted = (n: Node) => Boolean(n.status?.acceptedDate);
    const complete = (n: Node) => Boolean(n.status?.completedDate);
    const offered = (n: Node) => Boolean(n.status?.nameID);
    const active = (n: Node) => offered(n) && !complete(n);
    const nextNode = (n: Node): Node | null => n.next.find(accepted) ?? n.next.find(offered) ?? n.next[0] ?? null;
    // The walks guard against a loop in the data.
    const walk = <T>(start: Node, step: (n: Node, seen: Set<Node>) => T, seen = new Set<Node>()): T => { seen.add(start); return step(start, seen); };
    const arcComplete = (n: Node, seen: Set<Node>): boolean => (!n.next.length ? complete(n) : n.next.some((x) => !seen.has(x) && walk(x, arcComplete, seen)));
    const activeMissions = (n: Node, seen: Set<Node>): Node[] | null => {
      if (active(n)) return [n];
      for (const x of n.next) { if (seen.has(x)) continue; const r = walk(x, activeMissions, seen); if (r) return r; }
      return null;
    };
    const chainLength = (n: Node): number => { let count = 0; const seen = new Set<Node>(); for (let x: Node | undefined = n; x && !seen.has(x); x = x.next[0]) { seen.add(x); count += 1; } return count; };
    const missionNumber = (n: Node): number => { let count = 0; const seen = new Set<Node>(); for (let x: Node | undefined = n; x && !seen.has(x); x = x.previous[0]) { seen.add(x); count += 1; } return count; };
    const nextChapter = (n: Node): number | null => { const seen = new Set<Node>([n]); for (let x = nextNode(n); x && !seen.has(x); x = nextNode(x)) { if (x.chapterID) return x.chapterID; seen.add(x); } return null; };
    for (const s of starts) if (!s.chapterID) s.chapterID = nextChapter(s);

    const isComplete = starts.some((s) => walk(s, arcComplete));
    const started = starts.some(accepted);
    let missions: Node[] | null = null;
    for (const s of starts) if (accepted(s)) missions = walk(s, activeMissions);
    const activeList = (missions ?? starts.slice()).slice().sort((a, b) => Number(canUseAgent(b.agentID)) - Number(canUseAgent(a.agentID)));
    const activeMission = activeList[0] ?? null;
    const startNode = starts.find(accepted) ?? starts.find(offered) ?? activeMission!;
    const state: EpicArcState = isComplete ? ARC_COMPLETE : started ? ARC_STARTED : starts.some((s) => canUseAgent(s.agentID)) ? ARC_AVAILABLE : ARC_UNAVAILABLE;
    const total = chainLength(startNode);
    const activeNum = started ? missionNumber((missions ?? starts)[0]!) : 0;
    let completeTimeMs: number | null = null;
    if (isComplete) { const seen = new Set<Node>(); let x: Node | null = startNode; while (x && x.next.length && !seen.has(x)) { seen.add(x); x = nextNode(x); } completeTimeMs = filetimeMs(x?.status?.completedDate ?? null); }
    const chapterIDs: number[] = [];
    { const seen = new Set<Node>(); for (let x: Node | null = startNode; x && !seen.has(x); x = nextNode(x)) { seen.add(x); if (x.chapterID && !chapterIDs.includes(x.chapterID)) chapterIDs.push(x.chapterID); } }
    let currentChapterID: number | null = null;
    { const seen = new Set<Node>(); let chapter: number | null = null; for (let x: Node | null = startNode; x && !seen.has(x); x = nextNode(x)) { seen.add(x); if (x.chapterID) chapter = x.chapterID; if (active(x)) { currentChapterID = chapter; break; } } }
    views.push({
      epicArcID: arc.epicArcID, nameID: arc.nameID, factionID: arc.factionID, state,
      missions: total, missionsCompleted: isComplete ? total : Math.max(0, activeNum - 1),
      activeAgentID: activeMission?.agentID || null, completeTimeMs,
      replayable: isComplete && completeTimeMs !== null && (nowMs - completeTimeMs) / 1000 >= (arc.restartInterval ?? 0) * 60,
      chapterIDs, currentChapterID: currentChapterID ?? chapterIDs[0] ?? null,
    });
  }
  return views;
}

/** eveCfg.CanUseAgent on the effective standings (the three, each raised by its skill): an aura agent always; a level 1
 * agent other than a research one always; else the greatest at least (level - 1) * 2 - 1 and the least above -2. */
export function canUseAgentAtLevel(level: number | null, agentTypeID: number | null, raised: { readonly value: number; readonly low: boolean }): boolean {
  const AURA = 11, RESEARCH = 4;
  if (agentTypeID === AURA) return true;
  if (level === 1 && agentTypeID !== RESEARCH) return true;
  if (level === null) return false;
  return !raised.low && raised.value >= (level - 1) * 2 - 1;
}
