import type { Color, Texture, Vector4, WebGLProgramParametersWithUniforms } from "three";

export interface PortraitColorLayer {
  diffuse: Texture;
  zones: Texture;
  colors: Color[];
  diffuseRect: Vector4;
  zonesRect: Vector4;
  weight: number;
  gloss: number | null;
}

export function compositePortraitColorLayer(shader: WebGLProgramParametersWithUniforms, name: string, layer: PortraitColorLayer): void {
  shader.uniforms[name + "Detail"] = { value: layer.diffuse };
  shader.uniforms[name + "Zones"] = { value: layer.zones };
  shader.uniforms[name + "Colors"] = { value: layer.colors };
  shader.uniforms[name + "Rect"] = { value: layer.diffuseRect };
  shader.uniforms[name + "ZonesRect"] = { value: layer.zonesRect };
  shader.uniforms[name + "Opacity"] = { value: layer.weight };
  shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
    #include <map_pars_fragment>
    uniform sampler2D ${name}Detail;
    uniform sampler2D ${name}Zones;
    uniform vec3 ${name}Colors[3];
    uniform vec4 ${name}Rect;
    uniform vec4 ${name}ZonesRect;
    uniform float ${name}Opacity;
  `).replace("#include <color_fragment>", `
    float ${name}Mask;
    {
      vec2 uv = (vMapUv - ${name}Rect.xy) / ${name}Rect.zw;
      vec2 zoneUV = (vMapUv - ${name}ZonesRect.xy) / ${name}ZonesRect.zw;
      vec4 detail = texture2D(${name}Detail, uv);
      vec3 zones = texture2D(${name}Zones, zoneUV).rgb;
      float weight = dot(zones, vec3(1.0));
      vec3 tint = zones.r * ${name}Colors[0] + zones.g * ${name}Colors[1] + zones.b * ${name}Colors[2];
      tint = mix(${name}Colors[0], tint / max(weight, 0.001), clamp(weight, 0.0, 1.0));
      float inside = step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
      ${name}Mask = detail.a * inside * ${name}Opacity;
      diffuseColor.rgb = mix(diffuseColor.rgb, detail.rgb * tint, ${name}Mask);
    }
    #include <color_fragment>
  `);
  if (layer.gloss !== null) {
    shader.uniforms[name + "Gloss"] = { value: layer.gloss };
    shader.fragmentShader = shader.fragmentShader.replace("#include <roughnessmap_pars_fragment>", `
      #include <roughnessmap_pars_fragment>
      uniform float ${name}Gloss;
    `).replace("#include <roughnessmap_fragment>", `
      #include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, mix(0.92, 0.24, ${name}Gloss), ${name}Mask);
    `);
  }
}
