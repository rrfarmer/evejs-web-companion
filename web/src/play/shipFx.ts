// The client's ShipEffects (eve/client/script/environment/effects/GenericEffect.py ShipEffect): an OnSpecialFX whose
// guid the effects table types "ShipEffect" - a stasis web's vortex on its target, a survey scan's sphere, an ECM
// burst - drawn as its graphic (an EveTransform, an EveChildContainer or an effect root) placed by the table's
// transformFlags (effectConsts.py FX_TF_*):
// - POSITION_BALL (1) at the ship's ball, POSITION_TARGET (2) at the target's - the effect ball; POSITION_MODEL (7)
//   at the ship's model's bounds' centre (EveLocalPositionCurve centerBounds, its parent the ship's model);
// - ELLIPSOID (8): scaled by the effect ball's model's authored shapeEllipsoidRadius and moved by its
//   shapeEllipsoidCenter in the model's frame (a ship's model always has the attributes; unset they read -1, 0);
// - SCALE_BOUNDING (5) scaled by the effect ball's model's local box, each axis max(-min, max) x 1.2;
//   SCALE_SYMMETRIC (4) and SCALE_RADIUS (6) by its bounding sphere radius - the first of 8 / graphicRadius / 5 / 4
//   / 6 that applies;
// - ROTATION_BALL (3) turned with the effect ball; else unturned (the ship model's modelRotationCurve, which a ship's
//   model leaves unset).
// Start plays its first curve set from the start - where the table says timeScale, at GetMaxCurveDuration / the
// trigger's duration in seconds, so it spans the module's cycle - and Repeat, each cycle after (the server sends one
// start with a repeat count; the client's FxSequencer repeats it), plays it again; Stop removes it
// (lingerOnDeathTimer, a graphicInfo the module triggers never give, is nought).

import * as THREE from "three";
import { hullChildren, playEffectSet, type SofChildNode } from "../three/hullChildren.ts";
import { fxGuid } from "./turretFx.ts";

/** A ShipEffect's graphic as the fx route reads it (extract.mjs extractFxGraphic: its shipEffect). */
interface ShipEffectData {
  root: SofChildNode;
  childEffects: Record<string, SofChildNode | null>;
  transformFlags: number[];
  timeScale: boolean;
  firstSet: { name: string | null; length: number } | null;
}

/** The effects table's ShipEffect guids whose flags are all drawn here (client 3396210). */
const SHIP_EFFECTS = new Set([
  "effects.ModifyTargetSpeed", "effects.SurveyScan", "effects.ElectronicAttributeModifyActivate",
  "effects.TurretWeaponRangeTrackingSpeedMultiplyActivate", "effects.TargetBreaker", "effects.ECMBurst", "effects.Jettison",
  "effects.WarfareLinkSkirmish", "effects.WarfareLinkShield", "effects.WarfareLinkArmor", "effects.WarfareLinkInformation",
  "effects.WarfareLinkMining", "effects.WarfareLinkedGeneric", "effects.MicroJumpFieldJump",
  "effects.SuperWeaponAOETrackingDisruption", "effects.SuperWeaponAOEStasisWeb", "effects.SuperWeaponAOESensorDampener",
  "effects.SuperWeaponAOEGuidanceDisruption", "effects.SuperWeaponAOEPulse", "effects.SuperWeaponAOEWarpDisruption",
  "effects.SuperWeaponAOECycle", "effects.SuperWeaponAOETargetPainter", "effects.SuperWeaponEnergyDrain",
  // [7], [1, 5], [1, 3, 8], [1, 3] and the like
  "effects.WarfareLinkSphereInformation", "effects.WarfareLinkSphereSkirmish", "effects.WarfareLinkSphereArmor",
  "effects.WarfareLinkSphereMining", "effects.WarfareLinkSphereShield", "effects.StructureECMBurst", "effects.DrifterControlled",
  "effects.SuperDefenseShield", "effects.AbyssalDeparturePlayer", "effects.AbyssalDepartureObserver", "effects.PulseSphere80K",
  "effects.PulseSphere30K", "effects.AbyssalSpaceTear", "effects.AbyssalSpaceTearTrace", "effects.AbyssalSpaceTearTraceB",
  "effects.AbyssalWinterSpaceTearTrace", "effects.OutOfBoundsShip", "effects.OutOfBoundsShipWinter", "effects.OutOfBoundsShipDeathzone",
  "effects.ScanningPulseVolumeAsteroid",
]);
const FX_TF_POSITION_BALL = 1, FX_TF_POSITION_TARGET = 2, FX_TF_ROTATION_BALL = 3, FX_TF_SCALE_SYMMETRIC = 4, FX_TF_SCALE_BOUNDING = 5,
  FX_TF_SCALE_RADIUS = 6, FX_TF_POSITION_MODEL = 7, FX_TF_ELLIPSOID = 8;

