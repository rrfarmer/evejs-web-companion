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
  #ifdef MEDIUM_AO
    layout(location = 0) out vec4 outVisibility;
    layout(location = 1) out vec4 outEdges;
  #endif

  ivec2 sourcePixel(ivec2 pixel, int slice) {
    ivec2 offset = ivec2(slice % 2, slice / 2);
    #ifdef MEDIUM_AO
      return pixel * 2 + offset;
    #else
      return pixel * 4 + 2 * offset;
    #endif
  }
  vec3 positionAt(ivec2 pixel, float depth) {
    vec2 uv = (vec2(pixel) + 0.5) / vec2(planeSize);
    return vec3((uv * vec2(2.0, -2.0) + vec2(-1.0, 1.0) + projectionOffset) * tangent * depth, depth);
  }
  float obscurance(vec3 delta, vec3 normal, float invRadiusSquared) {
    float distanceSquared = dot(delta, delta);
    float cosine = dot(normal, delta) * inversesqrt(max(distanceSquared, 1e-12));
    return max(0.0, cosine - 0.06) * max(0.0, 1.0 - distanceSquared * invRadiusSquared);
  }
  float planeDepth(ivec2 pixel, int slice) {
    return depthAt(sourcePixel(clamp(pixel, ivec2(0), planeSize - 1), slice));
  }
  vec2 generate(ivec2 pixel, int slice) {
    ivec2 source = sourcePixel(pixel, slice);
    float depth = depthAt(source);
    if (depth <= 1.0) return vec2(1.0, 0.0);
    vec3 center = positionAt(pixel, depth);
    float distanceFromEye = length(center);
    float radius = 6.0 * max(1.0, distanceFromEye * 0.005);
    #ifdef MEDIUM_AO
      float nearLimit = 7.2;
    #else
      float nearLimit = 10.8;
    #endif
    radius *= 0.2 + 0.8 * clamp(distanceFromEye * tangent.y / nearLimit, 0.0, 1.0);
    float projectedRadius = 0.85 * radius * float(planeSize.x) / (depth * 2.0 * tangent.x);
    float subpass = float(subpasses[(2 * pixel.y + pixel.x) % 5]);
    float angle = (float(slice) + subpass / 5.0) * 1.57079632679;
    float scale = 1.0 + 0.07 * (float(slice) - 1.5 + (subpass - 2.0) / 5.0);
    float c = cos(angle) * scale * projectedRadius;
    float s = -sin(angle) * scale * projectedRadius;
    mat2 transform = mat2(c, s, s, -c);

    vec3 normal = texelFetch(normalMap, bottomLeftPixel(source), 0).xyz * 2.0 - 1.0;
    normal.z = -normal.z;
    #ifdef MEDIUM_AO
      const int tapCount = 5;
      const vec3 taps[tapCount] = vec3[](vec3(0.784881, 0.566617, 1.5), vec3(0.260222, -0.295752, 1.5),
        vec3(0.104594, 0.083725, 1.11), vec3(-0.682868, 0.049630, 1.09), vec3(-0.135702, -0.641902, 1.25));
    #else
      const int tapCount = 3;
      const vec3 taps[tapCount] = vec3[](vec3(0.784881, 0.566617, 1.5), vec3(0.260222, -0.295752, 1.5), vec3(0.104594, 0.083725, 1.11));
    #endif
    float sum = 0.0;
    float invRadiusSquared = 1.0 / (radius * radius);
    center *= 0.9992;
    float fade = clamp((center.z - 1.0) / 9.0, 0.0, 1.0);
    float weights = 0.0;
    float packedEdges = 1.0;
    #ifdef MEDIUM_AO
      const ivec2 neighbors[4] = ivec2[](ivec2(-1,0), ivec2(1,0), ivec2(0,-1), ivec2(0,1));
      vec4 depths;
      for (int n = 0; n < 4; n++) depths[n] = planeDepth(pixel + neighbors[n], slice);
      vec4 dz = depths - depth;
      vec4 edge = clamp(1.3 - min(abs(dz), abs(dz + dz.yxwz)) / (0.04 * depth), 0.0, 1.0);
      // Generation treats a cleared depth as outside the scene, including in the slope correction.
      for (int n = 0; n < 4; n++) {
        if (depths[n] <= 0.0) edge[n] = 0.0;
        else if (depths[n ^ 1] <= 0.0) edge[n] = clamp(1.3 - abs(dz[n]) / (0.04 * depth), 0.0, 1.0);
      }
      vec2 pixelScale = depth * tangent * vec2(2.0, -2.0) / vec2(planeSize);
      for (int n = 0; n < 4; n++) {
        vec3 delta = vec3(pixelScale * vec2(neighbors[n]), 0.0) + (center / center.z) * (depths[n] - center.z);
        sum += edge[n] * obscurance(delta, normal, 4.0 * invRadiusSquared);
      }
      sum *= 5.0;
      fade *= 1.0 - 0.35 * (max(0.0, 1.0 - edge.x - edge.y) + max(0.0, 1.0 - edge.z - edge.w));
      packedEdges = dot(roundEven(edge * 3.05), vec4(64.0, 16.0, 4.0, 1.0)) / 255.0;
    #endif
    for (int i = 0; i < tapCount; i++) {
      ivec2 shift = ivec2(roundEven(transform * taps[i].xy));
      for (int direction = -1; direction <= 1; direction += 2) {
        ivec2 tap = pixel + direction * shift;
        float tapDepth = planeDepth(tap, slice);
        float weight = taps[i].z;
        vec3 delta = positionAt(tap, tapDepth) - center;
        #ifdef MEDIUM_AO
          weight *= tapDepth > 0.0 ? (0.4 + 0.6 * clamp(2.0 - max(0.0, -delta.z) / 6.0, 0.0, 1.0)) : 0.4;
        #endif
        if (tapDepth > 0.0) sum += weight * obscurance(delta, normal, invRadiusSquared);
        weights += weight;
      }
    }
    #ifndef MEDIUM_AO
      weights = 1.0 / 0.121654;
    #endif
    float visibility = pow(1.0 - min(0.98, 4.3 * sum / weights) * fade, 2.6);
    return vec2(visibility, packedEdges);
  }
  void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec2 a = generate(pixel, 0), b = generate(pixel, 1), c = generate(pixel, 2), d = generate(pixel, 3);
    vec4 visibility = vec4(a.x, b.x, c.x, d.x);
    #ifdef MEDIUM_AO
      outVisibility = visibility;
      outEdges = vec4(a.y, b.y, c.y, d.y);
    #else
      gl_FragColor = visibility;
    #endif
  }
