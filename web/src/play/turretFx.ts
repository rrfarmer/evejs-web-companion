// Weapons fire, drawn from the server's own word of it: michelle.OnSpecialFX(shipID, moduleID, moduleTypeID,
// targetID, otherTypeID, guid, isOffensive, start, active, duration, repeat, ...), the effect a turret plays as it
// cycles (effects.ProjectileFired, effects.HybridFired, effects.Laser...: start 1 as it begins, start 0 as it stops).
// Our own drawing of it (the client plays each weapon's effect file): tracer pulses from the shooter to its target for
// guns, a flickering beam for lasers, and a flash where the shots land.

import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

interface Firing {
  shooter: number; target: number; moduleID: number; moduleTypeID: number; kind: "projectile" | "hybrid" | "laser"; startedAt: number; until: number; lastPulse: number;
  /** One shot a cycle: its length (ms) and when the next begins; whether the turret was idle (its first shot waits to track). */
  cycle: number; nextCycle: number; idle: boolean;
  /** The turret's miss queue (EveTurretTarget: the last four told, popped by each shot; empty a hit). */
  misses: boolean[];
  /** Shots begun whose impact is still to come: when, and its size and life (null: read when it lands, the turret's graphic not come when it began). */
  shots: { at: number; size: number | null; life: number | null }[];
}
/** A turret module's graphic as the extractor reads it (lib/turret.mjs; GET /client-assets/turret/<typeID>). */
export interface TurretInfo { impactSize: number; useRandomFiringDelay: boolean; maxTrackingTime: number; firingPeakTime: number; firingDuration: number }
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
};
const COLOUR: Record<Firing["kind"], number> = { projectile: 0xffc36a, hybrid: 0x8ff0ff, laser: 0xff5a3c };
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
    const kind = KIND[fxGuid(args[5])];
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
    this.firings.set(key, {
      shooter, target, moduleID, moduleTypeID, kind, startedAt: now, until: Math.min(until, now + 10 * 60_000), lastPulse: 0,
      cycle, nextCycle: now, idle: !was, misses: was && was.target === target ? was.misses : [], shots: was?.shots ?? [],
    });
  }

  /** EnterStateFiring and StartFireAtLocator for one shot begun at `at` (ms). */
  private startShot(f: Firing, at: number): void {
    this.onFire?.(f.shooter, f.moduleID, f.target);
    const info = turretInfo(f.moduleTypeID);
    // until the turret's graphic has come: a medium gun's size, no peak, a second's firing
    const peak = info?.firingPeakTime ?? 0, total = info?.firingDuration ?? 1, size = info?.impactSize ?? 0.75;
    let delay = (info?.useRandomFiringDelay ?? true) ? RANDOM_DELAY_MAX * Math.random() : 0;
    if (f.idle) { delay += info?.maxTrackingTime ?? 1; f.idle = false; }
    delay += peak;
    const missed = f.misses.shift() ?? false;
    if (!missed && size > 0) f.shots.push({ at: at + delay * 1000, size: info ? size : null, life: info ? Math.max(total - peak, 0) : null });
  }

  /**
   * Where a ship's turret for a module fires from now (its muzzle, turretModel.ts), the shot's number cycling the
   * muzzles; null where the ship draws no turret for it (the ship's centre then).
   */
  muzzleOf: ((shooter: number, moduleID: number, shot: number, target: number) => THREE.Vector3 | null) | null = null;
  /** Each shot begun (EnterStateFiring of the module's turret set): its ship, module and target. */
  onFire: ((shooter: number, moduleID: number, target: number) => void) | null = null;
  private shotCount = 0;

  /** One frame: where things are drawn now (by itemID), and the time. */
  update(positionOf: (itemID: number) => THREE.Vector3 | null, now = performance.now(), radiusOf?: (itemID: number) => number | null): void {
    for (const [key, f] of this.firings) {
      const from = positionOf(f.shooter), to = positionOf(f.target);
      if (now > f.until || !from || !to) { this.firings.delete(key); continue; }
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
      if (f.kind === "laser") continue;
      if (now - f.lastPulse >= PULSE_EVERY_MS) { f.lastPulse = now; this.pulse(f, now); }
    }
    // lasers: one beam each while it fires, flickering
    for (const [f, beam] of this.beams) if (![...this.firings.values()].includes(f)) { this.group.remove(beam); beam.geometry.dispose(); this.beams.delete(f); }
    for (const f of this.firings.values()) {
      if (f.kind !== "laser") continue;
      const from = this.muzzleOf?.(f.shooter, f.moduleID, 0, f.target) ?? positionOf(f.shooter)!, to = positionOf(f.target)!;
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
    for (const b of this.blasts) (b.sprite.material as THREE.Material).dispose();
    this.flashTexture?.dispose();
  }
}
