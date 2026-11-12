// The client's UI sounds (GetAudioService().SendUIEvent(name) / PlaySound(uiconst.SOUND_*)): a Wwise event by name,
// its id the FNV-1 hash of the lowercase name, played as the sound the extractor found it plays
// (tools/client-extract/audio.mjs: /client-assets/audio/events.json, the sounds by event id - "<bank>/<source id>" or
// "streamed/<source id>", a container's several - each an Ogg Vorbis rebuilt from the client's Wwise Vorbis). An
// event with nothing found plays nothing. Its loudness: the Audio panel's master volume x its UI sound level
// (gfxSettings; the client feeds them to Wwise, whose curves are not read here: taken as plain gains), nothing while
// audio is off.

import { gfx } from "./gfxSettings.ts";

/** Wwise's ids: FNV-1 32-bit of the lowercase name (AK::SoundEngine::GetIDFromString). */
export function wwiseId(name: string): number {
  let h = 2166136261;
  for (const c of new TextEncoder().encode(name.toLowerCase())) {
    h = Math.imul(h, 16777619) >>> 0;
    h = (h ^ c) >>> 0;
  }
  return h;
}

/** A layer: its alternatives, or {s: alternatives, d: its crossfade by distance - [distance, gain, interpolation]}. */
type Layer = string[] | { s: string[]; d: [number, number, number][] };
/** events.json's entry: layers (older lists: alternatives, or one sound). */
type EventSounds = string | string[] | Layer[];

/**
 * A segment's shape, AkCurveInterpolation, as the client's Wwise engine evaluates it (_audio2.dll at RVA 0x179950:
 * (t, from, to, interpolation) -> from + (to - from) x shape(t), its switch's table at 0x179c80 for 0 .. 8, its own
 * polynomials and constants): 0 Log3, 1 Sine, 2 Log1, 3 InvSCurve, 4 Linear, 5 SCurve, 6 Exp1, 7 SineRecip, 8 Exp3
 * (9 Constant: the segment's first value).
 */
export function curveShape(kind: number, t: number): number {
  switch (kind) {
    case 0: return 1 - (1 - t) ** 3;
    case 1: {
      // a polynomial for sin(t pi / 2)
      const x = t * (Math.PI / 2);
      const k = 0.286479 - 0.0911891 * x;
      return t * k * (Math.PI * t) - x * k * t * t + (0.986761 - 0.314096 * x) * x;
    }
    case 2: return t * (3 - t) / 2;
    case 3: {
      // the inverted S, by halves: a polynomial for sin(t pi) / 2 up to the middle, 1 - sin(pi - t pi) / 2 after it
      const half = (x: number) => { const y = x * x; return (((0.00415316 - 9.18183e-5 * y) * y - 0.0833241) * y + 0.499998) * x; };
      return t <= 0.5 ? half(t * Math.PI) : 1 - half(Math.PI - t * Math.PI);
    }
    case 5: {
      // a polynomial for (1 - cos(t pi)) / 2
      const y = t * t * 9.86961;
      return Math.min(1, ((0.000484834 * y - 0.0196138) * y + 0.247675) * y + 0.000696702);
    }
    case 6: return t * (t + 1) / 2;
    case 7: {
      // 1 - a polynomial for cos(t pi / 2)
      const u = t * t * 2.4674;
      return 1 - (((0.0414877 - 0.00127121 * u) * u - 0.499912) * u + 0.999993);
    }
    case 8: return t * t * t;
    default: return t;
  }
}
/** A Wwise curve at x (each segment by its first point's interpolation): the first point's value before it, the last's after. */
export function curveAt(points: readonly [number, number, number][], x: number): number {
  if (!points.length) return 1;
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, y0, kind] = points[i]!, [x1, y1] = points[i + 1]!;
    if (x > x1) continue;
    if (kind === 9 || x1 === x0) return y0;
    return y0 + (y1 - y0) * curveShape(kind, (x - x0) / (x1 - x0));
  }
  return points[points.length - 1]![1];
}
let events: Promise<Record<string, EventSounds>> | null = null;
/** One alternative of each of an event's layers (they sound together), with its gain at that distance. */
function pick(found: EventSounds | null, distance = 0): { sound: string; gain: number }[] {
  if (found === null) return [];
  const layers: Layer[] = typeof found === "string" ? [[found]] : found.length && typeof found[0] !== "string" ? found as Layer[] : [found as string[]];
  const out: { sound: string; gain: number }[] = [];
  for (const l of layers) {
    const choices = Array.isArray(l) ? l : l.s;
    if (!choices.length) continue;
    const gain = Array.isArray(l) ? 1 : curveAt(l.d, distance);
    if (gain <= 0.001) continue;
    out.push({ sound: choices[Math.floor(Math.random() * choices.length)]!, gain });
  }
  return out;
}
let context: AudioContext | null = null;
/** The page's one audio context (the music's too). */
export function audioContext(): AudioContext {
  context ??= new AudioContext();
  return context;
}
const decoded = new Map<string, Promise<AudioBuffer | null>>();
/** The sounds a "<name>_play" event started and has playing (a "<name>_stop" event ends them, as its Stop action does). */
const playing = new Map<string, Set<AudioBufferSourceNode>>();
/** Every UI event asked to play (for checks): its name and what was found for it. */
export const uiAudioLog: { name: string; sound: string | null; state?: AudioContextState; played?: boolean; distance?: number }[] = [];

