import * as THREE from "three";
import { animators } from "../three/childAnimation.ts";
import { loadDds } from "../three/ddsTexture.ts";
import { effectObject, playEffectSet, stopEffectSet, type SofChildNode } from "../three/hullChildren.ts";
import { WORMHOLE_TRANSIT_MATERIAL } from "../three/wormholeTransitMaterial.ts";
import { destinationNebula } from "./nonInteractableWormhole.ts";

export const WORMHOLE_START_MS = 500;
export const WORMHOLE_MIDDLE_MS = 1_500;
export const WORMHOLE_CAMERA_RETURN_MS = 500;
export const WORMHOLE_STOP_MS = 2_000;

type Tunnel = { object: THREE.Object3D; material: THREE.ShaderMaterial };
type Flight = {
  at: number;
  source: THREE.Texture | null;
  far: THREE.Texture | null;
  triglavian: boolean;
  tunnel: Tunnel | null;
  started: boolean;
  middle: boolean;
  stopped: boolean;
};

let definition: Promise<SofChildNode> | null = null;
const reflectionCubes = new Map<number, Promise<THREE.Texture | null>>();

function reflectionFor(graphicID: number): Promise<THREE.Texture | null> {
  if (graphicID <= 0) return Promise.resolve(null);
  if (!reflectionCubes.has(graphicID)) {
    reflectionCubes.set(graphicID, destinationNebula(graphicID)
      .then((maps) => maps?.destinationReflectionCube ? loadDds(maps.destinationReflectionCube) : null)
      .catch(() => null)
      .then((cube) => {
        if (!cube) reflectionCubes.delete(graphicID);
        return cube;
      }));
  }
  return reflectionCubes.get(graphicID)!;
}

async function buildTunnel(): Promise<Tunnel | null> {
  definition ??= fetch("/client-assets/wormholeTransit.json").then(async (response) => {
    if (!response.ok) throw new Error("Wormhole transition assets are unavailable");
    return ((await response.json()) as { root: SofChildNode }).root;
  }).catch((error) => { definition = null; throw error; });
  const object = await effectObject(await definition, {});
  let material: THREE.ShaderMaterial | null = null;
  object?.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material.name === WORMHOLE_TRANSIT_MATERIAL) {
      material = mesh.material as THREE.ShaderMaterial;
      mesh.renderOrder = 1_000;
    }
  });
  return object && material ? { object, material } : null;
}

function release(tunnel: Tunnel | null): void {
  if (!tunnel) return;
  tunnel.object.removeFromParent();
  animators.delete(tunnel.object.userData.animatorKey as string);
  tunnel.material.dispose();
}

/** The camera-relative effect survives the ballpark change and plays out over the arrival scene. */
export class WormholeTransit {
  private prepared: Promise<Tunnel | null> | null = null;
  private flight: Flight | null = null;

  constructor(private readonly scene: THREE.Scene) {}

  preload(nebulaID: number): void {
    this.prepared ??= buildTunnel().catch(() => null);
    void reflectionFor(nebulaID);
  }

  begin(now: number, source: THREE.Texture | null, nebulaID: number, triglavian: boolean): void {
    this.clear();
    const flight: Flight = { at: now, source, far: null, triglavian, tunnel: null, started: false, middle: false, stopped: false };
    this.flight = flight;
    const prepared = this.prepared;
    this.prepared = null;
    void reflectionFor(nebulaID).then((cube) => { flight.far = cube; });
    void Promise.resolve(prepared).then((tunnel) => tunnel ?? buildTunnel()).then((tunnel) => {
      if (!tunnel) return;
      if (this.flight !== flight) { release(tunnel); return; }
      flight.tunnel = tunnel;
      this.scene.add(tunnel.object);
      if (flight.triglavian) playEffectSet(tunnel.object, "destination_tspace");
    }).catch((error: unknown) => { console.warn("Wormhole transition:", error); });
  }

  update(now: number, stopped: boolean, quality: number, sun: THREE.Vector3): void {
    const flight = this.flight;
    const tunnel = flight?.tunnel;
    if (!flight || !tunnel) return;
    const since = now - flight.at;
    const { object, material } = tunnel;
    const u = material.uniforms;
    const source = flight.source ?? flight.far;
    u.sourceNebula!.value = source;
    u.destinationNebula!.value = flight.far ?? source;
    u.lowQuality!.value = quality === 1;
    (u.sunDirection!.value as THREE.Vector3).copy(sun);
    material.visible = source !== null && u.specularMap!.value !== null &&
      (quality === 1 ? u.diffuseMap!.value !== null : u.normalMap!.value !== null);
    if (!flight.started && since >= WORMHOLE_START_MS) {
      playEffectSet(object, "start");
      flight.started = true;
    }
    if (!flight.middle && since >= WORMHOLE_MIDDLE_MS) {
      playEffectSet(object, "middle");
      flight.middle = true;
    }
    if (stopped && flight.middle && !flight.stopped) {
      stopEffectSet(object, "start");
      playEffectSet(object, "stop");
      flight.stopped = true;
    }
  }

  clear(): void {
    release(this.flight?.tunnel ?? null);
    this.flight = null;
  }

  dispose(): void {
    this.clear();
    void this.prepared?.then(release);
    this.prepared = null;
  }
}
