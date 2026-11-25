import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { prepareScalar, scalarAt, type ScalarCurve } from "../three/curves.ts";
import { loadDds } from "../three/ddsTexture.ts";
import { BACKGROUND_DISTORTION_LAYER } from "../three/distortion.ts";
import { warpTunnelMaterial, type WarpTunnelPass } from "../three/warpTunnelMaterial.ts";
import type { WarpPlanetFade } from "./warpPlanetCrossings.ts";

const AU = 149_597_870_700;
export const WARP_SPEED_MULTIPLIER_ATTRIBUTE = 600;
const STREAKS = 700;

interface WarpTunnelDefinition {
  model: string;
  scale: [number, number, number];
  rotation: [number, number, number, number];
  intensity: ScalarCurve;
  transparent: WarpTunnelPass;
  additive: WarpTunnelPass;
  distortion?: WarpTunnelPass;
}

interface WarpSurface {
  root: THREE.Group;
  geometry: THREE.BufferGeometry;
  materials: THREE.ShaderMaterial[];
  textures: Map<string, THREE.Texture>;
  distortion: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
  diffuse: THREE.Vector4;
  intensity: ScalarCurve;
  keys: ReturnType<typeof prepareScalar>;
}

async function loadWarpSurface(): Promise<WarpSurface> {
  const response = await fetch("/client-assets/warpTunnel.json");
  if (!response.ok) throw new Error(`Warp tunnel assets: HTTP ${response.status}`);
  const definition = await response.json() as WarpTunnelDefinition;
  const urls = new Set([
    ...Object.values(definition.transparent.textures), ...Object.values(definition.additive.textures),
    ...Object.values(definition.distortion?.textures ?? {}),
  ]);
  const [gltf, entries] = await Promise.all([
    new GLTFLoader().loadAsync(definition.model),
    Promise.all(Array.from(urls, async (url) => [url, await loadDds(url)] as const)),
  ]);
  const textures = new Map(entries);
  let geometry: THREE.BufferGeometry | undefined;
  gltf.scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    if (!geometry) geometry = node.geometry;
    else if (node.geometry !== geometry) node.geometry.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
  });
  if (!geometry) throw new Error("Warp tunnel mesh is missing");

  const root = new THREE.Group();
  const [x, y, z, w] = definition.rotation;
  const materials = [
    warpTunnelMaterial(definition.transparent, textures, "transparent"),
    warpTunnelMaterial(definition.additive, textures, "additive"),
  ];
  if (definition.distortion) materials.push(warpTunnelMaterial(definition.distortion, textures, "distortion"));
  let distortion: WarpSurface["distortion"] = null;
  materials.forEach((material, i) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "warpTunnel";
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.renderOrder = -0.75 + 0.25 * i;
    mesh.scale.fromArray(definition.scale);
    mesh.quaternion.set(-x, -y, z, w);
    if (material.name === "WarpTunnelDistortion") {
      mesh.layers.set(BACKGROUND_DISTORTION_LAYER);
      distortion = mesh;
    }
    root.add(mesh);
  });
  root.visible = false;
  const intensity = definition.intensity;
  const diffuse = materials[0]!.uniforms.Diffuse!.value.clone() as THREE.Vector4;
  return { root, geometry, materials, textures, distortion, diffuse, intensity, keys: prepareScalar(intensity) };
}

export class WarpTunnel {
  readonly object = new THREE.Group();
  private readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly material: THREE.LineBasicMaterial;
  /** Each streak: its angle round the way, its distance from it (share of the camera's), where it is along it (-1..1). */
  private readonly streaks: { angle: number; radius: number; along: number }[] = [];
  private readonly across = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  private surface: WarpSurface | null = null;
  private disposed = false;
  private shown = 0;
  private previousTime = 0;

