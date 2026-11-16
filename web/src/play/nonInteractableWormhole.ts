import type { Object3D } from "three";
import { effectObject, type SofChildNode } from "../three/hullChildren.ts";
import { setControllerVariable } from "../three/hullModel.ts";

export function isNonInteractableWormhole(typeID: number | null): boolean {
  return typeID === 84329 || typeID === 87593;
}

interface WormholeEffect {
  root: SofChildNode | null;
  childEffects: Record<string, SofChildNode | null>;
}

let effectFile: Promise<WormholeEffect | null> | undefined;

export async function nonInteractableWormhole(): Promise<Object3D | null> {
  // Both non-interactable types share Wormhole_Violent in the 3698585 graphics table.
  effectFile ??= fetch("/client-assets/effects/20956.json")
    .then((response) => response.ok ? response.json() as Promise<WormholeEffect> : null)
    .then((effect) => {
      if (!effect?.root) effectFile = undefined;
      return effect;
    }, (error: unknown) => {
      effectFile = undefined;
      throw error;
    });
  const effect = await effectFile;
  return effect?.root ? effectObject(effect.root, effect.childEffects) : null;
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
