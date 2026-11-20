import { type Object3D, Vector3 } from "three";
import { filetimeToUnixMs } from "../bridge/activity.ts";
import { placeStretch, type SofStretch3 } from "../three/behaviorAgents.ts";
import { setControllerVariable } from "../three/controllerVariables.ts";
import { hullChildren, playEffectSet, setEffectShaderQuality, setEffectSoundHandler } from "../three/hullChildren.ts";
import { playMovingWorldEvent } from "./uiAudio.ts";

// 3698585 moonmining/autoMoonMining/common and structures/const.py.
const OPERATING_STATES = [102, 110, 111, 112, 113, 114];
const UPKEEP_STATES = [1, 2, 3];

interface BeamGraphic {
  readonly geometry: SofStretch3;
  readonly template: Object3D;
}

let requested = false;
let graphic: BeamGraphic | null = null;
function requestBeam(): void {
  if (requested) return;
  requested = true;
  void fetch("/client-assets/fx/effects.AutoMoonMinerBeam.json").then(async response => {
    if (!response.ok) return;
    const data: { stretches?: (SofStretch3 & { type: string })[] } = await response.json();
    const geometry = data.stretches?.find(stretch => stretch.type === "EveStretch3" && stretch.root);
    if (!geometry) return;
    const template = await hullChildren([{ res: "", root: geometry.root, skipped: {} }]);
    if (!template) return;
    graphic = { geometry, template };
  }).catch(() => { /* The hull can still face the moon. */ });
}

interface DrillPresentation {
  lastHarvest: number | null;
  pendingHarvest: number | null;
  beam: { object: Object3D; audio: BeamAudio } | null;
}

const drills = new WeakMap<Object3D, DrillPresentation>();

interface Position { readonly x: number; readonly y: number; readonly z: number }
interface Moon { readonly position: Position; readonly radius: number }

interface Voice {
  readonly at: Vector3;
  readonly abort: AbortController;
  sound?: Awaited<ReturnType<typeof playMovingWorldEvent>>;
  fadeUntil?: number;
}

class BeamAudio {
  private readonly observers = new Map([
    ["stretch_source_sfx", new Vector3()],
    ["stretch_mid_sfx", new Vector3()],
    ["stretch_dest_sfx", new Vector3()],
  ]);
  private readonly voices = new Map<string, Voice>();

  play(event: string, observer: string): void {
    const at = this.observers.get(observer);
    if (!at) return;
    // The bank's stop action fades the middle loop over 1 s and plays its own tail.
    if (event === "autominer_mining_loop_stop") {
      const loop = this.voices.get("autominer_mining_loop_play");
      if (loop) {
        loop.fadeUntil = performance.now() + 1000;
        loop.sound?.stop(1000);
      }
    }
    this.stop(event);
    const voice: Voice = { at, abort: new AbortController() };
    this.voices.set(event, voice);
    void playMovingWorldEvent(event, at, voice.abort.signal).then(sound => {
      voice.sound = sound;
      if (voice.fadeUntil !== undefined) sound.stop(Math.max(0, voice.fadeUntil - performance.now()));
    });
  }

  move(source: Vector3, destination: Vector3): void {
    this.observers.get("stretch_source_sfx")!.copy(source);
    this.observers.get("stretch_mid_sfx")!.lerpVectors(source, destination, 0.5);
    this.observers.get("stretch_dest_sfx")!.copy(destination);
    for (const [event, { sound, at }] of this.voices) {
      if (sound?.active) sound.move(at);
      else if (sound) this.voices.delete(event);
    }
  }

  private stop(event: string): void {
    const voice = this.voices.get(event);
    if (!voice) return;
    voice.abort.abort();
    voice.sound?.stop();
    this.voices.delete(event);
  }

  clear(): void {
    for (const event of this.voices.keys()) this.stop(event);
  }
}

export function hideMetenoxBeam(holder: Object3D): void {
  const beam = drills.get(holder)?.beam;
  if (!beam) return;
  beam.object.visible = false;
  beam.audio.clear();
}

export function updateMetenoxPresentation(
  holder: Object3D,
  slim: ReadonlyMap<unknown, unknown>,
  position: Position,
  moon: Moon | undefined,
  shaderQuality: 1 | 2 | 3,
): void {
  const operating = OPERATING_STATES.indexOf(Number(slim.get("state")));
  const upkeep = UPKEEP_STATES.indexOf(Number(slim.get("upkeepState")));
  if (operating >= 0) setControllerVariable(holder, "operatingState", operating);
  if (upkeep >= 0) setControllerVariable(holder, "upkeepState", upkeep);

  const raw = slim.get("component_autoMoonMiner_lastHarvest");
  const harvest = typeof raw === "bigint" ? filetimeToUnixMs(raw) : null;
  let state = drills.get(holder);
  if (!state) {
    // Loading a ball supplies the last harvest as a baseline. A subsequent slim
    // change starts the pulse, as AutoMoonMiner.OnSlimItemUpdated does.
    state = { lastHarvest: harvest, pendingHarvest: null, beam: null };
    drills.set(holder, state);
  } else if (harvest !== null && (state.lastHarvest === null || harvest > state.lastHarvest)) {
    state.lastHarvest = state.pendingHarvest = harvest;
  }

  if (!moon) { hideMetenoxBeam(holder); return; }
  const direction = new Vector3(moon.position.x - position.x, moon.position.y - position.y, position.z - moon.position.z);
  if (direction.lengthSq() === 0) { hideMetenoxBeam(holder); return; }
  // The browser mirrors the game world's Z. The holder's +Z is the rendered
  // hull's forward direction. Keep the roll from the static ball orientation.
  holder.rotation.set(Math.atan2(-direction.y, Math.hypot(direction.x, direction.z)),
    Math.atan2(direction.x, direction.z), holder.rotation.z, "YXZ");

  const model = holder.userData.model as Object3D | undefined;
  if (!model) { hideMetenoxBeam(holder); return; }
  requestBeam();
  const locator = (model.userData.locatorSets as Record<string, number[][]> | undefined)?.beam_source?.[0];
  if (!graphic || !locator) { hideMetenoxBeam(holder); return; }

  if (state.pendingHarvest !== null && state.pendingHarvest <= Date.now()) {
    if (!state.beam) {
      const object = graphic.template.clone();
      const audio = new BeamAudio();
      state.beam = { object, audio };
      object.name = "metenox-harvest-beam";
      setEffectSoundHandler(object, (event, observer) => audio.play(event, observer));
      holder.add(object);
    }
    setControllerVariable(holder, "isFiring", 1, true);
    setControllerVariable(state.beam.object, "isFiring", 1, true);
    playEffectSet(state.beam.object, "play_start");
    state.pendingHarvest = null;
  }
  if (!state.beam) return;

  // CelestialBeam._SetUpBeamEndpoints uses beam_source and the nearest point
  // on the moon's spherical bounds, in the direction of the source.
  const [x = 0, y = 0, z = 0] = locator;
  const source = model.localToWorld(new Vector3(x, y, -z));
  const center = holder.getWorldPosition(new Vector3()).add(direction);
  const surface = source.clone().sub(center).normalize().multiplyScalar(moon.radius).add(center);
  const { object, audio } = state.beam;
  audio.move(source, surface);
  // The effect's root mirrors its authored EVE coordinates into the browser.
  const localSource = holder.worldToLocal(source);
  const localSurface = holder.worldToLocal(surface);
  localSource.z *= -1;
  localSurface.z *= -1;
  placeStretch(object, graphic.geometry, localSource, localSurface);
  setEffectShaderQuality(object, shaderQuality);
  object.visible = true;
}
