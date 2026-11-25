<script lang="ts">
  import { onMount } from "svelte";
  import * as THREE from "three";
  import { loadPortraitBackdrop } from "../three/portraitBackdrop.ts";

  let { url }: { url: string } = $props();
  let canvas: HTMLCanvasElement;
  let renderer = $state.raw<THREE.WebGLRenderer | null>(null);
  let display = $state<"loading" | "ready" | "unavailable">("loading");
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
  camera.position.z = 1;
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.MeshBasicMaterial({ toneMapped: false });
  scene.add(new THREE.Mesh(geometry, material));

  onMount(() => {
    try {
      renderer = new THREE.WebGLRenderer({ canvas });
      renderer.setSize(384, 384, false);
    } catch {
      display = "unavailable";
    }
    return () => {
      geometry.dispose();
      material.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
    };
  });

  $effect(() => {
    const active = renderer;
    const resource = url;
    if (!active) return;
    let cancelled = false;
    let texture: THREE.Texture | null = null;
    display = "loading";
    void loadPortraitBackdrop(active, resource, true).then(loaded => {
      if (cancelled) { loaded.dispose(); return; }
      texture = loaded;
      material.map = loaded;
      material.needsUpdate = true;
      active.render(scene, camera);
      display = "ready";
    }).catch(() => {
      if (!cancelled) display = "unavailable";
    });
    return () => {
      cancelled = true;
      texture?.dispose();
    };
  });
</script>

<canvas bind:this={canvas} data-backdrop-state={display} hidden={display !== "ready"} role="img" aria-label="Selected portrait backdrop"></canvas>
{#if display !== "ready"}
  <p role="status">{display === "loading" ? "Loading backdrop…" : "This backdrop could not be displayed."}</p>
{/if}

<style>
  canvas { width: 100%; aspect-ratio: 1; object-fit: contain; }
  p { margin: auto; color: #a8bbb6; }
</style>
