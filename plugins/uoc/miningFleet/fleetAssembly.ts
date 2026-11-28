import { isSessionChangeSettling } from "../compat/flying.ts";
import type { SynchronousStore } from "./targetBoard.ts";
export type FleetAssemblyObservation =
  | { readonly state: "not-in-fleet" }
  | {
      readonly state: "ready";
      readonly fleetID: number;
      readonly memberIDs: readonly number[];
      readonly bossID?: number | null;
    };
export class SharedFleetConflict extends Error {}
export interface FleetAssemblyPeer {
  readonly characterID: number;
  readonly botID: string;
  readonly shipID: number;
  current(): void;
  read(): Promise<FleetAssemblyObservation>;
  invitation(): {
    readonly fleetID: number;
    readonly inviterID: number | null;
    readonly receivedAtMs: number;
  } | null;
  create(): Promise<void>;
  invite(characterID: number, fleetID: number): Promise<void>;
  accept(fleetID: number): Promise<void>;
  leave?(): Promise<void>;
}
export interface FleetMoveAuthorization {
  readonly characterID: number;
  readonly shipID: number;
  readonly fromFleetID: number;
}
type FleetAdmission = {
  kind: "invite" | "accept";
  characterID: number;
  issuedAt: number;
  fleetID?: number;
  inviterID?: number;
  reinvited?: true;
  refusal?: string;
};
interface RecordState {
  version: 1;
  identity: string;
  leaderID: number;
  fleetID: number | null;
  pending:
    | FleetAdmission
    | {
        kind: "create" | "leave";
        characterID: number;
        issuedAt: number;
        fleetID?: number;
        inviterID?: number;
      }
    | null;
  joined: readonly number[];
  deferred?: readonly FleetAdmission[];
  origin?: {
    readonly kind: "existing-exact" | "existing-partial";
    readonly fleetID: number;
    readonly memberIDs: readonly number[];
    readonly observedAt: number;
  };
}
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
export const FLEET_ACCEPT_OBSERVATION_MS = 5000;
/** Serialized native fleet formation. A fresh invite can replace an unconfirmed MCC acceptance after native readback. */
export function createFleetAssembly(
  store: SynchronousStore,
  operationID: string,
  operationRunID: string,
  peers: readonly FleetAssemblyPeer[],
  now: () => number = Date.now,
  moves: readonly FleetMoveAuthorization[] = [],
  recovering: () => boolean = () => false,
  partial?: {
    existingOnly: boolean;
    read(peer: FleetAssemblyPeer): FleetAssemblyObservation | null;
    preferred?(peer: FleetAssemblyPeer): boolean;
    canCreate?(peer: FleetAssemblyPeer): boolean;
  },
) {
  if (
    !operationID ||
    !operationRunID ||
    peers.length < 2 ||
    peers.some((p) => !positive(p.characterID) || !positive(p.shipID) || (!partial && !p.botID)) ||
    new Set(peers.map((p) => p.characterID)).size !== peers.length ||
    new Set(peers.map((p) => p.shipID)).size !== peers.length ||
    (!partial && new Set(peers.map((p) => p.botID)).size !== peers.length)
  )
    throw Error("Fleet assembly roster is invalid.");
  if (
    !Array.isArray(moves) ||
    moves.some(
      (m) =>
        !m ||
        ![m.characterID, m.shipID, m.fromFleetID].every(positive) ||
        !peers.some((p) => p.characterID === m.characterID && p.shipID === m.shipID),
    ) ||
    new Set(moves.map((m) => m.characterID)).size !== moves.length
  )
    throw Error("Fleet move authorization is invalid.");
  const identity = JSON.stringify([
      operationID,
      operationRunID,
      peers.map((p) => (partial ? [p.characterID, p.shipID] : [p.characterID, p.shipID, p.botID])),
      ...(moves.length ? [moves.map((m) => [m.characterID, m.shipID, m.fromFleetID])] : []),
    ]),
    leader = peers[0]!,
    wanted = new Set(peers.map((p) => p.characterID));
  const authorizeLeave = (peer: FleetAssemblyPeer, fleetID: number) => {
    if (
      !moves.some(
        (m) =>
          m.characterID === peer.characterID &&
          m.shipID === peer.shipID &&
          m.fromFleetID === fleetID,
      )
    )
      throw Error(
        "Explicit approval is required for this pilot to leave the currently observed fleet.",
      );
  };
  const saved = store.read() as RecordState | null;
  let state: RecordState;
  function matchesIdentity(value: string) {
    if (value === identity) return true;
    if (!partial) return false;
    try {
      const old = JSON.parse(value),
        expected = JSON.parse(identity);
      return (
        Array.isArray(old[2]) &&
        old[2].every(
          (p: unknown) => Array.isArray(p) && p.length === 3 && typeof p[2] === "string" && p[2],
        ) &&
        JSON.stringify([
          old[0],
          old[1],
          old[2].map((p: unknown[]) => p.slice(0, 2)),
          ...old.slice(3),
        ]) === JSON.stringify(expected)
      );
    } catch {
      return false;
    }
  }
  if (saved === null) {
    state = {
      version: 1,
      identity,
      leaderID: leader.characterID,
      fleetID: null,
      pending: null,
      joined: [],
    };
    store.write(structuredClone(state));
  } else {
    if (
      !saved ||
      saved.version !== 1 ||
      !matchesIdentity(saved.identity) ||
      (partial ? !wanted.has(saved.leaderID) : saved.leaderID !== leader.characterID) ||
      !(saved.fleetID === null || positive(saved.fleetID)) ||
      !Array.isArray(saved.joined) ||
      new Set(saved.joined).size !== saved.joined.length ||
      saved.joined.some((id) => !wanted.has(id)) ||
      (saved.origin !== undefined &&
        (!saved.origin ||
          !["existing-exact", "existing-partial"].includes(saved.origin.kind) ||
          saved.origin.fleetID !== saved.fleetID ||
          !Array.isArray(saved.origin.memberIDs) ||
          !saved.origin.memberIDs.includes(saved.leaderID) ||
          saved.origin.memberIDs.length < 1 ||
          (saved.origin.kind === "existing-exact" &&
            saved.origin.memberIDs.length !== wanted.size) ||
          new Set(saved.origin.memberIDs).size !== saved.origin.memberIDs.length ||
          saved.origin.memberIDs.some((id) => !wanted.has(id)) ||
          !Number.isFinite(saved.origin.observedAt))) ||
      !(
        saved.pending === null ||
        (saved.pending &&
          ["create", "invite", "accept", "leave"].includes(saved.pending.kind) &&
          wanted.has(saved.pending.characterID) &&
          Number.isFinite(saved.pending.issuedAt) &&
          (saved.pending.inviterID === undefined || wanted.has(saved.pending.inviterID)) &&
          (saved.pending.kind !== "leave" || positive(saved.pending.fleetID)))
      )
    )
      throw Error("Fleet assembly custody needs reconciliation.");
    state = { ...structuredClone(saved), identity };
  }
  if (
    state.deferred &&
    (!partial ||
      !Array.isArray(state.deferred) ||
      new Set(state.deferred.map((p) => p.characterID)).size !== state.deferred.length ||
      state.deferred.some(
        (p) =>
          !p ||
          !["invite", "accept"].includes(p.kind) ||
          !wanted.has(p.characterID) ||
          !Number.isFinite(p.issuedAt) ||
          (p.inviterID !== undefined && !wanted.has(p.inviterID)) ||
          (p.reinvited !== undefined && p.reinvited !== true),
      ) ||
      state.deferred.some((p) => p.characterID === state.pending?.characterID))
  )
    throw Error("Fleet admission records require reconciliation.");
  const write = (next: RecordState) => {
    store.write(structuredClone(next));
    state = structuredClone(next);
  };
  async function dispatchAdmission(
    admission: FleetAdmission,
    remember: (attempt: FleetAdmission) => void,
    send: () => Promise<void>,
  ) {
    const before = state;
    remember(admission);
    try {
      await send();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (partial && isSessionChangeSettling(error)) {
        // WC refused the write before contacting EveJS. Keep the original invite and retry allowance.
        write(before);
      } else if (
        partial &&
        (code === "CALL_REFUSED" || code === "CALL_NOT_ALLOWED" || code === "BRIDGE_WRITE_REFUSED")
      ) {
        const reason = error instanceof Error ? error.message : String(error);
        remember({
          ...admission,
          refusal:
            (admission.kind === "invite" ? "Fleet invitation" : "Fleet acceptance") +
            " refused: " +
            reason,
        });
      }
      throw error;
    }
  }
  let busy = false;
  async function step(): Promise<"ready" | "waiting"> {
    if (busy) return "waiting";
    busy = true;
    try {
      const confirmPeers = () => {
        if (!partial) for (const peer of peers) peer.current();
      };
      confirmPeers();
      const reads = partial
        ? peers.map((p) => partial.read(p))
        : await Promise.all(
            peers.map(async (p) => {
              const v = await p.read();
              p.current();
              return v;
            }),
          );
      confirmPeers();
      for (let i = 0; i < reads.length; i++) {
        const r = reads[i]!;
        if (
          r?.state === "ready" &&
          (!positive(r.fleetID) ||
            !Array.isArray(r.memberIDs) ||
            !r.memberIDs.length ||
            !r.memberIDs.includes(peers[i]!.characterID) ||
            r.memberIDs.some((id) => !positive(id)) ||
            new Set(r.memberIDs).size !== r.memberIDs.length)
        )
          throw Error("A selected pilot belongs to an unrelated or unreadable fleet.");
      }
      if (!partial)
        for (const r of reads)
          if (r?.state === "ready")
            for (const id of r.memberIDs) {
              if (!wanted.has(id)) continue;
              const other = reads[peers.findIndex((p) => p.characterID === id)]!;
              if (!other && partial) continue;
              if (
                other?.state !== "ready" ||
                other.fleetID !== r.fleetID ||
                JSON.stringify([...other.memberIDs].sort((a, b) => a - b)) !==
                  JSON.stringify([...r.memberIDs].sort((a, b) => a - b))
              )
                return "waiting";
            }
      const recoveringRoster = recovering();
      if (
        !state.pending &&
        state.fleetID !== null &&
        reads.every((r) => r?.state === "not-in-fleet")
      ) {
        if (partial && !recoveringRoster)
          throw new SharedFleetConflict(
            "Every selected pilot confirms that the operation fleet has ended.",
          );
        if (!recoveringRoster) return "waiting";
        // EveJS destroys its last member's fleet on disconnect. All selected pilots
        // now independently confirm absence, so existing CreateFleet may run once.
        write({ ...state, fleetID: null, joined: [], origin: undefined, deferred: undefined });
        return "waiting";
      }
      const surviving =
        state.fleetID === null
          ? []
          : reads.filter(
              (r): r is Extract<FleetAssemblyObservation, { state: "ready" }> =>
                r?.state === "ready" && r.fleetID === state.fleetID,
            );
      if (surviving.some((r) => r.memberIDs.some((id) => !wanted.has(id))))
        throw new SharedFleetConflict("The operation fleet contains an unselected member.");
      if (partial?.existingOnly) {
        if (state.fleetID !== null) return surviving.length ? "ready" : "waiting";
        const i = reads.findIndex(
          (r) => r?.state === "ready" && r.memberIDs.every((id) => wanted.has(id)),
        );
        const row = reads[i];
        if (row?.state !== "ready") return "waiting";
        write({
          ...state,
          leaderID: peers[i]!.characterID,
          fleetID: row.fleetID,
          joined: row.memberIDs,
        });
        return "ready";
      }
      const boss = surviving[0]?.bossID;
      const bossIndex =
        (recoveringRoster || partial) &&
        positive(boss) &&
        surviving.every((r) => !r.bossID || r.bossID === boss)
          ? peers.findIndex(
              (peer, i) =>
                peer.characterID === boss &&
                surviving.includes(reads[i] as (typeof surviving)[number]),
            )
          : -1;
      const recordedIndex = peers.findIndex((p) => p.characterID === state.leaderID);
      const readyIndex =
        partial && !state.pending && state.fleetID === null && !reads[recordedIndex]
          ? reads.findIndex((r) => r !== null)
          : recordedIndex;
      const index = bossIndex >= 0 ? bossIndex : readyIndex;
      const actingLeader = peers[index],
        lead = reads[index];
      if (!actingLeader || !lead) return "waiting";
      if (
        recoveringRoster &&
        surviving.length &&
        reads.some((r) => r?.state === "not-in-fleet") &&
        bossIndex < 0
      )
        throw Error("The native boss of the surviving operation fleet could not be verified.");

      if (state.pending?.kind === "leave") {
        const pending = state.pending,
          index = peers.findIndex((p) => p.characterID === pending.characterID),
          read = reads[index];
        if (!read) return "waiting";
        if (read?.state === "not-in-fleet") {
          write({ ...state, pending: null });
          return "waiting";
        }
        throw Error("Fleet leave is unresolved; it will not be sent again.");
      }
      if (state.pending?.kind === "create") {
        if (
          lead.state === "ready" &&
          lead.memberIDs.length === 1 &&
          lead.memberIDs[0] === state.pending.characterID &&
          (partial || reads.slice(1).every((r) => r?.state === "not-in-fleet"))
        ) {
          write({
            ...state,
            fleetID: lead.fleetID,
            pending: null,
            joined: [state.pending.characterID],
          });
          return "waiting";
        }
        throw Error("Fleet creation is unresolved; no second CreateFleet will be sent.");
      }
      // Approve the whole currently observed consolidation before adopting or moving anyone.
      // This prevents a partially approved setup from changing one pilot's fleet and
      // only then discovering that another selected move lacks approval.
      const retained =
        state.fleetID ??
        (lead.state === "ready" && !lead.memberIDs.some((id) => !wanted.has(id))
          ? lead.fleetID
          : null);
      if (!state.pending && !partial)
        for (let i = 0; i < reads.length; i++) {
          const r = reads[i]!;
          if (r?.state === "ready" && r.fleetID !== retained) authorizeLeave(peers[i]!, r.fleetID);
        }
      if (state.fleetID === null) {
        if (
          !state.pending &&
          lead.state === "ready" &&
          lead.memberIDs.length === wanted.size &&
          reads.every(
            (r) =>
              r?.state === "ready" &&
              r.fleetID === lead.fleetID &&
              r.memberIDs.length === wanted.size &&
              r.memberIDs.every((id) => wanted.has(id)),
          )
        ) {
          confirmPeers();
          const observedAt = now();
          if (!Number.isFinite(observedAt)) throw Error("Fleet observation time is invalid.");
          const memberIDs = [...wanted].sort((a, b) => a - b);
          write({
            ...state,
            leaderID: actingLeader.characterID,
            fleetID: lead.fleetID,
            joined: memberIDs,
            origin: { kind: "existing-exact", fleetID: lead.fleetID, memberIDs, observedAt },
          });
          return "ready";
        }
        if (!state.pending && lead.state === "ready" && lead.fleetID === retained) {
          const memberIDs = [...lead.memberIDs].sort((a, b) => a - b),
            observedAt = now();
          if (!Number.isFinite(observedAt)) throw Error("Fleet observation time is invalid.");
          write({
            ...state,
            leaderID: actingLeader.characterID,
            fleetID: lead.fleetID,
            joined: memberIDs,
            origin: { kind: "existing-partial", fleetID: lead.fleetID, memberIDs, observedAt },
          });
          return "waiting";
        }
        if (state.pending) throw Error("Fleet formation remains unresolved.");
        const other = reads.findIndex((r) => r?.state === "ready");
        if (other >= 0) {
          const peer = peers[other]!,
            read = reads[other]!;
          if (read?.state !== "ready" || !peer.leave)
            throw Error("Selected pilot cannot leave the prior fleet.");
          authorizeLeave(peer, read.fleetID);
          confirmPeers();
          peer.current();
          write({
            ...state,
            pending: {
              kind: "leave",
              characterID: peer.characterID,
              fleetID: read.fleetID,
              issuedAt: now(),
            },
          });
          confirmPeers();
          await peer.leave();
          peer.current();
          return "waiting";
        }
        if (partial?.canCreate && !partial.canCreate(actingLeader)) return "waiting";
        if ((partial ? [actingLeader] : peers).some((peer) => peer.invitation() !== null))
          throw Error("A selected pilot has an earlier invitation requiring review.");
        const pending = {
          kind: "create" as const,
          characterID: actingLeader.characterID,
          issuedAt: now(),
        };
        actingLeader.current();
        write({ ...state, leaderID: actingLeader.characterID, pending });
        await actingLeader.create();
        actingLeader.current();
        return "waiting";
      }
      if (
        lead.state !== "ready" ||
        lead.fleetID !== state.fleetID ||
        !lead.memberIDs.includes(actingLeader.characterID)
      )
        throw Error("The operation's created fleet could not be verified.");
      if ((partial || state.origin?.kind !== "existing-exact") && !state.pending) {
        const other = reads.findIndex((r) => r?.state === "ready" && r.fleetID !== state.fleetID);
        if (other >= 0) {
          const peer = peers[other]!,
            read = reads[other]!;
          if (read?.state !== "ready" || !peer.leave)
            throw Error("Selected pilot cannot leave the prior fleet.");
          authorizeLeave(peer, read.fleetID);
          confirmPeers();
          peer.current();
          write({
            ...state,
            pending: {
              kind: "leave",
              characterID: peer.characterID,
              fleetID: read.fleetID,
              issuedAt: now(),
            },
          });
          confirmPeers();
          await peer.leave();
          peer.current();
          return "waiting";
        }
      }
      const leadIDs = [...lead.memberIDs].sort((a, b) => a - b);
      if (!partial)
        for (const r of reads)
          if (
            r?.state === "ready" &&
            (r.fleetID !== state.fleetID ||
              JSON.stringify([...r.memberIDs].sort((a, b) => a - b)) !== JSON.stringify(leadIDs))
          )
            throw Error("Fleet membership has not converged on the operation's exact roster.");
      if (!partial && state.origin?.kind === "existing-exact" && !recoveringRoster) {
        if (
          reads.some((r) => r?.state !== "ready") ||
          leadIDs.length !== wanted.size ||
          leadIDs.some((id) => !wanted.has(id))
        )
          throw Error("The reused fleet no longer has the exact selected roster.");
        return "ready";
      }
      const pending = state.pending;
      const admissions = partial
        ? [
            ...(state.deferred ?? []),
            ...(pending?.kind === "invite" || pending?.kind === "accept" ? [pending] : []),
          ]
        : pending
          ? [pending]
          : [];
      const keep = (
        p: (typeof admissions)[number],
        replacement?: FleetAdmission,
        joined = false,
      ) => {
        write({
          ...state,
          pending: p === pending ? null : state.pending,
          ...(partial
            ? {
                deferred: [
                  ...(state.deferred ?? []).filter((x) => x.characterID !== p.characterID),
                  ...(replacement ? [replacement] : []),
                ],
              }
            : replacement
              ? { pending: replacement }
              : {}),
          joined: joined ? [...new Set([...state.joined, p.characterID])] : state.joined,
        });
      };
      for (const p of admissions) {
        if (p.kind !== "invite" && p.kind !== "accept")
          throw Error("Fleet admission custody is inconsistent.");
        const i = peers.findIndex((member) => member.characterID === p.characterID),
          peer = peers[i]!,
          read = reads[i];
        if (
          read?.state === "ready" &&
          (partial ? read.fleetID === state.fleetID : lead.memberIDs.includes(p.characterID))
        ) {
          keep(p, undefined, true);
          return "waiting";
        }
        if (!read || read.state !== "not-in-fleet") {
          if (!partial) throw Error("Fleet invitation belongs to another session.");
        } else {
          const invitation = peer.invitation();
          const fleetID = lead.fleetID,
            inviterID = p.inviterID ?? state.leaderID;
          const matching = invitation?.fleetID === fleetID && invitation.inviterID === inviterID;
          if (p.kind === "invite" && matching && invitation.receivedAtMs >= p.issuedAt) {
            const acceptance: FleetAdmission = {
              kind: "accept",
              characterID: peer.characterID,
              issuedAt: now(),
              ...(partial
                ? {
                    inviterID: invitation.inviterID,
                    ...(p.reinvited ? { reinvited: true as const } : {}),
                  }
                : {}),
            };
            peer.current();
            await dispatchAdmission(
              acceptance,
              (attempt) => keep(p, attempt),
              () => peer.accept(fleetID),
            );
            peer.current();
            return "waiting";
          }
          if (!partial) {
            if (p.kind === "accept")
              throw Error("Fleet acceptance remains unresolved; it will not be sent again.");
            if (invitation) throw Error("The received invitation does not match this operation.");
            return "waiting";
          }
          if (
            !p.reinvited &&
            now() - p.issuedAt >= FLEET_ACCEPT_OBSERVATION_MS &&
            (!invitation || matching) &&
            !surviving.some((view) => view.memberIDs.includes(p.characterID))
          ) {
            // The invite event can be lost during a session transition. Use the same
            // one fresh invitation as after an unconfirmed acceptance, only if absent.
            const [invitee, inviter] = await Promise.all([peer.read(), actingLeader.read()]);
            if (
              invitee.state !== "not-in-fleet" ||
              inviter.state !== "ready" ||
              inviter.fleetID !== fleetID ||
              !inviter.memberIDs.includes(actingLeader.characterID) ||
              inviter.memberIDs.includes(p.characterID) ||
              inviter.memberIDs.some((id) => !wanted.has(id))
            )
              continue;
            const existing = peer.invitation();
            if (
              existing &&
              (existing.fleetID !== fleetID ||
                existing.inviterID !== inviterID ||
                (p.kind === "invite" && existing.receivedAtMs >= p.issuedAt))
            )
              continue;
            actingLeader.current();
            peer.current();
            const retry: FleetAdmission = {
              kind: "invite",
              characterID: p.characterID,
              issuedAt: now(),
              inviterID: actingLeader.characterID,
              reinvited: true,
            };
            await dispatchAdmission(
              retry,
              (attempt) => keep(p, attempt),
              () => actingLeader.invite(p.characterID, fleetID),
            );
            actingLeader.current();
            return "waiting";
          }
        }
        if (partial && p === pending) {
          keep(p, { ...p, kind: p.kind });
          return "waiting";
        }
      }
      const candidates = peers.filter(
        (peer, i) =>
          reads[i]?.state === "not-in-fleet" &&
          !admissions.some((p) => p.characterID === peer.characterID),
      );
      const next =
        candidates.find((peer) => partial?.preferred?.(peer) && !peer.invitation()) ??
        candidates.find((peer) => !partial || !peer.invitation());
      if (!next) {
        if (partial) return "ready";
        if (
          leadIDs.length !== peers.length ||
          peers.some((peer) => !leadIDs.includes(peer.characterID))
        )
          throw Error("The native fleet roster is incomplete.");
        return "ready";
      }
      if (next.invitation()) throw Error("A prior fleet invitation requires review.");
      if (partial && bossIndex < 0 && boss && boss !== actingLeader.characterID) return "waiting";
      actingLeader.current();
      next.current();
      const invitation: FleetAdmission = {
        kind: "invite",
        characterID: next.characterID,
        issuedAt: now(),
        ...(actingLeader.characterID !== state.leaderID
          ? { inviterID: actingLeader.characterID }
          : {}),
      };
      await dispatchAdmission(
        invitation,
        (attempt) => write({ ...state, pending: attempt }),
        () => actingLeader.invite(next.characterID, lead.fleetID),
      );
      actingLeader.current();
      return "waiting";
    } finally {
      busy = false;
    }
  }
  function admissionIssue(characterID: number) {
    const pending = state.pending;
    const admission =
      state.deferred?.find((row) => row.characterID === characterID) ??
      (pending?.characterID === characterID &&
      (pending.kind === "invite" || pending.kind === "accept")
        ? pending
        : undefined);
    if (typeof admission?.refusal === "string" && admission.refusal) return admission.refusal;
    if (busy || !admission?.reinvited || now() - admission.issuedAt < FLEET_ACCEPT_OBSERVATION_MS)
      return null;
    return admission.kind === "invite"
      ? "The fresh native fleet invitation has not been confirmed."
      : "Native fleet membership has not been confirmed after attempting to accept the fresh invitation.";
  }
  return { step, admissionIssue, snapshot: () => structuredClone(state) };
}
