// Missiles in flight, as the client draws them: spaceObject.Missile (eve/client/script/environment/spaceObject/
// missile.py) loads the missile's model (an EveMissile, eveSpaceObject/missile.py MissileGraphics) and starts it; Trinity's
// EveMissile and EveMissileWarhead (carbonengine/trinity Eve/SpaceObject/EveMissile.cpp, EveMissileWarhead.cpp) fly
// each warhead on its own semi-smart path from the launch to a damage locator of the target, while the missile's ball
// (the server's, in the park) only says where the missile is and how fast it goes. A warhead is drawn as missile.fx
// draws it (a capsule ray-cast in a box), with its sprite lights (lights.fx) and its trail's GPU emitters; on reaching
// the target it makes the target's impact (CreateImpact: a shield ripple, an armor hole) and is gone.
//
// Not yet: the impact effect file (the explosion, the type's graphicFile), the launcher turrets' firing bones and
// delays (a warhead starts at the ball, as the client's does where the source ship has no turret set for the module),
// the camera shake and the target's torque.

import * as THREE from "three";
import { GpuEmitter, gpuSystemOf, setGpuParticleAssets, type GpuEmitterData } from "../three/gpuParticles.ts";
import { loadDds } from "../three/ddsTexture.ts";
import { logDepth } from "../three/logDepth.ts";
import { perlinNoise1D } from "../three/curves.ts";
import type { ImpactOverlay } from "../three/impactOverlay.ts";

/** A warhead as the extractor reads it (tools/client-extract/lib/missile.mjs). */
interface WarheadData {
  warheadLength: number; warheadRadius: number; impactDuration: number; impactSize: number; durationEjectPhase: number;
  startEjectVelocity: number; acceleration: number; maxExplosionDistance: number; pathOffsetNoiseScale: number; pathOffsetNoiseSpeed: number;
  sprites: { position: number[]; blinkRate: number; blinkPhase: number; minScale: number; maxScale: number; falloff: number; color: number[] }[];
  spriteTextures: Record<string, string | null>;
  emitters: GpuEmitterData[];
  mesh: { geometry: string | null; effect: string | null; textures: Record<string, string | null> } | null;
}
export interface MissileInfo {
  typeID: number; missileFile: string | null; impactFile: string | null;
  model: { name: string | null; warheads: WarheadData[] } | null;
  gpuParticles?: { atlas?: string | null; noise?: string | null };
}

const infos = new Map<number, Promise<MissileInfo | null>>();
function missileInfo(typeID: number): Promise<MissileInfo | null> {
  if (!infos.has(typeID)) infos.set(typeID, fetch(`/client-assets/missile/${typeID}`).then((r) => r.json() as Promise<MissileInfo>).catch(() => null));
  return infos.get(typeID)!;
}

const enum State { DELAYED, LAUNCH, EJECTING, START_TRACKING, TRACKING_SPREAD, TRACKING_FINAL, EXPLODED, DEAD }
const enum Evt { SWITCH_TARGET, EXPLODE, NONE }

/** What the warheads aim at: its centre, radius and impact overlay (damage locators, shape) where its model has one. */
export interface MissileTarget { position: THREE.Vector3; radius: number; impact: ImpactOverlay | null }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const v3 = (a: number[] | undefined) => new THREE.Vector3(a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0);

/** One warhead (EveMissileWarhead): its state, its offsets in its missile ball's space, its drawn object and emitters. */
class Warhead {
  state = State.DELAYED;
  flyingTime = 0;
  // PrepareLaunch
  currentEjectVelocity: number;
  currentDurationEjectPhase: number;
  explosionDistance: number;
  startOffset = new THREE.Vector3();
  startOrientation = new THREE.Quaternion();
  startDataValid = false;
  oldEndOffset = new THREE.Vector3();
  currentEndOffset = new THREE.Vector3();
  endOffset = new THREE.Vector3();
  currentOffset = new THREE.Vector3();
  currentOrientation = new THREE.Quaternion();
  finalDestinationTimer = 0;
  finalTargetTime = 0.75 - Math.random() * 0.1;
  speedModifier = 1.04 - Math.random() * 0.08;
  targetLocator = -1;
  explosionPosition = new THREE.Vector3();
  offsetTransform = new THREE.Matrix4();
  pathOffset = new THREE.Vector3();
  movement = new THREE.Vector3();
  posLastFrame = new THREE.Vector3();
  lastRelativePosition = new THREE.Vector3();
  lastPositionValid = false;
  bombFlightpath = false;
  /** EveMissileWarhead::Update's noise seed (the client's: its own address & 0xfff). */
  readonly noiseSeed = Math.floor(Math.random() * 4096);
  readonly world = new THREE.Matrix4();
  readonly emitters: GpuEmitter[];

