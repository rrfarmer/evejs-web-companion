<script lang="ts">
  // The new HUD's safety badge's selector (hud/client/utility_buttons/safety_badge.py SafetyBadge, _HoverSelector:
  // shipSafetyButton.SafetyLevelSelector, SELECTOR_WIDTH 280): opened by a hover on the badge after the expand
  // (EXPAND_SEC 0.15 s), it stays while the pointer is over the badge or it, and goes SELECTOR_LINGER_MS (0.3 s)
  // after the pointer leaves both. What a press does is SafetyChooser's: a level higher or the same is set at once, a
  // lower one wants its confirm.
  import { isSessionLost } from "../app/flow.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { safetyChoices, safetyPress, type SafetyBadge, type SafetyLevel, type SafetyLocks, type SafetyChoice } from "../space/crimewatch.ts";
  import SafetyMenu from "./SafetyMenu.svelte";
  import { plainText } from "../bridge/clientWords.ts";
  let { flow, safety, locks, anchor, onhover, onleave, words }: {
    flow: AppFlow;
    safety: SafetyBadge;
    locks: SafetyLocks;
    /** The badge's box, or null while the selector is shut. */
    anchor: DOMRect | null;
    onhover: () => void;
    onleave: () => void;
    /** The words the page has (store.words' templates). */
    words: Readonly<Record<string, string | null | undefined>>;
  } = $props();
  const LABELS = ["UI/Crimewatch/SafetyLevel/SafetySettingsCaption", "UI/Crimewatch/SafetyLevel/SafetyLevelSelectionBody", "UI/Common/Confirm",
    "UI/Crimewatch/SafetyLevel/SafetyConfirmHint", "UI/Crimewatch/SafetyLevel/SafetyButtonLocked", "UI/Crimewatch/SafetyLevel/SafetyButtonNoneOptionHintAlphaLocked",
    ...["None", "Partial", "Full"].flatMap((l) => [`UI/Crimewatch/SafetyLevel/SafetyButton${l}`, `UI/Crimewatch/SafetyLevel/SafetyButton${l}OptionHint`])];
  $effect(() => { flow.requestWords(LABELS); });
  // (the hints' markup and colour tags dropped: a title carries text)
  const say = (label: string, own: string): string => {
    const t = words[label];
    return typeof t === "string" && t !== "" ? plainText(t.replace(/\{[^}]*color[^}]*\}/gi, "")).replace(/\r\n/g, "\n") : own;
  };
  let confirming = $state<SafetyLevel | null>(null);
  let setting = $state(false);
  let error = $state("");
  const choices = $derived(safetyChoices(safety.level, locks));
  $effect(() => { if (anchor === null) { confirming = null; error = ""; } });
  async function set(level: SafetyLevel): Promise<void> {
    if (setting) return;
    setting = true;
    error = "";
    try {
      await flow.setSafetyLevel(level);
      onleave();
    } catch (cause) {
      error = isSessionLost(cause) ? "The live session ended (idle timeout or another client took over)." : panelErrorWords(cause);
    } finally {
      setting = false;
      confirming = null;
    }
  }
  function press(choice: SafetyChoice): void {
    const does = safetyPress(choice, confirming);
    if (does === "confirm") confirming = choice.level;
    else if (does === "set") void set(choice.level);
  }
</script>

{#if anchor}
  <div class="hud-safety-pop" role="group" style:left="{Math.max(8, Math.min(anchor.left + anchor.width / 2 - 140, window.innerWidth - 288))}px"
    style:bottom="{window.innerHeight - anchor.top + 6}px" onmouseenter={onhover} onmouseleave={onleave}>
    <SafetyMenu {choices} {confirming} {setting} {locks} {error} {say} onpress={press} onconfirm={(level) => void set(level)} oncancel={() => { confirming = null; }} />
  </div>
{/if}

<style>
  .hud-safety-pop { position: fixed; width: 280px; z-index: 100001; background: rgba(6, 10, 12, 0.92); border: 1px solid rgba(255, 255, 255, 0.15); padding: 6px; }
</style>
