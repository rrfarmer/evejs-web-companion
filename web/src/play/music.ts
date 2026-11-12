// The client's music: DynamicMusicService (eveaudio/eveMusicService.py) sends music trigger events to the Wwise music
// player as its node graph 805 "Master Music Graph" says - the login / character selection music (806:
// music_login_play, music_login_stop as it stops), in space the dynamic music (809: music_eve_dynamic_play, then the
// system's security class's switch - 812 music_switch_empire, 813 music_switch_danger, 814 music_switch_zero /
// _zero_special, 815 music_switch_zero_wormhole; music_eve_dynamic_stop as it stops), in the hangar none (808 only
// waits for the undock). The music itself is tools/client-extract/audio.mjs's music.json: each trigger's Play, Stop and
// Set State actions; the music switch containers (a state group's state picks the child, 0 the default), the playlists
// (their item trees: sequence or random groups, loop counts, weights, avoid-repeat) and the segments (each track's
// clips; a random sub-track picked where there are several; the next segment's entry marker at its exit marker).
// Its loudness: the Audio panel's master volume x its Music level (the client's volume_music RTPC: its curve not read).
// In combat - something has the ship targeted (targetMgr.IsTargeted: its targetedBy not empty) and the Use Combat
// Music setting on - 823 instead of 809: music_eve_combat_play, then music_switch_combat_empire (high sec) /
// _nullsec (low sec) / _zerosec_and_wormhole (zero sec); music_eve_combat_stop as it stops.
// Not built: the transition rules (a changed switch crossfades over 2 s here), stingers, the music objects' own
// volumes, the dungeon, abyssal, Zarzakh, insurgency, Triglavian and Pochven branches.

import { gfx, onGfx } from "./gfxSettings.ts";
import { audioContext } from "./uiAudio.ts";

type Op = ["play", number] | ["stop", number] | ["state", number, number];
/** A clip: its file, its place in the segment, its begin and end trims, its source's length (ms). */
type Clip = [string, number, number, number, number];
interface Segment { d: number; e: number; x: number; t: Clip[][][] }
type Tree = { s: number; l: number; w: number } | { r: 0 | 1; l: number; a: number; w: number; c: Tree[] };
type MusicNode = { seg: number } | { g: number; d: number; s: Record<string, number> } | { p: Tree };
interface MusicData { events: Record<string, Op[]>; nodes: Record<string, MusicNode>; segments: Record<string, Segment> }

let data: Promise<MusicData | null> | null = null;
function musicData(): Promise<MusicData | null> {
  data ??= fetch("/client-assets/audio/music.json").then((r) => (r.ok ? r.json() as Promise<MusicData> : null)).catch(() => null);
  return data;
}
/** The state groups' states the Set State actions set. */
const states = new Map<number, number>();
/** Every music event sent and what it did (for checks). */
export const musicLog: { event: string; at: number; found: boolean; leaf?: number | null; segments?: number[] }[] = [];

let out: GainNode | null = null;
function output(ctx: AudioContext): GainNode {
  if (out) return out;
  out = ctx.createGain();
  out.connect(ctx.destination);
  const level = (s = gfx()) => (s.audioEnabled ? s.masterVolume * s.eveampGain : 0);
  out.gain.value = level();
  onGfx((s) => { out!.gain.setTargetAtTime(level(s), ctx.currentTime, 0.1); });
  return out;
}

/** A switch container's child for the states set now, down to a playlist or a segment. */
function resolve(m: MusicData, id: number, depth = 0): number | null {
  const node = m.nodes[id];
  if (!node || depth > 8) return null;
  if ("g" in node) {
    const child = node.s[String(states.get(node.g) ?? 0)] ?? node.d;
    return child ? resolve(m, child, depth + 1) : null;
  }
  return id;
}

