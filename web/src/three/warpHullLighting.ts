import * as THREE from "three";
import { curveValue } from "./curves.ts";

const SECONDARY_INTENSITY = 3.14;
const STATIC_COLOR = new THREE.Vector3(0.5647059, 0.9960784, 1);
const MOVING_COLOR = new THREE.Vector3(0.2705882, 0.6156862, 1);
const WHITE = new THREE.Vector3(1, 1, 1);
const RADIUS_CURVE = { type: "TriPerlinCurve", offset: 0.2, scale: 0.2 };

interface MovingLight {
  start: number;
  x: number;
  y: number;
  color: THREE.Vector3;
}

/** Warp.py's point lights projected onto the hull's world-space L2 spherical harmonics. */
export class WarpHullLighting {
  readonly uniforms = {
    warpLightActive: { value: false },
    warpLightSH: { value: Array.from({ length: 7 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  };
  private readonly phases = [Math.random() * 128, Math.random() * 128];
  private readonly moving: MovingLight[] = [];
  private nextLight = -Infinity;

  clear(): void {
    if (this.nextLight === -Infinity) return;
    this.uniforms.warpLightActive.value = false;
    for (const coefficient of this.uniforms.warpLightSH.value) coefficient.set(0, 0, 0, 0);
    this.moving.length = 0;
    this.nextLight = -Infinity;
  }

  update(sim: number, intensity: number, fade: { entering: number; leaving: number; brightness: number }): void {
    if (sim >= this.nextLight) {
      while (this.moving[0] && sim - this.moving[0].start > 350) this.moving.shift();
      const angle = Math.random() * Math.PI * 2;
      this.moving.push({
        start: sim, x: Math.sin(angle) * 1.5, y: Math.cos(angle) * 1.5,
        color: MOVING_COLOR.clone().lerp(WHITE, Math.random()),
      });
      this.nextLight = sim + 100 + Math.random() * 400;
    }

    const envelope = THREE.MathUtils.clamp(intensity + 2 * Math.max(0, fade.entering - fade.leaving), 0, 1);
    const power = 2 * SECONDARY_INTENSITY * fade.brightness * envelope;
    this.uniforms.warpLightActive.value = power > 0.0001;
    for (const coefficient of this.uniforms.warpLightSH.value) coefficient.set(0, 0, 0, 0);
    if (!this.uniforms.warpLightActive.value) return;
    for (let i = 0; i < this.phases.length; i++) {
      const radius = curveValue(RADIUS_CURVE, sim / 1000 + this.phases[i]!);
      this.add(0, 0, 2 * i - 1, radius, STATIC_COLOR, power);
    }
    for (const light of this.moving) {
      const z = Math.max(-6, 2 - 0.02 * Math.max(0, sim - light.start));
      this.add(light.x, light.y, z, 0.7, light.color, power);
    }
  }

  private add(x: number, y: number, z: number, radius: number, color: THREE.Vector3, power: number): void {
    const d = Math.hypot(x, y, z);
    if (d < 1 || radius <= 0) return;
    x /= d; y /= d; z /= d;
    const sinSq = Math.min(1, (radius / d) ** 2), cos = Math.sqrt(1 - sinSq);
    const band0 = 0.5 * (1 - cos), band1 = 0.5 * sinSq, band2 = -cos * sinSq;
    // Tr2ShLightingManager::ShSolver<L2>'s normalization and packing, combined.
    const zBand = 0.078125 * (3 * z * z - 1) * band2;
    const sh = this.uniforms.warpLightSH.value;
    for (let channel = 0; channel < 3; channel++) {
      const scale = color.getComponent(channel) * power;
      const a = sh[channel]!, b = sh[channel + 3]!;
      a.x += scale * x * band1; a.y += scale * y * band1; a.z += scale * z * band1;
      a.w += scale * (band0 - zBand);
      b.x += scale * 0.9375 * x * y * band2; b.y -= scale * 0.9375 * y * z * band2;
      b.z += scale * 3 * zBand; b.w -= scale * 0.9375 * z * x * band2;
      const last = sh[6]!;
      last.setComponent(channel, last.getComponent(channel) + scale * 0.234375 * (x * x - y * y) * band2);
    }
  }
}

const WARP_LIGHT_GLSL = `
  uniform bool warpLightActive;
  uniform vec4 warpLightSH[7];
  vec3 warpLighting(vec3 direction, float constantBand) {
    vec3 n = normalize(direction * mat3(viewMatrix));
    n.z = -n.z;
    vec4 a = vec4(n, constantBand);
    vec4 b = n.yzzx * n.xyzz;
    vec3 first = vec3(dot(warpLightSH[0], a), dot(warpLightSH[1], a), dot(warpLightSH[2], a));
    vec3 second = vec3(dot(warpLightSH[3], b), dot(warpLightSH[4], b), dot(warpLightSH[5], b));
    return max(first + second + warpLightSH[6].rgb * (n.x * n.x - n.y * n.y), 0.0);
  }
`;

/** quadv5's High shader samples L2 for ambient diffuse and in the reflected direction for specular. */
export function applyWarpHullLighting(shader: Parameters<THREE.Material["onBeforeCompile"]>[0], light: WarpHullLighting): void {
  Object.assign(shader.uniforms, light.uniforms);
  shader.fragmentShader = WARP_LIGHT_GLSL + shader.fragmentShader.replace(
    "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
    `vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
      if (warpLightActive) {
        vec3 viewing = normalize(vViewPosition);
        vec3 fresnel = mix(material.specularColor, vec3(1.0), pow(1.0 - clamp(dot(normal, viewing), 0.0, 1.0), 5.0));
        float alpha = material.roughness * material.roughness;
        outgoingLight += warpLighting(normal, 1.0) * material.diffuseColor * (1.0 - fresnel) * RECIPROCAL_PI
                       + warpLighting(reflect(-viewing, normal), 0.0) * fresnel * (alpha / (5.0 - 4.0 * alpha));
      }`,
  );
}
