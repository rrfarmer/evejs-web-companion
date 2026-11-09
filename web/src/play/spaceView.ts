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
import { typeModel, setThrust } from "../three/hullModel.ts";
import { celestialModel, systemCelestials, type CelestialItem } from "../three/celestialModel.ts";
import { ShipHud, type HudModule } from "./shipHud.ts";
import { WarpTunnel } from "./warpTunnel.ts";
import { TargetBar, type TargetBarEntry } from "./targetBar.ts";
import { loadDds } from "../three/ddsTexture.ts";
import { Overview } from "./overview.ts";
import { Neocom } from "./neocom.ts";
import { bracketIcon, loadBrackets } from "./brackets.ts";
import { panelErrorWords } from "../bridge/refusals.ts";
import { PlayWindow, clientTexture } from "./window.ts";

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

export interface SpaceActions {
  gotoDirection(dx: number, dy: number, dz: number): Promise<void>;
  alignTo(itemID: number): Promise<void>;
  keepAtRange(itemID: number): Promise<void>;
  jump(itemID: number): Promise<void>;
  lock(itemID: number): Promise<void>;
  unlock(itemID: number): Promise<void>;
  /** What is locked, and what has the pilot locked: the BFF's read (GET /api/bridge/targets). */
  targets(): Promise<{ targetIDs: number[]; targeterIDs: number[] }>;
  stop(): Promise<void>;
  approach(itemID: number): Promise<void>;
  orbit(itemID: number): Promise<void>;
  warpTo(itemID: number): Promise<void>;
  dock(itemID: number): Promise<void>;
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
  private lastFrameAt = performance.now();

