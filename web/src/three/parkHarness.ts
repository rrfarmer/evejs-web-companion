// Spike S2: the browser runs its own Destiny Park (the BFF's code, bundled by virtual:destiny) on a
// feed of a real server's notifications, and must put every ball where the BFF's Park put it,
// tick by tick, to the last bit. Dev only (park-harness.html). The feed and the BFF's positions
// come from scripts/destiny-feed.js.
//
//   /park-harness.html?feed=destinyWarp&speed=8

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Park, Ballpark, marshalDecode, readFeedItem, applyToPark, MODE_NAME, type FeedItem } from "virtual:destiny";

type Row = [string, number, number, number, number]; // id, x, y, z, mode
interface Feed { about: string; shipID: string | null; items: FeedItem[]; expected: Row[][]; summary: Record<string, unknown> }

const params = new URLSearchParams(location.search);
const feedName = params.get("feed") ?? "destinyWarp";
const speed = Number(params.get("speed") ?? 8);
const status = document.getElementById("status")!;

function snapshot(park: Park): Row[] {
  const out: Row[] = [];
  for (const [id, ball] of park.ballpark.balls) out.push([String(id), ball.newPos.x, ball.newPos.y, ball.newPos.z, ball.mode]);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/** The same schedule as scripts/destiny-feed.js playFeed. */
function play(items: FeedItem[]) {
  const park = new Park({ ballpark: new Ballpark() });
  const failures: string[] = [];
  const guard = (name: string, fn: () => void) => { try { fn(); } catch (e) { failures.push(`${name}: ${(e as Error).message}`); } };
  const ticks: Row[][] = [];
  let clock = items.length ? items[0]!.atMs : 0;
  const tickTo = (atMs: number) => {
    while (clock + 1000 <= atMs) { park.tick(); clock += 1000; ticks.push(snapshot(park)); }
  };
  for (const item of items) {
    tickTo(item.atMs);
    const { method, args } = readFeedItem(item, marshalDecode);
    applyToPark(park, method, args, guard);
  }
  tickTo(clock + 1000);
  for (let more = 0; more < 3 && park.history.length > 0; more++) tickTo(clock + 1000);
  return { park, ticks, failures };
}

function compare(ours: Row[][], theirs: Row[][]) {
  let rows = 0, exact = 0;
  const mismatches: string[] = [];
  if (ours.length !== theirs.length) mismatches.push(`tick count: browser ${ours.length}, BFF ${theirs.length}`);
  for (let t = 0; t < Math.min(ours.length, theirs.length); t++) {
    const a = ours[t]!, b = theirs[t]!;
    if (a.length !== b.length) mismatches.push(`tick ${t}: ${a.length} balls here, ${b.length} in the BFF`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      rows++;
      const x = a[i]!, y = b[i]!;
      if (x[0] === y[0] && Object.is(x[1], y[1]) && Object.is(x[2], y[2]) && Object.is(x[3], y[3]) && x[4] === y[4]) exact++;
      else if (mismatches.length < 10) mismatches.push(`tick ${t} ball ${x[0]}: [${x.slice(1).join(", ")}] vs [${y.slice(1).join(", ")}]`);
    }
  }
  return { rows, exact, mismatches };
}

// ---- drawing: the balls as points, the pilot's ship marked, played back between ticks ----
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020306);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 1e13);
const controls = new OrbitControls(camera, renderer.domElement);
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

async function main() {
  const res = await fetch(`/play-feed/${feedName}.json`);
  if (!res.ok) throw new Error(`/play-feed/${feedName}.json: HTTP ${res.status} (run node scripts/destiny-feed.js ${feedName})`);
  const feed = (await res.json()) as Feed;
  const t0 = performance.now();
  const { park, ticks, failures } = play(feed.items);
  const ms = performance.now() - t0;
  const result = compare(ticks, feed.expected);
  const verdict = result.mismatches.length === 0 && result.exact === result.rows ? "IDENTICAL" : "DIFFERENT";
  const summary = {
    feed: feedName, verdict, ticks: ticks.length, positionsCompared: result.rows, exact: result.exact,
    failures, resets: park.resets, fatalDesyncs: park.fatalDesyncs, playMs: Math.round(ms), mismatches: result.mismatches,
  };
  (window as unknown as { __park: unknown }).__park = summary;
  status.textContent = `${feedName}: ${verdict} — ${result.exact}/${result.rows} positions over ${ticks.length} ticks match the BFF bit for bit; ${failures.length} failures, ${park.resets} resets (${Math.round(ms)} ms)`;

  // playback: points for every ball at the interpolated position between two ticks; z mirrored into three's space
  const ship = feed.shipID;
  const maxBalls = Math.max(...ticks.map((t) => t.length));
  const geom = new THREE.BufferGeometry();
  const pos = new Float32Array(maxBalls * 3);
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geom, new THREE.PointsMaterial({ color: 0x8fb8ff, size: 3, sizeAttenuation: false }));
  scene.add(points);
  const shipMark = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffc040 }));
  scene.add(shipMark);
  const label = document.getElementById("tick")!;
  let start = performance.now();
  renderer.setAnimationLoop(() => {
    const f = ((performance.now() - start) / 1000) * speed;
    const t = Math.floor(f);
    if (t >= ticks.length - 1) { start = performance.now(); return; }
    const a = ticks[t]!, b = new Map(ticks[t + 1]!.map((r) => [r[0], r]));
    const k = f - t;
    let n = 0;
    let shipAt: THREE.Vector3 | null = null;
    for (const r of a) {
      const s = b.get(r[0]) ?? r;
      const x = r[1] + (s[1] - r[1]) * k, y = r[2] + (s[2] - r[2]) * k, z = -(r[3] + (s[3] - r[3]) * k);
      if (r[0] === ship) shipAt = new THREE.Vector3(x, y, z);
      pos.set([x, y, z], n * 3); n++;
    }
    geom.setDrawRange(0, n);
    geom.attributes.position!.needsUpdate = true;
    geom.computeBoundingSphere();
    if (shipAt) {
      // follow the pilot's ship, at a distance that shows its grid
      const back = shipAt.clone().add(new THREE.Vector3(-30000, 15000, 30000));
      if (t === 0 && k < 0.05) camera.position.copy(back);
      controls.target.copy(shipAt);
      shipMark.position.copy(shipAt);
      shipMark.scale.setScalar(camera.position.distanceTo(shipAt) / 150);
      const mode = a.find((r) => r[0] === ship)?.[4];
      label.textContent = `tick ${t} · ship ${MODE_NAME[mode ?? -1] ?? mode} · ${n} balls`;
    }
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch((e) => { status.textContent = `failed: ${(e as Error).message}`; console.error(e); });
