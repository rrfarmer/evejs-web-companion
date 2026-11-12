// EveStretch2 (Trinity's Eve/Renderable/Stretch/EveStretch2.cpp): the stretch a turret's firing effect draws from a
// muzzle to its target - a strip of quads drawn additive by one effect, with lights at its two ends. Its effect gets
// the source and the target (each with the destination's scale), the start, loop and end curve sets' scaled times and a
// random number drawn at each StartFiring, and its intensity (EveStretch2PerObjectData). Its curve sets (start, loop,
// end) drive the effect's parameters and the lights through their bindings: StartFiring plays start and loop from the
// delay given, stops end; StopFiring stops start and loop and plays end.
//
// The effects ported (res:/graphics/effect/managed/space/specialfx/stretch/*.fx, their sm_depth vertex and pixel
// stages disassembled, client 3396210): laser.fx, projectile.fx, blast.fx, artillery.fx and atomic.fx. Each quad of the strip is one part, by its index:
// the beam or stream of shots from source to target (a strip turned to face the camera, at least about two pixels
// wide, its profile the FalloffMap across it), the flares at the source and target, projectile's muzzle flash, and the
// splash at the target (a disc facing back along the beam, two CloudMap swirls). Not as the client: no fog volume (no scene sets one); the output stays linear (the client
// writes sRGB into an sRGB target); the scene's depth only where softDepth.ts has drawn it.

import * as THREE from "three";
import { colorValue, curveValue, vector3Value, type Curve } from "./curves.ts";
import { loadDds } from "./ddsTexture.ts";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL } from "./softDepth.ts";
import { offerLights, type ChildLight } from "./dynamicLights.ts";
import { GpuEmitter, type GpuEmitterData, type GpuParticleSystem } from "./gpuParticles.ts";

/** A stretch's curve set as the extractor reads it (lib/turret.mjs stretchCurveSet). */
export interface StretchSet {
  scale: number;
  curves: Curve[];
  bindings: {
    name: string | null; source: number | null; sourceCurve: Curve | null; sourceAttribute: string;
    /** "param:<name>", "sourceLight", "destinationLight" or "emitter:<stretch index>:source|destination" */
    target: string; destinationAttribute: string; scale: number; offset: number[];
  }[];
}
export interface StretchLight { position: number[]; radius: number; color: number[]; brightness: number; noiseAmplitude: number; noiseFrequency: number; noiseOctaves: number }
/** An EveStretch2 as the extractor reads it (lib/turret.mjs readStretch). */
export interface SofStretch2 {
  type: "EveStretch2"; name: string | null; quadCount: number; effect: string | null;
  params: Record<string, number | number[]>; textures: Record<string, string | null>;
  start: StretchSet | null; loop: StretchSet | null; end: StretchSet | null;
  sourceLight: StretchLight | null; destinationLight: StretchLight | null;
  /** Its GPU emitters, updated with the end frames (their rate and colours often bound to its curves). */
  sourceEmitter?: GpuEmitterData | null; destinationEmitter?: GpuEmitterData | null;
}

/** The effects this file draws. */
export const STRETCH2_EFFECTS = new Set(["laser", "projectile", "blast", "artillery", "atomic"]);

// --- shared by the effects: the per-object data, the quads' corners, the depth pulled toward the eye, the flares,
// the target's splash (laser.fx and projectile.fx compile the same code for them)

const VS_HEAD = `
uniform vec4 srcPos; uniform vec4 dstPos; uniform vec4 timing;
uniform float Intensity; uniform vec4 FlareIntensity; uniform vec4 SplashIntensity;
uniform vec2 viewport;
varying vec4 v1; varying vec4 v2;
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
varying float vFragDepth; varying float vIsPerspective;
#endif
const vec2 CORNER[4] = vec2[4](vec2(-0.5, -0.5), vec2(0.5, -0.5), vec2(0.5, 0.5), vec2(-0.5, 0.5));
// a view z drawn nearer by a bias (never past the eye), as the effect's depth: its clip z over the true w
float biasedDepth(float viewZ, float w) {
  float z = min(viewZ, 0.0);
  vec4 c = projectionMatrix * vec4(0.0, 0.0, z, 1.0);
  return min(c.z / c.w, 1.0) * w;
}
// the strip from a to b turned to face the camera on screen, halfW wide, at corner c: its clip position
vec4 facingStrip(vec3 a, vec3 b, vec2 c, float halfW) {
  mat4 VP = projectionMatrix * viewMatrix;
  vec4 P0 = VP * vec4(a, 1.0), P1 = VP * vec4(b, 1.0);
  vec2 dir = normalize(P1.xy / P1.w - P0.xy / P0.w);
  vec4 clip = mix(P0, P1, c.x + 0.5);
  return vec4(clip.xy + vec2(dir.y, -dir.x) * halfW * c.y, clip.zw);
}
// two pixels' worth at a point's depth (tan(fov / 2) / height x 4)
float pixelsAt(vec3 world) { return (projectionMatrix * viewMatrix * vec4(world, 1.0)).w / projectionMatrix[1][1] / viewport.y * 4.0; }
// a flare at the source (k: FlareIntensity.xy) or the target (.zw), larger seen down the beam's way; sets v2, fragW
float fragW;
vec4 flareAt(vec3 at, vec3 way, vec2 k, vec2 c) {
  vec3 back = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float lo = k.y * Intensity;
  float size = (dot(way, back) * 0.5 + 0.5) * (Intensity * k.x - lo) + lo;
  vec4 view = viewMatrix * vec4(at, 1.0);
  view.xy += c * size * 16.0;
  vec4 clip = projectionMatrix * vec4(view.xyz, 1.0);
  fragW = max(-min(size * 16.0 + view.z, 0.0), 1e-3);
  v2 = vec4(size, view.z, 0.0, 0.0);
  return vec4(clip.xy, biasedDepth(size * 16.0 + view.z, clip.w), clip.w);
}
vec4 flare(vec3 S, vec3 D, bool atDest, vec2 k, vec2 c) {
  vec3 way = normalize(D - S);
  return flareAt(atDest ? D : S, atDest ? -way : way, k, c);
}
// the splash: a disc at the target across the beam (SplashIntensity.x x the target's scale x splashScale), its
// strength the effect's (weight: Intensity, or blast's bolt arrived); sets v2, fragW
float splashScale = 1.0;
vec4 splash(vec3 S, vec3 D, vec2 c, float weight) {
  vec3 way = normalize(D - S);
  float s = SplashIntensity.x * srcPos.w * splashScale;
  vec3 up = abs(way.x) > 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 X = normalize(cross(way, up));
  vec3 Y = cross(way, X);
  vec3 world = (X * c.y + Y * c.x) * s * 16.0 + D;
  vec4 view = viewMatrix * vec4(world, 1.0);
  vec4 clip = projectionMatrix * vec4(view.xyz, 1.0);
  float z = s * SplashIntensity.z + view.z;
  fragW = max(-min(z, 0.0), 1e-3);
  vec3 toEye = normalize(cameraPosition - D);
  float f = min(abs(dot(-way, toEye)), 1.0) * weight;
  v2 = vec4(f * f, s * SplashIntensity.z, -min(z, 0.0), 1.0);
  return vec4(clip.xy, biasedDepth(z, clip.w), clip.w);
}`;
const VS_TAIL = `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  vFragDepth = 1.0 + fragW; vIsPerspective = 1.0;
#endif`;

