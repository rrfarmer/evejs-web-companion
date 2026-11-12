// Weapons fire, drawn from the server's own word of it: michelle.OnSpecialFX(shipID, moduleID, moduleTypeID,
// targetID, otherTypeID, guid, isOffensive, start, active, duration, repeat, ...), the effect a turret plays as it
// cycles (effects.ProjectileFired, effects.HybridFired, effects.Laser...: start 1 as it begins, start 0 as it stops).
// A turret whose firing effect is drawn here plays it (EveTurretFiringFX: an EveStretch2 per muzzle - laser.fx,
// projectile.fx, blast.fx, artillery.fx, atomic.fx - three/stretch2.ts); the rest are our own drawing of it: tracer
// pulses from the shooter to its target for guns, a flickering beam for a laser whose effect has not come, and a flash
// where the shots land.

import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { Stretch2Effect, stretch2Kit, type SofStretch2, type Stretch2Kit } from "../three/stretch2.ts";
import { gpuSystemOf } from "../three/gpuParticles.ts";
import { hullChildren, startEffect } from "../three/hullChildren.ts";
import { livePartsOf, placeEveStretch, placeStretch, setVariable, type SofStretch3 } from "../three/behaviorAgents.ts";
import { offerLights } from "../three/dynamicLights.ts";

interface Firing {
  shooter: number; target: number; moduleID: number; moduleTypeID: number; kind: "projectile" | "hybrid" | "laser" | "mining" | "launcher" | "ewar"; startedAt: number; until: number; lastPulse: number;
  /** The charge (OnSpecialFX's otherTypeID): its beam colour (ammoColors). */
  chargeTypeID: number;
  /**
   * A Triglavian beam's spool-up (effects.TriglavianBeam: OnSpecialFX's graphicInfo, the module's damage bonus per
   * cycle and its most) and the cycles fired; null for the rest.
   */
  spool: { perCycle: number; max: number; cycles: number } | null;
  /** A Vorton projector's chain (effects.UpwellChainWeapon*: ChainWeaponEffect): its guid and the further targets. */
  chain: { guid: string; targets: number[] } | null;
  /** Each muzzle's firing (EveTurretFiringFX per-muzzle data): when its delay is over, when it began; the cycling position. */
  muzzles: { startAt: number | null; startedAt: number | null }[]; cyclingPos: number;
  /** One shot a cycle: its length (ms) and when the next begins; whether the turret was idle (its first shot waits to track). */
  cycle: number; nextCycle: number; idle: boolean;
  /** The turret's miss queue (EveTurretTarget: the last four told, popped by each shot; empty a hit). */
  misses: boolean[];
  /** Shots begun whose impact is still to come: when, and its size and life (null: read when it lands, the turret's graphic not come when it began). */
  shots: { at: number; size: number | null; life: number | null }[];
}
/** A turret module's graphic as the extractor reads it (lib/turret.mjs; GET /client-assets/turret/<typeID>). */
export interface TurretInfo {
  impactSize: number; useRandomFiringDelay: boolean; maxTrackingTime: number; firingPeakTime: number; firingDuration: number;
  isLoopFiring?: boolean; maxCyclingFirePos?: number; cyclingFireGroupCount?: number;
  /** The firing's sounds (lib/turret.mjs, turretBuild 13: the firing effect's AudEventCurves - each event, its key's
   *  time, at the muzzle or the target). */
  sounds?: { event: string; time: number; at: "muzzle" | "target" }[];
  /** Its firing effect: a stretch per muzzle, the target's scaling (lib/turret.mjs, turretBuild 5). */
  firing?: { stretches: ({ type: string | null } | SofStretch2 | TurretStretch3)[]; scaleEffectTarget: boolean; minRadius: number; maxRadius: number; minScale: number; maxScale: number } | null;
}
/** A firing effect's EveStretch3 as the extractor reads it (children.mjs readTurretStretch3). */
type TurretStretch3 = SofStretch3 & { type: "EveStretch3" | "EveStretch"; name: string | null };
/** A module type's EveStretch3s built (hull-child graphs, one template per stretch), once: null where it has none. */
const stretch3s = new Map<number, { data: TurretStretch3; template: THREE.Object3D }[] | null>();
const stretch3Asked = new Set<number>();
function stretch3Of(typeID: number, info: TurretInfo | null): { data: TurretStretch3; template: THREE.Object3D }[] | null {
  if (!info) return null;
  if (!stretch3Asked.has(typeID)) {
    stretch3Asked.add(typeID);
    const specs = (info.firing?.stretches ?? []).filter((s): s is TurretStretch3 => (s.type === "EveStretch3" || s.type === "EveStretch") && !!(s as TurretStretch3).root);
    if (!specs.length || specs.length !== (info.firing?.stretches.length ?? 0)) stretch3s.set(typeID, null);
    else void Promise.all(specs.map(async (data) => {
      const template = await hullChildren([{ res: "", root: data.root, skipped: {} }]);
      if (!template) throw new Error("no graph");
      template.scale.set(1, 1, 1);
      return { data, template };
    })).then((t) => stretch3s.set(typeID, t)).catch(() => stretch3s.set(typeID, null));
  }
  return stretch3s.get(typeID) ?? null;
}
/** A charge's beam colour by its typeID (/client-assets/ammoColors.json), once asked. */
let ammoColours: Record<string, number[]> | null = null;
let ammoAsked = false;
function ammoColour(typeID: number): number[] | null {
  if (!ammoAsked && typeof fetch === "function") {
    ammoAsked = true;
    void fetch("/client-assets/ammoColors.json").then((r) => r.json()).then((m: Record<string, number[]>) => { ammoColours = m; }).catch(() => undefined);
  }
  return ammoColours?.[String(typeID)] ?? null;
}
/** A module type's stretches made ready (their textures), once: null where it has none drawn here. */
const kits = new Map<number, Stretch2Kit[] | null>();
const kitsAsked = new Set<number>();
function kitsOf(typeID: number, info: TurretInfo | null): Stretch2Kit[] | null {
  if (!info) return null;
  if (!kitsAsked.has(typeID)) {
    kitsAsked.add(typeID);
    const specs = (info.firing?.stretches ?? []).filter((s): s is SofStretch2 => s.type === "EveStretch2");
    // only a firing effect wholly of stretches drawn here (a mix would lose its other muzzles)
    if (!specs.length || specs.length !== (info.firing?.stretches.length ?? 0)) kits.set(typeID, null);
    else void Promise.all(specs.map(stretch2Kit)).then((k) => kits.set(typeID, k.every((x) => !!x) ? k as Stretch2Kit[] : null)).catch(() => kits.set(typeID, null));
  }
  return kits.get(typeID) ?? null;
}
/**
 * OnSpecialFX's graphicInfo for a Triglavian beam (triglavianBeam.py: mulitplierBonusPerCycle - the client's spelling -
 * and multiplierBonusMax), as a dict however the wire decoded it; noughts where it has none.
 */