`;

// The edge data stays fixed across blur iterations. Low supplies open edges.
const BLUR = `
  uniform highp sampler2D source, edges;
  uniform bool edgeAware;
  vec4 at(ivec2 pixel) {
    return texelFetch(source, clamp(pixel, ivec2(0), textureSize(source, 0) - 1), 0);
  }
  vec4 weight(ivec4 packedEdges, int shift) {
    return min(vec4(1.0), vec4((packedEdges >> shift) & 3) / 3.0 + 0.5);
  }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec4 packedEdges = edgeAware ? ivec4(roundEven(255.0 * texelFetch(edges, p, 0))) : ivec4(255);
    vec4 l = weight(packedEdges, 6), r = weight(packedEdges, 4), t = weight(packedEdges, 2), b = weight(packedEdges, 0);
    gl_FragColor = (0.5 * at(p) + l * at(p + ivec2(-1, 0)) + r * at(p + ivec2(1, 0))
                  + t * at(p + ivec2(0, -1)) + b * at(p + ivec2(0, 1))) / (0.5 + l + r + t + b);
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
const RESOLVE_LOW = `
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

// Apply reconstructs the native-resolution image from four half-size planes.
const RESOLVE_MEDIUM = `
  ${CAMERA_DEPTH}
  uniform highp sampler2D source, edges, shadow;
  uniform bool hasShadow;
  void main() {
    ivec2 framePixel = ivec2(gl_FragCoord.xy);
    ivec2 pixel = bottomLeftPixel(framePixel);
    ivec2 parity = pixel % 2;
    int slice = parity.x + 2 * parity.y;
    ivec2 center = pixel / 2;
    float occlusion = 1.0;
    float sceneDepth = texelFetch(softDepthMap, framePixel, 0).r;
    if (sceneDepth < 1.0) {
      int packedEdges = int(roundEven(texelFetch(edges, center, 0)[slice] * 255.0));
      vec4 edge = min(vec4(1.0), vec4((ivec4(packedEdges) >> ivec4(6, 4, 2, 0)) & 3) / 3.0 + 0.5);
      vec2 shift = edge.yw - edge.xz;
      vec2 weights = 0.5 * (edge.yw + edge.xz);
      float diagonalWeight = 0.5 * (weights.x + weights.y);
      vec2 uv = vec2(pixel - parity) + 0.5;
      vec2 opposite = vec2(pixel + parity) + shift - 0.5;
      vec2 scale = 0.5 / vec2(textureSize(source, 0));
      float h = texture(source, vec2(opposite.x, uv.y) * scale)[slice ^ 1];
      float v = texture(source, vec2(uv.x, opposite.y) * scale)[slice ^ 2];
      float d = texture(source, opposite * scale)[slice ^ 3];
      float ao = texelFetch(source, center, 0)[slice];
      float sum = ao + weights.x * h + weights.y * v + diagonalWeight * d;
      occlusion = roundEven(255.0 * sum / (1.0 + weights.x + weights.y + diagonalWeight)) / 255.0;
    }
    float visibility = hasShadow ? texelFetch(shadow, framePixel, 0).r : 1.0;
    gl_FragColor = vec4(visibility, sceneDepth, occlusion, 1.0);
  }
