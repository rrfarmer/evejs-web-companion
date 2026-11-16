<script lang="ts">
  // The pilot's probes as the client's probe scanner lists them (scannerListEntries.ScanProbeEntryNew): each probe's
  // label, the time it has left and its scan range, an inactive one dimmed; and the probe menu
  // (scanSvc.GetProbeMenu): Scan Range, the type's eight ranges (GetScanRangeStepsByTypeID), and Recover Probe, for
  // the probe and any others chosen with it. The range is the client's own to keep (bridge/scannerWrites.ts,
  // setRangeStep) and goes to the server with the next scan. Above them, the palette's two formation buttons
  // (bridge/probeFormations.ts): the probes sent to the formation's places, the shortfall launched.
  import { onMount } from "svelte";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { filetimeOf } from "../bridge/journalWords.ts";
  import { PROBE_STATE, formationOf, probeNumber } from "../bridge/scannerWrites.ts";
  import { PINPOINT_FORMATION, SPREAD_FORMATION } from "../bridge/probeFormations.ts";
  import { SHORT_INTERVAL_WORD_LABELS, shortWrittenInterval } from "../bridge/timeInterval.ts";
  import { fmtDist } from "../space/overview.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const scanner = store.scanner;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;

  const AU = 149_597_870_700;
  const WORDS = {
    probeLabel: "UI/Inflight/Scanner/ProbeLabel",
    scanRange: "UI/Inflight/Scanner/ScanRange",
    recoverProbe: "UI/Inflight/Scanner/RecoverProbe",
    pinpoint: "UI/Inflight/Scanner/LaunchPinpointFormation",
    spread: "UI/Inflight/Scanner/LaunchSpreadFormation",
    none: "UI/Generic/None",
    expired: "UI/Inflight/Scanner/Expired",
  } as const;
  $effect(() => {
    flow.requestWords([...Object.values(WORDS), ...SHORT_INTERVAL_WORD_LABELS]);
  });
  const word = (label: string, args: Record<string, string | number> = {}): string | null => {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf: () => "" })).trim() : null;
  };

  // The entry's timer (UpdateProbeState, every half second): the clock the time left is counted by.
  let nowMs = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (nowMs = Date.now()), 500);
    return () => clearInterval(timer);
  });

  const inSpace = $derived($scanner.operations.status === "ready" && $scanner.operations.value.inSpace);
  const probes = $derived($scanner.operations.status === "ready" && $scanner.operations.value.inSpace ? $scanner.operations.value.probes : []);
  // The palette's formation buttons (probeScannerPalette 239 to 248), offered as CheckButtonStates offers them.
  const formation = $derived($scanner.operations.status === "ready" ? formationOf($scanner.operations.value) : { refusal: "" });
  const formationRefusal = $derived("refusal" in formation ? formation.refusal : null);
  let chosen = $state<number[]>([]);
  let busy = $state(false);
  let failure = $state("");

  /** UpdateProbeState: None, Expired, or the time left to the minute (to the second under one). */
  function timeLeft(expiry: string): string {
    if (!/^\d+$/.test(expiry) || expiry === "0") return word(WORDS.none) ?? "None";
    const serverMs = nowMs + ($flight.crimewatch?.clockOffsetMs ?? 0);
    const left = BigInt(expiry) - filetimeOf(serverMs);
    if (left <= 0n) return word(WORDS.expired) ?? "Expired";
    const showTo = left >= 600_000_000n ? "minute" : "second";
    return shortWrittenInterval(left, $words.templates, "day", showTo) ?? "";
  }
  const rangeText = (range: number): string => fmtDist(range, range < AU ? 2 : 0);

  /** GetProbeMenu: the probes chosen, with the one the menu is for among them. */
  const menuProbes = (probeID: number): number[] => (chosen.includes(probeID) ? [...chosen] : [...chosen, probeID]);

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    failure = "";
    try {
      await action();
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

{#if inSpace}
  <section class="scanner-probes">
    <p class="controls">
      <button type="button" disabled={busy || formationRefusal !== null} title={formationRefusal ?? ""}
        onclick={() => void run(() => flow.launchProbeFormation(PINPOINT_FORMATION))}>
        {word(WORDS.pinpoint) ?? "Launch Pinpoint Formation"}
      </button>
      <button type="button" disabled={busy || formationRefusal !== null} title={formationRefusal ?? ""}
        onclick={() => void run(() => flow.launchProbeFormation(SPREAD_FORMATION))}>
        {word(WORDS.spread) ?? "Launch Spread Formation"}
      </button>
    </p>
    {#if probes.length > 0}
    <table class="guests">
      <tbody>
        {#each probes as probe (probe.probeID)}
          <tr class:dim={probe.state === PROBE_STATE.INACTIVE}>
            <td>
              <label>
                <input type="checkbox" checked={chosen.includes(probe.probeID)}
                  onchange={(event) => (chosen = event.currentTarget.checked ? [...chosen, probe.probeID] : chosen.filter((id) => id !== probe.probeID))} />
                {word(WORDS.probeLabel, { probeIndex: probeNumber(probe.probeID) }) ?? `Probe ${probeNumber(probe.probeID)}`}
              </label>
            </td>
            <td class="num">{timeLeft(probe.expiry)}</td>
            <td class="num">{rangeText(probe.scanRange)}</td>
            <td>
              {#if (probe.rangeSteps ?? []).length > 0}
                <select aria-label={word(WORDS.scanRange) ?? "Scan Range"} disabled={busy} value=""
                  onchange={(event) => {
                    const step = Number(event.currentTarget.value);
                    event.currentTarget.value = "";
                    if (step > 0) void run(() => flow.setProbeRangeStep(menuProbes(probe.probeID), step));
                  }}>
                  <option value="">{word(WORDS.scanRange) ?? "Scan Range"}</option>
                  {#each probe.rangeSteps ?? [] as range, index (index)}
                    <option value={index + 1}>{fmtDist(range)}</option>
                  {/each}
                </select>
              {/if}
              <button type="button" disabled={busy} onclick={() => void run(() => flow.recoverChosenProbes(menuProbes(probe.probeID)))}>
                {word(WORDS.recoverProbe) ?? "Recover Probe"}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {/if}
    {#if failure}
      <p class="error">{failure}</p>
    {/if}
  </section>
{/if}

<style>
  /* ScanProbeEntryNew: an inactive probe at half. */
  .scanner-probes .dim { opacity: 0.5; }
</style>
