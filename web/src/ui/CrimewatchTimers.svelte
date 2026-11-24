<script lang="ts">
  // The crimewatch timers (eve/client/script/ui/crimewatch/crimewatchTimers.py TimerContainer, on the side panels at
  // (104, 12), 32 high - the live client, gridcheck g264 / g280): each Timer a 46 wide slot (TOLEFT, in the order its
  // timer first came; the rest shift left as one goes) holding a 32 x 32 dial:
  //  - GaugeCircular radius 16, lineWidth 2.5, anticlockwise from the top, its empty ring the colour at ALPHA_EMPTY 0.2;
  //  - the icon 16 x 16 in the timer's colour, scaled in from 0.8 over 0.75 s (ANIM_OVERSHOT);
  //  - the pointer (Crimewatch_TimerPoint_WithShadow.png 15 x 19, clipped to 15 x 13 at (9, -10)) turned with the gauge.
  // SetRatio: the time left over the timer's maxTimeout (CRIMEWATCH_TIMER_DATA, read live in g281: weapons 60 s, NPC
  // 300 s, PvP / suspect / criminal 900 s, retribution 300 s). A timer whose cause goes on (no expiry) is full and
  // PlayActiveAnimation pulses the pointer and gauge 1 / 0.75 each second; in its last BLINK_BEFORE_DONE_TIME 5 s the
  // icon blinks (FlipFlop, 1 s, 5 loops) with its endingAudioEvent; a new or renewed timer plays its resetAudioEvent.
  // Not ported: the rewind sweep on a reset, the end animation, the hint (TimerHint), the at-war icon (the pilot is
  // at war with no one here), the jump / booster / engagement / abyssal timers (the page reads only the five).
  import { crimewatchTimers, type CrimewatchTimerView } from "../space/crimewatch.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "../play/window.ts";
  import { playUiEvent } from "../play/uiAudio.ts";

  let { store }: { store: ClientStore } = $props();
  const flight = store.flight;

  interface TimerLook { icon: string; rgb: string; maxMs: number; start: string; end: string }
  const RED = "221, 0, 0", YELLOW = "251, 179, 56";
  const LOOKS: Record<string, TimerLook> = {
    weapons: { icon: "Crimewatch_Locked", rgb: RED, maxMs: 60000, start: "crimewatch_weapons_timer_play", end: "crimewatch_weapons_timer_end_play" },
    npc: { icon: "Crimewatch_Combat", rgb: YELLOW, maxMs: 300000, start: "crimewatch_log_off_timer_new_play", end: "crimewatch_log_off_timer_end_play" },
    pvp: { icon: "Crimewatch_Combat", rgb: RED, maxMs: 900000, start: "crimewatch_log_off_timer_new_play", end: "crimewatch_log_off_timer_end_play" },
    suspect: { icon: "Crimewatch_SuspectCriminal", rgb: YELLOW, maxMs: 900000, start: "crimewatch_criminal_timer_play", end: "crimewatch_criminal_timer_end_play" },
    criminal: { icon: "Crimewatch_SuspectCriminal", rgb: RED, maxMs: 900000, start: "crimewatch_criminal_timer_play", end: "crimewatch_criminal_timer_end_play" },
    disapproval: { icon: "Crimewatch_Disapproval", rgb: YELLOW, maxMs: 300000, start: "crimewatch_weapons_timer_play", end: "crimewatch_weapons_timer_end_play" },
  };
  const keyOf = (t: CrimewatchTimerView): string => (t.kind === "criminal" && t.word === "Suspect" ? "suspect" : t.kind);

  let now = $state(Date.now());
  $effect(() => { const t = setInterval(() => { now = Date.now(); }, 50); return () => clearInterval(t); });
  const reading = $derived($flight.crimewatch);
  const views = $derived(reading ? crimewatchTimers(reading.states, now + reading.clockOffsetMs) : []);

  // the slots in the order each timer first came
  let order = $state<string[]>([]);
  let lastEnd = new Map<string, number | null>();
  let ending = new Set<string>();
  $effect(() => {
    const present = new Set(views.map(keyOf));
    const next = order.filter((k) => present.has(k));
    for (const v of views) {
      const k = keyOf(v);
      if (!next.includes(k)) next.push(k);
      // SetExpiryTime -> Reset -> Rewind_Thread: the reset sound for a new timer or a later end
      const end = v.remainingMs === null ? null : Math.round((now + v.remainingMs) / 1000);
      const was = lastEnd.get(k);
      if (!lastEnd.has(k) || (end !== null && was !== null && was !== undefined && end > was + 1) || (end === null && was !== null)) void playUiEvent(LOOKS[k]!.start);
      lastEnd.set(k, end);
      if (v.remainingMs !== null && v.remainingMs < 5000 && !ending.has(k)) { ending.add(k); void playUiEvent(LOOKS[k]!.end); }
      if (v.remainingMs === null || v.remainingMs >= 5000) ending.delete(k);
    }
    for (const k of [...lastEnd.keys()]) if (!present.has(k)) { lastEnd.delete(k); ending.delete(k); }
    if (next.join() !== order.join()) order = next;
  });
  const shown = $derived(order.map((k) => ({ k, v: views.find((x) => keyOf(x) === k)! })).filter((x) => x.v));

  const R = 16 - 2.5 / 2;
  const C = 2 * Math.PI * R;
