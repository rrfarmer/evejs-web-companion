import * as THREE from "three";
import { sceneReflection } from "./celestialModel.ts";
import type { SofChildMeshArea } from "./hullChildren.ts";
import { logDepth } from "./logDepth.ts";

type Texture = (url: string | null | undefined) => Promise<THREE.Texture | null>;

function vector(value: number | number[] | null | undefined, defaults: readonly [number, number, number, number]): THREE.Vector4 {
  return new THREE.Vector4(...(Array.isArray(value) && value.length === 4 ? value as [number, number, number, number] : defaults));
}

/** The portal's WormholeFX surface from the build 3698585 sm_hi stages. */
export function wormholeMaterial(area: SofChildMeshArea, texture: Texture): THREE.ShaderMaterial {
  const p = area.params;
  const uniforms = {
    textureTransform: { value: vector(p.TextureTransform, [0, 0, 1, 1]) },
    materialDiffuseColor: { value: vector(p.MaterialDiffuseColor, [0.5, 0.5, 0.5, 1]) },
    specularCurve: { value: vector(p.MaterialSpecularCurve, [5, 20, 1, 0]) },
    specularFactors: { value: vector(p.MaterialSpecularFactors, [0.5, 1, 0, 0]) },
    reflectionFactors: { value: vector(p.ReflectionFactors, [1, 1, 0, 1]) },
    normalStrength: { value: typeof p.NormalStrength === "number" ? p.NormalStrength : 1 },
    cubeMapTint: { value: vector(p.CubeMapTint, [1, 1, 1, 1]) },
    diffuseMap: { value: null as THREE.Texture | null },
    normalMap: { value: null as THREE.Texture | null },
    reflectionMap: { value: null as THREE.Texture | null },
    hasReflectionMap: { value: false },
    sunDirection: { value: new THREE.Vector3(0, 1, 0) },
    sunColour: { value: new THREE.Color(1, 1, 1) },
  };
  const material = logDepth(new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      #ifndef USE_TANGENT
      attribute vec4 tangent;
      #endif
      uniform vec4 textureTransform;
      varying vec4 surfaceUV;
      varying vec3 surfaceNormal, surfaceTangent, surfaceBitangent, towardsEye;
      void main() {
        vec3 worldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        mat3 basis = mat3(modelMatrix);
        surfaceUV = vec4(uv, uv * textureTransform.zw + textureTransform.xy);
        surfaceNormal = basis * normal;
        surfaceTangent = basis * tangent.xyz;
        surfaceBitangent = basis * (cross(normal, tangent.xyz) * tangent.w);
        towardsEye = normalize(cameraPosition - worldPosition);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D diffuseMap, normalMap;
      uniform samplerCube reflectionMap;
      uniform bool hasReflectionMap;
      uniform vec4 materialDiffuseColor, specularCurve, specularFactors, reflectionFactors, cubeMapTint;
      uniform float normalStrength;
      uniform vec3 sunDirection, sunColour;
      varying vec4 surfaceUV;
      varying vec3 surfaceNormal, surfaceTangent, surfaceBitangent, towardsEye;
      void main() {
        vec2 slope = (texture2D(normalMap, surfaceUV.zw).ga * 2.0 - 1.0) * normalStrength;
        vec3 normal = normalize(surfaceNormal * sqrt(max(0.0, 1.0 - dot(slope, slope)))
          - surfaceTangent * slope.x + surfaceBitangent * slope.y);
        vec3 reflected = reflect(-towardsEye, normal);
        float mask = texture2D(normalMap, surfaceUV.xy).b;
        float k = clamp(reflectionFactors.w * mask + reflectionFactors.z, 0.0, 1.0);
        vec3 reflection = hasReflectionMap ? textureCube(reflectionMap, vec3(reflected.xy, -reflected.z)).rgb * k : vec3(0.0);
        float h = max(0.0, dot(normal, normalize(towardsEye + sunDirection)));
        float sparkle = h > 0.0 ? specularCurve.z * pow(h, specularCurve.x) + pow(h, specularCurve.y) : 0.0;
        vec3 specular = sparkle * specularFactors.x * mask * sunColour;
        vec3 colour = specular + reflection * (reflectionFactors.x + reflectionFactors.y * specular) * cubeMapTint.rgb;
        gl_FragColor = vec4(colour, texture2D(diffuseMap, surfaceUV.xy).a * materialDiffuseColor.a);
      }
    `,
  }));
  material.visible = false;
  let localReflection: THREE.Texture | null = null;
  void Promise.all([
    texture(area.textures.DiffuseMap),
    texture(area.textures.GlowNormalSpecularMap),
    texture(area.textures.ReflectionMap),
  ]).then(([diffuse, normal, reflection]) => {
    if (!diffuse || !normal) return;
    for (const map of [diffuse, normal]) {
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.needsUpdate = true;
    }
    uniforms.diffuseMap.value = diffuse;
    uniforms.normalMap.value = normal;
    localReflection = reflection;
    material.visible = true;
  });
  material.onBeforeRender = (_renderer, scene) => {
    const light = scene.children.find((object): object is THREE.DirectionalLight => (object as THREE.DirectionalLight).isDirectionalLight);
    if (light) {
      uniforms.sunDirection.value.copy(light.position).sub(light.target.position).normalize();
      uniforms.sunColour.value.copy(light.color).multiplyScalar(light.intensity);
    }
    // The near side reads EveSpaceSceneEnvMap, while the far side names its own cube.
    const reflection = localReflection ?? sceneReflection.value;
    uniforms.reflectionMap.value = reflection;
    uniforms.hasReflectionMap.value = (reflection as THREE.CubeTexture | null)?.isCubeTexture === true;
  };
  return material;
}
