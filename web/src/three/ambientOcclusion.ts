import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SOFT_DEPTH, SOFT_VIEW_DEPTH_GLSL } from "./softDepth.ts";

const VERTEX = "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }";
const CAMERA_DEPTH = `
  uniform highp sampler2D softDepthMap;
  ${SOFT_VIEW_DEPTH_GLSL}
  ivec2 bottomLeftPixel(ivec2 pixel) {
    return ivec2(pixel.x, textureSize(softDepthMap, 0).y - 1 - pixel.y);
  }
  float depthAt(ivec2 pixel) {
    if (any(greaterThanEqual(pixel, textureSize(softDepthMap, 0)))) return 0.0;
    float depth = texelFetch(softDepthMap, bottomLeftPixel(pixel), 0).r;
    return depth < 1.0 ? softViewDepth(depth) : 0.0;
  }
`;

// GenerateQ0 in 3698585 runs once for each of four 2x2 offsets at quarter size.
// Store the four planes as RGBA. Keep their coordinates in Direct3D's top-down
// order so the rotation sequence and point sampling start at the same corner.
const GENERATE = `
  ${CAMERA_DEPTH}
  uniform highp sampler2D normalMap;
  uniform ivec2 planeSize;
  uniform vec2 tangent, projectionOffset;
  const int subpasses[5] = int[](0, 1, 4, 3, 2);

  ivec2 sourcePixel(ivec2 pixel, int slice) {
    return pixel * 4 + 2 * ivec2(slice % 2, slice / 2);
  }
  vec3 positionAt(ivec2 pixel, float depth) {
    vec2 uv = (vec2(pixel) + 0.5) / vec2(planeSize);
    return vec3((uv * vec2(2.0, -2.0) + vec2(-1.0, 1.0) + projectionOffset) * tangent * depth, depth);
  }
  float obscurance(ivec2 tap, int slice, vec3 center, vec3 normal, float invRadiusSquared) {
    float depth = depthAt(sourcePixel(clamp(tap, ivec2(0), planeSize - 1), slice));
    if (depth <= 0.0) return 0.0;
    vec3 delta = positionAt(tap, depth) - center;
    float distanceSquared = dot(delta, delta);
    float cosine = dot(normal, delta) * inversesqrt(max(distanceSquared, 1e-12));
    return max(0.0, cosine - 0.06) * max(0.0, 1.0 - distanceSquared * invRadiusSquared);
  }
  float generate(ivec2 pixel, int slice) {
    ivec2 source = sourcePixel(pixel, slice);
    float depth = depthAt(source);
    if (depth <= 1.0) return 1.0;
    vec3 center = positionAt(pixel, depth);
    float distanceFromEye = length(center);
    float radius = 6.0 * max(1.0, distanceFromEye * 0.005);
    radius *= 0.2 + 0.8 * clamp(distanceFromEye * tangent.y / 10.8, 0.0, 1.0);
    float projectedRadius = 0.85 * radius * float(planeSize.x) / (depth * 2.0 * tangent.x);
    float subpass = float(subpasses[(2 * pixel.y + pixel.x) % 5]);
    float angle = (float(slice) + subpass / 5.0) * 1.57079632679;
    float scale = 1.0 + 0.07 * (float(slice) - 1.5 + (subpass - 2.0) / 5.0);
    float c = cos(angle) * scale * projectedRadius;
    float s = -sin(angle) * scale * projectedRadius;
    mat2 transform = mat2(c, s, s, -c);

    vec3 normal = texelFetch(normalMap, bottomLeftPixel(source), 0).xyz * 2.0 - 1.0;
    normal.z = -normal.z;
    const vec3 taps[3] = vec3[](vec3(0.784881, 0.566617, 1.5), vec3(0.260222, -0.295752, 1.5), vec3(0.104594, 0.083725, 1.11));
    float sum = 0.0;
    float invRadiusSquared = 1.0 / (radius * radius);
    center *= 0.9992;
    for (int i = 0; i < 3; i++) {
      ivec2 shift = ivec2(roundEven(transform * taps[i].xy));
      sum += taps[i].z * (obscurance(pixel + shift, slice, center, normal, invRadiusSquared)
                       + obscurance(pixel - shift, slice, center, normal, invRadiusSquared));
    }
    float fade = clamp((center.z - 1.0) / 9.0, 0.0, 1.0);
    return pow(1.0 - min(0.98, sum * (4.3 * 0.121654)) * fade, 2.6);
  }
  void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    gl_FragColor = vec4(generate(pixel, 0), generate(pixel, 1), generate(pixel, 2), generate(pixel, 3));
  }
`;

// Q0 supplies open edges. Its six EdgeSensitiveBlur iterations reduce to a
// cross with half weight at the center and intermediate float16 rounding.
const BLUR = `
  uniform highp sampler2D source;
  vec4 at(ivec2 pixel) {
    return texelFetch(source, clamp(pixel, ivec2(0), textureSize(source, 0) - 1), 0);
  }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    gl_FragColor = (0.5 * at(p) + at(p + ivec2(-1, 0)) + at(p + ivec2(1, 0))
                  + at(p + ivec2(0, -1)) + at(p + ivec2(0, 1))) / 4.5;
  }
`;

