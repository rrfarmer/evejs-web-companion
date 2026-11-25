import * as THREE from "three";
import type { SpaceVector } from "../store/types.ts";
import { animators } from "../three/childAnimation.ts";
import { setControllerVariable } from "../three/controllerVariables.ts";
import { effectObject, setEffectShaderQuality, type SofChildNode } from "../three/hullChildren.ts";
import { JUMP_TUNNEL_MATERIAL } from "../three/jumpTunnelMaterial.ts";
import { playUiEvent } from "./uiAudio.ts";

interface Tunnel {
  object: THREE.Object3D;
  surface: THREE.ShaderMaterial;
  materials: Set<THREE.Material>;
}

interface Graphic {
  root: SofChildNode | null;
  childEffects: Record<string, SofChildNode | null>;
}

export interface RegionalWarp {
  position: SpaceVector;
  point: SpaceVector;
  preparing: boolean;
  multiplier: number;
}

function release(object: THREE.Object3D, materials: Set<THREE.Material>): void {
  object.removeFromParent();
  const key = object.userData.animatorKey as string | undefined;
  if (key) animators.delete(key);
  for (const material of materials) material.dispose();
}

/** A system can replace the legacy tunnel with an installed effect graph (Warp.Prepare). */
export class RegionalWarpTunnel {
  private graphicID: number | undefined;
  private definition: Promise<Graphic> | null = null;
  private prepared: Promise<void> | null = null;
  private tunnel: Tunnel | null = null;
  private initialDistanceSquared = 0;
  private progress = 0;
  private readonly axis = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  private readonly angles = new THREE.Euler(0, 0, 0, "YXZ");

  constructor(private readonly parent: THREE.Group) {}

  setGraphic(graphicID: number | undefined): void {
    if (graphicID === this.graphicID) return;
    this.dispose();
    this.graphicID = graphicID;
    if (!graphicID) return;
    this.definition = fetch(`/client-assets/effect/${graphicID}.json`).then(async (response) => {
      if (!response.ok) throw new Error(`Regional warp graphic ${graphicID}: HTTP ${response.status}`);
      return await response.json() as Graphic;
    });
    this.prepare();
  }

  private prepare(): void {
    const definition = this.definition;
    if (!definition || this.prepared) return;
    this.prepared = definition.then(async ({ root, childEffects }) => {
      const object = root && await effectObject(root, childEffects, (event) => { void playUiEvent(event); });
      if (!object) return;
      let surface: THREE.ShaderMaterial | undefined;
      const materials = new Set<THREE.Material>();
      object.traverse((child) => {
        child.raycast = () => {};
        const material = (child as THREE.Mesh).material;
        if (material instanceof THREE.Material && child.name !== "child-modifiers" && !child.userData.gpuEmitterKey) {
          materials.add(material);
        }
        if (material instanceof THREE.ShaderMaterial && material.name === JUMP_TUNNEL_MATERIAL) surface = material;
      });
      if (!surface || !(await surface.userData.ready as boolean) || this.definition !== definition) {
        release(object, materials);
        return;
      }
      object.name = "regionalWarpTunnel";
      object.visible = false;
      this.tunnel = { object, surface, materials };
      this.parent.add(object);
    }).catch((error: unknown) => { console.warn("Regional warp tunnel:", error); });
  }

  update(flight: RegionalWarp | null, share: number, quality: 1 | 2 | 3): boolean {
    const tunnel = this.tunnel;
    if (!tunnel) return false;
    const { object, surface } = tunnel;
    if (!flight) {
      if (object.visible) {
        object.visible = false;
        release(object, tunnel.materials);
        this.tunnel = null;
        this.prepared = null;
        this.prepare();
      }
      this.progress = 0;
      return false;
    }
    const { position, point, multiplier } = flight;
    this.axis.set(position.x - point.x, position.y - point.y, point.z - position.z);
    const distanceSquared = this.axis.lengthSq();
    if (!object.visible) {
      if (flight.preparing || distanceSquared === 0) return false;
      this.initialDistanceSquared = distanceSquared;
      this.axis.normalize();
      this.side.set(0, 1, 0).cross(this.axis);
      if (this.side.lengthSq() < 1e-10) this.side.set(1, 0, 0).cross(this.axis);
      this.side.normalize();
      this.up.crossVectors(this.axis, this.side);
      this.basis.makeBasis(this.side, this.up, this.axis);
      this.angles.setFromRotationMatrix(this.basis);
      this.angles.x -= Math.PI;
      object.quaternion.setFromEuler(this.angles);
      setControllerVariable(object, "warpSpeedModifier", multiplier);
      setControllerVariable(object, "shortWarp", distanceSquared < 15_000_000 ** 2 ? 1 : 0);
      this.progress = 0.01;
      object.visible = true;
    }
    this.progress = this.progress > 0.5 && share < 0.00001 ? 1
      : Math.max(this.progress, 1 - distanceSquared / this.initialDistanceSquared);
    setControllerVariable(object, "TravelTunnelProgress", this.progress);
    setEffectShaderQuality(object, quality);
    surface.uniforms.steps!.value = quality === 1 ? 4 : 10;
    return true;
  }

  dispose(): void {
    if (this.tunnel) release(this.tunnel.object, this.tunnel.materials);
    this.tunnel = null;
    this.definition = null;
    this.prepared = null;
    this.graphicID = undefined;
    this.progress = 0;
  }
}
