import { Vector3, type Object3D, type Scene } from "three";
import { setGpuParticleAssets } from "../three/gpuParticles.ts";
import { effectObject, startEffect, type SofChildNode } from "../three/hullChildren.ts";
import { explosionSoundsOf, pickExplosion, playWorldEvent } from "./uiAudio.ts";

export const DRIFTER_COLLECTION = 85231;

type Position = { x: number; y: number; z: number };
type Sound = ReturnType<typeof pickExplosion>[number];

interface CollectionExplosion {
  root: SofChildNode;
  childEffects: Record<string, SofChildNode | null>;
  gpuParticles?: Parameters<typeof setGpuParticleAssets>[0];
  delayMs: number;
  durationMs: number;
  modelSwitchDelayMs: number;
  scale: number;
}

let asset: Promise<CollectionExplosion | null> | undefined;
function load(): Promise<CollectionExplosion | null> {
  return asset ??= fetch("/client-assets/drifterCollectionExplosion.json")
    .then((r) => r.ok ? r.json() as Promise<CollectionExplosion> : Promise.reject(new Error(String(r.status))))
    .catch(() => { asset = undefined; return null; });
}

interface Explosion {
  position: Position;
  at: number;
  data?: CollectionExplosion;
  model?: Object3D;
  visual?: Object3D;
  sounds: Sound[];
}

export class DrifterCollectionExplosions {
  private readonly active = new Map<number, Explosion>();

  constructor(private readonly scene: Scene) {}

  preload(): void {
    void load();
    void explosionSoundsOf();
  }

  queue(id: number, position: Position, at: number): void {
    if (this.active.has(id)) return;
    const explosion: Explosion = { position, at, sounds: [] };
    this.active.set(id, explosion);
    void explosionSoundsOf().then((table) => {
      explosion.sounds = pickExplosion(table, DRIFTER_COLLECTION, "g");
    });
    void load().then(async (data) => {
      if (!data || this.active.get(id) !== explosion) return;
      explosion.data = data;
      setGpuParticleAssets(data.gpuParticles);
      const visual = await effectObject(data.root, data.childEffects);
      if (visual && this.active.get(id) === explosion) {
        visual.scale.setScalar(data.scale);
        explosion.visual = visual;
      }
    }).catch((error: unknown) => console.warn("Drifter Collection effect:", error));
  }

  holdModel(id: number, model: Object3D): boolean {
    const explosion = this.active.get(id);
    if (!explosion) return false;
    explosion.model = model;
    return true;
  }

  update(origin: Position, now: number): void {
    for (const [id, explosion] of this.active) {
      const { position, at, data, model, visual } = explosion;
      // Preserve the last frame's model through the native switch time, but
      // release it if streaming the graph stalls or extraction fails.
      const start = data ? at + data.delayMs : at;
      if (now >= start + (data?.durationMs ?? 5000)) {
        model?.removeFromParent();
        visual?.removeFromParent();
        this.active.delete(id);
        continue;
      }
      const relative = new Vector3(position.x - origin.x, position.y - origin.y, origin.z - position.z);
      if (model) {
        if (data && now >= start + data.modelSwitchDelayMs) {
          model.removeFromParent();
          explosion.model = undefined;
        } else {
          model.position.copy(relative);
        }
      }
      if (!data || now < start) continue;
      if (visual) {
        visual.position.copy(relative);
        if (!visual.parent) {
          this.scene.add(visual);
          startEffect(visual);
        }
      }
      explosion.sounds = explosion.sounds.filter((sound) => {
        if (now < start + sound.time * 1000) return true;
        void playWorldEvent(sound.event, relative, sound.scale);
        return false;
      });
    }
  }

  clear(): void {
    for (const { model, visual } of this.active.values()) {
      model?.removeFromParent();
      visual?.removeFromParent();
    }
    this.active.clear();
  }
}