  constructor(readonly d: WarheadData, readonly id: number, readonly doSpread: boolean, readonly object: THREE.Object3D) {
    this.currentEjectVelocity = d.startEjectVelocity;
    this.currentDurationEjectPhase = d.durationEjectPhase;
    const e = d.maxExplosionDistance - Math.random() * d.maxExplosionDistance / 2;
    this.explosionDistance = e * e;
    this.emitters = d.emitters.map((x) => new GpuEmitter(x));
  }

  /** Launch: the start transform in the ball's space (identity where no turret gives one). */
  launch(start: THREE.Matrix4): void {
    start.decompose(this.startOffset, this.startOrientation, new THREE.Vector3());
    this.currentOrientation.copy(this.startOrientation);
    this.currentOffset.copy(this.startOffset);
    this.startDataValid = true;
    this.lastPositionValid = false;
  }

  worldPosition(): THREE.Vector3 { return new THREE.Vector3().setFromMatrixPosition(this.world); }

  /** UpdateState (EveMissileWarhead.cpp:355-418). */
  updateState(dt: number, aliveTime: number, target: MissileTarget | null): Evt {
    this.bombFlightpath = !target;
    let evt = Evt.NONE;
    const flight01 = clamp01(this.flyingTime / ((aliveTime + 0.1) * this.speedModifier));
    switch (this.state) {
      case State.DELAYED: if (this.startDataValid) this.state = State.LAUNCH; break;
      case State.LAUNCH: this.state = State.EJECTING; break;
      case State.EJECTING:
        this.currentDurationEjectPhase -= dt;
        if (this.currentDurationEjectPhase <= 0) { this.currentDurationEjectPhase = 0; this.state = State.START_TRACKING; }
        break;
      case State.START_TRACKING:
        this.targetLocator = target?.impact ? target.impact.goodLocatorIndex(this.worldPosition()) : -1;
        this.state = aliveTime >= 5 && this.doSpread ? State.TRACKING_SPREAD : State.TRACKING_FINAL;
        break;
      case State.TRACKING_SPREAD:
        if (flight01 >= this.finalTargetTime) {
          this.targetLocator = target?.impact ? target.impact.goodLocatorIndex(this.worldPosition()) : -1;
          evt = Evt.SWITCH_TARGET;
          this.state = State.TRACKING_FINAL;
        }
        break;
      case State.EXPLODED: this.state = State.DEAD; break;
      default: break;
    }
    return evt;
  }

  /** UpdateEndTransform (:329-342). */
  updateEnd(endOffset: THREE.Vector3, switchLocators: boolean): void {
    this.endOffset.copy(endOffset);
    if (switchLocators) { this.finalDestinationTimer = this.flyingTime; this.oldEndOffset.copy(this.currentEndOffset); }
  }

