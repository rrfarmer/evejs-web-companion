// 3698585 EveChildCloud2/basiccloud.fx. Use the authored volume and the
// renderer's opaque depth, with a single WebGL color target for the integrated light.
import * as THREE from "three";
import { loadDds } from "./ddsTexture.ts";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL } from "./softDepth.ts";
import { CLOUD_FOG } from "./cloudOpacity.ts";
import { decodeVta } from "./vtaVolume.ts";
import { VortexLightmap } from "./vortexLightmap.ts";
import { VortexShadow } from "./vortexShadow.ts";
import { VortexReflection, type ReflectionColors } from "./vortexReflection.ts";
import { SPACE_SHADOW_GLSL, type SpaceShadowAtlas } from "./spaceShadowAtlas.ts";

export const OBSERVATORY_VORTEX_TYPE = 77388;

type Triple = [number, number, number];

interface VortexData {
  scaling: Triple;
  density: number;
  albedo: Triple;
  steps: number;
  noiseFactor: number;
  temperatureControl: [number, number, number, number];
  absorptionPhase: number;
  lights: { position: Triple; radius: number; innerRadius: number; color: [number, number, number, number]; brightness: number }[];
  volume: string;
  volumeLow: string;
  noise: string;
  gradient: string;
  reflection?: { noise: string; colors: ReflectionColors };
}

interface VortexAssets {
  data: VortexData;
  noise: THREE.Texture;
  gradient: THREE.Texture;
  reflectionNoise: Promise<THREE.Texture | null> | null;
}

let sharedAssets: Promise<VortexAssets> | null = null;
function vortexAssets(): Promise<VortexAssets> {
  sharedAssets ??= fetch("/client-assets/observatoryVortex.json").then(async (response) => {
    if (!response.ok) throw new Error(`Observatory vortex: ${response.status}`);
    const data = await response.json() as VortexData;
    const [noise, gradient] = await Promise.all([loadDds(data.noise), loadDds(data.gradient)]);
    gradient.colorSpace = THREE.SRGBColorSpace;
    gradient.wrapS = gradient.wrapT = THREE.ClampToEdgeWrapping;
    gradient.needsUpdate = true;
    const reflectionNoise = data.reflection ? loadDds(data.reflection.noise).catch((error: unknown) => {
      console.warn("Observatory reflection:", error);
      return null;
    }) : null;
    return { data, noise, gradient, reflectionNoise };
  }).catch((error: unknown) => {
    sharedAssets = null;
    throw error;
  });
  return sharedAssets;
}

const volumes = new Map<string, Promise<THREE.Data3DTexture>>();
function loadVolume(url: string): Promise<THREE.Data3DTexture> {
  let volume = volumes.get(url);
  if (!volume) {
    volume = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`Vortex volume: ${response.status}`);
      const { data, width, height, depth } = await decodeVta(await response.arrayBuffer());
      const texture = new THREE.Data3DTexture(data, width, height, depth);
      texture.format = THREE.RedFormat;
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      return texture;
    }).catch((error: unknown) => {
      volumes.delete(url);
      throw error;
    });
    volumes.set(url, volume);
  }
  return volume;
}

