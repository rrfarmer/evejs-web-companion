import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { prepareScalar, scalarAt, type ScalarCurve } from "../three/curves.ts";
import { loadDds } from "../three/ddsTexture.ts";
import { warpTunnelMaterial, type WarpTunnelPass } from "../three/warpTunnelMaterial.ts";

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
}

interface WarpSurface {
  root: THREE.Group;
  geometry: THREE.BufferGeometry;
  materials: THREE.ShaderMaterial[];
  textures: Map<string, THREE.Texture>;
  intensity: ScalarCurve;
  keys: ReturnType<typeof prepareScalar>;
}

async function loadWarpSurface(): Promise<WarpSurface> {
  const response = await fetch("/client-assets/warpTunnel.json");
  if (!response.ok) throw new Error(`Warp tunnel assets: HTTP ${response.status}`);
  const definition = await response.json() as WarpTunnelDefinition;
  const urls = new Set([...Object.values(definition.transparent.textures), ...Object.values(definition.additive.textures)]);
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
    warpTunnelMaterial(definition.transparent, textures, false),
    warpTunnelMaterial(definition.additive, textures, true),
  ];
  materials.forEach((material, i) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "warpTunnel";
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.renderOrder = -0.75 + 0.25 * i;
    mesh.scale.fromArray(definition.scale);
    mesh.quaternion.set(-x, -y, z, w);
    root.add(mesh);
  });
  root.visible = false;
  const intensity = definition.intensity;
  return { root, geometry, materials, textures, intensity, keys: prepareScalar(intensity) };
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
    const multiplier = typeMultiplier !== null && Number.isFinite(typeMultiplier) && typeMultiplier > 0 ? typeMultiplier : 1;
    return warping ? Math.min(1, Math.max(0, speed / (3 * AU * multiplier))) : 0;
  }

  update(camera: THREE.Camera, focus: THREE.Vector3, way: THREE.Vector3, warpShare: number, gateShare: number, time: number, dt: number): void {
    const validWay = way.lengthSq() > 0.5;
    const surface = this.surface;
    if (surface) {
      const intensity = scalarAt(surface.intensity, surface.keys, warpShare);
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
      }
    }
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