  /**
   * UpdateWarhead (:495-595): the offset in the ball's space lerped from the (ejecting, inherited-velocity-carried,
   * ball-velocity-countered) start to the target's locator by flight^(1 + acceleration), the noise path added (strongest
   * mid-flight); its facing the way it moved (slerped in where the move was under a metre). All in three's space, `ball`
   * the missile ball's transform, `shift` the world's move under the view this frame.
   */
  updateWarhead(dt: number, aliveTime: number, ballVelocity: THREE.Vector3, inheritedVelocity: THREE.Vector3, invBallRotation: THREE.Quaternion, ball: THREE.Matrix4, shift: THREE.Vector3): void {
    const ejectDir = new THREE.Vector3(0, 0, this.currentEjectVelocity).applyQuaternion(this.startOrientation);
    let globalBallVelocity = ballVelocity.clone().applyQuaternion(invBallRotation);
    if (this.state >= State.START_TRACKING) this.flyingTime += dt;
    const totalFlying = (aliveTime + 0.1) * this.speedModifier;
    const flight01 = clamp01(this.flyingTime / totalFlying);
    const quick01 = clamp01(3 * flight01);
    if (this.state >= State.EJECTING) this.startOffset.addScaledVector(ejectDir, dt);
    this.startOffset.addScaledVector(inheritedVelocity, dt);
    const t = clamp01((this.flyingTime - this.finalDestinationTimer) / (totalFlying - this.finalDestinationTimer));
    const modifiedOld = this.oldEndOffset.clone().multiplyScalar(1 - clamp01(t * 2));
    this.currentEndOffset.lerpVectors(modifiedOld, this.endOffset, t);
    this.currentOffset.lerpVectors(this.startOffset, this.currentEndOffset, Math.pow(flight01, 1 + this.d.acceleration));
    globalBallVelocity = globalBallVelocity.lerp(new THREE.Vector3(), flight01);
    this.startOffset.addScaledVector(globalBallVelocity, -dt);
    this.currentEjectVelocity = THREE.MathUtils.lerp(this.d.startEjectVelocity, 0, Math.pow(quick01, 1 + this.d.acceleration));
    this.currentOffset.addScaledVector(this.pathOffset, Math.sin(Math.PI * flight01) ** 2);
    if (this.bombFlightpath) this.currentOffset.multiplyScalar((1 - quick01) ** 2);
    const relative = this.currentOffset.clone().applyMatrix4(ball);
    // the way back along the move (the last place less this one, the world's shift taken out)
    const back = this.lastRelativePosition.clone().sub(relative).add(shift);
    this.lastRelativePosition.copy(relative);
    if (this.lastPositionValid) {
      const distSq = back.lengthSq();
      if (this.startDataValid && distSq > 0) {
        // TriQuaternionArcFromForward: the warhead's -z along the way back (its nose, +z, along its move)
        const now = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), back.applyQuaternion(invBallRotation).normalize());
        if (distSq < 1) this.currentOrientation.slerp(now, distSq).normalize();
        else this.currentOrientation.copy(now);
      }
    } else this.lastPositionValid = true;
    this.offsetTransform.compose(this.currentOffset, this.currentOrientation, new THREE.Vector3(1, 1, 1));
  }

  /** Update (:470-481): the noise path's offset for the next frame, the world transform, and how far it moved. */
  update(ball: THREE.Matrix4, shift: THREE.Vector3): void {
    const pos = this.flyingTime * this.d.pathOffsetNoiseSpeed + this.noiseSeed;
    const s = this.d.pathOffsetNoiseScale;
    this.pathOffset.set(perlinNoise1D(pos, 1.1, 2, 3) * s, perlinNoise1D(pos + 10.1, 1.1, 2, 3) * s, perlinNoise1D(pos + 18.3, 1.1, 2, 3) * s);
    this.posLastFrame.add(shift);
    this.world.multiplyMatrices(ball, this.offsetTransform);
    const now = this.worldPosition();
    this.movement.subVectors(now, this.posLastFrame);
    this.posLastFrame.copy(now);
  }

  /** CheckImpact (:420-464): at the end of the flight or at the target's impact position, the explosion. */
  checkImpact(dt: number, aliveTime: number, target: MissileTarget | null): Evt {
    if (this.state !== State.TRACKING_FINAL || this.id < 0) return Evt.NONE;
    const flight01 = clamp01((this.flyingTime - dt) / ((aliveTime + 0.1) * this.speedModifier));
    const now = this.worldPosition();
    if (!target) { this.explosionPosition.copy(now); this.state = State.EXPLODED; return Evt.EXPLODE; }
    const last = now.clone().sub(this.movement);
    const hit = target.impact ? target.impact.impactPosition(this.targetLocator, last, now, this.explosionDistance)
      : now.distanceToSquared(target.position) < Math.max(this.explosionDistance, target.radius * target.radius) ? target.position.clone() : null;
    if (flight01 >= 1 || hit) {
      const at = hit ?? now;
      this.explosionPosition.copy(now);
      this.state = State.EXPLODED;
      if (at.clone().sub(now).dot(this.movement) < 0) this.explosionPosition.copy(at);
      if (this.d.impactSize > 0) target.impact?.createImpact(this.targetLocator, this.d.impactSize, this.movement.clone().negate(), this.d.impactDuration);
      return Evt.EXPLODE;
    }
    return Evt.NONE;
  }
}

