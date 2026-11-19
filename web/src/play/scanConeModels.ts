import * as THREE from "three";
import { animators, HULL_OWNER, type ChildAnimator, type SofCurveSet } from "../three/childAnimation.ts";
import { effectObject, type SofChildContainer, type SofChildNode } from "../three/hullChildren.ts";
import { loadDds } from "../three/ddsTexture.ts";

export type ScanConeKind = "cone" | "half" | "sphere";
interface ConeAsset {
  root: SofChildContainer;
  childEffects: Record<string, SofChildNode | null>;
}
interface ScanStage {
  id: number;
  duration: number;
}
interface ConeModel {
  object: THREE.Object3D;
  holder: THREE.Group;
  authoredScale: number;
  animator: ChildAnimator;
  first: ScanStage;
  second: ScanStage;
}

function readStage(animator: ChildAnimator, sets: readonly SofCurveSet[], name: string): ScanStage | null {
  const id = sets.find((set) => set.name === name)?.id;
  const duration = animator.duration(HULL_OWNER, name);
  return id !== undefined && duration > 0 ? { id, duration } : null;
}

/** The three EveTransform resources used by MapViewDirectionalScanHandler. */
export class ScanConeModels {
  readonly root = new THREE.Group();
  lineTexture: THREE.Texture | null = null;
  private readonly models = new Map<ScanConeKind, ConeModel>();
  private startedAt: number | null = null;
  private previousAt: number | null = null;
  private requested = false;
  private disposed = false;

  private async load(): Promise<void> {
    this.requested = true;
    try {
      const response = await fetch("/client-assets/dscanCones.json");
      if (!response.ok) return;
      const { lineTexture, shapes } = await response.json() as { lineTexture: string; shapes: Record<ScanConeKind, ConeAsset> };
      void loadDds(lineTexture).then((texture) => {
        if (this.disposed) { texture.dispose(); return; }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 16;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        this.lineTexture = texture;
      }).catch(() => {});
      await Promise.all((Object.keys(shapes) as ScanConeKind[]).map(async (kind) => {
        const { root, childEffects } = shapes[kind];
        const authoredScale = root.s?.[0];
        if (!authoredScale) return;
        const object = await effectObject(root, childEffects);
        if (!object) return;
        const animator = animators.get(object.userData.animatorKey as string);
        const first = animator && readStage(animator, root.curveSets ?? [], "ScanPart_01");
        const second = animator && readStage(animator, root.curveSets ?? [], "ScanPart_02");
        if (this.disposed || !animator || !first || !second) {
          this.release(object);
          return;
        }
        const holder = new THREE.Group();
        holder.name = `dscan-${kind}`;
        holder.visible = false;
        holder.add(object);
        this.root.add(holder);
        this.models.set(kind, { object, holder, authoredScale, animator, first, second });
      }));
    } catch {
      // The geometric fallback remains available when the local cache has no authored model.
    }
  }

  scan(now: number): void {
    this.previousAt = this.startedAt;
    this.startedAt = now;
  }

  update(kind: ScanConeKind, length: number, radius: number): boolean {
    if (!this.requested) void this.load();
    for (const [name, model] of this.models) model.holder.visible = name === kind;
    const model = this.models.get(kind);
    if (!model) return false;
    const { holder, authoredScale, object, animator, first, second } = model;
    if (kind === "cone") {
      // The cone mesh is one unit high and half a unit wide. The map holder's +Y is the scan direction.
      holder.scale.set(2 * radius / authoredScale, length / authoredScale, 2 * radius / authoredScale);
    } else {
      // ShowHalfSphere and ShowSphere negate the runtime scale. After mirroring, the authored hemisphere
      // faces +Z, which this rotation turns onto the map holder's +Y.
      holder.scale.setScalar(-radius / authoredScale);
      holder.rotation.x = -Math.PI / 2;
    }
    if (this.startedAt !== null) {
      const now = performance.now();
      const elapsed = (now - this.startedAt) / 1000;
      animator.applyTime(first.id, Math.min(elapsed, first.duration), object);
      const secondAt = elapsed >= first.duration ? this.startedAt : this.previousAt;
      if (secondAt !== null) {
        animator.applyTime(second.id, THREE.MathUtils.clamp((now - secondAt) / 1000 - first.duration, 0, second.duration), object);
      }
    }
    return true;
  }

