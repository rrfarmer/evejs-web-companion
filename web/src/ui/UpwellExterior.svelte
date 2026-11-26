<script lang="ts">
  import { onMount } from "svelte";
  import * as THREE from "three";
  import { OrbitControls } from "three/addons/controls/OrbitControls.js";
  import { getDockedStructureGrid } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { decodeSpaceSnapshot } from "../bridge/space.ts";
  import { readPlainJsonField } from "../bridge/wire.ts";
  import type { SpaceEntity } from "../store/types.ts";
  import { celestialModel, systemCelestials } from "../three/celestialModel.ts";
  import { loadDds } from "../three/ddsTexture.ts";
  import { useHullTextureRenderer } from "../three/hullAlbedo.ts";
  import { typeModel } from "../three/hullModel.ts";

  let { flow, structureID }: { flow: AppFlow; structureID: number } = $props();
  let host: HTMLDivElement;
  let state = $state<"loading" | "ready" | "error">("loading");
  let error = $state("");
  let modelCount = $state(0);
  let cameraRange = $state(0);

  onMount(() => {
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ logarithmicDepthBuffer: true, antialias: true });
    } catch {
      error = "The exterior view requires WebGL.";
      state = "error";
      return;
    }
    useHullTextureRenderer(renderer);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.transform = "scaleX(-1)";
    renderer.domElement.setAttribute("aria-label", "Exterior camera");
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04070d);
    const camera = new THREE.PerspectiveCamera(40, 1, 5, 5e13);
    camera.position.set(10000, 7000, 12000);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enablePan = false;
    // The game assets mirror Z at extraction. Reverse the horizontal drag to match the mirrored canvas.
    const mirrored = orbit as unknown as { _rotateLeft(angle: number): void };
    const rotate = mirrored._rotateLeft.bind(orbit);
    mirrored._rotateLeft = angle => rotate(-angle);
    const sun = new THREE.DirectionalLight(0xffebd1, 2.8);
    sun.position.set(-1, 1, 1);
    scene.add(sun, new THREE.HemisphereLight(0xb5c9f0, 0x273343, 1.15));

    let closed = false;
    let frame = 0;
    let environment: THREE.WebGLRenderTarget | null = null;
    const celestials: THREE.Object3D[] = [];
    const disposeCelestial = (body: THREE.Object3D) => body.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      node.geometry.dispose();
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
    });
    const draw = () => {
      if (closed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        renderer.render(scene, camera);
        cameraRange = Math.round(camera.position.distanceTo(orbit.target));
      });
    };
    orbit.addEventListener("change", draw);
    const resize = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = host;
      if (clientWidth < 1 || clientHeight < 1) return;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight);
      draw();
    });
    resize.observe(host);
    const controller = new AbortController();
    const offset = (row: SpaceEntity, origin: SpaceEntity) => new THREE.Vector3(
      row.position.x - origin.position.x, row.position.y - origin.position.y, origin.position.z - row.position.z);

    async function loadEnvironment(system: number) {
      const response = await fetch(`/client-assets/scene/${system}`, { signal: controller.signal });
      if (!response.ok) return;
      const { maps } = await response.json() as { maps?: { nebula?: string; reflection?: string } };
      const [nebula, reflection] = await Promise.all([maps?.nebula, maps?.reflection].map(path =>
        path ? loadDds(path).catch(() => null) : null));
      if (closed) return;
      if (nebula) {
        scene.background = nebula;
        scene.backgroundRotation.set(0, Math.PI, 0);
        scene.backgroundIntensity = 1.25;
      }
      if (reflection) {
        const pmrem = new THREE.PMREMGenerator(renderer);
        environment = pmrem.fromCubemap(reflection as unknown as THREE.CubeTexture);
        pmrem.dispose();
        scene.environment = environment.texture;
        scene.environmentRotation.set(0, Math.PI, 0);
      }
      draw();
    }

    async function load() {
      let snapshot;
      let structure;
      for (let attempt = 0; attempt < 18 && !closed; attempt++) {
        const raw = await getDockedStructureGrid(flow.requestOptions());
        if (closed) return;
        if (readPlainJsonField(raw, "structureID") !== structureID) throw new Error("The docked structure changed.");
        snapshot = decodeSpaceSnapshot(raw);
        structure = snapshot.entities.find(row => row.itemID === structureID && row.geometryAvailable);
        if (snapshot.stateValid && structure) break;
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      if (closed) return;
      if (!snapshot?.stateValid || !structure?.typeID || !snapshot.solarSystemID) {
        throw new Error("The structure exterior is unavailable.");
      }
      const model = await typeModel(structure.typeID);
      if (closed) return;
      if (!model) throw new Error("The structure model is unavailable.");
      scene.add(model);
      modelCount = 1;
      const bounds = new THREE.Box3().setFromObject(model);
      const radius = Math.max(structure.radius, bounds.getSize(new THREE.Vector3()).length() * 0.5, 10);
      orbit.target.copy(bounds.getCenter(new THREE.Vector3()));
      camera.position.copy(orbit.target).add(new THREE.Vector3(0.58, 0.33, 0.75).normalize().multiplyScalar(radius * 3.7));
      orbit.minDistance = radius * 1.18;
      orbit.maxDistance = radius * 22;
      orbit.update();
      state = "ready";
      draw();

      void loadEnvironment(snapshot.solarSystemID).catch(() => {});
      const celestialTypes = new Set(["sun", "planet", "moon"]);
      const sceneRows = snapshot.entities.filter(row => row.itemID !== structureID && row.typeID && row.geometryAvailable)
        .map(row => ({ row, position: offset(row, structure) }))
        .sort((a, b) => a.position.lengthSq() - b.position.lengthSq());
      const star = sceneRows.find(({ row }) => row.kind === "sun");
      if (star && star.position.lengthSq()) sun.position.copy(star.position).normalize();
      const near = sceneRows.filter(({ row, position }) =>
        ["ship", "structure", "station", "stargate"].includes(row.kind ?? "") && position.lengthSq() < 250000 ** 2).slice(0, 16);
      const bodies = sceneRows.filter(({ row }) => row.kind === "planet" || row.kind === "moon").slice(0, 4);
      if (star) bodies.push(star);
      const settings = await systemCelestials(snapshot.solarSystemID);
      if (closed) return;
      for (const { row, position } of [...near, ...bodies]) {
        if (row.typeID === null) continue;
        const kind = row.kind ?? "";
        const isCelestial = celestialTypes.has(kind);
        const loading = isCelestial
          ? celestialModel(row.typeID, kind, row.radius, settings[String(row.itemID)] ?? null, row.itemID)
          : typeModel(row.typeID);
        void loading.then(object => {
          if (!object) return;
          if (closed) {
            if (isCelestial) disposeCelestial(object);
            return;
          }
          if (isCelestial) celestials.push(object);
          object.position.copy(position);
          scene.add(object);
          modelCount++;
          draw();
        }).catch(() => {});
      }
    }
    void load().catch(cause => {
      if (closed) return;
      error = cause instanceof Error ? cause.message : "Unable to open the exterior view.";
      state = "error";
    });
    return () => {
      closed = true;
      controller.abort();
      cancelAnimationFrame(frame);
      resize.disconnect();
      orbit.dispose();
      for (const body of celestials) disposeCelestial(body);
      environment?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  });
</script>

<section class="upwell-exterior" data-view-state={state} data-structure={structureID} data-models={modelCount}
  data-camera-range={cameraRange} aria-label="Structure exterior">
  <div class="exterior-canvas" bind:this={host}></div>
  {#if state === "loading"}<p role="status">Loading structure exterior…</p>{/if}
  {#if state === "error"}<p role="alert">{error}</p>{/if}
</section>

<style>
  .upwell-exterior, .exterior-canvas { position: absolute; inset: 0; }
  .exterior-canvas :global(canvas) { display: block; }
  p { position: absolute; inset: 50% 0 auto; margin: 0; text-align: center; pointer-events: none; }
</style>
