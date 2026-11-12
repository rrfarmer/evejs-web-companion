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
import { vector3Value } from "./curves.ts";

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
  | { type: "DroneAvoidance"; id?: number; enabled: boolean; priority: number; behaviorWeight: number; visionRange: number; framesBetweenUpdates: number };

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
  parts: { mesh: THREE.InstancedMesh; local: THREE.Matrix4; localInv: THREE.Matrix4 }[];
}

interface BuiltSystem { groups: BuiltGroup[]; tunnels: SofTunnelGroup[] }

/**
 * The system's holder: each group's mesh (childMesh, as an EveChildMesh's) made instanced, its parts' instance counts
 * nought until a clone's run places the agents. The grid's numbers a curve set's binding may drive (gridFullnessFactor:
 * the construction sites' build-up), read when the grid is made.
 */
export async function buildAgents(
  node: SofChildAgents,
  childMesh: (mesh: SofChildMesh) => Promise<THREE.Object3D | null>,
  values: (id: number, get: (attr: string) => number | number[] | undefined, set: (attr: string, v: number | number[]) => void) => void,
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
    return { spec, mesh: await childMesh(spec.mesh) };
  }));
  // (in the groups' order: a group's place in the system's update and its parts' in the holder)
  for (const { spec, mesh } of made) {
    if (!mesh) continue;
    mesh.updateMatrixWorld(true);
    const group: BuiltGroup = { spec, parts: [] };
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
    built.push(group);
  }
  // (by a key: a clone copies userData through JSON)
  const key = `agents:${++agentKeys}`;
  builtSystems.set(key, { groups: built, tunnels: node.tunnels ?? [] });
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
    const a: Agent = { position: at.clone(), rotation: new THREE.Quaternion(), velocity: V(), acceleration: V(), lifetime: 0, id: randInt(500), scratch: [], xfade: -1, shown: 0 };
    for (const r of this.runs) a.scratch[r.index] = r.spec.type === "ProcessLifetime" ? { hasUsedEntryTunnel: false, hasUsedExitTunnel: false, assignedLifeTimeTunnel: 0, tunnelPoint: 0, hasSpawned: false } satisfies LifetimeData
      : r.spec.type === "Inertia" ? { agentAccel: V() } : null;
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
}

/** One clone's agents: run each frame, then sized and culled for the view. */
export class AgentRun {
  private readonly groups: { run: GroupRun; parts: THREE.InstancedMesh[]; drawn: number }[] = [];
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
      this.groups.push({ run, parts, drawn: -1 });
    }
  }

  update(renderer: THREE.WebGLRenderer, camera: THREE.Camera, holder: THREE.Object3D): void {
    const now = performance.now() / 1000;
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
  }
}
