<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { AppFlow } from "../app/flow.ts";
  import type { ChatDirectoryChannel } from "../app/api.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words);
  const conversations = $derived(flow.conversations.state);
  const joinedRooms = $derived($conversations.rooms.map(room => room.channel).sort().join(","));
  const paths = {
    channelName: "UI/Chat/ChannelName",
    name: "UI/Chat/ChannelWindow/Name",
    members: "UI/Chat/ChannelWindow/Members",
    player: "UI/Chat/ChannelWindow/PlayerChannels",
    owned: "UI/Chat/ChannelWindow/MyChannels",
  } as const;
  const locale = (path: string, fallback: string) => plainText($words.templates[path] ?? "") || fallback;

  let channels = $state.raw<readonly ChatDirectoryChannel[]>([]);
  let exact = $state.raw<readonly ChatDirectoryChannel[] | null>(null);
  let query = $state("");
  let loading = $state(true);
  let searching = $state(false);
  let error = $state("");
  let request = 0;
  const visibleRooms = new SvelteSet<string>();
  let roomObserver: IntersectionObserver | null = null;
  let counts = $state.raw<ReadonlyMap<string, number>>(new Map());
  let tabVisible = $state(true);

  function observeRoom(node: HTMLElement, roomName: string) {
    roomObserver?.observe(node);
    return { destroy() { roomObserver?.unobserve(node); visibleRooms.delete(roomName); } };
  }

  $effect(() => {
    // The client refreshes the channel list when the current pilot joins or leaves.
    void joinedRooms;
    const rooms = [...visibleRooms];
    if (!tabVisible || rooms.length === 0) return;
    let current = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        // The bridge accepts at most 32 rooms in one request.
        const batches = [];
        for (let at = 0; at < rooms.length; at += 32) batches.push(flow.readChatChannelMembers(rooms.slice(at, at + 32)));
        const results = await Promise.allSettled(batches);
        if (!current) return;
        const next = new Map(counts);
        for (const room of rooms) next.delete(room);
        for (const result of results) if (result.status === "fulfilled") {
          for (const [room, count] of result.value) next.set(room, count);
        }
        counts = next;
      } finally {
        pending = false;
      }
    };
    const first = setTimeout(refresh, 50);
    // Default client interval in globalConfig.const.
    const timer = setInterval(refresh, 300_000);
    return () => { current = false; clearTimeout(first); clearInterval(timer); };
  });

  function systemLabels(roomName: string) {
    return /^system_(\d+)_(\d+)$/.exec(roomName);
  }
  function requestDirectoryWords(rows: readonly ChatDirectoryChannel[]) {
    const labels = new Set<string>();
    for (const { roomName } of rows) {
      const ids = systemLabels(roomName);
      if (ids) { labels.add(`#${ids[1]}`); labels.add(`#${ids[2]}`); }
    }
    if (labels.size) flow.requestWords([...labels]);
  }
  function channelName(row: ChatDirectoryChannel) {
    const ids = systemLabels(row.roomName);
    const name = plainText(row.name);
    if (!ids) return name || row.roomName;
    const translated = locale(`#${ids[2]}`, name || row.roomName);
    return name && name !== translated ? `${translated} (${name})` : translated;
  }
  function channelGroup(row: ChatDirectoryChannel) {
    const ids = systemLabels(row.roomName);
    if (ids) return { id: `system:${ids[1]}`, label: locale(`#${ids[1]}`, "System Channels") };
    if (row.roomName.startsWith("player_")) {
      return row.affiliation === "owner" ? { id: "owned", label: locale(paths.owned, "My Channels") } :
        { id: "player", label: locale(paths.player, "Player Channels") };
    }
    return { id: "system", label: "System Channels" };
  }
  const groups = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const grouped = new Map<string, { id: string; label: string; channels: { roomName: string; label: string }[] }>();
    for (const row of exact ?? channels) {
      const label = channelName(row);
      if (exact === null && needle && !label.toLowerCase().includes(needle) && !row.roomName.toLowerCase().includes(needle)) continue;
      const group = channelGroup(row);
      const existing = grouped.get(group.id) ?? { ...group, channels: [] };
      existing.channels.push({ roomName: row.roomName, label });
      grouped.set(group.id, existing);
    }
    return [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label));
  });

  onMount(() => {
    let mounted = true;
    roomObserver = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        const room = (target as HTMLElement).dataset.roomName;
        if (!room || !target.isConnected) continue;
        if (isIntersecting) visibleRooms.add(room);
        else visibleRooms.delete(room);
      }
    });
    const updateTabVisibility = () => { tabVisible = !document.hidden; };
    updateTabVisibility();
    document.addEventListener("visibilitychange", updateTabVisibility);
    flow.requestWords(Object.values(paths));
    void flow.readChatChannelDirectory(null).then(rows => {
      if (!mounted) return;
      channels = rows;
      requestDirectoryWords(rows);
    }).catch(() => { if (mounted) error = "The chat directory is unavailable."; }).finally(() => {
      if (mounted) loading = false;
    });
    return () => {
      mounted = false;
      request++;
      roomObserver?.disconnect();
      document.removeEventListener("visibilitychange", updateTabVisibility);
    };
  });

  function changeQuery(value: string) {
    query = value;
    request++;
    exact = null;
    searching = false;
    error = "";
  }
  async function findChannel(event: SubmitEvent) {
    event.preventDefault();
    const value = query.trim();
    if (!value || searching) return;
    const serial = ++request;
    searching = true;
    error = "";
    try {
      const rows = await flow.readChatChannelDirectory(value);
      if (serial !== request) return;
      exact = rows;
      requestDirectoryWords(rows);
    } catch {
      if (serial === request) error = "The channel search is unavailable.";
    } finally {
      if (serial === request) searching = false;
    }
  }
</script>

<form class="controls channel-search" onsubmit={findChannel}>
  <input type="search" class="grow" maxlength="60" aria-label={locale(paths.channelName, "Channel Name")}
    placeholder={locale(paths.channelName, "Channel Name")} value={query} oninput={(event) => changeQuery(event.currentTarget.value)} />
  <button type="submit" disabled={!query.trim() || searching}>Find Channel</button>
</form>
{#if error}
  <p class="error" role="alert">{error}</p>
{:else if loading || searching}
  <p role="status">{searching ? "Finding channel…" : "Reading channels…"}</p>
{/if}
{#if groups.length}
  <table class="guests channel-directory">
    <thead><tr><th scope="col">{locale(paths.name, "Name")}</th><th scope="col" class="num">{locale(paths.members, "Members")}</th></tr></thead>
    {#each groups as group (group.id)}
      <tbody>
        <tr><th scope="rowgroup" colspan="2">{group.label}</th></tr>
        {#each group.channels as channel (channel.roomName)}
          {@const count = counts.get(channel.roomName)}
          <tr data-room-name={channel.roomName} use:observeRoom={channel.roomName}>
            <td>{channel.label}</td>
            <td class="num" data-members={count}>{count ? count.toLocaleString() : ""}</td>
          </tr>
        {/each}
      </tbody>
    {/each}
  </table>
{:else if !loading && !searching && !error}
  <p class="empty" role="status">{query.trim() ? "No channels match." : "No channels are available."}</p>
{/if}

<style>
  .channel-search { margin-bottom: 0.75rem; }
  .channel-directory th[scope="rowgroup"] { color: var(--color-text-bright); }
  .channel-directory td { padding-inline-start: 0.9rem; }
</style>