const VERTEX = `
  varying vec3 localPoint;
  void main() {
    localPoint = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = `
  varying vec3 localPoint;
  uniform highp sampler3D field, lightmap;
  uniform bool lightmapReady;
  ${SPACE_SHADOW_GLSL}
  uniform mat4 cloudToView;
  uniform sampler2D noiseMap, gradientMap;
  uniform vec3 localEye, viewDepthAxis, sunDirection, sunColor, albedo, lightDistanceScale;
  uniform vec4 temperature, lightPosition[4], lightColor[4];
  uniform float densityScale, noiseFactor, phase, steps;
  ${SOFT_DEPTH_GLSL}
  #ifdef CLOUD_OPACITY_ONLY
    uniform vec2 opacitySize;
    uniform vec4 cloudFogDepths;
  #endif

  vec2 interval(vec3 origin, vec3 direction) {
    vec3 reciprocal = 1.0 / (sign(direction + vec3(1e-20)) * max(abs(direction), 1e-6));
    vec3 a = (-0.5 - origin) * reciprocal, b = (0.5 - origin) * reciprocal;
    vec3 first = min(a, b), last = max(a, b);
    return vec2(max(max(first.x, first.y), first.z), min(min(last.x, last.y), last.z));
  }

  float voxels(vec3 p) {
    return texture(field, vec3(p.xy, -p.z) + 0.5).r;
  }

  float stepTransmission(float density, float distance) {
    return density > 0.01 ? exp(-density * distance) : 1.0;
  }

  // basiccloud's normalized Henyey–Greenstein term, with -direction for incoming light.
  float scatter(float viewCosine) {
    return 0.07957747 * (1.0 - phase * phase) / pow(1.0 + phase * phase + 2.0 * phase * viewCosine, 1.5);
  }

  float transmission(vec3 p, vec3 direction, float reach) {
    float width = max(0.0, min(reach, interval(p, direction).y)) * 0.25;
    float sum = 0.0;
    for (int i = 0; i < 4; i++) sum += voxels(p + direction * ((float(i) + 0.5) * width));
    return exp(-min(1.0, sum * width * densityScale));
  }

  vec3 lightAt(vec3 p, vec3 direction) {
    vec2 lighting = lightmapReady ? texture(lightmap, vec3(p.xy, -p.z) + 0.5).rg
      : vec2(transmission(p, sunDirection, 2.0), 1.0);
    vec3 daylight = sunColor * (scatter(dot(direction, sunDirection)) * lighting.r);
    for (int i = 0; i < 4; i++) {
      vec3 offset = lightPosition[i].xyz - p;
      vec3 delta = offset * lightDistanceScale;
      float distance = length(delta);
      float radius = lightPosition[i].w, inner = max(0.001, lightColor[i].w);
      if (distance < radius) {
        float falloff = (radius - distance) / ((distance + inner) * (radius + inner));
        float angular = scatter(-dot(direction, delta) / max(distance, 1e-6));
        float selfShadow = lightmapReady ? lighting.g
          : transmission(p, normalize(offset + vec3(1e-9)), min(0.1, length(offset)));
        daylight += lightColor[i].rgb * (falloff * angular * selfShadow);
      }
    }
    return daylight * spaceShadow((cloudToView * vec4(p, 1.0)).xyz, true);
  }

  vec3 temperatureAlbedo(float t) {
    float mapped = t < temperature.z ? 0.5 * t / temperature.z
      : 0.5 + 0.5 * clamp((t - temperature.z) / max(1.0 - temperature.z, 1e-6), 0.0, 1.0);
    mapped = clamp((mapped - temperature.x) / (temperature.y - temperature.x), 0.0, 1.0);
    vec3 tinted = texture2D(gradientMap, vec2(mapped)).rgb * albedo;
    return mix(vec3(dot(tinted, vec3(0.22, 0.72, 0.06))), tinted, temperature.w);
  }

  void main() {
    vec3 direction = normalize(localPoint - localEye);
    vec2 box = interval(localEye, direction);
    float begin = max(box.x, 0.0), end = box.y;
    vec2 pixel = gl_FragCoord.xy;
    #ifdef CLOUD_OPACITY_ONLY
      float opaqueDepth = softSceneDepthAt(pixel * softDepthSize / opacitySize);
      pixel.y = opacitySize.y - pixel.y;
    #else
      float opaqueDepth = softSceneDepth();
    #endif
    float viewRate = max(dot(viewDepthAxis, direction), 1e-5);
    if (softDepthOn > 0.0) end = min(end, opaqueDepth / viewRate);
    if (end <= begin) discard;

    ivec2 noiseSize = textureSize(noiseMap, 0);
    ivec2 at = ivec2(pixel) % noiseSize;
    float stepLength = 1.0 / steps;
    float cursor = min(end, begin + texelFetch(noiseMap, at, 0).r * noiseFactor * stepLength);
    vec3 color = vec3(0.0);
    float transmit = 1.0, previous = begin;
    #ifdef CLOUD_OPACITY_ONLY
      vec3 sliceAt = cloudFogDepths.xyz / viewRate;
      vec3 slices = vec3(-1.0);
      for (int j = 0; j < 3; j++) {
        if (sliceAt[j] <= begin) slices[j] = 0.0;
      }
    #endif
    for (int i = 0; i < 128; i++) {
      #ifdef CLOUD_OPACITY_ONLY
        // The native shader samples the shortened step at each plane and
        // leaves the main march at its original step positions.
        for (int j = 0; j < 3; j++) {
          if (slices[j] < 0.0 && sliceAt[j] <= cursor && sliceAt[j] < end) {
            float density = voxels(localEye + direction * sliceAt[j]) * densityScale;
            float atCut = transmit * stepTransmission(density, sliceAt[j] - previous);
            // The native shader stores this transmission in half precision, rounding toward zero.
            uint packed = packHalf2x16(vec2(atCut, 0.0));
            float rounded = unpackHalf2x16(packed).x;
            slices[j] = 1.0 - (rounded > atCut ? unpackHalf2x16(packed - 1u).x : rounded);
          }
        }
      #endif
      vec3 p = localEye + direction * cursor;
      float density = voxels(p);
      if (density * densityScale > 0.01) {
        float stepTransmit = stepTransmission(density * densityScale, cursor - previous);
        #ifndef CLOUD_OPACITY_ONLY
          color += transmit * (1.0 - stepTransmit) * lightAt(p, direction) * temperatureAlbedo(density);
        #endif
        transmit *= stepTransmit;
      }
      if (cursor >= end || transmit <= 0.001) break;
      previous = cursor;
      cursor = min(end, cursor + stepLength);
    }
    #ifdef CLOUD_OPACITY_ONLY
      gl_FragColor = vec4(mix(slices, vec3(1.0 - transmit), lessThan(slices, vec3(0.0))), 1.0 - transmit);
    #else
      gl_FragColor = vec4(2.0 * color, 1.0 - transmit);
    #endif
  }