const datas = new Map<string, Promise<ShipEffectData | null>>();
function shipEffectData(guid: string): Promise<ShipEffectData | null> {
  if (!datas.has(guid)) {
    datas.set(guid, typeof fetch !== "function" ? Promise.resolve(null)
      : fetch(`/client-assets/fx/${guid}.json`).then((r) => r.json()).then((fx: { shipEffect?: ShipEffectData | null }) => fx.shipEffect ?? null).catch(() => null));
  }
  return datas.get(guid)!;
}

interface Playing {
  guid: string; shooter: number; target: number; until: number; cycle: number; nextRepeat: number;
  holder: THREE.Group; offset: THREE.Group; data: ShipEffectData | null; object: THREE.Object3D | null; scale: number | undefined;
}

/**
 * The ball's place (three's space), its model's bounding sphere radius and its turn, as the view knows them; its
 * model's local box (GetLocalBoundingBox: the mesh's, in the model's own space, three's handedness) and the box's
 * centre in three's space; its hull's authored shape ellipsoid (EVE's model space), null where unset.
 */
export interface ShipFxBall {
  position: THREE.Vector3; radius: number | null; quaternion: THREE.Quaternion | null;
  box?: { min: THREE.Vector3; max: THREE.Vector3; centre: THREE.Vector3 } | null;
  ellipsoid?: { center: number[]; radius: number[] } | null;
}

export class ShipFx {
  readonly group = new THREE.Group();
  private readonly playing = new Map<string, Playing>();
  get live(): number { return this.playing.size; }

  /** OnSpecialFX(shipID, moduleID, moduleTypeID, targetID, otherTypeID, guid, isOffensive, start, active, duration, repeat, ...). */
  hear(name: string, args: readonly unknown[]): void {
    if (name !== "OnSpecialFX") return;
    const guid = fxGuid(args[5]).split(",").map((g) => g.trim()).find((g) => SHIP_EFFECTS.has(g));
    if (!guid) return;
    const shooter = Number(args[0]), moduleID = Number(args[1]), target = Number(args[3]);
    const key = `${shooter}:${moduleID}:${guid}`;
    const was = this.playing.get(key);
    if (Number(args[7]) !== 1) { if (was) this.drop(key, was); return; }
    const duration = Number(args[9]) > 0 ? Number(args[9]) : 10_000, repeat = Number(args[10]);
    const now = performance.now();
    const until = now + Math.min(duration * Math.max(1, Number.isFinite(repeat) && repeat > 0 ? Math.min(repeat, 1000) : 1), 10 * 60_000);
    // a start again on the same target: the run goes on to the new end
    if (was && was.target === target) { was.until = until; return; }
    if (was) this.drop(key, was);
    const p: Playing = { guid, shooter, target, until, cycle: duration, nextRepeat: Infinity, holder: new THREE.Group(), offset: new THREE.Group(), data: null, object: null, scale: undefined };
    p.holder.visible = false;
    p.holder.add(p.offset);
    this.group.add(p.holder);
    this.playing.set(key, p);
    void shipEffectData(guid).then(async (data) => {
      if (!data?.root || this.playing.get(key) !== p) return;
      const object = await hullChildren([{ res: "", root: structuredClone(data.root), skipped: {} }], data.childEffects).catch(() => null);
      if (!object || this.playing.get(key) !== p) return;
      p.data = data;
      p.object = object;
      p.offset.add(object);
      // Start: the first set from its start, over the cycle where the table scales its time
      const length = data.firstSet?.length ?? 0;
      p.scale = data.timeScale && length > 0 ? length / (duration / 1000) : undefined;
      playEffectSet(object, data.firstSet?.name ?? null, p.scale);
      p.nextRepeat = performance.now() + p.cycle;
    });
  }

