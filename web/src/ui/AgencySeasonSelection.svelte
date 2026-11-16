<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  type Seasons = Awaited<ReturnType<AppFlow["agencySeasons"]>>;
  let { store, flow, seasons, onchange }: {
    store: ClientStore; flow: AppFlow; seasons: Seasons; onchange: (next: Seasons) => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const eventInfo = "UI/Seasons/MultipleSeasonsTexts/eventInfoLabel";
  $effect(() => flow.requestWords([eventInfo]));
  const word = (id: number | null | undefined) => id == null ? "" : plainText($words.templates[`#${id}`] ?? "");
  let busy = $state(false);
  let failure = $state("");

  async function choose(id: number | null) {
    if (busy || id === null) return;
    busy = true;
    failure = "";
    try {
      const next = await flow.selectAgencySeason(id);
      if (next) onchange(next);
    } catch (error) {
      failure = error instanceof Error ? error.message : "The season selection could not be confirmed.";
    } finally { busy = false; }
  }
</script>

<section class="season-selector" aria-label={word(seasons.navigation?.headingID) || "Season selection"}>
  <header>
    <span title={word(seasons.navigation?.hintID)}>{plainText($words.templates[eventInfo] ?? "") || "Event information"}</span>
    <h2>{word(seasons.navigation?.headingID) || "Choose a season"}</h2>
  </header>
  <div class="season-options">
    {#each seasons.choices as choice (choice.seasonID)}
      <button type="button" disabled={busy} onclick={() => choose(choice.seasonID)} title={word(choice.cardHintID)}>
        {#if choice.cardPicture}<img alt="" src={clientTexture(choice.cardPicture)} />{/if}
        <span>{word(choice.cardTitleID) || word(choice.titleID) || `Season ${choice.seasonID}`}</span>
        {#if choice.cardDescriptionID}<small>{word(choice.cardDescriptionID)}</small>{/if}
      </button>
    {/each}
  </div>
  {#if failure}<p role="alert">{failure}</p>{/if}
</section>

<style>
  .season-selector { padding: 10px 0; color: rgb(255 255 255 / 92%); }
  header { position: relative; max-width: 1114px; margin: 0 auto; min-height: 30px; text-align: center; }
  header span { position: absolute; inset: 8px auto auto 8px; opacity: 0.75; font-size: 12px; }
  h2 { margin: 0 0 16px; font-size: 24px; font-weight: 500; }
  .season-options { display: flex; gap: 16px; width: max-content; max-width: 100%; margin: 0 auto; padding: 4px; overflow-x: auto; }
  button { position: relative; isolation: isolate; flex: 0 0 125px; height: 333px; padding: 0; overflow: hidden; text-align: left;
    border: 1px solid rgb(255 255 255 / 15%); background: #121a21; color: inherit; cursor: pointer; }
  button:hover, button:focus-visible { border-color: #67b7db; }
  button:disabled { opacity: 0.75; cursor: default; }
  img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: -1; }
  button span { position: absolute; top: 27px; left: 0; right: 0; padding: 8px 12px; font-size: 16px;
    text-shadow: 0 1px 3px #000; background: linear-gradient(90deg, rgb(14 46 61 / 92%), rgb(8 27 37 / 71%)); }
  small { position: absolute; inset: auto 0 0; padding: 8px 12px; background: rgb(0 0 0 / 65%); }
  [role="alert"] { text-align: center; }
  @media (max-width: 650px) { header span { position: static; } }
</style>
