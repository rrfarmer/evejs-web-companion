<script lang="ts">
  import { onMount } from "svelte";
  import { getAcademyTravelConversation } from "../app/api.ts";
  import type { Session } from "../app/sessions.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { playUiEvent } from "../play/uiAudio.ts";
  import LabelText from "./LabelText.svelte";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { session }: { session: Session } = $props();
  // svelte-ignore state_referenced_locally
  const { flow, store: { words } } = session;
  const CLOSE = "UI/Conversations/UI/Close";
  const LINE = "UI/Conversations/Dialogue/Lines/AcademyShipCannotLeaveExordium";
  let portrait = $state<string | null>(null);
  let speakerKey = $state("#519116");
  let lineKey = $state(LINE);
  const speaker = $derived(plainText($words.templates[speakerKey] ?? "Aura"));
  const closeLabel = $derived(plainText($words.templates[CLOSE] ?? "Close"));
  const line = $derived($words.templates[lineKey] ?? $words.templates[LINE]
    ?? "Academy ships cannot leave Exordium. Return to a station to board another ship.");

  onMount(() => {
    let current = true;
    flow.requestWords([CLOSE, LINE, speakerKey]);
    void playUiEvent("npe_aura_incoming_transmission_play");
    void getAcademyTravelConversation(flow.requestOptions()).then(record => {
      if (!current || !record) return;
      if (record.textID !== null) lineKey = `#${record.textID}`;
      if (record.speakerID !== null) speakerKey = `#${record.speakerID}`;
      portrait = record.portrait;
      flow.requestWords([lineKey, speakerKey]);
    }).catch(() => {});
    return () => { current = false; };
  });
</script>

<div class="transmission" role="dialog" aria-label={speaker} tabindex="-1">
  {#if portrait}<img alt="" src={clientTexture(portrait)} />{/if}
  <div class="content">
    <header>{speaker}</header>
    <div class="line"><LabelText markup={line} /></div>
    <footer><button type="button" onclick={flow.closeAcademyTravelConversation}>{closeLabel}</button></footer>
  </div>
</div>

<style>
  .transmission {
    position: fixed;
    top: 75px;
    left: clamp(8px, calc(50vw - 215px), 385px);
    z-index: 44;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    box-sizing: border-box;
    width: min(430px, calc(100vw - 16px));
    min-height: 168px;
    max-height: calc(100dvh - 85px);
    overflow: auto;
    color: #edf7ff;
    background: linear-gradient(130deg, #192f40f2, #0a151fee);
    border: 1px solid #789fbc;
    border-radius: 9px 3px;
    box-shadow: 0 0 15px #67aec765, inset 0 0 16px #9adaff30;
  }
  img { align-self: end; width: clamp(95px, 28vw, 150px); height: 100%; min-height: 170px; object-fit: contain; object-position: bottom; }
  .content { grid-column: 2; padding: 8px 10px 10px 8px; }
  .transmission:not(:has(img)) .content { grid-column: 1 / -1; padding-left: 16px; }
  header {
    margin-bottom: 7px;
    padding: 2px 5px;
    color: #d5eeff;
    letter-spacing: .075em;
    text-transform: uppercase;
    border-bottom: 1px solid #82a9c58c;
    background: url("/client-res/ui/texture/classes/conversationui/aurawindowtitlebar.png") center / 100% 100% no-repeat;
  }
  .line { padding: 0 4px; font-size: 13px; line-height: 1.35; }
  footer { display: flex; justify-content: end; margin-top: 8px; }
  button { color: #e8f5ff; background: #243c4f; border: 1px solid #8badc6; border-radius: 2px; padding: 3px 13px; cursor: pointer; }
  button:hover, button:focus-visible { background: #396185; }
</style>
