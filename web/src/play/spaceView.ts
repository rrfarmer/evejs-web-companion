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
import { typeModel } from "../three/hullModel.ts";

export interface Entity {
  kind: string; itemID: number; typeID: number | null; groupID: number | null; categoryID: number | null; name: string | null;
  radius: number; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number };
  isSelf: boolean; mode?: string | null; maxVelocity?: number | null; isNpc?: boolean; targetEntityID?: number | null;
}
interface Snapshot { entities: Entity[]; ship: (Entity & { maxVelocity: number | null; speedFraction: number | null }) | null }

export interface SpaceActions {
  gotoDirection(dx: number, dy: number, dz: number): Promise<void>;
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
function glyph(e: Entity): string {
  const c = e.isNpc ? "var(--hostile)" : KIND_COLOUR[e.kind] ?? "#c9c9c9";
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
  private readonly speedEl: HTMLDivElement;
  private readonly modeEl: HTMLDivElement;
  private readonly gaugeArc: SVGPathElement;
  private readonly selectedEl: HTMLDivElement;
  private readonly feedEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private selected: number | null = null;
  private snapshot: Snapshot | null = null;
  private frameCount = 0;
  private stopped = false;

  constructor(private readonly live: LivePark, private readonly actions: SpaceActions, private readonly where: { system: string; security: number | null }) {
    this.root.className = "space";
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.root.appendChild(this.renderer.domElement);
    this.brackets.className = "brackets";
    this.root.appendChild(this.brackets);
    this.root.insertAdjacentHTML("beforeend", `
      <div class="neocom"><div class="eve">EVE</div></div>
      <div class="hud-top-left"><div class="system">${where.system}<span class="sec">${where.security === null ? "" : where.security.toFixed(1)}</span></div><div class="sub"></div></div>
      <div class="ship-hud">
        <svg class="gauge" viewBox="0 0 168 168">
          <circle cx="84" cy="84" r="70" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>
          <path class="speed-track" d="M 34.5 133.5 A 70 70 0 1 1 133.5 133.5" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="6"/>
          <path class="speed-arc" d="" fill="none" stroke="#e3b542" stroke-width="6"/>
          <g class="stop" style="cursor:pointer"><circle cx="84" cy="84" r="26" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.3)"/>
          <rect x="76" y="76" width="16" height="16" fill="#d7dad6"/></g>
        </svg>
        <div class="speed">0 m/s</div><div class="mode"></div>
      </div>
      <div class="selected-item" style="display:none"><div class="window-head">Selected Item</div><div class="body"></div></div>
      <div class="toast"></div>
      <div class="feed-status"></div>`);
    this.speedEl = this.root.querySelector(".ship-hud .speed")!;
    this.modeEl = this.root.querySelector(".ship-hud .mode")!;
    this.gaugeArc = this.root.querySelector(".speed-arc")!;
    this.selectedEl = this.root.querySelector(".selected-item")!;
    this.feedEl = this.root.querySelector(".feed-status")!;
    this.toastEl = this.root.querySelector(".toast")!;
    this.root.querySelector(".stop")!.addEventListener("click", () => this.act("Stop", () => this.actions.stop()));

    this.scene.background = new THREE.Color(0x020305);
    this.scene.add(this.starfield());
    this.scene.add(new THREE.AmbientLight(0x334455, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.5);
    sun.position.set(-1, 0.4, 0.6);
    this.scene.add(sun);
    this.camera.position.set(-600, 250, 900);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 1e6;
    this.controls.zoomSpeed = 1.2;
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
    this.root.remove();
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
    try { await fn(); } catch (e) { this.toast(`${what}: ${(e as Error).message}`); }
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
    this.renderSelected();
  }

  private renderSelected(): void {
    const e = this.snapshot?.entities.find((x) => x.itemID === this.selected) ?? null;
    if (!e || e.isSelf) { this.selectedEl.style.display = "none"; return; }
    this.selectedEl.style.display = "";
    const body = this.selectedEl.querySelector(".body")!;
    const dist = this.distanceTo(e);
    if (body.getAttribute("data-id") !== String(e.itemID)) {
      body.setAttribute("data-id", String(e.itemID));
      const canDock = e.kind === "station";
      body.innerHTML = `<div class="name"></div><div class="dist"></div><div class="actions">
        <button class="btn" data-a="approach">Approach</button><button class="btn" data-a="orbit">Orbit</button>
        <button class="btn" data-a="warp">Warp To</button>${canDock ? `<button class="btn" data-a="dock">Dock</button>` : ""}</div>`;
      body.querySelector(".name")!.textContent = e.name ?? `${e.kind} ${e.itemID}`;
      body.querySelectorAll<HTMLButtonElement>("button[data-a]").forEach((b) => b.addEventListener("click", () => {
        const id = e.itemID;
        const a = b.dataset.a!;
        void this.act(b.textContent ?? a, () => a === "approach" ? this.actions.approach(id) : a === "orbit" ? this.actions.orbit(id) : a === "warp" ? this.actions.warpTo(id) : this.actions.dock(id));
      }));
    }
    body.querySelector(".dist")!.textContent = distanceWords(dist);
  }

  private distanceTo(e: Entity): number {
    const s = this.snapshot?.ship;
    if (!s) return 0;
    return Math.max(0, Math.hypot(e.position.x - s.position.x, e.position.y - s.position.y, e.position.z - s.position.z) - e.radius - s.radius);
  }

  private frame(): void {
    if (this.stopped) return;
    this.frameCount++;
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
      if (e.isSelf) continue;
      let el = this.bracketEls.get(e.itemID);
      if (!el) {
        el = document.createElement("div");
        el.className = "bracket";
        el.innerHTML = `${glyph(e)}<div class="label"></div>`;
        const id = e.itemID;
        el.addEventListener("click", (ev) => { ev.stopPropagation(); this.select(id); });
        el.addEventListener("dblclick", (ev) => { ev.stopPropagation(); void this.act("Approach", () => this.actions.approach(id)); });
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
    for (const [id, m] of this.marks) if (!seen.has(id)) { this.scene.remove(m); this.marks.delete(id); }

    if (ego) {
      const speed = Math.hypot(ego.velocity.x, ego.velocity.y, ego.velocity.z);
      const max = ego.maxVelocity ?? 0;
      this.speedEl.textContent = `${speed < 10 ? speed.toFixed(1) : Math.round(speed).toLocaleString()} m/s`;
      const frac = max > 0 ? Math.min(1, speed / max) : 0;
      this.gaugeArc.setAttribute("d", arc(84, 84, 70, -135, -135 + 270 * frac));
      this.modeEl.textContent = ego.mode === "STOP" && speed < 1 ? "Stopped" : ego.mode === "WARP" ? "Warping" : ego.mode === "ORBIT" ? "Orbiting" : ego.mode === "FOLLOW" ? "Approaching" : speed > 0.5 ? "Moving" : "";
    }
    if (this.frameCount % 15 === 0) {
      this.renderSelected();
      this.feedEl.textContent = `${this.live.status} · tick ${park.currentTime % 100000} · ${snap?.entities.length ?? 0} on grid · ${this.live.items} updates${this.live.failures.length ? ` · ${this.live.failures.length} failed` : ""}`;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
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

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  if (to - from < 0.5) return "";
  const p = (deg: number) => { const a = ((deg - 90) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const [x1, y1] = p(from), [x2, y2] = p(to);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}