/** A playlist's segments in the order its item tree plays them (endless where it loops for ever). */
function* walk(tree: Tree): Generator<number> {
  if ("s" in tree) {
    for (let n = 0; tree.l === 0 || n < tree.l; n++) yield tree.s;
    return;
  }
  for (let pass = 0; tree.l === 0 || pass < tree.l; pass++) {
    if (!tree.r) { for (const c of tree.c) yield* walk(c); continue; }
    // random: each pick weighted, the last `a` picked avoided (while any other is left)
    const recent: Tree[] = [];
    for (let n = 0; n < tree.c.length; n++) {
      const avoid = Math.min(tree.a, tree.c.length - 1);
      const blocked = avoid > 0 ? recent.slice(-avoid) : [];
      const open = tree.c.filter((c) => !blocked.includes(c));
      const total = open.reduce((sum, c) => sum + c.w, 0);
      let r = Math.random() * total;
      const pick = open.find((c) => (r -= c.w) < 0) ?? open[open.length - 1]!;
      recent.push(pick);
      yield* walk(pick);
    }
  }
}

/** A music object playing: its segments one after another, each at the last one's exit marker. */
class Playback {
  private readonly gain: GainNode;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private order: Generator<number> | null = null;
  private exitAt = 0;
  private stopped = false;
  leaf: number | null = null;
  readonly played: number[] = [];

  constructor(private readonly m: MusicData, private readonly ctx: AudioContext, readonly root: number) {
    this.gain = ctx.createGain();
    this.gain.connect(output(ctx));
  }

  /** From the leaf the states pick now (a crossfade where one was playing). */
  start(fadeMs = 0): void {
    const leaf = resolve(this.m, this.root);
    if (leaf === this.leaf) return;
    this.leaf = leaf;
    this.fadeOut(fadeMs);
    if (this.timer) clearTimeout(this.timer);
    if (leaf === null) { this.order = null; return; }
    const node = this.m.nodes[leaf]!;
    this.order = "p" in node ? walk(node.p) : "seg" in node ? (function* () { yield node.seg; })() : null;
    this.exitAt = this.ctx.currentTime + 0.1;
    void this.next(true);
  }

  private fadeOut(ms: number): void {
    const now = this.ctx.currentTime;
    for (const s of this.sources) {
      const g = (s as AudioBufferSourceNode & { own?: GainNode }).own;
      if (g && ms > 0) { g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(0, now + ms / 1000); }
      try { s.stop(now + ms / 1000); } catch { /* not started */ }
    }
    this.sources.clear();
  }

  private async next(first = false): Promise<void> {
    if (this.stopped || !this.order) return;
    const order = this.order;
    const step = order.next();
    if (step.done) return;
    const seg = this.m.segments[step.value];
    if (!seg) return;
    // one sub-track of each track (a random one where there are several), its clips loaded
    const clips = seg.t.map((subs) => subs[Math.floor(Math.random() * subs.length)]!).flat();
    const buffers = await Promise.all(clips.map((c) => bufferOf(this.ctx, c[0])));
    if (this.stopped || order !== this.order) return;
    const now = this.ctx.currentTime;
    // the segment's entry marker at the last one's exit marker (the first from its entry, now)
    const start = Math.max(this.exitAt, now + 0.05) - seg.e / 1000;
    for (const [n, c] of clips.entries()) {
      const buffer = buffers[n];
      if (!buffer) continue;
      const [, at, begin, end, length] = c;
      let when = start + (at + begin) / 1000, offset = begin / 1000;
      let duration = (length + end - begin) / 1000;
      if (first && when < start + seg.e / 1000) { const skip = start + seg.e / 1000 - when; when += skip; offset += skip; duration -= skip; }
      if (when < now) { offset += now - when; duration -= now - when; when = now; }
      if (duration <= 0) continue;
      const source = this.ctx.createBufferSource() as AudioBufferSourceNode & { own?: GainNode };
      source.buffer = buffer;
      source.own = this.ctx.createGain();
      source.connect(source.own).connect(this.gain);
      source.start(when, offset, duration);
      this.sources.add(source);
      source.onended = () => { this.sources.delete(source); };
    }
    this.played.push(step.value);
    this.exitAt = start + seg.x / 1000;
    // the next segment readied 15 s before this one's exit
    const lead = Math.max(0, (this.exitAt - this.ctx.currentTime - 15) * 1000);
    this.timer = setTimeout(() => { void this.next(); }, lead);
  }

