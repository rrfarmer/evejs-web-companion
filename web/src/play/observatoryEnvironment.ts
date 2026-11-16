import * as THREE from "three";
import type { EnvironmentBloom } from "../three/bloom.ts";
import { loadDds, loadDds3D } from "../three/ddsTexture.ts";

const ENVIRONMENT_ANCHOR_TYPE = 49106;

interface Position { x: number; y: number; z: number }
interface Anchor { itemID: number; typeID: number | null; position: Position }

interface Template {
  anchor: number;
  activationRadius: number;
  distanceField: {
    minDistance: number;
    maxDistance: number;
    timeAdjustmentSecondsIn: number;
    timeAdjustmentSecondsOut: number;
  };
  postProcess: {
    ranges: { bloom: [min: number, max: number] };
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
  private influence = 0;

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
      this.influence = 0;
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
    const { minDistance, maxDistance, timeAdjustmentSecondsIn, timeAdjustmentSecondsOut } = template.distanceField;
    if (this.anchorID !== anchor.itemID) {
      this.anchorID = anchor.itemID;
      this.influence = 0;
    }
    // The installed EveDistanceField generates a linear DistanceCurve between these two authored keys.
    const target = 1 - THREE.MathUtils.clamp((distance - minDistance) / (maxDistance - minDistance), 0, 1);
    const seconds = target > this.influence ? timeAdjustmentSecondsIn : timeAdjustmentSecondsOut;
    const step = dt / seconds;
    this.influence = THREE.MathUtils.clamp(target, this.influence - step, this.influence + step);
    const { bloom, ranges, lut: grading } = template.postProcess;
    return {
      luminanceThreshold: bloom.luminanceThreshold,
      luminanceScale: bloom.luminanceScale,
      brightness: THREE.MathUtils.lerp(...ranges.bloom, this.influence),
      grime,
      grimeWeight: bloom.grimeWeight * this.influence,
      lut,
      lutInfluence: grading.influence * this.influence,
    };
  }
}
