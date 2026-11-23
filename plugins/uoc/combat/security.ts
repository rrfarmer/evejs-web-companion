import { randomUUID } from "node:crypto";

/** Solo Security scope, deliberately limited to WC74's proven NPC-wave content. */
export const SECURITY_L1 = new Map<number, number>([[2504, 875], [2925, 1940], [13735, 3030]]);
/** WC74 securityMissions.js @ 213da333; templates from frozen 261028.1-test. */
export const SECURITY_L2 = new Map<number, number>([[909, 209]]);
export function securityContent(level:number):ReadonlyMap<number,number>|null{return level===1?SECURITY_L1:level===2?SECURITY_L2:null;}
export function securityLevelMatches(actual:number,level:number,rule:"EXACT"|"UP_TO"):boolean{return (actual===1||actual===2)&&(rule==="UP_TO"?actual<=level:actual===level);}
export interface Identity { readonly agentID: number; readonly missionID: number; readonly titleID: number | null; readonly acceptedKey: string; readonly contentID: number; readonly dungeonID: number; readonly destinationSystemID: number; readonly locationNumber: number; readonly instanceID: number | null; readonly roomID: number | null }
export interface Offer { readonly agentID: number; readonly missionID: number; readonly titleID: number | null; readonly expirationTime: string | null; readonly key: string; readonly status: "offered" | "accepted"; readonly contentID: number; readonly dungeonID: number; readonly dungeonCount: number; readonly otherObjectives: number; readonly shipRestricted: boolean; readonly destinationSystemID: number; readonly locationNumber: number; readonly expectedISK: number }
export interface Credit { readonly transactionID: number; readonly kind: 33 | 34; readonly isk: number; readonly taxISK: number; readonly characterID: number; readonly agentID: number; readonly issuedAtOrAfter: boolean }
export interface Observation {
  readonly observedAt: number; readonly characterID: number; readonly shipID: number; readonly agentID: number; readonly agentLevel: number; readonly agentStationID: number; readonly agentSystemID: number;
  readonly dockedStationID: number | null; readonly systemID: number; readonly inSpace: boolean; readonly inWarp: boolean | null;
  /** null is a known empty journal. Unreadable observations must reject rather than return null. */
  readonly mission: Offer | null;
  readonly buttons: { readonly request: number | null; readonly accept: number | null; readonly complete: number | null };
  readonly unqualifiedOffer?: {readonly agentID:number;readonly missionID:number;readonly missionKey:string} | null;
  readonly routeReachable: boolean | null;
  readonly entry: { readonly sequence: number; readonly at: number; readonly characterID: number; readonly shipID: number; readonly dungeonID: number; readonly instanceID: number; readonly roomID: number; readonly landed: boolean; readonly onEntryGrid: boolean } | null;
  readonly dungeon: { readonly dungeonID: number; readonly instanceID: number; readonly roomID: number } | null;
  /** Both objective flags must come from native mission reads, never a cleared grid. */
  readonly objectiveComplete: boolean | null; readonly dungeonObjectiveComplete: boolean | null;
  readonly combatSettled: boolean | null; readonly eligibleNpcIDs: readonly number[] | null;
  readonly gates: readonly { readonly itemID: number; readonly distanceM: number; readonly onEntryGrid: boolean }[] | null;
  readonly wallet: number | null; readonly lp: number | null; readonly credits: readonly Credit[] | null;
}
export type CommandKind = "ROUTE_AGENT" | "ROUTE_SYSTEM" | "REQUEST" | "ACCEPT" | "MISSION_WARP" | "APPROACH_GATE" | "GATE" | "COMPLETE";
export interface Command { readonly id: string; readonly kind: CommandKind; readonly characterID: number; readonly shipID: number; readonly agentID: number; readonly missionKey: string | null; readonly targetID: number | null; readonly actionID: number | null; readonly issuedAt: number; readonly afterSequence: number; readonly fromRoomID: number | null; readonly destinationSystemID: number | null; readonly locationNumber: number | null; readonly status: "DISPATCHED" | "ACKNOWLEDGED"; readonly completionConfirmed: boolean; readonly reward?: import("../shared/rewards/index.ts").MissionRewardReadout | null }
export interface Completion { readonly identity: Identity; readonly commandID: string; readonly expectedISK: number; readonly isk: number | null; readonly taxISK: number | null; readonly lp: number | null; readonly reward?: import("../shared/rewards/index.ts").MissionRewardReadout | null; readonly transactionIDs: readonly number[] }
export type Phase = "AGENT" | "OFFER" | "ACCEPT" | "MISSION_SYSTEM" | "ENTRY" | "COMBAT" | "SETTLE" | "PROGRESS" | "RETURN" | "COMPLETE" | "DONE" | "BLOCKED";
export interface State { readonly version: 1; readonly revision: number; readonly runID: string; readonly accountID: number | string; readonly characterID: number; readonly shipID: number; readonly agentID: number; readonly agentStationID: number; readonly agentSystemID: number; readonly agentLevel?:1|2; readonly deadlineMs: number; readonly missionLimit: number|null; readonly phase: Phase; readonly reason: string | null; readonly unqualifiedOffer?:{readonly agentID:number;readonly missionID:number;readonly missionKey:string}|null; readonly offer: Offer | null; readonly identity: Identity | null; readonly pending: Command | null; readonly before: { readonly wallet: number; readonly lp: number } | null; readonly completed: readonly Completion[] }
export interface Journal { read(): Promise<State | null>; /** Atomic durable compare-and-swap, fail on stale revision. */ save(expectedRevision: number | null, next: State): Promise<void> }
export interface Hooks {
  readonly journal: Journal;
  /** Optional narrower content scope, checked before accepting an offer. */
  readonly allowOffer?: (offer: Offer) => boolean;
  /** Must freshly read the held pilot and fail on unreadable/ambiguous evidence. */
  observe(): Promise<Observation>;
  /** Freshly fence run, held pilot, ship, objective and exact action at the native mutation boundary. */
  execute(command: Command, assertCurrent: () => void): Promise<{ readonly completed?: boolean; readonly reward?: import("../shared/rewards/index.ts").MissionRewardReadout | null } | void>;
  /** Existing NPC-only combat ladder, with fresh identity, target, ship, run and Stop fences at native dispatch. */
  combat(identity: Identity, assertCurrent: () => void): Promise<void>;
  /** Existing combat custody settlement: modules, locks and drones are physically settled. */
  settle(assertCurrent: () => void): Promise<void>;
  now(): number;
}
const positive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const missionMatches = (offer: Offer, identity: Identity) => offer.agentID === identity.agentID && offer.missionID === identity.missionID && offer.titleID === identity.titleID && offer.contentID === identity.contentID && offer.dungeonID === identity.dungeonID && offer.key === identity.acceptedKey;
const sameOffer = (a: Offer, b: Offer) => a.agentID === b.agentID && a.missionID === b.missionID && a.titleID === b.titleID && a.contentID === b.contentID && a.dungeonID === b.dungeonID && a.destinationSystemID === b.destinationSystemID && a.locationNumber === b.locationNumber && a.expectedISK === b.expectedISK;
const validOffer = (a: Offer, level:number) => a.status === "offered" && positive(a.agentID) && positive(a.missionID) && positive(a.destinationSystemID) && Number.isSafeInteger(a.locationNumber) && a.locationNumber >= 0 && securityContent(level)?.get(a.contentID) === a.dungeonID && a.dungeonCount === 1 && a.otherObjectives === 0 && a.shipRestricted === false && finite(a.expectedISK) && a.expectedISK >= 0;

