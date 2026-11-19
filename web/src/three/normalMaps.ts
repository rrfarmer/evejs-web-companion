/** Expand the installed BC5 normal's two channels in the tangent frame. */
export function eveNormalMap(shader: string, flipGreen: boolean): string {
  return shader.replace("vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
    `vec3 mapN = vec3((texture2D(normalMap, vNormalMapUv).xy + 0.002) * 2.0 - 1.0, 1.0);
     ${flipGreen ? "mapN.y = -mapN.y;" : ""}`);
}
