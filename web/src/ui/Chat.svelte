<script lang="ts">
  // Local/Corp and private conversations, each with its own roster and history.
  // The page's chatConversations controller owns private creation, invitations
  // and sending order; the BFF holds the XMPP connection. The active backlog is
  // polled while this panel is open, and the per-session invitation listener
  // keeps private membership current even when this panel is put away.
  //
  // A message is shown by its markup as the client's chat shows it (the editor's markup: bridge/mailMarkup.ts). Its
  // links are followed when clicked as the client's link registry follows them (ui/linkFollowers.ts: skill plans, Show
  // Info, the web), each in its colour and with its hint; any other link is underlined with its url as its hint. A link dragged onto the send box (a skill plan's share
  // button: SkillPlanDragData.get_link) is put in at the caret as its markup.
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { createChatPoller } from "../app/chatPoll.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ChatChannel } from "../store/types.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { mailBodyLines } from "../bridge/mailMarkup.ts";
  import { labelEscaped } from "../bridge/labelMarkup.ts";
  import { LINK_DRAG_TYPE } from "../bridge/skillPlanLink.ts";
  import { OVERVIEW_PROFILE_DRAG_TYPE } from "../bridge/overviewProfileLink.ts";
  import { ITEM_FILTER_DRAG_TYPE, readInventoryFilters, writeInventoryFilters } from "../bridge/inventoryFilters.ts";
  import { ASSET_ITEM_DRAG_MIME, decodeAssetItemDrag } from "./dragDrop.ts";
  import { droppedFittingDrag, isFittingDrag } from "./fittingDrag.ts";
  import type { DroppedLink } from "../app/flow.ts";
  import { itemLinksFromDrop, LINK_WORDS, linkFollowerOf, startLinkDrag, type ItemLink } from "./linkFollowers.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { doubleClickOwner } from "./ownerDoubleClick.ts";
  import { dragCharacter } from "./characterDrag.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import { chatWordPattern } from "../bridge/chatWordFilters.ts";
  import ChatWordFilters from "./ChatWordFilters.svelte";

  let { store, flow, unread, openSkillPlanLink = null, openInventoryFilterLink = null }: {
    store: ClientStore;
    flow: AppFlow;
    unread?: ReadonlySet<string>;
    /** A skill plan's link in a message, clicked. */
    openSkillPlanLink?: ((url: string) => void) | null;
    openInventoryFilterLink?: ((url: string) => void) | null;
  } = $props();

  // svelte-ignore state_referenced_locally
  const chat = store.chat;
  // svelte-ignore state_referenced_locally
  const conversations = flow.conversations.state;
  const activity = $derived(flow.conversations.activity);
  const bannedWords = $derived(chatWordPattern($activity.filters.bannedWords, true));
  const highlightedWords = $derived(chatWordPattern($activity.filters.highlightWords, true));
  const channelMenu = new ContextMenu();
  const BLINK_LABEL = "UI/Chat/BlinkOnNewActivity";
  const FILTERS_LABEL = "UI/Chat/ConfigureWordFiltersAndHighlights";
  let wordFiltersOpen = $state(false);
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const live = store.live;

  // R7d — resolve each channel's identity to a NAME: Local → its solar system,
  // Corp → the corporation. Batched + cached by the flow; the raw room string
  // (local_<systemID> / corp_<corpID>) is never rendered.
  $effect(() => {
    const refs: NameRef[] = [];
    if ($chat.local.solarSystemID) {
      refs.push({ kind: "system", id: $chat.local.solarSystemID });
    }
    if ($chat.corp.corporationID) {
      refs.push({ kind: "corporation", id: $chat.corp.corporationID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // R10 — messages now arrive live over the push channel, so the backlog poll
  // drops to a slow safety net while the channel is delivering and snaps back
  // to the old fast cadence whenever it is not. The poll still covers roster
  // changes (which the channel does not carry) and keeps the held session warm.
  // ⚠ GUARDED. `createChatPoller` arms a plain interval, so without this a slow
  // chat read stacks up beat on beat and the requests it displaces from the
  // browser's connection pool are the ones that visibly fail. See
  // app/skipWhileBusy.ts.
  const chatBeat = skipWhileBusy(refresh);
  const poller = createChatPoller({
    status: () => store.get().live.status,
    refresh: () => void chatBeat(),
  });
  let busy = $state(false);
  let error = $state("");
  let draft = $state("");
  let drafts: Record<string, string> = {}, draftFor = "";
  const activeKey = $derived($conversations.active ?? $chat.activeChannel);
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const pilotID = $derived($station.online?.characterID ?? null);
  $effect(() => {
    const key = `${pilotID}:${activeKey}`;
    untrack(() => { if (draftFor) drafts[draftFor] = draft; draftFor = key; draft = drafts[key] ?? ""; });
  });
  let sendBox = $state<HTMLInputElement | undefined>(undefined);

  // svelte-ignore state_referenced_locally
  const words = store.words;
  function linkWord(label: string): string {
    const template = $words.templates[label];
    return plainText(formatTemplate(typeof template === "string" ? template : LINK_WORDS[label] ?? "", {}, { nameOf: () => "" }));
  }

  function openChannelMenu(event: MouseEvent | KeyboardEvent, channel: string) {
    event.preventDefault();
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const pointer = event instanceof MouseEvent && (event.clientX || event.clientY) ? event : null;
    channelMenu.open(pointer?.clientX ?? bounds.left, pointer?.clientY ?? bounds.bottom, [
      {
        label: linkWord(BLINK_LABEL) || "Blink on New Activity", path: BLINK_LABEL,
        checked: !$activity.disabled.has(channel), checkbox: true, run: () => flow.conversations.toggleActivityBlink(channel),
      },
      {
        label: linkWord(FILTERS_LABEL) || "Configure Word Filters and Highlights", path: FILTERS_LABEL,
        run: () => { wordFiltersOpen = true; },
      },
    ]);
  }

  function displayWords(text: string): readonly { text: string; highlighted?: boolean }[] {
    const cleaned = bannedWords ? text.replace(bannedWords, "***") : text;
    if (!highlightedWords) return [{ text: cleaned }];
    const runs: { text: string; highlighted?: boolean }[] = [];
    let end = 0;
    for (const match of cleaned.matchAll(highlightedWords)) {
      if (match.index > end) runs.push({ text: cleaned.slice(end, match.index) });
      runs.push({ text: match[0], highlighted: true });
      end = match.index + match[0].length;
    }
    if (end < cleaned.length) runs.push({ text: cleaned.slice(end) });
    return runs;
  }

  /** How a link in a message is followed (ui/linkFollowers.ts: the client's link registry), or null where it is not. */
  function followerOf(url: string, text: string) {
    return linkFollowerOf(url, flow, openSkillPlanLink, linkWord, text, openInventoryFilterLink);
  }

  /** chat/client/const.py MAX_MESSAGE_LENGTH: the most the chat's text holds, its tags counted (EditPlainText countWithTags). */
  const MAX_MESSAGE_LENGTH = 1024;

  /** A link or a fitting dragged over the send box is taken. */
  function linkDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types;
    if (types?.includes(LINK_DRAG_TYPE) || types?.includes(OVERVIEW_PROFILE_DRAG_TYPE) || types?.includes(ITEM_FILTER_DRAG_TYPE) || types?.includes(ASSET_ITEM_DRAG_MIME) || isFittingDrag(event)) event.preventDefault();
  }

  // eveEditPlainText adds links in scroll order, preserving the text on either side of the caret.
  async function insertItemLinks(links: readonly ItemLink[]): Promise<void> {
    const original = draft;
    const channel = store.get().chat.activeChannel;
    const at = sendBox?.selectionStart ?? original.length;
    let inserted = "";
    for (const { url, text } of links) {
      const markup = await flow.droppedLinkMarkup({ kind: "link", url, text: labelEscaped(text) }, {
        length: original.length + inserted.length + (at > 0 && !inserted ? 2 : 1), selected: 0, max: MAX_MESSAGE_LENGTH,
      });
      if (markup === null) break;
      inserted += (at > 0 && !inserted ? " " : "") + markup + " ";
    }
    if (!inserted || draft !== original || store.get().chat.activeChannel !== channel) return;
    draft = original.slice(0, at) + inserted + original.slice(at);
    await tick();
    sendBox?.setSelectionRange(at + inserted.length, at + inserted.length);
  }

  /**
   * A link or a fitting dropped on the send box (eveEditPlainText.OnDropData): its markup (<a href="url">text</a>,
   * evelink.Link; a fitting's its link, format_fitting_url) put in at the caret, as the room left lets it
   * (flow.droppedLinkMarkup). What was dropped is read before any await, as a drop's data can only be.
   */
  function linkDropped(event: DragEvent): void {
    const assetRows = decodeAssetItemDrag(event.dataTransfer?.getData(ASSET_ITEM_DRAG_MIME));
    if (assetRows.length > 0) {
      event.preventDefault();
      void insertItemLinks(assetRows.map(row => ({
        url: `showinfo:${row.typeID}//${row.itemID}${row.shipOwnerID === null ? "" : `//${row.shipOwnerID}`}`,
        text: row.name,
      }))).catch(() => {});
      return;
    }
    const profileRaw = event.dataTransfer?.getData(OVERVIEW_PROFILE_DRAG_TYPE);
    let profile: DroppedLink | null = null;
    if (profileRaw) {
      try {
        const p = JSON.parse(profileRaw) as { text?: unknown; data?: unknown };
        if (typeof p.text === "string" && p.data && typeof p.data === "object") profile = { kind: "overviewProfile", text: p.text, data: p.data as Record<string, unknown> };
      } catch { /* not one */ }
    }
    const filterRaw = profile === null ? event.dataTransfer?.getData(ITEM_FILTER_DRAG_TYPE) : null;
    if (filterRaw) {
      try {
        const p = JSON.parse(filterRaw) as { text?: unknown; filter?: unknown };
        // the filter read back as a kept one is, so that only a well-formed filter is shared
        const filter = readInventoryFilters(writeInventoryFilters([p.filter as never]))[0];
        if (typeof p.text === "string" && filter) profile = { kind: "itemFilter", text: p.text, filter };
      } catch { /* not one */ }
    }
    const fitting = profile === null ? droppedFittingDrag(event) : null;
    const raw = fitting === null && profile === null ? event.dataTransfer?.getData(LINK_DRAG_TYPE) : null;
    if (profile === null && fitting === null && !raw) return;
    event.preventDefault();
    let dropped: DroppedLink;
    if (profile !== null) {
      dropped = profile;
    } else if (fitting?.kind === "source") {
      dropped = { kind: "fittingSource", source: fitting.source };
    } else if (fitting !== null) {
      dropped = { kind: "fitting", shipTypeID: fitting.fitting.shipTypeID, fitData: fitting.fitting.fitData, name: fitting.fitting.name };
    } else {
      let link: unknown;
      try {
        link = JSON.parse(raw ?? "");
      } catch {
        return;
      }
      if (Array.isArray(link)) {
        const links = itemLinksFromDrop(link);
        if (links.length > 0) void insertItemLinks(links).catch(() => {});
        return;
      }
      if (!link || typeof link !== "object" || !("url" in link) || !("text" in link) ||
          typeof link.url !== "string" || typeof link.text !== "string") return;
      dropped = { kind: "link", url: link.url, text: link.text };
    }
    const at = sendBox?.selectionStart ?? draft.length;
    const selected = Math.abs((sendBox?.selectionEnd ?? at) - at);
    void flow.droppedLinkMarkup(dropped, { length: draft.length, selected, max: MAX_MESSAGE_LENGTH }).then((markup) => {
      if (markup === null) return;
      const place = Math.min(at, draft.length);
      draft = draft.slice(0, place) + markup + draft.slice(place);
    }).catch(() => {});
  }

  const CHANNELS: readonly { id: ChatChannel; label: string }[] = [
    { id: "local", label: "Local" },
    { id: "corp", label: "Corp" },
  ];

  function currentChannel(): ChatChannel {
    return store.get().chat.activeChannel;
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error =
          panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  async function refresh(): Promise<void> {
    await run(() => flow.conversations.state.get().active ? flow.conversations.refresh() : flow.loadChat(currentChannel()));
  }

  async function switchChannel(channel: ChatChannel): Promise<void> {
    if (channel === currentChannel() && flow.conversations.state.get().active === null) {
      return;
    }
    flow.setChatChannel(channel);
    await refresh();
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text) {
      return;
    }
    const channel = currentChannel(), room = flow.conversations.state.get().active, key = draftFor;
    await run(async () => {
      if (room) await flow.conversations.send(room, text); else await flow.sendChatMessage(channel, text);
      if (draftFor === key) draft = ""; else drafts[key] = "";
    });
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void send();
  }

  onMount(() => {
    flow.requestWords([...Object.keys(LINK_WORDS), BLINK_LABEL, FILTERS_LABEL]);
    void refresh();
    poller.start();
  });

  // Re-arm the poll cadence when the live channel connects or drops.
  $effect(() => {
    void $live.status;
    poller.sync();
  });

  onDestroy(() => {
    // Closing the tab stops polling.
    poller.stop();
    channelMenu.close();
  });

  // The active channel's decoded state (roster + backlog).
  const activeRoom = $derived($conversations.rooms.find(room => room.channel === $conversations.active) ?? null);
  const active = $derived(activeRoom?.state ?? $chat[$chat.activeChannel]);
  const localMode = $derived(!activeRoom && $chat.activeChannel === "local" ? active.roomName?.split("_")[0] : undefined);
  const delayedLocal = $derived(localMode === "wormhole" || localMode === "nullsec" || localMode === "triglavian");

  // A line's speaker is named from the table of owners, as the client's window names it (xmppchatsvc.py
  // _HandleMessageFromAdmin: window.Receive(charid), cfg.eveowners), not from the room's roster alone: the room's own
  // voice (its message of the day) speaks as owner 1, the EVE System, who is in no roster and came out "Character 1".
  // The roster's name stands while the owner's is asked for.
  $effect(() => {
    const ids = new Set(active.messages.map((message) => message.characterID).filter((id) => id > 0));
    if (localMode) for (const member of active.roster) ids.add(member.characterID);
    if (ids.size > 0) flow.requestNames([...ids].map((id) => ({ kind: "owner" as const, id })));
  });
  function speakerName(message: { readonly characterID: number; readonly characterName: string }): string {
    return resolvedName($names.resolved, "owner", message.characterID, message.characterName);
  }

  // The active channel's resolved name (Local → system, Corp → corporation), or
  // "" while it resolves — the header then shows just "Local" / "Corp", never the
  // raw room string.
  const channelName = $derived(
    $chat.activeChannel === "corp"
      ? resolvedName($names.resolved, "corporation", active.corporationID, "")
      : resolvedName($names.resolved, "system", active.solarSystemID, ""),
  );
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Chat</h2>
  </header>
  <nav class="tabs" style="flex-wrap: wrap">
    {#each CHANNELS as channel (channel.id)}
      <button
        type="button"
        class:active={$conversations.active === null && $chat.activeChannel === channel.id}
        data-unread={unread?.has(channel.id) || undefined}
        disabled={busy}
        oncontextmenu={(event) => openChannelMenu(event, channel.id)}
        onkeydown={(event) => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") openChannelMenu(event, channel.id); }}
        onclick={() => switchChannel(channel.id)}
      >
        {channel.label}
      </button>
    {/each}
    {#each $conversations.rooms as room (room.channel)}
      <button type="button" class:active={$conversations.active === room.channel} data-unread={unread?.has(room.channel) || undefined}
        disabled={busy} onclick={() => flow.conversations.select(room.channel)}
        oncontextmenu={(event) => openChannelMenu(event, room.channel)}
        onkeydown={(event) => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") openChannelMenu(event, room.channel); }}>{room.title}</button>
    {/each}
    {#if activeRoom}<button type="button" class="minor" disabled={busy || $conversations.busy} aria-label="Close conversation" onclick={() => run(() => flow.conversations.close(activeRoom!.channel))}>×</button>{/if}
    <button type="button" disabled={busy} onclick={() => refresh()}>Refresh</button>
  </nav>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $conversations.error}<p class="error">{$conversations.error}</p>{/if}
  {#if $chat.error}
    <p class="error">{$chat.error}</p>
  {/if}
</section>

<section data-chat-active={activeRoom?.channel ?? $chat.activeChannel}>
  <h2>
    {activeRoom?.title ?? ($chat.activeChannel === "corp" ? "Corp" : "Local")}
    {#if !activeRoom && channelName}<span class="note">· {channelName}</span>{/if}
  </h2>
  {#if !active.loaded}
    <p class="note">Loading…</p>
  {:else if localMode === "nolocal"}
    <p class="note">Local chat is unavailable in this system.</p>
  {:else if !activeRoom && $chat.activeChannel === "corp" && active.corporationID === null}
    <p class="note">This character is not in a corporation.</p>
  {:else}
    <div class="chat-grid">
      <div class="messages">
        <h3>Messages</h3>
        {#if active.messages.length === 0}
          <p class="empty">No recent messages.</p>
        {:else}
          <ul class="message-list">
            {#each active.messages as message, index (index)}
              <li>
                <span class="author">{speakerName(message)}</span>:
                <span class="body">{#each mailBodyLines(message.message) as line, place (place)}{#if place > 0}<br />{/if}{#each line as run, at (at)}{@const follower = run.link === null ? null : followerOf(run.link, run.text)}{#if follower !== null}<button type="button" class="evelink {follower.kind}" title={follower.hint} onclick={follower.follow} draggable="true" ondragstart={(event) => startLinkDrag(event, run.link ?? "", run.text)}>{@render filteredWords(run.text)}</button>{:else}<span class:chat-bold={run.bold} class:chat-italic={run.italic} class:chat-underline={run.underline || run.link !== null} title={run.link ?? undefined}>{@render filteredWords(run.text)}</span>{/if}{/each}{/each}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      <div class="roster">
        <h3>{delayedLocal ? "Recent speakers" : `Members (${active.roster.length})`}</h3>
        {#if active.roster.length === 0}
          <p class="empty">No members visible.</p>
        {:else}
          <ul class="roster-list">
            {#each active.roster as member (member.characterID)}
              <li draggable="true" ondragstart={event => dragCharacter(event, member.characterID, member.name)}
                ondblclick={() => void run(() => doubleClickOwner(flow, member.characterID))}>{localMode ? resolvedName($names.resolved, "owner", member.characterID, member.name) : member.name}</li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>

    <form class="send-box" onsubmit={onSubmit}>
      <input
        type="text"
        bind:this={sendBox}
        bind:value={draft}
        ondragover={linkDragOver}
        ondrop={linkDropped}
        maxlength={MAX_MESSAGE_LENGTH}
        placeholder={`Message ${activeRoom?.title ?? ($chat.activeChannel === "corp" ? "Corp" : "Local")}…`}
        disabled={busy}
      />
      <button type="submit" disabled={busy || draft.trim().length === 0}>Send</button>
    </form>
  {/if}
</section>

{#snippet filteredWords(text: string)}
  {#each displayWords(text) as word}{#if word.highlighted}<strong class="chat-highlight">{word.text}</strong>{:else}{word.text}{/if}{/each}
{/snippet}
{#if wordFiltersOpen}<ChatWordFilters {store} {flow} close={() => { wordFiltersOpen = false; }} />{/if}

<style>
  .chat-highlight { color: #64c75b; }
  .tabs button[data-unread="true"] { box-shadow: inset 0 -2px rgb(243, 144, 88); }
  .chat-bold { font-weight: 700; }
  .chat-italic { font-style: italic; }
  .chat-underline { text-decoration: underline; }
  .chat-grid {
    display: grid;
    grid-template-columns: 1fr minmax(140px, 220px);
    gap: 1rem;
    align-items: start;
  }
  .message-list,
  .roster-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 20rem;
    overflow-y: auto;
  }
  .message-list li {
    padding: 0.15rem 0;
  }
  .message-list .author {
    font-weight: 600;
  }
  .roster-list li {
    padding: 0.1rem 0;
  }
  .send-box {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .send-box input {
    flex: 1;
  }
  @media (max-width: 640px) {
    .chat-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
