<script lang="ts">
  import { onMount } from "svelte";
  import * as THREE from "three";
  import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
  import type { PortraitFraming } from "../app/flow.ts";
  import type { PortraitSkinTone } from "../app/api.ts";
  import { compressedSupport, loadDds } from "../three/ddsTexture";
  import { loadPortraitBackdrop } from "../three/portraitBackdrop.ts";

  let { model, backdropUrl, backdropIsDds = false, bloodlineID, framing, fieldOfView, hasSkinTones = false, skinColors }: {
    model: "female" | "male";
    backdropUrl?: string;
    backdropIsDds?: boolean;
    bloodlineID?: number | null;
    framing?: PortraitFraming | null;
    fieldOfView?: number;
    hasSkinTones?: boolean;
    skinColors?: PortraitSkinTone["colors"];
  } = $props();
  let canvas: HTMLCanvasElement;
  let renderer = $state.raw<THREE.WebGLRenderer | null>(null);
  let display = $state<"loading" | "ready" | "unavailable">("loading");
  let backdropDisplay = $state<"loading" | "ready" | "unavailable">("loading");
  let headBounds = $state.raw<THREE.Box3 | null>(null);
  type SkinUniforms = {
    portraitSkinDetail: { value: THREE.Texture };
    portraitSkinZone: { value: THREE.Texture };
    portraitSkinColors: { value: THREE.Color[] };
    portraitSkinStrength: { value: number };
  };
  let skinUniforms = $state.raw<SkinUniforms | null>(null);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 30);
  const key = new THREE.DirectionalLight(0xffede3, 2.2);
  key.position.set(-2, 2, -3);
  const fill = new THREE.DirectionalLight(0xd6ecff, 1);
  fill.position.set(2, 0.6, -2);
  scene.add(key, fill, new THREE.HemisphereLight(0xe2eefa, 0x544447, 1.1));
  const loader = new GLTFLoader();

  function applySurface(object: THREE.Object3D, surface: THREE.Material, transparent: ReadonlySet<string>,
    eyelashMeshes: ReadonlySet<string>, eyelashes: THREE.Material | null, skin: THREE.Material): void {
    const materials = new Set<THREE.Material>();
    object.traverse(node => {
      if (node instanceof THREE.Mesh) {
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          materials.add(material);
        }
        const overlay = eyelashMeshes.has(node.name) ? eyelashes : null;
        node.material = overlay ?? (node.name === "meshShape" ? skin : surface);
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
    const tint = skinUniforms;
    const colors = skinColors;
    if (!active || !bounds) return;
    if (tint) {
      tint.portraitSkinStrength.value = colors ? 1 : 0;
      colors?.forEach((rgb, index) => tint.portraitSkinColors.value[index]!.setRGB(...rgb, THREE.SRGBColorSpace));
    }
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
    const bloodline = bloodlineID;
    const withSkin = hasSkinTones;
    if (!active) return;
    let retired = false;
    let head: THREE.Group | null = null;
    let eyelashTexture: THREE.Texture | null = null;
    let eyelashes: THREE.MeshBasicMaterial | null = null;
    const maps: Awaited<ReturnType<typeof loadMap>>[] = [];
    headBounds = null;
    skinUniforms = null;
    display = "loading";
    const stem = `/client-assets/portrait-head/${name}`;
    void (async () => {
      const response = await fetch(stem + ".materials.json");
      if (!response.ok) throw new Error("Portrait materials unavailable");
      const { diffuse, normal, transparent, eyelashMask, eyelashMeshes, skinDetail, skinZone } = await response.json() as {
        diffuse: string; normal: string; transparent: string[]; eyelashMask: string; eyelashMeshes: string[];
        skinDetail: string; skinZone: string;
      };
      for (const [url, color] of [[diffuse, true], [normal, false]] as const) {
        const map = await loadMap(url, color);
        if (retired) { map.texture.dispose(); map.bitmap.close(); return; }
        maps.push(map);
      }
      let archetype: { diffuse: THREE.Texture; normal: THREE.Texture; weight: number } | null = null;
      if (bloodline != null && ((bloodline >= 1 && bloodline <= 8) || (bloodline >= 11 && bloodline <= 14))) {
        try {
          const source = await fetch(`${stem}-${bloodline}.archetype.json`);
          if (!source.ok) throw new Error("Portrait archetype unavailable");
          const layer = await source.json() as { diffuse: string; normal: string; weight: number };
          for (const [url, color] of [[layer.diffuse, true], [layer.normal, false]] as const) {
            const map = await loadMap(url, color);
            if (retired) { map.texture.dispose(); map.bitmap.close(); return; }
            maps.push(map);
          }
          archetype = { diffuse: maps[2]!.texture, normal: maps[3]!.texture, weight: layer.weight };
        } catch {
          // The generic maps can still render if the installation lacks the archetype layer.
        }
      }
      if (retired) return;
      if (withSkin) {
        try {
          const detail = await loadMap(skinDetail, true);
          if (retired) { detail.texture.dispose(); detail.bitmap.close(); return; }
          maps.push(detail);
          const zone = await loadMap(skinZone, false);
          if (retired) { zone.texture.dispose(); zone.bitmap.close(); return; }
          maps.push(zone);
          skinUniforms = {
            portraitSkinDetail: { value: detail.texture }, portraitSkinZone: { value: zone.texture },
            portraitSkinColors: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
            portraitSkinStrength: { value: 0 },
          };
        } catch {
          // The face remains visible when its colorizing layers are unavailable.
        }
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
      const tint = skinUniforms;
      const skin = tint ? surface.clone() : surface;
      // The authored head normal packs tangent X in alpha and Y in green.
      // Read the two linear channels without premultiplying the PNG.
      const configure = (material: THREE.MeshStandardMaterial, skinLayer: SkinUniforms | null) => {
        material.onBeforeCompile = shader => {
          const layeredNormal = archetype ? `headNormal = mix(headNormal,
            texture2D( archetypeNormal, vNormalMapUv ).ag * 2.0 - 1.0, archetypeCoverage);` : "";
          if (archetype) {
            shader.uniforms.archetypeDiffuse = { value: archetype.diffuse };
            shader.uniforms.archetypeNormal = { value: archetype.normal };
            shader.uniforms.archetypeWeight = { value: archetype.weight };
            shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
              #include <map_pars_fragment>
              uniform sampler2D archetypeDiffuse;
              uniform sampler2D archetypeNormal;
              uniform float archetypeWeight;
            `).replace("#include <map_fragment>", `
              #include <map_fragment>
              vec4 archetypeColor = texture2D( archetypeDiffuse, vMapUv );
              float archetypeCoverage = clamp(archetypeColor.a * archetypeWeight, 0.0, 1.0);
              diffuseColor.rgb = mix(diffuseColor.rgb, archetypeColor.rgb, archetypeCoverage);
            `);
          }
          if (skinLayer) {
            Object.assign(shader.uniforms, skinLayer);
            shader.fragmentShader = shader.fragmentShader.replace("#include <map_pars_fragment>", `
              #include <map_pars_fragment>
              uniform sampler2D portraitSkinDetail;
              uniform sampler2D portraitSkinZone;
              uniform vec3 portraitSkinColors[3];
              uniform float portraitSkinStrength;
            `).replace("#include <color_fragment>", `
              vec4 skinDetail = texture2D( portraitSkinDetail, vMapUv );
              vec3 skinZone = texture2D( portraitSkinZone, vMapUv ).rgb;
              vec3 skinTint = (skinZone.r * portraitSkinColors[0] + skinZone.g * portraitSkinColors[1] +
                skinZone.b * portraitSkinColors[2]) / max(dot(skinZone, vec3(1.0)), 0.001);
              diffuseColor.rgb = mix(diffuseColor.rgb, skinDetail.rgb * skinTint,
                portraitSkinStrength * clamp(4.0 * skinDetail.a, 0.0, 0.85));
              #include <color_fragment>
            `);
          }
          shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>",
            THREE.ShaderChunk.normal_fragment_maps.replace(
              "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
              `vec2 headNormal = texture2D( normalMap, vNormalMapUv ).ag * 2.0 - 1.0;
               ${layeredNormal}
               vec3 mapN = vec3( headNormal, sqrt( max( 0.0, 1.0 - dot( headNormal, headNormal ) ) ) );`,
            ));
        };
        material.customProgramCacheKey = () => `portrait:${Boolean(archetype)}:${Boolean(skinLayer)}`;
      };
      configure(surface, null);
      if (tint) configure(skin, tint);
      applySurface(avatar, surface, new Set(transparent), new Set(eyelashMeshes), eyelashes, skin);
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
