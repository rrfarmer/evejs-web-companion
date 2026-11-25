import * as THREE from "three";

export interface WarpTunnelPass {
  parameters: Record<string, [number, number, number, number]>;
  textures: Record<string, string>;
}

const DEFORM = `
  uniform float Time;
  uniform vec4 MiscFactors, MiscFactors2, TextureParams;

  vec4 tunnelPosition() {
    // The sphere is mirrored on glTF import. Apply the native vertex offset and spin in its original frame.
    float turn = Time * MiscFactors.w;
    float wave = sin(Time * MiscFactors.y + MiscFactors.z * uv.y) * MiscFactors.x;
    vec2 point = vec2(position.x, -position.z + wave);
    float c = cos(turn), s = sin(turn);
    vec2 spun = mat2(c, -s, s, c) * point;
    return projectionMatrix * modelViewMatrix * vec4(spun.x, position.y, -spun.y, 1.0);
  }
`;

const TRANSPARENT_VERTEX = `
  ${DEFORM}
  uniform vec4 TunnelTextureParams;
  varying vec4 maskUV;
  varying vec2 cloudsUV;
  void main() {
    maskUV = vec4(uv, uv * TextureParams.xy + Time * TextureParams.zw);
    cloudsUV = uv * TunnelTextureParams.xy + Time * TunnelTextureParams.zw;
    gl_Position = tunnelPosition();
  }
`;

const TRANSPARENT_FRAGMENT = `
  uniform sampler2D MaskMap, CapTexture, TunnelMap;
  uniform vec4 Diffuse, RedShiftColor, BlueShiftColor, MiscFactors2;
  varying vec4 maskUV;
  varying vec2 cloudsUV;

  float capFalloff(float distance, float inner) {
    if (distance <= inner) return 1.0;
    float outer = min(inner * 3.0, 1.0);
    if (distance >= outer) return 0.0;
    float fade = (outer - distance) / (outer - inner);
    return fade * fade;
  }

  void main() {
    float mask = 1.0 + min(texture2D(MaskMap, maskUV.zw).r * 8.0, 1.0);
    float entrance = capFalloff(1.0 - maskUV.y * maskUV.y, clamp(MiscFactors2.z, 0.0, 1.0)) * mask;
    float exit = (1.0 - capFalloff(maskUV.y, 1.0 - clamp(MiscFactors2.x, 0.0, 1.0))) * mask;
    float cap = texture2D(CapTexture, maskUV.xy).g;
    vec4 shift = (maskUV.y >= 0.5 ? BlueShiftColor : RedShiftColor) * MiscFactors2.w * (1.0 - cap);
    float alpha = clamp(shift.a + MiscFactors2.z * min(entrance * entrance, 1.0) - min(exit * exit, 1.0), 0.0, 1.0);
    vec3 tint = alpha > 0.0 ? shift.rgb * (shift.a / alpha) : vec3(0.0);
    gl_FragColor = vec4(tint + texture2D(TunnelMap, cloudsUV).rgb * Diffuse.rgb * cap, alpha);
  }
`;

const ADDITIVE_VERTEX = `
  ${DEFORM}
  uniform vec4 LightningMapParam, LightningMaskMapParam, MiscFactors3;
  varying vec4 diffuseUV, lightningUV;
  varying vec3 strengths;
  void main() {
    vec2 scroll = Time * TextureParams.zw;
    diffuseUV = vec4(uv * TextureParams.xy + scroll,
                     (uv + vec2(0.4, 0.92)) * TextureParams.xy + 0.7 * scroll);
    lightningUV = vec4(
      uv * LightningMapParam.xy * vec2(1.0, MiscFactors2.y) +
        vec2(sin(Time * LightningMapParam.z), Time * LightningMapParam.w),
      uv * LightningMaskMapParam.xy * vec2(1.0, MiscFactors2.y) + Time * LightningMaskMapParam.zw
    );
    float flicker = sin(2.0 * Time + 0.5 * uv.y);
    float lightning = (0.6 * flicker * flicker + 0.4) * max(sin(6.283185 * Time), 0.7) * MiscFactors2.z;
    float fade = max(clamp(MiscFactors3.x, 0.0, 1.0) - clamp(MiscFactors3.y, 0.0, 1.0), 0.0);
    strengths = vec3(lightning, uv.y, clamp(2.0 * fade + MiscFactors2.w, 0.0, 1.0) * MiscFactors2.x);
    gl_Position = tunnelPosition();
  }
`;

