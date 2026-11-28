import type { Texture, Vector4, WebGLProgramParametersWithUniforms } from "three";

export interface PortraitImplantMap {
  texture: Texture;
  rect: Vector4;
}

export interface PortraitImplantMaps {
  Diffuse: PortraitImplantMap;
  Normal: PortraitImplantMap;
  Specular: PortraitImplantMap;
}

export function compositePortraitImplant(shader: WebGLProgramParametersWithUniforms, maps: PortraitImplantMaps): void {
  for (const [role, map] of Object.entries(maps)) {
    shader.uniforms["portraitImplant" + role] = { value: map.texture };
    shader.uniforms["portraitImplant" + role + "Rect"] = { value: map.rect };
  }
  shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
    #include <map_pars_fragment>
    uniform sampler2D portraitImplantDiffuse, portraitImplantNormal, portraitImplantSpecular;
    uniform vec4 portraitImplantDiffuseRect, portraitImplantNormalRect, portraitImplantSpecularRect;
    vec4 samplePortraitImplant(sampler2D map, vec4 rect, vec2 uv) {
      vec2 local = (uv - rect.xy) / rect.zw;
      vec2 inside = step(vec2(0.0), local) * step(local, vec2(1.0));
      vec4 sampleColor = texture2D(map, local);
      sampleColor.ba *= inside.x * inside.y;
      return sampleColor;
    }
  `).replace("#include <color_fragment>", `
    vec4 implantDiffuse = samplePortraitImplant(portraitImplantDiffuse, portraitImplantDiffuseRect, vMapUv);
    diffuseColor.rgb = mix(diffuseColor.rgb, implantDiffuse.rgb, implantDiffuse.a);
    #include <color_fragment>
  `).replace("#include <roughnessmap_fragment>", `
    #include <roughnessmap_fragment>
    vec4 implantSpecular = samplePortraitImplant(portraitImplantSpecular, portraitImplantSpecularRect, vMapUv);
    roughnessFactor = mix(roughnessFactor, 1.0 - implantSpecular.a, implantDiffuse.a);
  `).replace("#include <lights_physical_fragment>", `
    #include <lights_physical_fragment>
    material.specularColor *= mix(1.0, implantSpecular.r, implantDiffuse.a);
  `);
}
