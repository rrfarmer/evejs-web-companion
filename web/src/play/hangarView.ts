// The hangar while docked: the pilot's ship in its station's hangar, as the client shows the active ship docked (the
// hangar's model is the SOF hull hangarRegistry names, drawn by the play view's own hull pipeline, with the nearest of
// its point lights); where no hangar is drawn, the ship turns in a dark bay under a few lights. The pilot can turn and
// zoom the camera, which moves as the client's hangar camera does (hangarCamera.ts): it swings in as the pilot docks,
// keeps within its pitch and zoom limits, and after 100 s untouched turns slowly round the ship, which bobs.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { typeModel, graphicModel, setThrust } from "../three/hullModel.ts";
import { SHIP_FLOATING_HEIGHT } from "./hangarRegistry.ts";
import { loadDds } from "../three/ddsTexture.ts";
import { FOV, MAX_PITCH, MIN_PITCH, ENTRY_SECONDS, IDLE_AFTER_SECONDS, DEFAULT_SWING, zoomLimits, entryAt, idleAt, bobAt, swingOf, type Swing } from "./hangarCamera.ts";
import { pickDockSwing, type DockSwing } from "./hangarRegistry.ts";

interface HangarScene { reflection: string | null; sunDiffuseColor: number[] | null; sunDirection: number[] | null; ambientColor: number[] | null }

/** How many of a hangar's point lights are lit (the nearest to the ship): three's forward renderer pays for each. */
const HANGAR_LIGHTS = 24;

