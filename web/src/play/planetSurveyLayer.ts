import * as THREE from "three";
import { PLANET_SURVEY_PATTERN, PLANET_SURVEY_RAMP, PLANET_SURVEY_SAMPLES } from "../bridge/planetSurvey.ts";
import { loadDds } from "../three/ddsTexture.ts";

/** uiplanet's chart sits above the planet surface and below its installation links. */
export async function createPlanetSurveyLayer() {
  const ramp = await new THREE.TextureLoader().loadAsync(PLANET_SURVEY_RAMP);
  let pattern: THREE.Texture;
  try {
    pattern = await loadDds(PLANET_SURVEY_PATTERN);
  } catch (error) {
    ramp.dispose();
    throw error;
  }
  pattern.wrapS = pattern.wrapT = THREE.RepeatWrapping;
  pattern.needsUpdate = true;
  const uniforms = {
    chart: { value: null as THREE.DataTexture | null }, ramp: { value: ramp }, pattern: { value: pattern },
    heatOffset: { value: 0 }, heatStretch: { value: 2 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    vertexShader: `
      varying vec3 surfaceDirection;
      void main() {
        surfaceDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D chart, ramp, pattern;
      uniform float heatOffset, heatStretch;
      varying vec3 surfaceDirection;
      void main() {
        vec3 point = normalize(surfaceDirection);
        const float pi = 3.141592653589793;
        // PlanetSphere's U increases from +X toward +Z in the web scene.
        vec2 angular = vec2(fract(atan(point.z, point.x) / (2.0 * pi)), acos(clamp(point.y, -1.0, 1.0)) / pi);
        vec2 uv = (angular * ${PLANET_SURVEY_SAMPLES - 1}.0 + 0.5) / ${PLANET_SURVEY_SAMPLES}.0;
        float density = clamp(texture2D(chart, uv).r * heatStretch + heatOffset, 0.0, 1.0);
        vec4 color = texture2D(ramp, vec2(density, 0.5));
        float grid = texture2D(pattern, angular * vec2(25.0, 12.5)).a;
        float overlay = 0.175 * grid;
        gl_FragColor = vec4(mix(vec3(1.0), color.rgb, color.a > 0.0 ? 1.0 : 0.0),
          overlay * (1.0 - color.a) + color.a);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.003, 160, 112), material);
  mesh.name = "planet-resource-survey";
  mesh.renderOrder = 2;
  mesh.visible = false;
  return {
    mesh,
    setChart(chart: Uint8Array<ArrayBuffer> | null) {
      uniforms.chart.value?.dispose();
      uniforms.chart.value = null;
      mesh.visible = chart !== null;
      if (chart === null) return;
      const texture = new THREE.DataTexture(chart, PLANET_SURVEY_SAMPLES, PLANET_SURVEY_SAMPLES, THREE.RedFormat);
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      uniforms.chart.value = texture;
    },
    setRange(low: number, high: number) {
      uniforms.heatStretch.value = 1 / (high - low);
      uniforms.heatOffset.value = -low * uniforms.heatStretch.value;
    },
    dispose() {
      uniforms.chart.value?.dispose();
      ramp.dispose();
      pattern.dispose();
      mesh.geometry.dispose();
      material.dispose();
      mesh.removeFromParent();
    },
  };
}
