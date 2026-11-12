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

let events: Promise<Record<string, string | string[]>> | null = null;
let context: AudioContext | null = null;
const decoded = new Map<string, Promise<AudioBuffer | null>>();
/** Every UI event asked to play (for checks): its name and what was found for it. */
export const uiAudioLog: { name: string; sound: string | null; state?: AudioContextState; played?: boolean }[] = [];

function eventsMap(): Promise<Record<string, string | string[]>> {
  events ??= fetch("/client-assets/audio/events.json").then((r) => (r.ok ? r.json() as Promise<Record<string, string | string[]>> : {})).catch(() => ({}));
  return events;
}

/** SendUIEvent: the event's sound played once, now (the first call after a user gesture starts the audio). */
export async function playUiEvent(name: string): Promise<void> {
  const found = (await eventsMap())[String(wwiseId(name))] ?? null;
  // (a random / sequence container's sounds: one of them, at random)
  const choices = found === null ? [] : Array.isArray(found) ? found : [found];
  const sound = choices.length ? choices[Math.floor(Math.random() * choices.length)]! : null;
  const entry: (typeof uiAudioLog)[number] = { name, sound };
  uiAudioLog.push(entry);
  const settings = gfx();
  const volume = settings.audioEnabled ? settings.masterVolume * settings.uiGain : 0;
  if (!sound || volume <= 0) return;
  context ??= new AudioContext();
  if (context.state === "suspended") await context.resume().catch(() => {});
  const ctx = context;
  entry.state = ctx.state;
  if (!decoded.has(sound)) {
    decoded.set(sound, fetch(`/client-assets/audio/${sound}.ogg`).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).catch(() => null));
  }
  const buffer = await decoded.get(sound)!;
  if (!buffer) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(ctx.destination);
  source.start();
  entry.played = true;
}
