<script lang="ts">
  import { onMount } from "svelte";
  import { bridgeAsk } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { activePvpEvents, eventDate, eventInteger, pvpEventOf, type PvPEvent } from "../bridge/pvpFilamentEvents.ts";
  import { isListValue, readDictEntry } from "../bridge/wire.ts";
  import { clientTexture } from "../play/window.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import { showMarketDetails } from "./marketDetails.ts";
  import { showInfo } from "./showInfo.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const live = $derived(store.live);
  const station = $derived(store.station);
  const prefix = "UI/PVPFilament/EventWindow/";
  const icon = clientTexture("res:/UI/Texture/WindowIcons/provingGrounds.png");
  const fields = ["rank", "wins", "losses", "draws"] as const;
  const labels = ["Rank", "Wins", "Losses", "Draws"];
  const dates = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  let event = $state.raw<PvPEvent | null>(null);
  let next = $state.raw<Date | null>(null);
  let active = $state(false);
  let loading = $state(false);
  let error = $state("");
  let readStarted = $state(0);

  const typeName = (id: number) => resolvedName($names.resolved, "type", id, "Filament");
  const pilotName = (id: number) => resolvedName($names.resolved, "character", id, "Pilot");
  const markup = (key: string) => formatTemplate($words.templates[key] ?? "", {}, { nameOf: (_, id) => typeName(id) });
  const word = (key: string, fallback: string) => plainText(markup(prefix + key)) || fallback;
  const eventTitle = $derived(event ? plainText(markup(`#${event.nameID}`)) || typeName(event.filamentTypeID) : "");

  function noticePayload(method: string) {
    const current = event;
    if (!current) return undefined;
    return $live.notifications.slice().reverse().find(notice => notice.method === method && notice.receivedAtMs >= readStarted &&
      eventInteger(readDictEntry(notice.args[0], "matchTypeID")) === current.matchTypeID &&
      eventInteger(readDictEntry(notice.args[0], "scheduleID")) === current.scheduleID)?.args[0];
  }

  const statistics = $derived(readDictEntry(noticePayload("OnPVPFilamentsCharacterStatistics"), "statistics"));
  const leaderboard = $derived.by(() => {
    const entries = readDictEntry(noticePayload("OnPVPFilamentsLeaderboard"), "entries");
    if (!isListValue(entries)) return null;
    return entries.items.flatMap(row => {
      const characterID = eventInteger(readDictEntry(row, "character_id"));
      const rank = eventInteger(readDictEntry(row, "rank"));
      return characterID && rank && rank <= 100 ? [{ characterID, rank, wins: eventInteger(readDictEntry(row, "wins")) }] : [];
    });
  });

  $effect(() => {
    if (leaderboard?.length) flow.requestNames(leaderboard.map(row => ({ kind: "character", id: row.characterID })));
  });

  async function load() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      const ask = bridgeAsk(flow.requestOptions());
      const activeEvent = activePvpEvents(await ask("pvpFilamentMgr", "GetActiveEvents", []))[0];
      const chosen = activeEvent ?? pvpEventOf(await ask("pvpFilamentMgr", "GetMostRecentEvent", []));
      active = activeEvent !== undefined;
      event = chosen;
      next = chosen && !active ? eventDate(await ask("pvpFilamentMgr", "GetNextEventDate", [])) : null;
      if (!chosen) return;
      flow.requestNames([chosen.filamentTypeID, ...chosen.rewards.map(item => item.typeID)].map(id => ({ kind: "type", id })));
      flow.requestWords([chosen.nameID, chosen.descriptionID, chosen.rulesID, chosen.restrictionsID, chosen.rewardsHintID]
        .filter(Boolean).map(id => `#${id}`));
      const args = [chosen.matchTypeID, chosen.scheduleID];
      readStarted = Date.now();
      await ask("pvpFilamentMgr", "GetCharacterStatistics", args);
      await ask("pvpFilamentMgr", "GetLeaderboard", args);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The event could not be read.";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    flow.requestWords(["InactiveWindow", "InactiveWindowWithDate", "FinalResults", "YourStatistics", "Leaderboard",
      "Rank", "Wins", "Losses", "Draws", "Filament", "OpenMarket", "Rules", "ShipRestrictions", "Rewards"].map(key => prefix + key));
    void load();
  });
</script>