function spoolOf(raw: unknown): { perCycle: number; max: number } {
  const get = (k: string): number => Number(graphicInfoValue(raw, k) ?? 0) || 0;
  return { perCycle: get("mulitplierBonusPerCycle") || get("multiplierBonusPerCycle"), max: get("multiplierBonusMax") };
}
/** One key of OnSpecialFX's graphicInfo (a util.KeyVal: {type: "object", name, args: {type: "dict", entries}}), raw. */
function graphicInfoValue(raw: unknown, key: string): unknown {
  const o0 = raw as Record<string, unknown> | null;
  const dict = o0 && typeof o0 === "object" && o0.type === "object" && o0.args ? o0.args : raw;
  if (!dict || typeof dict !== "object") return undefined;
  if (dict instanceof Map) return dict.get(key);
  const o = dict as Record<string, unknown>;
  if (Array.isArray(o.entries)) return (o.entries as unknown[][]).find((p) => fxGuid(p?.[0]) === key)?.[1];
  return o[key];
}
/** ChainWeaponEffect's graphicInfo['targets']: the further targets the chain jumps to, in order. */
function chainTargetsOf(raw: unknown): number[] {
  const v = graphicInfoValue(raw, "targets") as { items?: unknown[] } | unknown[] | undefined;
  const items = Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : [];
  return items.map((x) => Number(typeof x === "bigint" ? Number(x) : x)).filter((x) => Number.isFinite(x) && x > 0);
}
/** An effect guid's own graphic (/client-assets/fx/<guid>.json: the Vorton chain's EveStretch3), built once. */
const fxGraphics = new Map<string, { data: TurretStretch3; template: THREE.Object3D } | null>();
const fxAsked = new Set<string>();
function fxGraphicOf(guid: string): { data: TurretStretch3; template: THREE.Object3D } | null {
  if (!fxAsked.has(guid) && typeof fetch === "function") {
    fxAsked.add(guid);
    void fetch(`/client-assets/fx/${guid}.json`).then((r) => r.json()).then(async (fx: { stretches?: TurretStretch3[] }) => {
      const data = fx.stretches?.[0];
      if (!data?.root) { fxGraphics.set(guid, null); return; }
      const template = await hullChildren([{ res: "", root: data.root, skipped: {} }]);
      if (!template) { fxGraphics.set(guid, null); return; }
      template.scale.set(1, 1, 1);
      fxGraphics.set(guid, { data, template });
    }).catch(() => fxGraphics.set(guid, null));
  }
  return fxGraphics.get(guid) ?? null;
}
/** EveTurretFiringFX::UpdateVisibility's LOD_ANGLE_FACTOR. */
const LOD_ANGLE_FACTOR = 0.002;
/** EveTurretTarget.h EVE_TURRET_RANDOM_DELAY_MAX: GetShotTimeVariance. */
const RANDOM_DELAY_MAX = 0.6;
const turretInfos = new Map<number, TurretInfo | null>();
const turretAsked = new Set<number>();
/** A module type's turret graphic, asked for once; null until it has come, or where the type has none. */
function turretInfo(typeID: number): TurretInfo | null {
  if (!turretAsked.has(typeID) && typeID > 0 && typeof fetch === "function") {
    turretAsked.add(typeID);
    void fetch(`/client-assets/turret/${typeID}`).then((r) => r.json()).then((t: Partial<TurretInfo> & { turret?: null }) => {
      turretInfos.set(typeID, t && typeof t.impactSize === "number" ? t as TurretInfo : null);
    }).catch(() => undefined);
  }
  return turretInfos.get(typeID) ?? null;
}
interface Pulse { firing: Firing; bornAt: number; mesh: Line2; flash: THREE.Sprite; from: THREE.Vector3 | null }
interface Blast { itemID: number; at: THREE.Vector3 | null; bornAt: number; sprite: THREE.Sprite; size: number }

