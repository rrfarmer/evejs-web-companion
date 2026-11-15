<script lang="ts">
  import { getAcademyCatalogue } from "../app/api.ts";
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import {
    ACADEMY_CATEGORIES, ACADEMY_RACKS, academyFit, academyOffers, academyStandardBuy, recommendedAcademyShip,
    type AcademyCatalogue, type AcademyOffer, type AcademyShipState,
  } from "../bridge/academyShips.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import type { FittingSkillRequirements } from "../bridge/fittingSkills.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import ShipInfoPreview from "./ShipInfoPreview.svelte";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const { station, words, names } = store;
  // svelte-ignore state_referenced_locally
  const changed = flow.academyChanged;
  const raceID = $derived($station.online?.raceID ?? 0);

  const ROOT = "UI/AcademyShips/";
  const BACK = "UI/Common/Buttons/Back";
  const VIEW = "UI/Common/Buttons/View";
  const BOARD = "UI/Common/Buttons/Board";
  const SAVE = "UI/Fitting/FittingWindow/Save";
  const LABELS = [
    BOARD, BACK, VIEW, SAVE, ...["WindowDescription", "shipsAvailable", "BorrowedShips", "RecommendedLabel", "RentedLabel", "BuyStandard"]
      .map(key => ROOT + key),
    ...ACADEMY_CATEGORIES.flatMap(({ name }) => [ROOT + "CategoryName" + name, ROOT + "CategoryDescription" + name]),
  ];
  let catalogue = $state.raw<AcademyCatalogue | null | undefined>(undefined);
  let loan = $state.raw<AcademyShipState | null | undefined>(undefined);
  let category = $state<number | null>(null);
  let selected = $state<number | null>(null);
  let busy = $state(false);
  let catalogueError = $state("");
  let loanError = $state("");
  let actionError = $state("");
  let missingSkills = $state.raw<FittingSkillRequirements | null>(null);
  const availableOffers = $derived(catalogue && category !== null ? academyOffers(catalogue, category, raceID, shipName) : []);
  const offer = $derived(availableOffers.find(offer => offer.fittingID === selected) ?? availableOffers[0] ?? null);
  const fit = $derived(offer && catalogue ? academyFit(offer, catalogue.facts) : []);
  const loanCount = $derived(loan?.shipID != null ? 1 : 0);

  $effect(() => {
    let current = true;
    flow.requestWords(LABELS);
    void getAcademyCatalogue(flow.requestOptions()).then(read => {
      if (!current) return;
      catalogue = read;
      if (!read) return;
      flow.requestWords(read.offers.flatMap(offer => [`#${offer.descriptionID}`, `#${offer.taglineID}`]));
      flow.requestNames(Object.keys(read.facts).map(id => ({ kind: "type", id: Number(id) })));
    }).catch(error => { if (current) catalogueError = errorWords(error); });
    return () => { current = false; };
  });

  $effect(() => {
    const picked = offer, facts = catalogue?.facts;
    missingSkills = null;
    if (!picked || !facts) return;
    let current = true;
    void flow.academyStandardSkills(picked, facts).then(read => {
      if (!current || !read) return;
      missingSkills = read;
      flow.requestNames(read.listed.map(([id]) => ({ kind: "type", id })));
    }).catch(() => {});
    return () => { current = false; };
  });

  $effect(() => {
    void $changed;
    let current = true;
    void flow.academyShipState().then(state => {
      if (!current) return;
      loan = state;
      loanError = "";
    }).catch(error => {
      if (!current) return;
      loan = undefined;
      loanError = errorWords(error);
    });
    return () => { current = false; };
  });

  function word(label: string, fallback: string, args?: TemplateArguments): string {
    const text = $words.templates[label];
    return text ? plainText(args ? formatTemplate(text, args, { templates: $words.templates }) : text) : fallback;
  }

  function shipName(offer: AcademyOffer): string {
    return resolvedName($names.resolved, "type", offer.shipTypeID, offer.name);
  }

  function choose(id: number | null): void {
    category = id;
    selected = null;
    actionError = "";
  }

  async function run(action: () => Promise<void>) {
    busy = true;
    actionError = "";
    try {
      await action();
    } catch (error) {
      actionError = errorWords(error);
    } finally {
      busy = false;
    }
  }

  function play(event: PointerEvent): void {
    const video = (event.currentTarget as HTMLElement).querySelector("video");
    if (video && !matchMedia("(prefers-reduced-motion: reduce)").matches) void video.play().catch(() => {});
  }

  function pause(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).querySelector("video")?.pause();
  }
</script>

