// EveChildBehaviorSystem (Children/EveChildBehaviorSystem.cpp, Behaviors/BehaviorGroup.cpp and the behaviours): groups
// of agents, each drawn as the group's mesh (quadinstancedv5: the hull shader per instance), here one InstancedMesh per
// part of it, run per model clone (AgentRun, from the hull children's ticker).
//
// Each update (BehaviorGroup::UpdateAgents, dt clamped to [0, 0.1]): the behaviours in priority order
// (IBehavior::ProcessPriority, then the file's order) add to each agent's acceleration, each seeing the agents within
// its search radius + 2 x the group's bounding sphere x scale (EveKDdroneManagementTree::FindDronesInRange: the agent
// itself among them); then velocity += acceleration dt, the facing turned toward the velocity by |v|^2 / maxVelocity^2,
// the velocity clamped to maxVelocity, position += velocity dt, acceleration nought. The behaviours run here:
// SpawnDrones (a count at the spawn position, a grid, more on a timer), ProcessLifetime (spline tunnels: in, about and
// out), Inertia and DroneAvoidance.
//
// Each frame, per agent (BehaviorGroup::UpdateVisibility and GetShipInfoForBuffer): in the view's frustum its size
// across in pixels (the bounding sphere radius x the group's scale), shown where at least renderThreshold; the mesh
// cross-fades to a sprite between blendScreenSizeMax and blendScreenSizeMin (xfade 0 .. 1), drawn at
// scale x (1 - xfade)(0.5 + (1 - xfade) 0.5) while xfade is under 0.75, not at all past it. (The sprites and the
// boosters' flares are not drawn.)
import * as THREE from "three";
import type { SofChildMesh } from "./hullChildren.ts";
import { perlinNoise1D, vector3Value } from "./curves.ts";
import { agentBoosters, agentBoxGeometry, setAgentBooster, type AgentBoosterData, type AgentFlareData } from "./boosterVolumetric.ts";
import { hullChildren, quadMesh, type SofChildNode } from "./hullChildren.ts";
import { offerLights, type ChildLight } from "./dynamicLights.ts";

export interface SofAgentGrid {
  id?: number;
  /** x, y, z counts and the distance between (w) */
  info: number[];
  /** the distance between on each axis, where not nought */
  spacing: number[];
  /** [0, 1] how full; -1 a random fullness per point */
  fullness: number;
}

/** A SplineTunnelGroup: its Tr2CurveVector3 curves, each sampled into a tunnel. */
export interface SofTunnelGroup {
  /** IBehavior::TunnelGroupType: 0 exit, 1 entrance, 2 other */
  type: number;
  breakPoints: number;
  width: number;
  pullSize: number;
  entrySize: number;
  curves: Record<string, unknown>[];
}

export type SofBehavior =
  | { type: "SpawnDrones"; id?: number; enabled: boolean; priority: number; addByCount: boolean; addOnGrid: boolean; seconds: number; time: number; count: number; spawnPosition: number[] }
  | { type: "ProcessLifetime"; id?: number; enabled: boolean; priority: number; returningAge: number; behaviorWeight: number; wanderAmount: number; respawnAgentsOnDeath: boolean; firstSpawnAtRandomPlaces: boolean; tunnels: SofTunnelGroup[] }
  | { type: "Inertia"; id?: number; enabled: boolean; priority: number; maxRotationSpeed: number; maxAcceleration: number }
  | { type: "DroneAvoidance"; id?: number; enabled: boolean; priority: number; behaviorWeight: number; visionRange: number; framesBetweenUpdates: number }
  | { type: "SeekTarget"; id?: number; enabled: boolean; priority: number; behaviorWeight: number; arrivedRadius: number; distFromOrigin: number; slowDownRadius: number; firstSpawnAtRandomPlaces: boolean; locatorSetName: string; ownSet: string | null; ownLocators: number[][] }
  | { type: "CollisionAvoidance"; id?: number; enabled: boolean; priority: number; avoidanceScalar: number; volumes: SofVolume[] }
  | { type: "InclusionVolume"; id?: number; enabled: boolean; priority: number; behaviorWeight: number; volumes: SofVolume[] }
  | { type: "Wander"; id?: number; enabled: boolean; priority: number; weightWander: number; rand1: number; rand2: number; rand3: number; freq: number }
  | { type: "PlayFX"; id?: number; enabled: boolean; priority: number; behaviorWeight: number; sec: number; hasEffect: boolean; stretch?: SofStretch3 | null };

/** An EveStretch3 (children.mjs readStretch3): its parts' graph (one container, the parts live) and their ids. */
export interface SofStretch3 { root: SofChildNode; destObjectScale: number; ids: { source: number | null; stretch: number | null; move: number | null; dest: number | null } }

/** An EveEllipsoidVolume: its centre, outer and inner radii, rotation. */
export interface SofVolume { position: number[]; shape: number[]; innerShape: number[]; rotation: number[] }

export interface SofAgentGroup {
  id?: number;
  name: string | null;
  display: boolean;
  count: number;
  scale: number;
  spawnPosition: number[];
  boundingSphereRadius: number;
  renderThreshold: number;
  blendMin: number;
  blendMax: number;
  grid: SofAgentGrid | null;
  maxVelocity?: number;
  update?: boolean;
  behaviors?: SofBehavior[];
  booster?: AgentBoosterData | null;
  mesh: SofChildMesh;
}

export interface SofChildAgents {
  k: "agents";
  id?: number;
  name: string | null;
  m: number[];
  display?: boolean;
  groups: SofAgentGroup[];
  /** the system's own spline tunnels (EveChildBehaviorSystem.splineTunnels) */
  tunnels?: SofTunnelGroup[];
}

/** A group as built: its spec, its parts (instanced, in the system's space through `local`). */
interface BuiltGroup {
  spec: SofAgentGroup;
  /** its flames (agentBoosters) and flares (quadMesh), found in a clone by name */
  booster?: string | null;
  flares?: string | null;
  /** its PlayFX's firing effect, built once (hullChildren), cloned per agent */
  stretch?: { template: THREE.Object3D; data: SofStretch3; behavior: number } | null;
  parts: { mesh: THREE.InstancedMesh; local: THREE.Matrix4; localInv: THREE.Matrix4 }[];
}

interface BuiltSystem { groups: BuiltGroup[]; tunnels: SofTunnelGroup[]; locatorSets: Record<string, number[][]> }

/**
 * The system's holder: each group's mesh (childMesh, as an EveChildMesh's) made instanced, its parts' instance counts
 * nought until a clone's run places the agents. The grid's numbers a curve set's binding may drive (gridFullnessFactor:
 * the construction sites' build-up), read when the grid is made.
 */