const KIND: Record<string, Firing["kind"]> = {
  "effects.ProjectileFired": "projectile",
  "effects.ProjectileFiredForEntities": "projectile",
  "effects.HybridFired": "hybrid",
  "effects.Laser": "laser",
  "effects.TriglavianBeam": "laser",
  // the miners (their firing effects EveStretch3s; nothing of our own drawn for them)
  "effects.Mining": "mining",
  "effects.CloudMining": "mining",
  // the tractor beams and salvagers (their firing effects EveStretches; nothing of our own drawn)
  "effects.TractorBeam": "mining",
  "effects.Salvaging": "mining",
  // the Vorton projectors (their turret's own firing effect, and the chain: chainLinks)
  // the EWAR and remote-assistance modules' stretches (the effects table's LocatorStretchEffect and EveStretch3
  // types): the guid's own graphic from the ship to the target while the module runs
  "effects.WarpScramble": "ewar",
  "effects.WarpDisrupt": "ewar",
  "effects.EnergyDestabilization": "ewar",
  "effects.EnergyVampire": "ewar",
  "effects.SensorDampening": "ewar",
  "effects.TrackingDisruption": "ewar",
  "effects.RemoteECM": "ewar",
  "effects.EnergyTransfer": "ewar",
  "effects.RemoteArmorRepairDrone": "ewar",
  "effects.TargetPaint": "ewar",
  "effects.ShieldTransfer": "ewar",
  "effects.RemoteHullRepair": "ewar",
  "effects.UpwellChainWeaponSmall": "laser",
  "effects.UpwellChainWeaponMedium": "laser",
  "effects.UpwellChainWeaponLarge": "laser",
};
const COLOUR: Record<Firing["kind"], number> = { projectile: 0xffc36a, hybrid: 0x8ff0ff, laser: 0xff5a3c, mining: 0xff5a3c, launcher: 0xffc36a, ewar: 0x8ff0ff };
/** How often a gun's pulse goes out, and how long it takes to get there (a likeness, not the cycle). */
const PULSE_EVERY_MS = 220, FLIGHT_MS = 260;

/** The guid of an OnSpecialFX, whichever way the wire decoded it. */
export function fxGuid(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  const data = (raw as { data?: number[] } | null)?.data;
  return Array.isArray(data) ? String.fromCharCode(...data) : String(raw);
}