  stop(fadeMs: number): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.fadeOut(fadeMs);
    setTimeout(() => this.gain.disconnect(), fadeMs + 100);
  }
}

const decoded = new Map<string, Promise<AudioBuffer | null>>();
function bufferOf(ctx: AudioContext, file: string): Promise<AudioBuffer | null> {
  if (!decoded.has(file)) {
    decoded.set(file, fetch(`/client-assets/audio/${file}`).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).catch(() => null));
    // (a segment's few minutes of audio each: the decoded ones are not kept past a dozen)
    if (decoded.size > 12) decoded.delete(decoded.keys().next().value!);
  }
  return decoded.get(file)!;
}

const playing = new Map<number, Playback>();
let lastSent = "";

/** DynamicMusicService.SendMusicEvent: a trigger's actions - its Set States, then its Plays and Stops (the same event twice in a row sent once). */
export async function sendMusicEvent(name: string, forcePlay = false): Promise<void> {
  if (!forcePlay && name === lastSent) return;
  lastSent = name;
  const m = await musicData();
  const ops = m?.events[name];
  const entry: (typeof musicLog)[number] = { event: name, at: Date.now(), found: !!ops };
  musicLog.push(entry);
  if (!m || !ops) return;
  const ctx = audioContext();
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  let changed = false;
  for (const op of ops) {
    if (op[0] === "state" && states.get(op[1]) !== op[2]) { states.set(op[1], op[2]); changed = true; }
  }
  if (changed) for (const p of playing.values()) p.start(2000);
  for (const op of ops) {
    if (op[0] === "play" && !playing.has(op[1])) {
      const p = new Playback(m, ctx, op[1]);
      playing.set(op[1], p);
      p.start();
      entry.leaf = p.leaf;
      entry.segments = p.played;
    } else if (op[0] === "stop") {
      playing.get(op[1])?.stop(1000);
      playing.delete(op[1]);
    }
  }
}

/** What is playing (for checks): each music object, the playlist or segment its states picked, the segments started. */
export function musicPlaying(): { root: number; leaf: number | null; played: number[] }[] {
  return [...playing.values()].map((p) => ({ root: p.root, leaf: p.leaf, played: [...p.played] }));
}

/** The combat music's switch for a system (823's tree by security class: 2 -> 818, 1 -> 820, 0 -> 821; the safe class none). */
export function combatSwitch(security: number): string | null {
  if (security <= 0) return "music_switch_combat_zerosec_and_wormhole";
  if (security < 0.45) return "music_switch_combat_nullsec";
  if (security < 0.95) return "music_switch_combat_empire";
  return null;
}

/**
 * The dynamic music's switch for a system (809's tree by SecurityClassFromLevel: zero sec at 0.0 and below, low below
 * 0.45, high below 0.95, else the safe class - no branch of its own; 814 - a k-space system's music_switch_zero, the
 * listed specials' _zero_special, else 815's wormhole switch).
 */
export function securitySwitch(solarSystemID: number, security: number): string | null {
  if (security <= 0) {
    if (solarSystemID < 31000000) return "music_switch_zero";
    if ([31000001, 31000002, 31000003, 31000004, 31000006].includes(solarSystemID)) return "music_switch_zero_special";
    return "music_switch_zero_wormhole";
  }
  if (security < 0.45) return "music_switch_danger";
  if (security < 0.95) return "music_switch_empire";
  return null;
}