  /** `onNeocom`: what a Neocom button opens; the app's play mode opens its own windows (PlayApp.svelte). */
  constructor(private readonly live: LivePark, private readonly actions: SpaceActions, private readonly where: { system: string; security: number | null }, private readonly options: { onNeocom?: (id: string) => void; rack?: { modules(): HudModule[]; use(m: HudModule): Promise<void>; capacitor?(): { max: number | null; ratio: number | null } } } = {}) {
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
    this.root.appendChild(this.selectedEl);
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
    this.scene.add(this.warpTunnel.object);
    this.camera.position.set(-600, 250, 900);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 1e6;
    this.controls.zoomSpeed = 1.2;
    this.overview = new Overview({ select: (id) => this.select(id), approach: (id) => void this.act("Approach", () => this.actions.approach(id)), glyph });
    this.root.appendChild(this.overview.window.root);
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
    this.renderer.dispose();
    this.shipHud.dispose();
    this.targetBar.dispose();
    this.warpTunnel.dispose();
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
    try { await fn(); } catch (e) { this.toast(panelErrorWords(e)); }
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

/** The Selected Item window's actions, as the client offers them for a thing of each kind, with its own icons. */
  private actionsFor(e: Entity): { key: string; title: string; icon: string; run: () => Promise<void> }[] {
    const id = e.itemID;
    const icon = (name: string) => clientTexture(`res:/UI/Texture/eveicon/control_icons/${name}_32px.png`);
    const out = [
      { key: "approach", title: "Approach", icon: icon("approach"), run: () => this.actions.approach(id) },
      { key: "align", title: "Align To", icon: icon("align_to"), run: () => this.actions.alignTo(id) },
      { key: "warp", title: "Warp To Within 0 m", icon: icon("warp_to"), run: () => this.actions.warpTo(id) },
      { key: "orbit", title: "Orbit", icon: icon("orbit"), run: () => this.actions.orbit(id) },
      { key: "keep", title: "Keep at Range", icon: icon("keep_at_distance"), run: () => this.actions.keepAtRange(id) },
    ];
    if (e.kind === "station" || e.kind === "structure") out.push({ key: "dock", title: "Dock", icon: icon("dock"), run: () => this.actions.dock(id) });
    if (e.kind === "stargate") out.push({ key: "jump", title: "Jump", icon: icon("jump_to"), run: () => this.actions.jump(id) });
    const lockable = ["ship", "drone", "fighter", "wreck", "container", "asteroid", "structure", "station", "stargate"].includes(e.kind);
    if (lockable) {
      out.push(this.locked.has(id)
        ? { key: "unlock", title: "Unlock Target", icon: icon("target"), run: () => this.actions.unlock(id) }
        : { key: "lock", title: "Lock Target", icon: icon("target"), run: () => this.lockTracked(id) });
    }
    out.push({ key: "look", title: "Look At", icon: icon("look_at"), run: async () => { this.lookAt = id; } });
    return out;
  }

  private renderSelected(): void {
    const e = this.snapshot?.entities.find((x) => x.itemID === this.selected) ?? null;
    if (!e || e.isSelf) { this.selectedEl.style.display = "none"; return; }
    this.selectedEl.style.display = "";
    const body = this.selectedWin.body;
    const dist = this.distanceTo(e);
    const sig = `${e.itemID}:${this.locked.has(e.itemID)}`;
    if (body.getAttribute("data-sig") !== sig) {
      body.setAttribute("data-sig", sig);
      body.innerHTML = `<div class="si-name"></div><div class="si-dist"></div><div class="si-actions"></div>`;
      body.querySelector(".si-name")!.textContent = e.name ?? `${e.kind} ${e.itemID}`;
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
  private framedFor: number | null = null;

  /**
   * The client's ship orbit camera limits (shipOrbitCamera.py, cameraUtil.py): no nearer than GetBallMaxZoom, (radius
   * + near clip) * 1.5 (* an aspect-ratio factor, taken as 1) + 2; no further than its minZoom, 800 km; and on first
   * looking at the ship, GetInitialLookAtDistance: the root of a * x^2 + b * x + c, a = 1 / 800000^0.95,
   * b = FOV_MIN / 2 (0.55 / 2), c = -max(radius, nearest).
   */
  private frameShip(radius: number): void {
    const nearest = (radius + this.camera.near) * 1.5 + 2;
    const a = 1 / 800000 ** 0.95, b = 0.55 / 2, c = -Math.max(radius, nearest);
    const d = Math.sqrt(b * b - 4 * a * c);
    const initial = Math.max(-2 * c / (b + d), -2 * c / (b - d));
    this.controls.minDistance = nearest;
    this.controls.maxDistance = 800000;
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

  private distanceTo(e: Entity): number {
    const s = this.snapshot?.ship;
    if (!s) return 0;
    return Math.max(0, Math.hypot(e.position.x - s.position.x, e.position.y - s.position.y, e.position.z - s.position.z) - e.radius - s.radius);
  }

  private sceneFor: number | null = null;

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
      this.scene.environment = refl;
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
    const origin = ego ? ego.position : { x: 0, y: 0, z: 0 };
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
      if (e.kind === "sun") this.sunLight.position.copy(rel).normalize();
      if (e.isSelf) continue;
      let el = this.bracketEls.get(e.itemID);
      if (!el) {
        el = document.createElement("div");
        el.className = "bracket";
        el.innerHTML = `${glyph(e)}<div class="label"></div>`;
        const id = e.itemID;
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
          (el.querySelector(".label") as HTMLElement).textContent = `${e.name ?? e.kind} - ${distanceWords(this.distanceTo(e))}`;
        }
      }
    }
    for (const [id, el] of this.bracketEls) if (!seen.has(id)) { el.remove(); this.bracketEls.delete(id); }
    if (snap) this.overview.update(snap.entities, (x) => this.distanceTo(x));
    if (ego && this.framedFor !== ego.itemID) { this.framedFor = ego.itemID; this.frameShip(ego.radius); }
    // Look At (the client's camera lookAt): the camera turns about the thing looked at, and follows it, until it
    // is gone or the pilot's own ship is looked at again; the camera keeps its offset as the point moves.
    const looked = this.lookAt === null ? null : this.marks.get(this.lookAt) ?? null;
    if (this.lookAt !== null && !looked) this.lookAt = null;
    const want = looked ? looked.position : new THREE.Vector3();
    const shift = want.clone().sub(this.controls.target);
    if (shift.lengthSq() > 0) { this.camera.position.add(shift); this.controls.target.copy(want); }
    for (const [id, m] of this.marks) if (!seen.has(id)) { this.scene.remove(m); this.marks.delete(id); }

    if (ego) {
      const speed = Math.hypot(ego.velocity.x, ego.velocity.y, ego.velocity.z);
      this.shipHud.update({
        shieldRatio: ego.shieldRatio ?? null, armorRatio: ego.armorRatio ?? null, hullRatio: ego.hullRatio ?? null,
        // The capacitor from the app's session where there is one (its fitting's capacitor total, the space read's
        // ratio); a ship's own capacitor is not in the park's slim item.
        capacitorRatio: this.options.rack?.capacitor?.().ratio ?? ego.capacitorRatio ?? null,
        capacitorMax: this.options.rack?.capacitor?.().max ?? null,
        speed, maxSpeed: ego.maxVelocity ?? null,
      });
      this.modeEl.textContent = ego.mode === "STOP" && speed < 1 ? "Stopped" : ego.mode === "WARP" ? "Warping" : ego.mode === "ORBIT" ? "Orbiting" : ego.mode === "FOLLOW" ? "Approaching" : speed > 0.5 ? "Moving" : "";
    }
    // The warp tunnel, along the ship's way (mirrored into three's handedness as positions are), as strong as the
    // client's binding of the ship's speed makes it.
    const now = performance.now(), dt = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    const egoSpeed = ego ? Math.hypot(ego.velocity.x, ego.velocity.y, ego.velocity.z) : 0;
    const way = ego && egoSpeed > 0 ? new THREE.Vector3(ego.velocity.x, ego.velocity.y, -ego.velocity.z).divideScalar(egoSpeed) : new THREE.Vector3();
    this.warpTunnel.update(this.camera, this.controls.target, way, WarpTunnel.share(ego?.mode === "WARP", egoSpeed), dt);
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
    this.renderer.render(this.scene, this.camera);
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
    holder.userData = { kind: e.kind };
    if (["planet", "moon", "sun"].includes(e.kind) && e.typeID) {
      // Each planet and moon from its own preset and height maps (the system's celestials), as the client draws it.
      const systemID = this.live.hello?.solarSystemID ?? null;
      const typeID = e.typeID;
      void (systemID ? systemCelestials(systemID) : Promise.resolve({} as Record<string, CelestialItem>))
        .then((items) => celestialModel(typeID, e.kind, e.radius, items[String(e.itemID)] ?? null)).then((model) => {
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
