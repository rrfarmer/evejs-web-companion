import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadDds, loadDds3D } from "../three/ddsTexture.ts";
import type { TypeModelInfo } from "../three/hullModel.ts";
import type { DScanRow } from "./dscan.ts";
import { playUiEvent } from "./uiAudio.ts";

interface HologramVariant {
  textures: { LayerAllMap: string; LayerMaskMap: string };
  parameters: Record<string, number[]>;
}
interface HologramAssets {
  variant: HologramVariant;
  volume: THREE.Data3DTexture;
  mask: THREE.Texture;
}
interface Hull {
  node: THREE.Object3D;
  radius: number;
}
interface Hologram {
  model: THREE.Object3D;
  material: THREE.ShaderMaterial;
  at: THREE.Vector3;
  size: number;
}
interface Wave {
  startsAt: number;
  models: Hologram[];
  direction: THREE.Vector3;
  hover: boolean;
  started: boolean;
}

const loader = new GLTFLoader();
const hulls = new Map<number, Promise<Hull | null>>();
let assets: Promise<HologramAssets> | null = null;

async function loadAssets(): Promise<HologramAssets> {
  const response = await fetch("/client-assets/dscanHologram.json");
  if (!response.ok) throw new Error("Directional scan hologram assets are unavailable");
  const variant = await response.json() as HologramVariant;
  const [volume, mask] = await Promise.all([loadDds3D(variant.textures.LayerAllMap), loadDds(variant.textures.LayerMaskMap)]);
  mask.wrapS = mask.wrapT = THREE.RepeatWrapping;
  mask.needsUpdate = true;
  return { variant, volume, mask };
}

function loadHull(typeID: number): Promise<Hull | null> {
  if (!hulls.has(typeID)) {
    hulls.set(typeID, fetch(`/client-assets/type/${typeID}`).then(async (response) => {
      if (!response.ok) throw new Error("Directional scan hull is unavailable");
      const info = await response.json() as TypeModelInfo;
      if (!info.model) return null;
      const [gltf, sof] = await Promise.all([
        loader.loadAsync(info.model),
        info.sof ? fetch(info.sof).then((r) => r.ok ? r.json() as Promise<{ boundingSphere?: number[] }> : null) : null,
      ]);
      const node = gltf.scene.children[0]?.children[0];
      if (!node) return null;
      const radius = sof?.boundingSphere?.[3] || new THREE.Box3().setFromObject(node).getBoundingSphere(new THREE.Sphere()).radius;
      return radius > 0 ? { node, radius } : null;
    }).catch(() => {
      hulls.delete(typeID);
      return null;
    }));
  }
  return hulls.get(typeID)!;
}

// fx3dv5.sm_hi, Main. Model coordinates are normalized by the authored hull sphere.
// The volumes use different channels and swizzles. The radial mask adds FxColor independently of the grid.
function materialFor(data: HologramAssets, radius: number): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    grid: { value: data.volume }, maskMap: { value: data.mask }, radius: { value: radius },
    time: { value: 0 }, activation: { value: 0 },
  };
  for (const [name, values] of Object.entries(data.variant.parameters)) uniforms[name] = { value: new THREE.Vector4().fromArray(values) };
  return new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, toneMapped: false,
    vertexShader: `
      uniform float radius;
      varying vec3 hullPoint;
      varying vec3 viewNormal;
      varying vec3 viewToEye;
      void main() {
        hullPoint = position * vec3(1.0, 1.0, -1.0) / radius;
        viewNormal = normalize(normalMatrix * normal);
        vec4 at = modelViewMatrix * vec4(position, 1.0);
        viewToEye = normalize(-at.xyz);
        gl_Position = projectionMatrix * at;
      }
    `,
    fragmentShader: `
      precision highp sampler3D;
      uniform sampler3D grid;
      uniform sampler2D maskMap;
      uniform float time, activation;
      uniform vec4 FresnelFactors, Layer1Transform, Layer1Scroll, Layer2Transform, Layer2Scroll;
      uniform vec4 Layer3Transform, Layer3Scroll, Layer3Center, BaseColor, FxColor;
      varying vec3 hullPoint;
      varying vec3 viewNormal;
      varying vec3 viewToEye;
      void main() {
        vec3 uv1 = hullPoint * Layer1Transform.x + Layer1Transform.yzw + Layer1Scroll.yzw + fract(Layer1Scroll.x * time);
        vec3 uv2 = hullPoint * Layer2Transform.x + Layer2Transform.yzw + Layer2Scroll.yzw + fract(Layer2Scroll.x * time);
        float lattice = texture(grid, uv1).r * texture(grid, uv2).g;
        vec2 uv3 = length(hullPoint - Layer3Center.xyz) * Layer3Transform.xy + Layer3Transform.zw
          + Layer3Scroll.zw + fract(Layer3Scroll.xy * time);
        vec4 mask = texture(maskMap, uv3);
        vec4 color = (BaseColor * vec4(mask.rgb, 1.0) * lattice + mask.a * FxColor) * activation;
        float fresnel = pow(1.0 - clamp(dot(normalize(viewNormal), viewToEye) - FresnelFactors.z, 0.0, 1.0), FresnelFactors.x);
        color.rgb *= FresnelFactors.y >= 0.0 ? fresnel * FresnelFactors.y : (1.0 - min(fresnel, 1.0)) * -FresnelFactors.y;
        gl_FragColor = color;
        #include <colorspace_fragment>
      }
    `,
  });
}

