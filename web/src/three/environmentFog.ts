import type * as THREE from "three";

/** Tr2PPFogEffect fields stored in the Observatory's installed template. */
export interface AuthoredEnvironmentFog {
  color: readonly [number, number, number, number];
  colorInfluence: number;
  nebulaInfluence: number;
  nebulaBlur?: number;
  originalBrightenOnly?: number;
  backgroundOcclusion: number;
  brightnessAdjustmentAmount: number;
  brightnessThreshold0?: number;
  brightnessThreshold1?: number;
  blendDistance0: number;
  blendDistance1: number;
  blendDistance2: number;
  blendBias0: number;
  blendBias1: number;
  blendBias2: number;
  blendAmount0: number;
  blendAmount1: number;
  blendAmount2: number;
  blendPower0?: number;
  blendPower1?: number;
  blendPower2: number;
  areaScale: readonly [xz: number, y: number];
  intensity?: number;
}

export interface EnvironmentFog {
  settings: AuthoredEnvironmentFog;
  center: THREE.Vector3Like;
  dimensions: readonly [number, number, number];
  influence: number;
  amount: number;
  intensity: number;
}

// EnvironmentFogColor and EnvironmentFogComposit in SM_3_0_DEPTH. The composite
// uses the distance along the view ray and its closest point to the field center.
export const ENVIRONMENT_FOG_GLSL = `
uniform bool fogEnabled, fogHasNebula;
uniform samplerCube fogNebula;
uniform mat4 fogInverseProjection, fogWorldFromView;
uniform vec4 fogColorParams;
uniform vec3 fogCompositeParams, fogAreaSize, fogEyeFromCenter, fogColor, fogBrightness;
uniform vec4 fogBlend0, fogBlend1, fogBlend2;

vec3 fromSrgb(vec3 c) {
  return mix(c / 12.92, pow((max(c, 0.0) + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 environmentFog(vec3 original, vec2 uv) {
  vec3 view = normalize((fogInverseProjection * vec4(uv * 2.0 - 1.0, -1.0, 1.0)).xyz);
  vec3 ray = mat3(fogWorldFromView) * view;
  float depth = softSceneDepthAt(uv * softDepthSize) / -view.z;

  vec3 inArea = fogEyeFromCenter / fogAreaSize;
  vec3 areaRay = ray / fogAreaSize;
  vec3 rayUnit = normalize(areaRay);
  float closest = clamp(-dot(inArea, rayUnit), 0.0, length(areaRay) * depth);
  float area = clamp((1.0 - length(inArea + rayUnit * closest)) / 0.98, 0.0, 1.0);
  float coverage = max(pow(area, 4.0), fogCompositeParams.x);

  vec3 blend = mix(fogBlend0.yzw, fogBlend1.yzw,
      clamp((depth - fogBlend0.x) / (fogBlend1.x - fogBlend0.x), 0.0, 1.0));
  blend = mix(blend, fogBlend2.yzw,
      clamp((depth - fogBlend1.x) / (fogBlend2.x - fogBlend1.x), 0.0, 1.0));
  float amount = pow(clamp(blend.x + 1.0, 0.0, 1.0), blend.z) * blend.y * coverage;

  float blur = fogColorParams.y * 0.125;
  float lod = blur < 0.0005255 ? 0.0 : (1.0 - log2(2.0 / pow(blur, 4.0) - 1.0) / 28.0) * 7.0;
  vec3 linearOriginal = fromSrgb(original);
  vec3 nebula = fogHasNebula ? textureLod(fogNebula, vec3(ray.xy, -ray.z), lod).rgb : linearOriginal;
  vec3 brightened = mix(linearOriginal, max(nebula, linearOriginal), fogColorParams.z);
  vec3 fogged = mix(toSrgb(mix(brightened, nebula, fogColorParams.x)), fogColor, fogColorParams.w);
  float lumaDifference = dot(original - fogged, vec3(0.299, 0.587, 0.114));
  float brightness = clamp((lumaDifference - fogBrightness.x) / (fogBrightness.y - fogBrightness.x), 0.0, 1.0);
  amount *= (1.0 - brightness * fogBrightness.z) * fogCompositeParams.y * fogCompositeParams.z;
  return mix(original, fogged, amount);
}
`;
