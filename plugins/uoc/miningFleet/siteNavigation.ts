import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { readMiningReadiness } from "./nativeBelt.ts";
import { targetKey, type Claim, type SynchronousStore } from "./targetBoard.ts";
import { selectNativeSite, type NativeSite, type SiteTarget } from "./siteDiscovery.ts";
import { sameSiteClassification, validSavedSiteClassification } from "./siteSelection.ts";
type Scope = Pick<PluginRunContext, "characterID" | "baseUrl" | "fetch">;
type Authority = { state: string; target: SiteTarget; claim: Claim | null };
type Position = { x: number; y: number; z: number };
type SceneEvidence = { sampledAtMs: number; position: Position };
type Pending = { issuedAt: number; acknowledged: boolean; before: SceneEvidence };
type RecordState = {
  version: 1;
  identity: string;
  pending: Pending | null;
  arrivedAt: number | null;
  history: {
    issuedAt: number;
    acknowledged: boolean;
    arrivedAt: number;
    before: SceneEvidence;
    after: SceneEvidence;
  }[];
};
const validScene = (v: SceneEvidence) =>
  !!v &&
  Number.isFinite(v.sampledAtMs) &&
  v.sampledAtMs > 0 &&
  !!v.position &&
  [v.position.x, v.position.y, v.position.z].every(Number.isFinite);
const equalSite = (a: NativeSite, b: NativeSite) =>
  a.scannerKey === b.scannerKey &&
  a.instanceID === b.instanceID &&
  a.label === b.label &&
  a.archetypeID === b.archetypeID &&
  JSON.stringify(a.target) === JSON.stringify(b.target) &&
  sameSiteClassification(b, a);
const equalClaim = (a: Claim, b: Claim) =>
  a.key === b.key &&
  a.operationID === b.operationID &&
  a.runID === b.runID &&
  a.generation === b.generation;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** One exact target, claim generation and held ship own a durable warp intent. */