/** The effects' sounds by guid (tools/client-extract/audio.mjs: fxSounds.json - each event, its time, source or target). */
let fxSounds: Promise<Record<string, { event: string; time: number; at: "source" | "target" }[]>> | null = null;
export function fxSoundsOf(): Promise<Record<string, { event: string; time: number; at: "source" | "target" }[]>> {
  fxSounds ??= fetch("/client-assets/audio/fxSounds.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return fxSounds;
}

/**
 * The explosions' sounds (tools/client-extract/audio.mjs: explosionSounds.json): by type its bucket and race; by bucket
 * and race the explosions it may play, each with its chance weight and its sounds.
 */
export interface ExplosionSounds {
  types: Record<string, [number, string | null]>;
  buckets: Record<string, Record<string, { w: number; ls?: number; gs?: number; s: { event: string; time: number; k?: "l" | "g" }[] }[]>>;
}
let explosions: Promise<ExplosionSounds> | null = null;
export function explosionSoundsOf(): Promise<ExplosionSounds> {
  explosions ??= fetch("/client-assets/audio/explosionSounds.json").then((r) => (r.ok ? r.json() : { types: {}, buckets: {} })).catch(() => ({ types: {}, buckets: {} }));
  return explosions;
}
/** GetRandomExplosion: one of a type's bucket's explosions for its race (else the default's), by their chances. */
/** One of a type's bucket's explosions, by its chance: its sounds, each with its emitter's scaling (the bucket's local or global scale). */
export function pickExplosion(table: ExplosionSounds, typeID: number): { event: string; time: number; scale: number }[] {
  const t = table.types[String(typeID)];
  if (!t) return [];
  const bucket = table.buckets[String(t[0])];
  const list = bucket?.[t[1] ?? ""] ?? bucket?.["default"] ?? Object.values(bucket ?? {})[0] ?? [];
  const total = list.reduce((n, o) => n + o.w, 0);
  let r = Math.random() * total;
  const chosen = list.find((o) => (r -= o.w) <= 0) ?? list[list.length - 1];
  return (chosen?.s ?? []).map((s) => ({ event: s.event, time: s.time, scale: s.k === "l" ? chosen!.ls ?? 1 : s.k === "g" ? chosen!.gs ?? 1 : 1 }));
}

function eventsMap(): Promise<Record<string, EventSounds>> {
  // (the sounds' own properties asked with the events, so the first sound played has them)
  askSoundProps();
  events ??= fetch("/client-assets/audio/events.json").then((r) => (r.ok ? r.json() as Promise<Record<string, EventSounds>> : {})).catch(() => ({}));
  return events;
}

type Vec3 = { x: number; y: number; z: number };
/** A sound's file: events.json names it with its extension (.ogg Vorbis, .wav PTADPCM); older lists without one: .ogg. */
const soundUrl = (sound: string): string => `/client-assets/audio/${sound}${/\.(ogg|wav)$/.test(sound) ? "" : ".ogg"}`;
/** The listener: the camera (Wwise's listener is the camera's), its place and its forward and up directions. */
let listenerAt: Vec3 = { x: 0, y: 0, z: 0 };
export function setListener(at: Vec3, forward: Vec3, up: Vec3): void {
  listenerAt = { x: at.x, y: at.y, z: at.z };
  if (!context) return;
  const l = context.listener;
  if (l.positionX) {
    l.positionX.value = at.x; l.positionY.value = at.y; l.positionZ.value = at.z;
    l.forwardX.value = forward.x; l.forwardY.value = forward.y; l.forwardZ.value = forward.z;
    l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
  }
}

/** The sounds' own properties (soundProps.json: v its volume in dB, l its loop count - 0 for ever, a its attenuation). */
let soundProps: Record<string, { v?: number; l?: number; a?: number }> = {};
let soundPropsAsked = false;
/** The attenuations (attenuations.json: each one's volume curve by distance - s its scaling, p its points). */
let attenuations: Record<string, { s: number; p: [number, number, number][] }> = {};
let attenuationsReady: Promise<void> | null = null;
function askSoundProps(): void {
  if (soundPropsAsked) return;
  soundPropsAsked = true;
  void fetch("/client-assets/audio/soundProps.json").then((r) => (r.ok ? r.json() : {})).then((j) => { soundProps = j as typeof soundProps; }).catch(() => {});
}
function askAttenuations(): Promise<void> {
  askSoundProps();
  attenuationsReady ??= fetch("/client-assets/audio/attenuations.json").then((r) => (r.ok ? r.json() : {})).then((j) => { attenuations = j as typeof attenuations; }).catch(() => {});
  return attenuationsReady;
}
/**
 * A sound's attenuation at a distance (m): its volume curve there - a dB-scaled curve's value y read as the gain 1 + y
 * (-1 silent, at its max distance), an unscaled one's as dB; 1 for a sound with none (Wwise does not attenuate it).
 */
export function attenuationAt(sound: string, distance: number, scale = 1): number {
  const a = soundProps[sound]?.a;
  const curve = a === undefined ? undefined : attenuations[String(a)];
  if (!curve || !curve.p.length) return 1;
  // (an emitter's attenuation scaling factor stretches the curve's distances: SetAttenuationScalingFactor)
  const y = curveAt(curve.p, distance / (scale > 0 ? scale : 1));
  return curve.s === 2 ? Math.max(0, Math.min(1, 1 + y)) : Math.pow(10, y / 20);
}
/** A panner that only places the sound (its fall-off is the sound's attenuation curve, applied as a gain). */
function placer(ctx: AudioContext, at: Vec3): PannerNode {
  return new PannerNode(ctx, { panningModel: "equalpower", distanceModel: "linear", refDistance: 1, maxDistance: 1e12, rolloffFactor: 0,
    positionX: at.x, positionY: at.y, positionZ: at.z });
}
/** A sound's own level as a gain (its volume property in dB), and whether it loops for ever. */
export function ownOf(sound: string): { gain: number; loop: boolean } {
  askSoundProps();
  const p = soundProps[sound];
  return { gain: p?.v !== undefined ? Math.pow(10, p.v / 20) : 1, loop: p?.l === 0 };
}

/** A sound's buffer, decoded once. */
function bufferOf(ctx: AudioContext, sound: string): Promise<AudioBuffer | null> {
  if (!decoded.has(sound)) decoded.set(sound, fetch(soundUrl(sound)).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).catch(() => null));
  return decoded.get(sound)!;
}

