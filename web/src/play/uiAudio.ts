// The client's UI sounds (GetAudioService().SendUIEvent(name) / PlaySound(uiconst.SOUND_*)): a Wwise event by name,
// its id the FNV-1 hash of the lowercase name, played as the sound the extractor found it plays
// (tools/client-extract/audio.mjs: /client-assets/audio/events.json, "<bank>/<source id>" by event id; the sound an
// Ogg Vorbis rebuilt from the client's Wwise Vorbis). An event with nothing found plays nothing.

/** Wwise's ids: FNV-1 32-bit of the lowercase name (AK::SoundEngine::GetIDFromString). */
export function wwiseId(name: string): number {
  let h = 2166136261;
  for (const c of new TextEncoder().encode(name.toLowerCase())) {
    h = Math.imul(h, 16777619) >>> 0;
    h = (h ^ c) >>> 0;
  }
  return h;
}

let events: Promise<Record<string, string>> | null = null;
let context: AudioContext | null = null;
const decoded = new Map<string, Promise<AudioBuffer | null>>();
/** Every UI event asked to play (for checks): its name and what was found for it. */
export const uiAudioLog: { name: string; sound: string | null; state?: AudioContextState; played?: boolean }[] = [];

function eventsMap(): Promise<Record<string, string>> {
  events ??= fetch("/client-assets/audio/events.json").then((r) => (r.ok ? r.json() as Promise<Record<string, string>> : {})).catch(() => ({}));
  return events;
}

/** SendUIEvent: the event's sound played once, now (the first call after a user gesture starts the audio). */
export async function playUiEvent(name: string): Promise<void> {
  const sound = (await eventsMap())[String(wwiseId(name))] ?? null;
  const entry: (typeof uiAudioLog)[number] = { name, sound };
  uiAudioLog.push(entry);
  if (!sound) return;
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
  source.connect(ctx.destination);
  source.start();
  entry.played = true;
}
