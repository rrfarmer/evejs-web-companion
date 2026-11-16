import * as THREE from "three";
import { OpaqueShadowMask } from "./opaqueShadowMask.ts";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL } from "./softDepth.ts";

// 3698585 Tr2ShadowMap, Static split mode, used at Low and High.
const SPLITS = [25, 75, 150, 300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 76800, 153600, 307200, 614400, 1228800];
const SPLIT_COUNT = SPLITS.length;
const MAX_DEPTH = SPLITS[SPLIT_COUNT - 1]!;
const COLUMNS = 4;
const ATLAS_SIZE = 2048;
const TILE_SIZE = ATLAS_SIZE / COLUMNS;

export const SPACE_SHADOW_GLSL = `
  uniform sampler2D shadowAtlas;
  uniform mat4 viewToShadow[${SPLIT_COUNT}];
  uniform int firstShadowSplit, lastShadowSplit, activeShadowSplits;
  const float shadowSplits[${SPLIT_COUNT}] = float[](${SPLITS.map((depth) => depth.toFixed(1)).join(", ")});

  float spaceShadow(vec3 viewPosition, bool volume) {
    float viewDepth = -viewPosition.z;
    for (int i = firstShadowSplit; i <= lastShadowSplit; i++) {
      if (viewDepth < shadowSplits[i]) {
        if ((activeShadowSplits & (1 << i)) == 0) return 1.0;
        vec3 clip = (viewToShadow[i] * vec4(viewPosition, 1.0)).xyz;
        if (all(lessThanEqual(abs(clip), vec3(1.0)))) {
          vec2 tile = vec2(i % ${COLUMNS}, i / ${COLUMNS});
          vec2 uv = (tile + 0.5 + clip.xy * ${(0.5 - 1 / TILE_SIZE).toFixed(10)}) / ${COLUMNS}.0;
          float casterDepth = texture(shadowAtlas, uv).r;
          float receiverDepth = clip.z * 0.5 + 0.5;
          if (volume) return casterDepth < receiverDepth ? 0.3 : 1.0;
          if (receiverDepth < casterDepth) return 1.0;
          // ShadowDepth.fx fades opaque shadows in the last five percent of the far split.
          return i == ${SPLIT_COUNT - 1} ? clamp((viewDepth - ${(MAX_DEPTH * 0.95).toFixed(1)}) / ${(MAX_DEPTH * 0.05).toFixed(1)}, 0.0, 1.0) : 0.0;
        }
        break;
      }
    }
    return 1.0;
  }
`;

const OPAQUE_RESOLVE_GLSL = SPACE_SHADOW_GLSL + `
  uniform vec4 planetShadowSpheres[2];
  uniform vec3 shadowSunDirection;
  float opaqueSpaceShadow(vec3 viewPosition) {
    // ShadowDepth.sm_depth tests the two analytic spheres before sampling the atlas.
    if (-viewPosition.z > ${MAX_DEPTH.toFixed(1)}) return 1.0;
    for (int i = 0; i < 2; i++) {
      vec4 sphere = planetShadowSpheres[i];
      if (sphere.w <= 0.0) continue;
      vec3 offset = sphere.xyz - viewPosition;
      float along = dot(offset, shadowSunDirection);
      float distanceSquared = dot(offset, offset);
      float radiusSquared = sphere.w * sphere.w;
      if (along < 0.0 && distanceSquared > radiusSquared) continue;
      if (distanceSquared - along * along <= radiusSquared) return 0.0;
    }
    return spaceShadow(viewPosition, false);
  }
`;

export interface ShadowPlanet {
  center: THREE.Vector3;
  radius: number;
}

function shadowUniforms() {
  return {
    shadowAtlas: { value: null as THREE.DepthTexture | null },
    viewToShadow: { value: SPLITS.map(() => new THREE.Matrix4()) },
    firstShadowSplit: { value: 0 }, lastShadowSplit: { value: -1 }, activeShadowSplits: { value: 0 },
  };
}

const OPAQUE_SHADOW_GLSL = `
  ${SOFT_DEPTH_GLSL}
  uniform sampler2D opaqueShadowMask;
  uniform bool opaqueShadowReady;
  float opaqueSunVisibility(vec3 viewPosition) {
    float visibility = 1.0;
    bool matchedDepth = false;
    if (opaqueShadowReady) {
      ivec2 pixel = ivec2(gl_FragCoord.xy);
      float sceneDepth = texelFetch(softDepthMap, pixel, 0).r;
      // At MSAA edges and cutouts the opaque prepass can see a different surface.
      float depth = -viewPosition.z;
      matchedDepth = sceneDepth < 1.0 && abs(softViewDepth(sceneDepth) - depth) <= max(0.01, depth * 0.00005);
      if (matchedDepth) visibility = texelFetch(opaqueShadowMask, pixel, 0).r;
    }
    if (!matchedDepth) visibility = opaqueSpaceShadow(viewPosition);
    return visibility;
  }
`;

