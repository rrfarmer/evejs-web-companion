// The hangar while docked: the pilot's ship, turning slowly in the dark under a few lights, as the client shows the
// active ship in its hangar (our own drawing: the client's hangar interiors are not drawn). The model is the play
// view's own (hullModel.typeModel); the pilot can turn and zoom the camera.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { typeModel, setThrust } from "../three/hullModel.ts";

export class HangarView {
  readonly root = document.createElement("div");
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 1, 1e6);
  private readonly controls: OrbitControls;
  private readonly turntable = new THREE.Group();
  private shownType: number | null = null;
  private stopped = false;
  private readonly onResize = () => this.resize();

  constructor() {
    this.root.className = "hangar-view";
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.root.appendChild(this.renderer.domElement);
    // a dark bay: a faint studio reflection, a warm key, a cool rim, and a dim fill from below
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.25;
    this.scene.background = new THREE.Color(0x07090b);
    const key = new THREE.DirectionalLight(0xfff1dc, 2.6);
    key.position.set(-1, 1.2, 0.8);
    const rim = new THREE.DirectionalLight(0x9cc8ff, 1.6);
    rim.position.set(1, 0.4, -1);
    const fill = new THREE.DirectionalLight(0x445566, 0.5);
    fill.position.set(0, -1, 0.3);
    this.scene.add(key, rim, fill, this.turntable);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    addEventListener("resize", this.onResize);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Show a ship type (again only when it changes). */
  async show(typeID: number | null): Promise<void> {
    if (typeID === this.shownType) return;
    this.shownType = typeID;
    this.turntable.clear();
    if (!typeID) return;
    const model = await typeModel(typeID).catch(() => null);
    if (!model || this.stopped || this.shownType !== typeID) return;
    // in the hangar the engines are at rest
    setThrust(model, 0);
    this.turntable.add(model);
    const radius = (model.userData as { radius?: number }).radius ?? 50;
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(-0.9, 0.35, 1.1).normalize().multiplyScalar(radius * 3.2);
    this.camera.near = radius / 50;
    this.camera.far = radius * 400;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = radius * 1.4;
    this.controls.maxDistance = radius * 12;
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.stopped = true;
    this.renderer.setAnimationLoop(null);
    removeEventListener("resize", this.onResize);
    this.controls.dispose();
    this.renderer.dispose();
    this.root.remove();
  }
}