export class HangarView {
  readonly root = document.createElement("div");
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(FOV), 1, 1, 1e6);
  private readonly controls: OrbitControls;
  private readonly turntable = new THREE.Group();
  private shownType: number | null = null;
  private shownHangar: string | null = null;
  private readonly studioEnvironment: THREE.Texture | null;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 0);
  private hangar: THREE.Object3D | null = null;
  private readonly hangarLights = new THREE.Group();
  private readonly studio: THREE.Light[] = [];
  private stopped = false;
  /** The camera's zoom limits for the ship shown, and the ship's own measures for its bobbing. */
  private zoom = { near: 10, far: 2050 };
  private swing: Swing = DEFAULT_SWING;
  private ship: { model: THREE.Object3D; restY: number; lookY: number; radius: number; since: number } | null = null;
  /** The docking swing (seconds since it began) and the idle turn (from where the camera was), while they run. */
  private entryFrom: number | null = null;
  private idle: { since: number; from: { yaw: number; pitch: number; distance: number } } | null = null;
  private lastInput = performance.now();
  private lastBob = 0;
  private readonly onInput = () => { this.lastInput = performance.now(); this.entryFrom = null; this.idle = null; this.setFov(FOV); };
  private readonly onResize = () => this.resize();

  constructor() {
    this.root.className = "hangar-view";
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.root.appendChild(this.renderer.domElement);
    // a dark bay: a faint studio reflection, a warm key, a cool rim, and a dim fill from below
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.studioEnvironment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.25;
    this.scene.background = new THREE.Color(0x07090b);
    const key = new THREE.DirectionalLight(0xfff1dc, 2.6);
    key.position.set(-1, 1.2, 0.8);
    const rim = new THREE.DirectionalLight(0x9cc8ff, 1.6);
    rim.position.set(1, 0.4, -1);
    const fill = new THREE.DirectionalLight(0x445566, 0.5);
    fill.position.set(0, -1, 0.3);
    this.studio.push(key, rim, fill);
    this.scene.add(key, rim, fill, this.sun, this.turntable, this.hangarLights);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = MIN_PITCH;
    this.controls.maxPolarAngle = MAX_PITCH;
    // any touch of the camera stops its animations and starts the idle wait again (Orbit, Zoom: StopHangarEntryAnimation)
    this.controls.addEventListener("start", this.onInput);
    this.renderer.domElement.addEventListener("wheel", this.onInput, { passive: true });
    addEventListener("resize", this.onResize);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Show a ship type in a hangar (its model and scene graphics, hangarRegistry; null for the dark bay), again only on a change. */
  async show(typeID: number | null, hangarGraphics: { model: number; scene: number; swings?: readonly DockSwing[] } | null = null): Promise<void> {
    const hangarKey = hangarGraphics ? `${hangarGraphics.model}:${hangarGraphics.scene}` : null;
    if (typeID === this.shownType && hangarKey === this.shownHangar) return;
    this.shownType = typeID;
    this.shownHangar = hangarKey;
    this.turntable.clear();
    if (!typeID) return;
    const [model, hangar, scene] = await Promise.all([
      typeModel(typeID).catch(() => null),
      hangarGraphics ? graphicModel(hangarGraphics.model).catch(() => null) : Promise.resolve(null),
      hangarGraphics ? fetch(`/client-assets/graphic/${hangarGraphics.scene}`).then((r) => r.json()).then((g: { scene?: HangarScene }) => g.scene ?? null).catch(() => null) : Promise.resolve(null),
    ]);
    if (!model || this.stopped || this.shownType !== typeID || this.shownHangar !== hangarKey) return;
    // in the hangar the engines are at rest
    setThrust(model, 0);
    this.setHangar(hangar);
    await this.setScene(hangar ? scene : null);
    // DefaultHangarShipBehaviour.PlaceShip: turned half round about y, its bounding box's bottom on the hangar's anchor
    // point (SHIP_FLOATING_HEIGHT up where the hangar has none), moved by half its bounding sphere's centre.
    model.rotation.y = Math.PI;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const centre = box.getCenter(new THREE.Vector3());
    const a = (hangar?.userData as { anchor?: number[] | null } | undefined)?.anchor ?? null;
    const anchor = hangar ? new THREE.Vector3(a?.[0] ?? 0, a?.[1] ?? SHIP_FLOATING_HEIGHT, -(a?.[2] ?? 0)) : new THREE.Vector3();
    model.position.copy(anchor).add(new THREE.Vector3(0, hangar ? -box.min.y : 0, 0)).addScaledVector(centre, 0.5);
    this.turntable.add(model);
    const radius = (model.userData as { radius?: number }).radius ?? 50;
    const look = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
    this.controls.target.copy(look);
    // HangarCamera.UpdateMinMaxZoom: nearest 1.5 x (bounding radius + its centre off the origin), farthest 2050 m; the
    // hull's own bounding sphere (its SOF hull's, as model.boundingSphereRadius is), else one measured round the meshes
    const bs = (model.userData as { boundingSphere?: number[] | null }).boundingSphere ?? null;
    const measured = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
    const sphere = bs && bs.length >= 4
      ? { radius: bs[3]!, centre: Math.hypot(bs[0]!, bs[1]!, bs[2]!) }
      : { radius: measured.radius, centre: measured.center.distanceTo(model.position) };
    const maxCam = (hangar?.userData as { maxCameraDistance?: number[] | null } | undefined)?.maxCameraDistance ?? null;
    this.zoom = zoomLimits(sphere.radius, sphere.centre, maxCam ? Math.hypot(maxCam[0] ?? 0, maxCam[1] ?? 0, maxCam[2] ?? 0) : undefined);
    this.swing = hangarGraphics?.swings?.length ? swingOf(pickDockSwing(hangarGraphics.swings)) : DEFAULT_SWING;
    this.controls.minDistance = this.zoom.near;
    this.controls.maxDistance = this.zoom.far;
    this.camera.near = Math.max(0.5, radius / 50);
    this.camera.far = hangar ? 1e5 : radius * 400;
    this.ship = { model, restY: model.position.y, lookY: look.y, radius: sphere.radius, since: performance.now() };
    this.lastBob = 0;
    // the first ship shown is the docking: the camera swings in (AnimEnterHangar); a ship boarded after is placed
    // where that swing ends
    const first = this.entryFrom === null && !this.shownBefore;
    this.shownBefore = true;
    this.entryFrom = first ? performance.now() : null;
    this.idle = null;
    this.lastInput = performance.now();
    this.place(entryAt(first ? 0 : 1, this.zoom.near, this.zoom.far, this.swing));
    this.lightHangar(look);
    if (hangar) this.probe(look);
  }
  private shownBefore = false;

  /**
   * The reflection probe (hangarView's reflectionProbe): the client lights a docked ship mostly by a cube rendered of
   * the hangar about it. Here the hangar is rendered once into a cube from the ship's place, the ship hidden, and
   * that cube, filtered for rough surfaces (PMREM), is what the hulls reflect and are lit by.
   */
  private probeTarget: THREE.WebGLCubeRenderTarget | null = null;
  private probeEnv: THREE.Texture | null = null;
  private probe(at: THREE.Vector3): void {
    this.probeTarget?.dispose();
    this.probeEnv?.dispose();
    const target = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const eye = new THREE.CubeCamera(1, 1e5, target);
    eye.position.copy(at);
    this.turntable.visible = false;
    this.scene.updateMatrixWorld(true);
    eye.update(this.renderer, this.scene);
    this.turntable.visible = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.probeEnv = pmrem.fromCubemap(target.texture).texture;
    pmrem.dispose();
    this.probeTarget = target;
    this.scene.environment = this.probeEnv;
    this.scene.environmentRotation.set(0, 0, 0);
    this.scene.environmentIntensity = 1;
  }

  /** The camera put at a yaw, pitch and distance about its target (and a fov, where given). */
  private place(at: { yaw: number; pitch: number; distance: number; fov?: number }): void {
    const t = this.controls.target, sinP = Math.sin(at.pitch), theta = -at.yaw;
    this.camera.position.set(t.x + at.distance * Math.sin(theta) * sinP, t.y + at.distance * Math.cos(at.pitch), t.z + at.distance * Math.cos(theta) * sinP);
    this.camera.lookAt(t);
    if (at.fov !== undefined) this.setFov(at.fov);
  }
  private setFov(fov: number): void {
    const deg = THREE.MathUtils.radToDeg(fov);
    if (Math.abs(this.camera.fov - deg) < 1e-3) return;
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
  }
  /** Where the camera is now, as yaw, pitch and distance about its target. */
  private where(): { yaw: number; pitch: number; distance: number } {
    const o = this.camera.position.clone().sub(this.controls.target);
    const s = new THREE.Spherical().setFromVector3(o);
    return { yaw: -s.theta, pitch: s.phi, distance: s.radius };
  }

  /** One frame of the camera's own motion and the ship's bobbing. */
  private animate(now: number): void {
    if (this.ship) {
      // the ship bobs; the camera, looking at it, moves with it (HangarCamera.Update)
      const bob = bobAt((now - this.ship.since) / 1000, this.ship.radius);
      const d = bob - this.lastBob;
      this.lastBob = bob;
      this.ship.model.position.y = this.ship.restY + bob;
      this.controls.target.y = this.ship.lookY + bob;
      this.camera.position.y += d;
    }
    if (this.entryFrom !== null) {
      const t = Math.min(1, (now - this.entryFrom) / (ENTRY_SECONDS * 1000));
      this.place(entryAt(t, this.zoom.near, this.zoom.far, this.swing));
      if (t >= 1) { this.entryFrom = null; this.lastInput = now; }
      return;
    }
    if (!this.idle && now - this.lastInput > IDLE_AFTER_SECONDS * 1000) this.idle = { since: now, from: this.where() };
    if (this.idle) this.place(idleAt((now - this.idle.since) / 1000, this.idle.from, this.zoom.near, this.zoom.far));
  }

  /** The hangar's model in place of the last, and the studio lights dimmed where there is one. */
  private setHangar(hangar: THREE.Object3D | null): void {
    if (this.hangar) this.scene.remove(this.hangar);
    this.hangar = hangar;
    if (hangar) this.scene.add(hangar);
    for (const l of this.studio) l.intensity = (l.userData.full ??= l.intensity) * (hangar ? 0.35 : 1);
    this.scene.background = new THREE.Color(hangar ? 0x000000 : 0x07090b);
  }

  /**
   * The hangar's EveSpaceScene: its reflection cube for what the hulls reflect (as the space view takes a nebula's,
   * a half turn about y), its sun as the key light (sunDiffuseColor along sunDirection), no ambient (ambientColor is
   * black in the race hangars), the studio lights at a third as a fill. Without one, the dark bay's studio light.
   */
  private async setScene(scene: HangarScene | null): Promise<void> {
    this.sun.intensity = 0;
    if (!scene) { this.scene.environment = this.studioEnvironment; this.scene.environmentIntensity = 0.25; return; }
    if (scene.reflection) {
      try {
        this.scene.environment = await loadDds(scene.reflection);
        this.scene.environmentRotation.set(0, Math.PI, 0);
        this.scene.environmentIntensity = 1;
      } catch { /* a cube this GPU cannot take: the studio one stays */ }
    }
    // The client lights a docked ship mostly through its live reflection probe of the hangar (hangarView's
    // reflectionProbe; the scenes even turn the sun black where dynamic lights are on, and none of the hangar's own
    // point lights reaches the pad). We have only the scene's static cube, dark in some hangars (ch1's is near black):
    // so the studio lights stay on at a third as a fill, our own drawing's stand-in for the probe.
    for (const l of this.studio) l.intensity = (l.userData.full ?? l.intensity) * 0.3;
    const c = scene.sunDiffuseColor ?? [1, 1, 1, 1];
    // a scene that names no sunDirection (ch1) is lit from overhead here
    const d = scene.sunDirection ?? [0, -1, 0];
    this.sun.color.setRGB(c[0] ?? 1, c[1] ?? 1, c[2] ?? 1);
    this.sun.intensity = 3;
    // light comes along sunDirection: the light sits against it (EVE z mirrored)
    this.sun.position.set(-(d[0] ?? 0), -(d[1] ?? -1), d[2] ?? 0).normalize();
  }

  /** The hangar's point lights nearest the ship lit (EveSOFDataHullLightSet: colour, brightness, radius). */
  private lightHangar(near: THREE.Vector3): void {
    this.hangarLights.clear();
    const lights = ((this.hangar?.userData as { lights?: { position: number[]; radius: number | null; brightness: number; color: number[] | null }[] } | undefined)?.lights ?? [])
      .map((l) => ({ l, at: new THREE.Vector3(l.position[0] ?? 0, l.position[1] ?? 0, -(l.position[2] ?? 0)) }))
      .sort((x, y) => x.at.distanceTo(near) - y.at.distanceTo(near))
      .slice(0, HANGAR_LIGHTS);
    for (const { l, at } of lights) {
      const c = l.color ?? [1, 1, 1, 1];
      // a light of the radius it is given, falling off to nothing at its edge (not by the inverse square)
      const light = new THREE.PointLight(new THREE.Color(c[0] ?? 1, c[1] ?? 1, c[2] ?? 1), l.brightness * 2, l.radius ?? 300, 0);
      light.position.copy(at);
      this.hangarLights.add(light);
    }
  }

  private resize(): void {
    const w = this.root.clientWidth || innerWidth, h = this.root.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame(): void {
    if (this.stopped) return;
    if (this.renderer.domElement.width !== Math.round((this.root.clientWidth || innerWidth) * this.renderer.getPixelRatio())) this.resize();
    this.animate(performance.now());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.stopped = true;
    this.renderer.setAnimationLoop(null);
    removeEventListener("resize", this.onResize);
    this.controls.removeEventListener("start", this.onInput);
    this.renderer.domElement.removeEventListener("wheel", this.onInput);
    this.controls.dispose();
    this.probeTarget?.dispose();
    this.probeEnv?.dispose();
    this.renderer.dispose();
    this.root.remove();
  }
}
