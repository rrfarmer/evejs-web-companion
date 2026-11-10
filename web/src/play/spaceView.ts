// Space, drawn from the browser's own park (LivePark): every ball where the retail client draws it
// (Ballpark.drawn), described by the BFF's own overview projection (projectSpace), around a camera that
// orbits the pilot's ship as the client's does.
//
// FLOATING ORIGIN. EVE's coordinates run to hundreds of billions of metres; a float32 vertex there has
// steps of tens of kilometres. The scene's origin is the pilot's ship every frame: positions are taken
// relative to it in doubles on the CPU and only then handed to the GPU. A logarithmic depth buffer
// covers a hull at 10 m and a planet at 10^10 m in one frame.
//
// HANDEDNESS. EVE's space is left-handed (y up); three.js is right-handed. z is mirrored going in and
// coming out (models are mirrored once, at extraction).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { projectSpace } from "virtual:destiny";
import { LivePark } from "../three/livePark.ts";
import { typeModel, setThrust, setShipSpeed, setControllerVariable, sendControllerEvent, setActivationStrength } from "../three/hullModel.ts";
import { shiftGpuParticles } from "../three/gpuParticles.ts";
import { celestialModel, systemCelestials, setPlanetEnvironment, type CelestialItem } from "../three/celestialModel.ts";
import { ShipHud, type HudModule } from "./shipHud.ts";
import { WarpTunnel } from "./warpTunnel.ts";
import { TurretFx, fxGuid } from "./turretFx.ts";
import { impactOverlayOf, IMPACT_ANIMATIONS, type ImpactOverlay } from "../three/impactOverlay.ts";
import type { DamageRouting } from "../store/types.ts";
import { TargetBar, type TargetBarEntry } from "./targetBar.ts";
import { loadDds } from "../three/ddsTexture.ts";
import { Overview, typeNames } from "./overview.ts";
import { DScanWindow } from "./dscan.ts";
import { Neocom } from "./neocom.ts";
import { bracketIcon, loadBrackets } from "./brackets.ts";
import { panelErrorWords } from "../bridge/refusals.ts";
import { PlayWindow, clientTexture } from "./window.ts";
import { bloomFor, type Bloom } from "../three/bloom.ts";
import { DynamicExposure } from "../three/exposure.ts";
import { RadialMenu, RADIAL_CSS, RADIAL_ICON, WARP_RANGES, holdToOpen, radialRanges, type RadialOption } from "./radialMenu.ts";

export interface Entity {
  kind: string; itemID: number; typeID: number | null; groupID: number | null; categoryID: number | null; name: string | null;
  radius: number; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number };
  isSelf: boolean; mode?: string | null; maxVelocity?: number | null; isNpc?: boolean; targetEntityID?: number | null;
}
interface Snapshot {
  entities: Entity[];
  ship: (Entity & {
    maxVelocity: number | null; speedFraction: number | null;
    shieldRatio?: number | null; armorRatio?: number | null; hullRatio?: number | null; capacitorRatio?: number | null;
  }) | null;
}

/**
 * `onNeocom`: what a Neocom button opens. `rack`: the module rack's data and use. `windowLayer`: where the view's own
 * windows (overview, selected item, the scanner) and its radial menu go, beside the app's windows so that they stack
 * together, the one last clicked on top; the view's own root when there is none. `showInfo`: the info window for a
 * thing in space (the radial menu's Show Info).
 */
export interface SpaceViewOptions {
  onNeocom?: (id: string) => void;
  rack?: { modules(): HudModule[]; use(m: HudModule): Promise<void>; capacitor?(): { max: number | null; ratio: number | null } };
  windowLayer?: { element: HTMLElement; raise(el: HTMLElement): void };
  showInfo?: (itemID: number, typeID: number | null) => void;
  /** True while the pilot is coming out of a station: the view's first sight of the ship is the undock camera's. */
  undocking?: () => boolean;
}

export interface SpaceActions {
  gotoDirection(dx: number, dy: number, dz: number): Promise<void>;
  alignTo(itemID: number): Promise<void>;
  keepAtRange(itemID: number, range?: number): Promise<void>;
  /** The jump; `onJumping` said as the jump itself is asked (after any closing in), which starts the gate effect. */
  jump(itemID: number, onJumping?: () => void): Promise<void>;
  lock(itemID: number): Promise<void>;
  unlock(itemID: number): Promise<void>;
  /** What is locked, and what has the pilot locked: the BFF's read (GET /api/bridge/targets). */
  targets(): Promise<{ targetIDs: number[]; targeterIDs: number[] }>;
  stop(): Promise<void>;
  approach(itemID: number): Promise<void>;
  orbit(itemID: number, range?: number): Promise<void>;
  warpTo(itemID: number, range?: number): Promise<void>;
  dock(itemID: number): Promise<void>;
  /** scanMgr.ConeScan(angle, range, x, y, z): the directional scanner's call, where the page can make it. */
  coneScan?(angle: number, range: number, x: number, y: number, z: number): Promise<unknown>;
  /** menusvc.OpenCargo on a wreck or a can: flown to within reach, opened, and the inventory window shown on it. */
  openCargo?(itemID: number): Promise<void>;
}

const KIND_COLOUR: Record<string, string> = {
  ship: "#c9c9c9", drone: "#c9c9c9", station: "#d7dad6", stargate: "#d7dad6", planet: "#9fb3c8", moon: "#9fb3c8", sun: "#ffd27a",
  asteroid: "#a08c74", celestial: "#9fb3c8", wreck: "#8d918c", container: "#8d918c", structure: "#d7dad6", billboard: "#8d918c",
};