const FS_HEAD = `
#include <logdepthbuf_pars_fragment>
${SOFT_DEPTH_GLSL}
uniform sampler2D NoiseMap; uniform sampler2D FalloffMap; uniform sampler2D CloudMap;
uniform float Intensity; uniform vec4 Flicker; uniform vec4 Color; uniform vec4 SplashAnimation; uniform vec4 SplashIntensity;
uniform vec4 timing; uniform vec4 misc;
varying vec4 v1; varying vec4 v2;
float sceneDistance() { return softDepthOn > 0.5 ? softSceneDepth() : 1e12; }
// a flare: the falloff over its radius, cut where it goes behind the scene (soft over 30 sqrt(size))
vec4 flare() {
  float sz = sqrt(v2.x);
  float d = length(v1.xy);
  float g = d * 0.5 + 0.5;
  float soft = clamp((sceneDistance() - (-v2.y - sz * 30.0)) / (sz * 30.0), 0.0, 1.0);
  float r = 1.0 - max(1.0 - d, 0.0) * soft;
  float f = textureGrad(FalloffMap, vec2(r * 0.5 + 0.5, 0.0), vec2(dFdx(g), 0.0), vec2(dFdy(g), 0.0)).x;
  return f * v2.x * Color;
}
#ifndef SPLASH_CHANNEL
#define SPLASH_CHANNEL y
#endif
// the splash: two swirls of the cloud map (green; atomic's blue) by angle and radius, sharpened toward the rim, faded into the scene
vec4 splash() {
  vec2 p = v1.xy - 0.5;
  float ang = atan(p.y, p.x) * 0.159155 + 0.5;
  float rr = 1.0 - 2.0 * length(p);
  float t = timing.w + timing.y;
  vec2 g = vec2(dFdx(rr)), h = vec2(dFdy(rr));
  float s1 = textureGrad(CloudMap, vec2(ang, rr) * SplashAnimation.xy + t * SplashAnimation.zw, g, h).SPLASH_CHANNEL;
  float s2 = textureGrad(CloudMap, vec2(ang, rr) * SplashAnimation.xy + t * SplashAnimation.zw * vec2(-0.97, 1.03), g, h).SPLASH_CHANNEL;
  float m = max(rr, 0.0);
  float n = pow(abs(s1 * s2), (1.0 - m) * 10.0);
  float m4 = m * m * m * m;
  float soft = clamp((sceneDistance() - v2.z) / v2.y, 0.0, 1.0);
  soft *= soft; soft *= soft;
  return m4 * soft * n * v2.x * (Color * SplashIntensity.y);
}
// the flicker (the noise map at Flicker's rate of the loop's time), the stretch's own intensity; linear out
#ifndef OUTPUT_SCALE
#define OUTPUT_SCALE misc.x
#endif
void finish(vec4 colour, vec2 flick) {
  float noise = texture2D(NoiseMap, vec2(flick.y * timing.y, 0.0)).x;
  colour *= 1.0 - noise * flick.x;
  colour *= OUTPUT_SCALE;
  gl_FragColor = vec4(max(colour.rgb, 0.0), colour.a);
}`;

// --- laser.fx: quad 0 the beam (its profile the FalloffMap across it, two CloudMap scrolls along it), 1 and 2 the
// flares at source and target (the target's x its scale), the rest the splash

const LASER_VERTEX = `${VS_HEAD}
uniform vec4 Clouds;
void main() {
  fragW = 1.0;
  if (!(Intensity > 0.0)) {
    gl_Position = vec4(0.0); v1 = vec4(0.0); v2 = vec4(0.0);
  } else {
    vec3 S = (modelMatrix * vec4(srcPos.xyz, 1.0)).xyz, D = (modelMatrix * vec4(dstPos.xyz, 1.0)).xyz;
    float q = position.x;
    vec2 c = CORNER[int(position.y + 0.5)];
    float r2z = 1.0;
    if (q == 0.0) {
      float u = c.x + 0.5, v = c.y + 0.5;
      float pix = pixelsAt(mix(S, D, u));
      float halfW = max(pix, Intensity * 16.0);
      gl_Position = facingStrip(S, D, c, halfW);
      fragW = gl_Position.w;
      r2z = pix / (Intensity * 16.0);
      float len = length(S - D);
      float t = timing.w + timing.y;
      vec2 uv = vec2(u * len, v * halfW) / Clouds.y;
      float a = -t * Clouds.z;
      v2.y = uv.x * SplashIntensity.w + a * SplashIntensity.w;
      v2.z = uv.y;
      v2.w = a * Clouds.w * SplashIntensity.w + uv.x * SplashIntensity.w;
      v2.x = len / (sqrt(Intensity) * 30.0) * 0.5;
      v1.xy = c + 0.5;
    } else if (q < 3.0) {
      bool atDest = q == 2.0;
      gl_Position = flare(S, D, atDest, atDest ? FlareIntensity.zw * srcPos.w : FlareIntensity.xy, c);
      v1.xy = (c + 0.5) * 2.0 - 1.0;
    } else {
      gl_Position = splash(S, D, c, Intensity);
      v1.xy = c + 0.5;
    }
    v1.z = q;
    v1.w = r2z;
  }
${VS_TAIL}
}`;

const LASER_FRAGMENT = `${FS_HEAD}
uniform vec4 Clouds;
void main() {
#include <logdepthbuf_fragment>
  if (v1.z == 0.0) {
    // the beam: its profile across, faded where it is thinner than the pixels, and at its two ends
    float a = texture2D(FalloffMap, vec2(v1.y, 0.0)).x * clamp(1.0 / v1.w, 0.0, 1.0);
    float ends = clamp(min(1.0 - v1.x, v1.x) * v2.x, 0.0, 1.0);
    float base = clamp(1.0 - Clouds.x, 0.0, 1.0);
    float n = texture2D(CloudMap, v2.yz).x * texture2D(CloudMap, v2.wz).x;
    float cloud = texture2D(CloudMap, vec2(v1.x, timing.w)).z * n;
    cloud = cloud * (1.0 - base) + base;
    finish(ends * (cloud * a * Color * Intensity), Flicker.xy);
  } else if (v1.z < 2.5) finish(flare(), Flicker.xy);
  else finish(splash(), Flicker.zw);
}`;

