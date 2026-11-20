<script lang="ts">
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import { commandLaunchRemaining, fmtTime, quoteCommandLaunch, type CommandLaunchFacts } from "../bridge/planetLaunches.ts";
  import type { ColonyPin } from "../store/types.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { pin, nowMs, flow, disabled, launch, close }: {
    pin: ColonyPin; nowMs: number; flow: AppFlow; disabled: boolean;
    launch: (payload: Readonly<Record<number, number>>, tax: number) => Promise<number>;
    close: () => void;
  } = $props();

  let payload = $state.raw<Readonly<Record<number, number>>>({});
  let facts = $state.raw<CommandLaunchFacts | null>(null);
  let factsError = $state("");
  let failure = $state("");
  let receipt = $state("");
  let confirmedAt = $state<number | null>(null);
  let retry = $state(0);
  const stockTypes = $derived(pin.contents.map(item => item.typeID).sort((a, b) => a - b).join(","));
  const remaining = $derived(commandLaunchRemaining(Math.max(pin.lastLaunchAtMs ?? 0, confirmedAt ?? 0) || null, nowMs));
  const review = $derived.by(() => {
    if (!facts || !Object.keys(payload).length) return null;
    try {
      return { quote: quoteCommandLaunch(pin, payload, facts), error: "" };
    } catch (cause) {
      return { quote: null, error: errorWords(cause) };
    }
  });
  const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const isk = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  $effect(() => {
    const types = stockTypes;
    const pinTypeID = pin.typeID;
    retry;
    facts = null;
    factsError = "";
    if (!types) return;
    let current = true;
    void flow.readCommandLaunchFacts(pinTypeID, types.split(",").map(Number)).then(result => {
      if (current) facts = result;
    }).catch(cause => {
      if (current) factsError = errorWords(cause);
    });
    return () => { current = false; };
  });

  function stage(typeID: number, quantity: number): void {
    const next = { ...payload };
    if (quantity > 0) next[typeID] = (next[typeID] ?? 0) + quantity;
    else delete next[typeID];
    payload = next;
    receipt = failure = "";
  }

  async function submit(): Promise<void> {
    if (disabled || remaining || !review?.quote) return;
    failure = receipt = "";
    try {
      confirmedAt = await launch(payload, review.quote.tax);
      payload = {};
      receipt = "Payload launched. Track it in Planetary Colonies → Launches.";
    } catch (cause) {
      failure = errorWords(cause);
    }
  }
</script>

<section class="command-launch" aria-label="Command centre launch">
  <header><h2>Launch Payload</h2><button type="button" disabled={disabled} aria-label="Close launch panel" onclick={close}>×</button></header>
  <dl>
    {#if pin.usedM3 !== null && pin.capacityM3 !== null}
      <div><dt>Storage</dt><dd>{number(pin.usedM3)} / {number(pin.capacityM3)} m³</dd></div>
    {/if}
    <div><dt>Next launch</dt><dd>{remaining > 0 ? fmtTime(remaining) : "Now"}</dd></div>
  </dl>
  <h3>Stored commodities</h3>
  <ul>
    {#each pin.contents as item (item.typeID)}
      {@const left = Math.max(0, item.quantity - (payload[item.typeID] ?? 0))}
      {#if left > 0}
        <li>
          <TypeIcon typeID={item.typeID} name={item.typeName} />
          <span>{item.typeName} <small>{number(left)}</small></span>
          <button type="button" disabled={disabled} aria-label={`Add ${item.typeName} to payload`}
            onclick={() => stage(item.typeID, left)}>Add</button>
        </li>
      {/if}
    {/each}
  </ul>
  {#if pin.contents.every(item => item.quantity <= (payload[item.typeID] ?? 0))}<p>Storehouse is empty.</p>{/if}
  <h3>Payload</h3>
  <ul>
    {#each Object.entries(payload) as [id, quantity] (id)}
      {@const name = pin.contents.find(item => item.typeID === Number(id))?.typeName ?? "Commodity"}
      <li>
        <TypeIcon typeID={Number(id)} {name} />
        <span>{name} <small>{number(quantity)}</small></span>
        <button type="button" disabled={disabled} aria-label={`Remove ${name} from payload`}
          onclick={() => stage(Number(id), 0)}>Remove</button>
      </li>
    {:else}
      <li class="empty">Payload is empty.</li>
    {/each}
  </ul>
  {#if factsError}<p role="alert">{factsError}</p><button type="button" disabled={disabled} onclick={() => { retry++; }}>Retry tax data</button>
  {:else if Object.keys(payload).length && !facts}<p role="status">Reading launch tax…</p>{/if}
  {#if review?.error}<p role="alert">{review.error}</p>{/if}
  <footer>
    {#if review?.quote}
      <span>Launch cost <strong>{isk(review.quote.tax)} ISK</strong>
        {#if review.quote.volume !== null}<small>{number(review.quote.volume)} m³ payload</small>{/if}
      </span>
    {/if}
    <button type="button" disabled={disabled || remaining > 0 || !review?.quote} onclick={() => void submit()}>Launch</button>
  </footer>
  {#if receipt}<p role="status">{receipt}</p>{/if}
  {#if failure}<p role="alert">{failure}</p>{/if}
</section>

<style>
  .command-launch { display: grid; gap: 6px; margin-top: 8px; padding: 8px; border: 1px solid #344753; background: #0b141b; }
  header, footer, dl div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  header h2, h3, dl, dd, ul, p { margin: 0; }
  h2 { font-size: 13px; }
  h3 { font-size: 12px; color: #abc0cb; }
  ul { padding: 0; list-style: none; }
  li { display: grid; align-items: center; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 6px;
    padding: 4px 0; border-top: 1px solid #30434e; }
  small { display: block; color: #abc0cb; }
  p, .empty { display: block; color: #abc0cb; }
  [role="alert"] { color: #ffc797; }
  button { font: inherit; color: inherit; background: #1c2a34; border: 1px solid #49616d; padding: 3px 6px; }
  button:enabled { cursor: pointer; }
  button:disabled { opacity: .5; }
  footer > button { margin-left: auto; }
</style>