export class TurretFx {
  readonly group = new THREE.Group();
  private readonly firings = new Map<string, Firing>();
  private readonly pulses: Pulse[] = [];
  private readonly beams = new Map<Firing, Line2>();
  /** A laser firing's stretches, one per muzzle (its turret's firing effect). */
  private readonly stretches = new Map<Firing, Stretch2Effect[]>();
  /** A firing's EveStretch3s, one per muzzle (a clone of its template each), and whether each has been started. */
  private readonly stretch3 = new Map<Firing, { fx: THREE.Object3D; started: boolean; startedAt: number | null }[]>();
  /** A Vorton firing's chain links (ChainWeaponEffect: turret to target, then target to target), made anew each cycle. */
  /** Each launcher's cycling position (shooter:module:launch), kept between its shots. */
  private readonly launchCycling = new Map<string, number>();
  private readonly chainLinks = new Map<Firing, { fx: THREE.Object3D; from: number | null; to: number }[]>();
  private readonly blasts: Blast[] = [];
  /** The screen's size in pixels: fat lines are drawn so many pixels wide. */
  private readonly resolution = new THREE.Vector2(1, 1);
  setResolution(w: number, h: number): void { this.resolution.set(w, h); }
  private line(colour: number, width: number): Line2 {
    const line = new Line2(new LineGeometry(), new LineMaterial({ color: colour, linewidth: width, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.material.resolution = this.resolution;
    line.frustumCulled = false;
    return line;
  }
  private flashTexture: THREE.Texture | null = null;

  constructor() { this.group.name = "turretFx"; }

  /**
   * A shot's impact on its target (the client's turret set fires one shot each weapon cycle, turretSet.py; its
   * EveTurretSet::EnterStateFiring starts the shot after a random delay of up to 0.6 s - plus the turret's tracking
   * time when it was idle - and the firing effect's peak, and EveTurretTarget::StartFireAtLocator pops the miss queue:
   * a hit with an impact size above nought makes the target's impact when the delay is over, living the firing's
   * length less its peak, EveTurretTarget.cpp:136-159, :258-265): the shooter, the target, the turret's impact size and
   * that life in seconds.
   */
  onShot: ((shooter: number, target: number, size: number, lifeTime: number) => void) | null = null;

  /**
   * godma.OnDamageMessage: by the message's keys, the ship whose turrets hear the shot's hit or miss - observed: the
   * source's; a target: the pilot's own (only those shooting that target); an owner: the owner's ship (none that we
   * know: a targeted pilot's, targetSvc.ownerToShipIDCache); else a source: the source's. Of that ship's turrets
   * shooting (with the message's weapon type where it names one), the one with the fewest misses queued is told
   * (DamageMessageTurretPropogation, DamageMessageGrouped: hit quality at most 0 a miss, 3 or more a hit, 1 a miss half
   * the time, 2 a quarter; none given 5). Its miss queue keeps the last four.
   */
  damageMessage(ownShipID: number, routing: { observed: boolean; targetID: number | null; hasOwner: boolean; sourceID: number | null }, weaponTypeID: number | null, hitQuality: number | null): void {
    const shipID = routing.observed ? routing.sourceID : routing.targetID !== null ? ownShipID : routing.hasOwner ? null : routing.sourceID;
    if (shipID === null) return;
    let best: Firing | null = null;
    for (const f of this.firings.values()) {
      if (f.shooter !== shipID) continue;
      if (routing.targetID !== null && f.target !== routing.targetID) continue;
      if (weaponTypeID && f.moduleTypeID !== weaponTypeID) continue;
      if (!best || f.misses.length < best.misses.length) best = f;
    }
    if (!best) return;
    const q = hitQuality ?? 5;
    const missed = q <= 0 ? true : q >= 3 ? false : Math.random() < [0.5, 0.25][q - 1]!;
    best.misses.push(missed);
    while (best.misses.length > 4) best.misses.shift();
  }

  /**
   * Every module effect under way (any OnSpecialFX: guns, launchers, the rest), by shooter and module: its target and
   * when it ends (a cycle times its repeats; a minute where open). The turrets aim at it (turretModel.ts).
   */
  private readonly aims = new Map<string, { shooter: number; moduleID: number; target: number; until: number }>();
  /** The target a ship's module is working on now (moduleID null: any of the ship's), or null. */
  aimTarget(shooter: number, moduleID: number | null, now = performance.now()): number | null {
    for (const a of this.aims.values()) {
      if (a.shooter !== shooter || (moduleID !== null && a.moduleID !== moduleID)) continue;
      if (now > a.until) continue;
      if (a.target > 0) return a.target;
    }
    return null;
  }

  /** A park entry: OnSpecialFX (a firing begun or stopped) or TerminalPlayDestructionEffect (a ball blown up). */
  hear(name: string, args: readonly unknown[]): void {
    if (name === "OnSpecialFX") {
      const key = `${Number(args[0])}:${Number(args[1])}`;
      if (Number(args[7]) === 1) {
        const duration = Number(args[9]), repeat = Number(args[10]);
        const until = performance.now() + (duration > 0 ? duration * Math.max(1, Number.isFinite(repeat) && repeat > 0 ? Math.min(repeat, 1000) : 1) : 60_000);
        this.aims.set(key, { shooter: Number(args[0]), moduleID: Number(args[1]), target: Number(args[3]), until });
      } else this.aims.delete(key);
    }
    if (name === "TerminalPlayDestructionEffect") {
      // the ball goes with an explosion where it was last drawn
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flash(), color: 0xffb060, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sprite.visible = false;
      this.group.add(sprite);
      this.blasts.push({ itemID: Number(args[0]), at: null, bornAt: performance.now(), sprite, size: 0 });
      return;
    }
    if (name !== "OnSpecialFX") return;
    // (a guid may be a list: "effects.TriglavianBeam,effects.AttackMode")
    const guids = fxGuid(args[5]).split(",").map((g) => g.trim());
    const guid = guids.find((g) => KIND[g]) ?? "";
    const kind = KIND[guid];
    if (!kind) return;
    const shooter = Number(args[0]), moduleID = Number(args[1]), moduleTypeID = Number(args[2]), target = Number(args[3]);
    const key = `${shooter}:${moduleID}`;
    if (Number(args[7]) !== 1) { this.firings.delete(key); return; }
    turretInfo(moduleTypeID);
    const duration = Number(args[9]), repeat = Number(args[10]);
    const now = performance.now();
    // a cycle's length times its repeats, or a minute where the server leaves it open (it says stop when it stops)
    const until = duration > 0 ? now + duration * Math.max(1, Number.isFinite(repeat) && repeat > 0 ? Math.min(repeat, 1000) : 1) : now + 60_000;
    // its shots: one a cycle (a second where the server gives none), the first at once; a firing begun anew keeps the
    // turret's state (a repeat of one already shooting is no idle turret)
    const cycle = duration > 0 ? duration : 1000;
    const was = this.firings.get(key);
    const next: Firing = {
      shooter, target, moduleID, moduleTypeID, kind, startedAt: now, until: Math.min(until, now + 10 * 60_000), lastPulse: 0,
      cycle, nextCycle: now, idle: !was, misses: was && was.target === target ? was.misses : [], shots: was?.shots ?? [],
      chargeTypeID: Number(args[4]) || 0, muzzles: was?.muzzles ?? [], cyclingPos: was?.cyclingPos ?? 0,
      spool: guid === "effects.TriglavianBeam" ? { ...spoolOf(args[13]), cycles: was?.spool?.cycles ?? 0 } : null,
      chain: kind === "ewar" ? { guid, targets: [] } : /^effects\.UpwellChainWeapon/.test(guid) ? { guid, targets: chainTargetsOf(args[13]) } : null,
    };
    this.firings.set(key, next);
    if (next.chain) fxGraphicOf(next.chain.guid);
    // an EWAR stretch's repeat on the same target keeps the stretch it has (the client's effect runs Start to Stop)
    const links = was && kind === "ewar" && was.target === target ? this.chainLinks.get(was) : undefined;
    if (was && links) { this.chainLinks.delete(was); this.chainLinks.set(next, links); }
    // a firing begun anew keeps its turret's effect going
    const fx = was ? this.stretches.get(was) : undefined;
    if (was && fx) { this.stretches.delete(was); this.stretches.set(next, fx); }
    const fx3 = was ? this.stretch3.get(was) : undefined;
    if (was && fx3) { this.stretch3.delete(was); this.stretch3.set(next, fx3); }
  }

  /** EnterStateFiring and StartFireAtLocator for one shot begun at `at` (ms). */
  private startShot(f: Firing, at: number): void {
    if (f.chain) this.shootChain(f);
    if (f.spool) f.spool.cycles++;
    this.onFire?.(f.shooter, f.moduleID, f.target);
    const info = turretInfo(f.moduleTypeID);
    // until the turret's graphic has come: a medium gun's size, no peak, a second's firing
    const peak = info?.firingPeakTime ?? 0, total = info?.firingDuration ?? 1, size = info?.impactSize ?? 0.75;
    let delay = (info?.useRandomFiringDelay ?? true) ? RANDOM_DELAY_MAX * Math.random() : 0;
    if (f.idle) { delay += info?.maxTrackingTime ?? 1; f.idle = false; }
    this.prepareFiring(f, info, at + delay * 1000);
    delay += peak;
    const missed = f.misses.shift() ?? false;
    if (!missed && size > 0) f.shots.push({ at: at + delay * 1000, size: info ? size : null, life: info ? Math.max(total - peak, 0) : null });
  }

  /**
   * EveTurretSet::EnterStateFiring for the firing effect: a looping one left going once it fires, else stopped and each
   * muzzle's stretch made to start when the delay is over (PrepareFiring; a turret cycling its muzzles - maxCyclingFirePos
   * above one - only the next group's: its stretches over its cycling positions).
   */
  private prepareFiring(f: Firing, info: TurretInfo | null, startAt: number): void {
    if (info?.isLoopFiring && f.muzzles.some((m) => m.startedAt !== null)) return;
    // the firing effect's start curve set played with it: its sound events (EveTurretFiringFX startCurveSet) - a firing
    // effect with sounds and no stretch drawn sounds all the same
    if (info?.sounds?.length) this.onSound?.(info.sounds, f.shooter, f.target, startAt);
    const n = info?.firing?.stretches.length ?? 0;
    if (!n) return;
    const fx = this.stretches.get(f);
    if (fx) for (const s of fx) s.stopFiring();
    const cycling = info?.maxCyclingFirePos ?? 1;
    // EveTurretSet::SetupFiringState / EnterStateFiring: the position steps by the group count (default 1) and wraps
    // at maxCyclingFirePos x it; PrepareFiring(delay, position, group) starts the stretches from that index - a
    // position past the stretches (a light launcher: one stretch, two positions) starts none that shot
    const group = cycling > 1 ? Math.max(1, info?.cyclingFireGroupCount ?? 1) : n;
    if (cycling > 1) f.cyclingPos = (f.cyclingPos + group) % (cycling * group);
    const first = cycling > 1 ? f.cyclingPos : 0;
    f.muzzles = Array.from({ length: n }, (_, i) => ({ startAt: i >= first && i < first + group ? startAt : null, startedAt: null }));
  }

  /**
   * EveTurretFiringFX::UpdateAsynchronous / UpdateVisibility for a laser firing: each muzzle's stretch started when its
   * delay is over, drawn for the effect's length (or on, looping) from its muzzle to the target, the target's end scaled
   * by its radius (SetScaleByRadius); muzzles near each other on screen merged into the first (its intensity theirs).
   */
  private drawStretches(f: Firing, from: THREE.Vector3, to: THREE.Vector3, now: number, radius: number | null, camera: THREE.PerspectiveCamera | null): boolean {
    const info = turretInfo(f.moduleTypeID);
    const kit = kitsOf(f.moduleTypeID, info);
    if (!kit || !info?.firing) return false;
    this.lateMuzzles(f, info, now);
    let fx = this.stretches.get(f);
    if (!fx) {
      fx = kit.map((k) => new Stretch2Effect(k));
      for (const s of fx) { this.group.add(s.mesh); s.peers = fx; }
      this.stretches.set(f, fx);
    }
    const colour = f.chargeTypeID ? ammoColour(f.chargeTypeID) : null;
    const fi = info.firing;
    const destScale = fi.scaleEffectTarget && radius !== null && fi.maxRadius !== fi.minRadius
      ? Math.max(fi.minScale, Math.min(fi.maxScale, (radius - fi.minRadius) * (fi.maxScale - fi.minScale) / (fi.maxRadius - fi.minRadius) + fi.minScale))
      : 1;
    const live: { s: Stretch2Effect; at: THREE.Vector3 }[] = [];
    fx.forEach((s, i) => {
      const m = f.muzzles[i];
      s.mesh.visible = false;
      if (!m) return;
      if (m.startedAt === null && m.startAt !== null && now >= m.startAt) {
        if (colour) s.setAmmoColor(colour);
        s.startFiring(-(now - m.startAt) / 1000, now);
        m.startedAt = now;
      }
      if (m.startedAt === null) return;
      // TriglavianBeam: Start sets 0.3, each Repeat adds the bonus per cycle (to its most) over its most
      if (f.spool) {
        const bonus = f.spool.max > 0 ? Math.min(f.spool.perCycle * Math.max(0, f.spool.cycles - 1), f.spool.max) / f.spool.max : 0;
        s.setPyIntensity(0.3 + bonus);
      }
      if (!info.isLoopFiring && (now - m.startedAt) / 1000 >= info.firingDuration) return;
      const at = this.muzzleOf?.(f.shooter, f.moduleID, i, f.target) ?? from;
      live.push({ s, at });
    });
    // the merge: the started muzzles' spread seen from the camera against a LOD angle (its fov x 0.002)
    let merge = 1;
    if (live.length > 1 && camera) {
      const centre = live.reduce((c, l) => c.add(l.at), new THREE.Vector3()).divideScalar(live.length);
      const spread = Math.max(...live.map((l) => l.at.distanceTo(centre)));
      const angle = Math.atan(spread * 2 / (camera.position.distanceTo(centre) + 1));
      const lod = THREE.MathUtils.degToRad(camera.fov) * LOD_ANGLE_FACTOR;
      merge = angle <= lod ? 0 : Math.min((angle - lod) / lod, 1);
    }
    live.forEach(({ s, at }, i) => {
      const intensity = live.length > 1 && camera ? (i === 0 ? live.length + (1 - live.length) * merge : merge) : 1;
      s.place(at, to, destScale, intensity);
      s.update(now, this.group.parent ? gpuSystemOf(this.group.parent) : null);
      s.mesh.visible = intensity > 0;
    });
    return true;
  }

  /**
   * A missile launcher's shot (MissileGraphics.Start: the launcher's turret StartShooting - missileFx.onLaunch): its
   * firing effect (EveStretch: the muzzle burst) played once, from its muzzles toward the target, after the turret
   * set's firing delay (seconds); its impacts are the missile's, not drawn here.
   */
  launch(shooter: number, moduleID: number, moduleTypeID: number, target: number | null, delay: number, now = performance.now()): void {
    const info = turretInfo(moduleTypeID);
    const key = `${shooter}:${moduleID}:launch`;
    const f: Firing = {
      shooter, target: target ?? shooter, moduleID, moduleTypeID, kind: "launcher", startedAt: now, until: now + (delay + Math.max(info?.firingDuration ?? 2, 0.5) + 0.5) * 1000, lastPulse: 0,
      cycle: Infinity, nextCycle: Infinity, idle: false, misses: [], shots: [], chargeTypeID: 0, muzzles: [], cyclingPos: 0, spool: null, chain: null,
    };
    const was = this.firings.get(key);
    if (was) { for (const e of this.stretch3.get(was) ?? []) e.fx.removeFromParent(); this.stretch3.delete(was); }
    // the launcher's cycling position goes on from its last shot
    f.cyclingPos = this.launchCycling.get(key) ?? 0;
    this.firings.set(key, f);
    if (info) this.prepareFiring(f, info, now + delay * 1000);
    else f.muzzles = [];
    this.launchCycling.set(key, f.cyclingPos);
    f.startedAt = now + delay * 1000;
  }

  /**
   * ChainWeaponEffect.Shoot for a cycle (Start, and each Repeat after removing the last): the guid's graphic from the
   * turret's first muzzle to the target, then from each target to the next of graphicInfo's targets, each with its
   * jumpNumber (0 the turret's, then 1, 2 ...), started (StartFiring) after a delay growing by 0.3 x random a link.
   * The damage it puts on source and target (_apply_damage) is not drawn.
   */
  private shootChain(f: Firing): void {
    const g = f.chain ? fxGraphicOf(f.chain.guid) : null;
    for (const l of this.chainLinks.get(f) ?? []) l.fx.removeFromParent();
    this.chainLinks.delete(f);
    if (!g || !f.chain) return;
    const links: { fx: THREE.Object3D; from: number | null; to: number }[] = [];
    const ends: [number | null, number][] = [[null, f.target]];
    let last = f.target;
    for (const t of f.chain.targets) { if (t === last) continue; ends.push([last, t]); last = t; }
    let delay = 0;
    ends.forEach(([from, to], i) => {
      const fx = g.template.clone();
      fx.name = "chain-link";
      this.group.add(fx);
      setVariable(fx, "jumpNumber", i);
      setVariable(fx, "FiringDelay", delay);
      setVariable(fx, "IsFiring", 1);
      links.push({ fx, from, to });
      delay += 0.3 * Math.random();
    });
    this.chainLinks.set(f, links);
  }

  /** Each chain link placed from its source (the turret's muzzle, or the target before) to its target. */
  private placeChains(positionOf: (itemID: number) => THREE.Vector3 | null, renderer: THREE.WebGLRenderer | null, camera: THREE.Camera | null,
    radiusOf?: (itemID: number) => number | null): void {
    for (const [f, links] of this.chainLinks) {
      const g = f.chain ? fxGraphicOf(f.chain.guid) : null;
      if (!g) continue;
      for (const l of links) {
        let to = positionOf(l.to);
        let from = l.from === null ? (f.kind === "ewar" ? null : this.muzzleOf?.(f.shooter, f.moduleID, 0, f.target)) ?? positionOf(f.shooter) : positionOf(l.from);
        if (f.kind === "ewar" && from && to) {
          // LocatorStretchEffect: from the ship's bounds nearest the target (nearestBounds, its box x 1.2: its radius
          // here) to the target's damage locator facing it
          const dir = to.clone().sub(from).normalize();
          from = from.clone().addScaledVector(dir, radiusOf?.(f.shooter) ?? 0);
          to = this.damageLocatorOf?.(l.to, from) ?? to;
        }
        l.fx.visible = !!(to && from);
        if (!to || !from) continue;
        if ((g.data as { type?: string }).type === "EveStretch") placeEveStretch(l.fx, g.data, from, to);
        else placeStretch(l.fx, g.data, from, to);
        if (renderer && camera) for (const part of livePartsOf(l.fx)) offerLights(renderer, camera, part);
      }
    }
  }

  /**
   * A firing whose shot began before its turret's graphic had come (its muzzles not prepared - a miner's next cycle may
   * be a minute off): its muzzles prepared now, to start at once.
   */
  private lateMuzzles(f: Firing, info: TurretInfo, now: number): void {
    if (!f.muzzles.length && (info.firing?.stretches.length ?? 0) > 0) this.prepareFiring(f, info, Math.max(now, f.startedAt));
  }

  /**
   * A firing whose effect is EveStretch3s (the miners, the Vorton projectors): a clone of each stretch's graph per
   * muzzle, started (EveStretch3::StartFiring: FiringDelay, IsFiring 1 to its controllers) once the muzzle's delay is
   * over, its parts placed each frame from the muzzle to the target (EveStretch3::UpdateAsyncronous, placeStretch), its
   * lights offered; gone with the firing (its stop states not played).
   */
  private drawStretch3(f: Firing, from: THREE.Vector3, to: THREE.Vector3, now: number, renderer: THREE.WebGLRenderer | null, camera: THREE.Camera | null): boolean {
    const info = turretInfo(f.moduleTypeID);
    const built = stretch3Of(f.moduleTypeID, info);
    if (!built || !info) return false;
    this.lateMuzzles(f, info, now);
    let fx = this.stretch3.get(f);
    if (!fx) {
      fx = built.map((b) => { const c = b.template.clone(); c.name = "turret-stretch3"; c.visible = false; this.group.add(c); return { fx: c, started: false, startedAt: null }; });
      this.stretch3.set(f, fx);
    }
    fx.forEach((e, i) => {
      const m = f.muzzles[i];
      const b = built[i]!;
      if (m && m.startedAt === null && m.startAt !== null && now >= m.startAt) m.startedAt = now;
      const on = !!m && m.startedAt !== null && (!!info.isLoopFiring || (now - m.startedAt!) / 1000 < info.firingDuration);
      e.fx.visible = on;
      if (!on) return;
      // an EveStretch's shot begun (EveStretch::StartFiring: its play_start / play_loop sets PlayFrom the start, play_end
      // stopped): its curve sets but play_end played from now (startEffect - the clones share their template's
      // animator, so all of them)
      if (b.data.type === "EveStretch" && e.startedAt !== m!.startedAt) {
        startEffect(e.fx, (name) => name === "play_end");
        e.startedAt = m!.startedAt;
      }
      if (!e.started) { e.started = true; setVariable(e.fx, "FiringDelay", 0); setVariable(e.fx, "IsFiring", 1); }
      const at = this.muzzleOf?.(f.shooter, f.moduleID, i, f.target) ?? from;
      if (b.data.type === "EveStretch") placeEveStretch(e.fx, b.data, at, to);
      else placeStretch(e.fx, b.data, at, to);
      if (renderer && camera) for (const part of livePartsOf(e.fx)) offerLights(renderer, camera, part);
    });
    return true;
  }

  /**
   * Where a ship's turret for a module fires from now (its muzzle, turretModel.ts), the shot's number cycling the
   * muzzles; null where the ship draws no turret for it (the ship's centre then).
   */
  muzzleOf: ((shooter: number, moduleID: number, shot: number, target: number) => THREE.Vector3 | null) | null = null;
  /** The damage locator of a target that faces a point (EveLocalPositionBehavior.damageLocator), or null. */
  damageLocatorOf: ((target: number, from: THREE.Vector3) => THREE.Vector3 | null) | null = null;
  /** Each shot begun (EnterStateFiring of the module's turret set): its ship, module and target. */
  onFire: ((shooter: number, moduleID: number, target: number) => void) | null = null;
  /** A firing's sound events, the shooter and the target, and when its effect starts (performance.now ms). */
  onSound: ((sounds: readonly { event: string; time: number; at: "muzzle" | "target" }[], shooter: number, target: number | null, startAt: number) => void) | null = null;
  private shotCount = 0;

  /** One frame: where things are drawn now (by itemID), and the time. */
  update(positionOf: (itemID: number) => THREE.Vector3 | null, now = performance.now(), radiusOf?: (itemID: number) => number | null, camera: THREE.PerspectiveCamera | null = null,
    renderer: THREE.WebGLRenderer | null = null): void {
    for (const [key, f] of this.firings) {
      const from = positionOf(f.shooter), to = positionOf(f.target);
      if (now > f.until || !from || !to) { this.firings.delete(key); continue; }
      // (an EWAR module's stretch: on while it runs - LocatorStretchEffect Start to Stop - no shots, no impacts)
      if (f.kind === "ewar") { if (!this.chainLinks.has(f)) this.shootChain(f); continue; }
      for (let n = 0; now >= f.nextCycle && n < 4; n++) { this.startShot(f, f.nextCycle); f.nextCycle += f.cycle; }
      if (now >= f.nextCycle) f.nextCycle = now + f.cycle;
      for (let i = f.shots.length - 1; i >= 0; i--) {
        const s = f.shots[i]!;
        if (now < s.at) continue;
        f.shots.splice(i, 1);
        const later = s.size === null ? turretInfo(f.moduleTypeID) : null;
        const size = s.size ?? later?.impactSize ?? 0.75, life = s.life ?? (later ? Math.max(later.firingDuration - later.firingPeakTime, 0) : 1);
        if (size > 0) this.onShot?.(f.shooter, f.target, size, life);
      }
      if (f.kind === "laser" || f.kind === "mining" || f.kind === "launcher" || this.stretches.has(f) || this.stretch3.has(f)) continue;
      if (now - f.lastPulse >= PULSE_EVERY_MS) { f.lastPulse = now; this.pulse(f, now); }
    }
    // the turret's own firing effect (its stretches) where it is drawn here; else for a laser one beam while it fires,
    // flickering (a gun's pulses above)
    const firing = new Set(this.firings.values());
    for (const [f, beam] of this.beams) if (!firing.has(f)) { this.group.remove(beam); beam.geometry.dispose(); this.beams.delete(f); }
    for (const [f, fx] of this.stretches) if (!firing.has(f)) { for (const s of fx) s.dispose(); this.stretches.delete(f); }
    for (const [f, fx] of this.stretch3) if (!firing.has(f)) { for (const s of fx) s.fx.removeFromParent(); this.stretch3.delete(f); }
    for (const [f, links] of this.chainLinks) if (!firing.has(f)) { for (const l of links) l.fx.removeFromParent(); this.chainLinks.delete(f); }
    this.placeChains(positionOf, renderer, camera, radiusOf);
    for (const f of this.firings.values()) {
      if (f.kind === "ewar") continue;
      const from = this.muzzleOf?.(f.shooter, f.moduleID, 0, f.target) ?? positionOf(f.shooter)!, to = positionOf(f.target)!;
      if (this.drawStretches(f, from, to, now, radiusOf?.(f.target) ?? null, camera) || this.drawStretch3(f, from, to, now, renderer, camera)) {
        const old = this.beams.get(f);
        if (old) { this.group.remove(old); old.geometry.dispose(); this.beams.delete(f); }
        continue;
      }
      if (f.kind !== "laser") continue;
      let beam = this.beams.get(f);
      if (!beam) {
        beam = this.line(COLOUR.laser, 2.5);
        this.beams.set(f, beam);
        this.group.add(beam);
      }
      beam.geometry.setPositions([from.x, from.y, from.z, to.x, to.y, to.z]);
      beam.material.opacity = 0.65 + 0.35 * Math.sin(now / 37);
    }
    // explosions: a bloom of light where the ball was, swelling and fading over two seconds
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i]!;
      const here = positionOf(b.itemID);
      if (here) b.at = here.clone();
      const t = (now - b.bornAt) / 2000;
      if (t > 1 || (!b.at && t > 0.5)) { this.group.remove(b.sprite); (b.sprite.material as THREE.Material).dispose(); this.blasts.splice(i, 1); continue; }
      if (!b.at) continue;
      if (!b.size) b.size = Math.max(60, (radiusOf?.(b.itemID) ?? 40) * 6);
      b.sprite.visible = true;
      b.sprite.position.copy(b.at);
      b.sprite.scale.setScalar(b.size * (0.4 + 1.2 * Math.sqrt(t)));
      (b.sprite.material as THREE.SpriteMaterial).opacity = 1 - t;
    }
    // gun pulses: a short bright streak travelling to the target, a flash as it lands
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i]!;
      const from = p.from ?? positionOf(p.firing.shooter), to = positionOf(p.firing.target);
      const t = (now - p.bornAt) / FLIGHT_MS;
      if (!from || !to || t > 1.6) { this.drop(i); continue; }
      const way = to.clone().sub(from);
      const head = from.clone().addScaledVector(way, Math.min(1, t));
      const tail = from.clone().addScaledVector(way, Math.max(0, Math.min(1, t) - 0.12));
      p.mesh.geometry.setPositions([tail.x, tail.y, tail.z, head.x, head.y, head.z]);
      p.mesh.visible = t <= 1;
      p.flash.visible = t >= 1;
      if (t >= 1) {
        p.flash.position.copy(to);
        const s = Math.max(8, way.length() * 0.02) * (1.6 - t) * 2.5;
        p.flash.scale.setScalar(s);
        (p.flash.material as THREE.SpriteMaterial).opacity = Math.max(0, (1.6 - t) / 0.6);
      }
    }
  }

  private pulse(f: Firing, now: number): void {
    const mesh = this.line(COLOUR[f.kind], 3);
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flash(), color: COLOUR[f.kind], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flash.visible = false;
    this.group.add(mesh, flash);
    // the shot leaves its turret's muzzle (where the ship draws the turret), held there as it flies
    const muzzle = this.muzzleOf?.(f.shooter, f.moduleID, this.shotCount++, f.target) ?? null;
    this.pulses.push({ firing: f, bornAt: now, mesh, flash, from: muzzle });
  }

  private drop(i: number): void {
    const p = this.pulses[i]!;
    this.group.remove(p.mesh, p.flash);
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
    (p.flash.material as THREE.Material).dispose();
    this.pulses.splice(i, 1);
  }

  private flash(): THREE.Texture {
    if (this.flashTexture) return this.flashTexture;
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(0.3, "rgba(255,255,255,0.5)"); grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.flashTexture = new THREE.CanvasTexture(c);
    return this.flashTexture;
  }

  /** How many firings are under way (for checks). */
  get active(): number { return this.firings.size; }

  dispose(): void {
    for (let i = this.pulses.length - 1; i >= 0; i--) this.drop(i);
    for (const beam of this.beams.values()) { beam.geometry.dispose(); beam.material.dispose(); }
    for (const fx of this.stretches.values()) for (const s of fx) s.dispose();
    for (const b of this.blasts) (b.sprite.material as THREE.Material).dispose();
    this.flashTexture?.dispose();
  }
}
