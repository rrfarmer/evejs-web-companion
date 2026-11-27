<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, typeID, winningNumber, ownedNumbers, onFinish }: {
    store: ClientStore; flow: AppFlow; typeID: number; winningNumber: number;
    ownedNumbers: readonly number[]; onFinish: () => void;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const heading = "UI/HyperNet/CardShowWinner";
  const skip = "UI/HyperNet/Skip";
  const owned = "UI/HyperNet/OwnedTickets";
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  const symbols = (number: number) => String(number + 1).padStart(4, "0");
  const winningCode = $derived(symbols(winningNumber));
  const name = $derived(resolvedName($names.resolved, "type", typeID, String(typeID)));

  let revealed = $state(0);
  let canSkip = $state(false);
  const candidates = $derived(ownedNumbers.filter(number => symbols(number).startsWith(winningCode.slice(0, revealed))).length);
  let startTimer: number | undefined;
  let stepTimer: number | undefined;
  let finishTimer: number | undefined;
  let finished = false;

  function stopTimers() {
    window.clearTimeout(startTimer);
    window.clearInterval(stepTimer);
    window.clearTimeout(finishTimer);
  }
  function finish() {
    if (finished) return;
    finished = true;
    stopTimers();
    onFinish();
  }

  onMount(() => {
    flow.requestWords([heading, skip, owned]);
    startTimer = window.setTimeout(() => {
      canSkip = true;
      stepTimer = window.setInterval(() => {
        revealed++;
        if (revealed === winningCode.length) {
          window.clearInterval(stepTimer);
          finishTimer = window.setTimeout(finish, 500);
        }
      }, 500);
    }, 1500);
    return stopTimers;
  });
</script>

<section class="winner-reveal" data-hypernet-reveal aria-label={word(heading, "Show winner")}>
  <h3>{word(heading, "Show winner")}</h3>
  <div class="prize"><img src={typeIconUrl(typeID)} alt="" /><span>{name}</span></div>
  <div class="slots" role="progressbar" aria-label="Winning HyperNode" aria-valuemin="0"
    aria-valuemax={winningCode.length} aria-valuenow={revealed} data-reveal-stage={revealed}>
    {#each [...winningCode] as digit, index (index)}
      <span class:revealed={index < revealed}>{index < revealed ? digit : "•"}</span>
    {/each}
  </div>
  <p data-reveal-candidates={candidates}>
    {plainText(formatTemplate($words.templates[owned] ?? "{owned_ticket_count} HyperNodes owned",
      { owned_ticket_count: ownedNumbers.length }, { nameOf: () => "" }))}
  </p>
  <progress value={candidates} max={Math.max(ownedNumbers.length, 1)} aria-label="Matching owned HyperNodes"></progress>
  <button type="button" data-hypernet-skip-reveal disabled={!canSkip} onclick={finish}>{word(skip, "Skip")}</button>
</section>

<style>
  .winner-reveal { display: grid; justify-items: center; gap: 12px; padding: 20px; border: 1px solid #47606e; }
  h3, p { margin: 0; }
  .prize { display: flex; align-items: center; gap: 8px; }
  img { width: 48px; height: 48px; object-fit: contain; }
  .slots { display: flex; gap: 6px; }
  .slots span { display: grid; place-items: center; width: 30px; height: 36px; color: #b8c3cc; border: 1px solid #47606e;
    font-size: 18px; font-variant-numeric: tabular-nums; }
  .slots .revealed { color: #fff; border-color: #66cddd; background: #00506666; }
  progress { width: min(100%, 180px); accent-color: #66cddd; }
</style>
