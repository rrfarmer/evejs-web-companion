<script lang="ts">
  // corporation/corp_dlg_editcorpdetails.py CreateCorp (CorpDetails): the logo at the top - the CorpIcon 90 and the
  // CorpLogoPicker beside it (three rows: the layer's shape and its colour, 24 each in a frame; a shape opens the
  // library's shapes, four to a row, a colour its colours, each with a Close button), then the corporation's name
  // (DefaultCorpName to start; corpNameMaxLenTQ 50), the ticker (5) with its Ticker button (PickTicker:
  // GetSuggestedTickerNames, one picked), the ISK and LP tax rates (0 to 100), the home page ("http://" to start), Allow
  // Friendly Fire, the description (4000), and Submit (Submit: corp.AddCorporation, the window closed). The first
  // layer's shape random (graphicCorpLogoLibShapes), the other two the library's no-shape, no colours. (The client's
  // own window; here a box over the corporation window.)
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import CorpLogo from "./CorpLogo.svelte";
  let { store, flow, onClose }: { store: ClientStore; flow: AppFlow; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const library = flow.corpLogoLibrary;
  const P = "UI/Corporations/CorpDetails/";
  const LABELS = [P + "CorpName", P + "DefaultCorpName", P + "Ticker", P + "ISKTaxRate", P + "LPTaxRate", P + "HomePage", P + "Description",
    P + "SelectTicker", "UI/Corporations/CorpUIHome/AllowFriendlyFire", "UI/Corporations/CreateCorp/EnterDescriptionHere",
    "UI/Corporations/CreateCorp/CreateCorpCaption", "UI/Generic/Submit", "UI/Generic/Close"];
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  let name = $state(""), named = false, ticker = $state(""), iskTax = $state(0), lpTax = $state(0), url = $state("http://");
  let friendlyFire = $state(false), description = $state("");
  let shapes = $state<(number | null)[]>([null, null, null]), colors = $state<(number | null)[]>([null, null, null]);
  let picking = $state<{ kind: "shape" | "color"; layer: number } | null>(null);
  let tickers = $state<readonly string[] | null>(null);
  let submitting = $state(false), error = $state("");
  const ids = (record: Readonly<Record<string, unknown>>) => Object.keys(record).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  $effect(() => {
    // SetupLogo([random shape, no shape, no shape], [None] * 3), once the library is read
    const lib = $library;
    if (lib === null || shapes[0] !== null) return;
    const all = ids(lib.shapes);
    shapes = [all[Math.floor(Math.random() * all.length)] ?? lib.noShape, lib.noShape, lib.noShape];
  });
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  $effect(() => {
    // DefaultCorpName: "{[character]player.name} Corporation", the player the pilot
    const t = $words.templates[P + "DefaultCorpName"], me = $station.online?.characterID;
    const mine = me ? resolvedName($names.resolved, "character", me, "") : "";
    if (named || typeof t !== "string" || !mine) return;
    name = plainText(formatTemplate(t, { player: String(me) }, { nameOf: (kind, id) => (id === me ? mine : resolvedName($names.resolved, kind, id, "")) }));
    named = true;
  });
  onMount(() => { flow.requestWords(LABELS); flow.requestCorpLogos([]); });
  const swatch = (colorID: number | null): string => {
    const c = colorID === null ? undefined : $library?.colors[String(colorID)];
    if (!c) return "transparent";
    const ch = (v: number | undefined) => Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255);
    return `rgb(${ch(c.rgba[0])}, ${ch(c.rgba[1])}, ${ch(c.rgba[2])})`;
  };
  const shapeTexture = (shapeID: number | null): string => clientTexture($library?.shapes[String(shapeID ?? $library?.noShape)] ?? "");
  function pick(id: number): void {
    if (picking === null) return;
    if (picking.kind === "shape") shapes[picking.layer] = id; else colors[picking.layer] = id;
  }
  async function pickTicker(): Promise<void> {
    tickers = null;
    try { const got = await flow.corporationTickerSuggestions(name); if (got !== null) tickers = got; }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  async function submit(): Promise<void> {
    if (submitting) return;
    submitting = true; error = "";
    try {
      if (await flow.createCorporation({ name, ticker, description: description.trim(), url, iskTaxRate: iskTax / 100, loyaltyPointTaxRate: lpTax / 100,
        shapes: [...shapes], colors: [...colors], applicationsEnabled: true, friendlyFireEnabled: friendlyFire })) onClose();
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { submitting = false; }
  }
</script>

<div class="create-corp-back">
  <section class="create-corp" aria-label={word("UI/Corporations/CreateCorp/CreateCorpCaption", "Create Corporation")} aria-busy={submitting}>
    <header><span>{word("UI/Corporations/CreateCorp/CreateCorpCaption", "Create Corporation")}</span><button type="button" class="x" aria-label={word("UI/Generic/Close", "Close")} onclick={onClose}>×</button></header>
    <div class="logo-control">
      <div class="logo">{#if $library}<CorpLogo library={$library} logo={{ shapes, colors }} name={name} />{/if}</div>
      <div class="picker">
        {#each [0, 1, 2] as layer (layer)}
          <div class="layer">
            <button type="button" class="pic" aria-label="Shape {layer + 1}" style="background-image: url(&quot;{shapeTexture(shapes[layer] ?? null)}&quot;)" onclick={() => (picking = { kind: "shape", layer })}></button>
            <button type="button" class="col" aria-label="Colour {layer + 1}" style="background-color: {swatch(colors[layer] ?? null)}" onclick={() => (picking = { kind: "color", layer })}></button>
          </div>
        {/each}
      </div>
      {#if picking && $library}
        <div class="library {picking.kind}">
          <div class="grid">
            {#if picking.kind === "shape"}
              {#each ids($library.shapes) as id (id)}<button type="button" class="shape" aria-label="Shape {id}" style="background-image: url(&quot;{shapeTexture(id)}&quot;)" onclick={() => pick(id)}></button>{/each}
            {:else}
              {#each ids($library.colors) as id (id)}<button type="button" class="color" aria-label="Colour {id}" style="background-color: {swatch(id)}" onclick={() => pick(id)}></button>{/each}
            {/if}
          </div>
          <button type="button" onclick={() => (picking = null)}>{word("UI/Generic/Close", "Close")}</button>
        </div>
      {/if}
    </div>
    <label>{word(P + "CorpName", "Corporation Name")}<input bind:value={name} maxlength="50" /></label>
    <div class="ticker">
      <label>{word(P + "Ticker", "Ticker")}<input bind:value={ticker} maxlength="5" /></label>
      <button type="button" onclick={pickTicker}>{word(P + "Ticker", "Ticker")}</button>
    </div>
    {#if tickers}
      <div class="tickers" role="listbox" aria-label={word(P + "SelectTicker", "Select Ticker")}>
        {#each tickers as t (t)}<button type="button" role="option" aria-selected={ticker === t} onclick={() => { ticker = t; tickers = null; }}>{t}</button>{/each}
      </div>
    {/if}
    <label>{word(P + "ISKTaxRate", "ISK Tax Rate")}<input type="number" min="0" max="100" step="0.1" bind:value={iskTax} /></label>
    <label>{word(P + "LPTaxRate", "LP Tax Rate")}<input type="number" min="0" max="100" step="0.1" bind:value={lpTax} /></label>
    <label>{word(P + "HomePage", "Home Page")}<input bind:value={url} maxlength="2048" /></label>
    <label class="desc">{word(P + "Description", "Description")}<textarea bind:value={description} maxlength="4000" placeholder={word("UI/Corporations/CreateCorp/EnterDescriptionHere", "Enter description here")}></textarea></label>
    <label class="check"><input type="checkbox" bind:checked={friendlyFire} />{word("UI/Corporations/CorpUIHome/AllowFriendlyFire", "Allow Friendly Fire")}</label>
    {#if error}<p class="error">{error}</p>{/if}
    <div class="buttons"><button type="button" disabled={submitting} onclick={submit}>{word("UI/Generic/Submit", "Submit")}</button></div>
  </section>
</div>

<style>
  .create-corp-back { position: absolute; inset: 0; z-index: 5; display: flex; justify-content: center; align-items: flex-start; background: rgba(0, 0, 0, 0.45); overflow: auto; }
  .create-corp { position: relative; width: 400px; min-height: 590px; margin: 8px; padding: 5px; display: flex; flex-direction: column; gap: 4px; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  header { display: flex; justify-content: space-between; align-items: center; font-weight: bold; }
  .x { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .logo-control { position: relative; height: 100px; display: flex; justify-content: center; gap: 10px; }
  .logo { width: 90px; height: 90px; display: grid; }
  .logo :global(.corp-logo) { width: 90px; height: 90px; }
  .picker { width: 57px; }
  .layer { display: flex; gap: 0; height: 30px; padding-top: 3px; }
  .pic, .col { width: 24px; height: 24px; padding: 0; border: 1px solid rgba(102, 102, 102, 1); background-size: contain; background-color: transparent; cursor: pointer; }
  .pic { background-color: #fff; background-blend-mode: multiply; }
  .library { position: absolute; top: 100px; left: 50%; transform: translateX(-50%); z-index: 2; padding: 8px; background: #1d2125; border: 1px solid rgba(255, 255, 255, 0.2); display: flex; flex-direction: column; gap: 8px; align-items: center; }
  .library.shape { width: 280px; height: 240px; }
  .library.color { width: 150px; height: 194px; }
  .grid { flex: 1; overflow: auto; display: grid; grid-template-columns: repeat(4, 1fr); align-content: start; width: 100%; }
  .grid .shape { height: 64px; background-size: contain; background-repeat: no-repeat; background-position: center; background-color: transparent; border: 0; cursor: pointer; }
  .grid .color { height: 32px; border: 1px solid rgba(0, 0, 0, 0.5); cursor: pointer; }
  label { display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
  label input:not([type="checkbox"]), textarea { font-size: 13px; }
  .ticker { display: flex; align-items: flex-end; gap: 6px; }
  .ticker label { width: 240px; }
  .tickers { display: flex; flex-wrap: wrap; gap: 4px; }
  .desc { flex: 1; }
  textarea { min-height: 120px; resize: vertical; }
  .check { flex-direction: row; align-items: center; gap: 6px; }
  .buttons { display: flex; justify-content: center; padding-top: 4px; }
  .error { color: #e06666; }
</style>