// --- projectile.fx: quad 0 the stream of shots (rows of the CloudMap's shot atlas, Shots: spacing y, speed z, offset
// w), 1 and 3 the flares at source and target, 2 the muzzle flash (a strip FireParams.x long, its length flickering
// by FireParams.w with the noise, its width 16 x Intensity x FireParams.y, stronger across the view by FireParams.z),
// the rest the splash

const PROJECTILE_VERTEX = `${VS_HEAD}
uniform vec4 FireParams; uniform vec4 Shots; uniform sampler2D NoiseMap;
void main() {
  fragW = 1.0;
  vec3 S = (modelMatrix * vec4(srcPos.xyz, 1.0)).xyz, D = (modelMatrix * vec4(dstPos.xyz, 1.0)).xyz;
  float q = position.x;
  vec2 c = CORNER[int(position.y + 0.5)];
  float r3z = 1.0;
  v2 = vec4(0.0);
  if (q == 0.0) {
    float u = c.x + 0.5;
    float pix = pixelsAt(mix(S, D, u));
    float halfW = max(pix, Intensity * 16.0);
    gl_Position = facingStrip(S, D, c, halfW);
    fragW = gl_Position.w;
    r3z = pix / (Intensity * 16.0);
    float len = length(S - D);
    v2.x = len / (sqrt(Intensity) * 30.0) * 0.5;
    v2.y = (u * len - (Shots.w + timing.y) * Shots.z) / Shots.y;
    v1.xy = c + 0.5;
  } else if (q == 1.0 || q == 3.0) {
    bool atDest = q == 3.0;
    gl_Position = flare(S, D, atDest, atDest ? FlareIntensity.zw : FlareIntensity.xy, c);
    v1.xy = 2.0 * c;
  } else if (q == 2.0) {
    float halfW = Intensity * FireParams.y * 16.0;
    float n = textureLod(NoiseMap, vec2(timing.y, 0.0), 0.0).x;
    float len = (FireParams.w * (n - 1.0) + 1.0) * FireParams.x;
    vec3 way = normalize(D - S);
    vec3 back = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
    gl_Position = facingStrip(S, S + way * len, c, halfW);
    fragW = gl_Position.w;
    r3z = (1.0 - abs(dot(way, back))) * FireParams.z;
    v1.xy = c + 0.5;
  } else {
    gl_Position = splash(S, D, c, Intensity);
    v1.xy = c + 0.5;
  }
  v1.z = q;
  v1.w = r3z;
${VS_TAIL}
}`;

const PROJECTILE_FRAGMENT = `${FS_HEAD}
uniform vec4 FireParams;
void main() {
#include <logdepthbuf_fragment>
  vec4 colour;
  if (v1.z == 0.0) {
    // the stream: its profile across, faded at its ends; the shots a row of the atlas each (32 rows)
    float a = texture2D(FalloffMap, vec2(v1.y, 0.0)).x * clamp(1.0 / v1.w, 0.0, 1.0);
    float ends = clamp(min(1.0 - v1.x, v1.x) * v2.x, 0.0, 1.0);
    float shot = texture2D(CloudMap, vec2(v2.y, floor(v2.y) * 0.03125)).x;
    colour = ends * (shot * a * Color * Intensity);
  } else if (v1.z < 1.5 || (v1.z > 2.5 && v1.z < 3.5)) colour = flare();
  else if (v1.z < 2.5) {
    // the muzzle flash: the cloud map's blue over the strip, a scrolling noise, its random brightness
    float k = timing.w * FireParams.w + 1.0;
    float n = texture2D(NoiseMap, v1.xy * 2.0 - vec2(timing.y * 60.0, 0.0)).x * 0.7 + 0.3;
    float flash = texture2D(CloudMap, clamp(v1.xy, 0.0, 1.0)).z * v1.w;
    colour = Intensity * Color * (k * n * flash);
  } else colour = splash();
  finish(colour, Flicker.xy);
}`;

// --- blast.fx: one bolt travelling the strip (the hybrids). Its progress (loop time - Shots.x) / (Shots.y - Shots.x)
// over the strip and a bolt length min(2 x length, Shots.z): bolt(k) is where a point k along it (0 source, 1 target)
// lies against the bolt (1 its head, below 0 not reached), the ShotsMap's profile there (faded in below 0 by Shots.w)
// its strength. Quad 0 the bolt (StretchFalloffMap across it, the ShotsMap along it, two CloudMap scrolls), 1 and 3
// the flares (as strong as the bolt at their end), 2 the muzzle flash (as projectile's, as strong as the bolt at the
// muzzle), the rest the splash (once the bolt is past SplashIntensity.w, until it has gone)

const BLAST_BOLT = `
uniform vec4 Shots;
float bolt(float k, float len) {
  float L2 = min(2.0 * len, Shots.z);
  float prog = (timing.y - Shots.x) / (Shots.y - Shots.x);
  return 1.0 + len * (k * len / (len + L2) - prog) / L2;
}`;

const BLAST_VERTEX = `${VS_HEAD}
uniform vec4 FireParams; uniform vec4 Clouds; uniform sampler2D NoiseMap; uniform sampler2D ShotsMap;
${BLAST_BOLT}
float boltWeight(float a) {
  float s = textureLod(ShotsMap, vec2(clamp(a, 0.0, 1.0), 0.0), 0.0).x;
  return a < 0.0 ? clamp(a * Shots.w + 1.0, 0.0, 1.0) * s : s;
}
void main() {
  fragW = 1.0;
  vec3 S = (modelMatrix * vec4(srcPos.xyz, 1.0)).xyz, D = (modelMatrix * vec4(dstPos.xyz, 1.0)).xyz;
  float q = position.x;
  vec2 c = CORNER[int(position.y + 0.5)];
  float len = length(S - D);
  float r2z = 1.0;
  v2 = vec4(0.0);
  if (q == 0.0) {
    float u = c.x + 0.5, v = c.y + 0.5;
    float pix = pixelsAt(mix(S, D, u));
    float halfW = max(pix, Intensity * 16.0);
    gl_Position = facingStrip(S, D, c, halfW);
    fragW = gl_Position.w;
    r2z = pix / (Intensity * 16.0);
    float t = timing.w + timing.y;
    vec2 uv = vec2(u * len, v * halfW) / Clouds.y;
    v2 = vec4(bolt(u, len), uv.x + t * Clouds.z, uv.y, -t * Clouds.z * 0.91 + uv.x);
    v1.xy = c + 0.5;
  } else if (q == 1.0 || q == 3.0) {
    bool atDest = q == 3.0;
    float w = boltWeight(bolt(atDest ? 1.0 : 0.0, len));
    gl_Position = flare(S, D, atDest, (atDest ? FlareIntensity.zw * srcPos.w : FlareIntensity.xy) * w, c);
    v1.xy = 2.0 * c;
  } else if (q == 2.0) {
    float halfW = Intensity * FireParams.y * 16.0;
    float strength = boltWeight(bolt(0.0, len)) * FireParams.z;
    float n = textureLod(NoiseMap, vec2(timing.y, 0.0), 0.0).x;
    float flashLen = (FireParams.w * (n - 1.0) + 1.0) * FireParams.x;
    vec3 way = normalize(D - S);
    vec3 back = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
    gl_Position = facingStrip(S, S + way * flashLen, c, halfW);
    fragW = gl_Position.w;
    r2z = strength * (1.0 - abs(dot(way, back)));
    v1.xy = c + 0.5;
  } else {
    float a = bolt(1.0, len);
    float w = (a < 0.0 ? clamp(a * Shots.w + 1.0, 0.0, 1.0) : clamp((SplashIntensity.w - a) * 10.0, 0.0, 1.0)) * Intensity;
    gl_Position = splash(S, D, c, a > SplashIntensity.w ? 0.0 : w);
    v1.xy = c + 0.5;
  }
  v1.z = q;
  v1.w = r2z;
${VS_TAIL}
}`;