export async function buildAgents(
  node: SofChildAgents,
  childMesh: (mesh: SofChildMesh) => Promise<THREE.Object3D | null>,
  values: (id: number, get: (attr: string) => number | number[] | undefined, set: (attr: string, v: number | number[]) => void) => void,
  locatorSets: Record<string, number[][]> = {},
): Promise<THREE.Group> {
  const holder = new THREE.Group();
  holder.name = `child-agents:${node.name ?? ""}`;
  if (node.display === false) holder.visible = false;
  const built: BuiltGroup[] = [];
  const made = await Promise.all(node.groups.map(async (spec) => {
    const grid = spec.grid;
    if (grid?.id !== undefined) {
      const rec = grid as unknown as Record<string, unknown>;
      const key = (attr: string) => (attr === "gridFullnessFactor" ? "fullness" : attr === "gridInfo" ? "info" : attr === "gridSpacing" ? "spacing" : null);
      values(grid.id, (attr) => { const k = key(attr); return k ? (rec[k] as number | number[]) : undefined; }, (attr, v) => { const k = key(attr); if (k) rec[k] = v; });
    }
    const flames = spec.booster ? await agentBoosters(spec.booster, Math.max(1, spec.count)).catch(() => null) : null;
    // its PlayFX's firing effect (an EveStretch3): its graph built once, in EVE's space (no mirror: the holder is in it)
    const play = (spec.behaviors ?? []).findIndex((b) => b.type === "PlayFX" && !!b.stretch);
    const playSpec = play >= 0 ? (spec.behaviors![play] as Extract<SofBehavior, { type: "PlayFX" }>) : null;
    let stretch: BuiltGroup["stretch"] = null;
    if (playSpec?.stretch) {
      const template = await hullChildren([{ res: "", root: playSpec.stretch.root, skipped: {} }]).catch(() => null);
      if (template) { template.scale.set(1, 1, 1); stretch = { template, data: playSpec.stretch, behavior: play }; }
    }
    return { spec, mesh: await childMesh(spec.mesh), flames, stretch };
  }));
  // (in the groups' order: a group's place in the system's update and its parts' in the holder)
  for (const { spec, mesh, flames, stretch } of made) {
    if (!mesh) continue;
    mesh.updateMatrixWorld(true);
    const group: BuiltGroup = { spec, parts: [], stretch };
    // room for its count, or its grid (more on its timer: AgentRun grows it)
    const grid = spec.grid;
    const capacity = Math.max(1, spec.count, grid && (spec.behaviors ?? []).some((b) => b.type === "SpawnDrones" && b.addOnGrid) ? [0, 1, 2].reduce((n, i) => n * Math.max(0, Math.trunc(grid.info[i] ?? 1)), 1) : 0);
    mesh.traverse((o) => {
      const part = o as THREE.Mesh;
      if (!part.isMesh) return;
      const inst = new THREE.InstancedMesh(part.geometry, part.material, capacity);
      inst.count = 0;
      inst.frustumCulled = false;
      inst.layers.mask = part.layers.mask;
      inst.renderOrder = part.renderOrder;
      inst.castShadow = part.castShadow;
      inst.receiveShadow = part.receiveShadow;
      inst.userData = { ...part.userData };
      // the part's place under the mesh's holder (its parts in EVE's space through the holder's mirror)
      const local = part.matrixWorld.clone();
      inst.matrixAutoUpdate = false;
      inst.matrix.copy(local);
      group.parts.push({ mesh: inst, local, localInv: local.clone().invert() });
      holder.add(inst);
    });
    if (!spec.display) for (const p of group.parts) p.mesh.visible = false;
    if (flames) {
      flames.name = `agent-boosters:${built.length}`;
      group.booster = flames.name;
      holder.add(flames);
    }
    // its flares: a quad per agent and flare (flarequad.fx, as the hull children's quads), written each frame
    if (spec.booster && (spec.booster.halo || spec.booster.ambient)) {
      const flares = quadMesh([]);
      flares.name = `agent-flares:${built.length}`;
      group.flares = flares.name;
      holder.add(flares);
    }
    built.push(group);
  }
  // (by a key: a clone copies userData through JSON)
  const key = `agents:${++agentKeys}`;
  builtSystems.set(key, { groups: built, tunnels: node.tunnels ?? [], locatorSets });
  holder.userData.agentsKey = key;
  return holder;
}

let agentKeys = 0;
const builtSystems = new Map<string, BuiltSystem>();

// TriRand ([0, 1]), rand() % n and TriRandInt(n)
const triRand = Math.random;
const randInt = (n: number) => Math.floor(Math.random() * n);

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const V = () => new THREE.Vector3();
/** Normalize (nought stays nought) */
const norm = (v: THREE.Vector3) => (v.lengthSq() > 0 ? v.clone().normalize() : V());
/** TriQuaternionRotationArc: the shortest rotation taking a to b (b nought: none) */
function arc(a: THREE.Vector3, b: THREE.Vector3): THREE.Quaternion {
  if (b.lengthSq() === 0 || a.lengthSq() === 0) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());
}
const clampLength = (v: THREE.Vector3, max: number) => (v.length() > max ? v.setLength(max) : v);

interface Agent {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  velocity: THREE.Vector3;
  acceleration: THREE.Vector3;
  lifetime: number;
  /** TriRandInt(500): DroneAvoidance skips its own (and any agent sharing it) */
  id: number;
  /** each behaviour's scratch data, by its index in the group */
  scratch: unknown[];
  /** SeekTarget's goal (nought: none) and the way it faced last (targetDirection) */
  target: THREE.Vector3;
  targetDirection: THREE.Vector3;
  /** PlayFX: firing, since (seconds) */
  playFX: boolean;
  fxStartTime: number;
  xfade: number;
  shown: number;
}

/** A tunnel sampled from a curve (SplineTunnelGroup::CreateSplineTunnels). */
interface Tunnel { id: number; type: number; points: { pos: THREE.Vector3; rot: THREE.Vector3 }[]; width: number; pullSize: number; entrySize: number }

/** A tunnel group's curve's length: its axes' last key times, the greatest (Tr2CurveVector3::Length). */
function curveLength(c: Record<string, unknown>): number {
  let out = 0;
  for (const axis of ["x", "y", "z"]) {
    const keys = ((c[axis] as { keys?: number[][] } | undefined)?.keys ?? []) as number[][];
    for (const k of keys) out = Math.max(out, k[0] ?? 0);
  }
  return out;
}
const curveAt = (c: Record<string, unknown>, t: number) => new THREE.Vector3(...vector3Value(c as never, t));

/** The tunnels of a group: breakPoints + 2 points along each curve, each facing the next (the last as the one before). */
function tunnelsOf(g: SofTunnelGroup): Tunnel[] {
  return g.curves.map((c) => {
    const bp = Math.max(g.breakPoints, 0);
    const step = curveLength(c) / (bp + 1);
    const at = Array.from({ length: bp + 2 }, (_, i) => curveAt(c, i * step));
    const points = at.map((pos, i) => ({ pos, rot: i < bp + 1 ? at[i + 1]!.clone().sub(pos) : pos.clone().sub(at[bp]!) }));
    return { id: -1, type: g.type, points, width: g.width, pullSize: g.pullSize, entrySize: g.entrySize };
  });
}

interface LifetimeData { hasUsedEntryTunnel: boolean; hasUsedExitTunnel: boolean; assignedLifeTimeTunnel: number; tunnelPoint: number; hasSpawned: boolean }

/** A behaviour as run: its numbers, its own state. */
interface Run { spec: SofBehavior; index: number; state: Record<string, unknown> }

/** One group's run (BehaviorGroup). */
class GroupRun {
  agents: Agent[] = [];
  spawnPosition: THREE.Vector3;
  private readonly runs: Run[];
  private readonly sorted: Run[];
  private updatedOnce = false;
  /** whether anything here moves (else its matrices are written only when they change) */
  readonly moves: boolean;

  constructor(readonly built: BuiltGroup, private readonly system: { tunnels: Tunnel[] }) {
    const spec = built.spec;
    this.spawnPosition = new THREE.Vector3(...(spec.spawnPosition as [number, number, number]));
    this.runs = (spec.behaviors ?? []).map((b, index) => ({ spec: b, index, state: this.initialState(b) }));
    // SortBehaviorIndexes: by priority, then the file's order
    this.sorted = [...this.runs].sort((a, b) => a.spec.priority - b.spec.priority || a.index - b.index);
    this.moves = this.runs.some((r) => r.spec.type !== "SpawnDrones");
    // InitializeGeometryResource -> SetCount(count) -> AddAgentsByCount: at the spawn position where it is not nought
    for (let i = 0; i < Math.max(0, spec.count); i++) this.agents.push(this.newAgent(this.spawnPosition.lengthSq() ? this.spawnPosition : V()));
  }

