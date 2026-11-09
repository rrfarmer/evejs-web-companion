// The warp tunnel: streaks of light rushing past the camera along the ship's way while it warps. The client draws
// its tunnel from an effect file whose curves are bound to the ship's speed scaled by 1 / (3 AU x the ship's warp
// speed multiplier) (environment/effects/Warp.py SetupTunnelBindings, 263 to 268); this is our own drawing of it,
// driven by the same share of speed. The warp speed multiplier is not known here, so it is taken as one.

import * as THREE from "three";

const AU = 149_597_870_700;
const STREAKS = 700;

export class WarpTunnel {
  readonly object: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly material: THREE.LineBasicMaterial;
  /** Each streak: its angle round the way, its distance from it (share of the camera's), where it is along it (-1..1). */
  private readonly streaks: { angle: number; radius: number; along: number }[] = [];
  private shown = 0;

  constructor() {
    this.positions = new Float32Array(STREAKS * 2 * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.LineBasicMaterial({ color: 0xbcd6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.object = new THREE.LineSegments(geometry, this.material);
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.name = "warpTunnel";
    for (let i = 0; i < STREAKS; i++) this.streaks.push({ angle: Math.random() * Math.PI * 2, radius: 0.35 + Math.random() ** 0.6 * 3.5, along: Math.random() * 2 - 1 });
  }

  /** The tunnel's strength for a speed in metres a second while warping (0 when not warping): the client's binding. */
  static share(warping: boolean, speed: number): number {
    return warping ? Math.min(1, Math.max(0, speed / (3 * AU))) : 0;
  }

  /**
   * One frame: `way` the ship's direction of travel in three's space (unit), `share` its strength (0..1), `focus` the
   * point the camera looks at, `dt` seconds since the last frame. The strength eases in and out over half a second.
   */
  update(camera: THREE.Camera, focus: THREE.Vector3, way: THREE.Vector3, share: number, dt: number): void {
    this.shown += (share - this.shown) * Math.min(1, dt * 2);
    if (this.shown < 0.01 || way.lengthSq() < 0.5) {
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.material.opacity = Math.min(0.85, this.shown * 0.9);
    const d = Math.max(50, camera.position.distanceTo(focus));
    const side = new THREE.Vector3(0, 1, 0).cross(way);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0).cross(way);
    side.normalize();
    const up = way.clone().cross(side).normalize();
    const reach = d * 8, length = d * (0.15 + this.shown * 1.6), rush = (1.2 + this.shown * 6) * dt;
    const centre = camera.position;
    for (let i = 0; i < STREAKS; i++) {
      const s = this.streaks[i]!;
      s.along -= rush;
      if (s.along < -1) { s.along += 2; s.angle = Math.random() * Math.PI * 2; }
      const r = s.radius * d, cx = Math.cos(s.angle) * r, cy = Math.sin(s.angle) * r, a = s.along * reach;
      const o = i * 6;
      const hx = centre.x + side.x * cx + up.x * cy + way.x * a, hy = centre.y + side.y * cx + up.y * cy + way.y * a, hz = centre.z + side.z * cx + up.z * cy + way.z * a;
      this.positions[o] = hx; this.positions[o + 1] = hy; this.positions[o + 2] = hz;
      this.positions[o + 3] = hx - way.x * length; this.positions[o + 4] = hy - way.y * length; this.positions[o + 5] = hz - way.z * length;
    }
    (this.object.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
