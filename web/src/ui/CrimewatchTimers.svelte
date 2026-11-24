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
  // Not ported: the slots' slide left as one goes (ShiftLeft), the at-war icon (the pilot is
  // at war with no one here), the jump / booster / engagement / abyssal timers (the page reads only the five).
  import { crimewatchTimers, type CrimewatchTimerView } from "../space/crimewatch.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "../play/window.ts";
  import { playUiEvent } from "../play/uiAudio.ts";

  let { store }: { store: ClientStore } = $props();
  const flight = store.flight;

  interface TimerLook { icon: string; rgb: string; maxMs: number; start: string; end: string; tip?: string }
  const RED = "221, 0, 0", YELLOW = "251, 179, 56";
  const LOOKS: Record<string, TimerLook> = {
    weapons: { icon: "Crimewatch_Locked", rgb: RED, maxMs: 60000, start: "crimewatch_weapons_timer_play", end: "crimewatch_weapons_timer_end_play", tip: "<b>Weapons Timer</b>\n<b>Cause:</b> Aggression against another capsuleer or activation of some module groups\n<b>Consequence:</b> Unable to dock or use stargates or fitting services" },
    npc: { icon: "Crimewatch_Combat", rgb: YELLOW, maxMs: 300000, start: "crimewatch_log_off_timer_new_play", end: "crimewatch_log_off_timer_end_play", tip: "<b>Non-Capsuleer Log-Off Timer</b>\n<b>Cause:</b> Combat with a non-capsuleer\n<b>Consequence:</b> Ship will remain in space on log-off until timer expires" },
    pvp: { icon: "Crimewatch_Combat", rgb: RED, maxMs: 900000, start: "crimewatch_log_off_timer_new_play", end: "crimewatch_log_off_timer_end_play", tip: "<b>Capsuleer Log-Off Timer</b>\n<b>Cause:</b> Combat with another capsuleer\n<b>Consequence:</b> Ship will remain in space on log-off until timer expires" },
    suspect: { icon: "Crimewatch_SuspectCriminal", rgb: YELLOW, maxMs: 900000, start: "crimewatch_criminal_timer_play", end: "crimewatch_criminal_timer_end_play", tip: "<b>Suspect Timer</b>\n<b>Cause:</b> Committed a \"suspect\"-level offense\n<b>Consequence:</b> Capsuleers may freely engage" },
    criminal: { icon: "Crimewatch_SuspectCriminal", rgb: RED, maxMs: 900000, start: "crimewatch_criminal_timer_play", end: "crimewatch_criminal_timer_end_play", tip: "<b>Criminal Timer</b>\n<b>Cause:</b> Committed a \"criminal\"-level offense\n<b>Consequence:</b> Capsuleers may freely engage. CONCORD will engage in high-sec space" },
    disapproval: { icon: "Crimewatch_Disapproval", rgb: YELLOW, maxMs: 300000, start: "crimewatch_weapons_timer_play", end: "crimewatch_weapons_timer_end_play", tip: "<b>Retribution Timer</b>\n<b>Cause:</b> Committed a retribution-level offense.\n<b>Consequence:</b> Capsuleers may freely engage in Zarzakh. Pirate groups will engage in Zarzakh." },
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
  /** Rewind_Thread: the dial filling from where it was to its new ratio, (distance) x (1 - start) x 500 ms. */
  let rewinds = new Map<string, { from: number; at: number; dur: number }>();
  /** EndAnimation: a timer gone keeps its slot 0.4 s, emptied, its pointer dropping 9 over 0.3 s, scaled to 0.8. */
  let leaving: { k: string; at: number }[] = [];
  const realRatio = (k: string, v: CrimewatchTimerView) => (v.remainingMs === null ? 1 : Math.min(1, Math.max(0, v.remainingMs / LOOKS[k]!.maxMs)));
  function shownRatio(k: string, v: CrimewatchTimerView): number {
    const target = realRatio(k, v);
    const r = rewinds.get(k);
    if (!r) return target;
    const t = r.dur <= 0 ? 1 : (now - r.at) / r.dur;
    if (t >= 1) return target;
    return Math.min(target, r.from + (target - r.from) * t);
  }
  $effect(() => {
    const present = new Set(views.map(keyOf));
    const next = order.filter((k) => present.has(k));
    for (const v of views) {
      const k = keyOf(v);
      if (!next.includes(k)) next.push(k);
      // SetExpiryTime -> Reset -> Rewind_Thread: the reset sound for a new timer or a later end
      const end = v.remainingMs === null ? null : Math.round((now + v.remainingMs) / 1000);
      const was = lastEnd.get(k);
      if (!lastEnd.has(k) || (end !== null && was !== null && was !== undefined && end > was + 1) || (end === null && was !== null)) {
        void playUiEvent(LOOKS[k]!.start);
        const from = lastEnd.has(k) ? shownRatio(k, v) : 0;
        const target = realRatio(k, v);
        rewinds.set(k, { from, at: now, dur: Math.max(0, (target - from) * (1 - from) * 500) });
      }
      lastEnd.set(k, end);
      if (v.remainingMs !== null && v.remainingMs < 5000 && !ending.has(k)) { ending.add(k); void playUiEvent(LOOKS[k]!.end); }
      if (v.remainingMs === null || v.remainingMs >= 5000) ending.delete(k);
    }
    for (const k of [...lastEnd.keys()]) if (!present.has(k)) {
      lastEnd.delete(k); ending.delete(k); rewinds.delete(k);
      leaving = [...leaving.filter((x) => x.k !== k), { k, at: now }];
    }
    leaving = leaving.filter((x) => now - x.at < 400 && !present.has(x.k));
    // a leaving timer keeps its place in the order until it goes
    const kept = order.filter((k) => present.has(k) || leaving.some((x) => x.k === k));
    for (const k of next) if (!kept.includes(k)) kept.push(k);
    if (kept.join() !== order.join()) order = kept;
  });
  const lastViews = new Map<string, CrimewatchTimerView>();
  const shown = $derived(order.map((k) => {
    const v = views.find((x) => keyOf(x) === k);
    if (v) lastViews.set(k, v);
    return { k, v: v ?? lastViews.get(k)!, gone: !v };
  }).filter((x) => x.v));

  // TimerHint (crimewatchHints.py): after 0.25 s with the pointer on the dial, a 300 wide panel at the dial's
  // (+16, +16) on uicore.layer.abovemain, HINT_BACKGROUND_COLOR (0, 0, 0, 0.85) in a HINT_FRAME_COLOR (1, 1, 1, 0.25)
  // frame, fading in over 0.5 s: the time left (FmtTime, MM:SS) in a 20 Label in the timer's colour at 8 of a 58 wide
  // left part, centred, blinking (BlinkOut, 1 s) with the timer's maxTimeout while its cause goes on; the timer's
  // tooltip in EveLabelSmall at 62, 234 wide; as high as the text and 2 x defaultPadding 4. It goes (FadeOut) once,
  // a second after it came, the pointer is neither on it nor on its timer (the live client, gridcheck g282: 300 x 72,
  // the time '00:57' at (8, 24), the text (62, 4) 234 x 64).
  let hint = $state<{ k: string; x: number; y: number; fading: boolean } | null>(null);
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  let hintWatch: ReturnType<typeof setInterval> | null = null;
  let overDial: string | null = null;
  let overHint = false;
  function dialEnter(k: string, el: HTMLElement): void {
    overDial = k;
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      if (overDial !== k || (hint && hint.k === k)) return;
      const r = el.getBoundingClientRect();
      hint = { k, x: r.left + 16, y: r.top + 16, fading: false };
      const shownAt = Date.now();
      if (hintWatch) clearInterval(hintWatch);
      hintWatch = setInterval(() => {
        if (!hint) return;
        if (Date.now() - shownAt > 1000 && overDial !== hint.k && !overHint) {
          clearInterval(hintWatch!); hintWatch = null;
          hint = { ...hint, fading: true };
          setTimeout(() => { hint = null; }, 250);
        }
      }, 200);
    }, 250);
  }
  function dialLeave(k: string): void { if (overDial === k) overDial = null; }
  const mmss = (ms: number) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
  const hintView = $derived(hint ? views.find((v) => keyOf(v) === hint!.k) ?? null : null);

  const R = 16 - 2.5 / 2;
  const C = 2 * Math.PI * R;