`;

export class ObservatoryVortex {
  readonly mesh: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>;
  private readonly opacity: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>;
  private requested: string | null = null;
  private stopped = false;
  private readonly volume: VortexData;
  private readonly baked = new VortexLightmap();
  private readonly caster = new VortexShadow();
  readonly shadow = this.caster.group;
  reflection: VortexReflection | null = null;
  private readonly nativeSun = new THREE.Vector3();
  private readonly inverse = new THREE.Matrix4();

  private constructor(assets: VortexAssets, sun: THREE.DirectionalLight, shadows: SpaceShadowAtlas) {
    const { data, noise, gradient } = assets;
    this.volume = data;
    const uniforms = {
      ...SOFT_DEPTH,
      field: { value: null as THREE.Data3DTexture | null }, noiseMap: { value: noise }, gradientMap: { value: gradient },
      lightmap: { value: null as THREE.Data3DTexture | null }, lightmapReady: { value: false },
      ...shadows.uniforms,
      cloudToView: { value: new THREE.Matrix4() },
      localEye: { value: new THREE.Vector3() }, viewDepthAxis: { value: new THREE.Vector3() },
      sunDirection: { value: new THREE.Vector3() }, sunColor: { value: new THREE.Color() },
      albedo: { value: new THREE.Vector3(...data.albedo) }, densityScale: { value: data.density },
      steps: { value: data.steps }, noiseFactor: { value: data.noiseFactor }, phase: { value: data.absorptionPhase },
      temperature: { value: new THREE.Vector4(...data.temperatureControl) },
      lightDistanceScale: { value: new THREE.Vector3(...data.scaling).divideScalar(data.scaling[0]) },
      lightPosition: { value: data.lights.map(({ position: [x, y, z], radius }) => new THREE.Vector4(x, y, -z, radius)) },
      lightColor: { value: data.lights.map(({ color: [r, g, b], brightness, innerRadius }) => new THREE.Vector4(r * brightness, g * brightness, b * brightness, innerRadius)) },
    };
    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT,
      side: THREE.BackSide, transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
    });
    material.userData.softDepth = true;
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    this.mesh.visible = false;
    this.mesh.renderOrder = -5;
    const opacitySize = { value: new THREE.Vector2() };
    this.opacity = new THREE.Mesh(this.mesh.geometry, new THREE.ShaderMaterial({
      uniforms: { ...uniforms, opacitySize, cloudFogDepths: CLOUD_FOG.cloudFogDepths }, vertexShader: VERTEX, fragmentShader: FRAGMENT,
      defines: { CLOUD_OPACITY_ONLY: 1 }, side: THREE.BackSide,
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcColorFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    }));
    this.opacity.matrixAutoUpdate = false;
    const reflection = data.reflection;
    if (reflection) {
      void assets.reflectionNoise?.then((texture) => {
        if (texture && !this.stopped) this.reflection = new VortexReflection(this.mesh, texture, reflection.colors);
      });
    }
    const inverse = new THREE.Matrix4(), position = new THREE.Vector3(), target = new THREE.Vector3();
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      inverse.copy(this.mesh.matrixWorld).invert();
      uniforms.localEye.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse);
      const t = uniforms.cloudToView.value.multiplyMatrices(camera.matrixWorldInverse, this.mesh.matrixWorld).elements;
      uniforms.viewDepthAxis.value.set(-t[2]!, -t[6]!, -t[10]!);
      uniforms.sunDirection.value.copy(sun.getWorldPosition(position)).sub(sun.target.getWorldPosition(target)).transformDirection(inverse);
      uniforms.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
    };
    this.opacity.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      const target = renderer.getRenderTarget()!;
      opacitySize.value.set(target.width, target.height);
      this.mesh.onBeforeRender(renderer, scene, camera, geometry, material, group);
    };
  }

  cloudOpacityMesh(): THREE.Mesh {
    this.opacity.matrix.copy(this.mesh.matrixWorld);
    this.opacity.matrixWorldNeedsUpdate = true;
    return this.opacity;
  }

  static async load(sun: THREE.DirectionalLight, shadows: SpaceShadowAtlas): Promise<ObservatoryVortex> {
    return new ObservatoryVortex(await vortexAssets(), sun, shadows);
  }

  update(radius: number, quality: number, renderer: THREE.WebGLRenderer, sunDirection: THREE.Vector3, shadows: boolean): void {
    this.mesh.scale.set(...this.volume.scaling).multiplyScalar(radius);
    const uniforms = this.mesh.material.uniforms;
    const field = uniforms.field!.value as THREE.Data3DTexture | null;
    if (field) {
      this.mesh.updateWorldMatrix(true, false);
      this.inverse.copy(this.mesh.matrixWorld).invert();
      this.nativeSun.copy(sunDirection).transformDirection(this.inverse);
      this.nativeSun.z *= -1;
      const lightmap = this.baked.update(renderer, field, this.nativeSun, this.volume.density);
      uniforms.lightmap!.value = lightmap;
      uniforms.lightmapReady!.value = lightmap !== null;
      this.caster.update(shadows ? lightmap : null, this.inverse, this.nativeSun);
    }
    // sceneRenderJobSpace.ApplySpaceRenderingSettings selects the low VTA at Low and Medium.
    const url = quality >= 3 ? this.volume.volume : this.volume.volumeLow;
    if (this.requested === url) return;
    this.requested = url;
    void loadVolume(url).then((texture) => {
      if (this.stopped || this.requested !== url) return;
      this.mesh.material.uniforms.field!.value = texture;
      this.mesh.visible = true;
    }).catch((error: unknown) => console.warn("Observatory vortex texture:", error));
  }

  dispose(): void {
    this.stopped = true;
    this.baked.dispose();
    this.caster.dispose();
    this.reflection?.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.opacity.material.dispose();
  }
}