  private initialState(b: SofBehavior): Record<string, unknown> {
    if (b.type === "SpawnDrones") return { regenerate: true, time: b.time, addByCount: b.addByCount, spawnPosition: new THREE.Vector3(...(b.spawnPosition as [number, number, number])) };
    if (b.type === "ProcessLifetime") {
      const own = b.tunnels.flatMap(tunnelsOf);
      return { groups: b.tunnels, privateTunnels: own, shouldReassign: true, initialSpawn: b.firstSpawnAtRandomPlaces, exit: false };
    }
    if (b.type === "DroneAvoidance") return { frameCounter: 0, lastPullForces: [] as THREE.Vector3[] };
    return {};
  }

  private newAgent(at: THREE.Vector3): Agent {
    const a: Agent = {
      position: at.clone(), rotation: new THREE.Quaternion(), velocity: V(), acceleration: V(), lifetime: 0, id: randInt(500), scratch: [],
      target: V(), targetDirection: V(), playFX: false, fxStartTime: -1, xfade: -1, shown: 0,
    };
    for (const r of this.runs) a.scratch[r.index] = r.spec.type === "ProcessLifetime" ? { hasUsedEntryTunnel: false, hasUsedExitTunnel: false, assignedLifeTimeTunnel: 0, tunnelPoint: 0, hasSpawned: false } satisfies LifetimeData
      : r.spec.type === "Inertia" ? { agentAccel: V() }
      : r.spec.type === "SeekTarget" ? { position: V(), direction: V(), arrived: true, hasSpawned: false, timePassed: 0 } satisfies SeekData
      : r.spec.type === "PlayFX" ? { droneArrived: false, effectPlaying: false, oldTarget: V() } : null;
    return a;
  }

  /** AddAgentPrivate: one more, at the spawn position where it is not nought */
  private addAgent(): void { this.agents.push(this.newAgent(this.spawnPosition.lengthSq() ? this.spawnPosition : V())); }
  /** RemoveSpecificAgent: the last takes its place */
  private removeAgent(i: number): void { this.agents[i] = this.agents[this.agents.length - 1]!; this.agents.pop(); }

  update(dt0: number): void {
    const spec = this.built.spec;
    const dt = Math.min(Math.max(dt0, 0), 0.1);
    if (this.updatedOnce) {
      if (!spec.display || spec.update === false) return;
      if (!this.agents.length) {
        for (const r of this.sorted) this.calculate(r, dt, []);
        return;
      }
    }
    // each behaviour's search radius (-1: none), + the group's bounding sphere twice (the group's and the tree's)
    const bs = spec.boundingSphereRadius * spec.scale;
    const radii = this.runs.map((r) => this.searchRadius(r));
    const found = this.runs.map((r) => {
      const rad = radii[r.index]!;
      if (rad === -1 || Math.max(...radii) === -1) return this.agents.map(() => [] as Agent[]);
      const range = rad + bs + bs;
      return this.agents.map((a) => this.agents.filter((b) => b.position.distanceToSquared(a.position) < range * range));
    });
    for (const r of this.sorted) this.calculate(r, dt, found[r.index] ?? []);
    // move them
    const maxV = spec.maxVelocity ?? 100;
    for (const a of this.agents) {
      a.lifetime += dt;
      a.velocity.addScaledVector(a.acceleration, dt);
      const interest = Z_AXIS.clone().applyQuaternion(a.rotation);
      const facing = interest.clone().lerp(a.velocity, a.velocity.lengthSq() / Math.max(1, maxV * maxV));
      a.rotation = arc(Z_AXIS, facing);
      a.targetDirection = facing;
      clampLength(a.velocity, maxV);
      a.position.addScaledVector(a.velocity, dt);
      a.acceleration.set(0, 0, 0);
    }
    this.updatedOnce = true;
  }

  /** IBehavior::GetBehaviorSearchRadius (DroneAvoidance's every framesBetweenUpdates + 1 updates, counting as it is asked) */
  private searchRadius(r: Run): number {
    if (r.spec.type !== "DroneAvoidance") return -1;
    const s = r.state as { frameCounter: number };
    if (s.frameCounter >= r.spec.framesBetweenUpdates) { s.frameCounter = 0; return r.spec.visionRange; }
    s.frameCounter++;
    return -1;
  }

  private calculate(r: Run, dt: number, found: Agent[][]): void {
    const b = r.spec;
    if (b.type === "SpawnDrones") this.spawnDrones(r, b, dt);
    else if (b.type === "ProcessLifetime") this.processLifetime(r, b, dt);
    else if (b.type === "Inertia") this.inertia(r, b, dt);
    else if (b.type === "DroneAvoidance") this.droneAvoidance(r, b, found);
    else if (b.type === "SeekTarget") this.seekTarget(r, b, dt);
    else if (b.type === "CollisionAvoidance") this.collisionAvoidance(b);
    else if (b.type === "InclusionVolume") this.inclusionVolume(b);
    else if (b.type === "Wander") this.wander(b);
    else if (b.type === "PlayFX") this.playFX(r, b);
  }

  /** The locators SeekTarget picks from: its own set where named so, else the space object's (EveSpaceObject2's). */
  private seekLocators(b: Extract<SofBehavior, { type: "SeekTarget" }>): number[][] {
    if (b.ownSet !== null && b.ownSet === b.locatorSetName && b.ownLocators.length) return b.ownLocators;
    return this.locatorSets[b.locatorSetName] ?? [];
  }

  /** A random locator's position and direction (its rotation applied to +y: EveGetLocatorPose); none: nought, +y. */
  private randomLocator(b: Extract<SofBehavior, { type: "SeekTarget" }>): { position: THREE.Vector3; direction: THREE.Vector3 } {
    const list = this.seekLocators(b);
    if (!list.length) return { position: V(), direction: new THREE.Vector3(0, 1, 0) };
    const l = list[randInt(list.length)]!;
    const q = new THREE.Quaternion(l[3] ?? 0, l[4] ?? 0, l[5] ?? 0, l[6] ?? 1);
    return { position: new THREE.Vector3(l[0] ?? 0, l[1] ?? 0, l[2] ?? 0), direction: new THREE.Vector3(0, 1, 0).applyQuaternion(q) };
  }

  /**
   * SeekTarget::CalculateBehavior, its seek (not its ship repair, which only the client's Python sets up): each agent
   * that has arrived and has no target takes a random locator; it heads for distFromOrigin along the locator's direction
   * from it, slowing inside slowDownRadius, where it turns to the locator and starts its PlayFX; arrived inside
   * arrivedRadius. Outside, its pull grows with the time since (timePassed / 0.35 s, the time at least 0.35 s).
   */
  private seekTarget(r: Run, b: Extract<SofBehavior, { type: "SeekTarget" }>, dt: number): void {
    if (b.behaviorWeight <= 0 || !b.enabled) return;
    const SECONDS = 0.35;
    for (const a of this.agents) {
      const data = a.scratch[r.index] as SeekData;
      if (!data.hasSpawned && b.firstSpawnAtRandomPlaces) {
        const at = this.randomLocator(b).position;
        this.spawnPosition.copy(at);
        a.position.copy(at);
        data.hasSpawned = true;
      }
      if (data.arrived && a.target.lengthSq() === 0) {
        const l = this.randomLocator(b);
        data.position.copy(l.position);
        data.direction.copy(l.direction);
        data.arrived = false;
      }
      a.target.copy(data.position);
      if (data.direction.lengthSq() === 0) data.direction.set(0, 1, 0);
      const goal = norm(data.direction).multiplyScalar(b.distFromOrigin).add(a.target);
      let desired = goal.clone().sub(a.position);
      const distance = desired.length();
      desired = norm(desired);
      if (distance < b.slowDownRadius) {
        desired.multiplyScalar(distance / b.slowDownRadius);
        a.rotation = arc(Z_AXIS, norm(data.position.clone().sub(a.position)));
        data.timePassed = 0;
        if (!a.playFX) { a.fxStartTime = performance.now() / 1000; a.playFX = true; }
        if (distance < b.arrivedRadius) data.arrived = true;
      } else {
        data.timePassed = Math.max(data.timePassed + dt, SECONDS);
        desired.multiplyScalar(b.behaviorWeight * (Math.max(data.timePassed, SECONDS) / SECONDS));
      }
      a.acceleration.add(desired.sub(a.velocity));
    }
  }

