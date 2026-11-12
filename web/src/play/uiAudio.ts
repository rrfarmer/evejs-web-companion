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

/** events.json's entry: layers of alternatives (older lists: alternatives, or one sound). */
type EventSounds = string | string[] | string[][];
let events: Promise<Record<string, EventSounds>> | null = null;
/** One alternative of each of an event's layers (they sound together). */
function pick(found: EventSounds | null): string[] {
  if (found === null) return [];
  const layers: string[][] = typeof found === "string" ? [[found]] : found.length && Array.isArray(found[0]) ? found as string[][] : [found as string[]];
  return layers.filter((l) => l.length).map((l) => l[Math.floor(Math.random() * l.length)]!);
}
let context: AudioContext | null = null;
const decoded = new Map<string, Promise<AudioBuffer | null>>();
/** The sounds a "<name>_play" event started and has playing (a "<name>_stop" event ends them, as its Stop action does). */
const playing = new Map<string, Set<AudioBufferSourceNode>>();
/** Every UI event asked to play (for checks): its name and what was found for it. */
export const uiAudioLog: { name: string; sound: string | null; state?: AudioContextState; played?: boolean }[] = [];

function eventsMap(): Promise<Record<string, EventSounds>> {
  events ??= fetch("/client-assets/audio/events.json").then((r) => (r.ok ? r.json() as Promise<Record<string, EventSounds>> : {})).catch(() => ({}));
  return events;
}

type Vec3 = { x: number; y: number; z: number };
/** A sound's file: events.json names it with its extension (.ogg Vorbis, .wav PTADPCM); older lists without one: .ogg. */
const soundUrl = (sound: string): string => `/client-assets/audio/${sound}${/\.(ogg|wav)$/.test(sound) ? "" : ".ogg"}`;
/** The listener: the camera (Wwise's listener is the camera's), its place and its forward and up directions. */
export function setListener(at: Vec3, forward: Vec3, up: Vec3): void {
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
async function start(name: string, sounds: string[], volume: number, out: (ctx: AudioContext) => AudioNode, entry: (typeof uiAudioLog)[number]): Promise<void> {
  context ??= new AudioContext();
  if (context.state === "suspended") await context.resume().catch(() => {});
  const ctx = context;
  entry.state = ctx.state;
  const buffers = await Promise.all(sounds.map((s) => bufferOf(ctx, s)));
  const key = name.toLowerCase();
  const set = playing.get(key) ?? new Set<AudioBufferSourceNode>();
  playing.set(key, set);
  for (const buffer of buffers) {
    if (!buffer) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
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
  const sounds = pick((await eventsMap())[String(wwiseId(name))] ?? null);
  const entry: (typeof uiAudioLog)[number] = { name, sound: sounds.join(" + ") || null };
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
  const entry: (typeof uiAudioLog)[number] = { name, sound: sounds.join(" + ") || null };
  uiAudioLog.push(entry);
  const settings = gfx();
  const volume = settings.audioEnabled ? settings.masterVolume * settings.uiGain : 0;
  if (!sounds.length || volume <= 0) return;
  await start(name, sounds, volume, (ctx) => ctx.destination, entry);
}
