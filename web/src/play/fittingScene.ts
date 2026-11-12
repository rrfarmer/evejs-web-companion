// The fitting window's ship (eve/client/script/ui/shared/fittingScreen/fittingCenter.py ShipSceneParent,
// shared/fitting/shipSceneContainer.py, control/scenecontainer.py SceneContainer, camera/baseCamera.py):
//
//   the scene      res:/dx9/scene/fitting/fitting.red (extract.mjs --fitting-scene): its background cube
//                  (background.fx's NebulaMap) behind, its reflection cube (envMapResPath) reflected, its sun
//                  (sunDiffuseColor 2 along sunDirection) and ambient light
//   the place      550 x GetScaleFactor in the middle of the 640 ring, masked to a circle (circleStencil.dds)
//   the model      CreateActiveShipModel: moved by minus its bounding sphere's centre
//   the camera     fov 1.0, near 1, far 400000 (PrepareSpaceScene); ModifyCameraToFitShip: rad = the bounding
//                  sphere's radius + |centre|, the nearest rad + near, the farthest min(far - rad, rad / tan(fov / 2) x
//                  2), the zoom proportion nearest / (farthest - nearest) - the distance nearest + zoom x (farthest -
//                  nearest) (SetZoomLinear with SetMinMaxZoom's swapped ends), so twice the nearest
//   the entry      AnimEntry(yaw1 = 1.2 pi, pitch0 = 0.3, pitch1 = 0.5): over 2 s yaw 1.1 pi -> 1.2 pi, pitch (the
//                  eye from straight above, pi/2 - p) 1.27 -> 1.07, the zoom from 1 (the farthest) to its own
//   the mouse      SceneContainerBaseNavigation: a drag orbits (Orbit: 0.02 x fov a pixel, pitch half), the wheel zooms
//
// Not yet: the simulated ship's hologram look (ApplyIsisEffect) and scan grid, the fitted turrets (UpdateHardpoints),
// background.fx's own blend of its cube (AlphaBlend / tint), the dynamic exposure.

import * as THREE from "three";
import { typeModel, setThrust } from "../three/hullModel.ts";
import { loadDds } from "../three/ddsTexture.ts";

interface FittingSceneInfo {
  nebula: string | null; reflection: string | null;
  sunDiffuseColor: number[] | null; sunDirection: number[] | null; ambientColor: number[] | null;
}
let sceneInfo: Promise<FittingSceneInfo | null> | null = null;

const FOV = 1.0, NEAR = 1, FAR = 400000;
const ENTRY_SECONDS = 2;
const smooth = (t: number) => t * t * (3 - 2 * t);

