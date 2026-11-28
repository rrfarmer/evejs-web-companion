import { decodeSpaceSnapshot, getTargets, lockTarget } from "../../../web/src/plugin-api/flying.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { fleetRepairFitModules, type RemoteRepairModule } from "../combat/moduleFit.ts";
import { alreadyActiveRefusal } from "../combat/moduleAction.ts";
import { decodeModuleObservation } from "../shared/moduleObservation.ts";
import { readKeyVal, readRowField, unwrapReal } from "../shared/wire.ts";
import { targetNotLockedRefusal } from "../mining/activation.ts";

type Scene = ReturnType<typeof decodeSpaceSnapshot>;
type Entity = Scene["entities"][number];
export type RepairMember = { characterID: number; shipID: number; role: string };
const layers = {
  "remote-shield": "shieldRatio",
  "remote-armor": "armorRatio",
  "remote-hull": "hullRatio",
} as const;
const labels = {
  "remote-shield": "remote shield repair",
  "remote-armor": "remote armor repair",
  "remote-hull": "remote hull repair",
} as const;
const repairAt = 0.9;
const clearAt = 0.98;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const id = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const surfaceDistance = (a: { position: Entity["position"]; radius: number }, b: Entity) =>
  Math.max(
    0,
    Math.hypot(
      a.position.x - b.position.x,
      a.position.y - b.position.y,
      a.position.z - b.position.z,
    ) -
      a.radius -
      b.radius,
  );

function candidates(
  view: Scene,
  members: readonly RepairMember[],
  field: (typeof layers)[keyof typeof layers],
  until = repairAt,
) {
  if (!view.ship?.geometryAvailable) return [];
  const origin = view.ship;
  return members
    .flatMap((member) => {
      const ship = view.entities.find(
        (row) =>
          row.itemID === member.shipID &&
          row.kind === "ship" &&
          !row.isNpc &&
          !row.isSelf &&
          row.ownerID === member.characterID &&
          (row.characterID === null || row.characterID === member.characterID) &&
          row.geometryAvailable,
      );
      const health = ship?.[field];
      if (!ship || health == null || health >= until) return [];
      const severity =
        ship.hullRatio !== null && ship.hullRatio < 0.9
          ? 3
          : ship.armorRatio !== null && ship.armorRatio < 0.5
            ? 2
            : ship.shieldRatio !== null && ship.shieldRatio < 0.25
              ? 1
              : 0;
      const protectedShip = member.role === "MINER" || member.role === "HAULER";
      return [
        { member, ship, health, severity, protectedShip, distance: surfaceDistance(origin, ship) },
      ];
    })
    .sort(
      (a, b) =>
        b.severity - a.severity ||
        (b.severity ? Number(b.protectedShip) - Number(a.protectedShip) : 0) ||
        a.health - b.health ||
        a.distance - b.distance ||
        a.member.characterID - b.member.characterID,
    );
}

