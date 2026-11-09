// A bench for one type's model as the play view draws it (hullModel.typeModel: the SOF build, its materials and
// boosters), lit by a system's own nebula and reflection maps and a sun as SpaceView lights space. Dev only
// (hull-viewer.html): the place to tune the hull material against the client's look.
//
//   /hull-viewer.html?type=29984&system=30000142&lod=0&thrust=1
//   /hull-viewer.html?planet=40009082&system=30000142      (a planet or moon of the system, as SpaceView draws it)

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadDds, compressedSupport } from "./ddsTexture";
import { typeModel, setThrust } from "./hullModel";
import { celestialModel, systemCelestials } from "./celestialModel";

const params = new URLSearchParams(location.search);
const typeID = Number(params.get("type") ?? 588);
const systemID = Number(params.get("system") ?? 30000142);
const lodWanted = Number(params.get("lod") ?? 0);
const thrust = Number(params.get("thrust") ?? 0);
const planetID = Number(params.get("planet") ?? 0);
const status = document.getElementById("status")!;
const say = (s: string) => { status.textContent = s; (window as unknown as { __viewer: unknown }).__viewer = { ...(window as unknown as { __viewer?: object }).__viewer, status: s }; };

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// SpaceView's lights: the sun and a faint fill; the nebula and reflection maps come with the system.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
const sun = new THREE.DirectionalLight(0xfff6e8, 3);
sun.position.set(-1, 0.6, 0.8);
scene.add(sun, new THREE.AmbientLight(0x334455, 0.6));

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 1, 1e6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

async function loadSystem(): Promise<void> {
  const info = (await (await fetch(`/client-assets/scene/${systemID}`)).json()) as { maps?: Record<string, string> | null };
  const halfTurn = new THREE.Euler(0, Math.PI, 0);
  if (info.maps?.nebula) {
    scene.background = await loadDds(info.maps.nebula);
    scene.backgroundRotation.copy(halfTurn);
    scene.backgroundIntensity = 1.25;
  }
  if (info.maps?.reflection) {
    scene.environment = await loadDds(info.maps.reflection);
    scene.environmentRotation.copy(halfTurn);
    scene.environmentIntensity = 1.55;
  }
}

async function planetModel(): Promise<THREE.Object3D | null> {
  const item = (await systemCelestials(systemID))[String(planetID)];
  if (!item?.typeID) throw new Error(`planet ${planetID} is not in system ${systemID}`);
  const m = await celestialModel(item.typeID, item.kind ?? "planet", 1000, item, planetID);
  if (m) m.userData = { hull: item.celestial?.split("/").pop() ?? null };
  return m;
}

async function main() {
  const support = compressedSupport(renderer);
  if (!support.rgtc || !support.bptc) say(`warning: GPU lacks ${!support.rgtc ? "RGTC " : ""}${!support.bptc ? "BPTC" : ""}; textures will be missing`);
  const [model] = await Promise.all([planetID ? planetModel() : typeModel(typeID), loadSystem().catch((e) => console.warn("scene", e))]);
  if (!model) throw new Error(`type ${typeID} has no model`);
  scene.add(model);
  // the engines at the given share of top speed, at rest by default, as the play view sets them from the ship's speed
  setThrust(model, thrust);
  // One LOD held, as the view draws it close up.
  let shown: THREE.Object3D = model;
  model.traverse((o) => {
    const lod = o as THREE.LOD;
    if (!lod.isLOD) return;
    lod.autoUpdate = false;
    lod.levels.forEach((l, i) => { l.object.visible = i === Math.min(lodWanted, lod.levels.length - 1); });
    shown = lod.levels[Math.min(lodWanted, lod.levels.length - 1)]!.object;
  });
  const box = new THREE.Box3().setFromObject(shown);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(-0.55, 0.3, 0.75).multiplyScalar(size * 0.9));
  camera.near = size / 1000;
  camera.far = size * 1000;
  camera.updateProjectionMatrix();
  const info = model.userData as { hull?: string | null };
  say(`type ${typeID} — ${info.hull ?? "?"}, LOD ${lodWanted}${support.bptc ? "" : " (no BPTC)"}`);
  (window as unknown as { __viewer: object }).__viewer = { status: status.textContent, ready: true, model, scene, camera, controls, renderer, sun };
}

main().catch((e) => { say(`failed: ${e.message}`); console.error(e); });

/** One frame drawn now (the hidden pane runs no animation frames). */
function draw(): void {
  controls.update();
  renderer.render(scene, camera);
}
(window as unknown as { __draw: () => void }).__draw = draw;
renderer.setAnimationLoop(draw);