const atlasByRenderer = new WeakMap<THREE.WebGLRenderer, Record<string, THREE.IUniform>>();
const shadowCompilers = new WeakSet<THREE.Material["onBeforeCompile"]>();
const directionalLight = "getDirectionalLightInfo( directionalLight, directLight );";

function bindOpaqueShadow(material: THREE.MeshStandardMaterial): void {
  const compile = material.onBeforeCompile;
  if (shadowCompilers.has(compile)) return;
  const cacheKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    compile.call(this, shader, renderer);
    const atlas = atlasByRenderer.get(renderer);
    if (!atlas) return;
    Object.assign(shader.uniforms, atlas);
    // Hull shaders may already have expanded this chunk, including the dust layer's lighting.
    const source = shader.fragmentShader.replaceAll("#include <lights_fragment_begin>", THREE.ShaderChunk.lights_fragment_begin);
    shader.fragmentShader = OPAQUE_RESOLVE_GLSL + OPAQUE_SHADOW_GLSL + source.replaceAll(directionalLight, `${directionalLight}
      #if UNROLLED_LOOP_INDEX == 0
        if (receiveShadow && directLight.visible) directLight.color *= opaqueSunVisibility(-vViewPosition);
      #endif`);
  };
  material.customProgramCacheKey = function () {
    const base = cacheKey === THREE.Material.prototype.customProgramCacheKey ? compile.toString() : cacheKey.call(this);
    return base + "|spaceShadows";
  };
  shadowCompilers.add(material.onBeforeCompile);
  material.needsUpdate = true;
}

class CascadeShadow extends THREE.LightShadow<THREE.OrthographicCamera> {
  readonly isDirectionalLightShadow = true;
  readonly tiles = SPLITS.map((_, i) => ({
    camera: new THREE.OrthographicCamera(),
    frustum: new THREE.Frustum(),
    matrix: new THREE.Matrix4(),
    // Keep atlas filtering inside each tile.
    viewport: new THREE.Vector4(i % COLUMNS + 1 / TILE_SIZE, Math.floor(i / COLUMNS) + 1 / TILE_SIZE, 1 - 2 / TILE_SIZE, 1 - 2 / TILE_SIZE),
  }));
  readonly active: number[] = [];
  private readonly extents = new THREE.Vector2(COLUMNS, COLUMNS);
  private readonly lightOrientation = new THREE.Matrix4();
  private readonly viewToLight = new THREE.Matrix4();
  private readonly zero = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly rays = Array.from({ length: 4 }, () => new THREE.Vector3());
  private readonly point = new THREE.Vector3();
  private readonly bounds = new THREE.Box3();

  constructor() {
    super(new THREE.OrthographicCamera());
    this.mapSize.set(TILE_SIZE, TILE_SIZE);
  }

  override getViewportCount(): number { return this.active.length; }
  override getCamera(i = 0): THREE.OrthographicCamera { return this.tiles[this.active[i]!]!.camera; }
  override getFrustum(i = 0): THREE.Frustum { return this.tiles[this.active[i]!]!.frustum; }
  override getViewport(i: number): THREE.Vector4 { return this.tiles[this.active[i]!]!.viewport; }
  override getFrameExtents(): THREE.Vector2 { return this.extents; }