</script>

<div class="cw-timers">
  {#each shown as { k, v, gone } (k)}
    {@const look = LOOKS[k]!}
    {@const ratio = gone ? 0 : shownRatio(k, v)}
    <div class="cw-timer" class:gone class:active={v.remainingMs === null} class:blink={v.remainingMs !== null && v.remainingMs < 5000} style={`--cw: rgb(${look.rgb})`}>
      <div class="cw-dial" role="timer" onmouseenter={(e) => dialEnter(k, e.currentTarget)} onmouseleave={() => dialLeave(k)}>
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
{#if hint}
  {@const look = LOOKS[hint.k]!}
  <div class="cw-hint" class:fading={hint.fading} role="tooltip" style={`left: ${hint.x}px; top: ${hint.y}px`}
    onmouseenter={() => { overHint = true; }} onmouseleave={() => { overHint = false; }}>
    <div class="cw-hint-time" class:blinking={hintView !== null && hintView.remainingMs === null} style={`color: rgb(${look.rgb})`}>
      {hintView === null ? "00:00" : hintView.remainingMs === null ? mmss(look.maxMs) : mmss(hintView.remainingMs)}</div>
    <div class="cw-hint-text">{@html (look.tip ?? "").replace(/\n/g, "<br>")}</div>
  </div>
{/if}

<style>
  .cw-timers { position: fixed; left: 104px; top: 12px; height: 32px; display: flex; z-index: 6; pointer-events: none; }
  .cw-hint { position: fixed; width: 300px; z-index: 26; display: flex; align-items: center; background: rgba(0, 0, 0, 0.85);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25); animation: cw-hint-in 0.5s; transition: opacity 0.25s; }
  .cw-hint.fading { opacity: 0; }
  @keyframes cw-hint-in { from { opacity: 0; } to { opacity: 1; } }
  .cw-hint-time { width: 58px; box-sizing: border-box; flex: none; padding-left: 8px; font: 20px 'EVE Sans Neue', 'Segoe UI', sans-serif; line-height: 25px; }
  .cw-hint-time.blinking { animation: cw-hint-blink 1s infinite; }
  @keyframes cw-hint-blink { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
  .cw-hint-text { width: 238px; box-sizing: border-box; padding: 4px 0 4px 4px; font: 12px/16px 'EVE Sans Neue', 'Segoe UI', sans-serif; color: rgba(255, 255, 255, 0.75); }
  .cw-timer.gone .cw-dial { transform: scale(0.8); transition: transform 0.4s; }
  .cw-timer.gone .cw-ptr { transform: translateY(9px); transition: transform 0.3s; }
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
