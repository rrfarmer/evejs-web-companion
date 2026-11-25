<script lang="ts">
  import { onMount } from "svelte";
  import * as THREE from "three";
  import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
  import type { PortraitFraming } from "../app/flow.ts";
  import { compressedSupport, loadDds } from "../three/ddsTexture";
  import { loadPortraitBackdrop } from "../three/portraitBackdrop.ts";

  let { model, backdropUrl, backdropIsDds = false, framing, fieldOfView }: {
    model: "female" | "male";
    backdropUrl?: string;
    backdropIsDds?: boolean;
    framing?: PortraitFraming | null;
    fieldOfView?: number;
  } = $props();
  let canvas: HTMLCanvasElement;
  let renderer = $state.raw<THREE.WebGLRenderer | null>(null);
  let display = $state<"loading" | "ready" | "unavailable">("loading");
  let backdropDisplay = $state<"loading" | "ready" | "unavailable">("loading");
  let headBounds = $state.raw<THREE.Box3 | null>(null);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 30);
  const key = new THREE.DirectionalLight(0xffede3, 2.2);
  key.position.set(-2, 2, -3);
  const fill = new THREE.DirectionalLight(0xd6ecff, 1);
  fill.position.set(2, 0.6, -2);
  scene.add(key, fill, new THREE.HemisphereLight(0xe2eefa, 0x544447, 1.1));
  const loader = new GLTFLoader();

  function applySurface(object: THREE.Object3D, surface: THREE.Material, transparent: ReadonlySet<string>,
    eyelashMeshes: ReadonlySet<string>, eyelashes: THREE.Material | null): void {
    const materials = new Set<THREE.Material>();
    object.traverse(node => {
      if (node instanceof THREE.Mesh) {
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          materials.add(material);
        }
        const overlay = eyelashMeshes.has(node.name) ? eyelashes : null;
        node.material = overlay ?? surface;
        node.visible = overlay !== null || !transparent.has(node.name);
      }
    });
    for (const material of materials) material.dispose();
  }

  function release(object: THREE.Object3D): void {
    const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Skeleton>();
    object.traverse(node => {
      if (node instanceof THREE.Mesh) {
        resources.add(node.geometry);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) resources.add(material);
      }
      if (node instanceof THREE.SkinnedMesh) resources.add(node.skeleton);
    });
    for (const resource of resources) resource.dispose();
  }

  async function loadMap(path: string, color: boolean): Promise<{ bitmap: ImageBitmap; texture: THREE.Texture }> {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob(), {
      premultiplyAlpha: "none", colorSpaceConversion: "none",
    });
    const texture = new THREE.Texture(bitmap);
    // Granny's UVs address the top row at v=0. The native atlas transform
    // places this same local head map in the upper-right region of the atlas.
    texture.flipY = false;
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.needsUpdate = true;
    return { bitmap, texture };
  }

  onMount(() => {
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(384, 384, false);
      renderer.setClearColor(0x171e1e);
    } catch {
      display = "unavailable";
    }
    return () => {
      renderer?.dispose();
      renderer?.forceContextLoss();
    };
  });

  $effect(() => {
    const active = renderer;
    const bounds = headBounds;
    const saved = framing;
    const fov = fieldOfView;
    if (!active || !bounds) return;
    const center = bounds.getCenter(new THREE.Vector3());
    let usable = false;
    if (saved) {
      // The extracted model mirrors the native Z axis. Apply the same transform to the saved camera.
      camera.position.set(saved.position[0], saved.position[1], -saved.position[2]);
      camera.lookAt(saved.target[0], saved.target[1], -saved.target[2]);
      camera.fov = THREE.MathUtils.radToDeg(0.3);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      const projected = center.clone().project(camera);
      // Some saved defaults frame the full avatar below the generic head's bounds.
      usable = Math.abs(projected.x) <= 0.6 && Math.abs(projected.y) <= 0.6 && Math.abs(projected.z) < 1;
    }
    if (!usable) {
      const size = bounds.getSize(new THREE.Vector3());
      const distance = Math.max(size.x, size.y) * 2.15 + size.z * 0.5;
      const lensScale = fov === undefined ? 1 : Math.tan(THREE.MathUtils.degToRad(16)) / Math.tan(0.15);
      camera.position.set(center.x, center.y, center.z - distance * lensScale);
      camera.lookAt(center);
    }
    camera.fov = fov === undefined ? 32 : THREE.MathUtils.radToDeg(fov);
    camera.updateProjectionMatrix();
    active.render(scene, camera);
    display = "ready";
  });

  $effect(() => {
    const active = renderer;
    const url = backdropUrl;
    const isDds = backdropIsDds;
    if (!active || !url) return;
    let retired = false;
    let texture: THREE.Texture | null = null;
    backdropDisplay = "loading";
    void loadPortraitBackdrop(active, url, isDds).then(loaded => {
      if (retired) { loaded.dispose(); return; }
      texture = loaded;
      scene.background = loaded;
      active.render(scene, camera);
      backdropDisplay = "ready";
    }).catch(() => {
      if (!retired) {
        active.render(scene, camera);
        backdropDisplay = "unavailable";
      }
    });
    return () => {
      retired = true;
      scene.background = null;
      texture?.dispose();
    };
  });

  $effect(() => {
    const active = renderer;
    const name = model;
    if (!active) return;
    let retired = false;
    let head: THREE.Group | null = null;
    let eyelashTexture: THREE.Texture | null = null;
    let eyelashes: THREE.MeshBasicMaterial | null = null;
    const maps: Awaited<ReturnType<typeof loadMap>>[] = [];
    headBounds = null;
    display = "loading";
    const stem = `/client-assets/portrait-head/${name}`;
    void (async () => {
      const response = await fetch(stem + ".materials.json");
      if (!response.ok) throw new Error("Portrait materials unavailable");
      const { diffuse, normal, transparent, eyelashMask, eyelashMeshes } = await response.json() as {
        diffuse: string; normal: string; transparent: string[]; eyelashMask: string; eyelashMeshes: string[];
      };
      for (const [url, color] of [[diffuse, true], [normal, false]] as const) {
        const map = await loadMap(url, color);
        if (retired) { map.texture.dispose(); map.bitmap.close(); return; }
        maps.push(map);
      }
      if (eyelashMeshes.length && compressedSupport(active).s3tc) {
        const mask = await loadDds(eyelashMask).catch(() => null);
        if (retired) { mask?.dispose(); return; }
        if (mask) {
          eyelashTexture = mask;
          mask.wrapS = mask.wrapT = THREE.ClampToEdgeWrapping;
          eyelashes = new THREE.MeshBasicMaterial({
            color: 0x211817, map: mask, transparent: true, side: THREE.DoubleSide, depthWrite: false,
          });
          eyelashes.forceSinglePass = true;
          eyelashes.onBeforeCompile = shader => {
            shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>",
              "diffuseColor.a *= texture2D( map, vMapUv ).a;");
          };
        }
      }
      const { scene: avatar } = await loader.loadAsync(stem + ".glb");
      if (retired) { release(avatar); return; }
      head = avatar;
      const surface = new THREE.MeshStandardMaterial({ map: maps[0]!.texture, normalMap: maps[1]!.texture, roughness: 0.76 });
      // The authored head normal packs tangent X in alpha and Y in green.
      // Read the two linear channels without premultiplying the PNG.
      surface.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>",
          THREE.ShaderChunk.normal_fragment_maps.replace(
            "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
            `vec2 headNormal = texture2D( normalMap, vNormalMapUv ).ag * 2.0 - 1.0;
             vec3 mapN = vec3( headNormal, sqrt( max( 0.0, 1.0 - dot( headNormal, headNormal ) ) ) );`,
          ));
      };
      applySurface(avatar, surface, new Set(transparent), new Set(eyelashMeshes), eyelashes);
      scene.add(avatar);
      avatar.updateMatrixWorld(true);
      headBounds = new THREE.Box3().setFromObject(avatar, true);
    })().catch(() => {
      if (!retired) display = "unavailable";
    });
    return () => {
      retired = true;
      if (head) {
        scene.remove(head);
        release(head);
      } else eyelashes?.dispose();
      eyelashTexture?.dispose();
      for (const map of maps) {
        map.texture.dispose();
        map.bitmap.close();
      }
    };
  });
</script>

<canvas bind:this={canvas} data-portrait-head={display} data-backdrop-state={backdropUrl ? backdropDisplay : undefined}
  hidden={display !== "ready" || (Boolean(backdropUrl) && backdropDisplay === "loading")} role="img"
  aria-label={(model === "female" ? "Female base head" : "Male base head") + (backdropUrl ? " with selected backdrop" : "")}></canvas>
{#if display !== "ready"}
  <p role="status">{display === "loading" ? "Loading base head…" : "This base head could not be displayed."}</p>
{:else if backdropUrl && backdropDisplay !== "ready"}
  <p role="status">{backdropDisplay === "loading" ? "Loading backdrop…" : "This backdrop could not be displayed."}</p>
{/if}

<style>
  canvas { width: 100%; aspect-ratio: 1; object-fit: contain; }
  p { margin: auto; color: #a8bbb6; }
</style>