/** Belt policy over Farmer's existing fit, target and Dogma calls. Each activation is one native cycle. */
export function createBeltRepair({
  run,
  session,
  shipID,
  members,
  eligible,
  guard,
  fence,
  scene,
  readFit: refreshFit,
  canApproach,
}: {
  run: PluginRunContext;
  session: PilotSession;
  shipID: number;
  members: readonly RepairMember[];
  eligible: (member: RepairMember) => boolean;
  guard: () => void;
  fence: () => Promise<void>;
  scene: () => Promise<Scene>;
  readFit?: () => Promise<boolean>;
  canApproach: (view: Scene, ship: Entity) => boolean;
}) {
  const flying = session.flow.flying,
    options = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch };
  const pendingLocks = new Map<number, { confirmed: boolean; at: number }>();
  const awaiting = new Map<number, { target: number; until: bigint | null }>();
  const refused = new Map<
    string,
    { charge: number; capacitor: number | null; retryOnCap: boolean; why: string }
  >();
  const lockRefusals = new Map<number, { at: number; count: number; distance: number }>();
  const rejectedLocks = new Set<number>();
  let fitted: RemoteRepairModule[] | null = null,
    refreshFitAt = 0,
    approaching: number | null = null;
  const selected = () =>
    members.filter((member) => member.characterID !== run.characterID && eligible(member));
  const observe = (module: RemoteRepairModule) =>
    flying.bridgeAsk("dogmaIM", "ItemGetInfo", [module.itemID]).then((raw) => {
      guard();
      return decodeModuleObservation(raw, {
        moduleID: module.itemID,
        typeID: module.typeID,
        flagID: module.flagID,
        ownerID: run.characterID,
        shipID,
      });
    });
  async function readLocks() {
    const { targetIDs } = await getTargets(options);
    guard();
    if (!Array.isArray(targetIDs) || !targetIDs.every(id))
      throw Error("Friendly target locks are unreadable.");
    return targetIDs as number[];
  }
  async function capacitor() {
    const raw = await flying.bridgeAsk("dogmaIM", "ItemGetInfo", [shipID]);
    guard();
    const item = readKeyVal(raw, "invItem"),
      attrs = readKeyVal(raw, "attributes");
    if (
      readKeyVal(raw, "itemID") !== shipID ||
      readRowField(item, "ownerID") !== run.characterID ||
      !attrs ||
      typeof attrs !== "object" ||
      Array.isArray(attrs) ||
      !("entries" in attrs) ||
      !Array.isArray(attrs.entries)
    )
      return null;
    const entry = attrs.entries.find((pair) => Array.isArray(pair) && pair[0] === 18);
    return Array.isArray(entry) ? unwrapReal(entry[1]) : null;
  }
  async function readFit() {
    if (fitted !== null && Date.now() < refreshFitAt) return;
    const fullyNamed = await (refreshFit?.() ?? flying.readFit());
    guard();
    const fit = session.store.fitting.get();
    if (fit.activeShipID !== shipID || fit.slotsError !== null)
      throw Error("Remote repair fitting does not match the held ship.");
    const qualified = fleetRepairFitModules(fit.slots, flying.resolveRemoteRepModuleIDs(), (m) =>
      flying.fittedModuleActivation(m),
    );
    if (!fullyNamed && !qualified.length)
      throw Error("Remote repair fitting classifications are unavailable.");
    fitted = qualified;
    refreshFitAt = Date.now() + 5000;
  }
  return {
    capable: () =>
      !!fleetRepairFitModules(
        session.store.fitting.get().slots,
        flying.resolveRemoteRepModuleIDs(),
        (m) => flying.fittedModuleActivation(m),
      ).length,
    urgent(view: Scene) {
      const remote = flying.resolveRemoteRepModuleIDs(),
        peers = selected();
      return (["shield", "armor", "hull"] as const).some(
        (layer) =>
          remote[layer].length &&
          candidates(view, peers, layers[`remote-${layer}`], clearAt).some(
            (recipient) => recipient.severity > 0,
          ),
      );
    },
    async ready() {
      await readFit();
      return !!fitted?.length;
    },
    async tick(view: Scene) {
      if (!pendingLocks.size && !awaiting.size && approaching === null) {
        const peers = selected();
        if (!Object.values(layers).some((layer) => candidates(view, peers, layer, clearAt).length))
          return null;
      }
      await readFit();
      if (!fitted?.length) return null;
      let active: string | null = null,
        waiting: string | null = null,
        warning: string | null = null,
        urgent = false,
        closingRange = false;
      const needed = new Set<number>();
      let locks: number[] | null = null,
        remaining: number | null | undefined;
      for (const module of fitted) {
        const targetChoices = candidates(view, selected(), layers[module.kind]);
        try {
          const native = await observe(module);
          const running = native.effects.filter((effect) => effect.effectID !== 16);
          const pending = awaiting.get(module.itemID);
          if (running.length) {
            if (pending && running.some((effect) => effect.targetID === pending.target))
              awaiting.delete(module.itemID);
            const recipient = candidates(view, selected(), layers[module.kind], clearAt).find(
              (choice) => running.some((effect) => effect.targetID === choice.member.shipID),
            );
            if (recipient) {
              needed.add(recipient.member.shipID);
              active =
                labels[module.kind] +
                " on " +
                (recipient.ship.name ?? "pilot " + recipient.member.characterID);
              urgent ||= recipient.severity > 0;
            }
            // A one-cycle effect already in flight ends in native Dogma. Never
            // reactivate or redirect it before ItemGetInfo observes inactivity.
            continue;
          }
          if (!targetChoices.length) continue;
          const range = native.attributes?.[54];
          if (!native.online || range === undefined || !Number.isFinite(range) || range <= 0) {
            warning =
              "Repair module " +
              module.itemID +
              " is offline or its native optimal range is unavailable.";
            continue;
          }
          if (pending && (pending.until === null || BigInt(native.timeFiletime) < pending.until)) {
            warning =
              "Repair module " + module.itemID + " is waiting for its native activation state.";
            continue;
          }
          awaiting.delete(module.itemID);
          const need = native.attributes?.[6];
          if (remaining === undefined)
            remaining = await capacitor().catch(() => {
              guard();
              return null;
            });
          if (remaining !== null && typeof need === "number" && need > remaining) {
            warning = "Insufficient capacitor for repair module " + module.itemID + ".";
            continue;
          }
          const charge =
            session.store.fitting.get().slots.find((s) => s.module?.itemID === module.itemID)
              ?.module?.charge?.quantity ?? 0;
          const choices = targetChoices.filter((choice) => {
            const denied = refused.get(module.itemID + ":" + choice.member.shipID);
            if (
              !denied ||
              denied.charge !== charge ||
              (denied.retryOnCap &&
                remaining != null &&
                denied.capacitor != null &&
                remaining >= denied.capacitor + Math.max(1, (need ?? 0) * 0.25))
            )
              return true;
            warning = denied.why;
            return false;
          });
          const closestUsable = choices.find((row) => row.distance <= range),
            first = choices[0];
          const choice =
            first &&
            (!closestUsable ||
              (first.severity > closestUsable.severity && canApproach(view, first.ship)))
              ? first
              : closestUsable;
          if (!choice) continue;
          await fence();
          guard();
          const fresh = await scene();
          const peer = candidates(fresh, selected(), layers[module.kind]).find(
            (row) => row.member.shipID === choice.member.shipID,
          );
          if (!peer) continue;
          const target = peer.member.shipID;
          if (peer.distance > range) {
            if (canApproach(fresh, peer.ship)) {
              if (closingRange) continue;
              closingRange = true;
              if (approaching !== target) {
                guard();
                await flying.approachShip(target, Math.max(0, Math.floor(range * 0.75)));
                guard();
                approaching = target;
              }
              waiting = "Closing repair range to pilot " + peer.member.characterID + ".";
              urgent = true;
            } else
              warning =
                "Pilot " +
                peer.member.characterID +
                " is outside repair range and the permitted approach area.";
            continue;
          }
          needed.add(target);
          locks ??= await readLocks();
          if (!locks.includes(target)) {
            rejectedLocks.delete(target);
            const pending = pendingLocks.get(target);
            if (pending?.confirmed) pendingLocks.delete(target);
            const failure = lockRefusals.get(target);
            const closer = !!failure && peer.distance < failure.distance - 1000;
            if (
              !pendingLocks.has(target) &&
              (!failure || closer || (failure.count < 2 && Date.now() - failure.at >= 5000))
            ) {
              if (!eligible(peer.member)) continue;
              guard();
              const at = Date.now();
              try {
                await lockTarget(flying.bridgeDo, target, {
                  lockedTargetIDs: locks,
                  acquiringTargetIDs: [],
                });
                guard();
                lockRefusals.delete(target);
                pendingLocks.set(target, { confirmed: false, at });
              } catch (error) {
                guard();
                const refusal = error as { code?: string; status?: number } | null;
                if (refusal?.code === "CALL_REFUSED" && refusal.status === 409)
                  lockRefusals.set(target, {
                    at,
                    count: closer ? 1 : (failure?.count ?? 0) + 1,
                    distance: peer.distance,
                  });
                else pendingLocks.set(target, { confirmed: false, at });
                throw error;
              }
            }
            if (!pendingLocks.has(target)) {
              warning = "Native repair lock was refused for pilot " + peer.member.characterID + ".";
              continue;
            }
            waiting =
              Date.now() - (pendingLocks.get(target)?.at ?? Date.now()) > 45000
                ? "Native repair lock remains unconfirmed for pilot " +
                  peer.member.characterID +
                  "."
                : "Waiting for a native repair lock on pilot " + peer.member.characterID + ".";
            urgent ||=
              peer.severity > 0 &&
              Date.now() - (pendingLocks.get(target)?.at ?? Date.now()) <= 45000;
            continue;
          }
          const ownLock = pendingLocks.get(target);
          if (ownLock) ownLock.confirmed = true;
          if (rejectedLocks.has(target)) {
            waiting =
              "Waiting for the refused repair lock to clear on pilot " +
              peer.member.characterID +
              ".";
            continue;
          }
          if (!eligible(peer.member)) continue;
          guard();
          const duration = native.attributes?.[73];
          const acknowledgedUntil =
            typeof duration === "number" && duration > 0 && Number.isFinite(duration)
              ? BigInt(native.timeFiletime) + BigInt(Math.ceil(duration * 10000))
              : null;
          const key = module.itemID + ":" + target;
          awaiting.set(module.itemID, { target, until: null });
          try {
            await flying.bridgeDo("dogmaIM", "Activate", [module.itemID, "", target, 0]);
          } catch (error) {
            guard();
            if (targetNotLockedRefusal(error)) {
              awaiting.delete(module.itemID);
              rejectedLocks.add(target);
              locks = null;
              waiting = "Native repair lock was lost; checking the next lock observation.";
              continue;
            }
            if (!alreadyActiveRefusal(error)) {
              const refusal = error as {
                code?: string;
                status?: number;
                refusal?: { key?: string };
              } | null;
              const why = "Repair module " + module.itemID + ": " + message(error);
              if (refusal?.code === "CALL_REFUSED" && refusal.status === 409) {
                awaiting.delete(module.itemID);
                refused.set(key, {
                  charge,
                  capacitor: remaining ?? null,
                  retryOnCap:
                    refusal.refusal?.key === "NotEnoughCapacitor" ||
                    /not enough capacitor/i.test(why),
                  why,
                });
              }
              warning = why;
              continue;
            }
          }
          awaiting.set(module.itemID, { target, until: acknowledgedUntil });
          if (remaining !== null && typeof need === "number") remaining -= need;
          const after = await observe(module);
          if (after.activeTargets.some((effect) => effect.targetID === target)) {
            awaiting.delete(module.itemID);
            refused.delete(key);
            active =
              labels[module.kind] + " on " + (peer.ship.name ?? "pilot " + peer.member.characterID);
          } else
            waiting = "Waiting for native repair effect on pilot " + peer.member.characterID + ".";
          urgent ||= peer.severity > 0;
        } catch (error) {
          guard();
          warning = "Repair module " + module.itemID + ": " + message(error);
        }
      }
      if (approaching !== null && !closingRange && !needed.has(approaching)) {
        try {
          guard();
          await session.flow.stopShip();
          guard();
          approaching = null;
        } catch (error) {
          guard();
          warning = "Repair approach stop: " + message(error);
        }
      }
      // Release only our confirmed friendly locks, leaving offensive and pre-existing locks alone.
      if (pendingLocks.size) {
        try {
          locks = await readLocks();
          for (const [target, lock] of pendingLocks) {
            if (locks.includes(target)) lock.confirmed = true;
            if (needed.has(target) || !lock.confirmed) continue;
            if (locks.includes(target)) {
              guard();
              await flying.bridgeDo("dogmaIM", "RemoveTarget", [target]);
              guard();
            }
            pendingLocks.delete(target);
          }
        } catch (error) {
          guard();
          warning = "Repair lock cleanup: " + message(error);
        }
      }
      return { active, waiting, warning, urgent };
    },
  };
}
