<script lang="ts">
  import { onMount } from "svelte";
  import type { ChatAccessList, ChatChannelAccess, ChatChannelSettings } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import ChatChannelAccessList from "./ChatChannelAccessList.svelte";

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
  let tab = $state<"general" | ChatAccessList>("general");
  let changingAccess = $state(false);
  const generalForm = $props.id();

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
    if (!current || pending || changingAccess) return;
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
    if (tab !== "general" && trimmedName === current.name && (!current.owner || access === current.access && changedPassword === undefined) && motd === current.motd) {
      close();
      return;
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
  oncancel={(event) => { event.preventDefault(); if (!changingAccess && (!current || !pending)) close(); }}>
  <h2>{label("title", "Channel Configuration")}</h2>
  {#if current}
    <nav class="channel-tabs" aria-label="Channel settings">
      <button type="button" aria-pressed={tab === "general"} disabled={pending || changingAccess} onclick={() => { tab = "general"; }}>{label("general", "General")}</button>
      <button type="button" aria-pressed={tab === "allowed"} disabled={pending || changingAccess} onclick={() => { tab = "allowed"; }}>{label("allowed", "Allowed")}</button>
      <button type="button" aria-pressed={tab === "blocked"} disabled={pending || changingAccess} onclick={() => { tab = "blocked"; }}>{label("blocked", "Blocked")}</button>
    </nav>
  {/if}
  <form id={generalForm} hidden={tab !== "general"} onsubmit={submit}>
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
  </form>
  {#if tab !== "general"}
    {#key tab}<ChatChannelAccessList {store} {flow} {room} list={tab} bind:mutating={changingAccess} />{/key}
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="actions">
    <button type="submit" form={generalForm} disabled={!current || pending || changingAccess}>{label("ok", "OK")}</button>
    <button type="button" disabled={!!current && pending || changingAccess} onclick={close}>{label("cancel", "Cancel")}</button>
  </div>
</dialog>

<style>
  .channel-configuration { width: min(27rem, calc(100vw - 2rem)); border: 1px solid var(--color-accent); color: var(--color-text); background: var(--color-bg, #0b1119); }
  .channel-configuration::backdrop { background: #0009; }
  h2 { margin: 0 0 1rem; }
  fieldset { min-width: 0; display: grid; gap: 0.6rem; }
  label { display: grid; grid-template-columns: 1fr minmax(0, 12rem); align-items: center; gap: 0.5rem; }
  label.message { grid-template-columns: minmax(0, 1fr); }
  textarea { resize: vertical; }
  .channel-tabs { display: flex; gap: 0.5rem; margin-bottom: 0.65rem; }
  .channel-tabs button[aria-pressed="true"] { border-color: var(--color-accent); }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
</style>