  override updateMatrices(light: THREE.Light, view?: THREE.Camera): void {
    if (!(view instanceof THREE.PerspectiveCamera)) return;
    this.up.set(0, 1, 0);
    if (Math.abs(light.position.y) > 0.99) this.up.set(0, 0, 1);
    this.lightOrientation.lookAt(light.position, this.zero, this.up);
    this.viewToLight.copy(this.lightOrientation).transpose().multiply(view.matrixWorld);
    for (let i = 0; i < this.rays.length; i++) {
      const ray = this.rays[i]!.set(i & 1 ? 1 : -1, i & 2 ? 1 : -1, -1).applyMatrix4(view.projectionMatrixInverse);
      ray.multiplyScalar(-1 / ray.z);
    }
    for (const i of this.active) {
      this.bounds.makeEmpty();
      const near = Math.max(view.near, SPLITS[i - 1] ?? view.near), far = SPLITS[i]!;
      for (const ray of this.rays) {
        this.bounds.expandByPoint(this.point.copy(ray).multiplyScalar(near).applyMatrix4(this.viewToLight));
        this.bounds.expandByPoint(this.point.copy(ray).multiplyScalar(far).applyMatrix4(this.viewToLight));
      }
      const { min, max } = this.bounds;
      const { camera, frustum, matrix } = this.tiles[i]!;
      const halfX = (max.x - min.x) * 0.505, halfY = (max.y - min.y) * 0.505;
      const texelX = 2 * halfX / (TILE_SIZE - 2), texelY = 2 * halfY / (TILE_SIZE - 2);
      // Snap the projection to texels and leave room upstream for off-screen casters.
      const x = Math.round((min.x + max.x) * 0.5 / texelX) * texelX;
      const y = Math.round((min.y + max.y) * 0.5 / texelY) * texelY;
      const z = max.z + MAX_DEPTH;
      camera.position.set(x, y, z).applyMatrix4(this.lightOrientation);
      camera.quaternion.setFromRotationMatrix(this.lightOrientation);
      camera.left = -halfX; camera.right = halfX;
      camera.bottom = -halfY; camera.top = halfY;
      camera.near = 1; camera.far = z - min.z + 1;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(matrix);
    }
  }
}