  /** CollisionAvoidance: pushed out of each exclusion volume by (position - its centre) x intensity x avoidanceScalar */
  private collisionAvoidance(b: Extract<SofBehavior, { type: "CollisionAvoidance" }>): void {
    if (!b.enabled) return;
    for (const a of this.agents) {
      for (const v of b.volumes) {
        const k = volumeIntensity(v, a.position);
        if (k > 0) a.acceleration.add(a.position.clone().sub(new THREE.Vector3(v.position[0] ?? 0, v.position[1] ?? 0, v.position[2] ?? 0)).multiplyScalar(k * b.avoidanceScalar));
      }
    }
  }

  /** InclusionVolume: pulled toward a volume's centre while in its outer shell (the last such volume; none inside an inner one) */
  private inclusionVolume(b: Extract<SofBehavior, { type: "InclusionVolume" }>): void {
    if (!b.enabled) return;
    for (const a of this.agents) {
      let force = V();
      for (const v of b.volumes) {
        const status = volumeIntensity(v, a.position);
        if (status === 1) { force = V(); break; }
        if (status > 0) force = norm(new THREE.Vector3(v.position[0] ?? 0, v.position[1] ?? 0, v.position[2] ?? 0).sub(a.position)).multiplyScalar(b.behaviorWeight);
      }
      a.acceleration.add(force);
    }
  }

  /** Wander: PerlinNoise1D(seed x rand1..3 x freq, 2, 1, 1) on each axis, seed its lifetime + id, x weightWander */
  private wander(b: Extract<SofBehavior, { type: "Wander" }>): void {
    if (!b.enabled) return;
    for (const a of this.agents) {
      const seed = a.lifetime + a.id;
      const f = new THREE.Vector3(perlinNoise1D(seed * b.rand1 * b.freq, 2, 1, 1), perlinNoise1D(seed * b.rand2 * b.freq, 2, 1, 1), perlinNoise1D(seed * b.rand3 * b.freq, 2, 1, 1));
      a.acceleration.addScaledVector(f, b.weightWander);
    }
  }

  /**
   * PlayFX: an agent whose SeekTarget started its fire plays it for sec seconds, then stops and drops its target (so
   * it seeks another locator). Its firing effects (one per agent) are not drawn; without one the client runs none of this.
   */
  private playFX(r: Run, b: Extract<SofBehavior, { type: "PlayFX" }>): void {
    if (b.behaviorWeight <= 0 || !b.enabled || !b.hasEffect) return;
    const now = performance.now() / 1000;
    for (const a of this.agents) {
      const data = a.scratch[r.index] as { droneArrived: boolean; effectPlaying: boolean; oldTarget: THREE.Vector3 };
      if (a.playFX && !data.effectPlaying) { data.droneArrived = true; data.effectPlaying = true; }
      if (data.effectPlaying && now - a.fxStartTime > b.sec) {
        data.effectPlaying = a.playFX = false;
        data.oldTarget = a.target.clone();
        a.target.set(0, 0, 0);
      }
    }
  }

  /** SpawnDrones::CalculateBehavior */
  private spawnDrones(r: Run, b: Extract<SofBehavior, { type: "SpawnDrones" }>, dt: number): void {
    if (!b.enabled) return;
    const s = r.state as { regenerate: boolean; time: number; addByCount: boolean; spawnPosition: THREE.Vector3 };
    if (b.addOnGrid && s.regenerate) { this.updateGrid(); s.regenerate = false; return; }
    if (s.addByCount) {
      for (let i = 0; i < b.count; i++) this.agents.push(this.newAgent(this.spawnPosition));
      s.addByCount = false;
    }
    if (b.seconds <= 0) return;
    s.time += dt;
    if (s.time > b.seconds) {
      // a random entrance of the group's ProcessLifetime (GetBehaviorByName: the first)
      const life = this.runs.find((x) => x.spec.type === "ProcessLifetime");
      if (life) {
        const points = ((life.state.privateTunnels ?? []) as Tunnel[]).filter((t) => t.type === 1 && t.points.length).map((t) => t.points[0]!.pos);
        if (points.length) s.spawnPosition = points[randInt(points.length)]!.clone();
      }
      this.spawnPosition = s.spawnPosition.clone();
      for (let i = 0; i < b.count; i++) this.agents.push(this.newAgent(this.spawnPosition));
      s.time = 0;
    }
  }

  /** SpawnDrones::UpdateGrid: x then y then z from the spawn position, each point kept where TriRand() <= fullness */
  private updateGrid(): void {
    const grid = this.built.spec.grid;
    if (!grid) return;
    this.agents = [];
    const [xc, yc, zc] = [0, 1, 2].map((i) => Math.max(0, Math.trunc(grid.info[i] ?? 1)));
    const w = grid.info[3] ?? 10;
    const spacing = grid.spacing[0] || grid.spacing[1] || grid.spacing[2] ? grid.spacing : [w, w, w];
    const start = this.spawnPosition.clone();
    let fullness = grid.fullness;
    for (let i = 0; i < zc!; i++) {
      for (let j = 0; j < yc!; j++) {
        for (let k = 0; k < xc!; k++) {
          if (grid.fullness === -1) fullness = triRand();
          if (triRand() <= fullness) this.agents.push(this.newAgent(new THREE.Vector3(start.x + k * spacing[0]!, start.y + j * spacing[1]!, start.z + i * spacing[2]!)));
        }
      }
    }
    this.spawnPosition.set(0, 0, 0);
  }