const INTERLEAVE = `
  ${CAMERA_DEPTH}
  uniform highp sampler2D source;
  void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    ivec2 at = pixel / 2;
    ivec2 next = min((pixel + 1) / 2, textureSize(source, 0) - 1);
    vec4 a = texelFetch(source, at, 0);
    float b = texelFetch(source, ivec2(at.x, next.y), 0).g;
    float c = texelFetch(source, ivec2(next.x, at.y), 0).b;
    float d = texelFetch(source, next, 0).r;
    vec4 samples = roundEven(vec4(a.a, b, c, d) * 255.0) / 255.0;
    gl_FragColor = vec4(dot(samples, vec4(0.25)), depthAt(pixel * 2), 0.0, 1.0);
  }
`;

// UpscaleBilateral5x5NonSmart. Carry the factor beside the opaque shadow and
// depth so the hull shader can use one sampler for both lighting masks.
const RESOLVE = `
  ${CAMERA_DEPTH}
  uniform highp sampler2D source, shadow;
  uniform bool hasShadow;
  void main() {
    ivec2 framePixel = ivec2(gl_FragCoord.xy);
    ivec2 pixel = bottomLeftPixel(framePixel);
    float depth = depthAt(pixel);
    float visibility = hasShadow ? texelFetch(shadow, framePixel, 0).r : 1.0;
    float occlusion = 1.0;
    if (depth > 1.0) {
      ivec2 center = pixel / 2;
      ivec2 size = textureSize(source, 0);
      vec2 offset = vec2(pixel % 2) * 0.5;
      float sum = 0.001 * texelFetch(source, center, 0).r;
      float weight = 0.001;
      for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
        ivec2 delta = ivec2(x, y);
        ivec2 at = center + delta;
        if (any(lessThan(at, ivec2(0))) || any(greaterThanEqual(at, size))) continue;
        vec2 sampleValue = texelFetch(source, at, 0).rg;
        if (sampleValue.g <= 0.0) continue;
        vec2 displacement = vec2(delta) - offset;
        float dz = depth - sampleValue.g;
        float w = exp(-dot(displacement, displacement) / 5.0 - dz * dz / 0.8);
        sum += sampleValue.r * w;
        weight += w;
      }
      occlusion = roundEven(255.0 * sum / weight) / 255.0;
    }
    float sceneDepth = texelFetch(softDepthMap, framePixel, 0).r;
    gl_FragColor = vec4(visibility, sceneDepth, occlusion, 1.0);
  }
`;

function target(type: THREE.TextureDataType): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(1, 1, {
    type, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
}

function pass(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader, depthTest: false, depthWrite: false, toneMapped: false });
}

/** The installed Low space AO path, using fragment passes over the forward renderer's prepass. */
export class LowAmbientOcclusion {
  private readonly raw = target(THREE.UnsignedByteType);
  private readonly blur = [target(THREE.HalfFloatType), target(THREE.HalfFloatType)];
  private readonly interleaved = target(THREE.HalfFloatType);
  private readonly resolved = target(THREE.FloatType);
  private readonly quad = new FullScreenQuad();
  private readonly normals = { value: null as THREE.Texture | null };
  private readonly planeSize = { value: new THREE.Vector2() };
  private readonly tangent = { value: new THREE.Vector2() };
  private readonly projectionOffset = { value: new THREE.Vector2() };
  private readonly source = { value: this.raw.texture };
  private readonly shadow = { value: null as THREE.Texture | null };
  private readonly hasShadow = { value: false };
  private readonly generate = pass(GENERATE, {
    ...SOFT_DEPTH, normalMap: this.normals, planeSize: this.planeSize, tangent: this.tangent, projectionOffset: this.projectionOffset,
  });
  private readonly blurPass = pass(BLUR, { source: this.source });
  private readonly interleave = pass(INTERLEAVE, { ...SOFT_DEPTH, source: this.source });
  private readonly resolve = pass(RESOLVE, {
    ...SOFT_DEPTH, source: { value: this.interleaved.texture }, shadow: this.shadow, hasShadow: this.hasShadow,
  });

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, width: number, height: number,
    normals: THREE.Texture, shadow: THREE.Texture | null): THREE.Texture {
    const w = Math.ceil(width / 4), h = Math.ceil(height / 4);
    for (const t of [this.raw, ...this.blur]) t.setSize(w, h);
    this.interleaved.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
    this.resolved.setSize(width, height);
    this.normals.value = normals;
    this.shadow.value = shadow;
    this.hasShadow.value = shadow !== null;
    this.planeSize.value.set(w, h);
    const projection = camera.projectionMatrix.elements;
    this.tangent.value.set(1 / projection[0]!, 1 / projection[5]!);
    this.projectionOffset.value.set(projection[8]!, projection[9]!);
    const previous = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    try {
      this.draw(renderer, this.raw, this.generate);
      this.source.value = this.raw.texture;
      for (let n = 0; n < 6; n++) {
        const target = this.blur[n % this.blur.length]!;
        this.draw(renderer, target, this.blurPass);
        this.source.value = target.texture;
      }
      this.draw(renderer, this.interleaved, this.interleave);
      this.draw(renderer, this.resolved, this.resolve);
    } finally {
      renderer.setRenderTarget(previous, face, mip);
    }
    return this.resolved.texture;
  }

  private draw(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, material: THREE.ShaderMaterial): void {
    renderer.setRenderTarget(target);
    this.quad.material = material;
    this.quad.render(renderer);
  }

  dispose(): void {
    for (const material of [this.generate, this.blurPass, this.interleave, this.resolve]) material.dispose();
    for (const target of [this.raw, ...this.blur, this.interleaved, this.resolved]) target.dispose();
    this.quad.dispose();
  }
}
