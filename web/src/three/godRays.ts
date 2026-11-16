import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL, SoftDepthPass } from "./softDepth.ts";
import { CloudOpacityPass, type FlareClouds } from "./cloudOpacity.ts";

interface FlareMask {
  mask: THREE.Texture;
  halfSize: readonly [number, number];
  background: boolean;
}

export interface GodRays {
  color: readonly [number, number, number, number];
  intensity: number;
  noise: THREE.Texture;
  masks: readonly FlareMask[];
  systemID: number;
}

export interface GodRaySun {
  position: THREE.Vector3;
  radius: number;
}

// Godrays.sm_depth samples the reverse-Z depth 40 times toward the sun,
// jittered by the repeating 128px NoiseTexMap, and scales by flare visibility.
export const GOD_RAYS_GLSL = `
uniform sampler2D godRayNoise, godRayOcclusion;
uniform vec2 godRaySunUv, godRayFrameSize;
uniform vec3 godRayColor;
uniform float godRaySunDepth;

vec3 godRays(vec2 uv) {
  vec2 delta = godRaySunUv - uv;
  float falloff = max(1.0 - length(delta) * (2.0 / 3.0), 0.0);
  vec4 fractions = texture2D(godRayOcclusion, vec2(0.5));
  float visibility = fractions.x * fractions.y * fractions.z * fractions.w;
  if (falloff == 0.0 || visibility == 0.0) return vec3(0.0);

  vec2 noiseUv = vec2(uv.x, 1.0 - uv.y) * godRayFrameSize / 128.0;
  float jitter = 2.0 * texture2D(godRayNoise, noiseUv).r;
  float n = softDepthNearFar.x, f = softDepthNearFar.y;
  float projectionZ = -n / (f - n);
  float sum = 0.0;
  for (int i = 0; i < 40; i++) {
    vec2 tap = uv + delta * ((float(i) + jitter) / 40.0);
    tap = 1.0 - abs(mod(tap, 2.0) - 1.0);
    float eyeDepth = softSceneDepthAt(tap * softDepthSize);
    float depth = eyeDepth >= godRaySunDepth ? 0.0 : clamp((n / eyeDepth) / (1.0 - n / f) + projectionZ, 0.0, 1.0);
    sum += pow((1.0 + projectionZ) / max(1.0 + projectionZ - depth, 1e-6), 0.2);
  }
  return godRayColor * (falloff * falloff) * (2.0 * max(sum / 40.0, 0.5) - 1.0) * visibility;
}
`;

const OCCLUDERS = 4;

function occluderLayer(mesh: THREE.Mesh): "background" | "foreground" | "sun" {
  for (let object: THREE.Object3D | null = mesh; object; object = object.parent) {
    if (object.userData.kind === "planet" || object.userData.kind === "moon") return "background";
    if (object.userData.kind === "sun") return "sun";
  }
  return "foreground";
}