/** One missile (EveMissile, with missile.py's Missile around it): its ball's state and its warheads. */
class Missile {
  readonly group = new THREE.Group();
  warheads: Warhead[] = [];
  time = 0;
  aliveTime = 1;
  lastValidSpeed = 0;
  readonly inheritedVelocity = new THREE.Vector3();
  readonly ballPos = new THREE.Vector3();
  readonly ballRot = new THREE.Quaternion();
  readonly ballVel = new THREE.Vector3();
  /** missile.py DoCollision: the ball has hit (or gone): the missile flies on from where it was, its ball still. */
  collided = false;
  /** The system frame's place the ball was last at (for a ball gone from the park). */
  frozen: { x: number; y: number; z: number } | null = null;
  started = false;
  released = 0;
  readonly bornAt = performance.now();
  constructor(readonly itemID: number, readonly typeID: number, readonly targetID: number | null, readonly sourceShipID: number | null, readonly launchModules: number) {}
  get done(): boolean { return this.started && this.warheads.every((w) => w.state === State.DEAD); }
}

/** What the space view tells the missiles each frame. */
export interface MissileFrame {
  /** The missile balls in the park: id, type, place and velocity (three's space, the view's origin), max speed. */
  balls: { itemID: number; typeID: number; position: THREE.Vector3; velocity: THREE.Vector3; maxVelocity: number; targetID: number | null; sourceShipID: number | null; launchModules: number;
    /** Destiny's collision of the ball with its target this tick (the client's DoCollision). */
    collided: boolean }[];
  /** The view's origin (the ship's place, the system's frame): a ball gone is kept still where it was. */
  origin: { x: number; y: number; z: number };
  /** A thing's centre, radius and impact overlay by its id (the target, the source ship). */
  target: (itemID: number) => MissileTarget | null;
  velocityOf: (itemID: number) => THREE.Vector3 | null;
  /** The world's move under the view this frame (three's space). */
  shift: THREE.Vector3;
  dt: number;
  scene: THREE.Object3D;
  /** The direction to the sun (three's space): missile.fx's light. */
  sun: THREE.Vector3;
  aspect: number;
}

const textures = new Map<string, Promise<THREE.Texture | null>>();
function tex(url: string | null | undefined, wrap: THREE.Wrapping = THREE.RepeatWrapping): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  if (!textures.has(url)) textures.set(url, loadDds(url).then((t) => { t.wrapS = t.wrapT = wrap; t.needsUpdate = true; return t as THREE.Texture; }).catch(() => null));
  return textures.get(url)!;
}

/** The time the sprites blink by (lights.fx's time constant), seconds. */
const clock = { value: 0 };
const sunDir = { value: new THREE.Vector3(0, 1, 0) };
const aspect = { value: 1 };

/**
 * missile.fx (its compiled vs/ps): the unit cube made a box of radius x radius x length from the warhead's origin
 * forward; each pixel casts the eye's ray at a cylinder of half that radius along the warhead's z from its back to its
 * front, its nose rounded (a sphere of the radius at length/2 - radius from the centre), cut at its back; the texture
 * wrapped around it (u its length, v the angle about the axis) lit by N.L + 0.15 of the sun. Opaque.
 */