  /** Inertia::CalculateBehavior: the acceleration turned at most maxRotationSpeed dt from the last, its length eased */
  private inertia(r: Run, b: Extract<SofBehavior, { type: "Inertia" }>, dt: number): void {
    if (!b.enabled) return;
    const maxV = this.built.spec.maxVelocity ?? 100;
    for (const a of this.agents) {
      const data = a.scratch[r.index] as { agentAccel: THREE.Vector3 };
      const lastN = norm(data.agentAccel), lastLen = data.agentAccel.length();
      const accN = norm(a.acceleration), accLen = a.acceleration.length();
      if (lastN.lengthSq() !== 0 && b.maxRotationSpeed > 0) {
        let c = norm(new THREE.Vector3().crossVectors(lastN, accN));
        if (c.length() === 0) c = new THREE.Vector3(0, 1, 0);
        let angle = Math.acos(Math.min(1, Math.max(-1, lastN.dot(accN))));
        angle = Math.min(angle, b.maxRotationSpeed * dt);
        if (angle > 0) a.acceleration.copy(lastN).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(c, angle));
        const weight = Math.min(Math.max(maxV - a.velocity.length(), 0.1), maxV);
        a.acceleration.copy(clampLength(norm(a.acceleration).multiplyScalar(lastLen + (accLen - lastLen) * weight * dt), b.maxAcceleration));
      }
      data.agentAccel = a.acceleration.clone();
    }
  }

  /** DroneAvoidance::CalculateBehavior: away from the others found, half along its own way, x behaviorWeight */
  private droneAvoidance(r: Run, b: Extract<SofBehavior, { type: "DroneAvoidance" }>, found: Agent[][]): void {
    if (!b.enabled) return;
    const s = r.state as { frameCounter: number; lastPullForces: THREE.Vector3[] };
    if (s.frameCounter === 0) {
      s.lastPullForces = [];
      for (let c = 0; c < this.agents.length; c++) {
        const a = this.agents[c]!;
        // (no list for this agent, an empty one or only itself: no pull)
        const near = found[c];
        if (!near || near.length <= 1) { s.lastPullForces.push(V()); continue; }
        const away = V();
        for (const o of near) if (o.id !== a.id) away.add(a.position.clone().sub(o.position));
        if (away.lengthSq() === 0) { s.lastPullForces.push(V()); continue; }
        const pull = norm(away).multiplyScalar(0.5).add(norm(a.velocity).multiplyScalar(0.5)).multiplyScalar(b.behaviorWeight);
        if (pull.lengthSq() > 0) { a.acceleration.add(pull); s.lastPullForces.push(pull); } else s.lastPullForces.push(V());
      }
    } else {
      for (let c = 0; c < this.agents.length && c < s.lastPullForces.length; c++) this.agents[c]!.acceleration.add(s.lastPullForces[c]!);
    }
  }

  /** ProcessLifetime::CalculateBehavior */
  private processLifetime(r: Run, b: Extract<SofBehavior, { type: "ProcessLifetime" }>, dt: number): void {
    const s = r.state as { groups: SofTunnelGroup[]; privateTunnels: Tunnel[]; shouldReassign: boolean; initialSpawn: boolean; exit: boolean };
    if (s.shouldReassign) {
      // ReassignTunnelIDsAndAddSystemTunnels: the system's tunnels put in front (each at the front, so reversed), then
      // all numbered on from the system's last id
      for (const t of this.system.tunnels) s.privateTunnels.unshift(t);
      let id = this.system.tunnels.length ? this.system.tunnels[this.system.tunnels.length - 1]!.id : 0;
      for (const t of s.privateTunnels) t.id = id++;
      s.shouldReassign = false;
    }
    const tunnels = s.privateTunnels;
    const bs = this.built.spec.boundingSphereRadius;
    const dying: number[] = [];
    this.agents.forEach((drone, index) => {
      const data = drone.scratch[r.index] as LifetimeData;
      if (drone.lifetime <= dt && !s.initialSpawn) this.findASpawnPoint(drone, data, tunnels);
      if (!data.hasSpawned && s.initialSpawn) {
        const at = this.findInitialSpawnPoint(drone, data, s.groups);
        if (at) this.spawnPosition.copy(at);
        data.hasSpawned = true;
      }
      let desired = V();
      const process = (t: Tunnel) => { const out = this.processTunnel(drone, t, data, bs, b.wanderAmount); desired = out.desired; return out.done; };
      if (!data.hasUsedEntryTunnel) {
        if (data.assignedLifeTimeTunnel === -1) data.hasUsedEntryTunnel = true;
        else if (tunnels.length < data.assignedLifeTimeTunnel) data.hasUsedEntryTunnel = true;
        else if (tunnels.length > 0 && data.assignedLifeTimeTunnel < tunnels.length && process(tunnels[data.assignedLifeTimeTunnel]!)) {
          data.tunnelPoint = 0;
          data.hasUsedEntryTunnel = true;
          data.assignedLifeTimeTunnel = -1;
        }
      }
      if (s.exit || (b.returningAge !== -1 && drone.lifetime > b.returningAge)) {
        if (data.hasUsedExitTunnel) dying.push(index);
        else if (data.assignedLifeTimeTunnel === -1) {
          // FindAndAssignAnExitTunnel: the exit tunnel whose first point is nearest (none: out at once)
          let best = -1, bestSq = -1;
          tunnels.forEach((t, i) => {
            if (t.type !== 0 || !t.points.length) return;
            const d = t.points[0]!.pos.distanceToSquared(drone.position);
            if (bestSq === -1 || d < bestSq) { bestSq = d; best = i; }
          });
          if (best !== -1) data.assignedLifeTimeTunnel = best; else data.hasUsedExitTunnel = true;
        } else if (tunnels.length > 0 && data.assignedLifeTimeTunnel < tunnels.length && process(tunnels[data.assignedLifeTimeTunnel]!)) {
          data.hasUsedExitTunnel = true;
          dying.push(index);
        }
      }
      if (desired.lengthSq() === 0) return;
      drone.acceleration.add(norm(desired).multiplyScalar(b.behaviorWeight));
    });
    s.initialSpawn = false;
    for (let i = dying.length - 1; i >= 0; i--) {
      this.removeAgent(dying[i]!);
      if (b.respawnAgentsOnDeath) this.addAgent();
    }
  }

  /**
   * ProcessLifetime::ProcessTunnel: toward the tunnel's next point, offset half its width toward the line between the
   * points and wandered (each axis +- width x wanderAmount), eased onto the point's own way as it nears; the next point
   * once within width / 1.5 (+ the bounding sphere); done past the last. (Its branch for the last point compares the
   * point with the vector's end - past its last element - and is not taken.)
   */
  private processTunnel(agent: Agent, t: Tunnel, data: LifetimeData, bs: number, wander: number): { done: boolean; desired: THREE.Vector3 } {
    if (!t.points.length) return { done: false, desired: V() };
    if (data.tunnelPoint >= t.points.length) return { done: true, desired: V() };
    const p = t.points[data.tunnelPoint]!;
    const target = p.pos.clone().sub(agent.position);
    const first = t.points[0]!;
    const between = (p.pos.equals(first.pos) && p.rot.equals(first.rot)) || data.tunnelPoint === 0 ? p.rot : t.points[data.tunnelPoint - 1]!.rot;
    const len = between.length();
    if (len !== 0) {
      const proj = between.clone().multiplyScalar(target.dot(between) / (len * len));
      const offset = norm(proj.sub(target)).multiplyScalar(t.width / 2);
      const w = t.width * wander;
      offset.x += -w + triRand() * 2 * w;
      offset.y += -w + triRand() * 2 * w;
      offset.z += -w + triRand() * 2 * w;
      target.add(offset);
    }
    const fromShip = target.length();
    let blend = 0;
    if (len !== 0) { blend = Math.min(1, Math.max(0, (len - fromShip) / len)); blend *= blend; }
    let desired = norm(target).multiplyScalar(0.8 * (1 - blend)).add(norm(p.rot.clone().add(target)).multiplyScalar(0.2 * blend));
    if (norm(target).dot(norm(desired)) < 0.8) desired = target.clone();
    if (fromShip - bs < t.width / 1.5) data.tunnelPoint++;
    return { done: false, desired };
  }

  /** ProcessLifetime::FindASpawnPoint: a random entrance tunnel's first point, +- its entry size on each axis, facing along it */
  private findASpawnPoint(agent: Agent, data: LifetimeData, tunnels: Tunnel[]): void {
    const entrances = tunnels.filter((t) => t.type === 1 && t.points.length);
    if (!entrances.length) return;
    const t = entrances[randInt(entrances.length)]!;
    const n = t.entrySize;
    const at = t.points[0]!.pos.clone().add(new THREE.Vector3(-n + triRand() * 2 * n, -n + triRand() * 2 * n, -n + triRand() * 2 * n));
    this.spawnPosition.copy(at);
    agent.position.copy(at);
    agent.rotation = arc(Z_AXIS, t.points[0]!.rot);
    data.assignedLifeTimeTunnel = t.id;
  }

  /**
   * ProcessLifetime::FindInitialSpawnPoint: a random tunnel group (its own, else the system's); an entrance group puts
   * the agent at a whole second along one of its curves at random, part way through the tunnel. Its position, or null.
   */
  private findInitialSpawnPoint(agent: Agent, data: LifetimeData, own: SofTunnelGroup[]): THREE.Vector3 | null {
    const groups = own.length ? own : this.systemGroups;
    if (!groups.length) return null;
    const g = groups[randInt(groups.length)]!;
    if (!g.curves.length || g.type !== 1) return null;
    const c = g.curves[randInt(g.curves.length)]!;
    const length = Math.trunc(curveLength(c));
    const time = randInt(length + 1);
    const pos = curveAt(c, time);
    const step = length ? time / length : 0;
    const pointID = Math.floor(step * Math.max(g.breakPoints, 0) + 1) + 0.5;
    agent.position.copy(pos);
    agent.lifetime += step * pointID;
    data.tunnelPoint = Math.trunc(pointID);
    return pos;
  }

  systemGroups: SofTunnelGroup[] = [];
  locatorSets: Record<string, number[][]> = {};
}

