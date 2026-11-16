import type { Object3D } from "three";
import { effectObject, type SofChildNode } from "../three/hullChildren.ts";
import { setControllerVariable } from "../three/hullModel.ts";
import { gfx } from "./gfxSettings.ts";
import { playWorldEvent, playWorldLoop, stopEmitter, type WorldLoop } from "./uiAudio.ts";

export function isNonInteractableWormhole(typeID: number | null): boolean {
  return typeID === 84329 || typeID === 87593;
}

interface WormholeEffect {
  root: SofChildNode | null;
  childEffects: Record<string, SofChildNode | null>;
}

let effectFile: Promise<WormholeEffect | null> | undefined;

export async function nonInteractableWormhole(playSound: (event: string, observer: string) => void): Promise<Object3D | null> {
  // Both non-interactable types share Wormhole_Violent in the 3698585 graphics table.
  effectFile ??= fetch("/client-assets/effect/20956.json")
    .then((response) => response.ok ? response.json() as Promise<WormholeEffect> : null)
    .then((effect) => {
      if (!effect?.root) effectFile = undefined;
      return effect;
    }, (error: unknown) => {
      effectFile = undefined;
      throw error;
    });
  const effect = await effectFile;
  return effect?.root ? effectObject(effect.root, effect.childEffects, playSound) : null;
}

/** The portal's positioned Wwise observer, owned by the corresponding ball on this grid. */
export class WormholeAudio {
  private readonly lifetime = new AbortController();
  private readonly emitter: string;
  private open = false;
  private ambience: { request: AbortController; loop?: WorldLoop } | null = null;

  constructor(itemID: number, private readonly holder: Object3D) {
    this.emitter = `wormhole:${itemID}`;
  }

  play = (event: string, observer: string): void => {
    if (this.lifetime.signal.aborted) return;
    if (event === "worldobject_wormhole_play" && observer === "wormhole_sfx_observer") {
      this.open = true;
      this.move();
      return;
    }
    // The collapse event's Wwise Stop actions fade the running wormhole layers for 3 s.
    if (event === "worldobject_wormhole_collapse_play" && observer === "wormhole_sfx_observer") {
      this.open = false;
      this.stopAmbience(3000);
    }
    void playWorldEvent(event, this.holder.position, 1, this.emitter, this.lifetime.signal);
  };

  move(): void {
    if (!this.open || this.lifetime.signal.aborted) return;
    const { audioEnabled, masterVolume, worldVolume } = gfx();
    if (!audioEnabled || masterVolume <= 0 || worldVolume <= 0) {
      this.stopAmbience();
      return;
    }
    if (!this.ambience) {
      const ambience: { request: AbortController; loop?: WorldLoop } = { request: new AbortController() };
      this.ambience = ambience;
      void playWorldLoop("worldobject_wormhole_play", this.holder.position, ambience.request.signal).then((loop) => {
        if (ambience.request.signal.aborted) loop.stop();
        else ambience.loop = loop;
      });
    }
    this.ambience.loop?.move(this.holder.position);
  }

  dispose(): void {
    this.lifetime.abort();
    this.stopAmbience();
    stopEmitter(this.emitter);
  }

  private stopAmbience(fadeMs = 0): void {
    this.ambience?.request.abort();
    this.ambience?.loop?.stop(fadeMs);
    this.ambience = null;
  }
}

/** clientControllerRegistry.NonInteractableWormhole sets these from the slim item's pose. */
export function updateWormholePose(object: Object3D, pose: number | null | undefined): void {
  const state = pose ?? 0;
  if (object.userData.wormholePose === state) return;
  object.userData.wormholePose = state;
  setControllerVariable(object, "WH_Age", 0);
  setControllerVariable(object, "WH_State", state ? 1 : 0);
  setControllerVariable(object, "_WH_OnUse", state === 3 ? 3 : 0);
}