const ADDITIVE_FRAGMENT = `
  uniform sampler2D LightningMap, MaskMap, DiffuseMap, CapTexture;
  uniform vec4 LightningColor, DiffuseColor, MiscFactors3;
  varying vec4 diffuseUV, lightningUV;
  varying vec3 strengths;
  void main() {
    float lightningMask = pow(texture2D(MaskMap, lightningUV.zw).r, 2.5);
    float bolt = texture2D(LightningMap, lightningUV.xy).g * lightningMask * strengths.x;
    vec4 second = texture2D(DiffuseMap, diffuseUV.zw);
    float flow = mix(texture2D(DiffuseMap, diffuseUV.xy).g, second.r, 0.35);
    vec3 color = DiffuseColor.rgb * flow + LightningColor.rgb * bolt * second.a * 0.25;
    float cap = texture2D(CapTexture, vec2(0.5, strengths.y)).g;
    gl_FragColor = vec4(color * strengths.z * cap + MiscFactors3.zzz, 1.0);
  }
`;

const DISTORTION_VERTEX = `
  uniform float Time, PreviousTime;
  uniform vec4 MiscFactors, MiscFactors2, TextureParams;
  varying vec4 noiseUV;
  varying vec2 offset;
  void main() {
    float turn = Time * MiscFactors.w;
    float c = cos(turn), s = sin(turn);
    mat2 spin = mat2(c, -s, s, c);
    vec2 spun = spin * vec2(position.x, -position.z);
    vec2 normalXZ = spin * vec2(normal.x, -normal.z);
    // The viewport is mirrored in X, and the GL distortion target's UV increases upwards.
    offset = vec2(normalXZ.x, -normalXZ.y * normal.y) * MiscFactors2.x * clamp(MiscFactors2.w, 0.0, 1.0);
    vec2 tiled = uv * TextureParams.xy;
    noiseUV = vec4(tiled + Time * TextureParams.zw, tiled + PreviousTime * TextureParams.zw);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(spun.x, position.y, -spun.y, 1.0);
  }
`;

const DISTORTION_FRAGMENT = `
  uniform sampler2D NoiseMap;
  uniform vec4 MiscFactors2;
  varying vec4 noiseUV;
  varying vec2 offset;
  void main() {
    float noise = mix(texture2D(NoiseMap, noiseUV.xy).r, texture2D(NoiseMap, noiseUV.zw).a, MiscFactors2.y);
    gl_FragColor = vec4(noise * offset / 64.0, 1.0 / 256.0, 0.1);
  }
`;

export function warpTunnelMaterial(
  pass: WarpTunnelPass, textures: ReadonlyMap<string, THREE.Texture>, kind: "transparent" | "additive" | "distortion",
): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = { Time: { value: 0 } };
  for (const [name, value] of Object.entries(pass.parameters)) uniforms[name] = { value: new THREE.Vector4(...value) };
  for (const [name, url] of Object.entries(pass.textures)) uniforms[name] = { value: textures.get(url) };
  const distortion = kind === "distortion";
  const additive = kind === "additive";
  if (distortion) uniforms.PreviousTime = { value: 0 };
  return new THREE.ShaderMaterial({
    name: distortion ? "WarpTunnelDistortion" : additive ? "WarpTunnelAdditive" : "WarpTunnelTransparent",
    uniforms,
    vertexShader: distortion ? DISTORTION_VERTEX : additive ? ADDITIVE_VERTEX : TRANSPARENT_VERTEX,
    fragmentShader: distortion ? DISTORTION_FRAGMENT : additive ? ADDITIVE_FRAGMENT : TRANSPARENT_FRAGMENT,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    // The color draws sort before the ship and blend over the sky. Distortion draws on its own layer.
    blending: THREE.CustomBlending,
    blendSrc: distortion || additive ? THREE.OneFactor : THREE.SrcAlphaFactor,
    blendDst: distortion || additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
  });
}