const BLAST_FRAGMENT = `${FS_HEAD}
uniform vec4 FireParams; uniform vec4 Clouds; uniform vec4 srcPos; uniform vec4 dstPos;
uniform sampler2D ShotsMap; uniform sampler2D StretchFalloffMap;
uniform vec4 Shots;
void main() {
#include <logdepthbuf_fragment>
  vec4 colour;
  if (v1.z == 0.0) {
    // the bolt: its profile across, faded at the strip's ends and where it is thinner than the pixels; the ShotsMap
    // along it from its head; the clouds
    float a = texture2D(StretchFalloffMap, vec2(v1.y, 0.0)).x * clamp(1.0 / v1.w, 0.0, 1.0);
    float len = length(srcPos.xyz - dstPos.xyz);
    float ends = clamp(len / (sqrt(Intensity) * 30.0) * 0.5 * min(1.0 - v1.x, v1.x), 0.0, 1.0);
    float k = v2.x > 1.0 ? 0.0 : ends * a;
    k *= texture2D(ShotsMap, vec2(v2.x, 0.0)).x;
    if (v2.x < 0.0) k *= clamp(v2.x * Shots.w + 1.0, 0.0, 1.0);
    float base = clamp(1.0 - Clouds.x, 0.0, 1.0);
    float cl = texture2D(CloudMap, v2.yz).y * texture2D(CloudMap, v2.wz).y;
    cl = cl * (1.0 - base) + base;
    colour = k * cl * Color * Intensity;
  } else if (v1.z < 1.5 || (v1.z > 2.5 && v1.z < 3.5)) colour = flare();
  else if (v1.z < 2.5) {
    float k = timing.w * FireParams.w + 1.0;
    float n = texture2D(NoiseMap, v1.xy * 2.0 - vec2(timing.y * 60.0, 0.0)).x * 0.7 + 0.3;
    float flash = texture2D(CloudMap, clamp(v1.xy, 0.0, 1.0)).z * v1.w;
    colour = Intensity * Color * (k * n * flash);
  } else colour = splash();
  finish(colour, Flicker.xy);
}`;

// --- artillery.fx: a shell in flight. Its progress p = (loop time - Shots.x) / (Shots.y - Shots.x): quad 0 the trail
// from the muzzle to the shell (CloudMap's first column across it, brighter toward the shell, fading by Shots.w after
// it lands), 1 the muzzle flash (rising over Flashes.x before the shot, falling over half Flashes.y after), 2 the
// muzzle's flare (likewise over Flashes.x / Flashes.y), 3 the shell's flare (Shots.z growing to Flashes.w over the
// flight) and after it lands the impact's (FlareIntensity.zw x the target's scale, over Flashes.z), the rest the
// splash (over Flashes.z after it lands)

const ARTILLERY_VERTEX = `${VS_HEAD}
uniform vec4 FireParams; uniform vec4 Clouds; uniform vec4 Shots; uniform vec4 Flashes; uniform sampler2D NoiseMap;
// the muzzle's flash strength: rising over Flashes.x to the shot, falling over Flashes.y / k after it
float muzzle(float k) {
  float lt = timing.y;
  return Shots.x < lt ? clamp(1.0 - k * (lt - Shots.x) / Flashes.y, 0.0, 1.0) : clamp(1.0 - (Shots.x - lt) / Flashes.x, 0.0, 1.0);
}
// the impact's strength: from the landing, falling over Flashes.z
float impact() { return timing.y >= Shots.y ? clamp(1.0 - (timing.y - Shots.y) / Flashes.z, 0.0, 1.0) : 0.0; }
void main() {
  fragW = 1.0;
  vec3 S = (modelMatrix * vec4(srcPos.xyz, 1.0)).xyz, D = (modelMatrix * vec4(dstPos.xyz, 1.0)).xyz;
  float q = position.x;
  vec2 c = CORNER[int(position.y + 0.5)];
  float p = (timing.y - Shots.x) / (Shots.y - Shots.x);
  vec3 shell = S + clamp(p, 0.0, 1.0) * (D - S);
  float r4z = 1.0;
  v2 = vec4(0.0);
  if (q == 0.0) {
    float u = c.x + 0.5, v = c.y + 0.5;
    float pix = pixelsAt(mix(S, shell, u));
    float halfW = max(pix, Intensity * 16.0);
    gl_Position = facingStrip(S, shell, c, halfW);
    fragW = gl_Position.w;
    r4z = pix / (Intensity * 16.0);
    float len = length(shell - S);
    float t = timing.w + timing.y;
    vec2 uv = vec2(u * len, v * halfW) / Clouds.y;
    float fade = clamp(1.0 - max(p - 1.0, 0.0) * Shots.w, 0.0, 1.0);
    v2 = vec4(fade * fade, uv.x + t * Clouds.z, uv.y, -t * Clouds.z * 0.91 + uv.x);
    v1.xy = c + 0.5;
  } else if (q == 1.0) {
    float halfW = Intensity * FireParams.y * 16.0;
    float strength = muzzle(2.0) * FireParams.z;
    float n = textureLod(NoiseMap, vec2(timing.y, 0.0), 0.0).x;
    float flashLen = (FireParams.w * (n - 1.0) + 1.0) * FireParams.x;
    vec3 way = normalize(D - S);
    vec3 back = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
    gl_Position = facingStrip(S, S + way * flashLen, c, halfW);
    fragW = gl_Position.w;
    r4z = strength * (1.0 - abs(dot(way, back)));
    v1.xy = c + 0.5;
  } else if (q <= 3.0) {
    vec3 way = normalize(D - S);
    if (q == 2.0) gl_Position = flareAt(S, way, muzzle(1.0) * FlareIntensity.xy, c);
    else {
      float size = Shots.z + p * (Flashes.w - Shots.z);
      vec2 k = p < 0.0 ? vec2(0.0) : p < 1.0 ? vec2(size) : impact() * FlareIntensity.zw * srcPos.w;
      gl_Position = flareAt(shell, -way, k, c);
    }
    v1.xy = 2.0 * c;
  } else {
    gl_Position = splash(S, D, c, p < 0.0 ? 0.0 : impact() * Intensity);
    v1.xy = c + 0.5;
  }
  v1.z = q;
  v1.w = r4z;
${VS_TAIL}
}`;