  private release(object: THREE.Object3D): void {
    animators.delete(object.userData.animatorKey as string);
    const materials = new Set<THREE.ShaderMaterial>();
    object.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.ShaderMaterial) materials.add(o.material);
    });
    for (const material of materials) material.dispose();
  }

  dispose(): void {
    this.disposed = true;
    for (const { object } of this.models.values()) this.release(object);
    this.models.clear();
    this.root.clear();
    this.lineTexture?.dispose();
  }
}

/** Lines3DPlanar offsets the ribbon in its local XZ plane before the map's world transform. */
export function scanConeLines(angle: number, range: number, au: number, width: number, texture: THREE.Texture | null) {
  const positions: number[] = [], uvs: number[] = [], edgeFractions: number[] = [];
  const strengths: number[] = [], indices: number[] = [];
  const strip = (
    segments: number, halfWidth: number, pointAt: (t: number) => THREE.Vector3,
    startStrength: number, endStrength: number,
  ) => {
    const points = Array.from({ length: segments + 1 }, (_, i) => pointAt(i / segments));
    const edges = points.map((point, i) => {
      const tangent = points[Math.min(i + 1, segments)]!.clone().sub(points[Math.max(i - 1, 0)]!);
      const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize().multiplyScalar(halfWidth);
      return [point.clone().sub(side), point.clone().add(side)];
    });
    for (let i = 0; i < segments; i++) {
      const a = positions.length / 3;
      for (const edge of [...edges[i]!, ...edges[i + 1]!]) positions.push(edge.x, edge.y, edge.z);
      uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
      const start = THREE.MathUtils.lerp(startStrength, endStrength, i / segments);
      const end = THREE.MathUtils.lerp(startStrength, endStrength, (i + 1) / segments);
      strengths.push(start, start, end, end);
      // The planar texture rounds the ends of each segment using its length in the ribbon plane.
      const from = points[i]!, to = points[i + 1]!;
      const length = Math.hypot(to.x - from.x, to.z - from.z);
      const edge = halfWidth / (length + 2 * halfWidth);
      edgeFractions.push(edge, edge, edge, edge);
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  };
  const half = angle / 2;
  let rings = 0;
  for (let distance = au; distance < range; distance += 2 * au) {
    const radius = distance * Math.sin(half), elevation = distance * Math.cos(half);
    strip(360, width, (u) => new THREE.Vector3(radius * Math.cos(u * Math.PI * 2), elevation, radius * Math.sin(u * Math.PI * 2)), 1, 1);
    rings += 1;
  }
  // DrawConeSphereLineSegments uses eight arcs with a coloured midpoint at 0.25 × the full angle.
  const capWidth = width * angle * 3 * range / (14.3 * au);
  for (let i = 0; i < 8; i++) {
    const azimuth = i / 8 * Math.PI * 2;
    const capPoint = (fraction: number) => {
      const polar = angle * fraction, rad = range * Math.sin(polar);
      return new THREE.Vector3(rad * Math.cos(azimuth), range * Math.cos(polar), rad * Math.sin(azimuth));
    };
    strip(20, capWidth, (u) => capPoint(THREE.MathUtils.lerp(0.04, 0.25, u)), 0, 1);
    strip(20, capWidth, (u) => capPoint(THREE.MathUtils.lerp(0.25, 0.45, u)), 1, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("edgeFraction", new THREE.Float32BufferAttribute(edgeFractions, 1));
  geometry.setAttribute("strength", new THREE.Float32BufferAttribute(strengths, 1));
  geometry.setIndex(indices);
  const material = new THREE.ShaderMaterial({
    uniforms: { lineMap: { value: texture }, textured: { value: texture !== null } },
    vertexShader: `
      attribute float strength;
      attribute float edgeFraction;
      varying vec2 lineUv;
      varying float fade;
      varying float edge;
      void main() {
        lineUv = uv;
        fade = strength;
        edge = edgeFraction;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D lineMap;
      uniform bool textured;
      varying vec2 lineUv;
      varying float fade;
      varying float edge;
      void main() {
        float along = lineUv.y;
        float ends = max(edge, 0.00001);
        float textureY = 0.5 * (clamp(along / ends, 0.0, 1.0) + clamp((along - (1.0 - ends)) / ends, 0.0, 1.0));
        vec4 profile = textured ? texture2D(lineMap, vec2(lineUv.x, textureY)) : vec4(1.0 - abs(lineUv.x * 2.0 - 1.0));
        gl_FragColor = profile * vec4(57.0 / 255.0, 191.0 / 255.0, 128.0 / 255.0, 1.0) * fade;
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide, transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  });
  return { mesh: new THREE.Mesh(geometry, material), rings };
}