export function createSiteNavigation(
  run: Scope,
  session: PilotSession,
  config: {
    shipID: number;
    site: NativeSite;
    claim: Claim;
    allowDraining?: boolean;
    authority: () => Authority | null;
    readSites: () => Promise<NativeSite[]>;
    current: () => void;
    movementAdmission?: () => Promise<void>;
    document: SynchronousStore;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    pollMs?: number;
  },
) {
  const { site, claim, current, document } = config,
    now = config.now ?? Date.now,
    wait = config.wait ?? delay;
  const guard = () => {
    current();
    if (session.store.station.get().online?.characterID !== run.characterID)
      throw Error("Site navigation pilot changed.");
  };
  if (!validSavedSiteClassification(site))
    throw Error("Selected mining site classification is not verified.");
  if (
    !Number.isSafeInteger(config.shipID) ||
    config.shipID <= 0 ||
    !Number.isSafeInteger(site.scannerKey) ||
    site.scannerKey <= 0 ||
    !Number.isSafeInteger(site.instanceID) ||
    site.instanceID <= 0 ||
    typeof site.label !== "string" ||
    !site.label.trim() ||
    site.target.name !== site.label ||
    (site.target.kind === "ICE"
      ? site.archetypeID !== 28
      : site.target.kind !== "ORE_ANOMALY" || site.archetypeID !== 27) ||
    site.target.instanceID !== site.instanceID ||
    site.scannerKey !== site.target.siteID ||
    claim.key !== targetKey(site.target) ||
    !Number.isSafeInteger(claim.generation) ||
    claim.generation <= 0 ||
    !claim.operationID ||
    !claim.runID
  )
    throw Error("Site navigation scope is invalid.");
  const identity = JSON.stringify([
    run.characterID,
    config.shipID,
    site.target,
    site.label,
    claim.key,
    claim.operationID,
    claim.runID,
    claim.generation,
  ]);
  const raw = document.read();
  let state: RecordState;
  if (raw === null) state = { version: 1, identity, pending: null, arrivedAt: null, history: [] };
  else {
    const x = raw as RecordState;
    if (
      !x ||
      x.version !== 1 ||
      x.identity !== identity ||
      !Array.isArray(x.history) ||
      x.history.some(
        (h) =>
          !h ||
          !Number.isSafeInteger(h.issuedAt) ||
          h.issuedAt <= 0 ||
          typeof h.acknowledged !== "boolean" ||
          !validScene(h.before) ||
          !validScene(h.after) ||
          h.after.sampledAtMs <= h.before.sampledAtMs ||
          !Number.isSafeInteger(h.arrivedAt) ||
          h.arrivedAt < h.issuedAt ||
          h.arrivedAt > now(),
      ) ||
      !(x.arrivedAt === null || Number.isFinite(x.arrivedAt)) ||
      !(
        x.pending === null ||
        (x.pending &&
          Number.isSafeInteger(x.pending.issuedAt) &&
          x.pending.issuedAt > 0 &&
          x.pending.issuedAt <= now() &&
          typeof x.pending.acknowledged === "boolean" &&
          validScene(x.pending.before))
      ) ||
      (x.arrivedAt !== null && x.pending !== null)
    )
      throw Error("Site navigation journal needs reconciliation.");
    state = structuredClone(x);
  }
  const save = (next: RecordState) => {
    guard();
    document.write(structuredClone(next));
    state = next;
  };
  const verifyAuthority = () => {
    guard();
    const a = config.authority();
    if (
      !a ||
      (a.state !== "ACTIVE" && !(config.allowDraining && a.state === "DRAINING")) ||
      !a.claim ||
      !equalClaim(a.claim, claim) ||
      a.claim.expiresAt <= now() ||
      JSON.stringify(a.target) !== JSON.stringify(site.target)
    )
      throw Error("Exact site claim is stale or lost.");
  };
  const verifySite = async () => {
    verifyAuthority();
    const sites = await config.readSites();
    verifyAuthority();
    const fresh = selectNativeSite(sites, site.target.kind, site.scannerKey);
    if (!equalSite(fresh, site)) throw Error("Selected site was replaced or changed.");
    if (
      !Number.isFinite(fresh.observedAt) ||
      fresh.observedAt > now() ||
      now() - fresh.observedAt > 15000
    )
      throw Error("Scanner observation is stale.");
    return fresh;
  };
  const physical = async () => {
    verifyAuthority();
    const x = await readMiningReadiness(run, session, config.shipID, site.target.systemID, guard);
    verifyAuthority();
    const ship = x.space.ship!;
    const p = site.target.position;
    const metres = Math.hypot(ship.position.x - p.x, ship.position.y - p.y, ship.position.z - p.z);
    return {
      ready: x.ready,
      arrived: x.ready && metres < 150000,
      metres,
      evidence: { sampledAtMs: x.space.sampledAtMs!, position: structuredClone(ship.position) },
    };
  };
  async function observeArrival() {
    await verifySite();
    const position = await physical();
    await verifySite();
    if (!position.arrived) return false;
    if (state.pending) {
      if (position.evidence.sampledAtMs <= state.pending.before.sampledAtMs) return false;
      const arrivedAt = now();
      if (!Number.isSafeInteger(arrivedAt) || arrivedAt < state.pending.issuedAt)
        throw Error("Arrival observation time is invalid.");
      save({
        ...state,
        pending: null,
        arrivedAt,
        history: [
          ...state.history,
          {
            issuedAt: state.pending.issuedAt,
            acknowledged: state.pending.acknowledged,
            before: state.pending.before,
            after: position.evidence,
            arrivedAt,
          },
        ],
      });
    }
    return true;
  }
  async function performNavigation() {
    if (await observeArrival()) return;
    if (state.pending) {
      if (!state.pending.acknowledged) throw Error("Warp outcome is unknown; no replay.");
    } else {
      const before = await physical();
      if (before.arrived) {
        await verifySite();
        return;
      }
      if (!before.ready) throw Error("Ship warp or session transition is unresolved.");
      await verifySite();
      verifyAuthority();
      await config.movementAdmission?.();
      verifyAuthority();
      const admitted = await physical();
      await verifySite();
      verifyAuthority();
      if (admitted.arrived) return;
      if (!admitted.ready) throw Error("Ship movement changed during admission.");
      const issuedAt = now();
      if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0)
        throw Error("Warp intent time is invalid.");
      save({
        ...state,
        pending: { issuedAt, acknowledged: false, before: admitted.evidence },
        arrivedAt: null,
      });
      guard();
      await session.flow.warpToProbeResult(site.label, 0);
      guard();
      const pending = state.pending as RecordState["pending"];
      if (!pending) throw Error("Warp intent disappeared.");
      save({ ...state, pending: { ...pending, acknowledged: true } });
    }
    const end = now() + (config.timeoutMs ?? 180000),
      poll = config.pollMs ?? 1000;
    while (now() < end) {
      if (await observeArrival()) return;
      await wait(poll);
    }
    throw Error("Site arrival is unconfirmed; warp will not be replayed.");
  }
  let inFlight: Promise<void> | null = null;
  function navigate() {
    if (inFlight) return inFlight;
    const task = performNavigation();
    inFlight = task;
    void task
      .finally(() => {
        if (inFlight === task) inFlight = null;
      })
      .catch(() => {});
    return task;
  }
  return { navigate, observeArrival, snapshot: () => structuredClone(state) };
}
