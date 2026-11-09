// Spike S1 viewer: one hull extracted from the client by tools/client-extract, drawn with its own
// textures. Dev only (hull-viewer.html). The material is a first approximation of the client's
// quadv5 ship shader: albedo, BC5 normal map (z rebuilt), BC4 roughness (red channel), BC4 glow.
// Faction colours through MaterialMap / PaintMaskMap come with the SOF reader (M1).
//
//   /hull-viewer.html?hull=dx9/model/ship/caldari/battleship/cb1/cb1_t1&lod=0&flipGreen=1

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { loadDds, compressedSupport } from "./ddsTexture";

const params = new URLSearchParams(location.search);
const hull = params.get("hull") ?? "dx9/model/ship/caldari/battleship/cb1/cb1_t1";
const lodWanted = Number(params.get("lod") ?? 0);
const flipGreen = params.get("flipGreen") !== "0";
const status = document.getElementById("status")!;
const say = (s: string) => { status.textContent = s; (window as unknown as { __viewer: unknown }).__viewer = { ...(window as unknown as { __viewer?: object }).__viewer, status: s }; };

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
const sun = new THREE.DirectionalLight(0xfff4e6, 3.2);
sun.position.set(-1, 0.6, 0.8);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x223344, 0.4));

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 1, 1e6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/** Patch three's standard material to read the client's channel layout. */
function eveHullMaterial(maps: Record<string, THREE.Texture | undefined>, area: string) {
  const isBooster = /exhaust|booster/i.test(area);
  const m = new THREE.MeshStandardMaterial({
    map: maps.albedo,
    normalMap: maps.normal,
    roughnessMap: maps.roughness,
    roughness: 1,
    metalness: 0.6,
    emissiveMap: maps.glow,
    emissive: new THREE.Color(isBooster ? 0xffa060 : 0x9fd8ff),
    emissiveIntensity: isBooster ? 4 : 2,
  });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
        `vec3 mapN; mapN.xy = texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0;
         ${flipGreen ? "mapN.y = -mapN.y;" : ""}
         mapN.z = sqrt( max( 0.0, 1.0 - dot( mapN.xy, mapN.xy ) ) );`,
      )
      .replace("roughnessFactor *= texelRoughness.g;", "roughnessFactor *= texelRoughness.r;")
      .replace("totalEmissiveRadiance *= emissiveColor.rgb;", "totalEmissiveRadiance *= emissiveColor.rrr;");
  };
  return m;
}

async function main() {
  const support = compressedSupport(renderer);
  if (!support.rgtc || !support.bptc) say(`warning: GPU lacks ${!support.rgtc ? "RGTC " : ""}${!support.bptc ? "BPTC" : ""}; textures will be missing`);
  const base = `/client-assets/${hull}`;
  const gltf = await new GLTFLoader().loadAsync(`${base}.glb`);
  const root = gltf.scene;
  const info = root.children[0]?.userData ?? {};
  const textures = (info.textures ?? {}) as Record<string, Record<string, string>>;
  const dir = base.slice(0, base.lastIndexOf("/") + 1);
  const maps: Record<string, THREE.Texture | undefined> = {};
  await Promise.all(Object.entries(textures).map(async ([role, variants]) => {
    const file = variants.full ?? variants.mediumdetail ?? variants.lowdetail;
    if (!file) return;
    try { maps[role] = await loadDds(dir + file); } catch (e) { console.warn(role, e); }
  }));
  if (maps.albedo) maps.albedo.colorSpace = THREE.SRGBColorSpace;

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const area = (mesh.material as THREE.Material).name;
    mesh.material = eveHullMaterial(maps, area);
  });
  // show one LOD; the others stay in the file for distance switching later
  const lodNodes = root.children[0]?.children ?? [];
  const shown = lodNodes[Math.min(lodWanted, lodNodes.length - 1)];
  if (!shown) throw new Error(`${hull}: no LOD nodes in the file`);
  lodNodes.forEach((n) => { n.visible = n === shown; });
  scene.add(root);

  const box = new THREE.Box3().setFromObject(shown);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(-0.55, 0.3, 0.75).multiplyScalar(size * 0.9));
  camera.near = size / 1000;
  camera.far = size * 100;
  camera.updateProjectionMatrix();

  const triangles = lodNodes.reduce((n, node, i) => {
    if (i !== lodWanted) return n;
    node.traverse((o) => { const g = (o as THREE.Mesh).geometry; if (g?.index) n += g.index.count / 3; });
    return n;
  }, 0);
  say(`${hull.split("/").pop()} — LOD ${lodWanted} of ${lodNodes.length}, ${triangles} triangles, maps: ${Object.keys(maps).join(", ")}${support.bptc ? "" : " (no BPTC)"}`);
  (window as unknown as { __viewer: object }).__viewer = { status: status.textContent, ready: true, maps: Object.keys(maps), triangles, support };
}

main().catch((e) => { say(`failed: ${e.message}`); console.error(e); });

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