<section class="pvp-events" aria-label="The Proving Grounds">
  {#if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={load}>Retry</button>
  {/if}
  {#if event}
    <div class="event-layout" data-event={active ? "active" : "past"} data-schedule={event.scheduleID}>
      <article class="event-main" class:past={!active}>
        <img class="event-icon" src={icon} width="64" height="64" alt="" />
        {#if !active}<h2>{word("FinalResults", "Final Results")}</h2>{/if}
        <h3>{eventTitle}</h3>
        {#if active}
          {#if event.start && event.end}<p>{dates.format(event.start)} – {dates.format(event.end)}</p>{/if}
          <div class="event-description"><LabelText markup={markup(`#${event.descriptionID}`)} /></div>
          <section class="event-rewards">
            <h4>{word("Rewards", "Rewards")}</h4>
            {#each event.rewards as item (item.typeID)}
              <button type="button" onclick={() => showInfo({ kind: "type", typeID: item.typeID })}>
                <TypeIcon typeID={item.typeID} name={typeName(item.typeID)} />{item.amount.toLocaleString()} × {typeName(item.typeID)}
              </button>
            {/each}
            {#if event.rewardsHintID}<p><LabelText markup={markup(`#${event.rewardsHintID}`)} /></p>{/if}
          </section>
          <section class="event-filament">
            <h4>{word("Filament", "Filament")}</h4>
            <p><TypeIcon typeID={event.filamentTypeID} name={typeName(event.filamentTypeID)} />{typeName(event.filamentTypeID)}</p>
            <button type="button" onclick={() => { if (event) showMarketDetails(event.filamentTypeID); }}>{word("OpenMarket", "Open Market")}</button>
            {#if event.rulesID}<details><summary>{word("Rules", "Rules")}</summary><LabelText markup={markup(`#${event.rulesID}`)} /></details>{/if}
            {#if event.restrictionsID}<details><summary>{word("ShipRestrictions", "Ship Restrictions")}</summary><LabelText markup={markup(`#${event.restrictionsID}`)} /></details>{/if}
          </section>
        {:else if next}
          <p>{word("InactiveWindowWithDate", "Next event")} {dates.format(next)}</p>
        {:else}
          <p>{word("InactiveWindow", "No event is currently active.")}</p>
        {/if}
      </article>
      <aside>
        <h3>{word("YourStatistics", "Your Statistics")}</h3>
        <p>{$station.online?.characterName ?? ""}</p>
        <dl>
          {#each fields as key, index (key)}
            <div><dt>{word(labels[index]!, labels[index]!)}</dt><dd>{eventInteger(readDictEntry(statistics, "rank")) > 0
              ? eventInteger(readDictEntry(statistics, key)).toLocaleString() : "–"}</dd></div>
          {/each}
        </dl>
        <h3>{word("Leaderboard", "Leaderboard")}</h3>
        {#if leaderboard?.length}
          <ol>
            {#each leaderboard as row (row.characterID)}
              <li><span>{row.rank}</span><button type="button" onclick={() => showInfo({ kind: "character", characterID: row.characterID })}>{pilotName(row.characterID)}</button><span>{row.wins} {word("Wins", "Wins")}</span></li>
            {/each}
          </ol>
        {:else if loading}
          <p role="status">Loading leaderboard…</p>
        {:else if leaderboard !== null}
          <p>No leaderboard entries.</p>
        {/if}
      </aside>
    </div>
  {:else if loading}
    <p role="status">Loading events…</p>
  {:else if !error}
    <div class="inactive"><img src={icon} width="64" height="64" alt="" /><h2>{word("InactiveWindow", "No event is currently active.")}</h2></div>
  {/if}
</section>

<style>
  .pvp-events { padding: 16px; min-height: 100%; box-sizing: border-box; }
  .inactive { min-height: 380px; display: grid; place-content: center; justify-items: center; gap: 16px; }
  .event-layout { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 14px; }
  .event-main, aside { border: 1px solid var(--line, #39444b); padding: 14px; }
  .event-main.past { display: grid; align-content: center; justify-items: center; text-align: center; min-height: 380px; }
  .event-layout h2, .event-layout h3, h4 { margin: 6px 0; }
  .event-rewards, .event-filament { margin-top: 14px; border-top: 1px solid var(--line, #39444b); padding-top: 8px; }
  .event-rewards button, .event-filament p { display: inline-flex; gap: 8px; align-items: center; }
  details { margin-top: 8px; }
  dl { display: flex; gap: 8px; flex-wrap: wrap; }
  dl div { min-width: 48px; text-align: center; padding: 6px; background: rgb(255 255 255 / 0.06); }
  dd { margin: 4px 0 0; }
  ol { list-style: none; padding: 0; }
  li { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  @media (max-width: 690px) { .event-layout { grid-template-columns: 1fr; } }
</style>