const ARTILLERY_FRAGMENT = `${FS_HEAD}
uniform vec4 FireParams; uniform vec4 Clouds;
void main() {
#include <logdepthbuf_fragment>
  vec4 colour;
  if (v1.z == 0.0) {
    // the trail: CloudMap's first column across it, brighter toward the shell (u squared), the clouds along it
    float k = texture2D(CloudMap, vec2(0.0, v1.y)).x * v1.x * v1.x * v2.x;
    float base = clamp(1.0 - Clouds.x, 0.0, 1.0);
    float cl = texture2D(CloudMap, v2.yz).y * texture2D(CloudMap, v2.wz).y;
    cl = cl * (1.0 - base) + base;
    colour = k * cl * Color * Intensity * clamp(1.0 / v1.w, 0.0, 1.0);
  } else if (v1.z < 1.5) {
    float k = timing.w * FireParams.w + 1.0;
    float n = texture2D(NoiseMap, v1.xy * 2.0 - vec2(timing.y * 60.0, 0.0)).x * 0.7 + 0.3;
    float flash = texture2D(CloudMap, clamp(v1.xy, 0.0, 1.0)).z * v1.w;
    colour = Intensity * Color * (k * n * flash);
  } else if (v1.z < 3.5) colour = flare();
  else colour = splash();
  finish(colour, Flicker.xy);
}`;

// --- atomic.fx: the Triglavian disintegrators' beam (Properties: x size, y intensity, z the output's scale, w the
// beam's width - bound to the spool-up, py_intensity). Quad 0 the beam (FalloffMap across and along it, rising from
// 4 x Properties.x along it over StretchStartFlare.w of that, CloudMap's alpha clouds), 1 the core at the muzzle (a
// disc facing the eye ray: a vortex of the CloudMap's green inside half its radius, fire of its red outside, a border
// ring), 2 and 3 the flares (x the target's scale), 4 the start flare 4 x Properties.x along the beam, the rest the
// splash (CloudMap blue). Its output is x Properties.z (not the stretch's intensity).

const ATOMIC_VERTEX = `${VS_HEAD}
uniform vec4 Properties; uniform vec4 StretchStartFlare; uniform vec4 Clouds;
// a quad of size x 16 about a point, its corners along the view's x and y; depth pulled toward the eye by it
vec4 viewQuad(vec3 at, float size, vec2 c) {
  vec4 view = viewMatrix * vec4(at, 1.0);
  view.xy += c * size * 16.0;
  vec4 clip = projectionMatrix * vec4(view.xyz, 1.0);
  fragW = max(-min(size * 16.0 + view.z, 0.0), 1e-3);
  v2 = vec4(size, view.z, 0.0, 0.0);
  return vec4(clip.xy, biasedDepth(size * 16.0 + view.z, clip.w), clip.w);
}
void main() {
  fragW = 1.0;
  if (!(Properties.y > 0.0)) {
    gl_Position = vec4(0.0); v1 = vec4(0.0); v2 = vec4(0.0);
  } else {
    vec3 S = (modelMatrix * vec4(srcPos.xyz, 1.0)).xyz, D = (modelMatrix * vec4(dstPos.xyz, 1.0)).xyz;
    float q = position.x;
    vec2 c = CORNER[int(position.y + 0.5)];
    float len = length(S - D);
    vec3 way = normalize(D - S);
    float r4z = 1.0;
    v2 = vec4(0.0);
    if (q == 0.0) {
      float u = c.x + 0.5, v = c.y + 0.5;
      float pix = pixelsAt(mix(S, D, u));
      float halfW = max(pix, Properties.y * Properties.x * Properties.w * 16.0);
      gl_Position = facingStrip(S, D, c, halfW);
      fragW = gl_Position.w;
      r4z = pix / (Properties.y * 16.0);
      float t = timing.w + timing.y;
      vec2 uv = vec2(u * len, v * halfW) / Clouds.y;
      v2 = vec4(len / (sqrt(Properties.y) * 30.0) * 0.5, uv.x * SplashIntensity.w - t * Clouds.z * SplashIntensity.w, uv.y, len * 0.25);
      v1.xy = c + 0.5;
    } else if (q == 1.0) {
      // the core: a disc at the muzzle across the eye ray (its axes not normalised, as the effect's)
      vec4 view = viewMatrix * vec4(S, 1.0);
      vec3 n = normalize(view.xyz);
      vec3 X = vec3(n.z, 0.0, -n.x);
      vec3 Y = cross(n, X);
      float size = Properties.x * 16.0;
      vec3 p = view.xyz + X * c.x * size + Y * c.y * size;
      vec4 clip = projectionMatrix * vec4(p, 1.0);
      gl_Position = vec4(clip.xy, biasedDepth(size + p.z, clip.w), clip.w);
      fragW = max(-min(size + p.z, 0.0), 1e-3);
      v2 = vec4(Properties.x, p.z, 0.0, 0.0);
      v1.xy = 2.0 * c;
    } else if (q < 4.0) {
      bool atDest = q == 3.0;
      vec2 k = (atDest ? FlareIntensity.zw : FlareIntensity.yx) * srcPos.w;
      gl_Position = flareAt(atDest ? D : S, -way, k, c);
      v1.xy = 2.0 * c;
    } else if (q == 4.0) {
      gl_Position = viewQuad(S + (D - S) * (4.0 / len * Properties.x), StretchStartFlare.x * srcPos.w * Properties.x, c);
      v1.xy = 2.0 * c;
    } else {
      splashScale = Properties.x;
      gl_Position = splash(S, D, c, 1.0);
      v1.xy = c + 0.5;
    }
    v1.z = q;
    v1.w = r4z;
  }
${VS_TAIL}
}`;