export class ScanHolograms {
  readonly root = new THREE.Group();
  private previous = new Set<number>();
  private radii = new Map<number, number | null>();
  private waves: Wave[] = [];
  private generation = 0;

  constructor(private readonly readRadii?: (ids: readonly number[]) => Promise<Record<string, number>>) {}

  reset(): void { this.clear(); this.previous.clear(); }

  clear(): void {
    this.generation += 1;
    for (const wave of this.waves) for (const item of wave.models) item.material.dispose();
    this.root.clear();
    this.waves = [];
  }

  private async rememberRadii(ids: readonly number[]): Promise<void> {
    if (!this.readRadii) return;
    const missing = [...new Set(ids)].filter((id) => !this.radii.has(id));
    for (let first = 0; first < missing.length; first += 200) {
      const batch = missing.slice(first, first + 200);
      const radii = await this.readRadii(batch);
      for (const id of batch) this.radii.set(id, radii[id] ?? null);
    }
  }

  scanned(rows: readonly DScanRow[], origin: THREE.Vector3, direction: THREE.Vector3, range: number): void {
    const fresh = rows.filter((row) => !this.previous.has(row.id)).map((row) => row.typeID);
    this.previous = new Set(rows.map((row) => row.id));
    if (fresh.length) void this.prepare(fresh, origin, direction, range, false);
  }

  hover(typeID: number | null, origin: THREE.Vector3, direction: THREE.Vector3, range: number): void {
    if (typeID === null) this.clear();
    else void this.prepare([typeID], origin, direction, range, true);
  }

  private async prepare(ids: number[], origin: THREE.Vector3, direction: THREE.Vector3, range: number, hover: boolean): Promise<void> {
    const generation = ++this.generation;
    const scanStart = performance.now();
    try {
      await this.rememberRadii(ids);
      const sorted = ids.flatMap((id) => {
        const radius = this.radii.get(id);
        return radius == null ? [] : [{ id, radius }];
      }).sort((a, b) => b.radius - a.radius);
      if (generation !== this.generation || !sorted.length) return;
      this.clear();
      const pending = this.generation;
      const groups: number[][] = [];
      for (let i = 0; i < sorted.length && groups.length < 3;) {
        const radius = sorted[i]!.radius;
        const count = radius > 2000 ? 1 : radius > 240 ? 3 : 5;
        groups.push(sorted.slice(i, i + count).map((item) => item.id));
        i += count;
      }
      const [data, models] = await Promise.all([
        assets ??= loadAssets().catch((error: unknown) => { assets = null; throw error; }),
        Promise.all(groups.map((group) => Promise.all(group.map(loadHull)))),
      ]);
      if (pending !== this.generation) return;
      const right = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 1, 0));
      if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
      right.normalize();
      const up = new THREE.Vector3().crossVectors(direction, right).normalize();
      const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
      const orbit = new THREE.Euler().setFromQuaternion(rotation, "YXZ");
      orbit.z = 0;
      const first = Math.max(scanStart + (hover ? 0 : 500), performance.now());
      for (const [index, group] of models.entries()) {
        const ready = group.filter((hull): hull is Hull => hull !== null);
        const wave = ready.map((hull, i) => {
          const model = hull.node.clone(true);
          const material = materialFor(data, hull.radius);
          model.traverse((node) => { if (node instanceof THREE.Mesh) node.material = material; });
          model.rotation.copy(orbit);
          const radius = Math.max(18, hull.radius);
          const at = origin.clone().addScaledVector(direction, 13 + radius + range);
          if (ready.length > 1) {
            const angle = i / ready.length * 2 * Math.PI;
            const offset = 10 + 0.8 * radius;
            at.addScaledVector(right, offset * Math.cos(angle)).addScaledVector(up, offset * Math.sin(angle));
          }
          model.visible = false;
          this.root.add(model);
          return { model, material, at, size: 3.5 / hull.radius ** 0.6 };
        });
        if (wave.length) this.waves.push({ startsAt: first + index * 500, models: wave, direction, hover, started: false });
      }
    } catch {
      // A missing native resource cannot produce a hologram. The scan results remain available.
    }
  }

  update(now: number): void {
    this.waves = this.waves.filter((wave) => {
      const elapsed = (now - wave.startsAt) / 1000;
      if (elapsed < 0) return true;
      if (!wave.started) {
        wave.started = true;
        if (!wave.hover) void playUiEvent("msg_newscan_directional_scan_hologram_appear_play");
      }
      if (!wave.hover && elapsed >= 0.65) {
        for (const item of wave.models) { item.model.removeFromParent(); item.material.dispose(); }
        return false;
      }
      const gone = wave.hover ? 0 : THREE.MathUtils.clamp((elapsed - 0.5) / 0.15, 0, 1);
      const strength = elapsed < 0.3 ? 2 - 0.7 * ((elapsed % 0.15) / 0.15) : 1.3;
      for (const item of wave.models) {
        item.model.visible = true;
        item.model.position.copy(item.at);
        if (!wave.hover) item.model.position.addScaledVector(wave.direction, 5 * Math.max(0, 1 - elapsed / 0.1) - gone * 30);
        item.model.scale.setScalar(item.size * Math.min(1, elapsed / 0.05) * (1 - gone));
        item.material.uniforms.time!.value = now / 1000;
        item.material.uniforms.activation!.value = gone > 0 ? 2 * (1 - gone) : strength;
      }
      return true;
    });
  }
}
