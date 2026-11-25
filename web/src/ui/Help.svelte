<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, showChat }: { store: ClientStore; flow: AppFlow; showChat: () => void } = $props();
  const labels = {
    chatHint: "UI/Help/JoinChannelHint",
    join: "UI/Help/JoinChannel",
    supportHint: "UI/Help/HelpCenterDescription",
    support: "UI/Help/OpenHelpCenterFinal",
  };
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? "").trim() || fallback;
  onMount(() => flow.requestWords(Object.values(labels)));

  let joining = $state(false);
  let error = $state("");
  async function joinHelp() {
    joining = true;
    error = "";
    try {
      await flow.conversations.openHelpChannel();
      showChat();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      joining = false;
    }
  }
</script>

<div class="eve-help">
  <section>
    <p>{word(labels.chatHint, "Join the help channel to ask other players for help.")}</p>
    <button type="button" disabled={joining} onclick={joinHelp}>{word(labels.join, "Join Channel")}</button>
    {#if error}<p role="alert">{error}</p>{/if}
  </section>
  <section>
    <p>{word(labels.supportHint, "Browse the Help Center or contact EVE Online support.")}</p>
    <a href="https://support.eveonline.com/hc/en-us/requests/new" target="_blank" rel="noopener noreferrer">{word(labels.support, "Open Help Center")}</a>
  </section>
</div>

<style>
  .eve-help { padding: 0 12px; }
  section { display: grid; justify-items: end; gap: 8px; padding: 12px 0; }
  section + section { border-top: 1px solid var(--line, #39444b); }
  p { justify-self: stretch; margin: 0; line-height: 1.4; }
  a { color: inherit; border: 1px solid var(--line, #56626b); padding: 5px 9px; text-decoration: none; }
  a:hover, a:focus-visible { background: #ffffff18; }
  [role="alert"] { color: #fc9c95; }
</style>