interface SeekData { position: THREE.Vector3; direction: THREE.Vector3; arrived: boolean; hasSpawned: boolean; timePassed: number }

/**
 * EveEllipsoidVolume::GetIntensity: the point turned by the volume's inverse rotation (about the origin); 0 outside the
 * shape, 1 inside the inner shape, else |p - outer hit|^2 / |inner hit - outer hit|^2 along the ray toward the centre
 * (IntersectEllipsoidRayClosest; no inner shape: the inner hit nought).
 */
function volumeIntensity(v: SofVolume, point: THREE.Vector3): number {
  const c = new THREE.Vector3(v.position[0] ?? 0, v.position[1] ?? 0, v.position[2] ?? 0);
  const shape = new THREE.Vector3(v.shape[0] ?? 0, v.shape[1] ?? 0, v.shape[2] ?? 0).max(V());
  const inner = new THREE.Vector3(v.innerShape[0] ?? 0, v.innerShape[1] ?? 0, v.innerShape[2] ?? 0).min(shape).max(V());
  const p = point.clone().applyQuaternion(new THREE.Quaternion(v.rotation[0] ?? 0, v.rotation[1] ?? 0, v.rotation[2] ?? 0, v.rotation[3] ?? 1).invert());
  const inside = (r: THREE.Vector3) => { const d = p.clone().sub(c); return (d.x / r.x) ** 2 + (d.y / r.y) ** 2 + (d.z / r.z) ** 2 <= 1; };
  if (!inside(shape)) return 0;
  if (inside(inner)) return 1;
  const dir = norm(c.clone().sub(p));
  const hit = (r: THREE.Vector3): THREE.Vector3 | null => {
    const vv = new THREE.Vector3(dir.x / r.x, dir.y / r.y, dir.z / r.z);
    const s = new THREE.Vector3((p.x - c.x) / r.x, (p.y - c.y) / r.y, (p.z - c.z) / r.z);
    const v_v = vv.dot(vv), v_s = vv.dot(s), s_s = s.dot(s);
    let pq = (v_s / v_v) ** 2 - s_s / v_v + 1 / v_v;
    if (pq < 0) return null;
    pq = Math.sqrt(pq);
    const t1 = -pq - v_s / v_v, t2 = pq - v_s / v_v;
    return dir.clone().multiplyScalar(Math.abs(t1) < Math.abs(t2) ? t1 : t2).add(p);
  };
  // (a missed ray keeps the volume's last hit in the client - here nought)
  const outer = hit(shape) ?? V();
  const innerHit = inner.lengthSq() !== 0 ? hit(inner) ?? V() : V();
  return p.distanceToSquared(outer) / innerHit.distanceToSquared(outer);
}

/** One clone's agents: run each frame, then sized and culled for the view. */
export class AgentRun {
  private readonly groups: { run: GroupRun; parts: THREE.InstancedMesh[]; drawn: number; flames: THREE.Mesh | null; flares: THREE.Mesh | null; stretches: Map<Agent, { fx: THREE.Object3D; playing: boolean; aimed: boolean }> }[] = [];
  private last = -1;

