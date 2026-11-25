import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { claimedBeltRocks } from "./beltRocks.ts";
import { readMiningReadiness } from "./nativeBelt.ts";
import { targetKey, type createTargetBoard, type Target } from "./targetBoard.ts";

type Point = { x: number; y: number; z: number };
export type LocalityPeer = {
  run: PluginRunContext;
  session: PilotSession;
  shipID: number;
  role: string;
  current: () => void;
};
export type LocalityRead = {
  characterID: number;
  shipID: number;
  role: string;
  observedAt: number;
  systemID: number;
  position: Point | null;
  belts: { beltID: number; beltName: string; position: Point | null }[];
};
const point = (p: any): p is Point => !!p && [p.x, p.y, p.z].every(Number.isFinite);
/** Same held flight/scene authority as navigation. Simulation time is not wall time. */
export async function observeLocality(
  peer: LocalityPeer,
  systemID: number,
  board?: Pick<ReturnType<typeof createTargetBoard>, "read" | "observeRestoredBelt">,
): Promise<LocalityRead> {
  peer.current();
  let view: Awaited<ReturnType<typeof readMiningReadiness>> | null = null;
  const startedAt = Date.now();
  try {
    view = await readMiningReadiness(peer.run, peer.session, peer.shipID, systemID, peer.current);
  } catch {
    peer.current();
  }
  peer.current();
  const ready = view?.ready === true,
    space = view?.space;
  const belts = ready
    ? (space?.entities ?? [])
        .filter(
          (e) =>
            e.groupID === 9 &&
            Number.isSafeInteger(e.itemID) &&
            e.itemID > 0 &&
            typeof e.name === "string" &&
            !!e.name.trim(),
        )
        .map((e) => ({
          beltID: e.itemID,
          beltName: e.name!.trim(),
          position: e.geometryAvailable && point(e.position) ? { ...e.position } : null,
        }))
    : [];
  if (board && space && belts.length) {
    for (const belt of belts) {
      if (
        !belt.position ||
        belts.some((other) => other !== belt && other.beltName === belt.beltName)
      )
        continue;
      const target = { kind: "BELT" as const, systemID, name: belt.beltName };
      if (board.read(targetKey(target))?.state !== "DEPLETED") continue;
      let rocks: ReturnType<typeof claimedBeltRocks>;
      try {
        rocks = claimedBeltRocks(space, {
          shipID: peer.shipID,
          characterID: peer.run.characterID,
          systemID,
          beltID: belt.beltID,
        });
      } catch {
        continue;
      }
      if (rocks.some((rock) => rock.remainingQuantity !== 0))
        board.observeRestoredBelt(target, startedAt);
    }
  }
  return {
    characterID: peer.run.characterID,
    shipID: peer.shipID,
    role: peer.role,
    observedAt: Date.now(),
    systemID,
    position: ready && point(space?.ship?.position) ? { ...space!.ship!.position } : null,
    belts,
  };
}
/** WC74 src/miningLocality.js: MINER-only median, 15s freshness, all-candidate
 * geometry or deterministic name fallback. No ID-to-distance conversion. */
export function rankLocality<T extends { target: Target; position?: Point | null }>(
  candidates: readonly T[],
  reads: readonly LocalityRead[],
  now = Date.now(),
) {
  const anchors = reads.filter(
    (r) =>
      r.role === "MINER" && now >= r.observedAt && now - r.observedAt <= 15000 && point(r.position),
  );
  const usable =
    candidates.length > 0 &&
    candidates.every(
      (c) => point(c.position) && anchors.some((a) => a.systemID === c.target.systemID),
    );
  const ranked = candidates
    .map((candidate) => {
      const distances = usable
        ? anchors
            .filter((a) => a.systemID === candidate.target.systemID)
            .map((a) =>
              Math.hypot(
                a.position!.x - candidate.position!.x,
                a.position!.y - candidate.position!.y,
                a.position!.z - candidate.position!.z,
              ),
            )
            .sort((a, b) => a - b)
        : [];
      const n = distances.length,
        medianDistanceM = n
          ? n % 2
            ? distances[Math.floor(n / 2)]!
            : (distances[n / 2 - 1]! + distances[n / 2]!) / 2
          : null;
      return {
        candidate,
        key: targetKey(candidate.target),
        medianDistanceM,
        anchorCount: n,
        reason:
          medianDistanceM === null
            ? "DETERMINISTIC_NO_FRESH_LOCALITY"
            : medianDistanceM < 150000
              ? "MAIN_BODY_AT_TARGET"
              : "MEDIAN_MAIN_BODY_DISTANCE",
      };
    })
    .sort(
      (a, b) =>
        (usable
          ? a.medianDistanceM! - b.medianDistanceM!
          : a.candidate.target.name.localeCompare(b.candidate.target.name)) ||
        a.key.localeCompare(b.key),
    );
  return {
    ranked,
    evidence: {
      policy: "PREFER_FLEET_LOCALITY",
      observedAt: now,
      selected: ranked[0]?.key ?? null,
      anchors: anchors.map(({ belts, ...r }) => r),
      candidates: ranked
        .slice(0, 20)
        .map(({ candidate, ...score }) => ({ ...score, position: candidate.position ?? null })),
    },
  };
}
