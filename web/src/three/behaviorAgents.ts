// EveChildBehaviorSystem's still groups (Children/EveChildBehaviorSystem.cpp, Behaviors/BehaviorGroup.cpp,
// Behaviors/SpawnDrones.cpp): agents placed once - count of them at the group's spawn position, or SpawnDrones' grid -
// each drawn as the group's mesh (quadinstancedv5: the hull shader per instance), here one InstancedMesh per part of it.
// Each frame, per agent (BehaviorGroup::UpdateVisibility and GetShipInfoForBuffer): in the view's frustum its size
// across in pixels (the bounding sphere radius x the group's scale), shown where at least renderThreshold; the mesh
// cross-fades to a sprite between blendScreenSizeMax and blendScreenSizeMin (xfade 0 .. 1), drawn at
// scale x (1 - xfade)(0.5 + (1 - xfade) 0.5) while xfade is under 0.75, not at all past it. (The sprite - the booster
// flares - is not drawn; nor are the moving groups.)
import * as THREE from "three";
import type { SofChildMesh } from "./hullChildren.ts";

export interface SofAgentGrid {
  id?: number;
  /** x, y, z counts and the distance between (w) */
  info: number[];
  /** the distance between on each axis, where not nought */
  spacing: number[];
  /** [0, 1] how full; -1 a random fullness per point */
  fullness: number;
}

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
  mesh: SofChildMesh;
}

export interface SofChildAgents {
  k: "agents";
  id?: number;
  name: string | null;
  m: number[];
  display?: boolean;
  groups: SofAgentGroup[];
}

/** A group as built: its spec, its parts (instanced, in the system's space through `local`), its most agents. */
interface BuiltGroup {
  spec: SofAgentGroup;
  parts: { mesh: THREE.InstancedMesh; local: THREE.Matrix4; localInv: THREE.Matrix4 }[];
  capacity: number;
}

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
  await Promise.all(node.groups.map(async (spec) => {
    const grid = spec.grid;
    if (grid?.id !== undefined) {
      const rec = grid as unknown as Record<string, unknown>;
      const key = (attr: string) => (attr === "gridFullnessFactor" ? "fullness" : attr === "gridInfo" ? "info" : attr === "gridSpacing" ? "spacing" : null);
      values(grid.id, (attr) => { const k = key(attr); return k ? (rec[k] as number | number[]) : undefined; }, (attr, v) => { const k = key(attr); if (k) rec[k] = v; });
    }
    const capacity = grid ? Math.max(0, Math.trunc(grid.info[0] ?? 1)) * Math.max(0, Math.trunc(grid.info[1] ?? 1)) * Math.max(0, Math.trunc(grid.info[2] ?? 1)) : Math.max(0, spec.count);
    if (!capacity) return;
    const made = await childMesh(spec.mesh);
    if (!made) return;
    made.updateMatrixWorld(true);
    const group: BuiltGroup = { spec, parts: [], capacity };
    made.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, capacity);
      inst.count = 0;
      inst.frustumCulled = false;
      inst.layers.mask = mesh.layers.mask;
      inst.renderOrder = mesh.renderOrder;
      inst.castShadow = mesh.castShadow;
      inst.receiveShadow = mesh.receiveShadow;
      inst.userData = { ...mesh.userData };
      // the part's place under the mesh's holder (its parts in EVE's space through the holder's mirror)
      const local = mesh.matrixWorld.clone();
      inst.matrixAutoUpdate = false;
      inst.matrix.copy(local);
      group.parts.push({ mesh: inst, local, localInv: local.clone().invert() });
      holder.add(inst);
    });
    if (!spec.display) for (const p of group.parts) p.mesh.visible = false;
    built.push(group);
  }));
  // (by a key: a clone copies userData through JSON)
  const key = `agents:${++agentKeys}`;
  builtGroups.set(key, built);
  holder.userData.agentsKey = key;
  return holder;
}

let agentKeys = 0;
const builtGroups = new Map<string, BuiltGroup[]>();

const TriRand = Math.random;

/** One clone's agents: placed on its first update, sized and culled each frame. */
export class AgentRun {
  private readonly groups: { built: BuiltGroup; parts: THREE.InstancedMesh[]; agents: THREE.Vector3[]; xfade: Float32Array; shown: Uint8Array }[] = [];

