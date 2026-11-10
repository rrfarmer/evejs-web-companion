// The scenes' glow: every EveSpaceScene the client draws has a post-process bloom (Tr2PostProcess2's
// Tr2PPBloomEffect; the hangar scenes give it a luminance threshold of 0), so bright things - glow maps, lights,
// lava, engine flames, the sun - bleed light round them. Ours is three's UnrealBloomPass between the scene's render
// and the output (tone mapping and colour space as the renderer has them).
//
// The scene is drawn into its own multisampled target and copied into the composer's plain targets: three
// invalidates a multisampled target's samples once it resolves them, so the bloom's additive composite back into a
// multisampled read buffer lands on nothing and the frame comes out black.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import type { DynamicExposure } from "./exposure.ts";

export interface Bloom {
  render(): void;
  setSize(width: number, height: number): void;
  dispose(): void;
  readonly pass: UnrealBloomPass;
}

/** A scene drawn with a glow: strength (how much), radius (how far, 0 to 1), threshold (the brightness it starts at). */
export function bloomFor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, glow: { strength: number; radius: number; threshold: number },
  exposure: () => DynamicExposure | null = () => null): Bloom {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const w = Math.max(1, size.x), h = Math.max(1, size.y);
  const drawn = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType }));
  // The copy in drops any NaN or infinite pixel: the blur spreads one over its neighbourhood and a NaN anywhere in
  // the bright pass turns the whole composite black.
  const copyIn = new ShaderPass({
    uniforms: { drawn: { value: null } },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform sampler2D drawn; varying vec2 vUv;
      void main() {
        vec4 c = texture2D(drawn, vUv);
        if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
        gl_FragColor = min(c, vec4(256.0));
      }`,
  }, "none");
  copyIn.uniforms["drawn"]!.value = drawn.texture; // after: ShaderPass clones its uniforms, and a target's texture won't clone
  composer.addPass(copyIn);
  const pass = new UnrealBloomPass(new THREE.Vector2(w, h), glow.strength, glow.radius, glow.threshold);
  composer.addPass(pass);
  composer.addPass(new OutputPass());
  return {
    pass,
    render: () => {
      renderer.setRenderTarget(drawn);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      // the scene's dynamic exposure, where it has one, measured on the frame as drawn and set for the output
      const e = exposure();
      if (e) { e.measure(renderer, drawn.texture); e.step(renderer); }
      composer.render();
    },
    setSize: (cw, ch) => {
      const r = renderer.getPixelRatio();
      drawn.setSize(Math.max(1, Math.floor(cw * r)), Math.max(1, Math.floor(ch * r)));
      composer.setPixelRatio(r);
      composer.setSize(cw, ch);
    },
    dispose: () => { composer.dispose(); drawn.dispose(); },
  };
}