const ATOMIC_FRAGMENT = `#define SPLASH_CHANNEL z
#define OUTPUT_SCALE Properties.z
uniform vec4 Properties;
${FS_HEAD}
uniform vec4 Border; uniform vec4 StretchStartFlare; uniform vec4 CoreFireAnimation; uniform vec4 CoreFireLook;
uniform vec4 CoreVortexAnimation; uniform vec4 CoreVortexLook; uniform vec4 Clouds;
void main() {
#include <logdepthbuf_fragment>
  vec4 colour;
  vec2 flick = Flicker.xy;
  if (v1.z == 0.0) {
    // the beam: the FalloffMap at (across, along), squared toward its edges, the clouds; rising from the start flare
    float a = texture2D(FalloffMap, v1.yx).x * clamp(1.0 / v1.w, 0.0, 1.0);
    float edge = 1.0 - abs(1.0 - 2.0 * v1.y);
    a *= edge * edge;
    float ends = clamp(min(1.0 - v1.x, v1.x) * v2.x, 0.0, 1.0);
    float base = clamp(1.0 - Clouds.x, 0.0, 1.0);
    a *= texture2D(CloudMap, v2.yz).w * (1.0 - base) + base;
    a *= min((v1.x * v2.w / Properties.x - 1.0) / StretchStartFlare.w, 1.0);
    colour = ends * a * Color * Properties.y;
  } else if (v1.z < 1.5) {
    // the core: by angle and radius (rr 1 at its centre, 0 at half its radius), fire outside, a vortex inside, a ring
    float ang = atan(v1.y, v1.x) * 0.159155 + 0.5;
    float rr = 1.0 - length(2.0 * v1.xy);
    float t = timing.w + timing.y;
    vec2 g = vec2(dFdx(rr)), h = vec2(dFdy(rr));
    float val;
    if (rr < 0.0) {
      float s = textureGrad(CloudMap, vec2(ang, rr) * CoreFireAnimation.xy + t * CoreFireAnimation.zw, g, h).x;
      val = pow(max(s + rr / CoreFireLook.x, 0.0), CoreFireLook.y) * CoreFireLook.z;
    } else {
      float s = textureGrad(CloudMap, vec2(ang - rr * CoreVortexLook.x, -rr) * CoreVortexAnimation.xy + t * CoreVortexAnimation.zw, g, h).y;
      val = pow(max(s - rr / CoreVortexLook.y, 0.0), CoreVortexLook.z) * CoreVortexLook.w;
    }
    val += pow(max(Border.x - abs(rr) / Border.x, 0.0), Border.z) * Border.y;
    colour = val * Properties.y * Color;
  } else if (v1.z < 3.5) colour = flare() * Properties.y;
  else if (v1.z < 4.5) {
    // the start flare: its falloff, soft into the scene, to the power StretchStartFlare.z
    float sz = sqrt(v2.x / StretchStartFlare.x / Properties.x);
    float d = length(v1.xy);
    float soft = clamp((sceneDistance() - (-v2.y - sz * 30.0)) / (sz * 30.0), 0.0, 1.0);
    float r = max(1.0 - d, 0.0) * soft;
    colour = pow(r, StretchStartFlare.z) * Color * Properties.y * Properties.y * StretchStartFlare.y;
  } else {
    colour = splash();
    flick = Flicker.zw;
  }
  finish(colour, flick);
}`;

/** A texture an effect reads: clamped (its sampler EveSceneFogSampler) or wrapped, and whether it is read as sRGB. */
interface EffectTexture { clamp: boolean; srgb: boolean }
interface EffectDef { vertex: string; fragment: string; defaults: Record<string, number | number[]>; textures: Record<string, EffectTexture> }
const WRAP = { clamp: false, srgb: false }, CLAMP = { clamp: true, srgb: false };
// each effect's shaders, its constants' defaults (the sm_depth record's constant table) and its sRGB textures
const EFFECTS: Record<string, EffectDef> = {
  laser: {
    vertex: LASER_VERTEX, fragment: LASER_FRAGMENT, textures: { NoiseMap: WRAP, FalloffMap: CLAMP, CloudMap: WRAP },
    defaults: { Intensity: 1, FlareIntensity: [4, 4, 4, 4], Clouds: [0, 1, 0, -0.91], SplashIntensity: [1, 1, 0.1, 1], Flicker: [0, 1, 0, 1], Color: [1, 1, 1, 1], SplashAnimation: [1, 0.1, 0.1, 0.5] },
  },
  projectile: {
    vertex: PROJECTILE_VERTEX, fragment: PROJECTILE_FRAGMENT, textures: { NoiseMap: WRAP, FalloffMap: CLAMP, CloudMap: { clamp: false, srgb: true } },
    defaults: { Intensity: 1, FireParams: [100, 1, 4, 0.1], FlareIntensity: [4, 4, 4, 4], Shots: [1, 1000, 1000, 0], SplashIntensity: [1, 1, 0.1, 0], Flicker: [0, 1, 0, 0], Color: [1, 1, 1, 1], SplashAnimation: [1, 0.1, 0.1, 0.5] },
  },
  blast: {
    vertex: BLAST_VERTEX, fragment: BLAST_FRAGMENT,
    textures: { NoiseMap: WRAP, FalloffMap: CLAMP, StretchFalloffMap: CLAMP, CloudMap: { clamp: false, srgb: true }, ShotsMap: { clamp: true, srgb: true } },
    defaults: { Intensity: 1, FireParams: [100, 1, 4, 0.1], FlareIntensity: [4, 4, 4, 4], Shots: [0.1, 0.7, 1000, 1], SplashIntensity: [1, 1, 0.1, 0.9], Clouds: [0, 1, 0, 0], Flicker: [0, 1, 0, 0], Color: [1, 1, 1, 1], SplashAnimation: [1, 0.1, 0.1, 0.5] },
  },
  artillery: {
    vertex: ARTILLERY_VERTEX, fragment: ARTILLERY_FRAGMENT,
    textures: { NoiseMap: WRAP, FalloffMap: CLAMP, CloudMap: { clamp: false, srgb: true } },
    defaults: { Intensity: 1, FireParams: [100, 1, 4, 0.1], FlareIntensity: [4, 4, 4, 4], Clouds: [0, 1, 0, 0], Shots: [0.1, 0.7, 50, 1], SplashIntensity: [1, 1, 0.1, 0], Flashes: [0.3, 0.3, 0.3, 0.3], Flicker: [0, 1, 0, 0], Color: [1, 1, 1, 1], SplashAnimation: [1, 0.1, 0.1, 0.5] },
  },
  atomic: {
    vertex: ATOMIC_VERTEX, fragment: ATOMIC_FRAGMENT,
    textures: { NoiseMap: WRAP, FalloffMap: CLAMP, CloudMap: WRAP },
    defaults: {
      Intensity: 1, Properties: [1, 1, 10, 10], StretchStartFlare: [2, 170, 40, 30], FlareIntensity: [4, 4, 4, 4], Clouds: [0, 1, 0, -0.91],
      SplashIntensity: [1, 1, 0.1, 1], Border: [0.03, 0.7, 1, 0], CoreFireAnimation: [3, 0.1, 0.03, 0.2], CoreFireLook: [0.5, 3, 1, 0],
      CoreVortexAnimation: [1, 0.3, 0.01, 0.1], CoreVortexLook: [1, 0.5, 3, 1], Flicker: [0, 1, 0, 1], Color: [1, 1, 1, 1], SplashAnimation: [1, 0.1, 0.1, 0.5],
    },
  },
};