  constructor() {
    this.positions = new Float32Array(STREAKS * 2 * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.LineBasicMaterial({ color: 0xbcd6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.lines = new THREE.LineSegments(geometry, this.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.lines.name = "warpTunnel";
    this.object.add(this.lines);
    for (let i = 0; i < STREAKS; i++) this.streaks.push({ angle: Math.random() * Math.PI * 2, radius: 0.35 + Math.random() ** 0.6 * 3.5, along: Math.random() * 2 - 1 });
    void loadWarpSurface().then((surface) => {
      if (this.disposed) {
        this.releaseSurface(surface);
        return;
      }
      this.surface = surface;
      this.object.add(surface.root);
    }).catch((error: unknown) => { console.warn("Warp tunnel:", error); });
  }

  /** The tunnel's strength for a speed in metres a second while warping (0 when not warping): the client's binding. */
  static share(warping: boolean, speed: number, typeMultiplier: number | null): number {
    return warping ? Math.min(1, Math.max(0, speed / (3 * AU * WarpTunnel.multiplier(typeMultiplier)))) : 0;
  }

  static multiplier(value: number | null): number {
    return value !== null && Number.isFinite(value) && value > 0 ? value : 1;
  }

  intensity(share: number): number {
    const surface = this.surface;
    return surface ? scalarAt(surface.intensity, surface.keys, share) : 0;
  }

  hasBackgroundDistortion(): boolean {
    return !!this.surface?.root.visible && this.surface.distortion?.visible === true;
  }

  update(camera: THREE.Camera, focus: THREE.Vector3, way: THREE.Vector3, warpShare: number, gateShare: number, time: number, dt: number,
    crossing: WarpPlanetFade): void {
    const validWay = way.lengthSq() > 0.5;
    const surface = this.surface;
    if (surface) {
      const intensity = this.intensity(warpShare);
      surface.root.visible = validWay && intensity > 0.002;
      if (surface.root.visible) {
        // Warp.AlignToDirection and the camera translation modifier, converted into the mirrored scene frame.
        this.across.set(0, 1, 0).cross(way);
        if (this.across.lengthSq() < 1e-10) this.across.set(1, 0, 0).cross(way);
        this.across.normalize();
        this.up.crossVectors(way, this.across);
        surface.root.quaternion.setFromRotationMatrix(this.basis.makeBasis(this.across, this.up, way));
        surface.root.position.copy(camera.position);
        for (const material of surface.materials) {
          material.uniforms.Time!.value = time;
          material.uniforms.MiscFactors2!.value.w = intensity;
        }
        const transparent = surface.materials[0]!.uniforms;
        transparent.MiscFactors2!.value.x = crossing.leaving;
        transparent.MiscFactors2!.value.z = crossing.entering;
        // _Setup_ binds the color curve to both caps and the flash curve to their scale.
        const { brightness, tint } = crossing;
        transparent.BlueShiftColor!.value.set(0.33 + 0.313 * tint, 0.71 + 0.117 * tint, 1, 0.3 - 0.05 * tint).multiplyScalar(brightness);
        transparent.RedShiftColor!.value.set(1 - 0.5 * tint, 0.46 - 0.154 * tint, 0.294 - 0.054 * tint, 0.22 - 0.032 * tint).multiplyScalar(brightness);
        const colorScale = (0.2 + 0.298014 * brightness) / (0.2 + 0.298014 * 0.6);
        transparent.Diffuse!.value.copy(surface.diffuse).multiplyScalar(colorScale);
        const additive = surface.materials[1]!.uniforms;
        additive.MiscFactors2!.value.x = brightness;
        additive.MiscFactors3!.value.x = crossing.entering;
        additive.MiscFactors3!.value.y = crossing.leaving;
        if (surface.distortion) {
          const uniforms = surface.distortion.material.uniforms;
          uniforms.MiscFactors2!.value.w = intensity * 8;
          uniforms.PreviousTime!.value = this.previousTime || time;
        }
      }
    }
    this.previousTime = time;
    const lineShare = surface ? gateShare : Math.max(warpShare, gateShare);
    this.shown += (lineShare - this.shown) * Math.min(1, dt * 2);
    this.lines.visible = this.shown >= 0.01 && validWay && !surface?.root.visible;
    if (!this.lines.visible) return;
    this.material.opacity = Math.min(0.85, this.shown * 0.9);
    const d = Math.max(50, camera.position.distanceTo(focus));
    const side = new THREE.Vector3(0, 1, 0).cross(way);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0).cross(way);
    side.normalize();
    const up = way.clone().cross(side).normalize();
    const reach = d * 8, length = d * (0.15 + this.shown * 1.6), rush = (1.2 + this.shown * 6) * dt;
    const centre = camera.position;
    for (let i = 0; i < STREAKS; i++) {
      const s = this.streaks[i]!;
      s.along -= rush;
      if (s.along < -1) { s.along += 2; s.angle = Math.random() * Math.PI * 2; }
      const r = s.radius * d, cx = Math.cos(s.angle) * r, cy = Math.sin(s.angle) * r, a = s.along * reach;
      const o = i * 6;
      const hx = centre.x + side.x * cx + up.x * cy + way.x * a, hy = centre.y + side.y * cx + up.y * cy + way.y * a, hz = centre.z + side.z * cx + up.z * cy + way.z * a;
      this.positions[o] = hx; this.positions[o + 1] = hy; this.positions[o + 2] = hz;
      this.positions[o + 3] = hx - way.x * length; this.positions[o + 4] = hy - way.y * length; this.positions[o + 5] = hz - way.z * length;
    }
    (this.lines.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  private releaseSurface(surface: WarpSurface): void {
    surface.root.removeFromParent();
    surface.geometry.dispose();
    for (const material of surface.materials) material.dispose();
    for (const texture of surface.textures.values()) texture.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.lines.geometry.dispose();
    this.material.dispose();
    if (this.surface) this.releaseSurface(this.surface);
  }
}
