<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ChatPasswordAnswer } from "../app/chatConversations.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, name, retry, finish }: {
    store: ClientStore; flow: AppFlow; name: string; retry: boolean; finish: (answer: ChatPasswordAnswer) => void;
  } = $props();
  const words = $derived(store.words);
  const paths = {
    title: "UI/Menusvc/PasswordRequired", channel: "UI/Chat/PasswordRequired",
    prompt: "UI/Menusvc/PleaseEnterPassword", retry: "UI/Menusvc/PleaseTryEnteringPasswordAgain",
    remember: "UI/Chat/SavePassword", join: "UI/Chat/ChannelWindow/JoinChannel", cancel: "UI/Common/Cancel",
  } as const;
  function text(key: keyof typeof paths, fallback: string): string {
    const template = $words.templates[paths[key]];
    return template ? plainText(formatTemplate(template, { channelName: name }, { nameOf: () => name })) : fallback;
  }
  let dialog: HTMLDialogElement;
  let field: HTMLInputElement;
  let password = $state("");
  let remember = $state(false);

  onMount(() => {
    flow.requestWords(Object.values(paths));
    dialog.showModal();
    field.focus();
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (password.trim()) finish({ password: password.trim(), remember });
  }
</script>

<dialog bind:this={dialog} class="chat-channel-password" aria-label={text("title", "Password Required")} data-retry={retry}
  oncancel={(event) => { event.preventDefault(); finish(null); }}>
  <h2>{text("title", "Password Required")}</h2>
  <p>{text("channel", `${name} requires a password.`)}</p>
  <form onsubmit={submit}>
    <label>{retry ? text("retry", "Please try entering the password again.") : text("prompt", "Please enter the password.")}
      <input type="password" bind:this={field} bind:value={password} autocomplete="off" required />
    </label>
    <label class="remember"><input type="checkbox" bind:checked={remember} />{text("remember", "Save Password")}</label>
    <div class="actions">
      <button type="submit" disabled={!password.trim()}>{text("join", "Join Channel")}</button>
      <button type="button" onclick={() => finish(null)}>{text("cancel", "Cancel")}</button>
    </div>
  </form>
</dialog>

<style>
  dialog { width: min(320px, calc(100vw - 2rem)); color: var(--color-text); background: var(--color-panel); border: 1px solid var(--color-line); }
  form, label:not(.remember) { display: grid; gap: 0.5rem; }
  .actions { display: flex; justify-content: end; gap: 0.5rem; }
</style>