</script>

<div class="cw-timers">
  {#each shown as { k, v } (k)}
    {@const look = LOOKS[k]!}
    {@const ratio = v.remainingMs === null ? 1 : Math.min(1, Math.max(0, v.remainingMs / look.maxMs))}
    <div class="cw-timer" class:active={v.remainingMs === null} class:blink={v.remainingMs !== null && v.remainingMs < 5000} style={`--cw: rgb(${look.rgb})`}>
      <div class="cw-dial">
        <svg class="cw-gauge" viewBox="0 0 32 32" width="32" height="32">
          <circle cx="16" cy="16" r={R} fill="none" stroke-width="2.5" stroke={`rgba(${look.rgb}, 0.2)`} />
          <circle cx="16" cy="16" r={R} fill="none" stroke-width="2.5" stroke={`rgb(${look.rgb})`}
            stroke-dasharray={`${ratio * C} ${C}`} transform="rotate(-90 16 16) scale(1 -1) translate(0 -32)" />
        </svg>
        <div class="cw-pointer" style={`transform: rotate(${-ratio * 360}deg)`}>
          <span class="cw-clip"><span class="cw-ptr" style={`-webkit-mask-image: url("${clientTexture("res:/UI/Texture/Crimewatch/Crimewatch_TimerPoint_WithShadow.png")}"); mask-image: url("${clientTexture("res:/UI/Texture/Crimewatch/Crimewatch_TimerPoint_WithShadow.png")}")`}></span></span>
        </div>
        <span class="cw-icon" style={`-webkit-mask-image: url("${clientTexture(`res:/UI/Texture/Crimewatch/${look.icon}.png`)}"); mask-image: url("${clientTexture(`res:/UI/Texture/Crimewatch/${look.icon}.png`)}")`}></span>
      </div>
    </div>
  {/each}
</div>

<style>
  .cw-timers { position: fixed; left: 104px; top: 12px; height: 32px; display: flex; z-index: 6; pointer-events: none; }
  .cw-timer { width: 46px; height: 32px; flex: none; }
  .cw-dial { position: relative; width: 32px; height: 32px; pointer-events: auto; }
  .cw-gauge { position: absolute; inset: 0; }
  .cw-pointer { position: absolute; inset: 0; }
  .cw-clip { position: absolute; left: 9px; top: -10px; width: 15px; height: 13px; overflow: hidden; }
  .cw-ptr { position: absolute; left: 0; top: 0; width: 15px; height: 19px; background: var(--cw); -webkit-mask-size: 15px 19px; mask-size: 15px 19px; }
  .cw-icon { position: absolute; left: 8px; top: 8px; width: 16px; height: 16px; background: var(--cw); -webkit-mask-size: 16px 16px; mask-size: 16px 16px;
    animation: cw-in 0.75s cubic-bezier(0.34, 1.56, 0.64, 1); }
  @keyframes cw-in { from { transform: scale(0.8); } to { transform: scale(1); } }
  .cw-timer.active .cw-gauge, .cw-timer.active .cw-pointer { animation: cw-pulse 1s step-end infinite; }
  @keyframes cw-pulse { 0% { opacity: 1; } 1% { opacity: 0.75; } 51% { opacity: 1; } }
  .cw-timer.blink .cw-icon { animation: cw-blink 1s step-end 5; }
  @keyframes cw-blink { 0% { opacity: 1; } 1% { opacity: 0; } 51% { opacity: 1; } }
</style>
