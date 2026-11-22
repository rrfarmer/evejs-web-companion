<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { onMount } from "svelte";
  import WindowActionItems from "./WindowActionItems.svelte";
  import { applyWindowFlags, setWindowFlag, windowFlags, WINDOW_ACTION_WORDS } from "./windowFlags.ts";
  import { captureGameLog, clearGameLog } from "./gameLog.ts";
  import { noticeBoard } from "./notices.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const prefix = "UI/Accessories/Log/";
  const labels = ["CaptureLog", "CopyLog", "ClearLog", "GameLog", "Listener", "SessionStarted"];
  $effect(() => { flow.requestWords([...labels.map((label) => prefix + label), ...WINDOW_ACTION_WORDS]); });
  onMount(() => applyWindowFlags("log"));

  let open = $state(false);
  let root: HTMLElement;
  let trigger: HTMLButtonElement;

  function word(label: string, fallback: string): string {
    const template = $words?.templates[prefix + label];
    return typeof template === "string" && template
      ? plainText(formatTemplate(template, {}, { nameOf: () => "" }))
      : fallback;
  }

  function capture() {
    return captureGameLog({
      title: word("GameLog", "Game Log"),
      listener: word("Listener", "Listener"),
      started: word("SessionStarted", "Session started"),
    });
  }

  function close(): void {
    open = false;
    trigger.focus();
  }

  function download(): void {
    const { filename, text } = capture();
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    close();
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(capture().text);
    } catch {
      noticeBoard.post({ kind: "warn", title: "Could not copy the game log" });
    }
    close();
  }
</script>

<svelte:window onpointerdown={(event) => { if (open && !root.contains(event.target as Node)) open = false; }}
  onkeydown={(event) => { if (open && event.key === "Escape") { event.stopPropagation(); close(); } }} />

<div class="game-log-actions" bind:this={root}>
  <button type="button" class="win-btn" title="Log actions" aria-label="Log actions"
    aria-expanded={open} aria-controls="game-log-actions-menu" bind:this={trigger}
    onpointerdown={(event) => event.stopPropagation()} onclick={() => (open = !open)}>⋯</button>
  {#if open}
    <div id="game-log-actions-menu" class="log-menu" role="menu" aria-label="Log actions">
      <WindowActionItems id="log" lightByDefault={true}
        compact={{ on: windowFlags("log").compact, toggle: () => setWindowFlag("log", "compact", !windowFlags("log").compact) }} word={(label, own) => { const t = $words?.templates[label]; return typeof t === "string" && t ? plainText(formatTemplate(t, {}, { nameOf: () => "" })) : own; }} onDone={() => (open = false)} />
      <button type="button" role="menuitem" onpointerdown={(event) => event.stopPropagation()}
        onclick={download}>{word("CaptureLog", "Capture Log")}</button>
      <button type="button" role="menuitem" onpointerdown={(event) => event.stopPropagation()}
        onclick={copy}><img class="mi" src="/client-res/ui/texture/eveicon/system_icons/copy_16px.png" alt="" />{word("CopyLog", "Copy Log")}</button>
      <span class="sep" role="separator"></span>
      <button type="button" role="menuitem" class="destructive" onpointerdown={(event) => event.stopPropagation()}
        onclick={() => { clearGameLog(); close(); }}><img class="mi" src="/client-res/ui/texture/eveicon/system_icons/trashcan_16px.png" alt="" />{word("ClearLog", "Clear Log")}</button>
    </div>
  {/if}
</div>

<style>
  .game-log-actions { position: relative; }
  .game-log-actions > .log-menu { left: auto; right: 0; }
  /* LoggerWindow.GetMenuMoreOptions: Copy Log with eveicon.copy, Clear Log with eveicon.trashcan, in the entry's icon slot */
  .mi { position: absolute; left: 4px; top: 50%; width: 16px; height: 16px; transform: translateY(-50%); }
</style>
