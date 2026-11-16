import type { Object3D } from "three";
import { effectObject, type SofChildNode } from "../three/hullChildren.ts";
import { setControllerVariable } from "../three/controllerVariables.ts";
import { gfx } from "./gfxSettings.ts";
import { playWorldEvent, playWorldLoop, stopEmitter, type WorldLoop } from "./uiAudio.ts";

const wormholeGraphics = { 84329: 20956, 87593: 28102 } as const;
type WormholeType = keyof typeof wormholeGraphics;

export function isNonInteractableWormhole(typeID: number | null): typeID is WormholeType {
  return typeID === 84329 || typeID === 87593;
}

interface WormholeEffect {
  root: SofChildNode | null;
  childEffects: Record<string, SofChildNode | null>;
  controllerVariableOverrides?: Record<string, number>;
}

const effectFiles = new Map<number, Promise<WormholeEffect | null>>();

export async function nonInteractableWormhole(typeID: WormholeType, playSound: (event: string, observer: string) => void) {
  const graphicID = wormholeGraphics[typeID];
  let pending = effectFiles.get(graphicID);
  if (!pending) {
    pending = fetch(`/client-assets/effect/${graphicID}.json`)
      .then((response) => response.ok ? response.json() as Promise<WormholeEffect> : null)
      .then((effect) => {
        if (!effect?.root) effectFiles.delete(graphicID);
        return effect;
      }, (error: unknown) => {
        effectFiles.delete(graphicID);
        throw error;
      });
    effectFiles.set(graphicID, pending);
  }
  const effect = await pending;
  if (!effect?.root) return null;
  const object = await effectObject(effect.root, effect.childEffects, playSound);
  const overrides = effect.controllerVariableOverrides ?? (typeID === 87593 ? { WH_State: 1 } : {});
  return object ? { object, overrides } : null;
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

/** SpaceObject.OnSlimItemUpdated runs the handler on each fresh slim, even when poseID repeats. */
export function updateWormholePose(object: Object3D, slim: ReadonlyMap<unknown, unknown> | undefined): void {
  if (!slim || object.userData.wormholeSlim === slim) return;
  object.userData.wormholeSlim = slim;
  const pose = Number(slim.get("poseID") ?? 0);
  object.userData.wormholePose = pose;
  setControllerVariable(object, "WH_Age", 0);
  setControllerVariable(object, "WH_State", pose ? 1 : 0);
  if (pose === 3) setControllerVariable(object, "_WH_OnUse", 3, true);
}
