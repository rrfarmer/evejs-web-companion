<script lang="ts">
  // safeLogoffTimer.SafeLogoffTimer2 (eve/client/script/ui/inflight/shipHud/safeLogoffTimer.py 90 to 180), the timer
  // gameui.OnSafeLogoffTimerStarted puts up: 300 wide, CENTERTOP 250 down, on a MenuUnderlay; the caption
  // (EveCaptionMedium 20, UI/Inflight/SafeLogoffTimerCaption, or SafeExitTimerCaption with Quit Game chosen), the time
  // left (EveCaptionLarge 24, WARNING_ORANGE, '%.1f' of the time to the end plus a second, every 50 ms; green 0.0 when
  // it runs out), the Log Out / Quit Game radio buttons, and Abort (UI/Commands/Abort: ship.AbortSafeLogoff). Taken
  // down by an abort or a failure (AbortLogoff: 0.85 for a second, then a 0.5 s fade).
  import { onDestroy } from "svelte";

  let { deadlineMs, completed, word, onAbort, onQuitChange }: {
    deadlineMs: number;
    completed: boolean;
    word: (label: string, own: string) => string;
    onAbort: () => void;
    onQuitChange: (quitting: boolean) => void;
  } = $props();

  let now = $state(Date.now());
  const tick = setInterval(() => { now = Date.now(); }, 50);
  onDestroy(() => clearInterval(tick));
  let quitting = $state(false);
  const left = $derived(completed ? "0.0" : Math.max(0.1, (deadlineMs - now + 1000) / 1000).toFixed(1));
  const caption = $derived(quitting ? word("UI/Inflight/SafeExitTimerCaption", "Safe exit in progress") : word("UI/Inflight/SafeLogoffTimerCaption", "Safe logoff in progress"));
  const hint = $derived(quitting ? word("UI/Inflight/SafeExitTimerHint", "") : word("UI/Inflight/SafeLogoffTimerHint", ""));
  function choose(q: boolean): void { quitting = q; onQuitChange(q); }
</script>

<div class="safe-logoff" title={hint || undefined} data-safe-logoff>
  <div class="sl-caption">{caption}</div>
  <div class="sl-timer" class:done={completed}>{left}</div>
  <div class="sl-choices">
    <label><input type="radio" name="safe-logoff-choice" checked={!quitting} onchange={() => choose(false)} />{word("UI/Inflight/SafeLogoffLogOutCb", "Log out")}</label>
    <label><input type="radio" name="safe-logoff-choice" checked={quitting} onchange={() => choose(true)} />{word("UI/Inflight/SafeLogoffQuitGameCb", "Quit game")}</label>
  </div>
  <div class="sl-buttons"><button type="button" class="client-btn" disabled={completed} onclick={onAbort}>{word("UI/Commands/Abort", "Abort")}</button></div>
</div>

<style>
  .safe-logoff { position: absolute; left: 50%; top: 250px; transform: translateX(-50%); width: 300px; z-index: 40;
    background: rgba(20, 22, 24, 0.92); border: 1px solid rgba(255, 255, 255, 0.15); padding-top: 16px; text-align: center; pointer-events: auto; }
  .sl-caption { font-size: 20px; color: rgba(255, 255, 255, 0.9); padding: 0 25px; }
  .sl-timer { font-size: 24px; margin-top: 16px; color: rgb(243, 144, 88); }
  .sl-timer.done { color: rgb(0, 255, 0); }
  .sl-choices { margin-top: 16px; display: inline-flex; flex-direction: column; gap: 12px; text-align: left; font-size: 14px; color: rgba(255, 255, 255, 0.75); }
  .sl-choices label { display: flex; gap: 6px; align-items: center; }
  .sl-buttons { padding: 16px 0; }
</style>
