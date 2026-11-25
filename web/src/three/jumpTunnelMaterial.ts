import * as THREE from "three";
import type { SofChildMeshArea } from "./hullChildren.ts";
import { logDepth } from "./logDepth.ts";

export const JUMP_TUNNEL_MATERIAL = "jump-tunnel-uber";

/** The 3698585 JumpTunnelUber cloud and scrolling surface. Limit the cloud march for browser Low. */
export function jumpTunnelMaterial(area: SofChildMeshArea, time: THREE.IUniform<number>,
  load: (url: string | null | undefined) => Promise<THREE.Texture | null>): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = { time, steps: { value: 4 } };
  const vector = (name: string, fallback: number[]) => {
    const value = area.params[name];
    uniforms[name] = { value: new THREE.Vector4().fromArray(Array.isArray(value) ? value : fallback) };
  };
  const scalar = (name: string, fallback: number) => {
    const value = area.params[name];
    uniforms[name] = { value: Array.isArray(value) ? value[0] : value ?? fallback };
  };
  for (let i = 1; i <= 3; i++) {
    vector(`TransformDiffuse${i}`, [0, 0, 1, 1]);
    vector(`ScrollDiffuse${i}`, [0, 0, 0, 0]);
    vector(`DiffuseColor${i}`, [1, 1, 1, 1]);
  }
  vector("Tiling1", [0.1, 0.1, 0, 1]);
  vector("TilingWave", [0.1, 0.1, 0, 5]);
  vector("TilingColor", [0.05, 0.05, 0, 1]);
  vector("Color1", [1, 1, 1, 1]);
  vector("Color2", [1, 1, 1, 1]);
  vector("AlphaMaskTransform", [0, 0, 1, 1]);
  vector("AlphaMaskScroll", [0, 0, 0, 0]);
  scalar("AlphaMaskStrength", 1);
  scalar("Speed", 1);
  scalar("WaveAmount", 0.6);
  scalar("WaveDistortion", 0.05);
  scalar("CloudScale", 1);
  scalar("CloudBias", 0);
  scalar("CloudDensity", 1);
  scalar("ColPow", 5);
  scalar("ColFactor", 20);
  scalar("Brightness", 1);
  const material = logDepth(new THREE.ShaderMaterial({
    name: JUMP_TUNNEL_MATERIAL, uniforms, transparent: true, depthWrite: false,
    vertexShader: `
      varying vec2 tunnelUv;
      void main() {
        tunnelUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec2 tunnelUv;
      uniform float time, Speed, WaveAmount, WaveDistortion, CloudScale, CloudBias, CloudDensity;
      uniform float ColPow, ColFactor, Brightness, AlphaMaskStrength;
      uniform int steps;
      uniform vec4 Tiling1, TilingWave, TilingColor, Color1, Color2, AlphaMaskTransform, AlphaMaskScroll;
      uniform vec4 TransformDiffuse1, TransformDiffuse2, TransformDiffuse3;
      uniform vec4 ScrollDiffuse1, ScrollDiffuse2, ScrollDiffuse3, DiffuseColor1, DiffuseColor2, DiffuseColor3;
      uniform sampler2D DiffuseMap1, DiffuseMap2, DiffuseMap3, AlphaMask, CloudTex1, WaveTex, ColorTex;

      vec4 cloudLayer(vec2 uv, float z, float clock) {
        vec3 wave = texture2D(WaveTex, uv * TilingWave.xy + TilingWave.zw * clock).rgb - 0.5;
        vec4 cloud = texture2D(CloudTex1, uv * Tiling1.xy + Tiling1.zw * clock + wave.xy * WaveDistortion);
        float density = (cloud.a + wave.z * WaveAmount) * CloudScale + CloudBias;
        float tint = pow(1.0 - clamp(density, 0.0, 1.0), ColPow);
        vec3 colours = texture2D(ColorTex, uv * TilingColor.xy + TilingColor.zw * clock).rgb;
        vec3 colour = cloud.rgb * mix(Color2.rgb, colours * Color1.rgb * ColFactor, tint) + tint;
        float alpha = clamp((density - (1.0 - z) * (1.0 - z)) * CloudDensity, 0.0, 1.0);
        return vec4(colour * alpha, alpha);
      }

      vec2 surfaceUV(vec4 transform, vec4 scroll) {
        return tunnelUv * transform.zw + transform.xy + scroll.xy * time + scroll.zw;
      }

      void main() {
        float clock = time * Speed;
        vec4 cloud = vec4(0.05, 0.05, 0.05, 0.2);
        for (int i = 0; i < 10; i++) {
          if (i >= steps || cloud.a >= 0.995) break;
          float z = (float(i) + 0.5) / float(steps);
          cloud += cloudLayer(tunnelUv, z, clock) * (1.0 - cloud.a);
        }
        cloud.rgb += cloudLayer(tunnelUv, 1.0, clock).rgb * (1.0 - cloud.a);
        vec4 inner = texture2D(DiffuseMap1, surfaceUV(TransformDiffuse1, ScrollDiffuse1)) * DiffuseColor1;
        inner *= texture2D(DiffuseMap2, surfaceUV(TransformDiffuse2, ScrollDiffuse2)) * DiffuseColor2;
        inner *= texture2D(DiffuseMap3, surfaceUV(TransformDiffuse3, ScrollDiffuse3)) * DiffuseColor3;
        vec2 maskUv = tunnelUv * AlphaMaskTransform.zw + AlphaMaskTransform.xy
          + AlphaMaskScroll.xy * time + AlphaMaskScroll.zw;
        float alpha = clamp(texture2D(AlphaMask, maskUv).a * AlphaMaskStrength, 0.0, 1.0);
        gl_FragColor = vec4(mix(cloud.rgb, inner.rgb * Brightness, inner.a * Brightness), alpha);
      }`,
  }));
  material.visible = false;
  const textures = ["DiffuseMap1", "DiffuseMap2", "DiffuseMap3", "AlphaMask", "CloudTex1", "WaveTex", "ColorTex"];
  for (const name of textures) uniforms[name] = { value: null };
  material.userData.ready = Promise.all(textures.map(async (name) => {
    const texture = await load(area.textures[name]);
    uniforms[name]!.value = texture;
    return texture !== null;
  })).then((loaded) => { material.visible = loaded.every(Boolean); return material.visible; });
  return material;
}
