import * as THREE from "three";

// 3698585 Tr2ShadowMap, Static split mode, used at Low and High.
const SPLITS = [25, 75, 150, 300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 76800, 153600, 307200, 614400, 1228800];
export const CLOUD_SHADOW_SPLITS = SPLITS.length;
const MAX_DEPTH = SPLITS[CLOUD_SHADOW_SPLITS - 1]!;
const COLUMNS = 4;
const ATLAS_SIZE = 2048;
const TILE_SIZE = ATLAS_SIZE / COLUMNS;

export const CLOUD_SHADOW_GLSL = `
  uniform sampler2D shadowAtlas;
  uniform mat4 cloudToShadow[${CLOUD_SHADOW_SPLITS}];
  uniform int firstShadowSplit, lastShadowSplit;
  const float shadowSplits[${CLOUD_SHADOW_SPLITS}] = float[](${SPLITS.map((depth) => depth.toFixed(1)).join(", ")});

  float cloudShadow(vec3 p, float viewDepth) {
    for (int i = firstShadowSplit; i <= lastShadowSplit; i++) {
      if (viewDepth < shadowSplits[i]) {
        vec3 clip = (cloudToShadow[i] * vec4(p, 1.0)).xyz;
        if (all(lessThanEqual(abs(clip), vec3(1.0)))) {
          vec2 tile = vec2(i % ${COLUMNS}, i / ${COLUMNS});
          vec2 uv = (tile + 0.5 + clip.xy * ${(0.5 - 1 / TILE_SIZE).toFixed(10)}) / ${COLUMNS}.0;
          return texture(shadowAtlas, uv).r < clip.z * 0.5 + 0.5 ? 0.3 : 1.0;
        }
        break;
      }
    }
    return 1.0;
  }
`;

class CascadeShadow extends THREE.LightShadow<THREE.OrthographicCamera> {
  readonly isDirectionalLightShadow = true;
  readonly tiles = SPLITS.map((_, i) => ({
    camera: new THREE.OrthographicCamera(),
    frustum: new THREE.Frustum(),
    matrix: new THREE.Matrix4(),
    // Keep atlas filtering inside each tile.
    viewport: new THREE.Vector4(i % COLUMNS + 1 / TILE_SIZE, Math.floor(i / COLUMNS) + 1 / TILE_SIZE, 1 - 2 / TILE_SIZE, 1 - 2 / TILE_SIZE),
  }));
  first = 0;
  last = -1;
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

  override getViewportCount(): number { return this.last - this.first + 1; }
  override getCamera(i = 0): THREE.OrthographicCamera { return this.tiles[this.first + i]!.camera; }
  override getFrustum(i = 0): THREE.Frustum { return this.tiles[this.first + i]!.frustum; }
  override getViewport(i: number): THREE.Vector4 { return this.tiles[this.first + i]!.viewport; }
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
    for (let i = this.first; i <= this.last; i++) {
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

/** Opaque depth rendered into the splits crossed by visible Observatory volumes. */
export class CloudShadowAtlas {
  private readonly shadow = new CascadeShadow();
  private readonly sun = new THREE.DirectionalLight();
  private readonly pass = new THREE.Scene();
  private readonly passTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private readonly modelView = new THREE.Matrix4();

  constructor() {
    this.sun.shadow = this.shadow;
  }

  get texture(): THREE.DepthTexture | null {
    return this.last < this.first ? null : this.shadow.map?.depthTexture ?? null;
  }

  get first(): number { return this.shadow.first; }
  get last(): number { return this.shadow.last; }
  matrix(split: number): THREE.Matrix4 { return this.shadow.tiles[split]!.matrix; }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, view: THREE.PerspectiveCamera, sunDirection: THREE.Vector3, clouds: readonly THREE.Mesh[]): void {
    this.shadow.first = 0;
    this.shadow.last = -1;
    if (!clouds.length) return;
    view.updateWorldMatrix(true, false);
    scene.updateMatrixWorld();
    let near = Infinity, far = -Infinity;
    for (const cloud of clouds) {
      const m = this.modelView.multiplyMatrices(view.matrixWorldInverse, cloud.matrixWorld).elements;
      const radius = 0.5 * (Math.abs(m[2]!) + Math.abs(m[6]!) + Math.abs(m[10]!));
      near = Math.min(near, -m[14]! - radius);
      far = Math.max(far, -m[14]! + radius);
    }
    near = Math.max(near, view.near);
    if (far < near || near >= MAX_DEPTH) return;
    this.shadow.first = SPLITS.findIndex((depth) => near < depth);
    this.shadow.last = far >= MAX_DEPTH ? CLOUD_SHADOW_SPLITS - 1 : SPLITS.findIndex((depth) => far < depth);
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
  }

  dispose(): void {
    this.shadow.dispose();
    this.passTarget.dispose();
  }
}
