<script lang="ts">
  // The safety selector as it stands: its three buttons, and the two that
  // confirm a lower level or let it go (shipSafetyButton.SafetyLevelSelector).
  //
  // What a press does is the chooser's (SafetyChooser.svelte). This says what
  // there is to press: a button that would do nothing cannot be pressed, the
  // level now is marked, and each level has beside it what it lets the ship
  // do, or the two buttons while it waits to be confirmed.
  import { safetyPress, type SafetyChoice, type SafetyLevel, type SafetyLocks } from "../space/crimewatch.ts";

  let { choices, confirming, setting, locks, error, onpress, onconfirm, oncancel, say }: {
    choices: readonly SafetyChoice[];
    confirming: SafetyLevel | null;
    setting: boolean;
    locks: SafetyLocks;
    error: string;
    onpress: (choice: SafetyChoice) => void;
    onconfirm: (level: SafetyLevel) => void;
    oncancel: () => void;
    /**
     * The client's words (SafetyLevelSelector, 3698585), where given: the caption and body, each level's button
     * (shipSafetyConst.ACTION_LABEL) in its colour with its option hint (STATE_HINT) for a hint, Full's button as
     * Safety Locked where the level is held at Full, and the confirm button (UI/Common/Confirm, SafetyConfirmHint).
     */
    say?: (label: string, own: string) => string;
  } = $props();
  const ACTION = ["UI/Crimewatch/SafetyLevel/SafetyButtonNone", "UI/Crimewatch/SafetyLevel/SafetyButtonPartial", "UI/Crimewatch/SafetyLevel/SafetyButtonFull"] as const;
  const ACTION_OWN = ["Disable safety", "Partial safety", "Enable safety"] as const;
  const HINT = ["UI/Crimewatch/SafetyLevel/SafetyButtonNoneOptionHint", "UI/Crimewatch/SafetyLevel/SafetyButtonPartialOptionHint", "UI/Crimewatch/SafetyLevel/SafetyButtonFullOptionHint"] as const;
  /** shipSafetyConst.COLOR: crimewatchConst.Colors Red, Yellow, Green. */
  const COLOR = ["#DD0000", "#FBB338", "#29F24B"] as const;
</script>

{#if say}
<div class="safety-menu client" role="group" aria-label="Safety level">
  <b class="safety-caption">{say("UI/Crimewatch/SafetyLevel/SafetySettingsCaption", "Safety Settings")}</b>
  <p class="safety-body">{say("UI/Crimewatch/SafetyLevel/SafetyLevelSelectionBody", "Reduced safety levels allow actions which may result in the loss of your ship without further warning.")}</p>
  {#each choices as choice (choice.level)}
    <div class="safety-row">
      <button type="button" class="safety-choice" style:color={COLOR[choice.level]} class:selected={choice.selected}
        aria-pressed={choice.selected} disabled={setting || safetyPress(choice, confirming) === "nothing"}
        title={[...(choice.level === 0 && locks.alpha ? [say("UI/Crimewatch/SafetyLevel/SafetyButtonNoneOptionHintAlphaLocked", "")] : []), say(HINT[choice.level], choice.says)].filter(Boolean).join("\n\n")}
        onclick={() => onpress(choice)}
      >{choice.level === 2 && locks.full ? say("UI/Crimewatch/SafetyLevel/SafetyButtonLocked", "Safety Locked") : say(ACTION[choice.level], ACTION_OWN[choice.level])}</button>
      {#if confirming === choice.level}
        <button type="button" class="safety-confirm" style:color={COLOR[choice.level]} disabled={setting}
          title={say("UI/Crimewatch/SafetyLevel/SafetyConfirmHint", "Reducing safety may result in unexpected ship loss. You have been warned!")}
          onclick={() => onconfirm(choice.level)}>{say("UI/Common/Confirm", "Confirm")}</button>
      {/if}
    </div>
  {/each}
  {#if error}<p class="safety-error" role="alert">{error}</p>{/if}
</div>
{:else}
<div class="safety-menu" role="group" aria-label="Safety level">
  {#if locks.full}
    <p class="safety-note">The security of this system holds the safety at Full.</p>
  {:else if locks.alpha}
    <p class="safety-note">An alpha clone cannot set the safety to None in high security.</p>
  {/if}
  {#each choices as choice (choice.level)}
    <div class="safety-row">
      <button
        type="button"
        class="safety-choice safety-{choice.tone}"
        aria-pressed={choice.selected}
        disabled={setting || safetyPress(choice, confirming) === "nothing"}
        onclick={() => onpress(choice)}
      >{choice.word}</button>
      {#if confirming === choice.level}
        <button type="button" class="safety-confirm" disabled={setting} onclick={() => onconfirm(choice.level)}>
          {setting ? "Setting…" : `Confirm ${choice.word}`}
        </button>
        <button type="button" class="safety-cancel" disabled={setting} onclick={oncancel}>Cancel</button>
      {:else}
        <span class="safety-says">{choice.says}</span>
      {/if}
    </div>
  {/each}
  {#if error}<p class="safety-error" role="alert">{error}</p>{/if}
</div>

{/if}
