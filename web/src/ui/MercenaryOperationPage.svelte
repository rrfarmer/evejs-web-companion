<script lang="ts">
  import type { DungeonData } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatInterval, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ShipRestrictions } from "../bridge/dungeonTracking.ts";
  import type { BookmarkPlace } from "../bridge/locationsList.ts";
  import type { MercenaryDenActivity } from "../bridge/mercenaryDens.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import { solarSystemMenu, solarSystemMenuWords } from "./solarSystemMenu.ts";
  import MercenaryOperationTrackButton from "./MercenaryOperationTrackButton.svelte";
  import MercenaryOperationTravel from "./MercenaryOperationTravel.svelte";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, operation, name, onBack, onShowSystem, onShowMapBrowser, completed = false }: {
    store: ClientStore; flow: AppFlow; operation: MercenaryDenActivity; name: string; onBack: () => void;
    onShowSystem?: (systemID: number) => void;
    onShowMapBrowser?: (systemID: number) => void;
    completed?: boolean;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const system = $derived(resolvedName($names.resolved, "system", operation.solarSystemID, String(operation.solarSystemID)));
  const dungeonID = $derived(operation.dungeonID);
  let intel = $state.raw<DungeonData | null>(null);
  let restrictions = $state.raw<ShipRestrictions | null>(null);
  let now = $state(Date.now());
  let starting = $state(false);
  let startedHere = $state("");
  let failure = $state<{ id: string; message: string } | null>(null);
  let bookmark = $state.raw<BookmarkPlace | null>(null);
  const systemMenu = new ContextMenu();
  const started = $derived(operation.started || operation.id === startedHere);
  const labels = {
    back: ["UI/Commands/Back", "Back"],
    category: ["UI/Sovereignty/MercenaryDen/ConfigurationWindow/ActivitiesTitle", "Mercenary Tactical Operations"],
    status: ["UI/Agency/MercDen/Status", "Status"],
    ready: ["UI/Agency/MercDen/ReadyToStart", "Ready to Start"],
    started: ["UI/Agency/MercDen/InProgress", "In Progress"],
    completed: ["UI/Generic/Completed", "Completed"],
    intel: ["UI/Dungeons/GameplayDescriptionHeader", "Operational Intel"],
    description: ["UI/Common/Description", "Description"],
    impacts: ["UI/Agency/MercDen/JobDetailHeader", "Mercenary Den"],
    difficulty: ["UI/Agency/ContentDifficulty", "Difficulty"],
    level: ["UI/Agency/LevelX", "Level {level}"],
    enemy: ["UI/Agency/RoamingEnemies", "Roaming Enemies"],
    restrictions: ["UI/Objectives/Titles/ShipRestrictions", "Ship Restrictions"],
    start: ["UI/Sovereignty/MercenaryDen/StartOperation", "Start Operation"],
    startHint: ["UI/Sovereignty/MercenaryDen/StartMTOAtMercDen", "Start Operation at Den"],
    development: ["UI/Sovereignty/MercenaryDen/DevelopmentImpact", "Development Impact {impact}"],
    anarchy: ["UI/Sovereignty/MercenaryDen/AnarchyImpact", "Anarchy Impact {impact}"],
    bonus: ["UI/Sovereignty/MercenaryDen/InfomorphBonus", "Infomorph Bonus {bonus}"],
    expires: ["UI/Common/Expires", "Expires"],
  } as const;
  const word = (key: keyof typeof labels, args: Record<string, string | number> = {}) =>
    plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1], args, { nameOf: () => "" }));
  const message = (id: number | null | undefined) => id ? plainText($words.templates[`#${id}`] ?? "").trim() : "";
  const description = $derived(message(operation.descriptionID));
  const gameplay = $derived(message(intel?.gameplayDescriptionID));
  const enemy = $derived(intel?.factionID && intel.factionID !== 500021 ? resolvedName($names.resolved, "owner", intel.factionID, "") : "");
  function openSystemMenu(x: number, y: number) {
    const id = operation.solarSystemID;
    const name = system;
    systemMenu.open(x, y, solarSystemMenu(store, flow, id, () => name, place => { bookmark = place; }, onShowSystem, onShowMapBrowser));
  }
  async function startOperation() {
    if (starting || started || completed) return;
    const selected = operation;
    starting = true;
    failure = null;
    try {
      if (await flow.startMercenaryOperation(selected)) startedHere = selected.id;
    } catch (cause) {
      failure = { id: selected.id, message: panelErrorWords(cause) };
    } finally {
      starting = false;
    }
  }
  $effect(() => {
    const id = dungeonID;
    let current = true;
    intel = null;
    restrictions = null;
    if (id > 0) {
      void flow.loadMercenaryOperationIntel(id).then(result => { if (current) intel = result; }, () => {});
      void flow.readDungeonShipRestrictions(id).then(result => { if (current) restrictions = result; }, () => {});
    }
    return () => { current = false; };
  });
  $effect(() => {
    const messages = [intel?.gameplayDescriptionID, intel?.archetypeTitleID, intel?.archetypeDescriptionID]
      .filter((id): id is number => Boolean(id)).map(id => `#${id}`);
    flow.requestWords([...Object.values(labels).map(([path]) => path), ...solarSystemMenuWords, ...messages]);
  });
  $effect(() => {
    void operation.id;
    bookmark = null;
    return () => systemMenu.close();
  });
  $effect(() => {
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
</script>

{#if bookmark}
  {#key bookmark.itemID}<BookmarkWindow {store} {flow} place={bookmark} onDone={() => bookmark = null} />{/key}
{/if}

<article class="mto-page" data-operation={operation.id}>
  <button type="button" class="mto-back" onclick={onBack}>{word("back")}</button>
  <header>
    <small>{word("category")}</small>
    <h2>{name}</h2>
    <div class="mto-header-details">
      {#if completed}
        <span class="mto-completed" role="status">{word("completed")}</span>
      {:else}
        <span>{word(started ? "started" : "ready")}</span>
        {#if operation.expiresAt > now}
          <time datetime={new Date(operation.expiresAt).toISOString()}>
            {word("expires")} {formatInterval((operation.expiresAt - now) * 10_000)}
          </time>
        {/if}
        <MercenaryOperationTrackButton {store} {flow} id={operation.id} eligible={!operation.expiresAt || operation.expiresAt > now} />
        <MercenaryOperationTravel {store} {flow} solarSystemID={operation.solarSystemID} />
        {#if !started && (!operation.expiresAt || operation.expiresAt > now)}
          <button type="button" class="mto-start" title={word("startHint")} disabled={starting} onclick={() => void startOperation()}>{word("start")}</button>
        {/if}
      {/if}
    </div>
    {#if !completed && failure?.id === operation.id}<p role="alert">{failure.message}</p>{/if}
  </header>
  {#if description}<section><h3>{word("description")}</h3><p>{description}</p></section>{/if}
  <section class="mto-intel">
    <h3>{word("intel")}</h3>
    {#if restrictions}
      <div><button type="button" onclick={() => flow.openShipRestrictions(dungeonID)}>{word("restrictions")}</button></div>
    {/if}
    {#if gameplay}<p>{gameplay}</p>{/if}
    <dl>
      {#if !completed}<dt>{word("status")}</dt><dd>{word(started ? "started" : "ready")}</dd>{/if}
      {#if intel?.difficulty}<dt>{word("difficulty")}</dt><dd>{word("level", { level: intel.difficulty })}</dd>{/if}
      {#if enemy}<dt>{word("enemy")}</dt><dd>{enemy}</dd>{/if}
    </dl>
    <h4>{word("impacts")}</h4>
    <ul>
      {#if operation.solarSystemID}
        <li><button type="button" class="mto-system"
          onclick={() => showInfo({ kind: "mapLocation", typeID: 5, itemID: operation.solarSystemID })}
          oncontextmenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openSystemMenu(event.clientX, event.clientY);
          }}
          onkeydown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            openSystemMenu(bounds.left, bounds.bottom);
          }}>{system}</button></li>
      {/if}
      <li>{word("development", { impact: operation.developmentImpact })}</li>
      <li>{word("anarchy", { impact: operation.anarchyImpact })}</li>
      <li>{word("bonus", { bonus: operation.infomorphBonus })}</li>
    </ul>
  </section>
  {#if message(intel?.archetypeTitleID) && message(intel?.archetypeDescriptionID)}
    <section><h3>{message(intel?.archetypeTitleID)}</h3><p>{message(intel?.archetypeDescriptionID)}</p></section>
  {/if}
</article>

<style>
  article { display: grid; gap: 12px; }
  .mto-back { justify-self: start; }
  header { display: grid; gap: 5px; padding: 14px; background: #0008; }
  header small, time, dt { color: #b8c3cc; }
  h2, h3, h4, p, dl, dd, ul { margin: 0; }
  p { white-space: pre-line; }
  section { display: grid; gap: 6px; }
  .mto-header-details, ul { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .mto-header-details button:first-of-type { margin-left: auto; }
  .mto-completed { color: #8dd9a5; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; }
  ul { list-style: none; padding: 0; }
  li { padding: 5px 8px; background: #ffffff0d; }
  .mto-system { border: 0; background: none; color: inherit; text-decoration: underline; padding: 0; }
</style>