  /** Each effect placed at its ball (ShipEffect.Prepare), gone at the end of its run. */
  update(ballOf: (itemID: number) => ShipFxBall | null, now = performance.now()): void {
    for (const [key, p] of this.playing) {
      if (now > p.until) { this.drop(key, p); continue; }
      // Repeat, each cycle (the FxSequencer's, from the start's repeat count): the first curve set played again
      if (p.object && now >= p.nextRepeat) {
        playEffectSet(p.object, p.data?.firstSet?.name ?? null);
        p.nextRepeat = now >= p.nextRepeat + p.cycle ? now + p.cycle : p.nextRepeat + p.cycle;
      }
      const flags = p.data?.transformFlags ?? [];
      const has = (f: number) => flags.includes(f);
      // the ship's ball and the effect ball (the target's where POSITION_TARGET)
      const ship = ballOf(p.shooter);
      const ball = has(FX_TF_POSITION_TARGET) ? ballOf(p.target) : ship;
      if (!ball || !ship) { p.holder.visible = false; continue; }
      if (has(FX_TF_POSITION_BALL)) p.holder.position.copy(ship.position);
      if (has(FX_TF_POSITION_MODEL)) p.holder.position.copy(ship.box?.centre ?? ship.position);
      if (has(FX_TF_POSITION_TARGET)) p.holder.position.copy(ball.position);
      // the scaling: ELLIPSOID's, else SCALE_BOUNDING's, SYMMETRIC's or RADIUS's (graphicRadius: no module trigger gives one)
      p.offset.position.set(0, 0, 0);
      const box = ball.box ? [0, 1, 2].map((i) => Math.max(-ball.box!.min.getComponent(i), ball.box!.max.getComponent(i))) : null;
      // (a SOF hull's model has the attributes, authored or at their defaults: radius -1, centre 0; a model without
      // them - undefined here - takes SCALE_BOUNDING instead)
      const e = ball.ellipsoid === undefined ? undefined : ball.ellipsoid ?? { center: [0, 0, 0], radius: [-1, -1, -1] };
      if (has(FX_TF_ELLIPSOID) && e) {
        p.holder.scale.set(e.radius[0] ?? -1, e.radius[1] ?? -1, e.radius[2] ?? -1);
        // modelTranslationCurve: the centre, in the model's frame (EVE's z mirrored into three's), before the scaling
        p.offset.position.set((e.center[0] ?? 0) / (e.radius[0] || 1), (e.center[1] ?? 0) / (e.radius[1] || 1), -(e.center[2] ?? 0) / (e.radius[2] || 1));
      } else if ((has(FX_TF_ELLIPSOID) || has(FX_TF_SCALE_BOUNDING)) && box) {
        p.holder.scale.set(box[0]! * 1.2, box[1]! * 1.2, box[2]! * 1.2);
      } else if (has(FX_TF_SCALE_SYMMETRIC) || has(FX_TF_SCALE_RADIUS)) {
        p.holder.scale.setScalar(ball.radius ?? 1);
      } else p.holder.scale.setScalar(1);
      if (has(FX_TF_ROTATION_BALL) && ball.quaternion) p.holder.quaternion.copy(ball.quaternion);
      else p.holder.quaternion.identity();
      p.holder.visible = !!p.object;
    }
  }

  private drop(key: string, p: Playing): void {
    this.group.remove(p.holder);
    this.playing.delete(key);
  }
}
