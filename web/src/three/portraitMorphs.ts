import * as THREE from "three";
import type { PortraitMorph } from "../app/api.ts";

interface MorphMesh {
  name: string;
  vertices: number;
  deltas: number[];
}

const outfitCatalogs = new Map<string, readonly string[]>();

export async function loadOutfitMorphNames(model: string): Promise<readonly string[]> {
  const cached = outfitCatalogs.get(model);
  if (cached) return cached;
  try {
    const response = await fetch(model.replace(/\.glb$/, ".morphs.json"));
    if (!response.ok) return [];
    const { names } = await response.json() as { names?: string[] };
    if (!Array.isArray(names)) return [];
    const valid = names.filter(name => typeof name === "string" && /^[a-z0-9_]+shape$/.test(name));
    outfitCatalogs.set(model, valid);
    return valid;
  } catch {
    return [];
  }
}

export async function applyPortraitMorphs(model: THREE.Object3D, stem: string, morphs: readonly PortraitMorph[],
  retired: () => boolean): Promise<void> {
  if (!morphs.length) return;
  const layers = await Promise.all(morphs.map(async ({ name, weight }) => {
    try {
      const response = await fetch(`${stem}/morphs/${name}.json`);
      if (!response.ok) return null;
      const data = await response.json() as { name: string; meshes: MorphMesh[] };
      return data.name === name && Array.isArray(data.meshes) ? { meshes: data.meshes, weight } : null;
    } catch {
      return null;
    }
  }));
  if (retired()) return;
  const changed = new Set<THREE.BufferGeometry>();
  for (const layer of layers) {
    if (!layer) continue;
    const applied = new Set<THREE.BufferAttribute>();
    model.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const mesh = layer.meshes.find(mesh => mesh.name === node.name || mesh.name === node.name.replace(/_\d+$/, ""));
      const geometry = node.geometry;
      const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal");
      if (!mesh || !(position instanceof THREE.BufferAttribute) || mesh.vertices !== position.count || applied.has(position)) return;
      applied.add(position);
      const { deltas } = mesh;
      for (let at = 0; at + 6 < deltas.length; at += 7) {
        const [index, x, y, z, nx, ny, nz] = deltas.slice(at, at + 7) as [number, number, number, number, number, number, number];
        if (!Number.isInteger(index) || index < 0 || index >= position.count) continue;
        position.setXYZ(index, position.getX(index) + x * layer.weight, position.getY(index) + y * layer.weight,
          position.getZ(index) + z * layer.weight);
        if (normal) normal.setXYZ(index, normal.getX(index) + nx * layer.weight, normal.getY(index) + ny * layer.weight,
          normal.getZ(index) + nz * layer.weight);
      }
      changed.add(geometry);
    });
  }
  for (const geometry of changed) {
    geometry.getAttribute("position").needsUpdate = true;
    if (geometry.hasAttribute("normal")) geometry.normalizeNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
}