/**
 * An event's sounds started: one alternative of each layer, together, through the node given (a gain, a panner); the
 * sources kept under the event's name for its stop event.
 */
async function start(name: string, sounds: { sound: string; gain: number }[], volume: number, out: (ctx: AudioContext) => AudioNode, entry: (typeof uiAudioLog)[number]): Promise<void> {
  context ??= new AudioContext();
  if (context.state === "suspended") await context.resume().catch(() => {});
  const ctx = context;
  entry.state = ctx.state;
  const buffers = await Promise.all(sounds.map((s) => bufferOf(ctx, s.sound)));
  const key = name.toLowerCase();
  const set = playing.get(key) ?? new Set<AudioBufferSourceNode>();
  playing.set(key, set);
  for (const [n, buffer] of buffers.entries()) {
    if (!buffer) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const own = ownOf(sounds[n]!.sound);
    // (a sound that loops for ever in Wwise loops here until its event's stop)
    source.loop = own.loop;
    const gain = ctx.createGain();
    gain.gain.value = volume * sounds[n]!.gain * own.gain;
    source.connect(gain).connect(out(ctx));
    source.start();
    entry.played = true;
    set.add(source);
    source.onended = () => { set.delete(source); };
  }
}

/**
 * An emitter's event (AudEmitter.SendEvent) in the world: its sounds placed at the point (the view's frame, as the
 * listener's), at master x World level, each sound by its attenuation curve at the emitter's distance - its
 * distances times the emitter's scaling factor (1 unless the client sets one: the effects' and explosions').
 */
export async function playWorldEvent(name: string, at: Vec3, scale = 1): Promise<void> {
  // the layers' crossfades by the emitter's distance from the listener (their RTPC bound to Distance)
  const distance = Math.hypot(at.x - listenerAt.x, at.y - listenerAt.y, at.z - listenerAt.z);
  await askAttenuations();
  const sounds = pick((await eventsMap())[String(wwiseId(name))] ?? null, distance)
    .map((s) => ({ ...s, gain: s.gain * attenuationAt(s.sound, distance, scale) }))
    .filter((s) => s.gain > 0.001);
  const entry: (typeof uiAudioLog)[number] = { name, sound: sounds.map((s) => `${s.sound}@${s.gain.toFixed(2)}`).join(" + ") || null, distance };
  uiAudioLog.push(entry);
  const settings = gfx();
  const volume = settings.audioEnabled ? settings.masterVolume * settings.worldVolume : 0;
  if (!sounds.length || volume <= 0) return;
  await start(name, sounds, volume, (ctx) => {
    const panner = placer(ctx, at);
    panner.connect(ctx.destination);
    return panner;
  }, entry);
}

