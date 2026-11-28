import type { Manifest } from "./operation.ts";
export interface HaulDocument {
  read(): unknown | null;
  write(value: unknown): void;
}
type Event = Readonly<{
  kind: "pickup" | "delivery" | "relocation";
  before: unknown;
  acknowledged: boolean;
  refusalReason?: string;
  after?: unknown;
}>;
type Journal = Readonly<{
  version: 1;
  identity: string;
  events: readonly Event[];
  pending: Event | null;
}>;
/** Synchronous document writes fence each native inventory mutation and its evidence. */
export function createHaulJournal(
  document: HaulDocument,
  manifest: Manifest,
  shipID: number,
  generation: number,
) {
  const identity = JSON.stringify([
    manifest.operationID,
    manifest.runID,
    manifest.containerID,
    shipID,
    generation,
    manifest.items,
  ]);
  const raw = document.read();
  let state: Journal;
  if (raw === null) state = { version: 1, identity, events: [], pending: null };
  else {
    const x = raw as Journal;
    const event = (v: Event) =>
      !!v &&
      typeof v === "object" &&
      ["pickup", "delivery", "relocation"].includes(v.kind) &&
      typeof v.acknowledged === "boolean" &&
      Object.hasOwn(v, "before");
    if (
      !x ||
      x.version !== 1 ||
      x.identity !== identity ||
      !Array.isArray(x.events) ||
      x.events.some((v) => !event(v) || !Object.hasOwn(v, "after")) ||
      !(x.pending === null || (event(x.pending) && !Object.hasOwn(x.pending, "after")))
    )
      throw Error("Haul journal identity or state is invalid.");
    state = structuredClone(x);
  }
  const save = (next: Journal) => {
    document.write(next);
    state = next;
  };
  function reconcile(kind: "pickup" | "delivery", after: unknown) {
    if (state.pending?.kind !== kind) throw Error("No matching haul intent can be reconciled.");
    const finished = { ...state.pending, after: structuredClone(after) };
    save({ ...state, pending: null, events: [...state.events, finished] });
  }
  function refuse(kind: "pickup" | "delivery") {
    if (state.pending?.kind !== kind || state.pending.acknowledged)
      throw Error(`No refused ${kind} intent.`);
    save({ ...state, pending: null });
  }
  // Updates replace state. Internal readers can reuse a snapshot including its inventory evidence.
  return {
    snapshot: () => state,
    begin(kind: Event["kind"], before: unknown) {
      if (state.pending) throw Error("Unresolved haul mutation; no replay.");
      save({ ...state, pending: { kind, before: structuredClone(before), acknowledged: false } });
    },
    acknowledge() {
      if (!state.pending || state.pending.acknowledged)
        throw Error("Haul intent is not dispatchable.");
      save({ ...state, pending: { ...state.pending, acknowledged: true } });
    },
    recordDeliveryRefusal(refusalReason: string) {
      if (state.pending?.kind !== "delivery" || state.pending.acknowledged)
        throw Error("No matching unacknowledged unload.");
      save({ ...state, pending: { ...state.pending, refusalReason } });
    },
    refusePickup() {
      refuse("pickup");
    },
    refuseDelivery() {
      const saved = document.read() as Journal | null;
      if (
        saved?.identity !== identity || saved.events.length !== state.events.length ||
        JSON.stringify(saved.pending) !== JSON.stringify(state.pending)
      ) throw Error("The pending unload changed. Refresh the operation.");
      refuse("delivery");
    },
    settle(after: unknown) {
      if (!state.pending?.acknowledged)
        throw Error("Haul intent lacks acknowledged native receipt.");
      const finished = { ...state.pending, after: structuredClone(after) };
      save({ ...state, pending: null, events: [...state.events, finished] });
    },
    recordRelocation(proof: unknown) {
      if (state.pending) throw Error("Unresolved haul mutation; no replay.");
      const p = proof as { kind?: unknown; items?: unknown; observedAt?: unknown };
      if (
        !p ||
        p.kind !== "relocated-manifest-items" ||
        !Array.isArray(p.items) ||
        !Number.isFinite(p.observedAt)
      )
        throw Error("Relocation proof is invalid.");
      const old = state.events.find((e) => e.kind === "relocation");
      if (old) {
        const saved = old.after as typeof p;
        if (
          saved?.kind !== p.kind ||
          !Number.isFinite(saved.observedAt) ||
          JSON.stringify(saved.items) !== JSON.stringify(p.items)
        )
          throw Error("Prior relocation proof changed.");
        return structuredClone(saved);
      }
      save({
        ...state,
        events: [
          ...state.events,
          {
            kind: "relocation",
            before: structuredClone(proof),
            acknowledged: true,
            after: structuredClone(proof),
          },
        ],
      });
      return structuredClone(p);
    },
    reconcile,
    reconcilePickup: (after: unknown) => reconcile("pickup", after),
  };
}