`;

function target(type: THREE.TextureDataType, count = 1, linear = false): THREE.WebGLRenderTarget {
  const filter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  return new THREE.WebGLRenderTarget(1, 1, {
    count, type, depthBuffer: false, minFilter: filter, magFilter: filter,
  });
}

function pass(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader, depthTest: false, depthWrite: false, toneMapped: false });
}

/** Ambient occlusion from the forward renderer's opaque normal and depth prepass. */
export class AmbientOcclusion {
  private readonly raw = target(THREE.UnsignedByteType);
  private readonly rawMedium = target(THREE.UnsignedByteType, 2);
  private readonly blur = [target(THREE.HalfFloatType), target(THREE.HalfFloatType)];
  private readonly filteredMedium = target(THREE.UnsignedByteType, 1, true);
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
  private readonly edgeAware = { value: false };
  private readonly edges = { value: this.rawMedium.textures[1]! };
  private readonly generate = pass(GENERATE, {
    ...SOFT_DEPTH, normalMap: this.normals, planeSize: this.planeSize, tangent: this.tangent, projectionOffset: this.projectionOffset,
  });
  private readonly generateMedium = new THREE.ShaderMaterial({
    uniforms: this.generate.uniforms, vertexShader: VERTEX, fragmentShader: GENERATE,
    defines: { MEDIUM_AO: 1 }, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, toneMapped: false,
  });
  private readonly blurPass = pass(BLUR, { source: this.source, edges: this.edges, edgeAware: this.edgeAware });
  private readonly interleave = pass(INTERLEAVE, { ...SOFT_DEPTH, source: this.source });
  private readonly resolve = pass(RESOLVE_LOW, {
    ...SOFT_DEPTH, source: { value: this.interleaved.texture }, shadow: this.shadow, hasShadow: this.hasShadow,
  });
  private readonly resolveMedium = pass(RESOLVE_MEDIUM, {
    ...SOFT_DEPTH, source: { value: this.filteredMedium.texture }, edges: this.edges, shadow: this.shadow, hasShadow: this.hasShadow,
  });

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, width: number, height: number,
    normals: THREE.Texture, shadow: THREE.Texture | null, quality: 1 | 2): THREE.Texture {
    const medium = quality === 2;
    const divisor = medium ? 2 : 4;
    const w = Math.ceil(width / divisor), h = Math.ceil(height / divisor);
    const raw = medium ? this.rawMedium : this.raw;
    raw.setSize(w, h);
    this.blur[0]!.setSize(w, h);
    if (medium) this.filteredMedium.setSize(w, h);
    else {
      this.blur[1]!.setSize(w, h);
      this.interleaved.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
    }
    this.resolved.setSize(width, height);
    this.normals.value = normals;
    this.shadow.value = shadow;
    this.hasShadow.value = shadow !== null;
    this.edgeAware.value = medium;
    this.planeSize.value.set(w, h);
    const projection = camera.projectionMatrix.elements;
    this.tangent.value.set(1 / projection[0]!, 1 / projection[5]!);
    this.projectionOffset.value.set(projection[8]!, projection[9]!);
    const previous = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    try {
      this.draw(renderer, raw, medium ? this.generateMedium : this.generate);
      this.source.value = raw.texture;
      if (medium) {
        this.draw(renderer, this.blur[0]!, this.blurPass);
        this.source.value = this.blur[0]!.texture;
        this.draw(renderer, this.filteredMedium, this.blurPass);
        this.draw(renderer, this.resolved, this.resolveMedium);
      } else {
        for (let n = 0; n < 6; n++) {
          const target = this.blur[n % this.blur.length]!;
          this.draw(renderer, target, this.blurPass);
          this.source.value = target.texture;
        }
        this.draw(renderer, this.interleaved, this.interleave);
        this.draw(renderer, this.resolved, this.resolve);
      }
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
    for (const material of [this.generate, this.generateMedium, this.blurPass, this.interleave, this.resolve, this.resolveMedium]) material.dispose();
    for (const target of [this.raw, this.rawMedium, ...this.blur, this.filteredMedium, this.interleaved, this.resolved]) target.dispose();
    this.quad.dispose();
  }
}
