import * as THREE from "three";

type Color = [number, number, number, number];
export type ReflectionColors = [Color, Color];

const VERTEX = `
  varying vec3 localPoint;
  void main() {
    localPoint = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// 3698585 basiccloudreflectionproxy: a sphere in the scaled cloud's local box.
const FRAGMENT = `
  varying vec3 localPoint;
  uniform vec3 localEye;
  uniform samplerCube noiseMap;
  uniform vec4 color1, color2;

  void main() {
    vec3 ray = normalize(localPoint - localEye);
    float along = dot(-localEye, ray);
    float originSquared = dot(localEye, localEye);
    // The cross product avoids subtracting large, almost equal values for distant probes.
    vec3 perpendicular = cross(localEye, ray);
    float perpendicularSquared = dot(perpendicular, perpendicular);
    if ((along < 0.0 && originSquared > 0.25) || perpendicularSquared >= 0.25) discard;
    float span = sqrt(0.25 - perpendicularSquared);
    float first = max(-along, -span);
    vec3 closest = cross(ray, perpendicular);
    vec3 last = closest + span * ray;
    vec3 middle = closest + (0.5 * (first + span)) * ray;
    vec4 color = mix(color1, color2, textureCube(noiseMap, vec3(last.xy, -last.z)).r);
    float softness = sqrt(max(0.0, 1.0 - 2.0 * length(middle)));
    float alpha = 1.0 - exp(-20.0 * softness * color.a * min(0.2, span - first));
    gl_FragColor = vec4(color.rgb, alpha);
  }
`;

export class VortexReflection {
  readonly proxy: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly inverse = new THREE.Matrix4();
  private readonly localEye = new THREE.Vector3();
  private readonly previousEye = new THREE.Vector3(Infinity);

  constructor(private readonly cloud: THREE.Mesh, noise: THREE.Texture, colors: ReflectionColors) {
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT,
      uniforms: {
        noiseMap: { value: noise },
        color1: { value: new THREE.Vector4(...colors[0]) },
        color2: { value: new THREE.Vector4(...colors[1]) },
        localEye: { value: this.localEye },
      },
      side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.proxy = new THREE.Mesh(cloud.geometry, material);
    this.proxy.matrixAutoUpdate = false;
  }

  place(eye: THREE.Vector3): boolean {
    this.cloud.updateWorldMatrix(true, false);
    const world = this.cloud.matrixWorld;
    const moved = !this.proxy.matrix.equals(world);
    if (moved) {
      this.proxy.matrix.copy(world);
      this.proxy.matrixWorldNeedsUpdate = true;
      this.inverse.copy(world).invert();
    }
    this.localEye.copy(eye).applyMatrix4(this.inverse);
    const eyeMoved = !this.previousEye.equals(this.localEye);
    this.previousEye.copy(this.localEye);
    return moved || eyeMoved;
  }

  dispose(): void {
    this.proxy.removeFromParent();
    this.proxy.material.dispose();
  }
}

/** The filtered system sky and the cloud proxies seen from the current space camera. */
export class VortexReflectionProbe {
  private readonly scene = new THREE.Scene();
  private readonly capture = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly camera = new THREE.CubeCamera(0.1, 2e12, this.capture);
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly sources = new Set<VortexReflection>();
  private filtered: ReturnType<THREE.PMREMGenerator["fromCubemap"]> | null = null;
  private face = 0;
  private remaining = 6;
  private quality = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer, sky: THREE.Texture) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.camera.coordinateSystem = renderer.coordinateSystem;
    this.camera.updateCoordinateSystem();
    this.scene.background = sky;
    this.scene.backgroundRotation.y = Math.PI;
  }

  update(eye: THREE.Vector3, quality: number, sources: VortexReflection[]): THREE.Texture | null {
    let changed = quality !== this.quality || this.sources.size !== sources.length;
    this.quality = quality;
    for (const source of this.sources) {
      if (!sources.includes(source)) {
        source.proxy.removeFromParent();
        this.sources.delete(source);
      }
    }
    for (const source of sources) {
      if (!this.sources.has(source)) {
        this.sources.add(source);
        this.scene.add(source.proxy);
        changed = true;
      }
      if (source.place(eye)) changed = true;
    }
    if (changed) this.remaining = 6;
    if (this.remaining === 0) return this.filtered?.texture ?? null;
    this.camera.position.copy(eye);
    if (quality >= 4) {
      this.camera.update(this.renderer, this.scene);
      this.remaining = this.face = 0;
    } else {
      this.renderFace();
      this.face = (this.face + 1) % 6;
      this.remaining--;
    }
    // Filter once all faces have been initialized, and once the final camera pose reaches all six.
    if (this.face === 0 || this.remaining === 0) {
      this.filtered = this.pmrem.fromCubemap(this.capture.texture, this.filtered);
    }
    return this.filtered?.texture ?? null;
  }

  private renderFace(): void {
    const renderer = this.renderer;
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const xr = renderer.xr.enabled;
    try {
      renderer.xr.enabled = false;
      this.camera.updateMatrixWorld();
      renderer.setRenderTarget(this.capture, this.face);
      renderer.render(this.scene, this.camera.children[this.face] as THREE.Camera);
    } finally {
      renderer.setRenderTarget(target, face, mip);
      renderer.xr.enabled = xr;
    }
  }

  dispose(): void {
    this.scene.clear();
    this.sources.clear();
    this.pmrem.dispose();
    this.filtered?.dispose();
    this.capture.dispose();
  }
}
