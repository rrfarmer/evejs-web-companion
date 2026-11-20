<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { compressColonyTemplate, planColonyTemplate, readColonyTemplate, type ColonyTemplate, type TemplatePlacement, type TemplateRotation } from "../bridge/colonyTemplate.ts";
  import type { PiRecipeBook } from "../bridge/piRecipes.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import type { Colony } from "../store/types.ts";
  import ColonyTemplateLibrary from "./ColonyTemplateLibrary.svelte";

  let { colony, recipes, flow, store, onClose }: {
    colony: Colony; recipes: PiRecipeBook; flow: AppFlow; store: ClientStore; onClose: () => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, `Type ${id}`);
  const isk = (amount: number) => `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ISK`;

  let source = $state("");
  let template = $state.raw<ColonyTemplate | null>(null);
  let rotation = $state<TemplateRotation>([0, 0, 0]);
  let cost = $state<number | null>(null);
  let reviewed = $state.raw<TemplatePlacement | null>(null);
  let error = $state("");
  let success = $state(false);
  let busy = $state(false);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let entirePlanet = $state(false);
  let compress = $state(true);
  const compressedTemplate = $derived.by(() => template && compress ? compressColonyTemplate(template) : template);
  const preview = $derived.by(() => {
    if (!compressedTemplate) return { placement: null, error: "" };
    try {
      return { placement: planColonyTemplate(compressedTemplate, colony, recipes, rotation), error: "" };
    } catch (cause) {
      return { placement: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  async function loadPreview(text = source): Promise<void> {
    busy = true;
    error = "";
    cost = null;
    reviewed = null;
    success = false;
    try {
      template = null;
      source = text;
      rotation = [0, 0, 0];
      entirePlanet = false;
      compress = true;
      const parsed = readColonyTemplate(text);
      template = parsed;
      const placement = planColonyTemplate(compressedTemplate!, colony, recipes, rotation);
      flow.requestNames([...new Set([
        ...placement.pins.map(pin => pin.typeID), ...parsed.routes.map(route => route.typeID),
        ...parsed.pins.flatMap(pin => pin.product === null ? [] : [pin.product]),
      ])].map(id => ({ kind: "type" as const, id })));
      cost = await flow.quoteColonyTemplate(placement);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function loadFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = "";
    busy = true;
    try {
      source = await file.text();
      await loadPreview();
    } catch {
      error = "The selected template file could not be read.";
    } finally {
      busy = false;
    }
  }

  async function pasteTemplate(): Promise<void> {
    busy = true;
    try {
      source = await navigator.clipboard.readText();
      await loadPreview();
    } catch {
      error = "Paste the template into the text field to load it.";
    } finally {
      busy = false;
    }
  }

  function turn(axis: number, value: number): void {
    const next = [...rotation] as [number, number, number];
    next[axis] = value;
    rotation = next;
    reviewed = null;
  }

  async function submit(): Promise<void> {
    if (!compressedTemplate || !reviewed || cost === null || busy) return;
    busy = true;
    error = "";
    try {
      await flow.submitColonyTemplate(colony.planetID, compressedTemplate, rotation, reviewed, cost);
      template = null;
      source = "";
      success = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      reviewed = null;
      busy = false;
    }
  }

  $effect(() => {
    const placement = preview.placement;
    const surface = canvas;
    const ctx = surface?.getContext("2d");
    if (!placement || !surface || !ctx) return;
    const {width, height} = surface;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0c1723";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#23384a";
    ctx.beginPath();
    for (let i = 1; i < 8; i++) { ctx.moveTo(i * width / 8, 0); ctx.lineTo(i * width / 8, height); }
    for (let i = 1; i < 4; i++) { ctx.moveTo(0, i * height / 4); ctx.lineTo(width, i * height / 4); }
    ctx.stroke();
    const fullCircle = Math.PI * 2;
    const proposed = placement.pins.filter(pin => !pin.existing);
    const origin = proposed[0]?.longitude ?? placement.pins[0]?.longitude ?? 0;
    const localLongitude = (longitude: number) => (longitude - origin + fullCircle * 1.5) % fullCircle - Math.PI;
    const linkedToCentre = placement.links.some(link => link.from === "CmdCtr" || link.to === "CmdCtr");
    const focus = linkedToCentre || proposed.length === 0 ? placement.pins : proposed;
    const longitudes = focus.map(pin => localLongitude(pin.longitude));
    const latitudes = focus.map(pin => pin.latitude);
    const left = Math.min(...longitudes), right = Math.max(...longitudes);
    const top = Math.min(...latitudes), bottom = Math.max(...latitudes);
    const scale = Math.min((width - 40) / Math.max(right - left, .035), (height - 40) / Math.max(bottom - top, .035));
    const position = (pin: { latitude: number; longitude: number }) => entirePlanet
      ? { x: pin.longitude / fullCircle * width, y: pin.latitude / Math.PI * height }
      : { x: width / 2 + (localLongitude(pin.longitude) - (left + right) / 2) * scale,
          y: height / 2 + (pin.latitude - (top + bottom) / 2) * scale };
    const points = new Map(placement.pins.map(pin => [pin.index, position(pin)]));
    ctx.strokeStyle = "#72c0eb";
    ctx.beginPath();
    for (const link of placement.links) {
      const a = points.get(link.from), b = points.get(link.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, wrap = entirePlanet && Math.abs(dx) > width / 2 ? -Math.sign(dx) * width : 0;
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x + wrap, b.y);
      if (wrap) { ctx.moveTo(a.x - wrap, a.y); ctx.lineTo(b.x, b.y); }
    }
    ctx.stroke();
    for (const pin of colony.pins) {
      if (pin.kind === "command" || pin.latitude == null || pin.longitude == null) continue;
      const p = position({ latitude: pin.latitude, longitude: pin.longitude });
      ctx.fillStyle = "#6d8195";
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    for (const pin of placement.pins) {
      const p = points.get(pin.index)!;
      ctx.beginPath();
      ctx.fillStyle = pin.existing ? "#f7ca77" : "#72dbe8";
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  });
</script>

<section class="colony-template" aria-label="Planetary Templates" data-window="colony-template">
  <header>
    <h4>Planetary Templates</h4>
    <button type="button" disabled={busy} aria-label="Close planetary templates" onclick={onClose}>×</button>
  </header>
  {#if success}<p role="status">Colony template loaded.</p>{/if}
  <textarea rows="3" bind:value={source} disabled={busy} aria-label="Planetary template text" placeholder="Paste template JSON or a colony template link"
    oninput={() => { template = null; reviewed = null; error = ""; success = false; }}></textarea>
  <div class="template-actions">
    <button type="button" disabled={busy || !source.trim()} onclick={() => void loadPreview()}>Preview template</button>
    <button type="button" disabled={busy} onclick={() => void pasteTemplate()}>Load from Clipboard</button>
    <label class="template-file">Open template file <input type="file" accept=".json,.txt,application/json,text/plain" disabled={busy} onchange={(event) => void loadFile(event)} /></label>
  </div>
  <ColonyTemplateLibrary {colony} {recipes} {flow} {store} {busy} {source} onLoad={(text) => void loadPreview(text)} />
  {#if error || preview.error}
    <p class="template-error" role="alert">{error || preview.error}</p>
  {/if}
  {#if template && preview.placement}
    {@const placement = preview.placement}
    <div class="template-preview">
      {#if template.comment}<p class="template-comment">{template.comment}</p>{/if}
      <p><strong>{colony.planetName ?? "Colony"}</strong> · {placement.pins.filter(pin => !pin.existing).length} installations ·
        {placement.links.length} links · {placement.routes} routes · command centre level {placement.requestedLevel}</p>
      <canvas bind:this={canvas} width="520" height="164" aria-label="Planetary surface with template installations and links"></canvas>
      <div class="template-actions">
        <label><input type="checkbox" bind:checked={compress} disabled={busy} onchange={() => { reviewed = null; }} /> Compress layout</label>
        <button type="button" onclick={() => { entirePlanet = !entirePlanet; }}>
          {entirePlanet ? "Zoom to template" : "Show entire planet"}
        </button>
      </div>
      <div class="axes">
        {#each ["X", "Y", "Z"] as axis, i}
          <label>Rotate {axis} <input type="range" min="-180" max="180" step="1" value={rotation[i]} disabled={busy}
            oninput={(event) => turn(i, event.currentTarget.valueAsNumber)} /><output>{rotation[i]}°</output></label>
        {/each}
      </div>
      <ul class="template-pins">
        {#each placement.pins as pin (pin.index)}
          <li>{typeName(pin.typeID)}{pin.existing ? " · Existing command centre" : ""}</li>
        {/each}
      </ul>
      {#if placement.skipped.length > 0}
        <p class="template-error">Routes skipped during import</p>
        <ul class="template-failures">
          {#each placement.skipped as route}
            <li>{route.path.map(index => {
              const pin = placement.pins.find(pin => pin.index === index);
              return pin ? typeName(pin.typeID) : `Installation ${index}`;
            }).join(" → ")} ({typeName(route.typeID)})</li>
          {/each}
        </ul>
      {/if}
      {#if cost !== null && placement.changes.length > 0}
        <div class="template-actions">
          <span>Construction cost <strong>{isk(cost)}</strong></span>
          {#if reviewed}
            <button type="button" disabled={busy} onclick={() => void submit()}>Confirm construction</button>
            <button type="button" disabled={busy} onclick={() => { reviewed = null; }}>Cancel</button>
          {:else}
            <button type="button" disabled={busy} onclick={() => { reviewed = placement; }}>Review construction</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .colony-template { display: grid; gap: .55rem; padding: .7rem; border: 1px solid #47637b; background: #101923; }
  header, .template-actions { display: flex; justify-content: space-between; align-items: center; gap: .45rem; flex-wrap: wrap; }
  h4, p { margin: 0; color: #e0ecf5; }
  textarea { box-sizing: border-box; resize: vertical; width: 100%; color: #e0ecf5; background: #0b1220; border: 1px solid #3b5064; padding: .45rem; }
  .template-file { display: inline-flex; align-items: center; gap: .35rem; }
  .template-file input { max-width: 11rem; }
  .template-preview { display: grid; gap: .45rem; }
  canvas { width: 100%; height: auto; border: 1px solid #324a5d; }
  .axes { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); column-gap: .7rem; }
  .axes label { display: grid; grid-template-columns: auto minmax(2rem, 1fr) 3ch; align-items: center; gap: .3rem; }
  .axes input { width: 100%; }
  .template-pins { list-style: none; display: flex; flex-wrap: wrap; gap: .35rem; padding: 0; margin: .15rem 0; }
  .template-pins li { border: 1px solid #3c576c; padding: .14rem .35rem; }
  .template-error, .template-failures { color: #ffca83; }
  .template-failures { margin: 0; padding-inline-start: 1.5rem; list-style: disc; }
  .template-comment { overflow-wrap: anywhere; }
</style>
