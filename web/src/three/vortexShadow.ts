import * as THREE from "three";
import { SOFT_DEPTH, SOFT_DEPTH_GLSL } from "./softDepth.ts";

// basiccloud's Shadow technique projects each opaque surface into the
// cloud and samples the direct-light channel where its ray enters the volume.
const SHADOW = `
uniform highp sampler3D lightmap;
uniform mat4 inverseProjection, cloudFromView;
uniform vec3 directionToSun;
varying vec2 uvOnScreen;
${SOFT_DEPTH_GLSL}

void main() {
  float raw = texture2D(softDepthMap, uvOnScreen).r;
  if (softDepthOn == 0.0 || raw >= 1.0) discard;
  vec3 viewRay = (inverseProjection * vec4(uvOnScreen * 2.0 - 1.0, -1.0, 1.0)).xyz;
  vec3 viewPoint = viewRay * (-softViewDepth(raw) / viewRay.z);
  vec3 p = (cloudFromView * vec4(viewPoint, 1.0)).xyz;
  p.z = -p.z;

  vec3 inverseRay = mix(vec3(-1.0), vec3(1.0), step(vec3(0.0), directionToSun)) / max(abs(directionToSun), 1e-8);
  vec3 a = (-0.5 - p) * inverseRay;
  vec3 b = (0.5 - p) * inverseRay;
  vec3 nearAt = min(a, b), farAt = max(a, b);
  float entry = max(0.0, max(nearAt.x, max(nearAt.y, nearAt.z)));
  float exitAt = min(farAt.x, min(farAt.y, farAt.z));
  if (exitAt < entry) discard;

  float transmission = textureLod(lightmap, p + directionToSun * entry + 0.5, 0.0).r;
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0 - transmission);
}
`;

export class VortexShadow {
  readonly group = new THREE.Group();
  private readonly uniforms = {
    ...SOFT_DEPTH,
    lightmap: { value: null as THREE.Data3DTexture | null },
    inverseProjection: { value: new THREE.Matrix4() },
    cloudFromView: { value: new THREE.Matrix4() },
    directionToSun: { value: new THREE.Vector3() },
  };
  private readonly worldToCloud = new THREE.Matrix4();
  private readonly overlay = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: this.uniforms,
    vertexShader: `varying vec2 uvOnScreen;
      void main() { uvOnScreen = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: SHADOW,
    transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
  }));

  constructor() {
    // Shade the opaque scene before the color of the vortex and other transparent draws.
    this.group.renderOrder = -1e9;
    this.group.visible = false;
    this.overlay.frustumCulled = false;
    this.overlay.material.userData.softDepth = true;
    this.group.add(this.overlay);
    this.overlay.onBeforeRender = (_renderer, _scene, camera) => {
      this.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
      this.uniforms.cloudFromView.value.multiplyMatrices(this.worldToCloud, camera.matrixWorld);
    };
  }

  update(lightmap: THREE.Data3DTexture | null, worldToCloud: THREE.Matrix4, directionToSun: THREE.Vector3): void {
    this.group.visible = lightmap !== null;
    this.uniforms.lightmap.value = lightmap;
    this.worldToCloud.copy(worldToCloud);
    this.uniforms.directionToSun.value.copy(directionToSun);
  }

  dispose(): void {
    this.overlay.geometry.dispose();
    this.overlay.material.dispose();
  }
}
