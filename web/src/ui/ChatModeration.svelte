<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { ChatMember } from "../store/types.ts";

  let { store, flow, room, action, member, close }: {
    store: ClientStore; flow: AppFlow; room: string; action: "mute" | "kick"; member: ChatMember; close: () => void;
  } = $props();
  const words = $derived(store.words);
  const titlePath = $derived(action === "mute" ? "UI/Chat/GagCharacter" : "UI/Chat/KickCharacter");
  const label = (path: string, fallback: string) => {
    const text = $words.templates[path];
    return text ? plainText(formatTemplate(text, { char: member.characterID }, { nameOf: () => member.name })) : fallback;
  };
  const title = $derived(label(titlePath, `${action === "mute" ? "Mute" : "Kick"} ${member.name}`));
  let dialog: HTMLDialogElement;
  let minutes = $state(30);
  let reason = $state("");
  let busy = $state(false);
  let error = $state("");

  onMount(() => {
    dialog.showModal();
    flow.requestWords([titlePath, "UI/Chat/LengthMinutes", "UI/Chat/Reason", "UI/Common/Buttons/OK", "UI/Common/Buttons/Cancel"]);
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !Number.isInteger(minutes) || minutes < 0 || minutes > 43200) return;
    busy = true;
    error = "";
    try {
      await flow.conversations.moderate(room, member.characterID, action, minutes, reason);
      close();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The channel action could not be completed.";
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} class="chat-moderation" aria-label={title}
  oncancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
  <h2>{title}</h2>
  <form onsubmit={submit}>
    <label>{label("UI/Chat/LengthMinutes", "Length (minutes)")}
      <input type="number" min="0" max="43200" step="1" required bind:value={minutes} disabled={busy} />
    </label>
    <label>{label("UI/Chat/Reason", "Reason")}
      <textarea maxlength="255" bind:value={reason} disabled={busy}></textarea>
    </label>
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="actions">
      <button type="submit" disabled={busy}>{label("UI/Common/Buttons/OK", "OK")}</button>
      <button type="button" disabled={busy} onclick={close}>{label("UI/Common/Buttons/Cancel", "Cancel")}</button>
    </div>
  </form>
</dialog>

<style>
  dialog { min-width: min(300px, calc(100vw - 2rem)); color: var(--color-text); background: var(--color-panel); border: 1px solid var(--color-line); }
  form, label { display: grid; gap: 0.5rem; }
  textarea { min-height: 4rem; }
  .actions { display: flex; justify-content: end; gap: 0.5rem; }
</style>