<section class="academy">
  {#if catalogueError}<p class="error" role="alert">{catalogueError}</p>
  {:else if catalogue === undefined}<p role="status">Loading Academy offers…</p>
  {:else if catalogue === null}<p role="status">Academy offers are unavailable from the installed client.</p>
  {:else if category === null}
    <h2>{word(ROOT + "WindowDescription", "Choose a career to explore fitted Academy ships")}</h2>
    <div class="categories">
      {#each ACADEMY_CATEGORIES as entry (entry.id)}
        {@const count = catalogue.offers.filter(offer => offer.categoryID === entry.id).length}
        <article class="category" onpointerenter={play} onpointerleave={pause}>
          <video aria-hidden="true" muted playsinline loop preload="auto" src={`/client-res/video/academyShips/${entry.name}_512x674.webm`}></video>
          <div class="category-content">
            <h3>{word(ROOT + "CategoryName" + entry.name, entry.name)}</h3>
            <p>{word(ROOT + "CategoryDescription" + entry.name, "")}</p>
            <p class="count">{word(ROOT + "shipsAvailable", `${count} ships available`, { color: "ffffff", numShips: count })}</p>
            <button type="button" class="view" aria-label={`${word(VIEW, "View")} ${entry.name}`} onclick={() => choose(entry.id)}>{word(VIEW, "View")}</button>
          </div>
        </article>
      {/each}
    </div>
  {:else}
    <header>
      <button type="button" onclick={() => choose(null)}>{word(BACK, "Back")}</button>
      <nav aria-label="Academy ship categories">
        {#each ACADEMY_CATEGORIES as entry (entry.id)}
          <button type="button" aria-pressed={category === entry.id} onclick={() => choose(entry.id)}>
            {word(ROOT + "CategoryName" + entry.name, entry.name)}
          </button>
        {/each}
      </nav>
      {#if loan}<span class:held={loanCount !== 0} class="loans" role="status">
        {word(ROOT + "BorrowedShips", `${loanCount}/1 ships on loan`, { numOnLoan: loanCount, numTotal: 1 })}
      </span>{/if}
    </header>
    <div class="browse">
      <div class="offers" aria-label="Offered ships">
        {#each availableOffers as entry (entry.fittingID)}
          {@const name = shipName(entry)}
          <button class="offer" type="button" aria-pressed={offer?.fittingID === entry.fittingID} onclick={() => { selected = entry.fittingID; actionError = ""; }}>
            <TypeIcon typeID={entry.shipTypeID} {name} size="md" />
            <span><strong>{name}</strong>
              {#if loan?.fittingID === entry.fittingID}<small class="held">{word(ROOT + "RentedLabel", "On loan")}</small>
              {:else if entry.shipTypeID === recommendedAcademyShip(raceID, category)}
                <small>{word(ROOT + "RecommendedLabel", "Recommended")}</small>
              {/if}
              <small>{word(`#${entry.taglineID}`, "")}</small>
            </span>
          </button>
        {/each}
      </div>
      {#if offer}
        {@const picked = offer}
        {@const facts = catalogue.facts}
        <div class="details">
          <div class="ship">
            <ShipInfoPreview typeID={picked.shipTypeID} factionID={facts[picked.shipTypeID]?.factionID ?? null} active={true} expanded={true} />
            <div class="ship-copy">
              <h2>{shipName(picked)}</h2>
              <p>{word(`#${picked.descriptionID}`, "")}</p>
            </div>
          </div>
          <div class="fit" aria-label="Fitting preview">
            {#each ACADEMY_RACKS as rack (rack.flag)}
              {@const rows = fit.filter(item => item.rack === rack.flag)}
              {#if rows.length > 0}
                <section aria-label={rack.label}>
                  <h3>{rack.label}</h3>
                  <div class="modules">
                    {#each rows as item}
                      {@const name = resolvedName($names.resolved, "type", item.typeID, "Equipment")}
                      <span class="module" title={item.amount > 1 ? `${name} × ${item.amount.toLocaleString()}` : name}>
                        <TypeIcon typeID={item.typeID} {name} />
                        {#if item.amount > 1}<span>{item.amount.toLocaleString()}</span>{/if}
                      </span>
                    {/each}
                  </div>
                </section>
              {/if}
            {/each}
          </div>
          <footer>
            {#if loanError || actionError}<p class="error" role="alert">{actionError || loanError}</p>{/if}
            {#if missingSkills?.listed.length}
              <details class="requirements">
                <summary>{missingSkills.listed.length} skills needed for the standard version</summary>
                {#if missingSkills.shipAndFitHeading}<h3>Ship and Fit</h3>{/if}
                {#each missingSkills.fit as [id, level] (id)}
                  <p>{resolvedName($names.resolved, "type", id, "Skill")} {["", "I", "II", "III", "IV", "V"][level]}</p>
                {/each}
                {#if missingSkills.cargoListed}<h3>Cargo Hold</h3>{/if}
                {#each missingSkills.cargo as [id, level] (id)}
                  <p>{resolvedName($names.resolved, "type", id, "Skill")} {["", "I", "II", "III", "IV", "V"][level]}</p>
                {/each}
              </details>
            {/if}
            <button type="button" title={word(SAVE, "Save Fitting")} disabled={busy}
              onclick={() => run(() => flow.saveAcademyStandardFit(picked, facts))}>Save Standard Fitting</button>
            <button type="button" disabled={busy} onclick={() => run(() => flow.openMultiBuy(academyStandardBuy(picked, facts)))}>
              {word(ROOT + "BuyStandard", "Buy Standard")}
            </button>
            <button type="button" class="primary" disabled={busy || !loan} onclick={() => run(() => flow.boardAcademyShip(picked))}>
              {word(BOARD, "Board")}
            </button>
          </footer>
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .academy { box-sizing: border-box; min-height: 100%; padding: 18px; color: #e6eef1; background: #10181e; }
  h2, h3, p { margin: 0; }
  h2 { font-size: 20px; font-weight: 500; }
  h3 { font-size: 15px; }
  p { color: #c0cdd3; line-height: 1.45; }
  button { border: 1px solid #4b646f; background: #17282f; color: inherit; cursor: pointer; border-radius: 2px; padding: 7px 12px; }
  button:hover:enabled, button[aria-pressed="true"] { background: #263f49; border-color: #80acb7; }
  button:focus-visible { outline: 2px solid #92dfe7; outline-offset: 2px; }
  button:disabled { cursor: default; opacity: .5; }
  .categories { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 15px; }
  .category { position: relative; min-height: clamp(275px, 65vh, 520px); background: #1c3039; border: 1px solid #415b65; overflow: hidden; display: flex; align-items: end; }
  .category:hover, .category:focus-within { border-color: #a3e2ef; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
  .category-content { position: relative; width: 100%; padding: 64px 16px 16px; background: linear-gradient(transparent, #0c161c 30%); text-align: center; }
  .category h3 { font-size: 24px; font-weight: 500; }
  .category p { margin-top: 8px; }
  .category .count { color: #e6eef1; }
  .view { margin-top: 12px; min-width: min(100%, 167px); }
  header { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
  nav, .modules { display: flex; gap: 5px; flex-wrap: wrap; }
  .loans { margin-left: auto; border: 1px solid #3f5761; padding: 7px 10px; }
  .held { color: #90dcbb; }
  .browse { display: grid; grid-template-columns: minmax(155px, 220px) minmax(0, 1fr); gap: 12px; }
  .offers { display: grid; gap: 4px; align-content: start; max-height: 530px; overflow: auto; }
  .offer { display: flex; text-align: left; align-items: center; gap: 6px; min-height: 52px; padding: 5px 6px; }
  small { display: block; color: #b4d2dc; font-size: 11px; margin-top: 2px; }
  .details { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(155px, .52fr); background: #0b1115; border: 1px solid #415b65; }
  .ship { position: relative; min-height: clamp(280px, 54vh, 475px); }
  .ship-copy { position: absolute; inset: auto 0 0; padding: 48px 14px 14px; background: linear-gradient(transparent, #0b1115 40%); pointer-events: none; }
  .ship-copy p { margin-top: 5px; }
  .fit { padding: 12px; overflow: auto; border-left: 1px solid #354c57; }
  .fit section + section { margin-top: 12px; }
  .fit h3 { margin-bottom: 5px; font-size: 12px; color: #c9e3eb; font-weight: 500; }
  .module { display: grid; gap: 2px; justify-items: center; font-size: 11px; }
  footer { display: flex; grid-column: 1 / -1; align-items: center; flex-wrap: wrap; justify-content: end; gap: 7px; border-top: 1px solid #354c57; padding: 9px; }
  .primary { background: #335668; border-color: #739ead; min-width: 95px; }
  .requirements { margin-right: auto; font-size: 12px; color: #f2c380; }
  .requirements h3 { font-size: 12px; margin-top: 4px; }
  summary { cursor: pointer; }
  .error { color: #ffb3a7; }
  @media (max-width: 685px) {
    .academy { padding: 10px; }
    .categories, .details { grid-template-columns: 1fr; }
    .fit { border-left: 0; }
    .browse { grid-template-columns: minmax(112px, 34%) minmax(0, 1fr); gap: 5px; }
  }
</style>
