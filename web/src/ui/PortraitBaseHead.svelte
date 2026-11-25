<script lang="ts">
  import { onMount } from "svelte";
  import * as THREE from "three";
  import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

  let { model }: { model: "female" | "male" } = $props();
  let canvas: HTMLCanvasElement;
  let renderer = $state.raw<THREE.WebGLRenderer | null>(null);
  let display = $state<"loading" | "ready" | "unavailable">("loading");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 30);
  const key = new THREE.DirectionalLight(0xffede3, 2.2);
  key.position.set(-2, 2, -3);
  const fill = new THREE.DirectionalLight(0xd6ecff, 1);
  fill.position.set(2, 0.6, -2);
  scene.add(key, fill, new THREE.HemisphereLight(0xe2eefa, 0x544447, 1.1));
  const surface = new THREE.MeshStandardMaterial({ color: 0xa99a91, roughness: 0.83 });
  const loader = new GLTFLoader();

  function release(object: THREE.Object3D, replaceMaterial = false): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const skeletons = new Set<THREE.Skeleton>();
    object.traverse(node => {
      if (node instanceof THREE.Mesh) {
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          if (material !== surface) materials.add(material);
        }
        if (replaceMaterial) node.material = surface;
        else geometries.add(node.geometry);
      }
      if (!replaceMaterial && node instanceof THREE.SkinnedMesh) skeletons.add(node.skeleton);
    });
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const skeleton of skeletons) skeleton.dispose();
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
      surface.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
    };
  });

  $effect(() => {
    const active = renderer;
    const name = model;
    if (!active) return;
    let retired = false;
    let head: THREE.Group | null = null;
    display = "loading";
    void loader.loadAsync(`/client-assets/portrait-head/${name}.glb`).then(({ scene: avatar }) => {
      if (retired) { release(avatar); return; }
      head = avatar;
      release(avatar, true);
      scene.add(avatar);
      avatar.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(avatar, true);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const distance = Math.max(size.x, size.y) * 2.15 + size.z * 0.5;
      camera.position.set(center.x, center.y, center.z - distance);
      camera.lookAt(center);
      active.render(scene, camera);
      display = "ready";
    }).catch(() => {
      if (!retired) display = "unavailable";
    });
    return () => {
      retired = true;
      if (head) {
        scene.remove(head);
        release(head);
      }
    };
  });
</script>

<canvas bind:this={canvas} data-portrait-head={display} hidden={display !== "ready"} role="img"
  aria-label={model === "female" ? "Female base head" : "Male base head"}></canvas>
{#if display !== "ready"}
  <p role="status">{display === "loading" ? "Loading base head…" : "This base head could not be displayed."}</p>
{/if}

<style>
  canvas { width: 100%; aspect-ratio: 1; object-fit: contain; }
  p { margin: auto; color: #a8bbb6; }
</style>