  constructor(holder: THREE.Object3D) {
    const sys = builtSystems.get(holder.userData.agentsKey as string);
    if (!sys) return;
    const systemTunnels = sys.tunnels.flatMap(tunnelsOf);
    // UpdateTunnelRegistry: the system's tunnels numbered from nought
    systemTunnels.forEach((t, i) => (t.id = i));
    // this clone's parts, in the order built
    const inClone: THREE.InstancedMesh[] = [];
    holder.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) inClone.push(o as THREE.InstancedMesh); });
    let i = 0;
    for (const b of sys.groups) {
      const parts = inClone.slice(i, i + b.parts.length);
      i += b.parts.length;
      const run = new GroupRun(b, { tunnels: systemTunnels });
      run.systemGroups = sys.tunnels;
      run.locatorSets = sys.locatorSets;
      // this clone's flames, on a geometry of its own (the instance data is this clone's agents')
      const flames = b.booster ? (holder.getObjectByName(b.booster) as THREE.Mesh | undefined) ?? null : null;
      if (flames) flames.geometry = agentBoxGeometry(Math.max(1, b.spec.count));
      const flares = b.flares ? (holder.getObjectByName(b.flares) as THREE.Mesh | undefined) ?? null : null;
      this.groups.push({ run, parts, drawn: -1, flames, flares, stretches: new Map() });
    }
  }

  /**
   * The group's flames (GetBoosterInfoForBuffer): the shown agents under the 0.3 cross-fade, each its booster at the
   * offset x scale through it (agent space: rotation and place), intensity |velocity| / max(1, maxVelocity), a phase
   * by its id; the geometry grown (a new one) where the agents outgrow it.
   */
  private writeFlames(flames: THREE.Mesh, run: GroupRun): void {
    const spec = run.built.spec;
    const offset = (flames.userData.boosterOffset ?? [0, 0, 0]) as number[];
    const atlas = (flames.userData.boosterAtlas ?? [0, 0]) as number[];
    const bs = ((flames.material as THREE.ShaderMaterial).uniforms.boosterScale!.value as THREE.Vector3);
    let geo = flames.geometry as THREE.InstancedBufferGeometry;
    const need = run.agents.length;
    if ((geo.getAttribute("agentIntensity") as THREE.InstancedBufferAttribute).count < need) {
      geo.dispose();
      geo = agentBoxGeometry(Math.max(need, 2 * (geo.getAttribute("agentIntensity") as THREE.InstancedBufferAttribute).count));
      flames.geometry = geo;
    }
    const at = new THREE.Vector3();
    const off = new THREE.Vector3(offset[0] ?? 0, offset[1] ?? 0, offset[2] ?? 0).multiplyScalar(spec.scale);
    let k = 0;
    for (const a of run.agents) {
      if (!a.shown || a.xfade >= 0.3) continue;
      at.copy(off).applyQuaternion(a.rotation).add(a.position);
      const intensity = a.velocity.length() / Math.max(1, spec.maxVelocity ?? 100);
      // (srand(id); rand(): a fixed phase per agent id)
      const phase = ((Math.sin(a.id * 12.9898) * 43758.5453) % 1 + 1) % 1;
      setAgentBooster(geo, k++, at, a.rotation, spec.scale, bs, intensity, phase, atlas);
    }
    geo.instanceCount = k;
    for (const name of ["row0", "row1", "row2", "row3", "phase", "atlas", "agentIntensity"]) (geo.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /**
   * The group's flares (BehaviorGroupBooster::AddFlare, for each shown agent; lod its cross-fade): the halo - at the
   * offset x (1 + lod)^2 (lod - 1)^2 x the group's scale, turned half about y, through the agent; its quad the halo
   * scale; brightness 0.1 + 0.9 x intensity x haloFlareBrightness x that - and the ambient - at the offset x mod x scale,
   * mod = (1 - lod)(lod + 1)(lod - 1)^2; its size mod x ambientFlareScale x scale + (1 - mod) x the bounding sphere x
   * scale x 2 (at a distance the agent's own glow); brightness (0.25 + 0.25 I + 0.5 mod I) x ambientFlareBrightness -
   * each x ((PerlinNoise1D((time + index x 10 ms) x noise speed, 2, 2, octaves) + 1) / 2) x the noise amplitude, coloured
   * by its colour.
   */
  private writeFlares(flares: THREE.Mesh, run: GroupRun): void {
    const spec = run.built.spec;
    const b = spec.booster!;
    const quads: Parameters<typeof quadMesh>[0] = [];
    const now = performance.now() / 1000;
    const noiseOf = (f: AgentFlareData, i: number) => (f.noiseAmplitude !== 0 ? ((perlinNoise1D((now + i * 0.01) * f.noiseSpeed, 2, 2, f.noiseOctaves) + 1) / 2) * f.noiseAmplitude : 1);
    const v = (a: number[] | undefined) => new THREE.Vector3(a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0);
    run.agents.forEach((a, i) => {
      if (!a.shown) return;
      const lod = a.xfade;
      const intensity = a.velocity.length() / Math.max(1, spec.maxVelocity ?? 100);
      const rot = (x: THREE.Vector3) => x.applyQuaternion(a.rotation);
      if (b.halo) {
        const h = b.halo;
        const mod = Math.max(0, (1 + lod) * (1 + lod) * (lod - 1) * (lod - 1));
        const bright = (0.1 + 0.9 * intensity * h.brightness * mod) * noiseOf(h, i);
        // Rot(0, 1, 0, 0): x and z turned about; the offset x mod, all x the group scale, through the agent
        const centre = rot(v(h.offset).multiplyScalar(mod * spec.scale).multiply(new THREE.Vector3(-1, 1, -1))).add(a.position);
        quads.push({
          centre, ax: rot(new THREE.Vector3(-spec.scale * (h.scale[0] ?? 1), 0, 0)), ay: rot(new THREE.Vector3(0, spec.scale * (h.scale[1] ?? 1), 0)),
          colour: [0, 1, 2, 3].map((k) => (h.color[k] ?? 1) * bright), min: 0, halo: { z: rot(new THREE.Vector3(0, 0, -1)), at: centre.clone() },
        });
      }
      if (b.ambient) {
        const f = b.ambient;
        const mod = (1 - lod) * (lod + 1) * (lod - 1) * (lod - 1);
        const bright = (0.25 + 0.25 * intensity + 0.5 * mod * intensity) * f.brightness * noiseOf(f, i);
        const far = (1 - mod) * spec.boundingSphereRadius * spec.scale * 2;
        const size = (k: number) => mod * (f.scale[k] ?? 1) * spec.scale + far;
        const centre = rot(v(f.offset).multiplyScalar(mod * spec.scale)).add(a.position);
        quads.push({ centre, ax: rot(new THREE.Vector3(size(0), 0, 0)), ay: rot(new THREE.Vector3(0, size(1), 0)), colour: [0, 1, 2, 3].map((k) => (f.color[k] ?? 1) * bright), min: 0, halo: null });
      }
    });
    const geo = flares.geometry as THREE.InstancedBufferGeometry;
    const room = (geo.getAttribute("iCentre") as THREE.InstancedBufferAttribute).count;
    if (room < quads.length) {
      // a new geometry with room (quadMesh's, the material kept)
      const fresh = quadMesh(Array.from({ length: Math.max(quads.length, room * 2) }, () => ({ centre: new THREE.Vector3(), ax: new THREE.Vector3(), ay: new THREE.Vector3(), colour: [0, 0, 0, 0], min: 0, halo: null })));
      // (the old one not disposed: the model's clones start from one geometry)
      flares.geometry = fresh.geometry;
    }
    const g2 = flares.geometry as THREE.InstancedBufferGeometry;
    const set = (name: string, i: number, values: number[]) => (g2.getAttribute(name) as THREE.InstancedBufferAttribute).set(values, i * values.length);
    quads.forEach((q, i) => {
      set("iCentre", i, q.centre.toArray());
      set("iAxisX", i, q.ax.toArray());
      set("iAxisY", i, q.ay.toArray());
      set("iColour", i, q.colour);
      set("iMin", i, [q.min]);
      set("iHaloZ", i, q.halo ? [...q.halo.z.toArray(), 1] : [0, 0, 0, 0]);
      set("iHaloAt", i, q.halo ? q.halo.at.toArray() : [0, 0, 0]);
    });
    for (const name of ["iCentre", "iAxisX", "iAxisY", "iColour", "iMin", "iHaloZ", "iHaloAt"]) (g2.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
    g2.instanceCount = quads.length;
  }

  /**
   * The group's booster lights (GetBoosterInfoForBuffer / BehaviorGroup::GetLights / BehaviorGroupBooster::AddLight):
   * an agent shown under the 0.25 cross-fade lights at its booster (offset x scale through it), radius lightRadius x
   * intensity x (1 - 4 lod)(2 lod + 1) x scale, colour lightColor x the ambient flare's noise (its amplitude, default
   * 0.2, applies even without the flare).
   */
  private gatherLights(run: GroupRun, into: ChildLight[]): void {
    const spec = run.built.spec;
    const b = spec.booster!;
    const now = performance.now() / 1000;
    const amb = b.ambient ?? { noiseAmplitude: 0.2, noiseSpeed: 1, noiseOctaves: 1 } as AgentFlareData;
    const off = new THREE.Vector3(b.offset[0] ?? 0, b.offset[1] ?? 0, b.offset[2] ?? 0).multiplyScalar(spec.scale);
    run.agents.forEach((a, i) => {
      if (!a.shown || a.xfade >= 0.25) return;
      const lod = a.xfade;
      const intensity = a.velocity.length() / Math.max(1, spec.maxVelocity ?? 100);
      const scale = intensity * (1 - 4 * lod) * (2 * lod + 1) * spec.scale;
      if (scale <= 0) return;
      const n = amb.noiseAmplitude !== 0 ? ((perlinNoise1D((now + i * 0.01) * amb.noiseSpeed, 2, 2, amb.noiseOctaves) + 1) / 2) * amb.noiseAmplitude : 1;
      const at = off.clone().applyQuaternion(a.rotation).add(a.position);
      into.push({ position: at.toArray(), radius: scale * (b.lightRadius ?? 3.5), color: (b.lightColor ?? [1, 1, 1, 1]).slice(0, 3).map((c) => c * n), brightness: 1 });
    });
  }

  /**
   * The group's firing effects (PlayFX: one per agent; EveStretch3 for each): shown once its agent has fired
   * (droneArrived), IsFiring 1 as it starts (StartFiring, FiringDelay 0) and 0 as it stops; while firing from the agent's
   * side (its place + its facing x the bounding sphere) to its target, afterwards to where that target was. Each update
   * places the parts as EveStretch3::UpdateAsyncronous does: the source at the source turned so -z points from target to
   * source (TriQuaternionArcFromForward), the stretch from source to target (EveChildModifierStretch: z scaled to the
   * length, at the middle), the move object at the source (moveProgression nought), the dest at the target with a half
   * turn about y x destObjectScale. The parts' lights are offered to the dynamic lights.
   */
  private runStretches(g: AgentRun["groups"][number], holder: THREE.Object3D, renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    const built = g.run.built.stretch!;
    const spec = g.run.built.spec;
    const seen = new Set<Agent>();
    for (const a of g.run.agents) {
      seen.add(a);
      const data = a.scratch[built.behavior] as { droneArrived: boolean; effectPlaying: boolean; oldTarget: THREE.Vector3 } | null;
      if (!data) continue;
      let entry = g.stretches.get(a);
      if (!entry && data.droneArrived) {
        const fx = built.template.clone();
        fx.name = "agent-stretch";
        holder.add(fx);
        entry = { fx, playing: false, aimed: false };
        g.stretches.set(a, entry);
      }
      if (!entry) continue;
      entry.fx.visible = data.droneArrived;
      if (data.effectPlaying !== entry.playing) {
        entry.playing = data.effectPlaying;
        setVariable(entry.fx, "FiringDelay", 0);
        setVariable(entry.fx, "IsFiring", data.effectPlaying ? 1 : 0);
      }
      // (while firing at its target; after, at where that was - the client's old target, unset until a first stop)
      if (data.effectPlaying) entry.aimed = true;
      if (!entry.aimed) continue;
      const dest = data.effectPlaying ? a.target : data.oldTarget;
      const source = a.position.clone().add(norm(a.targetDirection).multiplyScalar(spec.boundingSphereRadius));
      placeStretch(entry.fx, built.data, source, dest);
      for (const part of livePartsOf(entry.fx)) offerLights(renderer, camera, part);
    }
    // an agent gone: its effect with it
    for (const [a, e] of g.stretches) if (!seen.has(a)) { e.fx.removeFromParent(); g.stretches.delete(a); }
  }

  update(renderer: THREE.WebGLRenderer, camera: THREE.Camera, holder: THREE.Object3D): void {
    const now = performance.now() / 1000;
    const lights: ChildLight[] = [];
    const dt = this.last < 0 ? 0 : now - this.last;
    this.last = now;
    holder.updateWorldMatrix(true, false);
    const world = holder.matrixWorld;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const eye = camera.getWorldPosition(V());
    const ahead = camera.getWorldDirection(V());
    const halfWidth = (camera.projectionMatrix.elements[0] ?? 1) * renderer.domElement.width * 0.5;
    const sphere = new THREE.Sphere();
    const at = V();
    const m = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    for (const g of this.groups) {
      g.run.update(dt);
      const spec = g.run.built.spec;
      const agents = g.run.agents;
      const radius = spec.boundingSphereRadius * spec.scale;
      let changed = g.drawn !== agents.length || g.run.moves;
      // room for them all (a group grows on its timer and its grid): a new InstancedMesh twice the size in the old one's
      // place - a new instanceMatrix on the same mesh leaves an already-bound program drawing from the old buffer
      g.parts = g.parts.map((part) => {
        if (part.instanceMatrix.count >= agents.length) return part;
        const bigger = new THREE.InstancedMesh(part.geometry, part.material, Math.max(agents.length, part.instanceMatrix.count * 2));
        bigger.count = 0;
        bigger.frustumCulled = false;
        bigger.layers.mask = part.layers.mask;
        bigger.renderOrder = part.renderOrder;
        bigger.castShadow = part.castShadow;
        bigger.receiveShadow = part.receiveShadow;
        bigger.visible = part.visible;
        bigger.userData = { ...part.userData };
        bigger.matrixAutoUpdate = false;
        bigger.matrix.copy(part.matrix);
        bigger.matrixWorldNeedsUpdate = true;
        part.parent?.add(bigger);
        part.removeFromParent();
        changed = true;
        return bigger;
      });
      agents.forEach((a) => {
        at.copy(a.position).applyMatrix4(world);
        let xfade = 1, shown = 0;
        if (frustum.intersectsSphere(sphere.set(at, radius))) {
          const d = at.clone().sub(eye);
          // TriFrustum::GetPixelSizeAccross (the eye inside the sphere: no limit)
          const size = d.lengthSq() < radius * radius ? Infinity : (radius / Math.max(1e-5, d.dot(ahead))) * halfWidth * 2;
          xfade = size >= spec.blendMax ? 0 : size <= spec.blendMin ? 1 : 1 - (size - spec.blendMin) / Math.max(0.0001, spec.blendMax - spec.blendMin);
          shown = size >= spec.renderThreshold ? 1 : 0;
        }
        if (Math.abs(xfade - a.xfade) >= 1e-3 || shown !== a.shown) { a.xfade = xfade; a.shown = shown; changed = true; }
      });
      if (g.flames) this.writeFlames(g.flames, g.run);
      if (g.flares) this.writeFlares(g.flares, g.run);
      if (g.run.built.spec.booster) this.gatherLights(g.run, lights);
      if (g.run.built.stretch) this.runStretches(g, holder, renderer, camera);
      if (!changed) continue;
      // the agents drawn only (the client writes a nought matrix for the others: here they are left out - a nought
      // scale gives the shader's normal transform a division by nought)
      let k = 0;
      for (const a of agents) {
        const lod = a.shown && a.xfade < 0.75 ? (1 - a.xfade) * (0.5 + (1 - a.xfade) * 0.5) : 0;
        if (lod <= 0) continue;
        // the agent at its place and facing, the mesh at the group's scale x the cross-fade
        m.compose(a.position, a.rotation, one.clone().multiplyScalar(spec.scale * lod));
        for (let j = 0; j < g.parts.length; j++) {
          const part = g.run.built.parts[j]!;
          // in the part's own space: its place undone, the agent's transform, its place again
          g.parts[j]!.setMatrixAt(k, part.localInv.clone().multiply(m).multiply(part.local));
        }
        k++;
      }
      g.drawn = agents.length;
      for (const part of g.parts) { part.count = k; part.instanceMatrix.needsUpdate = true; }
    }
    // the booster lights, for the dynamic lights' next list (in the system's space: the holder's)
    holder.userData.lights = lights;
    offerLights(renderer, camera, holder);
  }
}

/** A controller variable kept on an object (hullModel.ts setControllerVariable: its controllers take it). */
function setVariable(o: THREE.Object3D, name: string, value: number): void {
  const vars = (o.userData.controllerVars ??= {}) as Record<string, number>;
  if (vars[name] === value) return;
  vars[name] = value;
  o.userData.controllerVarsVersion = ((o.userData.controllerVarsVersion as number | undefined) ?? 0) + 1;
}

const livePartsOf = (fx: THREE.Object3D) => {
  const out: THREE.Object3D[] = [];
  fx.traverse((o) => { if (o.name.startsWith("child-live:")) out.push(o); });
  return out;
};

// TriQuaternionArcFromForward: the rotation taking -z to the direction
const MINUS_Z = new THREE.Vector3(0, 0, -1);
const arcFromForward = (v: THREE.Vector3) => (v.lengthSq() > 0 ? new THREE.Quaternion().setFromUnitVectors(MINUS_Z, v.clone().normalize()) : new THREE.Quaternion());
const HALF_TURN_Y = new THREE.Quaternion(0, 1, 0, 0);

/** EveStretch3::UpdateAsyncronous's placing of its parts (in its owner's space). */
function placeStretch(fx: THREE.Object3D, data: SofStretch3, source: THREE.Vector3, dest: THREE.Vector3): void {
  const q = arcFromForward(source.clone().sub(dest));
  const diff = dest.clone().sub(source);
  const set = (id: number | null, m: THREE.Matrix4) => {
    if (id === null) return;
    fx.traverse((o) => {
      if (o.userData.childId !== id || !o.name.startsWith("child-live:")) return;
      o.matrix.copy(m);
      o.matrixWorldNeedsUpdate = true;
    });
  };
  const one = new THREE.Vector3(1, 1, 1);
  set(data.ids.source, new THREE.Matrix4().compose(source, q, one));
  set(data.ids.stretch, new THREE.Matrix4().compose(source.clone().addScaledVector(diff, 0.5), arcFromForward(diff), new THREE.Vector3(1, 1, diff.length())));
  set(data.ids.move, new THREE.Matrix4().compose(source, q, one));
  set(data.ids.dest, new THREE.Matrix4().compose(dest, q.clone().multiply(HALF_TURN_Y), one.clone().multiplyScalar(data.destObjectScale)));
}
