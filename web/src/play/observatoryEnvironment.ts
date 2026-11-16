import * as THREE from "three";
import type { EnvironmentBloom } from "../three/bloom.ts";
import type { AuthoredEnvironmentFog } from "../three/environmentFog.ts";
import { loadDds, loadDds3D } from "../three/ddsTexture.ts";

const ENVIRONMENT_ANCHOR_TYPE = 49106;

interface Position { x: number; y: number; z: number }
interface Anchor { itemID: number; typeID: number | null; position: Position }

interface Template {
  anchor: number;
  activationRadius: number;
  distanceField: {
    dimensions: readonly [number, number, number];
    minDistance: number;
    maxDistance: number;
    timeAdjustmentSecondsIn: number;
    timeAdjustmentSecondsOut: number;
  };
  postProcess: {
    ranges: { bloom: [min: number, max: number]; fog: [min: number, max: number] };
    fog: AuthoredEnvironmentFog;
    bloom: { luminanceThreshold: number; luminanceScale: number; grimePath: string; grimeWeight: number };
    lut: { path: string; influence: number };
  };
}

interface Environment {
  template: Template;
  grime: THREE.Texture;
  lut: THREE.Data3DTexture;
}

let assets: Promise<Environment> | null = null;
function loadEnvironment(): Promise<Environment> {
  assets ??= fetch("/client-assets/observatoryEnvironment.json").then(async (response) => {
    if (!response.ok) throw new Error(`Observatory environment: ${response.status}`);
    const template = await response.json() as Template;
    if (template.anchor !== ENVIRONMENT_ANCHOR_TYPE) throw new Error("Unexpected Observatory anchor type");
    const [grime, lut] = await Promise.all([
      loadDds(template.postProcess.bloom.grimePath),
      loadDds3D(template.postProcess.lut.path, THREE.ClampToEdgeWrapping),
    ]);
    grime.colorSpace = THREE.SRGBColorSpace;
    grime.wrapS = grime.wrapT = THREE.ClampToEdgeWrapping;
    grime.needsUpdate = true;
    return { template, grime, lut };
  }).catch((error: unknown) => {
    assets = null;
    throw error;
  });
  return assets;
}

/** The installed environment service adds/removes this template with its Destiny anchor ball. */
export class ObservatoryEnvironment {
  private data: Environment | null = null;
  private requested = false;
  private anchorID: number | null = null;
  private cameraDistance = 0;
  private fogTime = 0;

  private readonly load: () => Promise<Environment>;

  constructor(load = loadEnvironment) {
    this.load = load;
  }

  sample(entities: readonly Anchor[], origin: Position, eye: Position, dt: number, enabled: boolean): EnvironmentBloom | null {
    let anchor: Anchor | null = null;
    let distance = Infinity;
    if (enabled) {
      for (const entity of entities) {
        if (entity.typeID !== ENVIRONMENT_ANCHOR_TYPE) continue;
        const p = entity.position;
        const d = Math.hypot((p.x - origin.x) - eye.x, (p.y - origin.y) - eye.y, (origin.z - p.z) - eye.z);
        if (d < distance) {
          anchor = entity;
          distance = d;
        }
      }
    }
    if (!anchor || (this.data && distance >= this.data.template.activationRadius)) {
      this.anchorID = null;
      this.requested = false;
      this.cameraDistance = 0;
      this.fogTime = 0;
      return null;
    }
    if (!this.data) {
      if (!this.requested) {
        this.requested = true;
        void this.load().then((data) => { this.data = data; }).catch(() => {
          // Retry on the next entry after a failed asset request.
        });
      }
      return null;
    }
    const { template, grime, lut } = this.data;
    const { dimensions, minDistance, maxDistance, timeAdjustmentSecondsIn, timeAdjustmentSecondsOut } = template.distanceField;
    if (this.anchorID !== anchor.itemID) {
      this.anchorID = anchor.itemID;
      this.cameraDistance = maxDistance;
      this.fogTime = 0;
    }
    // EveDistanceField smooths the camera distance before evaluating DistanceCurve.
    const target = Math.min(distance, maxDistance);
    const seconds = target < this.cameraDistance ? timeAdjustmentSecondsIn : timeAdjustmentSecondsOut;
    this.cameraDistance = THREE.MathUtils.lerp(this.cameraDistance, target, Math.min(dt / seconds, 1));
    const influence = 1 - THREE.MathUtils.clamp((this.cameraDistance - minDistance) / (maxDistance - minDistance), 0, 1);

    // PostProcess._DoFogFadeIn uses an independent 1.5 s smoothstep in simulation time.
    this.fogTime = Math.min(this.fogTime + dt, 1.5);
    const fade = this.fogTime / 1.5;
    const { bloom, fog, ranges, lut: grading } = template.postProcess;
    return {
      luminanceThreshold: bloom.luminanceThreshold,
      luminanceScale: bloom.luminanceScale,
      brightness: THREE.MathUtils.lerp(...ranges.bloom, influence),
      grime,
      grimeWeight: bloom.grimeWeight * influence,
      lut,
      lutInfluence: grading.influence * influence,
      fog: {
        settings: fog, dimensions, influence,
        center: { x: anchor.position.x - origin.x, y: anchor.position.y - origin.y, z: origin.z - anchor.position.z },
        amount: THREE.MathUtils.lerp(...ranges.fog, influence),
        intensity: Math.min(fog.intensity ?? 1, fade * fade * (3 - 2 * fade)),
      },
    };
  }
}