/** One serialized tick at a time; an interrupted dispatched command remains in the journal and is never reissued. */
export function createSecurityCoordinator(hooks: Hooks) {
  let retired = false, inflight: Promise<void> | null = null;
  const assertCurrent = () => { if (retired) throw new Error("Security run retired; native dispatch denied."); };
  async function tickOnce() {
    assertCurrent();
    const permitted=(offer:Offer)=>validOffer(offer,state!.agentLevel??1)&&(hooks.allowOffer?.(offer)??true);
    let state = await hooks.journal.read();
    if (!state || state.version !== 1) throw new Error("Security custody journal is missing or invalid.");
    const save = async (patch: Partial<State>) => { assertCurrent(); const next = { ...state!, ...patch, revision: state!.revision + 1 }; await hooks.journal.save(state!.revision, next); state = next; };
    const block = async (reason: string) => save({ phase: "BLOCKED", reason });
    if (["DONE", "BLOCKED"].includes(state.phase)) return;
    if (hooks.now() >= state.deadlineMs) { await block("Runtime elapsed; stop and park with custody retained."); return; }
    const o = await hooks.observe(); assertCurrent();
    if (o.characterID !== state.characterID || o.shipID !== state.shipID || o.agentID !== state.agentID || o.agentLevel !== (state.agentLevel??1) || o.agentStationID !== state.agentStationID || o.agentSystemID !== state.agentSystemID || !finite(o.observedAt) || o.observedAt > hooks.now() || hooks.now() - o.observedAt > 15000) { await block("Owner, ship, agent or fresh observation could not be verified."); return; }
    const issue = async (kind: CommandKind, fields: Partial<Command> = {}) => {
      const command: Command = { id: randomUUID(), kind, characterID: state!.characterID, shipID: state!.shipID, agentID: state!.agentID,
        missionKey: state!.identity?.acceptedKey ?? null, targetID: null, actionID: null, issuedAt: hooks.now(), afterSequence: o.entry?.sequence ?? 0,
        fromRoomID: state!.identity?.roomID ?? null, destinationSystemID: null, locationNumber: null, status: "DISPATCHED", completionConfirmed: false, ...fields };
      await save({ pending: command });
      // Failure leaves the durable DISPATCHED record for observation/reconciliation, not replay.
      const result = await hooks.execute(command, assertCurrent); assertCurrent();
      await save({ pending: { ...command, status: "ACKNOWLEDGED", completionConfirmed: command.kind === "COMPLETE" && result?.completed === true, ...(result?.reward ? { reward: result.reward } : {}) } });
    };
    const p = state.pending;
    if (p) {
      const m = o.mission, id = state.identity;
      const arrival = o.entry && o.dungeon && o.entry.sequence > p.afterSequence && o.entry.at >= p.issuedAt && o.entry.characterID === state.characterID && o.entry.shipID === state.shipID && o.entry.dungeonID === id?.dungeonID && o.entry.instanceID === o.dungeon.instanceID && o.entry.dungeonID === o.dungeon.dungeonID && o.entry.roomID === o.dungeon.roomID && o.entry.landed && o.entry.onEntryGrid && o.inSpace && o.inWarp === false;
      if (p.kind === "ROUTE_AGENT" && o.dockedStationID === state.agentStationID) { await save({ pending: null }); return; }
      if (p.kind === "ROUTE_SYSTEM" && o.systemID === id?.destinationSystemID && o.inSpace && o.inWarp === false) { await save({ pending: null, phase: "ENTRY" }); return; }
      if(p.kind==="REQUEST"&&p.status==="ACKNOWLEDGED"&&o.unqualifiedOffer&&o.unqualifiedOffer.agentID===state.agentID&&positive(o.unqualifiedOffer.missionID)&&typeof o.unqualifiedOffer.missionKey==="string"&&o.unqualifiedOffer.missionKey){await save({pending:null,unqualifiedOffer:o.unqualifiedOffer,phase:"BLOCKED",reason:"An unqualified or unreadable native mission offer remains unaccepted."});return;}
      if (p.kind === "REQUEST" && m && permitted(m) && m.agentID === state.agentID) { await save({ pending: null, offer: m, phase: "OFFER" }); return; }
      if (p.kind === "REQUEST" && m && (!permitted(m) || m.agentID !== state.agentID)) { await block("An unsupported or foreign mission offer was left unaccepted."); return; }
      if (p.kind === "ACCEPT" && m && state.offer && sameOffer(state.offer, m) && m.status === "accepted" && m.key === JSON.stringify([m.agentID, m.missionID, m.titleID, m.expirationTime])) {
        if (state.completed.some(c => c.identity.acceptedKey === m.key)) { await block("A previously completed mission identity reappeared."); return; }
        const identity: Identity = { agentID: m.agentID, missionID: m.missionID, titleID: m.titleID, acceptedKey: m.key, contentID: m.contentID, dungeonID: m.dungeonID, destinationSystemID: m.destinationSystemID, locationNumber: m.locationNumber, instanceID: null, roomID: null };
        await save({ pending: null, identity, phase: "MISSION_SYSTEM" }); return;
      }
      if (p.kind === "MISSION_WARP" && arrival && id) { await save({ pending: null, identity: { ...id, instanceID: o.entry!.instanceID, roomID: o.entry!.roomID }, phase: "COMBAT" }); return; }
      if (p.kind === "APPROACH_GATE" && o.gates?.some(g => g.itemID === p.targetID && g.onEntryGrid && finite(g.distanceM) && g.distanceM <= 2200)) { await save({ pending: null }); return; }
      if (p.kind === "GATE" && arrival && id && o.entry!.instanceID === id.instanceID && o.entry!.roomID !== p.fromRoomID) { await save({ pending: null, identity: { ...id, roomID: o.entry!.roomID }, phase: "COMBAT" }); return; }
      if (p.kind === "COMPLETE" && p.status === "ACKNOWLEDGED" && p.completionConfirmed && !m && id && state.offer) {
        // A positively confirmed Complete and the absence of the exact accepted
        // journal row prove completion. Reward visibility is a separate read.
        const credits = o.credits, normal = credits?.filter(c => c.kind === 33) ?? [];
        const valid = !!state.before && finite(o.wallet) && finite(o.lp) && !!credits && credits.length <= 2 &&
          new Set(credits.map(c => c.kind)).size === credits.length && new Set(credits.map(c => c.transactionID)).size === credits.length &&
          credits.every(c => (c.kind === 33 || c.kind === 34) && positive(c.transactionID) && c.characterID === state!.characterID && c.agentID === state!.agentID && c.issuedAtOrAfter && finite(c.isk) && c.isk >= 0 && finite(c.taxISK) && c.taxISK >= 0) &&
          (state.offer.expectedISK === 0 || normal.length === 1 && Math.abs(normal[0]!.isk + normal[0]!.taxISK - state.offer.expectedISK) <= 0.005) && o.lp! >= state.before.lp;
        const completion: Completion = { identity: id, commandID: p.id, expectedISK: state.offer.expectedISK,
          isk: valid ? credits!.reduce((n,c)=>n+c.isk,0) : null, taxISK: valid ? credits!.reduce((n,c)=>n+c.taxISK,0) : null,
          lp: valid ? o.lp! - state.before!.lp : null, transactionIDs: valid ? credits!.map(c=>c.transactionID) : [], reward: p.reward ?? null };
        if (state.completed.some(c => c.identity.acceptedKey === id.acceptedKey || c.transactionIDs.some(tx => completion.transactionIDs.includes(tx)))) { await block("Completion identity or reward transaction was already counted."); return; }
        const completed = [...state.completed, completion];
        await save({ pending: null, completed, phase: state.missionLimit!==null && completed.length >= state.missionLimit ? "DONE" : "AGENT", offer: null, identity: null, before: null }); return;
      }
      // Do not infer failure or re-dispatch from absent proof, including successful RPC responses.
      return;
    }
    if (state.phase === "AGENT") {
      if (o.dockedStationID !== state.agentStationID) { await issue("ROUTE_AGENT", { targetID: state.agentStationID }); return; }
      if (o.mission !== null || o.unqualifiedOffer) { await block("An existing mission is not implicitly adopted."); return; }
      if (!positive(o.buttons.request)) { await block("A fresh Request action is unavailable."); return; }
      await issue("REQUEST", { actionID: o.buttons.request }); return;
    }
    if (state.phase === "OFFER") {
      if (!o.mission || !state.offer || !sameOffer(state.offer, o.mission) || !permitted(o.mission) || o.routeReachable !== true || !positive(o.buttons.accept)) { await block("The reviewed offer or route could not be verified."); return; }
      await issue("ACCEPT", { actionID: o.buttons.accept }); return;
    }
    const id = state.identity;
    if (!id) { await block("Accepted mission identity is missing."); return; }
    if (state.phase !== "COMPLETE" && (!o.mission || o.mission.status !== "accepted" || !missionMatches(o.mission, id))) { await block("Accepted mission identity changed."); return; }
    if (state.phase === "MISSION_SYSTEM") {
      if (o.systemID !== id.destinationSystemID || !o.inSpace || o.inWarp !== false) { await issue("ROUTE_SYSTEM", { destinationSystemID: id.destinationSystemID }); return; }
      await save({ phase: "ENTRY" }); return;
    }
    if (state.phase === "ENTRY") { await issue("MISSION_WARP", { destinationSystemID: id.destinationSystemID, locationNumber: id.locationNumber }); return; }
    const room = o.dungeon && o.entry && id.instanceID && o.dungeon.dungeonID === id.dungeonID && o.dungeon.instanceID === id.instanceID && o.dungeon.roomID === id.roomID && o.entry.characterID === state.characterID && o.entry.shipID === state.shipID && o.entry.dungeonID === id.dungeonID && o.entry.instanceID === id.instanceID && o.entry.roomID === id.roomID && o.entry.landed && o.entry.onEntryGrid && o.inSpace && o.inWarp === false;
    if (["COMBAT", "SETTLE", "PROGRESS"].includes(state.phase) && !room) { await block("Exact native dungeon room and landing proof are unavailable."); return; }
    if (state.phase === "COMBAT") {
      if (o.objectiveComplete === true && o.dungeonObjectiveComplete === true || o.eligibleNpcIDs !== null && o.eligibleNpcIDs.length === 0) { await save({ phase: "SETTLE" }); return; }
      if (o.eligibleNpcIDs === null) return;
      await hooks.combat(id, assertCurrent); return;
    }
    if (state.phase === "SETTLE") { if (o.combatSettled === true) { await save({ phase: o.objectiveComplete === true && o.dungeonObjectiveComplete === true ? "RETURN" : "PROGRESS" }); return; } await hooks.settle(assertCurrent); return; }
    if (state.phase === "PROGRESS") {
      if (o.eligibleNpcIDs === null || o.gates === null) return;
      if (o.eligibleNpcIDs.length) { await save({ phase: "COMBAT" }); return; }
      const gates = o.gates.filter(g => positive(g.itemID) && g.onEntryGrid && finite(g.distanceM) && g.distanceM >= 0);
      if (gates.length !== 1) { await block("A unique reachable gate is not proven; no gate is guessed."); return; }
      await issue(gates[0]!.distanceM > 2200 ? "APPROACH_GATE" : "GATE", { targetID: gates[0]!.itemID }); return;
    }
    if (state.phase === "RETURN") {
      if (o.dockedStationID !== state.agentStationID) { await issue("ROUTE_AGENT", { targetID: state.agentStationID }); return; }
      if (o.objectiveComplete !== true || o.dungeonObjectiveComplete !== true || !positive(o.buttons.complete)) { await block("Fresh objective or completion action is unavailable."); return; }
      await save({ before: finite(o.wallet) && finite(o.lp) ? { wallet: o.wallet, lp: o.lp } : null, phase: "COMPLETE" });
      await issue("COMPLETE", { actionID: o.buttons.complete }); return;
    }
  }
  return {
    tick(): Promise<void> { if (inflight) return inflight; inflight = tickOnce().finally(() => { inflight = null; }); return inflight; },
    async stop(): Promise<void> { retired = true; await inflight; },
  };
}
