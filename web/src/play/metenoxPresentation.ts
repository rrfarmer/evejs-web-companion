import { type Object3D, Vector3 } from "three";
import { filetimeToUnixMs } from "../bridge/activity.ts";
import { placeStretch, type SofStretch3 } from "../three/behaviorAgents.ts";
import { setControllerVariable } from "../three/controllerVariables.ts";
import { hullChildren, playEffectSet, setEffectShaderQuality } from "../three/hullChildren.ts";

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
    template.scale.setScalar(1);
    graphic = { geometry, template };
  }).catch(() => { /* The hull can still face the moon. */ });
}

interface DrillPresentation {
  lastHarvest: number | null;
  pendingHarvest: number | null;
  beam: Object3D | null;
}

const drills = new WeakMap<Object3D, DrillPresentation>();

interface Position { readonly x: number; readonly y: number; readonly z: number }
interface Moon { readonly position: Position; readonly radius: number }

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

  if (state.beam) state.beam.visible = false;
  if (!moon) return;
  const direction = new Vector3(moon.position.x - position.x, moon.position.y - position.y, position.z - moon.position.z);
  if (direction.lengthSq() === 0) return;
  // The browser mirrors the game world's Z. The holder's +Z is the rendered
  // hull's forward direction. Keep the roll from the static ball orientation.
  holder.rotation.set(Math.atan2(-direction.y, Math.hypot(direction.x, direction.z)),
    Math.atan2(direction.x, direction.z), holder.rotation.z, "YXZ");

  const model = holder.userData.model as Object3D | undefined;
  if (!model) return;
  requestBeam();
  const locator = (model.userData.locatorSets as Record<string, number[][]> | undefined)?.beam_source?.[0];
  if (!graphic || !locator) return;

  if (state.pendingHarvest !== null && state.pendingHarvest <= Date.now()) {
    if (!state.beam) {
      state.beam = graphic.template.clone();
      state.beam.name = "metenox-harvest-beam";
      holder.add(state.beam);
    }
    setControllerVariable(holder, "isFiring", 1, true);
    setControllerVariable(state.beam, "isFiring", 1, true);
    playEffectSet(state.beam, "play_start");
    state.pendingHarvest = null;
  }
  if (!state.beam) return;

  // CelestialBeam._SetUpBeamEndpoints uses beam_source and the nearest point
  // on the moon's spherical bounds, in the direction of the source.
  const [x = 0, y = 0, z = 0] = locator;
  const source = model.localToWorld(new Vector3(x, y, -z));
  const center = holder.getWorldPosition(new Vector3()).add(direction);
  const surface = source.clone().sub(center).normalize().multiplyScalar(moon.radius).add(center);
  placeStretch(state.beam, graphic.geometry, holder.worldToLocal(source), holder.worldToLocal(surface));
  setEffectShaderQuality(state.beam, shaderQuality);
  state.beam.visible = true;
}