  constructor(holder: THREE.Object3D) {
    const built = builtGroups.get(holder.userData.agentsKey as string) ?? [];
    // this clone's parts, in the order built
    const inClone: THREE.InstancedMesh[] = [];
    holder.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) inClone.push(o as THREE.InstancedMesh); });
    let i = 0;
    for (const b of built) {
      const parts = inClone.slice(i, i + b.parts.length);
      i += b.parts.length;
      const agents = placeAgents(b.spec).slice(0, b.capacity);
      this.groups.push({ built: b, parts, agents, xfade: new Float32Array(agents.length).fill(-1), shown: new Uint8Array(agents.length) });
    }
  }

  update(renderer: THREE.WebGLRenderer, camera: THREE.Camera, holder: THREE.Object3D): void {
    holder.updateWorldMatrix(true, false);
    const world = holder.matrixWorld;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const ahead = camera.getWorldDirection(new THREE.Vector3());
    const halfWidth = (camera.projectionMatrix.elements[0] ?? 1) * renderer.domElement.width * 0.5;
    const sphere = new THREE.Sphere();
    const at = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const s = new THREE.Matrix4();
    for (const g of this.groups) {
      const spec = g.built.spec;
      const radius = spec.boundingSphereRadius * spec.scale;
      let changed = g.parts.length > 0 && g.parts[0]!.count !== g.agents.length;
      g.agents.forEach((p, k) => {
        at.copy(p).applyMatrix4(world);
        let xfade = 1, shown = 0;
        if (frustum.intersectsSphere(sphere.set(at, radius))) {
          const d = at.clone().sub(eye);
          // TriFrustum::GetPixelSizeAccross (the eye inside the sphere: no limit)
          const size = d.lengthSq() < radius * radius ? Infinity : (radius / Math.max(1e-5, d.dot(ahead))) * halfWidth * 2;
          xfade = size >= spec.blendMax ? 0 : size <= spec.blendMin ? 1 : 1 - (size - spec.blendMin) / Math.max(0.0001, spec.blendMax - spec.blendMin);
          shown = size >= spec.renderThreshold ? 1 : 0;
        }
        if (Math.abs(xfade - g.xfade[k]!) < 1e-3 && shown === g.shown[k]) return;
        g.xfade[k] = xfade;
        g.shown[k] = shown;
        changed = true;
        const lod = shown && xfade < 0.75 ? (1 - xfade) * (0.5 + (1 - xfade) * 0.5) : 0;
        // the agent at its place, the mesh at the group's scale x the cross-fade (agent rotation: none for still ones)
        m.makeTranslation(p.x, p.y, p.z).multiply(s.makeScale(spec.scale * lod, spec.scale * lod, spec.scale * lod));
        for (let j = 0; j < g.parts.length; j++) {
          const part = g.built.parts[j]!;
          // in the part's own space: its place undone, the agent's transform, its place again
          g.parts[j]!.setMatrixAt(k, part.localInv.clone().multiply(m).multiply(part.local));
        }
      });
      if (!changed) continue;
      for (const part of g.parts) { part.count = g.agents.length; part.instanceMatrix.needsUpdate = true; }
    }
  }
}

/** The group's agents (system space): the grid, or count of them at the spawn position. */
function placeAgents(spec: SofAgentGroup): THREE.Vector3[] {
  const start = new THREE.Vector3(spec.spawnPosition[0] ?? 0, spec.spawnPosition[1] ?? 0, spec.spawnPosition[2] ?? 0);
  const grid = spec.grid;
  if (!grid) return Array.from({ length: Math.max(0, spec.count) }, () => start.clone());
  const [xc, yc, zc] = [0, 1, 2].map((i) => Math.max(0, Math.trunc(grid.info[i] ?? 1)));
  const w = grid.info[3] ?? 10;
  const spacing = grid.spacing[0] || grid.spacing[1] || grid.spacing[2] ? grid.spacing : [w, w, w];
  const out: THREE.Vector3[] = [];
  let fullness = grid.fullness;
  for (let i = 0; i < zc!; i++) {
    for (let j = 0; j < yc!; j++) {
      for (let k = 0; k < xc!; k++) {
        if (grid.fullness === -1) fullness = TriRand();
        if (TriRand() <= fullness) out.push(new THREE.Vector3(start.x + k * spacing[0]!, start.y + j * spacing[1]!, start.z + i * spacing[2]!));
      }
    }
  }
  return out;
}