/** A bracket glyph by kind, in the client's spirit: the shape says what it is, the colour whose. */
export function glyph(e: Entity): string {
  const c = e.isNpc ? "var(--hostile)" : KIND_COLOUR[e.kind] ?? "#c9c9c9";
  const icon = bracketIcon(e);
  if (icon) return `<span class="glyph bi" style="--icon:url('${icon}');--tint:${c}"></span>`;
  switch (e.kind) {
    case "ship": case "drone": case "fighter":
      return `<svg class="glyph" viewBox="0 0 16 16"><path d="M8 3 L13 12 L3 12 Z" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
    case "station": case "structure":
      return `<svg class="glyph" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" fill="none" stroke="${c}" stroke-width="1.5"/><rect x="6.5" y="6.5" width="3" height="3" fill="${c}"/></svg>`;
    case "stargate":
      return `<svg class="glyph" viewBox="0 0 16 16"><path d="M8 2 L14 8 L8 14 L2 8 Z" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
    case "planet": case "moon": case "sun":
      return `<svg class="glyph" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
    case "asteroid":
      return `<svg class="glyph" viewBox="0 0 16 16"><path d="M4 9 L7 4 L12 6 L12 11 L7 12 Z" fill="none" stroke="${c}" stroke-width="1.3"/></svg>`;
    default:
      return `<svg class="glyph" viewBox="0 0 16 16"><rect x="5" y="5" width="6" height="6" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
  }
}

export function distanceWords(m: number): string {
  if (m < 10_000) return `${Math.round(m).toLocaleString()} m`;
  if (m < 149_597_870_700 * 0.1) return `${Math.round(m / 1000).toLocaleString()} km`;
  return `${(m / 149_597_870_700).toFixed(1)} AU`;
}

export class SpaceView {
  readonly root = document.createElement("div");
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  /** Space's bloom (the space scenes' Tr2PPBloomEffect): the sun, engine flames, glow maps, weapons fire, lava. */
  private bloom: Bloom | null = null;
  /**
   * Space's dynamic exposure: the space scenes have no post-process of their own, so the client gives them
   * res:/dx9/default/postprocess.black (dynamic exposure at its defaults, tone map method 0).
   */
  private readonly exposure = new DynamicExposure();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 1, 1e13);
  private readonly controls: OrbitControls;
  private readonly brackets = document.createElement("div");
  private readonly bracketEls = new Map<number, HTMLDivElement>();
  private readonly marks = new Map<number, THREE.Object3D>();
  // Empty slots hidden, as the client's default (showEmptySlots off) has them, until the module rack knows the fit.
  private readonly shipHud = new ShipHud({ slots: { hi: 0, med: 0, low: 0 } });
  private readonly targetBar = new TargetBar();
  /** Targets being locked: itemID to when the lock began (performance.now()). */
  private readonly lockingIDs = new Map<number, number>();
  /** The active target (the client's state.activeTarget): the first locked, or the one last clicked in the bar. */
  private activeTarget: number | null = null;
  private readonly modeEl: HTMLDivElement;
  private readonly selectedEl: HTMLElement;
  private readonly selectedWin: PlayWindow;
  private locked = new Set<number>();
  private targeters = new Set<number>();
  private readonly feedEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private selected: number | null = null;
  private readonly overview: Overview;
  private starfieldObj!: THREE.Points;
  private readonly sunLight = new THREE.DirectionalLight(0xfff6e8, 3);
  private snapshot: Snapshot | null = null;
  private frameCount = 0;
  private stopped = false;
  private readonly warpTunnel = new WarpTunnel();
  /** Weapons fire, from the park's special effects. */
  private readonly turretFx = new TurretFx();
  /**
   * A shot landing on a ball with an impact overlay: at the damage locator facing the shooter best (the turret's
   * choice, EveTurretSet.cpp:3252-3330, roughly), its way the shooter's place less the locator's, the turret's size and
   * life (turretFx.ts).
   */
  private readonly onShot = (shooter: number, target: number, size: number, lifeTime: number): void => {
    const impact = this.marks.get(target)?.userData.impact as ImpactOverlay | undefined;
    const from = this.placeOf(shooter, this.lastOrigin);
    if (!impact || !from) return;
    const locator = impact.locatorFacing(from);
    const at = impact.locatorPosition(locator);
    impact.createImpact(locator, size, at ? from.clone().sub(at) : undefined, lifeTime);
  };
  /**
   * The defensive modules' impact animations under way (effects.ImpactEffect: Start and each Repeat set the animation
   * on for the cycle's length, Stop sets it off): by the module, its ship, its name, the cycle and when it next repeats.
   */
  private readonly impactAnimations = new Map<string, { ship: number; name: string; cycle: number; next: number; until: number }>();
  private readonly hearFx = (name: string, args: readonly unknown[]) => {
    this.turretFx.hear(name, args);
    if (name === "OnSpecialFX") {
      const anim = IMPACT_ANIMATIONS[fxGuid(args[5])];
      if (anim) {
        const ship = Number(args[0]), key = `${ship}:${Number(args[1])}`;
        // GenericEffect: the trigger's duration, else the effect's 10 s
        const duration = Number(args[9]) > 0 ? Number(args[9]) : 10_000, repeat = Number(args[10]);
        const impact = this.marks.get(ship)?.userData.impact as ImpactOverlay | undefined;
        if (Number(args[7]) === 1) {
          impact?.setImpactAnimation(anim, true, duration / 1000);
          const now = performance.now();
          this.impactAnimations.set(key, { ship, name: anim, cycle: duration, next: now + duration, until: now + duration * Math.max(1, Number.isFinite(repeat) && repeat > 0 ? Math.min(repeat, 1000) : 1) });
        } else {
          const a = this.impactAnimations.get(key);
          if (a) impact?.setImpactAnimation(a.name, false, a.cycle / 1000);
          this.impactAnimations.delete(key);
        }
      }
    }
    // OnClientControllerEvent(ballID, targetID, eventName, value): to the ball's model (spaceMgr.OnClientControllerEvent
    // -> spaceObject.SetControllerVariableFromEvent: Activated sets IsTriggered to the value; any other is an event)
    if (name === "OnClientControllerEvent") {
      const [ballID, , eventName, value] = args as [unknown, unknown, unknown, unknown];
      const mark = this.marks.get(Number(ballID));
      if (!mark || typeof eventName !== "string") return;
      if (eventName === "Activated") setControllerVariable(mark, "IsTriggered", Number(value ?? 0));
      else sendControllerEvent(mark, eventName);
    }
  };
  /**
   * The gate jump, drawn in our own way where the client plays its gate effect (SpaceToSpaceTransition: no fade, the
   * destination's scene swapped in during the effect): the tunnel builds from the jump order, flashes as the new
   * system's park comes (the feed's reset), and eases out.
   */
  private jumpOrderedAt: number | null = null;
  private jumpArrivedAt: number | null = null;
  private seenResets = 0;
  private seenSystem: number | null = null;
  private readonly flashEl = document.createElement("div");
  private readonly radial = new RadialMenu();
  /** Where the view's windows go (SpaceViewOptions.windowLayer). */
  private get layer(): HTMLElement { return this.options.windowLayer?.element ?? this.root; }
  private raiseOnClick(el: HTMLElement): void {
    const raise = this.options.windowLayer?.raise;
    if (raise) el.addEventListener("pointerdown", () => raise(el), true);
  }
  private dscan: DScanWindow | null = null;
  /**
   * A thing's name as the client gives it (uix.GetSlimItemName): its own name where it has one (a pilot's, a
   * station's, a celestial's), else its type's (an NPC hull, a wreck, a container, an asteroid).
   */
  private nameOf(e: Entity): string {
    return e.name ?? (e.typeID !== null ? this.names?.types[String(e.typeID)]?.[0] : null) ?? e.kind;
  }
  private names: { types: Record<string, [string | null, number | null]>; groups: Record<string, [string | null, number | null]> } | null = null;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly unhold: (() => void)[] = [];
  private lastFrameAt = performance.now();

  /** `onNeocom`: what a Neocom button opens; the app's play mode opens its own windows (PlayApp.svelte). */
  constructor(private readonly live: LivePark, private actions: SpaceActions, private readonly where: { system: string; security: number | null }, private readonly options: SpaceViewOptions = {}) {
    this.root.className = "space";
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.root.appendChild(this.renderer.domElement);
    this.brackets.className = "brackets";
    this.root.appendChild(this.brackets);
    this.root.insertAdjacentHTML("beforeend", `
      <div class="hud-top-left"><div class="system">${where.system}<span class="sec">${where.security === null ? "" : where.security.toFixed(1)}</span></div><div class="sub"></div></div>
      <div class="ship-mode"></div>
      <div class="toast"></div>
      <div class="feed-status"></div>`);
    this.flashEl.className = "jump-flash";
    this.root.appendChild(this.flashEl);
    this.seenResets = live.resets;
    this.seenSystem = live.hello?.solarSystemID ?? null;
    // The jump order starts the gate effect.
    const jump = actions.jump.bind(actions);
    // The call returns once the session has changed, after the new system's park has come: the effect starts as the
    // jump itself is asked (not while the ship is still flown to the gate), and is let go if the order is refused.
    this.actions = {
      ...actions,
      jump: async (id) => {
        try {
          await jump(id, () => { this.jumpOrderedAt = performance.now(); this.jumpArrivedAt = null; });
        } catch (e) { this.jumpOrderedAt = null; throw e; }
      },
    };
    this.modeEl = this.root.querySelector(".ship-mode")!;
    this.root.insertBefore(this.shipHud.root, this.modeEl);
    this.shipHud.onStop = () => void this.act("Stop", () => this.actions.stop());
    this.shipHud.onFullSpeed = () => void this.fullSpeed();
    this.selectedWin = new PlayWindow({ id: "selected-item", caption: "Selected Item", left: innerWidth - 300, top: 14, width: 280, height: 116, closable: false });
    this.selectedWin.body.classList.add("si");
    this.selectedEl = this.selectedWin.root;
    this.selectedEl.style.display = "none";
    this.root.insertBefore(this.targetBar.root, this.modeEl);
    this.targetBar.onSelect = (id) => { this.activeTarget = id; this.select(id); };
    this.targetBar.onUnlock = (id) => void this.act("Unlock Target", () => this.actions.unlock(id)).then(() => this.refreshTargets());
    this.layer.appendChild(this.selectedEl);
    this.pollTargets();
    this.feedEl = this.root.querySelector(".feed-status")!;
    this.toastEl = this.root.querySelector(".toast")!;

    this.scene.background = new THREE.Color(0x020305);
    this.starfieldObj = this.starfield();
    this.scene.add(this.starfieldObj);
    this.scene.add(new THREE.AmbientLight(0x334455, 0.6));
    // The system's star lights the grid from where it is (aimed each frame at the sun ball, frame()).
    this.sunLight.position.set(-1, 0.4, 0.6);
    this.scene.add(this.sunLight);
    this.scene.add(this.warpTunnel.object, this.turretFx.group);
    live.fxListeners.add(this.hearFx);
    this.camera.position.set(-600, 250, 900);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 1e6;
    this.controls.zoomSpeed = 1.2;
    this.overview = new Overview({ select: (id) => this.select(id), approach: (id) => void this.act("Approach", () => this.actions.approach(id)), glyph });
    this.layer.appendChild(this.overview.window.root);
    // The radial menu: held or right-clicked on a bracket, an overview row or an object in space.
    if (!document.getElementById("radial-css")) {
      const style = document.createElement("style");
      style.id = "radial-css";
      style.textContent = RADIAL_CSS;
      document.head.appendChild(style);
    }
    this.layer.appendChild(this.radial.root);
    this.radial.root.style.zIndex = "100000";
    for (const el of [this.selectedEl, this.overview.window.root]) this.raiseOnClick(el);
    const openRadial = (id: number, x: number, y: number, button: number) => this.openRadial(id, x, y, button);
    const rowID = (_x: number, _y: number, e: Event) => Number((e.target as HTMLElement).closest?.("[data-id]")?.getAttribute("data-id")) || null;
    // The directional scanner (Alt+D, V), where the page can make the call.
    void typeNames().then((n) => { this.names = n; });
    if (this.actions.coneScan) {
      const coneScan = this.actions.coneScan.bind(this.actions);
      this.dscan = new DScanWindow({
        scan: (angle, range, [x, y, z]) => coneScan(angle, range, x, y, z),
        direction: () => { const d = this.camera.getWorldDirection(new THREE.Vector3()); return [d.x, d.y, -d.z]; },
        known: (id) => {
          const e = this.snapshot?.entities.find((each) => each.itemID === id) ?? null;
          return { name: e?.name ?? null, distance: e ? this.distanceTo(e) : null };
        },
        typeName: (typeID) => this.names?.types[String(typeID)]?.[0] ?? null,
        groupName: (groupID) => this.names?.groups[String(groupID)]?.[0] ?? null,
      }, this.layer);
      this.layer.appendChild(this.dscan.window.root);
      this.raiseOnClick(this.dscan.window.root);
    }
    addEventListener("keydown", this.onKey);
    this.unhold.push(
      holdToOpen(this.brackets, rowID, openRadial),
      holdToOpen(this.overview.window.body, rowID, openRadial),
      holdToOpen(this.renderer.domElement, (x, y) => this.pickAt(x, y), openRadial),
    );
    // Brackets drawn before the client's tables are here are drawn again with the client's icons.
    void loadBrackets().then(() => { for (const el of this.bracketEls.values()) el.remove(); this.bracketEls.clear(); });
    this.root.appendChild(new Neocom((id) => (this.options.onNeocom ? this.options.onNeocom(id) : this.toast(`${id[0]!.toUpperCase()}${id.slice(1)} is not on the play page yet.`))).root);
    this.renderer.domElement.addEventListener("dblclick", (e) => this.doubleClick(e));
    this.renderer.domElement.addEventListener("click", () => this.select(null));
    addEventListener("resize", () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  dispose(): void {
    this.stopped = true;
    this.renderer.setAnimationLoop(null);
    this.sceneEnv?.dispose();
    this.bloom?.dispose();
    this.exposure.dispose();
    this.renderer.dispose();
    this.shipHud.dispose();
    this.targetBar.dispose();
    this.warpTunnel.dispose();
    this.live.fxListeners.delete(this.hearFx);
    this.turretFx.dispose();
    for (const off of this.unhold) off();
    // the windows in the shared layer are the view's to take away
    for (const el of [this.selectedEl, this.overview.window.root, this.dscan?.window.root, this.radial.root]) el?.remove();
    removeEventListener("keydown", this.onKey);
    this.radial.close();
    this.root.remove();
  }

  /**
   * The HUD's full-speed button. The client's SetMaxSpeed keeps the ship's heading; there is no set-speed action
   * here yet, so this flies on along the way the ship is going (its velocity, else where its model points).
   * TODO: a real SetSpeed(1.0) once SpaceActions has one.
   */
  private async fullSpeed(): Promise<void> {
    const ego = this.snapshot?.ship;
    if (!ego) return;
    let { x, y, z } = ego.velocity;
    if (Math.hypot(x, y, z) < 0.5) {
      const holder = this.marks.get(ego.itemID);
      if (!holder) return;
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(holder.quaternion);
      [x, y, z] = [f.x, f.y, -f.z]; // three.js back to EVE's handedness
    }
    await this.act("Full speed", () => this.actions.gotoDirection(x, y, z));
  }

  private resize(): void {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.bloom?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private starfield(): THREE.Points {
    const n = 4000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      pos.set([r * Math.cos(t), u, r * Math.sin(t)], i * 3);
      const b = 0.35 + Math.random() * 0.65;
      col.set([b, b * (0.9 + Math.random() * 0.1), b * (0.85 + Math.random() * 0.15)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
    // Far beyond anything on grid; the camera never leaves the ship by more than the zoom allows.
    stars.scale.setScalar(1e12);
    stars.frustumCulled = false;
    stars.renderOrder = -1;
    return stars;
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    clearTimeout((this.toastEl as unknown as { t?: number }).t);
    (this.toastEl as unknown as { t?: number }).t = window.setTimeout(() => this.toastEl.classList.remove("show"), 2600);
  }

  private async act(what: string, fn: () => Promise<void>): Promise<void> {
    // A refusal in the words the app gives it (bridge/refusals.ts), as the client puts its own up.
    // One the client has already said in its own way (a dialog) is not said again.
    try { await fn(); } catch (e) { if (!(e as { said?: boolean }).said) this.toast(panelErrorWords(e)); }
  }

  /** The client's double click in space: fly the way the camera looks through the cursor. */
  private doubleClick(e: MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const d = ray.ray.direction;
    void this.act("Move", () => this.actions.gotoDirection(d.x, d.y, -d.z));
  }

  private select(itemID: number | null): void {
    this.selected = itemID;
    for (const [id, el] of this.bracketEls) el.classList.toggle("selected", id === itemID);
    this.overview.setSelected(itemID);
    this.renderSelected();
  }

/**
   * The Selected Item window's actions in the client's order (inflight/selectedItemWnd.py GetActions,
   * selectedItemConst.ACTIONS_ALWAYS_VISIBLE read from the compiled module: the decompiled source prints its places):
   * Approach, or Align To for a thing far enough to warp to; Warp To Within; the thing's own (Dock for a station,
   * Jump for a stargate); then always Orbit, Keep at Range, Lock or Unlock, Look At and Show Info. Set as Camera
   * Interest is not drawn yet.
   */
  private actionsFor(e: Entity): { key: string; title: string; icon: string; run: () => Promise<void> }[] {
    const id = e.itemID;
    const icon = (name: string) => clientTexture(`res:/UI/Texture/eveicon/control_icons/${name}_32px.png`);
    const far = this.distanceTo(e) >= 150_000;
    const out = [
      far
        ? { key: "align", title: "Align To", icon: icon("align_to"), run: () => this.actions.alignTo(id) }
        : { key: "approach", title: "Approach", icon: icon("approach"), run: () => this.actions.approach(id) },
      { key: "warp", title: "Warp To Within 0 m", icon: icon("warp_to"), run: () => this.actions.warpTo(id) },
    ];
    if (e.kind === "station" || e.kind === "structure") out.push({ key: "dock", title: "Dock", icon: icon("dock"), run: () => this.actions.dock(id) });
    if (e.kind === "stargate") out.push({ key: "jump", title: "Jump", icon: icon("jump_to"), run: () => this.actions.jump(id) });
    out.push(
      { key: "orbit", title: "Orbit", icon: icon("orbit"), run: () => this.actions.orbit(id) },
      { key: "keep", title: "Keep at Range", icon: icon("keep_at_distance"), run: () => this.actions.keepAtRange(id) },
    );
    const lockable = ["ship", "drone", "fighter", "wreck", "container", "asteroid", "structure", "station", "stargate"].includes(e.kind);
    if (lockable) {
      out.push(this.locked.has(id)
        ? { key: "unlock", title: "Unlock Target", icon: icon("target"), run: () => this.actions.unlock(id) }
        : { key: "lock", title: "Lock Target", icon: icon("target"), run: () => this.lockTracked(id) });
    }
    out.push({ key: "look", title: "Look At", icon: icon("look_at"), run: async () => { this.lookAt = id; } });
    const showInfo = this.options.showInfo;
    if (showInfo) out.push({ key: "info", title: "Show Info", icon: icon("show_info"), run: async () => showInfo(id, e.typeID ?? null) });
    return out;
  }

  private renderSelected(): void {
    const e = this.snapshot?.entities.find((x) => x.itemID === this.selected) ?? null;
    if (!e || e.isSelf) { this.selectedEl.style.display = "none"; return; }
    this.selectedEl.style.display = "";
    const body = this.selectedWin.body;
    const dist = this.distanceTo(e);
    const sig = `${e.itemID}:${this.locked.has(e.itemID)}:${dist >= 150_000}`;
    if (body.getAttribute("data-sig") !== sig) {
      body.setAttribute("data-sig", sig);
      body.innerHTML = `<div class="si-name"></div><div class="si-dist"></div><div class="si-actions"></div>`;
      body.querySelector(".si-name")!.textContent = this.nameOf(e);
      const row = body.querySelector(".si-actions")!;
      for (const a of this.actionsFor(e)) {
        const b = document.createElement("button");
        b.className = `si-act${a.key === "unlock" ? " on" : ""}`;
        b.title = a.title;
        b.innerHTML = `<img src="${a.icon}" alt="">`;
        b.addEventListener("click", () => void this.act(a.title, a.run).then(() => this.refreshTargets()));
        row.appendChild(b);
      }
    }
    body.querySelector(".si-dist")!.textContent = distanceWords(dist);
  }

  private lookAt: number | null = null;
  private framedLook: number | null = null;
  private framedFor: number | null = null;

  /**
   * The client's ship orbit camera limits (shipOrbitCamera.py, cameraUtil.py): no nearer than GetBallMaxZoom, (radius
   * + near clip) * 1.5 (* an aspect-ratio factor, taken as 1) + 2; no further than its minZoom, 800 km; and on first
   * looking at the ship, GetInitialLookAtDistance: the root of a * x^2 + b * x + c, a = 1 / 800000^0.95,
   * b = FOV_MIN / 2 (0.55 / 2), c = -max(radius, nearest).
   */
  /**
   * The client's undock camera (ui/camera/undockCamera.py, with its dynamic camera movement on): the eye on the ship's
   * way out, twice its radius ahead, looking back at it as it comes out of the station; then over 30 s it swings a
   * sixth of a turn round and a tenth of a half turn further down, and draws back (zoom 0.48 to 0.65 over the first
   * 24 s), until the pilot takes the camera or it is done.
   */
  private undockCam: { start: number; spherical: THREE.Spherical } | null = null;
  private startUndockCamera(ego: { velocity: { x: number; y: number; z: number }; radius: number }): void {
    const v = new THREE.Vector3(ego.velocity.x, ego.velocity.y, -ego.velocity.z);
    if (v.lengthSq() < 1e-6) return;
    const eye = v.normalize().multiplyScalar(2 * Math.max(ego.radius, 10));
    const spherical = new THREE.Spherical().setFromVector3(eye);
    spherical.phi = Math.min(Math.PI - 0.01, spherical.phi + Math.PI / 40);
    this.undockCam = { start: performance.now(), spherical };
    this.controls.addEventListener("start", () => { this.undockCam = null; });
  }
  private stepUndockCamera(): void {
    const cam = this.undockCam;
    if (!cam) return;
    const t = (performance.now() - cam.start) / 30000;
    if (t >= 1) { this.undockCam = null; return; }
    const s = cam.spherical;
    const now = new THREE.Spherical(
      s.radius * (1 + (0.65 / 0.48 - 1) * Math.min(1, t / 0.8)),
      Math.min(Math.PI - 0.01, s.phi + (Math.PI / 10) * t),
      s.theta + (Math.PI / 3) * t,
    );
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(now));
  }

  private frameShip(radius: number): void {
    // the farthest the camera goes: 800 km, or ten times what it looks at where that is larger (a planet looked at)
    const farthest = Math.max(800000, radius * 10);
    const nearest = (radius + this.camera.near) * 1.5 + 2;
    const a = 1 / farthest ** 0.95, b = 0.55 / 2, c = -Math.max(radius, nearest);
    const d = Math.sqrt(b * b - 4 * a * c);
    const initial = Math.max(-2 * c / (b + d), -2 * c / (b - d));
    this.controls.minDistance = nearest;
    this.controls.maxDistance = farthest;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.lengthSq() === 0) dir.set(-0.5, 0.25, 0.83).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, initial);
  }

  private async refreshTargets(): Promise<void> {
    try {
      const t = await this.actions.targets();
      this.locked = new Set(t.targetIDs);
      this.targeters = new Set(t.targeterIDs);
      for (const [id, el] of this.bracketEls) { el.classList.toggle("locked", this.locked.has(id)); el.classList.toggle("targeting-me", this.targeters.has(id)); }
      this.renderSelected();
    } catch { /* the next poll tries again */ }
  }

  /** The client is told of locks as they happen; the BFF keeps them and the page reads them once a second. */
  private pollTargets(): void {
    const tick = () => { if (this.stopped) return; void this.refreshTargets().finally(() => setTimeout(tick, 1000)); };
    tick();
  }

  /**
   * Damage numbers floating up as the client's damage notifications come (the damage log's entries): over the target
   * for a shot of ours, over our own ship for one at us, rising and fading in a second and a half.
   */
  private readonly damageNumbers: { el: HTMLDivElement; itemID: number; bornAt: number }[] = [];
  showDamage(entry: { direction: "dealt" | "taken"; otherPartyID: number | null; amount: number; weaponTypeID?: number | null; quality?: number | null; routing?: DamageRouting }): void {
    // the shot's hit or miss to the turret that fired it, as the client routes the message (turretFx.damageMessage)
    const own = this.snapshot?.ship?.itemID ?? null;
    if (own !== null && entry.routing) this.turretFx.damageMessage(own, entry.routing, entry.weaponTypeID ?? null, entry.quality ?? null);
    const itemID = entry.direction === "dealt" ? entry.otherPartyID : this.snapshot?.ship?.itemID ?? null;
    if (itemID === null) return;
    const el = document.createElement("div");
    el.className = `dmg-num ${entry.direction}`;
    el.textContent = entry.amount > 0 ? String(Math.round(entry.amount)) : "miss";
    this.brackets.appendChild(el);
    this.damageNumbers.push({ el, itemID, bornAt: performance.now() });
    if (this.damageNumbers.length > 40) this.damageNumbers.shift()!.el.remove();
  }
  /**
   * The balls' impact overlays (impactOverlay.ts): each one's damage state from the park's (michelle's, extrapolated:
   * spaceObject._OnDamageState, a missing value nought; none before the first), then its frame - its holes' debris sent
   * with the ball's velocity, the count by its diameter on the screen in pixels (the client's render priority).
   */
  private stepImpacts(dt: number): void {
    // the defensive modules' repeats (ImpactEffect.Repeat: on again for the cycle), and their end (Stop: off)
    const now = performance.now();
    for (const [key, a] of this.impactAnimations) {
      const impact = this.marks.get(a.ship)?.userData.impact as ImpactOverlay | undefined;
      if (now >= a.until) { impact?.setImpactAnimation(a.name, false, a.cycle / 1000); this.impactAnimations.delete(key); continue; }
      if (now >= a.next) { a.next += a.cycle; impact?.setImpactAnimation(a.name, true, a.cycle / 1000); }
    }
    const byID = new Map((this.snapshot?.entities ?? []).map((e) => [e.itemID, e as Entity & { shieldRatio?: number | null; armorRatio?: number | null; hullRatio?: number | null }]));
    const pixelsPerRadian = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const camAt = this.camera.getWorldPosition(new THREE.Vector3());
    for (const [id, mark] of this.marks) {
      const impact = mark.userData.impact as ImpactOverlay | undefined;
      const e = byID.get(id);
      if (!impact || !e) continue;
      if (e.shieldRatio != null || e.armorRatio != null || e.hullRatio != null) impact.setDamageState(e.shieldRatio ?? 0, e.armorRatio ?? 0, e.hullRatio ?? 0);
      const distance = Math.max(1, mark.getWorldPosition(new THREE.Vector3()).distanceTo(camAt));
      impact.update(dt, this.scene, new THREE.Vector3(e.velocity.x, e.velocity.y, -e.velocity.z), (2 * e.radius * pixelsPerRadian) / distance);
      // the lights' flicker below 90 % hull
      setActivationStrength(mark, impact.activationStrength(performance.now() / 1000));
    }
  }
  /** Where a thing is drawn now, or was a moment ago before it went (blown up, out of the park). */
  private placeOf(id: number, origin: { x: number; y: number; z: number }): THREE.Vector3 | null {
    const mark = this.marks.get(id);
    if (mark) return mark.position;
    const g = this.gone.get(id);
    return g ? new THREE.Vector3(g.x - origin.x, g.y - origin.y, g.z + origin.z) : null;
  }
  private lastOrigin = { x: 0, y: 0, z: 0 };
  private readonly gone = new Map<number, { x: number; y: number; z: number; radius: number | null; at: number }>();
  private stepDamageNumbers(now: number): void {
    const w = innerWidth, h = innerHeight;
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const d = this.damageNumbers[i]!;
      const t = (now - d.bornAt) / 1500;
      const mark = this.marks.get(d.itemID);
      if (t > 1 || !mark) { d.el.remove(); this.damageNumbers.splice(i, 1); continue; }
      const p = mark.position.clone().project(this.camera);
      if (p.z >= 1) { d.el.style.display = "none"; continue; }
      d.el.style.display = "";
      d.el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h - 24 - t * 40}px)`;
      d.el.style.opacity = String(1 - t * t);
    }
  }

  /** The client's keys for the scanner (eveCommands: OpenDirectionalScanner Alt+D, CmdRefreshDirectionalScan V). */
  private key(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!this.dscan) return;
    if (e.altKey && !e.ctrlKey && e.code === "KeyD") { e.preventDefault(); this.dscan.toggle(); }
    else if (!e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyV") { e.preventDefault(); this.dscan.open(); void this.dscan.scan(); }
  }

  /** The object in space under a point of the screen: the nearest mark the ray from the camera meets. */
  private pickAt(x: number, y: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), this.camera);
    const owner = new Map<THREE.Object3D, number>();
    for (const [id, m] of this.marks) owner.set(m, id);
    for (const hit of ray.intersectObjects([...this.marks.values()], true)) {
      if ((hit.object as THREE.Mesh).isMesh !== true || hit.object.name === "warpTunnel") continue;
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) { const id = owner.get(o); if (id !== undefined) return id; }
    }
    return null;
  }

  /**
   * An object's radial menu, laid out as spaceRadialMenuFunctions.GetObjectsActions lays it: the type's primary action
   * at the top, then orbit, more, keep at range, lock, approach, show info and warp to, clockwise; for the pilot's own
   * ship, stop, the default orbit, more, the default keep at range, its cargo hold, show info and the default warp.
   */
  private openRadial(id: number, x: number, y: number, button: number): void {
    const e = this.snapshot?.entities.find((each) => each.itemID === id) ?? null;
    if (!e) return;
    this.select(e.isSelf ? this.selected : id);
    const icon = (n: number) => RADIAL_ICON(`res:/UI/Texture/Icons/44_32_${n}.png`);
    const run = (title: string, fn: () => Promise<void>) => () => void this.act(title, fn).then(() => this.refreshTargets());
    const showInfo: RadialOption = this.options.showInfo
      ? { label: "Show Info", icon: icon(24), run: () => this.options.showInfo!(id, e.typeID ?? null) }
      : { label: "Show Info", icon: icon(24), disabled: true };
    const lookAt: RadialOption = { label: "Look At", icon: icon(20), run: () => { this.lookAt = id; } };
    let options: (RadialOption | null)[];
    if (e.isSelf) {
      options = [
        { label: "Stop Ship", icon: clientTexture("res:/UI/Texture/Icons/44_32_38.png"), run: run("Stop", () => this.actions.stop()) },
        { label: "Set Default Orbit Distance", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/setOrbitDefault.png"), disabled: true },
        { label: "More", icon: "", more: [lookAt] },
        { label: "Set Default Keep at Range Distance", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/setKeepRangeDefault.png"), disabled: true },
        { label: "Open Cargo Hold", icon: icon(35), run: () => this.options.onNeocom?.("inventory") },
        null,
        showInfo,
        { label: "Set Default Warp To Distance", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/setWarpDefault.png"), disabled: true },
      ];
    } else {
      const dist = this.distanceTo(e);
      const primary: RadialOption | null =
        e.kind === "station" || e.kind === "structure" ? { label: "Dock", icon: icon(9), run: run("Dock", () => this.actions.dock(id)) }
        : e.kind === "stargate" ? { label: "Jump", icon: icon(39), run: run("Jump", () => this.actions.jump(id)) }
        // spaceRadialMenuFunctions: a wreck's and a can's first action is Open Cargo (44_32_35)
        : (e.kind === "wreck" || e.kind === "container") && this.actions.openCargo
          ? { label: "Open Cargo", icon: icon(35), run: run("Open Cargo", () => this.actions.openCargo!(id)) }
        : null;
      const lockable = ["ship", "drone", "fighter", "wreck", "container", "asteroid", "structure", "station", "stargate"].includes(e.kind);
      const lock: RadialOption = this.locked.has(id)
        ? { label: "Unlock Target", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/untarget.png"), run: run("Unlock Target", () => this.actions.unlock(id)) }
        : { label: "Lock Target", icon: icon(17), disabled: !lockable, run: run("Lock Target", () => this.lockTracked(id)) };
      options = [
        primary,
        { label: "Orbit", icon: icon(21), ranges: radialRanges(500, 30000), defaultRange: 1000, run: (r) => run("Orbit", () => this.actions.orbit(id, r))() },
        { label: "More", icon: "", more: [lookAt] },
        { label: "Keep at Range", icon: icon(22), ranges: radialRanges(500, 30000), defaultRange: 1000, run: (r) => run("Keep at Range", () => this.actions.keepAtRange(id, r))() },
        lock,
        { label: "Approach", icon: icon(23), run: run("Approach", () => this.actions.approach(id)) },
        showInfo,
        // A warp needs the object 150 km away or more (the server refuses a nearer one).
        { label: "Warp To Within", icon: icon(18), ranges: WARP_RANGES, defaultRange: 0, disabled: dist < 150_000, run: (r) => run("Warp To", () => this.actions.warpTo(id, r))() },
      ];
    }
    this.radial.open(x, y, this.nameOf(e), options, button);
  }

  private distanceTo(e: Entity): number {
    const s = this.snapshot?.ship;
    if (!s) return 0;
    return Math.max(0, Math.hypot(e.position.x - s.position.x, e.position.y - s.position.y, e.position.z - s.position.z) - e.radius - s.radius);
  }

  private sceneFor: number | null = null;
  /** The system's reflection cube, filtered (loadScene). */
  private sceneEnv: THREE.Texture | null = null;

  /**
   * The system's space scene, as the client draws it: its region's nebula cube map as the background, and the
   * nebula's reflection map for what the hulls reflect (sceneManager.GetResPathForLocation, EveSpaceScene's
   * NebulaMap and envMap1ResPath). The cube maps are EVE's, looked up in a world mirrored in z, and three
   * flips x when it samples a cube texture: together a half turn about y.
   */
  private async loadScene(solarSystemID: number): Promise<void> {
    this.sceneFor = solarSystemID;
    const info = await (await fetch(`/client-assets/scene/${solarSystemID}`)).json() as { name?: string; security?: number; maps?: Record<string, string> | null };
    if (this.sceneFor !== solarSystemID) return;
    if (info.name) {
      this.root.querySelector(".hud-top-left .system")!.innerHTML = `${info.name}<span class="sec">${typeof info.security === "number" ? info.security.toFixed(1) : ""}</span>`;
    }
    const halfTurn = new THREE.Euler(0, Math.PI, 0);
    if (info.maps?.nebula) {
      const nebula = await loadDds(info.maps.nebula);
      if (this.sceneFor !== solarSystemID) return;
      this.scene.background = nebula;
      this.scene.backgroundRotation.copy(halfTurn);
      this.scene.backgroundIntensity = 1.25; // EveSpaceScene.nebulaIntensity
      this.starfieldObj.visible = false;
    }
    if (info.maps?.reflection) {
      const refl = await loadDds(info.maps.reflection);
      if (this.sceneFor !== solarSystemID) return;
      // filtered for rough surfaces here, once (PMREM), not left to three's first draw of a standard material (which
      // converts it in the middle of that draw: hangarView.ts setScene); the planets read the cube itself
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.sceneEnv?.dispose();
      this.sceneEnv = pmrem.fromCubemap(refl as unknown as THREE.CubeTexture).texture;
      pmrem.dispose();
      this.scene.environment = this.sceneEnv;
      setPlanetEnvironment(refl);
      this.scene.environmentRotation.copy(halfTurn);
      this.scene.environmentIntensity = 1.55; // EveSpaceScene.reflectionIntensity
    }
  }

  private frame(): void {
    if (this.stopped) return;
    this.frameCount++;
    const systemID = this.live.hello?.solarSystemID ?? null;
    if (systemID && systemID !== this.sceneFor) void this.loadScene(systemID);
    this.live.frame();
    const park = this.live.park;
    let snap: Snapshot | null = null;
    if (park.validState) {
      snap = projectSpace(park, { solarSystemID: null, shipID: this.live.hello?.shipID ?? null, simTime: this.live.simNow() }) as unknown as Snapshot;
    }
    this.snapshot = snap;
    const ego = snap?.ship ?? null;
    // the ship's place is the scene's origin; with no ship (blown up, the capsule not yet in the park) the last one stays
    const origin = ego ? ego.position : this.lastOrigin;
    // the world moved under the GPU particles (they live in our space, which follows the ship): by the origin's move,
    // mirrored into three's handedness
    const moved = new THREE.Vector3(-(origin.x - this.lastOrigin.x), -(origin.y - this.lastOrigin.y), origin.z - this.lastOrigin.z);
    if (moved.lengthSq() > 0) shiftGpuParticles(this.scene, moved);
    this.lastOrigin = { x: origin.x, y: origin.y, z: origin.z };
    const seen = new Set<number>();
    const tmp = new THREE.Vector3();
    const w = innerWidth, h = innerHeight;
    for (const e of snap?.entities ?? []) {
      seen.add(e.itemID);
      // relative to the ship, in doubles, then mirrored into three's handedness
      const rel = tmp.set(e.position.x - origin.x, e.position.y - origin.y, -(e.position.z - origin.z));
      let mark = this.marks.get(e.itemID);
      if (!mark) { mark = this.markFor(e); this.marks.set(e.itemID, mark); this.scene.add(mark); }
      mark.position.copy(rel);
      this.orient(mark, e);
      if (e.maxVelocity) setThrust(mark, Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z) / e.maxVelocity);
      setShipSpeed(mark, Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z), e.maxVelocity ?? 0);
      // the ship's warp (ship.py: EnterWarp / ExitWarp set IsWarping; on load, a ball in warp mode)
      setControllerVariable(mark, "IsWarping", e.mode === "WARP" ? 1 : 0);
      if (e.kind === "sun") this.sunLight.position.copy(rel).normalize();
      if (e.isSelf) continue;
      let el = this.bracketEls.get(e.itemID);
      if (!el) {
        el = document.createElement("div");
        el.className = "bracket";
        el.innerHTML = `${glyph(e)}<div class="label"></div>`;
        const id = e.itemID;
        el.dataset.id = String(id);
        el.addEventListener("click", (ev) => { ev.stopPropagation(); this.select(id); });
        el.addEventListener("dblclick", (ev) => { ev.stopPropagation(); void this.act("Approach", () => this.actions.approach(id)); });
        el.classList.toggle("locked", this.locked.has(id));
        el.classList.toggle("targeting-me", this.targeters.has(id));
        this.brackets.appendChild(el);
        this.bracketEls.set(e.itemID, el);
      }
      const p = rel.clone().project(this.camera);
      const onScreen = p.z < 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05;
      el.style.display = onScreen ? "" : "none";
      if (onScreen) {
        el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px)`;
        if (this.frameCount % 10 === 0 || el.classList.contains("selected")) {
          (el.querySelector(".label") as HTMLElement).textContent = `${this.nameOf(e)} - ${distanceWords(this.distanceTo(e))}`;
        }
      }
    }
    for (const [id, el] of this.bracketEls) if (!seen.has(id)) { el.remove(); this.bracketEls.delete(id); }
    if (snap) this.overview.update(snap.entities, (x) => this.distanceTo(x));
    if (ego && this.framedFor !== ego.itemID) {
      this.framedFor = ego.itemID;
      this.frameShip(ego.radius);
      if (this.options.undocking?.()) this.startUndockCamera(ego);
    }
    this.stepUndockCamera();
    // Look At (the client's camera lookAt): the camera turns about the thing looked at, and follows it, until it
    // is gone or the pilot's own ship is looked at again; the camera keeps its offset as the point moves.
    const looked = this.lookAt === null ? null : this.marks.get(this.lookAt) ?? null;
    if (this.lookAt !== null && !looked) this.lookAt = null;
    const want = looked ? looked.position : new THREE.Vector3();
    const shift = want.clone().sub(this.controls.target);
    if (shift.lengthSq() > 0) { this.camera.position.add(shift); this.controls.target.copy(want); }
    // a new thing looked at is framed for its size as the ship is (a planet from outside it, not from the ship's
    // offset at its centre); looking back at the ship frames the ship again
    if (this.lookAt !== this.framedLook) {
      this.framedLook = this.lookAt;
      const size = this.lookAt !== null ? snap?.entities.find((e) => e.itemID === this.lookAt)?.radius ?? null : ego?.radius ?? null;
      if (size !== null) this.frameShip(size);
    }
    for (const [id, m] of this.marks) if (!seen.has(id)) {
      // where it went from, for a moment, in the system's own frame (an explosion is drawn where a ball was)
      this.gone.set(id, { x: m.position.x + origin.x, y: m.position.y + origin.y, z: m.position.z - origin.z, radius: m.userData.radius ?? null, at: performance.now() });
      this.scene.remove(m); this.marks.delete(id);
    }
    for (const [id, g] of this.gone) if (performance.now() - g.at > 5000) this.gone.delete(id);

    if (ego) {
      const speed = Math.hypot(ego.velocity.x, ego.velocity.y, ego.velocity.z);
      this.shipHud.update({
        shieldRatio: ego.shieldRatio ?? null, armorRatio: ego.armorRatio ?? null, hullRatio: ego.hullRatio ?? null,
        // The capacitor from the app's session where there is one (its fitting's capacitor total, the space read's
        // ratio); a ship's own capacitor is not in the park's slim item.
        capacitorRatio: this.options.rack?.capacitor?.().ratio ?? ego.capacitorRatio ?? null,
        capacitorMax: this.options.rack?.capacitor?.().max ?? null,
        speed, maxSpeed: ego.maxVelocity ?? null, warping: ego.mode === "WARP",
      });
      this.modeEl.textContent = ego.mode === "STOP" && speed < 1 ? "Stopped" : ego.mode === "WARP" ? "Warping" : ego.mode === "ORBIT" ? "Orbiting" : ego.mode === "FOLLOW" ? "Approaching" : speed > 0.5 ? "Moving" : "";
    }
    // The warp tunnel, along the ship's way (mirrored into three's handedness as positions are), as strong as the
    // client's binding of the ship's speed makes it.
    const now = performance.now(), dt = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    const egoSpeed = ego ? Math.hypot(ego.velocity.x, ego.velocity.y, ego.velocity.z) : 0;
    const way = ego && egoSpeed > 0 ? new THREE.Vector3(ego.velocity.x, ego.velocity.y, -ego.velocity.z).divideScalar(egoSpeed) : new THREE.Vector3();
    // The jump: a new park in another system is the arrival.
    // the system the view is in, once the feed has said (the view can be made before its first hello)
    if (this.seenSystem === null && this.live.resets === this.seenResets) this.seenSystem = this.live.hello?.solarSystemID ?? null;
    if (this.live.resets !== this.seenResets) {
      this.seenResets = this.live.resets;
      const system = this.live.hello?.solarSystemID ?? null;
      if (system !== null && this.seenSystem !== null && system !== this.seenSystem) this.jumpArrivedAt = now;
      if (system !== null) this.seenSystem = system;
    }
    let share = WarpTunnel.share(ego?.mode === "WARP", egoSpeed);
    let tunnelWay = way;
    let flash = 0;
    if (this.jumpOrderedAt !== null) {
      const since = now - this.jumpOrderedAt;
      const after = this.jumpArrivedAt === null ? null : now - this.jumpArrivedAt;
      // building over 1.5 s until the arrival; easing out over 2 s after it; given up after 20 s without one
      const strength = after === null ? Math.min(1, since / 1500) : Math.max(0, 1 - after / 2000);
      flash = after === null ? 0 : Math.max(0, 0.85 - after / 700);
      if ((after !== null && after > 2000) || (after === null && since > 20_000)) { this.jumpOrderedAt = null; this.jumpArrivedAt = null; }
      share = Math.max(share, strength);
    }
    // a ship that is not moving (at a gate, or come out of one) has no way of its own: the camera's, so the tunnel eases out
    if (way.lengthSq() < 0.5) tunnelWay = this.camera.getWorldDirection(new THREE.Vector3());
    this.flashEl.style.opacity = flash.toFixed(3);
    this.warpTunnel.update(this.camera, this.controls.target, tunnelWay, share, dt);
    this.turretFx.setResolution(innerWidth, innerHeight);
    this.turretFx.onShot = this.onShot;
    this.turretFx.update((id) => this.placeOf(id, origin), now, (id) => this.snapshot?.entities.find((e) => e.itemID === id)?.radius ?? this.gone.get(id)?.radius ?? null);
    this.stepImpacts(dt);
    this.stepDamageNumbers(now);
    // The rack: the ship's fitted modules, which are running and how far through their cycles, as the app's session
    // keeps them; often enough for the cycle sweep to move smoothly.
    const rack = this.options.rack;
    if (rack && this.frameCount % 3 === 0) this.shipHud.setModules(rack.modules(), (m) => void this.act(m.name ?? "Module", () => rack.use(m)));
    if (this.frameCount % 15 === 0) {
      this.renderSelected();
      this.feedEl.textContent = `${this.live.status} · tick ${park.currentTime % 100000} · ${snap?.entities.length ?? 0} on grid · ${this.live.items} updates${this.live.failures.length ? ` · ${this.live.failures.length} failed` : ""}`;
    }
    this.updateTargetBar();
    this.controls.update();
    this.bloom ??= bloomFor(this.renderer, this.scene, this.camera, { exposure: () => this.exposure, toneMap: 0 });
    this.bloom.render();
  }

  /** A lock, shown as locking (on its bracket) until the call returns: the server answers AddTarget once locked. */
  private async lockTracked(id: number): Promise<void> {
    this.lockingIDs.set(id, performance.now());
    try { await this.actions.lock(id); } finally { this.lockingIDs.delete(id); }
  }

  /** The target bar from the locked set, in lock order; a target being locked gets its indicator on its bracket. */
  private updateTargetBar(): void {
    const byID = new Map((this.snapshot?.entities ?? []).map((e) => [e.itemID, e]));
    if (this.activeTarget !== null && !this.locked.has(this.activeTarget)) this.activeTarget = null;
    const entries: TargetBarEntry[] = [];
    for (const id of this.locked) {
      const e = byID.get(id) as (Entity & { shieldRatio?: number | null; armorRatio?: number | null; hullRatio?: number | null }) | undefined;
      if (!e) continue;
      // targetMgr.OnTargetAdded: with no active target, the new one becomes it
      if (this.activeTarget === null) this.activeTarget = id;
      entries.push({
        itemID: id, typeID: e.typeID, name: e.name, distance: this.distanceTo(e),
        shieldRatio: e.shieldRatio ?? null, armorRatio: e.armorRatio ?? null, hullRatio: e.hullRatio ?? null,
        locking: false, active: id === this.activeTarget,
      });
    }
    for (const [id, startedAt] of this.lockingIDs) {
      if (this.locked.has(id)) continue;
      const e = byID.get(id);
      entries.push({
        itemID: id, typeID: e?.typeID ?? null, name: e?.name ?? null, distance: e ? this.distanceTo(e) : 0,
        shieldRatio: null, armorRatio: null, hullRatio: null, locking: true, active: false,
        lockTimeMs: null, // TODO: the lock time (bracket.GetScanSpeed) for the countdown
        lockStartedAt: startedAt,
      });
    }
    const win = this.selectedWin.root.style;
    this.targetBar.setAnchor({ left: parseFloat(win.left) || innerWidth - 300, top: parseFloat(win.top) || 14, width: parseFloat(win.width) || 280 });
    this.targetBar.update(entries);
    for (const id of this.lockingIDs.keys()) {
      const el = this.bracketEls.get(id), ind = this.targetBar.lockingIndicator(id);
      if (el && ind && ind.parentElement !== el) el.appendChild(ind);
    }
  }

  /**
   * A ball's holder in the scene: a stand-in at once, the type's own model from the client when it has come
   * (hullModel.ts). An EVE hull's nose is +z in its own space, so -z once mirrored: the model is turned half
   * round inside the holder, and the holder's +z is pointed where the ship is going (orient).
   */
  private markFor(e: Entity): THREE.Object3D {
    const holder = new THREE.Group();
    const big = ["station", "planet", "moon", "sun", "stargate", "structure"].includes(e.kind);
    const colour = e.kind === "sun" ? 0xffd27a : e.kind === "planet" || e.kind === "moon" ? 0x5d6f80 : big ? 0x7d8a94 : 0x6f7a82;
    const standIn = new THREE.Mesh(new THREE.SphereGeometry(Math.max(Math.min(e.radius, big ? e.radius : 60), 5), big ? 48 : 12, big ? 32 : 8),
      e.kind === "sun" ? new THREE.MeshBasicMaterial({ color: colour }) : new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9, transparent: !e.isSelf && !["planet", "moon", "sun"].includes(e.kind), opacity: 0.35 }));
    holder.add(standIn);
    holder.userData = { kind: e.kind, radius: e.radius };
    if (["planet", "moon", "sun"].includes(e.kind) && e.typeID) {
      // Each planet and moon from its own preset and height maps (the system's celestials), as the client draws it.
      const systemID = this.live.hello?.solarSystemID ?? null;
      const typeID = e.typeID;
      void (systemID ? systemCelestials(systemID) : Promise.resolve({} as Record<string, CelestialItem>))
        .then((items) => celestialModel(typeID, e.kind, e.radius, items[String(e.itemID)] ?? null, e.itemID)).then((model) => {
        if (!model || !this.marks.has(e.itemID)) return;
        holder.remove(standIn);
        holder.add(model);
      }).catch(() => { /* the stand-in stays */ });
    }
    const modelled = !["planet", "moon", "sun", "asteroid", "celestial", "billboard"].includes(e.kind);
    if (modelled && e.typeID) {
      void typeModel(e.typeID).then((model) => {
        if (!model || !this.marks.has(e.itemID)) return;
        model.rotation.y = Math.PI;
        holder.remove(standIn);
        holder.add(model);
        holder.userData.impact = impactOverlayOf(model);
      }).catch(() => { /* no model: the stand-in stays */ });
    }
    return holder;
  }

  /** Point a moving ship's holder along its velocity, easing the turn as the client's ball does not jump. */
  private orient(holder: THREE.Object3D, e: Entity): void {
    if (!["ship", "drone", "fighter"].includes(e.kind)) return;
    const v = new THREE.Vector3(e.velocity.x, e.velocity.y, -e.velocity.z);
    if (v.lengthSq() < 1) return;
    const want = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), v.normalize());
    holder.quaternion.slerp(want, 0.12);
  }
}