/** The sun's opaque caster depth, shared by hull lighting and Observatory volumes. */
export class SpaceShadowAtlas {
  readonly uniforms = shadowUniforms();
  private readonly planetShadows = {
    planetShadowSpheres: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    shadowSunDirection: { value: new THREE.Vector3() },
  };
  private readonly viewport = new THREE.Vector2();
  private readonly eye = new THREE.Vector3();
  private readonly planetCenter = new THREE.Vector3();
  private readonly opaqueShadowMask = { value: null as THREE.Texture | null };
  private readonly opaqueShadowReady = { value: false };
  private mask: OpaqueShadowMask | null = null;
  private hasOpaque = false;
  private readonly shadow = new CascadeShadow();
  private readonly sun = new THREE.DirectionalLight();
  private readonly pass = new THREE.Scene();
  private readonly passTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private readonly modelView = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly needed = SPLITS.map(() => false);
  private readonly sphere = new THREE.Sphere();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.sun.shadow = this.shadow;
    atlasByRenderer.set(renderer, {
      ...this.uniforms, ...this.planetShadows, ...SOFT_DEPTH,
      opaqueShadowMask: this.opaqueShadowMask, opaqueShadowReady: this.opaqueShadowReady,
    });
  }

  get needsOpaqueDepth(): boolean {
    return this.hasOpaque && this.uniforms.shadowAtlas.value !== null;
  }

  resolveOpaque(camera: THREE.Camera, width: number, height: number): void {
    if (!this.needsOpaqueDepth || !SOFT_DEPTH.softDepthOn.value) return;
    this.mask ??= new OpaqueShadowMask(OPAQUE_RESOLVE_GLSL, { ...this.uniforms, ...this.planetShadows });
    this.opaqueShadowMask.value = this.mask.render(this.renderer, camera, width, height);
    this.opaqueShadowReady.value = true;
  }

  private needRange(near: number, far: number): void {
    for (let i = 0; i < SPLIT_COUNT; i++) {
      if (near < SPLITS[i]! && far >= (SPLITS[i - 1] ?? 0)) this.needed[i] = true;
    }
  }

  private selectPlanetShadows(view: THREE.PerspectiveCamera, sunDirection: THREE.Vector3, sunPosition: THREE.Vector3 | null, planets: readonly ShadowPlanet[]): void {
    // EveSpaceScene ranks planet models by estimatedPixelDiameter. The
    // estimate uses eye distance and includes bodies outside the view frustum.
    const diameterScale = this.renderer.getDrawingBufferSize(this.viewport).y * view.projectionMatrix.elements[5]!;
    this.eye.setFromMatrixPosition(view.matrixWorld);
    this.planetShadows.shadowSunDirection.value.copy(sunDirection).transformDirection(view.matrixWorldInverse);
    const candidates: { planet: ShadowPlanet; diameter: number }[] = [];
    for (const planet of planets) {
      if (sunPosition && this.planetCenter.copy(planet.center).sub(sunPosition).dot(sunPosition) > 0) continue;
      const diameter = diameterScale * planet.radius / Math.max(1e-5, this.eye.distanceTo(planet.center));
      if (diameter > 50) candidates.push({ planet, diameter });
    }
    candidates.sort((a, b) => b.diameter - a.diameter);
    const slots = this.planetShadows.planetShadowSpheres.value;
    for (let i = 0; i < slots.length && i < candidates.length; i++) {
      const { center, radius } = candidates[i]!.planet;
      const p = this.planetCenter.copy(center).applyMatrix4(view.matrixWorldInverse);
      slots[i]!.set(p.x, p.y, p.z, radius);
    }
  }

  render(
    scene: THREE.Scene, view: THREE.PerspectiveCamera, sunDirection: THREE.Vector3, enabled: boolean,
    clouds: readonly THREE.Mesh[], planets: readonly ShadowPlanet[], sunPosition: THREE.Vector3 | null,
  ): void {
    this.hasOpaque = false;
    this.opaqueShadowMask.value = null;
    this.opaqueShadowReady.value = false;
    for (const sphere of this.planetShadows.planetShadowSpheres.value) sphere.set(0, 0, 0, 0);
    const uniforms = this.uniforms;
    uniforms.shadowAtlas.value = null;
    uniforms.firstShadowSplit.value = 0;
    uniforms.lastShadowSplit.value = -1;
    uniforms.activeShadowSplits.value = 0;
    if (!enabled) return;
    const renderer = this.renderer;
    view.updateWorldMatrix(true, false);
    scene.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.modelView.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
    this.needed.fill(false);
    scene.traverseVisible((object) => {
      if (!(object instanceof THREE.Mesh) || !object.receiveShadow || !object.layers.test(view.layers)) return;
      if (object.frustumCulled && !object.intersectsFrustum(this.frustum)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      let receives = false;
      for (const material of materials) {
        if (material instanceof THREE.MeshStandardMaterial && material.visible && !material.transparent && material.depthWrite && material.depthTest) {
          bindOpaqueShadow(material);
          receives = true;
        }
      }
      if (!receives) return;
      const bounds = object instanceof THREE.InstancedMesh || object instanceof THREE.SkinnedMesh ? object : object.geometry;
      if (!bounds.boundingSphere) bounds.computeBoundingSphere();
      if (!bounds.boundingSphere) return;
      this.sphere.copy(bounds.boundingSphere).applyMatrix4(this.modelView.multiplyMatrices(view.matrixWorldInverse, object.matrixWorld));
      const near = -this.sphere.center.z - this.sphere.radius, far = -this.sphere.center.z + this.sphere.radius;
      if (near < MAX_DEPTH && far >= view.near) {
        this.needRange(near, far);
        this.hasOpaque = true;
      }
    });
    for (const cloud of clouds) {
      const m = this.modelView.multiplyMatrices(view.matrixWorldInverse, cloud.matrixWorld).elements;
      const radius = 0.5 * (Math.abs(m[2]!) + Math.abs(m[6]!) + Math.abs(m[10]!));
      this.needRange(-m[14]! - radius, -m[14]! + radius);
    }
    const active = this.shadow.active;
    active.length = 0;
    this.needed.forEach((needed, split) => { if (needed) active.push(split); });
    if (!active.length) return;
    if (this.hasOpaque && planets.length) this.selectPlanetShadows(view, sunDirection, sunPosition, planets);
    this.shadow.map ??= new THREE.WebGLRenderTarget(ATLAS_SIZE, ATLAS_SIZE, {
      depthTexture: new THREE.DepthTexture(ATLAS_SIZE, ATLAS_SIZE, THREE.UnsignedIntType),
    });
    this.sun.position.copy(sunDirection);
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const afterRender = this.pass.onAfterRender;
    // Give the depth draws their own renderer state and leave the lighting pass's scene untouched.
    this.pass.onAfterRender = () => renderer.shadowMap.render([this.sun], scene, view);
    try {
      renderer.setRenderTarget(this.passTarget);
      renderer.render(this.pass, view);
    } finally {
      this.pass.onAfterRender = afterRender;
      renderer.setRenderTarget(target, face, mip);
    }
    for (const i of active) {
      uniforms.viewToShadow.value[i]!.multiplyMatrices(this.shadow.tiles[i]!.matrix, view.matrixWorld);
      uniforms.activeShadowSplits.value |= 1 << i;
    }
    uniforms.firstShadowSplit.value = active[0]!;
    uniforms.lastShadowSplit.value = active[active.length - 1]!;
    uniforms.shadowAtlas.value = this.shadow.map.depthTexture;
  }

  dispose(): void {
    atlasByRenderer.delete(this.renderer);
    this.mask?.dispose();
    this.shadow.dispose();
    this.passTarget.dispose();
  }
}