/** The quads' vertices: (quad index, corner index), two triangles a quad. */
function quadGeometry(count: number): THREE.BufferGeometry {
  const pos = new Float32Array(count * 4 * 3);
  const index: number[] = [];
  for (let q = 0; q < count; q++) {
    for (let c = 0; c < 4; c++) { pos[(q * 4 + c) * 3] = q; pos[(q * 4 + c) * 3 + 1] = c; }
    index.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

const v4 = (v: number | number[] | undefined, d: number[]) => { const a = Array.isArray(v) ? v : d; return new THREE.Vector4(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0); };

/** A stretch's textures, loaded once per file and use (FalloffMap clamped, as its sampler; the others wrapped; sRGB where the effect's resource says). */
const maps = new Map<string, Promise<THREE.Texture | null>>();
function mapOf(url: string | null | undefined, clamp: boolean, srgb = false): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  const key = `${url}|${clamp}|${srgb}`;
  let p = maps.get(key);
  if (!p) {
    p = loadDds(url).then((t) => {
      const tex = clamp || srgb ? t.clone() : t;
      if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      tex.needsUpdate = true;
      return tex as THREE.Texture;
    }).catch(() => null);
    maps.set(key, p);
  }
  return p;
}

/** What a stretch needs before it can be drawn: its textures. */
export interface Stretch2Kit { spec: SofStretch2; maps: Record<string, THREE.Texture | null> }
export async function stretch2Kit(spec: SofStretch2): Promise<Stretch2Kit | null> {
  if (!spec.effect || !STRETCH2_EFFECTS.has(spec.effect) || spec.quadCount <= 0) return null;
  const def = EFFECTS[spec.effect]!;
  const names = Object.keys(def.textures);
  const loaded = await Promise.all(names.map((n) => mapOf(spec.textures[n], def.textures[n]!.clamp, def.textures[n]!.srgb)));
  return { spec, maps: Object.fromEntries(names.map((n, i) => [n, loaded[i] ?? null])) };
}

/** A curve set's play state (TriCurveSet: PlayFrom, Stop; its scaled time). */
class SetRun {
  playing = false;
  private from = 0;
  private at = 0;
  time = 0;
  constructor(readonly set: StretchSet) {}
  playFrom(t: number, now: number): void { this.playing = true; this.from = t; this.at = now; this.time = t * this.set.scale; }
  stop(): void { this.playing = false; }
  update(now: number): void { if (this.playing) this.time = (this.from + (now - this.at) / 1000) * this.set.scale; }
}

/** A binding's destination component (".x" .. ".w", ".r" .. ".a"). */
const COMPONENT: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

/** A curve's value as a binding reads it (a constant's value, a colour's or vector's parts, a scalar's number). */
function valueOf(c: Curve, time: number): number | number[] {
  switch (c.type) {
    case "Tr2CurveConstant": return ((c as { value?: number[] }).value ?? [0, 0, 0, 0]).slice();
    case "Tr2CurveColor": return colorValue(c as never, time);
    case "Tr2CurveVector3": return vector3Value(c as never, time);
    default: return curveValue(c, time);
  }
}

/** One stretch drawn: its mesh (in its owner's space), its curve sets and lights. */
export class Stretch2Effect {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly sets: { start: SetRun | null; loop: SetRun | null; end: SetRun | null };
  private readonly source = new THREE.Vector3();
  private readonly dest = new THREE.Vector3();
  private destScale = 1;
  private sourceLight: ChildLight | null;
  private destLight: ChildLight | null;
  /** Its GPU emitters (each its own copy of the data: bindings set it). */
  readonly emitters: { source: GpuEmitter | null; destination: GpuEmitter | null };
  /** The firing effect's stretches by index (a binding may reach another's emitter); itself alone unless told. */
  peers: Stretch2Effect[] = [this];

  constructor(private readonly kit: Stretch2Kit) {
    const spec = kit.spec;
    const def = EFFECTS[spec.effect!]!;
    // the effect's constants: the stretch's own values, else the effect's defaults (a float, or a vector as a vec4)
    const constants: Record<string, THREE.IUniform> = {};
    for (const [name, d] of Object.entries(def.defaults)) {
      const v = spec.params[name] ?? d;
      constants[name] = { value: Array.isArray(d) ? v4(v, d) : Number(Array.isArray(v) ? v[0] : v) };
    }
    this.material = new THREE.ShaderMaterial({
      vertexShader: def.vertex, fragmentShader: def.fragment,
      uniforms: {
        srcPos: { value: new THREE.Vector4(0, 0, 0, 1) }, dstPos: { value: new THREE.Vector4(0, 0, 0, 1) },
        timing: { value: new THREE.Vector4(0, 0, 0, Math.random()) }, misc: { value: new THREE.Vector4(1, 0, 0, 0) },
        viewport: { value: new THREE.Vector2(1, 1) },
        ...constants,
        ...Object.fromEntries(Object.entries(kit.maps).map(([n, t]) => [n, { value: t }])),
        ...SOFT_DEPTH,
      },
      // TRIBATCHTYPE_ADDITIVE: added, tested against the scene's depth, not written
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    });
    this.material.userData.softDepth = true;
    this.mesh = new THREE.Mesh(quadGeometry(spec.quadCount), this.material);
    this.mesh.name = `stretch2:${spec.name ?? ""}`;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // each set a copy of its curves (the Ammo constant is set per firing)
    const run = (s: StretchSet | null) => (s ? new SetRun({ ...s, curves: s.curves.map((c) => structuredClone(c)) }) : null);
    this.sets = { start: run(spec.start), loop: run(spec.loop), end: run(spec.end) };
    const light = (l: StretchLight | null): ChildLight | null => (l ? { position: [0, 0, 0], radius: l.radius, color: l.color.slice(), brightness: l.brightness } : null);
    const emitter = (e: GpuEmitterData | null | undefined) => (e ? new GpuEmitter(structuredClone(e)) : null);
    this.emitters = { source: emitter(spec.sourceEmitter), destination: emitter(spec.destinationEmitter) };
    this.sourceLight = light(spec.sourceLight);
    this.destLight = light(spec.destinationLight);
    this.mesh.userData.lights = [];
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      const size = renderer.getSize(new THREE.Vector2());
      (this.material.uniforms.viewport!.value as THREE.Vector2).copy(size);
      offerLights(renderer, camera, this.mesh);
    };
  }

  /** turretSet.py SetAmmoColor: every "Ammo" constant curve takes the charge's colour. */
  setAmmoColor(color: number[]): void {
    for (const r of [this.sets.start, this.sets.loop, this.sets.end]) {
      for (const c of r?.set.curves ?? []) if (c.type === "Tr2CurveConstant" && (c as { name?: string }).name === "Ammo") (c as { value?: number[] }).value = color.slice();
    }
  }

  /** turretSet.py SetIntensity: every "py_intensity" constant curve's first value (the Triglavian beams' spool-up). */
  setPyIntensity(value: number): void {
    for (const r of [this.sets.start, this.sets.loop, this.sets.end]) {
      for (const c of r?.set.curves ?? []) {
        if (c.type !== "Tr2CurveConstant" || (c as { name?: string }).name !== "py_intensity") continue;
        const v = ((c as { value?: number[] }).value ?? [0, 0, 0, 0]).slice();
        v[0] = value;
        (c as { value?: number[] }).value = v;
      }
    }
  }

  /** EveStretch2::StartFiring: a new random; start and loop played from the delay (nought or past it), end stopped. */
  startFiring(delay: number, now = performance.now()): void {
    (this.material.uniforms.timing!.value as THREE.Vector4).w = Math.random();
    this.sets.start?.playFrom(-delay, now);
    this.sets.loop?.playFrom(-delay, now);
    this.sets.end?.stop();
  }
  /** EveStretch2::StopFiring. */
  stopFiring(now = performance.now()): void {
    this.sets.start?.stop();
    this.sets.loop?.stop();
    this.sets.end?.playFrom(0, now);
  }

  /** SetFiringTransform (the muzzle's place and the target's), SetDestObjectScale / DisplayEndPoints, SetIntensity. */
  place(source: THREE.Vector3, dest: THREE.Vector3, destScale: number, intensity: number): void {
    this.source.copy(source);
    this.dest.copy(dest);
    this.destScale = destScale;
    (this.material.uniforms.misc!.value as THREE.Vector4).x = intensity;
  }

  /** EveStretch2::Update: the sets' times and bindings, the end frames, the lights and emitters in them. */
  update(now = performance.now(), system: GpuParticleSystem | null = null): void {
    const u = this.material.uniforms;
    const timing = u.timing!.value as THREE.Vector4;
    timing.x = timing.y = timing.z = 0;
    const order: [keyof Stretch2Effect["sets"], "x" | "y" | "z"][] = [["start", "x"], ["loop", "y"], ["end", "z"]];
    for (const [k, c] of order) {
      const r = this.sets[k];
      if (!r) continue;
      r.update(now);
      timing[c] = r.time;
      if (r.playing) this.bind(r);
    }
    (u.srcPos!.value as THREE.Vector4).set(this.source.x, this.source.y, this.source.z, this.destScale);
    (u.dstPos!.value as THREE.Vector4).set(this.dest.x, this.dest.y, this.dest.z, this.destScale);
    // GetEndPointTransforms: z along the beam, x from the axis least along it; the target's frame turned about y
    const z = this.dest.clone().sub(this.source);
    const ax = Math.abs(z.x), ay = Math.abs(z.y), az = Math.abs(z.z);
    const up = ax < ay && ax < az ? new THREE.Vector3(1, 0, 0) : ay < ax && ay < az ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    z.normalize();
    const x = up.clone().cross(z).normalize(), y = x.clone().cross(z);
    const lights: ChildLight[] = [];
    const at = (l: ChildLight | null, spec: StretchLight | null, origin: THREE.Vector3, sign: number, scale: number) => {
      if (!l || !spec || !(l.brightness > 0)) return;
      const p = spec.position;
      const pos = origin.clone().addScaledVector(x, sign * (p[0] ?? 0)).addScaledVector(y, p[1] ?? 0).addScaledVector(z, sign * (p[2] ?? 0));
      lights.push({ position: pos.toArray(), radius: spec.radius * scale, color: l.color, brightness: l.brightness });
    };
    at(this.sourceLight, this.kit.spec.sourceLight, this.source, 1, 1);
    at(this.destLight, this.kit.spec.destinationLight, this.dest, -1, this.destScale);
    this.mesh.userData.lights = lights;
    // the emitters at the end frames (the source's: z along the beam; the target's: z and x turned back)
    if (system) {
      const t = now / 1000;
      this.emitters.source?.update(t, new THREE.Matrix4().makeBasis(x, y, z).setPosition(this.source), system);
      this.emitters.destination?.update(t, new THREE.Matrix4().makeBasis(x.clone().negate(), y, z.clone().negate()).setPosition(this.dest), system);
    }
  }

  /** A playing set's bindings copied (TriValueBinding: a scalar x scale + offset.x, a vector part by part). */
  private bind(r: SetRun): void {
    const u = this.material.uniforms;
    for (const b of r.set.bindings) {
      const curve = b.source !== null ? r.set.curves[b.source] : b.sourceCurve;
      if (!curve) continue;
      const src = valueOf(curve, r.time);
      const scalar = (v: number | number[]) => (Array.isArray(v) ? (v[0] ?? 0) : v) * b.scale + (b.offset[0] ?? 0);
      const vector = (v: number | number[]) => [0, 1, 2, 3].map((i) => (Array.isArray(v) ? (v[i] ?? 0) : v) * b.scale + (b.offset[i] ?? 0));
      if (b.target.startsWith("param:")) {
        const uni = u[b.target.slice(6)];
        if (!uni) continue;
        const comp = COMPONENT[b.destinationAttribute.split(".")[1] ?? ""];
        if (uni.value instanceof THREE.Vector4 && comp !== undefined) uni.value.setComponent(comp, scalar(src));
        else if (uni.value instanceof THREE.Vector4) uni.value.fromArray(vector(src));
        else uni.value = scalar(src);
        continue;
      }
      if (b.target.startsWith("emitter:")) {
        const [, i, end] = b.target.split(":");
        const e = this.peers[Number(i)]?.emitters[end === "destination" ? "destination" : "source"];
        const attr = b.destinationAttribute.split(".")[0] ?? "";
        if (e && attr) e.setValue(attr, /^colou?r/.test(attr) ? vector(src) : scalar(src));
        continue;
      }
      const light = b.target === "sourceLight" ? this.sourceLight : b.target === "destinationLight" ? this.destLight : null;
      if (!light) continue;
      if (b.destinationAttribute === "brightness") light.brightness = scalar(src);
      else if (b.destinationAttribute === "color") light.color = vector(src);
      else if (b.destinationAttribute === "radius") light.radius = scalar(src);
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
