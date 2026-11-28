import { ShaderChunk, type MeshStandardMaterial } from "three";
import type { PortraitSurfaceFinish } from "./portraitImplant.ts";

export function applyPortraitHairFinish(material: MeshStandardMaterial, finish: PortraitSurfaceFinish): void {
  const { Normal: normal, Specular: specular } = finish;
  material.normalMap = normal?.texture ?? null;
  material.customProgramCacheKey = () => `portrait-hair:${Boolean(normal)}:${Boolean(specular)}`;
  material.onBeforeCompile = shader => {
    if (normal) {
      shader.uniforms.portraitHairNormalRect = { value: normal.rect };
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
        #include <map_pars_fragment>
        uniform vec4 portraitHairNormalRect;
      `).replace("#include <normal_fragment_maps>", ShaderChunk.normal_fragment_maps.replace(
        "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
        `vec2 hairNormalUv = (vNormalMapUv - portraitHairNormalRect.xy) / portraitHairNormalRect.zw;
         vec2 hairNormalInside = step(vec2(0.0), hairNormalUv) * step(hairNormalUv, vec2(1.0));
         vec2 hairNormal = (texture2D(normalMap, hairNormalUv).ag * 2.0 - 1.0) * hairNormalInside.x * hairNormalInside.y;
         vec3 mapN = vec3(hairNormal, sqrt(max(0.0, 1.0 - dot(hairNormal, hairNormal))));`,
      ));
    }
    if (specular) {
      shader.uniforms.portraitHairSpecular = { value: specular.texture };
      shader.uniforms.portraitHairSpecularRect = { value: specular.rect };
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
        #include <map_pars_fragment>
        uniform sampler2D portraitHairSpecular;
        uniform vec4 portraitHairSpecularRect;
      `).replace("#include <roughnessmap_fragment>", `
        #include <roughnessmap_fragment>
        vec2 hairSpecularUv = (vMapUv - portraitHairSpecularRect.xy) / portraitHairSpecularRect.zw;
        vec2 hairSpecularInside = step(vec2(0.0), hairSpecularUv) * step(hairSpecularUv, vec2(1.0));
        float hairSpecularWeight = hairSpecularInside.x * hairSpecularInside.y;
        vec4 hairSpecular = texture2D(portraitHairSpecular, hairSpecularUv);
        roughnessFactor = mix(roughnessFactor, 1.0 - hairSpecular.a, hairSpecularWeight);
      `).replace("#include <lights_physical_fragment>", `
        #include <lights_physical_fragment>
        material.specularColor *= mix(1.0, hairSpecular.r, hairSpecularWeight);
      `);
    }
  };
}
