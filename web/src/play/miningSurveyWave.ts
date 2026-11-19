import * as THREE from "three";
import { loadTypeListsHolding, type ApiOptions } from "../app/api.ts";
import { SCAN_EFFECT_MS, SCAN_RANGE_M } from "../nav/surveyScan.ts";
import { distanceMeters } from "../space/overview.ts";
import type { ReadableSignal } from "../store/signals.ts";
import type { SpaceVector, SurveyResult } from "../store/types.ts";
import { prepareScalar, scalarAt, type ScalarCurve } from "../three/curves.ts";
import { playUiEvent } from "./uiAudio.ts";

export interface FlightMiningSurvey {
  readonly busy: ReadableSignal<boolean>;
  scan(): Promise<void>;
}

export interface SurveyRock {
  readonly itemID: number;
  readonly typeID: number | null;
  readonly position: SpaceVector;
  readonly radius: number;
  readonly oreValuePerM3?: number | null;
}

// VolumeScanner_01a / volumeScan_cs. Scaling reaches twice the controller's
// range with linear interpolation. The orchestrator uses half that diameter.
const brightness: ScalarCurve = { keys: [
  [0, 0, 0, 0, 1, 2, 2],
  [0.033252, 1, 0, 0, 3, 2, 2],
  [0.85, 1, 0, 0, 4, 2, 2],
  [0.91, 0.076929, -1.161031, -1.161031, 5, 2, 2],
  [1, 0, 0, 0, 2, 2, 2],
] };
const brightnessKeys = prepareScalar(brightness);

export function miningWaveSample(elapsedMs: number) {
  const progress = Math.max(0, Math.min(1, elapsedMs / SCAN_EFFECT_MS));
  return { radius: progress * SCAN_RANGE_M, brightness: scalarAt(brightness, brightnessKeys, progress), finished: progress >= 1 };
}

export function miningWaveTargets(rocks: readonly SurveyRock[], results: readonly SurveyResult[], origin: SpaceVector) {
  const surveyed = new Set(results.map(row => row.itemID));
  return rocks.flatMap(rock => {
    if (!surveyed.has(rock.itemID)) return [];
    const distance = distanceMeters(origin, rock.position) + rock.radius;
    return distance <= SCAN_RANGE_M ? [{ ...rock, distance }] : [];
  }).sort((a, b) => a.distance - b.distance);
}

// OreTypeList order matters when a type belongs to more than one list.
const consecutiveCues = (start: number, count: number, prefix: string) =>
  Array.from({ length: count }, (_, i) => [start + i, `mining_scan_${prefix}_ui_group_${i + 1}`] as const);
const cues = new Map<number, string>([
  ...consecutiveCues(865, 24, "ore"), ...consecutiveCues(889, 4, "abyssal_ore"),
  [893, "mining_scan_erratic_ore_ui_group_1"], ...consecutiveCues(894, 8, "ice"),
  [933, "mining_scan_ice_ui_group_8"], [917, "mining_scan_gas_cloud_ui_group"],
]);
const cueLists = [...cues.keys()];
const cueListBatches = [cueLists.slice(0, 16), cueLists.slice(16, 32), cueLists.slice(32)];

export async function miningWaveSounds(typeIDs: readonly number[], options: ApiOptions): Promise<ReadonlyMap<number, string>> {
  const sounds = new Map<number, string>();
  const unique = [...new Set(typeIDs)];
  for (let offset = 0; offset < unique.length; offset += 32) {
    const types = unique.slice(offset, offset + 32);
    const memberships = await Promise.all(cueListBatches.map(batch =>
      loadTypeListsHolding(types, batch, options).catch((): Readonly<Record<number, readonly number[] | null>> => ({})),
    ));
    for (const typeID of types) {
      const lists = memberships.flatMap(result => result[typeID] ?? []);
      const cue = cueLists.find(id => lists.includes(id));
      if (cue !== undefined) sounds.set(typeID, cues.get(cue)!);
    }
  }
  return sounds;
}

const SURVEY_VERTEX = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 localNormal;
  varying vec3 viewNormal;
  varying vec3 viewDirection;
  varying vec3 oreColor;
  void main() {
    vec4 point = vec4(position, 1.0);
    vec3 direction = normal;
    oreColor = vec3(1.0);
    #ifdef USE_INSTANCING
      point = instanceMatrix * point;
      direction = mat3(instanceMatrix) * direction;
    #endif
    #ifdef USE_INSTANCING_COLOR
      oreColor = instanceColor;
    #endif
    vec4 viewPoint = modelViewMatrix * point;
    localNormal = normal;
    viewNormal = normalMatrix * direction;
    viewDirection = -viewPoint.xyz;
    gl_Position = projectionMatrix * viewPoint;
    #include <logdepthbuf_vertex>
  }
`;

const SURVEY_FRAGMENT = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 localNormal;
  varying vec3 viewNormal;
  varying vec3 viewDirection;
  varying vec3 oreColor;
  uniform float surveyEnvelope;
  void main() {
    #include <logdepthbuf_fragment>
    float facing = abs(dot(normalize(viewNormal), normalize(viewDirection)));
    float rim = pow(1.0 - facing, 2.2);
    #ifdef SURVEY_ROCK
      gl_FragColor = vec4(oreColor, 0.006 + 0.34 * rim);
    #else
      vec3 direction = normalize(localNormal);
      float band = pow(0.5 + 0.5 * cos(dot(direction, vec3(7.0, 38.0, -9.0))), 10.0);
      gl_FragColor = vec4(0.2, 0.72, 0.91, surveyEnvelope * (0.008 + 0.072 * band + 0.18 * rim));
    #endif
  }
`;