/** Reduce each of the native flare's query slots to its own visibility fraction. */
export class GodRayOcclusion {
  readonly sunUv = new THREE.Vector2();
  sunDepth = 0;
  private readonly sunInView = new THREE.Vector3();
  private readonly foreground = new SoftDepthPass();
  private readonly background = new SoftDepthPass();
  private cloudOpacity: CloudOpacityPass | null = null;
  private readonly targets = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false,
  }));
  private current = 0;
  private systemID: number | null = null;
  get texture(): THREE.Texture { return this.targets[this.current]!.texture; }
  private readonly material = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      ...SOFT_DEPTH,
      masks: { value: Array<THREE.Texture | null>(OCCLUDERS).fill(null) },
      sunUv: { value: this.sunUv },
      maskHalfSize: { value: Array.from({ length: OCCLUDERS }, () => new THREE.Vector2()) },
      maskBackground: { value: Array<number>(OCCLUDERS).fill(0) },
      maskCount: { value: 0 },
      foregroundDepth: { value: null as THREE.Texture | null },
      backgroundDepth: { value: null as THREE.Texture | null },
      previous: { value: null as THREE.Texture | null },
      cloudOpacity: { value: null as THREE.Texture | null },
      hasCloud: { value: false },
      hasPrevious: { value: false },
      sunDepth: { value: 0 },
    },
    vertexShader: "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      uniform sampler2D masks[${OCCLUDERS}], foregroundDepth, backgroundDepth, previous, cloudOpacity;
      uniform vec2 sunUv, maskHalfSize[${OCCLUDERS}];
      uniform int maskCount, maskBackground[${OCCLUDERS}];
      uniform bool hasPrevious, hasCloud;
      uniform float sunDepth;
      ${SOFT_DEPTH_GLSL}
      float coverage(sampler2D mask, vec2 halfSize, bool background, float last) {
        float total = 0.0;
        float visible = 0.0;
        // WebGL has no atomic counter buffer. Sample the projected sprite on
        // a fixed grid using the native alpha threshold and opaque depth test.
        for (int y = 0; y < 24; y++) for (int x = 0; x < 24; x++) {
          vec2 maskUv = (vec2(float(x), float(y)) + 0.5) / 24.0;
          vec2 at = sunUv + (2.0 * maskUv - 1.0) * halfSize;
          if (any(lessThan(at, vec2(0.0))) || any(greaterThan(at, vec2(1.0)))) continue;
          if (textureLod(mask, vec2(maskUv.x, 1.0 - maskUv.y), 0.0).a <= 0.5) continue;
          total += 1.0;
          float depth = background ? textureLod(backgroundDepth, at, 0.0).r : textureLod(foregroundDepth, at, 0.0).r;
          if (softViewDepth(depth) >= sunDepth) {
            // The native foreground query counts hundredths of visibility.
            // Background queries set OcclusionFogWeight to zero.
            float opacity = hasCloud && !background ? textureLod(cloudOpacity, at, 0.0).a : 0.0;
            visible += floor(100.0 * (1.0 - min(opacity, 0.7)));
          }
        }
        return total > 0.0 ? visible / (100.0 * total) : last;
      }
      void main() {
        vec4 last = hasPrevious ? texture2D(previous, vec2(0.5)) : vec4(1.0);
        vec4 visibility = vec4(1.0);
        ${Array.from({ length: OCCLUDERS }, (_, i) => `
          if (maskCount > ${i}) visibility[${i}] = coverage(masks[${i}], maskHalfSize[${i}], maskBackground[${i}] != 0, last[${i}]);
        `).join("")}
        gl_FragColor = visibility;
      }`,
  });
  private readonly quad = new FullScreenQuad(this.material);

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, sun: GodRaySun, rays: GodRays, clouds?: FlareClouds): boolean {
    const direction = this.sunInView.copy(sun.position).applyMatrix4(camera.matrixWorldInverse);
    const viewDepth = -direction.z;
    if (viewDepth <= 0 || SOFT_DEPTH.softDepthOn.value === 0 || !rays.masks.length) return false;
    const cosine = viewDepth / direction.length();
    this.sunDepth = Math.max(1e-6, (viewDepth - sun.radius) * (1 - 1e-6));
    const projection = camera.projectionMatrix;
    direction.applyMatrix4(projection);
    this.sunUv.set(direction.x * 0.5 + 0.5, direction.y * 0.5 + 0.5);
    // The occluder vertex shader scales the camera-aligned sprite by the
    // square of the sun/view angle's cosine.
    const scale = 0.5 * cosine * cosine;
    const u = this.material.uniforms;
    const count = Math.min(OCCLUDERS, rays.masks.length);
    u["maskCount"]!.value = count;
    let onScreen = false;
    for (let i = 0; i < count; i++) {
      const { mask, halfSize, background } = rays.masks[i]!;
      u["masks"]!.value[i] = mask;
      u["maskBackground"]!.value[i] = Number(background);
      const size = u["maskHalfSize"]!.value[i].set(halfSize[0] * projection.elements[0]! * scale, halfSize[1] * projection.elements[5]! * scale);
      onScreen ||= Math.abs(this.sunUv.x - 0.5) < 0.5 + size.x && Math.abs(this.sunUv.y - 0.5) < 0.5 + size.y;
    }
    const hasPrevious = this.systemID === rays.systemID;
    if (!onScreen && hasPrevious) return true;
    const fullDepth = SOFT_DEPTH.softDepthMap.value;
    const { x: width, y: height } = SOFT_DEPTH.softDepthSize.value;
    const layered = onScreen && rays.masks.some(({ background }) => background);
    u["foregroundDepth"]!.value = layered ? this.foreground.capture(renderer, scene, camera, width, height,
      (mesh) => occluderLayer(mesh) === "foreground") : fullDepth;
    u["backgroundDepth"]!.value = layered ? this.background.capture(renderer, scene, camera, width, height,
      (mesh) => occluderLayer(mesh) === "background") : null;
    u["hasCloud"]!.value = onScreen && !!clouds?.meshes.length;
    if (onScreen && clouds?.meshes.length) {
      this.cloudOpacity ??= new CloudOpacityPass();
      u["cloudOpacity"]!.value = this.cloudOpacity.render(renderer, camera, clouds, width, height);
    }
    u["sunDepth"]!.value = this.sunDepth;
    u["previous"]!.value = this.texture;
    u["hasPrevious"]!.value = hasPrevious;
    const previousTarget = renderer.getRenderTarget();
    const next = 1 - this.current;
    renderer.setRenderTarget(this.targets[next]!);
    try {
      this.quad.render(renderer);
    } finally {
      renderer.setRenderTarget(previousTarget);
    }
    this.current = next;
    this.systemID = rays.systemID;
    return true;
  }

  dispose(): void {
    for (const target of this.targets) target.dispose();
    this.foreground.dispose();
    this.background.dispose();
    this.cloudOpacity?.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

/** Adds the half-resolution rays to the linear scene before bloom and tone mapping. */
export class GodRaysPass {
  private readonly occlusion = new GodRayOcclusion();
  private readonly rays = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  private readonly combined = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly rayMaterial = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      ...SOFT_DEPTH,
      godRaySunUv: { value: this.occlusion.sunUv },
      godRayOcclusion: { value: this.occlusion.texture },
      godRayNoise: { value: null as THREE.Texture | null },
      godRayFrameSize: { value: new THREE.Vector2() },
      godRaySunDepth: { value: 0 },
      godRayColor: { value: new THREE.Vector3() },
    },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `varying vec2 vUv;
      ${SOFT_DEPTH_GLSL}
      ${GOD_RAYS_GLSL}
      void main() { gl_FragColor = vec4(godRays(vUv), 1.0); }`,
  });
  private readonly compositeMaterial = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: { frame: { value: null as THREE.Texture | null }, rays: { value: this.rays.texture } },
    vertexShader: this.rayMaterial.vertexShader,
    fragmentShader: `varying vec2 vUv;
      uniform sampler2D frame, rays;
      void main() {
        vec4 original = texture2D(frame, vUv);
        gl_FragColor = vec4(original.rgb + texture2D(rays, vUv).rgb, original.a);
      }`,
  });
  private readonly quad = new FullScreenQuad(this.rayMaterial);

  render(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, sun: GodRaySun, settings: GodRays,
    frame: THREE.Texture, width: number, height: number, clouds?: FlareClouds,
  ): THREE.Texture {
    if (!this.occlusion.render(renderer, scene, camera, sun, settings, clouds)) return frame;
    this.combined.setSize(width, height);
    this.rays.setSize(Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2)));
    const u = this.rayMaterial.uniforms;
    u.godRayOcclusion!.value = this.occlusion.texture;
    const [r, g, b] = settings.color;
    u.godRayColor!.value.set(r, g, b).multiplyScalar(settings.intensity);
    u.godRayNoise!.value = settings.noise;
    u.godRaySunDepth!.value = this.occlusion.sunDepth;
    u.godRayFrameSize!.value.set(this.rays.width, this.rays.height);
    this.compositeMaterial.uniforms.frame!.value = frame;
    const previousTarget = renderer.getRenderTarget();
    try {
      this.quad.material = this.rayMaterial;
      renderer.setRenderTarget(this.rays);
      this.quad.render(renderer);
      this.quad.material = this.compositeMaterial;
      renderer.setRenderTarget(this.combined);
      this.quad.render(renderer);
    } finally {
      renderer.setRenderTarget(previousTarget);
    }
    return this.combined.texture;
  }

  dispose(): void {
    this.occlusion.dispose();
    this.compositeMaterial.dispose();
    this.rayMaterial.dispose();
    this.quad.dispose();
    this.combined.dispose();
    this.rays.dispose();
  }
}
