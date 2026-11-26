<script lang="ts">
  import { onMount } from "svelte";
  import type { ChatChannelAccess, ChatChannelSettings } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, room, close, saved }: {
    store: ClientStore;
    flow: AppFlow;
    room: string;
    close: () => void;
    saved: (value: ChatChannelSettings) => void;
  } = $props();
  const paths = {
    title: "UI/Chat/ChannelConfiguration", general: "UI/Generic/General", name: "UI/Chat/ChannelName",
    password: "UI/Chat/Password", retype: "UI/Chat/RetypePassword", access: "UI/Chat/DefaultAccess",
    motd: "UI/Chat/Motd", allowed: "UI/Chat/Allowed", moderated: "UI/Chat/Moderated", blocked: "UI/Chat/Blocked",
    ok: "UI/Common/Buttons/OK", cancel: "UI/Common/Buttons/Cancel",
  } as const;
  const words = $derived(store.words);
  const label = (key: keyof typeof paths, fallback: string) => plainText($words.templates[paths[key]] ?? "") || fallback;
  const unchangedPassword = "__no_change__";
  let dialog: HTMLDialogElement;
  let current = $state<ChatChannelSettings | null>(null);
  let name = $state("");
  let password = $state("");
  let retype = $state("");
  let access = $state<ChatChannelAccess>("allowed");
  let motd = $state("");
  let pending = $state(true);
  let error = $state("");

  onMount(() => {
    let mounted = true;
    dialog.showModal();
    flow.requestWords(Object.values(paths));
    void flow.chatDirectoryChannelSettings(room).then(settings => {
      if (!mounted) return;
      current = settings;
      name = settings.name;
      password = retype = settings.passwordProtected ? unchangedPassword : "";
      access = settings.access ?? "allowed";
      motd = settings.motd;
    }).catch(cause => {
      if (mounted) error = cause instanceof Error ? cause.message : "The channel settings could not be read.";
    }).finally(() => { if (mounted) pending = false; });
    return () => { mounted = false; };
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!current || pending) return;
    error = "";
    const trimmedName = name.trim();
    const changedPassword = password === unchangedPassword || (!current.passwordProtected && !password) ? undefined : password;
    if (current.owner) {
      if (!trimmedName) { error = "Enter a channel name."; return; }
      if (password !== retype) { error = "The passwords do not match."; return; }
      if (changedPassword && (changedPassword.length < 3 || changedPassword !== changedPassword.trim())) {
        error = "Use at least three characters for the password, with no leading or trailing spaces.";
        return;
      }
    }
    pending = true;
    try {
      const change = current.owner ? {
        ...(trimmedName !== current.name ? { name: trimmedName } : {}),
        ...(access !== current.access ? { access } : {}),
        ...(changedPassword !== undefined ? { password: changedPassword } : {}),
        motd,
      } : { motd };
      saved(await flow.chatDirectoryChannelSettings(room, change));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The channel settings could not be saved.";
    } finally {
      pending = false;
    }
  }
</script>

<dialog bind:this={dialog} class="channel-configuration" aria-label={label("title", "Channel Configuration")}
  oncancel={(event) => { event.preventDefault(); if (!current || !pending) close(); }}>
  <form onsubmit={submit}>
    <h2>{label("title", "Channel Configuration")}</h2>
    {#if current}
      <fieldset disabled={pending}>
        <legend>{label("general", "General")}</legend>
        <label>{label("name", "Channel Name")}<input type="text" maxlength="50" bind:value={name} readonly={!current.owner} /></label>
        {#if current.owner}
          <label>{label("password", "Password")}<input type="password" maxlength="20" autocomplete="new-password" bind:value={password} /></label>
          <label>{label("retype", "Re-type Password")}<input type="password" maxlength="20" autocomplete="new-password" bind:value={retype} /></label>
          <label>{label("access", "Default Access")}
            <select bind:value={access}>
              <option value="allowed">{label("allowed", "Allowed")}</option>
              <option value="moderated">{label("moderated", "Moderated")}</option>
              <option value="blocked">{label("blocked", "Blocked")}</option>
            </select>
          </label>
        {/if}
        <label class="message">{label("motd", "MOTD")}<textarea rows="6" maxlength="4000" bind:value={motd}></textarea></label>
      </fieldset>
    {:else if pending}
      <p role="status">Reading channel settings…</p>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="actions">
      <button type="submit" disabled={!current || pending}>{label("ok", "OK")}</button>
      <button type="button" disabled={!!current && pending} onclick={close}>{label("cancel", "Cancel")}</button>
    </div>
  </form>
</dialog>

<style>
  .channel-configuration { width: min(27rem, calc(100vw - 2rem)); border: 1px solid var(--color-accent); color: var(--color-text); background: var(--color-bg, #0b1119); }
  .channel-configuration::backdrop { background: #0009; }
  h2 { margin: 0 0 1rem; }
  fieldset { min-width: 0; display: grid; gap: 0.6rem; }
  label { display: grid; grid-template-columns: 1fr minmax(0, 12rem); align-items: center; gap: 0.5rem; }
  label.message { grid-template-columns: minmax(0, 1fr); }
  textarea { resize: vertical; }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
</style>
