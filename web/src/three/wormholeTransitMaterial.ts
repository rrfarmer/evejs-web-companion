import * as THREE from "three";
import type { SofChildMeshArea } from "./hullChildren.ts";

export const WORMHOLE_TRANSIT_MATERIAL = "wormhole-transit";

/** The installed transition's Low surface and its shared Medium/High reflection path. */
export function wormholeTransitMaterial(area: SofChildMeshArea,
  load: (url: string | null | undefined) => Promise<THREE.Texture | null>): THREE.ShaderMaterial {
  const vector = (name: string, defaults: number[]) => {
    const value = area.params[name];
    return { value: new THREE.Vector4().fromArray(Array.isArray(value) ? value : defaults) };
  };
  const texture = () => ({ value: null as THREE.Texture | null });
  const uniforms = {
    textureTransform: vector("TextureTransform", [0, 0, 1, 1]),
    miscFactors: vector("MiscFactors", [-0.1, 0.9, 4, 0.5]),
    alphaFactors: vector("AlphaFactors", [-0.1, 0.05, 0, 0.5]),
    reflectionFactors: vector("ReflectionFactors", [1, 1, 0, 1]),
    materialDiffuseColor: vector("MaterialDiffuseColor", [0.5, 0.5, 0.5, 1]),
    cubeMapTint: vector("CubeMapTint", [1, 1, 1, 1]),
    normalMap: texture(), specularMap: texture(), diffuseMap: texture(),
    sourceNebula: texture(), destinationNebula: texture(),
    sunDirection: { value: new THREE.Vector3() },
    lowQuality: { value: false },
  };
  const material = new THREE.ShaderMaterial({
    name: WORMHOLE_TRANSIT_MATERIAL,
    uniforms, transparent: true, depthTest: false, depthWrite: false,
    vertexShader: `
      #ifndef USE_TANGENT
      attribute vec4 tangent;
      #endif
      uniform vec4 textureTransform;
      uniform bool lowQuality;
      uniform vec3 sunDirection;
      varying vec4 tunnelUV;
      varying vec3 tunnelNormal, tunnelTangent, tunnelBitangent, tunnelEye;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        mat3 basis = mat3(modelMatrix);
        vec3 worldNormal = basis * normal;
        vec3 eye = normalize(cameraPosition - world.xyz);
        if (lowQuality) {
          vec3 n = normalize(worldNormal);
          tunnelNormal = vec3(2.25 * clamp(dot(n, sunDirection), 0.0, 1.0));
          tunnelTangent = vec3(2.25);
          float highlight = clamp(dot(n, normalize(eye + sunDirection)), 0.0, 1.0);
          tunnelBitangent = vec3(1.5 * pow(highlight, 20.0));
          tunnelEye = -reflect(eye, n);
        } else {
          tunnelNormal = worldNormal;
          tunnelTangent = basis * tangent.xyz;
          tunnelBitangent = basis * (cross(normal, tangent.xyz) * tangent.w);
          tunnelEye = eye;
        }
        tunnelUV = vec4(uv, uv * textureTransform.zw + textureTransform.xy);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform vec4 miscFactors, alphaFactors, reflectionFactors, materialDiffuseColor, cubeMapTint;
      uniform bool lowQuality;
      uniform sampler2D normalMap, specularMap, diffuseMap;
      uniform samplerCube sourceNebula, destinationNebula;
      varying vec4 tunnelUV;
      varying vec3 tunnelNormal, tunnelTangent, tunnelBitangent, tunnelEye;
      vec3 cubeDirection(vec3 direction) { return vec3(direction.xy, -direction.z); }
      void main() {
        float edge = 1.0 - tunnelUV.y;
        vec3 ends = alphaFactors.xyw;
        vec3 ramps = vec3(0.1, 0.25, 0.5);
        vec3 band = clamp((edge - ends + ramps) / ramps, 0.0, 1.0);
        float alpha = min(min(1.0 - band.x, band.y), band.z) * alphaFactors.z;
        float mask = texture2D(specularMap, tunnelUV.xy).a;
        vec3 colour;
        if (lowQuality) {
          vec3 diffuse = texture2D(diffuseMap, tunnelUV.xy).rgb * materialDiffuseColor.rgb;
          vec3 lighting = (tunnelNormal + 0.6 * tunnelTangent) * diffuse + tunnelBitangent * mask;
          colour = lighting + mask * textureLod(sourceNebula, cubeDirection(tunnelEye), 7.5).rgb;
        } else {
          vec2 slope = texture2D(normalMap, tunnelUV.zw).rg * 2.0 - 0.996;
          vec3 rippled = normalize(tunnelNormal - slope.x * tunnelTangent + slope.y * tunnelBitangent);
          float smoothness = clamp((tunnelUV.y - miscFactors.y) / (miscFactors.z - miscFactors.y), 0.0, 1.0);
          vec3 direction = cubeDirection(reflect(-tunnelEye, normalize(mix(rippled, normalize(tunnelNormal), smoothness))));
          vec3 source = textureLod(sourceNebula, direction, 0.0).rgb;
          vec3 destination = textureLod(destinationNebula, direction, 0.0).rgb;
          float reveal = clamp((tunnelUV.y - miscFactors.x + 0.1) * 5.0, 0.0, 1.0);
          colour = mix(source, destination, reveal) * miscFactors.w * reflectionFactors.x
            * clamp(reflectionFactors.z + reflectionFactors.w * mask, 0.0, 1.0);
        }
        gl_FragColor = vec4(colour * cubeMapTint.rgb, alpha);
      }`,
  });
  for (const [name, uniform] of [
    ["NormalMap", uniforms.normalMap], ["SpecularMap", uniforms.specularMap], ["DiffuseMap", uniforms.diffuseMap],
  ] as const) {
    void load(area.textures[name]).then((map) => { uniform.value = map; });
  }
  return material;
}