function missileMaterial(d: WarheadData, map: THREE.Texture | null): THREE.ShaderMaterial {
  return logDepth(new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, size: { value: new THREE.Vector2(d.warheadRadius, d.warheadLength) }, sun: sunDir },
    vertexShader: `uniform vec2 size;
      varying vec3 vWorld; varying vec3 vCentre; varying vec3 vZ; varying vec3 vY; varying vec3 vX;
      void main() {
        vec3 p = vec3(size.x * position.x, size.x * position.y, size.y * position.z + size.y * 0.5);
        vec4 w = modelMatrix * vec4(p, 1.0);
        vWorld = w.xyz;
        vCentre = (modelMatrix * vec4(0.0, 0.0, size.y * 0.5, 1.0)).xyz;
        vZ = mat3(modelMatrix) * vec3(0.0, 0.0, 1.0); vY = mat3(modelMatrix) * vec3(0.0, 1.0, 0.0); vX = mat3(modelMatrix) * vec3(1.0, 0.0, 0.0);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `uniform sampler2D map; uniform vec2 size; uniform vec3 sun;
      varying vec3 vWorld; varying vec3 vCentre; varying vec3 vZ; varying vec3 vY; varying vec3 vX;
      void main() {
        float R = size.x * 0.5, H = size.y * 0.5;
        vec3 a = normalize(vZ);
        vec3 d = normalize(vWorld - cameraPosition);
        vec3 ro = vWorld - d * H;
        vec3 dp = d - dot(d, a) * a;
        vec3 oc = ro - vCentre; vec3 op = oc - dot(oc, a) * a;
        float A = dot(dp, dp);
        float b = dot(dp, op) / A, c = (dot(op, op) - R * R) / A;
        float disc = b * b - c;
        if (disc < 0.0) discard;
        vec3 p = ro + (-sqrt(disc) - b) * d;
        vec3 front = vCentre + (H - R) * a;
        vec3 of = ro - front; float bs = dot(d, of);
        if (bs * bs - dot(of, of) + R * R < 0.0 && dot(a, p - front) > 0.0) discard;
        vec3 pb = p - (vCentre - H * a);
        float along = dot(a, pb);
        if (along < 0.0) discard;
        float ang = atan(dot(pb, normalize(vY)), dot(pb, normalize(vX)));
        vec3 colour = texture2D(map, vec2(clamp(along / size.y, 0.0, 1.0), (ang + 3.14159265) * 0.15915494)).rgb;
        vec3 n = normalize(pb - along * a);
        gl_FragColor = vec4(colour * (clamp(dot(n, sun), 0.0, 1.0) + 0.15), 1.0);
      }`,
  }));
}

/**
 * lights.fx (its compiled vs/ps; the vertex EveSpriteSet's PoolVertex): each sprite a card on the screen, its size
 * minScale..maxScale by the noise map's red at (blinkRate x time) (its second mip plus half its first, x 2/3), over
 * 1 + |view z| / falloff, in the screen's width (its height that x width/height x the item's blinkPhase: a streak where
 * it is small); the texture times the colour, added.
 */
function spriteMesh(d: WarheadData, map: THREE.Texture | null, noise: THREE.Texture | null): THREE.Mesh | null {
  const n = d.sprites.length;
  if (!n) return null;
  const pos: number[] = [], corner: number[] = [], p0: number[] = [], p1: number[] = [], col: number[] = [], index: number[] = [];
  const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  d.sprites.forEach((s, i) => {
    for (const c of CORNERS) {
      pos.push(s.position[0] ?? 0, s.position[1] ?? 0, s.position[2] ?? 0);
      corner.push(c[0]!, c[1]!);
      p0.push(s.blinkPhase, s.blinkRate, s.minScale, s.maxScale);
      p1.push(s.falloff || 1, 0);
      col.push(...[0, 1, 2, 3].map((k) => s.color[k] ?? 1));
    }
    index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("corner", new THREE.Float32BufferAttribute(corner, 2));
  g.setAttribute("p0", new THREE.Float32BufferAttribute(p0, 4));
  g.setAttribute("p1", new THREE.Float32BufferAttribute(p1, 2));
  g.setAttribute("col", new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(index);
  const m = logDepth(new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, noise: { value: noise }, time: clock, aspect },
    vertexShader: `uniform sampler2D noise; uniform float time; uniform float aspect;
      attribute vec2 corner; attribute vec4 p0; attribute vec2 p1; attribute vec4 col;
      varying vec4 vCol; varying vec2 vUv;
      void main() {
        float u = p0.y * time;
        float nz = (textureLod(noise, vec2(u, 0.0), 1.0).r + 0.5 * textureLod(noise, vec2(u, 1.0), 0.0).r) * 0.666667;
        float s = mix(p0.z, p0.w, nz);
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        s /= abs(view.z) / p1.x + 1.0;
        vec4 clip = projectionMatrix * view;
        clip.xy += vec2(corner.x * s, corner.y * s * p0.x * aspect) * clip.w;
        gl_Position = clip;
        vCol = col; vUv = corner + 0.5;
      }`,
    fragmentShader: `uniform sampler2D map; varying vec4 vCol; varying vec2 vUv;
      void main() { gl_FragColor = texture2D(map, vUv) * vCol; }`,
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  }));
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}

/** A warhead's drawn object (the capsule and its lights), its parts made once per missile type and shared. */
const warheadParts = new Map<string, Promise<{ mesh: THREE.Mesh | null; sprites: THREE.Mesh | null }>>();
async function warheadObject(typeID: number, i: number, d: WarheadData): Promise<THREE.Object3D> {
  const key = `${typeID}:${i}`;
  if (!warheadParts.has(key)) warheadParts.set(key, (async () => {
    const [map, sprite, noise] = await Promise.all([tex(d.mesh?.textures.DiffuseMap), tex(d.spriteTextures.DiffuseMap, THREE.ClampToEdgeWrapping), tex(d.spriteTextures.NoiseMap)]);
    const mesh = d.mesh?.effect === "missile" ? new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), missileMaterial(d, map)) : null;
    if (mesh) mesh.frustumCulled = false;
    return { mesh, sprites: spriteMesh(d, sprite, noise) };
  })());
  const parts = await warheadParts.get(key)!;
  const o = new THREE.Group();
  o.matrixAutoUpdate = false;
  if (parts.mesh) o.add(parts.mesh.clone());
  if (parts.sprites) o.add(parts.sprites.clone());
  return o;
}

export class MissileFx {
  readonly group = new THREE.Group();
  private readonly missiles = new Map<number, Missile>();
  /** Balls whose missile is over (its warheads exploded) while the ball is still in the park: not made again. */
  private readonly finished = new Set<number>();
  /** How many warheads have exploded (for checks). */
  exploded = 0;
  /** Each explosion: the missile's type and impact file, where (three's space) - the impact effect's hook. */
  onExplode: ((typeID: number, impactFile: string | null, at: THREE.Vector3, targetID: number | null) => void) | null = null;

  constructor() { this.group.name = "missiles"; }

  get active(): number { return this.missiles.size; }

  update(f: MissileFrame): void {
    clock.value = performance.now() / 1000;
    sunDir.value.copy(f.sun).normalize();
    aspect.value = f.aspect;
    const seen = new Set<number>();
    for (const b of f.balls) {
      seen.add(b.itemID);
      if (this.finished.has(b.itemID)) continue;
      let m = this.missiles.get(b.itemID);
      if (!m) {
        m = new Missile(b.itemID, b.typeID, b.targetID, b.sourceShipID, b.launchModules);
        this.missiles.set(b.itemID, m);
        this.group.add(m.group);
        void this.load(m, f);
      }
      (m as { maxVelocity?: number }).maxVelocity = b.maxVelocity;
      // a collided missile's ball is a still client ball where it collided (missile.py _DoCollision)
      if (m.collided) continue;
      if (b.collided) m.collided = true;
      m.ballPos.copy(b.position);
      m.ballVel.copy(b.velocity);
      m.frozen = { x: b.position.x + f.origin.x, y: b.position.y + f.origin.y, z: -b.position.z + f.origin.z };
      if (b.velocity.lengthSq() > 1e-6) m.ballRot.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.velocity.clone().normalize());
    }
    for (const [id, m] of this.missiles) {
      // the ball gone without a collision (missile.py Release: not collided -> Expire, ReleaseAll): the missile goes with
      // it, no explosion; a collided one flies on from where it collided until its warheads are done
      if (!seen.has(id) && !m.collided) { this.drop(id); continue; }
      if (m.collided) {
        if (m.frozen) m.ballPos.set(m.frozen.x - f.origin.x, m.frozen.y - f.origin.y, -(m.frozen.z - f.origin.z));
        m.ballVel.set(0, 0, 0);
        if (!m.started && !seen.has(id) && performance.now() - m.bornAt > 3000) { this.drop(id); continue; }
      }
      if (m.started) this.step(m, f);
      if ((m.done && m.started) || performance.now() - m.bornAt > 120_000) {
        this.drop(id);
        if (seen.has(id)) this.finished.add(id);
      }
    }
    for (const id of this.finished) if (!seen.has(id)) this.finished.delete(id);
  }

  private drop(id: number): void {
    const m = this.missiles.get(id);
    if (!m) return;
    this.group.remove(m.group);
    this.missiles.delete(id);
  }

  /** LoadModel and Prepare (missile.py): the model, the time to the target, the warheads made and launched. */
  private async load(m: Missile, f: MissileFrame): Promise<void> {
    const info = await missileInfo(m.typeID);
    const model = info?.model;
    if (!model || model.warheads.length !== 1 || !this.missiles.has(m.itemID)) return;
    setGpuParticleAssets(info.gpuParticles);
    const d = model.warheads[0]!;
    // _GetTimeToTarget: to the target's surface and to its centre at the ball's top speed; no spread under 1.6 s (and
    // then the missile is taken as collided at once)
    const target = m.targetID !== null ? f.target(m.targetID) : null;
    const maxV = (m as { maxVelocity?: number }).maxVelocity || m.ballVel.length() || 1;
    const est = (toCentre: boolean) => (target ? (m.ballPos.distanceTo(target.position) - (toCentre ? 0 : target.radius)) / maxV : 5);
    let timeToTarget = est(false);
    const doSpread = timeToTarget >= 1.6;
    if (!doSpread) m.collided = true;
    const toCentre = Math.max(0.5, est(true));
    timeToTarget = timeToTarget > 0 ? (timeToTarget + toCentre) * 0.5 : toCentre * 0.5;
    // Start: a warhead for each launcher (one each without a turret set), each launched at once (no firing delay)
    const count = Math.max(m.launchModules, 1);
    for (let i = 0; i < count; i++) {
      const object = await warheadObject(m.typeID, 0, d);
      const w = new Warhead(d, i, doSpread, object);
      m.group.add(object);
      object.visible = false;
      m.warheads.push(w);
    }
    // _GetMissileStartSpeed: the source ship's velocity in the ball's space
    const srcVel = m.sourceShipID !== null ? f.velocityOf(m.sourceShipID) : null;
    if (srcVel) m.inheritedVelocity.copy(srcVel).applyQuaternion(m.ballRot.clone().invert());
    m.aliveTime = timeToTarget;
    m.time = 0;
    m.lastValidSpeed = 0;
    for (const w of m.warheads) w.launch(new THREE.Matrix4());
    m.started = true;
  }

  /** EveMissile::UpdateSyncronous (EveMissile.cpp:120-207). */
  private step(m: Missile, f: MissileFrame): void {
    const dt = f.dt;
    const inv = m.ballRot.clone().invert();
    m.time += dt;
    const target = m.targetID !== null ? f.target(m.targetID) : null;
    const myVel = m.ballVel.clone();
    if (target) {
      const speed = myVel.length();
      if (speed > 0) {
        m.aliveTime = m.time + (m.ballPos.distanceTo(target.position) - target.radius) / speed;
        m.lastValidSpeed = speed;
      } else if (m.lastValidSpeed > 0) {
        myVel.subVectors(m.ballPos, target.position).normalize().multiplyScalar(m.lastValidSpeed);
      }
    }
    const ball = new THREE.Matrix4().compose(m.ballPos, m.ballRot, new THREE.Vector3(1, 1, 1));
    const system = gpuSystemOf(f.scene);
    const now = performance.now() / 1000;
    for (const w of m.warheads) {
      const evt = w.updateState(dt, m.aliveTime, target);
      if (w.state !== State.DEAD) {
        const locator = target ? (target.impact?.locatorPosition(w.targetLocator) ?? target.position.clone()) : m.ballPos.clone();
        w.updateEnd(locator.sub(m.ballPos).applyQuaternion(inv), evt === Evt.SWITCH_TARGET);
        w.updateWarhead(dt, m.aliveTime, myVel, m.inheritedVelocity, inv, ball, f.shift);
        w.update(ball, f.shift);
        w.object.matrix.copy(w.world);
        w.object.matrixWorldNeedsUpdate = true;
        w.object.visible = w.startDataValid;
        // EnableParticleEmitting(true) from the launch on: the trail from where the warhead is
        if (w.state >= State.EJECTING) for (const e of w.emitters) e.update(now, w.world, system);
      }
      if (w.checkImpact(dt, m.aliveTime, target) === Evt.EXPLODE) {
        this.exploded++;
        w.object.visible = false;
        this.onExplode?.(m.typeID, null, w.explosionPosition.clone(), m.targetID);
      }
      if (w.state === State.EXPLODED || w.state === State.DEAD) w.object.visible = false;
    }
  }

  /** For checks: each missile's warheads' states and places. */
  debug(): { itemID: number; typeID: number; collided: boolean; aliveTime: number; warheads: { state: number; flyingTime: number; at: number[]; locator: number }[] }[] {
    return [...this.missiles.values()].map((m) => ({
      itemID: m.itemID, typeID: m.typeID, collided: m.collided, aliveTime: m.aliveTime,
      warheads: m.warheads.map((w) => ({ state: w.state, flyingTime: w.flyingTime, at: w.worldPosition().toArray(), locator: w.targetLocator })),
    }));
  }
}
