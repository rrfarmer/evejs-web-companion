<script lang="ts">
  // agencyNew/ui/contentPages/contentPageHelp.ContentPageHelp (20 padding): the video browser (a Section, 0.3 of the width,
  // UI/Agency/HelpVideos/BrowserHeader) - a quick filter (24 high; three letters or more filter each group's videos by
  // name) over the scroll of the video groups (ListGroup, each its name, empty ones left out), each open showing its
  // videos (VideoScrollEntry: menuPlay_Icon 16, the name; the chosen one HIGHLIGHT_COLOR and its description under it)
  // - and the video section (20 apart; its header the chosen video's name, else NoVideoSelected; EntryMessage in the
  // centre until a video is chosen; the video player, looping, with the previous and next entries).
  // Not here (later parts): the subtitles (GetSubtitlePathForVideo), the player's own controls and the sequence of the
  // group's videos, dragging a video's link.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const H = "UI/Agency/HelpVideos/";
  const word = (label: string) => plainText(formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  type Data = NonNullable<Awaited<ReturnType<AppFlow["agencyHelpVideos"]>>>;
  let data = $state<Data | null | undefined>(undefined);
  let open = $state<number[]>([]), chosen = $state<number | null>(null), search = $state("");
  $effect(() => { void flow.agencyHelpVideos().then((d) => { data = d; }); });
  $effect(() => {
    flow.requestWords([`${H}BrowserHeader`, `${H}NoVideoSelected`, `${H}EntryMessage`, `${H}VideoLinkHelp`,
      ...(data ? [...data.groups.map((g) => g.nameID), ...Object.values(data.videos).flatMap((v) => [v.nameID, v.descriptionID])] : []).filter((x): x is number => !!x).map((x) => `#${x}`)]);
  });
  const message = (id: number | null) => (id ? word(`#${id}`) : "");
  /** GetScrollEntries: each group's videos (filtered by name from three letters on), the empty groups left out. */
  const groups = $derived((data?.groups ?? []).map((g) => ({ ...g, list: g.videos.filter((id) => {
    const v = data?.videos[String(id)];
    return !!v && (search.trim().length < 3 || message(v.nameID).toLowerCase().includes(search.trim().toLowerCase()));
  }) })).filter((g) => g.list.length));
  const order = $derived(groups.flatMap((g) => (open.includes(g.id) ? g.list : [])));
  const video = $derived(chosen !== null ? data?.videos[String(chosen)] ?? null : null);
  /** SelectNextEntry / SelectPreviousEntry: the next or previous video of the open groups. */
  function step(by: number): void {
    const i = chosen === null ? -1 : order.indexOf(chosen);
    const next = order[i + by];
    if (next !== undefined) chosen = next;
  }
</script>

<div class="ahp">
  <section class="ahp-section ahp-browser">
    <h3>{word(`${H}BrowserHeader`)}</h3>
    <input class="ahp-search" type="search" value={search} oninput={(e) => (search = e.currentTarget.value)} />
    <div class="ahp-scroll">
      {#each groups as g (g.id)}
        <button type="button" class="ahp-group" onclick={() => (open = open.includes(g.id) ? open.filter((x) => x !== g.id) : [...open, g.id])}>
          <span class="ahp-arrow">{open.includes(g.id) ? "▾" : "▸"}</span>{message(g.nameID)}</button>
        {#if open.includes(g.id)}
          {#each g.list as id (id)}
            {@const v = data?.videos[String(id)]}
            <button type="button" class="ahp-video" class:on={chosen === id} title={word(`${H}VideoLinkHelp`)} onclick={() => (chosen = id)}>
              <img alt="" src={clientTexture("res:/UI/Texture/classes/agency/helpSection/menuPlay_Icon.png")} />{message(v?.nameID ?? null)}</button>
            {#if chosen === id && v?.descriptionID}<p class="ahp-desc">{message(v.descriptionID)}</p>{/if}
          {/each}
        {/if}
      {/each}
    </div>
  </section>
  <section class="ahp-section ahp-player">
    <h3>{video ? message(video.nameID) : word(`${H}NoVideoSelected`)}</h3>
    {#if video?.path}
      <!-- (The subtitles, GetSubtitlePathForVideo, are a later part.) -->
      <!-- svelte-ignore a11y_media_has_caption -->
      {#key video.path}<video autoplay loop controls src={clientTexture(video.path)}></video>{/key}
      <div class="ahp-steps"><button type="button" onclick={() => step(-1)}>‹</button><button type="button" onclick={() => step(1)}>›</button></div>
    {:else}<p class="ahp-entry">{word(`${H}EntryMessage`)}</p>{/if}
  </section>
</div>

<style>
  .ahp { display: flex; gap: 20px; height: 100%; min-height: 0; box-sizing: border-box; }
  .ahp-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; display: flex; flex-direction: column; min-height: 0; }
  .ahp-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .ahp-browser { width: 30%; flex: none; }
  .ahp-search { height: 24px; box-sizing: border-box; }
  .ahp-scroll { flex: 1; min-height: 0; overflow: auto; margin-top: 5px; }
  .ahp-group { all: unset; box-sizing: border-box; cursor: pointer; display: flex; gap: 6px; width: 100%; padding: 4px 6px; font-size: 13px; background: rgb(255 255 255 / 0.05); margin-bottom: 1px; }
  .ahp-arrow { width: 10px; }
  .ahp-video { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 8px; width: 100%; height: 25px; padding-left: 8px; font-size: 12px; }
  .ahp-video img { width: 16px; height: 16px; opacity: 0.75; }
  .ahp-video:hover img { opacity: 1; }
  .ahp-video.on { background: rgb(255 255 255 / 0.1); }
  .ahp-video.on img { filter: sepia(1) hue-rotate(150deg) saturate(3); }
  .ahp-desc { margin: 2px 0 6px 28px; max-width: 250px; font-size: 12px; opacity: 0.8; }
  .ahp-player { flex: 1; min-width: 0; }
  .ahp-player video { flex: 1; min-height: 0; width: 100%; background: #000; }
  .ahp-steps { display: flex; justify-content: center; gap: 10px; padding-top: 6px; }
  .ahp-entry { margin: auto; max-width: 200px; text-align: center; font-size: 16px; }
</style>