/** One fitting window's ship view: mounted on an element, shown a hull type, closed with the window. */
export class FittingShipScene {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera((FOV * 180) / Math.PI, 1, NEAR, FAR);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 0);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0);
  private readonly holder = new THREE.Group();
  private readonly resize: ResizeObserver;
  private shown: number | null = null;
  private closed = false;
  /** The camera: yaw, pitch (from above), distance; the nearest and farthest; the entry's start. */
  private yaw = 1.2 * Math.PI;
  private pitch = Math.PI / 2 - 0.5;
  private distance = 1000;
  private nearest = 10;
  private farthest = 3000;
  private entry: { at: number; distance: number } | null = null;
  private drag: { x: number; y: number } | null = null;

  constructor(private readonly host: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.sun, this.ambient, this.holder);
    void this.loadScene();
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", (e) => { this.drag = { x: e.clientX, y: e.clientY }; this.entry = null; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.drag) return;
      // Orbit: dx, dy times fov x 0.02 (as radians), yaw less dx, pitch less dy / 2, clamped (kMinPitch 0.05)
      const dx = (e.clientX - this.drag.x) * FOV * 0.02, dy = (e.clientY - this.drag.y) * FOV * 0.02;
      this.drag = { x: e.clientX, y: e.clientY };
      this.yaw -= dx;
      this.pitch = Math.max(0.05, Math.min(Math.PI - 0.05, this.pitch - dy / 2));
    });
    canvas.addEventListener("pointerup", () => { this.drag = null; });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.entry = null;
      this.distance = Math.max(this.nearest, Math.min(this.farthest, this.distance * Math.pow(1.001, e.deltaY)));
    }, { passive: false });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private async loadScene(): Promise<void> {
    sceneInfo ??= fetch("/client-assets/fittingScene.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const info = await sceneInfo;
    if (!info || this.closed) return;
    const halfTurn = new THREE.Euler(0, Math.PI, 0);
    const c = info.sunDiffuseColor ?? [1, 1, 1, 1];
    const d = info.sunDirection ?? [0, -1, 0];
    // as the hangar's sun (hangarView setScene): the colour along sunDirection, the light against it, EVE z mirrored
    this.sun.color.setRGB(c[0] ?? 1, c[1] ?? 1, c[2] ?? 1);
    this.sun.intensity = 3;
    this.sun.position.set(-(d[0] ?? 0), -(d[1] ?? -1), d[2] ?? 0).normalize();
    const a = info.ambientColor ?? [0, 0, 0, 1];
    this.ambient.color.setRGB(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
    this.ambient.intensity = 1;
    try {
      if (info.nebula) {
        const nebula = await loadDds(info.nebula);
        if (this.closed) return;
        this.scene.background = nebula;
        this.scene.backgroundRotation.copy(halfTurn);
      }
      if (info.reflection) {
        const refl = await loadDds(info.reflection);
        if (this.closed) return;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.scene.environment = pmrem.fromCubemap(refl as unknown as THREE.CubeTexture).texture;
        pmrem.dispose();
        this.scene.environmentRotation.copy(halfTurn);
      }
    } catch { /* a cube this GPU cannot take: the plain black stays */ }
  }

  /** Show a hull type (null: none); again only on a change. A new one plays the entry (ReloadShipWhenChangingShips). */
  async show(typeID: number | null): Promise<void> {
    if (typeID === this.shown) return;
    this.shown = typeID;
    this.holder.clear();
    if (typeID === null) return;
    const model = await typeModel(typeID).catch(() => null);
    if (!model || this.closed || this.shown !== typeID) return;
    setThrust(model, 0);
    const sphere = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
    model.position.sub(sphere.center);
    this.holder.add(model);
    const rad = sphere.radius + sphere.center.length();
    this.nearest = rad + NEAR;
    this.farthest = Math.min(FAR - rad, (rad / Math.tan(FOV / 2)) * 2);
    this.distance = this.nearest + (this.nearest / (this.farthest - this.nearest)) * (this.farthest - this.nearest);
    this.camera.near = Math.max(NEAR, rad * 0.01);
    this.camera.updateProjectionMatrix();
    this.entry = { at: performance.now(), distance: this.distance };
  }

  private fit(): void {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    if (this.closed) return;
    let yaw = this.yaw, pitch = this.pitch, distance = this.distance;
    if (this.entry) {
      const t = Math.min(1, (performance.now() - this.entry.at) / 1000 / ENTRY_SECONDS);
      const s = smooth(t);
      yaw = this.yaw = 1.1 * Math.PI + (1.2 * Math.PI - 1.1 * Math.PI) * s;
      pitch = this.pitch = Math.PI / 2 - (0.3 + (0.5 - 0.3) * s);
      distance = this.distance = this.farthest + (this.entry.distance - this.farthest) * s;
      if (t >= 1) this.entry = null;
    }
    // SetYaw / SetPitch: the eye at pitch from straight above, turned by yaw (OrbitControls' azimuth = -yaw, z mirrored)
    this.camera.position.setFromSpherical(new THREE.Spherical(distance, pitch, -yaw));
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  close(): void {
    this.closed = true;
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    this.holder.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
