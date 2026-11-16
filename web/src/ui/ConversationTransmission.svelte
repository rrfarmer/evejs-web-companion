<script lang="ts">
  import { onMount } from "svelte";
  import { playUiEvent } from "../play/uiAudio.ts";
  import LabelText from "./LabelText.svelte";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { speaker, line, closeLabel, portrait, close }: {
    speaker: string; line: string; closeLabel: string; portrait: string | null; close: () => void;
  } = $props();

  onMount(() => { void playUiEvent("npe_aura_incoming_transmission_play"); });
</script>

<div class="transmission" role="dialog" aria-label={speaker} tabindex="-1">
  {#if portrait}<img alt="" src={clientTexture(portrait)} />{/if}
  <div class="content">
    <header>{speaker}</header>
    <div class="line"><LabelText markup={line} /></div>
    <footer><button type="button" onclick={close}>{closeLabel}</button></footer>
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