const surveyMaterial = (rock = false) => new THREE.ShaderMaterial({
  defines: rock ? { SURVEY_ROCK: 1 } : {},
  uniforms: { surveyEnvelope: { value: 0 } },
  vertexShader: SURVEY_VERTEX, fragmentShader: SURVEY_FRAGMENT,
  transparent: true, depthWrite: false, side: rock ? THREE.FrontSide : THREE.DoubleSide,
  blending: THREE.AdditiveBlending, toneMapped: false,
});

/** The local survey presentation, independent of the bot's survey results. */
export class MiningSurveyWave {
  readonly group = new THREE.Group();
  private readonly shell = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), surveyMaterial());
  private readonly rockGeometry = new THREE.SphereGeometry(1, 18, 12);
  private readonly rockMaterial = surveyMaterial(true);
  private readonly transform = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly cold = new THREE.Color(0x2fbacc);
  private readonly warm = new THREE.Color(0xffc668);
  private scan: {
    origin: SpaceVector;
    shipID: number;
    startMs: number;
    elapsedMs: number;
    targets: ReturnType<typeof miningWaveTargets>;
    markers: THREE.InstancedMesh;
    peakValue: number;
    reached: number;
    done?: () => void;
    audio: AbortController;
    sounds: Promise<ReadonlyMap<number, string>>;
  } | null = null;

  constructor() {
    this.group.name = "Mining survey";
    this.shell.name = "Mining survey wave";
    this.shell.visible = false;
    this.group.add(this.shell);
  }

  start(shipID: number, origin: SpaceVector, nowMs: number, targets: ReturnType<typeof miningWaveTargets>,
    sounds: Promise<ReadonlyMap<number, string>>, peakValue: number): Promise<void> {
    this.clear();
    const markers = new THREE.InstancedMesh(this.rockGeometry, this.rockMaterial, targets.length);
    markers.name = "Mining survey asteroid highlights";
    markers.frustumCulled = false;
    markers.count = 0;
    this.group.add(markers);
    const audio = new AbortController();
    void playUiEvent("mining_scan_start", audio.signal);
    return new Promise(done => {
      this.scan = { shipID, origin: { ...origin }, startMs: nowMs, elapsedMs: 0, targets, markers, peakValue, reached: 0, done, audio, sounds };
    });
  }

  update(nowMs: number, ego: { itemID: number | null; position: SpaceVector; mode?: string | null } | null,
    place: (itemID: number) => { position: THREE.Vector3; visibleRadius?: number } | undefined): void {
    const scan = this.scan;
    if (!scan) return;
    if (!ego || ego.itemID !== scan.shipID || ego.mode === "WARP") { this.clear(); return; }
    if (scan.done) {
      scan.elapsedMs = Math.max(scan.elapsedMs, nowMs - scan.startMs);
      const sample = miningWaveSample(scan.elapsedMs);
      this.shell.visible = sample.radius > 0 && !sample.finished;
      this.shell.position.set(scan.origin.x - ego.position.x, scan.origin.y - ego.position.y, ego.position.z - scan.origin.z);
      this.shell.scale.setScalar(Math.max(1, sample.radius));
      this.shell.material.uniforms.surveyEnvelope!.value = sample.brightness;
      while (scan.reached < scan.targets.length && scan.targets[scan.reached]!.distance <= sample.radius) {
        const target = scan.targets[scan.reached++]!;
        if (target.typeID !== null && place(target.itemID)) {
          const typeID = target.typeID;
          void scan.sounds.then(sounds => {
            const cue = sounds.get(typeID);
            if (cue) void playUiEvent(cue, scan.audio.signal);
          });
        }
      }
      if (sample.finished) this.finish();
    }
    let count = 0;
    for (let i = 0; i < scan.reached; i++) {
      const target = scan.targets[i]!;
      const mark = place(target.itemID);
      if (!mark) continue;
      const size = Math.max(8, (mark.visibleRadius ?? target.radius) * 1.08);
      this.transform.makeScale(size, size, size);
      this.transform.setPosition(mark.position);
      scan.markers.setMatrixAt(count, this.transform);
      const fraction = scan.peakValue > 0 && target.oreValuePerM3 != null ? target.oreValuePerM3 / scan.peakValue : 0.5;
      scan.markers.setColorAt(count++, this.color.copy(this.cold).lerp(this.warm, Math.min(1, Math.max(0, fraction))));
    }
    scan.markers.count = count;
    scan.markers.instanceMatrix.needsUpdate = true;
    if (scan.markers.instanceColor) scan.markers.instanceColor.needsUpdate = true;
  }

  private finish(): void {
    const scan = this.scan;
    if (!scan?.done) return;
    this.shell.visible = false;
    scan.done();
    scan.done = undefined;
    void playUiEvent("mining_scan_end");
  }

  clear(): void {
    if (!this.scan) return;
    this.finish();
    this.scan.audio.abort();
    this.scan.markers.removeFromParent();
    this.scan.markers.dispose();
    this.scan = null;
  }

  dispose(): void {
    this.clear();
    this.shell.geometry.dispose();
    this.shell.material.dispose();
    this.rockGeometry.dispose();
    this.rockMaterial.dispose();
  }
}
