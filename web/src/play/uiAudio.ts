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
 * A Wwise curve at x (its points' interpolations, AkCurveInterpolation: 9 constant, 4 linear, 5 S-curve; the others
 * taken as linear): the first point's value before it, the last's after.
 */
export function curveAt(points: readonly [number, number, number][], x: number): number {
  if (!points.length) return 1;
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, y0, kind] = points[i]!, [x1, y1] = points[i + 1]!;
    if (x > x1) continue;
    if (kind === 9 || x1 === x0) return y0;
    let t = (x - x0) / (x1 - x0);
    if (kind === 5) t = t * t * (3 - 2 * t);
    return y0 + (y1 - y0) * t;
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
const decoded = new Map<string, Promise<AudioBuffer | null>>();
/** The sounds a "<name>_play" event started and has playing (a "<name>_stop" event ends them, as its Stop action does). */
const playing = new Map<string, Set<AudioBufferSourceNode>>();
/** Every UI event asked to play (for checks): its name and what was found for it. */
export const uiAudioLog: { name: string; sound: string | null; state?: AudioContextState; played?: boolean; distance?: number }[] = [];

function eventsMap(): Promise<Record<string, EventSounds>> {
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
    const gain = ctx.createGain();
    gain.gain.value = volume * sounds[n]!.gain;
    source.connect(gain).connect(out(ctx));
    source.start();
    entry.played = true;
    set.add(source);
    source.onended = () => { set.delete(source); };
  }
}

/**
 * An emitter's event (AudEmitter.SendEvent) in the world: its sounds placed at the point (the view's frame, as the
 * listener's), at master x World level. Their fall-off with distance is Web Audio's inverse model from 1 km (Wwise's
 * attenuation curves are not read).
 */
export async function playWorldEvent(name: string, at: Vec3): Promise<void> {
  // the layers' crossfades by the emitter's distance from the listener (their RTPC bound to Distance)
  const distance = Math.hypot(at.x - listenerAt.x, at.y - listenerAt.y, at.z - listenerAt.z);
  const sounds = pick((await eventsMap())[String(wwiseId(name))] ?? null, distance);
  const entry: (typeof uiAudioLog)[number] = { name, sound: sounds.map((s) => `${s.sound}@${s.gain.toFixed(2)}`).join(" + ") || null, distance };
  uiAudioLog.push(entry);
  const settings = gfx();
  const volume = settings.audioEnabled ? settings.masterVolume * settings.worldVolume : 0;
  if (!sounds.length || volume <= 0) return;
  await start(name, sounds, volume, (ctx) => {
    const panner = new PannerNode(ctx, { panningModel: "equalpower", distanceModel: "inverse", refDistance: 1000, maxDistance: 300000, rolloffFactor: 1,
      positionX: at.x, positionY: at.y, positionZ: at.z });
    panner.connect(ctx.destination);
    return panner;
  }, entry);
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