/** The types' ambient sounds (tools/client-extract/audio.mjs: typeSounds.json - typeID -> its Wwise event). */
let typeSounds: Promise<Record<string, string>> | null = null;
export function typeSoundsOf(): Promise<Record<string, string>> {
  typeSounds ??= fetch("/client-assets/audio/typeSounds.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return typeSounds;
}

/** A looping sound in the world: moved with its object, stopped when it is let go. */
export interface WorldLoop { move(at: Vec3): void; stop(): void }
/**
 * An ambient event at an object (SetupAmbientAudio / PlayAmbientAudio): its sounds looped (the ship sounds are
 * loops in Wwise - the loop flag is not read from the bank here), placed and moved with the object, at master x
 * World level, until stopped (the client's shipsounds_stop as the camera looks elsewhere).
 */
export async function playWorldLoop(name: string, at: Vec3): Promise<WorldLoop> {
  const distance = Math.hypot(at.x - listenerAt.x, at.y - listenerAt.y, at.z - listenerAt.z);
  await askAttenuations();
  const sounds = pick((await eventsMap())[String(wwiseId(name))] ?? null, distance);
  const entry: (typeof uiAudioLog)[number] = { name, sound: sounds.map((s) => s.sound).join(" + ") || null, distance };
  uiAudioLog.push(entry);
  const settings = gfx();
  const volume = settings.audioEnabled ? settings.masterVolume * settings.worldVolume : 0;
  const nodes: { source: AudioBufferSourceNode; panner: PannerNode; gain: GainNode; base: number; sound: string }[] = [];
  let stopped = false;
  const handle: WorldLoop = {
    move(p) {
      // (its attenuation followed as it or the camera moves)
      const d = Math.hypot(p.x - listenerAt.x, p.y - listenerAt.y, p.z - listenerAt.z);
      for (const n of nodes) {
        n.panner.positionX.value = p.x; n.panner.positionY.value = p.y; n.panner.positionZ.value = p.z;
        n.gain.gain.value = n.base * attenuationAt(n.sound, d);
      }
    },
    stop() { stopped = true; for (const n of nodes) { try { n.source.stop(); } catch { /* over */ } } nodes.length = 0; },
  };
  if (!sounds.length || volume <= 0) return handle;
  context ??= new AudioContext();
  const ctx = context;
  entry.state = ctx.state;
  const buffers = await Promise.all(sounds.map((s) => bufferOf(ctx, s.sound)));
  if (stopped) return handle;
  for (const [n, buffer] of buffers.entries()) {
    if (!buffer) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    const base = volume * sounds[n]!.gain * ownOf(sounds[n]!.sound).gain;
    gain.gain.value = base * attenuationAt(sounds[n]!.sound, distance);
    const panner = placer(ctx, at);
    source.connect(gain).connect(panner).connect(ctx.destination);
    source.start();
    entry.played = true;
    nodes.push({ source, panner, gain, base, sound: sounds[n]!.sound });
  }
  return handle;
}

/** SendUIEvent: the event's sounds played once, now (the first call after a user gesture starts the audio). */
export async function playUiEvent(name: string): Promise<void> {
  // "<x>_stop": the sounds "<x>_play" started, stopped (the client's stop events are Stop actions on their play's
  // objects; the ones with a sound of their own are not handled here)
  const stop = /^(.*)_stop$/i.exec(name);
  if (stop) {
    const key = `${stop[1]!.toLowerCase()}_play`;
    for (const s of playing.get(key) ?? []) { try { s.stop(); } catch { /* already over */ } }
    playing.delete(key);
    uiAudioLog.push({ name, sound: null, played: false });
    return;
  }
  const sounds = pick((await eventsMap())[String(wwiseId(name))] ?? null);
  const entry: (typeof uiAudioLog)[number] = { name, sound: sounds.map((s) => s.sound).join(" + ") || null };
  uiAudioLog.push(entry);
  const settings = gfx();
  const volume = settings.audioEnabled ? settings.masterVolume * settings.uiGain : 0;
  if (!sounds.length || volume <= 0) return;
  await start(name, sounds, volume, (ctx) => ctx.destination, entry);
}
