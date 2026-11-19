import type { Object3D } from "three";
import { effectObject, type SofChildNode } from "../three/hullChildren.ts";
import { setControllerVariable } from "../three/controllerVariables.ts";
import { gfx } from "./gfxSettings.ts";
import { playWorldEvent, playWorldLoop, stopEmitter, type WorldLoop } from "./uiAudio.ts";

const wormholeGraphics = { 84329: 20956, 87593: 28102 } as const;
type WormholeType = keyof typeof wormholeGraphics;
export const WORMHOLE_GROUP = 988;

export function isNonInteractableWormhole(typeID: number | null): typeID is WormholeType {
  return typeID === 84329 || typeID === 87593;
}

interface WormholeEffect {
  root: SofChildNode | null;
  childEffects: Record<string, SofChildNode | null>;
  controllerVariableOverrides?: Record<string, number>;
}

const effectFiles = new Map<number, Promise<WormholeEffect | null>>();
const nebulaFiles = new Map<number, Promise<Record<string, string> | null>>();

function wormholeEffect(graphicID: number) {
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
  return pending;
}

export async function nonInteractableWormhole(typeID: WormholeType, playSound: (event: string, observer: string) => void) {
  const effect = await wormholeEffect(wormholeGraphics[typeID]);
  if (!effect?.root) return null;
  const object = await effectObject(effect.root, effect.childEffects, playSound);
  const overrides = effect.controllerVariableOverrides ?? (typeID === 87593 ? { WH_State: 1 } : {});
  return object ? { object, overrides } : null;
}

function destinationNebula(graphicID: number) {
  if (!Number.isSafeInteger(graphicID) || graphicID <= 0) return Promise.resolve(null);
  if (!nebulaFiles.has(graphicID)) {
    nebulaFiles.set(graphicID, fetch(`/client-assets/wormhole-nebula/${graphicID}.json`)
      .then((response) => response.ok ? response.json() as Promise<Record<string, string>> : null)
      .catch(() => null)
      .then((maps) => {
        if (!maps) nebulaFiles.delete(graphicID);
        return maps;
      }));
  }
  return nebulaFiles.get(graphicID)!;
}

function bindWormholeTextures(node: SofChildNode, maps: Record<string, string>): SofChildNode {
  if (node.k === "container") return { ...node, objects: node.objects.map((child) => bindWormholeTextures(child, maps)) };
  if (node.k !== "mesh") return node;
  return { ...node, areas: node.areas.map((area) => {
    if (!area.textureSlots) return area;
    const textures = { ...area.textures };
    for (const [parameter, slot] of Object.entries(area.textureSlots)) {
      if (maps[slot]) textures[parameter] = maps[slot];
    }
    return { ...area, textures };
  }) };
}

export async function ordinaryWormhole(typeID: number, nebulaID: number, playSound: (event: string, observer: string) => void) {
  // The five Drifter links in group 988 use the separate Sleeper graph in build 3698585.
  const graphicID = typeID >= 35650 && typeID <= 35654 ? 21050 : 3715;
  const [effect, maps] = await Promise.all([wormholeEffect(graphicID), destinationNebula(nebulaID)]);
  if (!effect?.root) return null;
  const root = maps ? bindWormholeTextures(effect.root, maps) : effect.root;
  const object = await effectObject(root, effect.childEffects, playSound);
  return object ? { object, overrides: effect.controllerVariableOverrides ?? {} } : null;
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
export function updateWormholePose(object: Object3D, slim: ReadonlyMap<unknown, unknown> | undefined, ordinary = false): void {
  if (!slim || object.userData.wormholeSlim === slim) return;
  object.userData.wormholeSlim = slim;
  if (ordinary) {
    setControllerVariable(object, "WH_State", 1);
    setControllerVariable(object, "WH_Age", Math.min(2, Number(slim.get("wormholeAge") ?? 0)));
    setControllerVariable(object, "WH_ShipMass", Number(slim.get("maxShipJumpMass") ?? 0));
    const size = Number(slim.get("wormholeSize") ?? 1);
    setControllerVariable(object, "WH_Size", size === 0.4 ? 3 : size === 0.7 ? 2 : 1);
    setControllerVariable(object, "isDestTriglavian", Number(slim.get("isDestTriglavian") ?? 0));
    return;
  }
  const pose = Number(slim.get("poseID") ?? 0);
  object.userData.wormholePose = pose;
  setControllerVariable(object, "WH_Age", 0);
  setControllerVariable(object, "WH_State", pose ? 1 : 0);
  if (pose === 3) setControllerVariable(object, "_WH_OnUse", 3, true);
}
