<script lang="ts">
  // Store/flow adapter for the pure ScannerCenter view. What each order would
  // send, and why the client would not offer it now, come from the scanner as
  // the transport keeps it, by the client's own rules (bridge/scannerWrites.ts).
  // The flow reads the scanner again as an order is made, and makes the
  // client's call itself.
  import { getContext, onMount } from "svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import { PINPOINT_FORMATION, SPREAD_FORMATION } from "../bridge/probeFormations.ts";
  import ScannerCenter from "./ScannerCenter.svelte";
  import ProbeScanResults from "./ProbeScanResults.svelte";
  import ScannerProbes from "./ScannerProbes.svelte";
  import {
    ABYSSAL_SCAN_QUESTION,
    SCAN_IN_PROGRESS,
    SHIP_SCANS_ALONE,
    isAbyssalSystem,
    launchOf,
    recallOf,
    scanOf,
  } from "../bridge/scannerWrites.ts";
  import { ASKED_KEEPING_YES, DO_NOT_ASK_AGAIN_LABEL, suppressableKey } from "../bridge/dialogSuppression.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { nameKey } from "../store/names.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { ScannerActionBindings } from "../scanner/scannerCenter.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  /**
   * On the play page the window as ProbeScannerWindow lays it out (400 x 400, caption UI/Inflight/Scanner/ProbeScanner;
   * probeScannerPalette.py): the results (their filter row and scroll, ProbeScanResults) over the bottom container 64
   * high on its segment underlay - the probe state row 24 high (the probe's icon 28, "X n" or NoLauncherFitted /
   * NoProbesLaunched / NoProbesInLauncher in warning orange, the recover and reconnect buttons at the right), then the
   * formation buttons 32 (pinpoint, spread, center on self), the size slider (1 to 8, its label the average range) and
   * the Analyze button 100 wide at the right. The companion's own center and probe table are not drawn there.
   */
  const retail = getContext("retailChrome") === true;

  // svelte-ignore state_referenced_locally
  const scanner = store.scanner;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;

  // The client's question before a scan in an Abyssal pocket (scanSvc.RequestScans_Check, 183 to 187):
  // prompt_player_fsd_dialog('ProbeScannerAbyssalSpaceWarning', buttons=YESNO, suppress=ID_YES). The dialog has no
  // title, so the box takes its type's (a warning: dialog_handler.py TITLE_BY_DIALOG_TYPE, 24 to 29, 107 to 109);
  // Yes is kept where the box is ticked and the install lets it (_persist_prompt_suppress_choice), and a kept Yes
  // asks nothing. No, and nothing is asked of the server. The page's own words stand while the install's are not
  // to hand.
  const QUESTION_WORDS = {
    title: "UI/Generic/Warning",
    yes: "UI/Common/Buttons/Yes",
    no: "UI/Common/Buttons/No",
  } as const;
  const OWN_QUESTION = ["Warning", "Probes launched here are likely to be lost to this pocket's environment. Scan anyway?"] as const;
  let abyssalQuestion = $state<{ readonly answer: (yes: boolean) => void } | null>(null);
  let dontAskAgain = $state(false);

  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(template) : own;
  }

  /** The scan, asked first in an Abyssal pocket as the client asks. */
  async function analyze(): Promise<void> {
    const read = $scanner.operations.status === "ready" ? $scanner.operations.value : null;
    if (read !== null && isAbyssalSystem(read.solarSystemID) &&
        !(ASKED_KEEPING_YES.has(ABYSSAL_SCAN_QUESTION) && flow.dialogYesKept(ABYSSAL_SCAN_QUESTION))) {
      dontAskAgain = false;
      const yes = await new Promise<boolean>((resolve) => {
        abyssalQuestion = { answer: resolve };
      });
      if (!yes) return;
    }
    await flow.analyzeScannerSignatures();
  }

  function answerAbyssal(yes: boolean): void {
    const waiting = abyssalQuestion;
    abyssalQuestion = null;
    if (waiting === null) return;
    // _persist_prompt_suppress_choice: Yes kept where the box was ticked.
    if (yes && dontAskAgain) flow.keepDialogYes(ABYSSAL_SCAN_QUESTION);
    waiting.answer(yes);
  }

  const typeNames = $derived.by(() => {
    const catalog: Record<number, string> = {};
    if ($scanner.scan.status === "ready") {
      for (const site of [
        ...$scanner.scan.value.anomalies,
        ...$scanner.scan.value.signatures,
        ...$scanner.scan.value.staticSites,
        ...$scanner.scan.value.structures,
      ]) {
        for (const value of [site.fields.typeID, site.fields.entryObjectTypeID]) {
          if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
            continue;
          }
          const name = $names.resolved[nameKey("type", value)];
          if (typeof name === "string" && name.trim() !== "") {
            catalog[value] = name;
          }
        }
      }
    }
    if ($scanner.operations.status === "ready") {
      const typeIDs = [
        $scanner.operations.value.launcher?.typeID,
        ...$scanner.operations.value.probes.map((probe) => probe.typeID),
      ];
      for (const value of typeIDs) {
        if (typeof value !== "number" || value <= 0) continue;
        const name = $names.resolved[nameKey("type", value)];
        if (typeof name === "string" && name.trim() !== "") catalog[value] = name;
      }
    }
    return catalog;
  });

  const actions = $derived.by((): ScannerActionBindings => {
    const operations = $scanner.operations;
    if (operations.status !== "ready" || !operations.value.inSpace) {
      return {};
    }
    // What each order would send, or why the client would not offer it now (bridge/scannerWrites.ts). The flow
    // reads the scanner again as an order is made, and goes by that.
    const read = operations.value;
    const launch = launchOf(read);
    const scan = scanOf(read);
    const recall = recallOf(read);
    const launcher = read.launcher;
    return {
      launch: {
        moduleID: "refusal" in launch ? 0 : launch.moduleID,
        count: "refusal" in launch ? 0 : launch.count,
        launcherName: launcher === null || launcher.typeID === null
          ? null
          : typeNames[launcher.typeID] ?? null,
        blocked: "refusal" in launch ? launch.refusal : undefined,
        run: () => flow.launchScannerProbes(),
      },
      recover: {
        probeIDs: "refusal" in recall ? [] : recall.probeIDs,
        blocked: "refusal" in recall ? recall.refusal : undefined,
        run: () => flow.recoverScannerProbes(),
      },
      analyze: {
        probeMap: "refusal" in scan || scan.probes === null ? {} : scan.probes,
        shipAlone: !("refusal" in scan) && scan.probes === null ? SHIP_SCANS_ALONE : undefined,
        blocked: "refusal" in scan ? scan.refusal : undefined,
        run: () => analyze(),
      },
      reconnect: {
        blocked: read.scanning === true ? SCAN_IN_PROGRESS : undefined,
        run: () => flow.reconnectScannerProbes(),
      },
    };
  });

  onMount(() => {
    // Session-loss handling lives in the flow; suppress only the otherwise
    // unhandled onMount promise after it has taken the character offline.
    void flow.loadScanner().catch(() => undefined);
    flow.requestWords([
      ...Object.values(QUESTION_WORDS),
      DO_NOT_ASK_AGAIN_LABEL,
      `dialog:${ABYSSAL_SCAN_QUESTION}/title`,
      `dialog:${ABYSSAL_SCAN_QUESTION}/body`,
      suppressableKey(ABYSSAL_SCAN_QUESTION),
      ...(retail ? ["UI/Inflight/Scanner/NoLauncherFitted", "UI/Inflight/Scanner/NoProbesLaunched", "UI/Inflight/Scanner/NoProbesInLauncher",
        "UI/Inflight/Scanner/ReconnectActiveProbes", "UI/Inflight/Scanner/RecoverActiveProbes", "UI/Inflight/Scanner/LaunchPinpointFormation",
        "UI/Inflight/Scanner/LaunchSpreadFormation", "UI/Inflight/Scanner/CenterOnSelf", "UI/Inflight/Scanner/ProbeSize", "UI/Inflight/Scanner/Analyze", "UI/Inflight/Scanner/ScanResults", "UI/Inflight/Scanner/NoScanResults"] : []),
    ]);
  });
</script>

{#if !retail}
<ScannerCenter
  scan={$scanner.scan}
  names={{ typeNames }}
  {actions}
  onRefresh={() => flow.loadScanner()}
/>
{/if}
{#if abyssalQuestion !== null}
  <!-- The client's warning before a scan in an Abyssal pocket: its title (the warning's own), body, the box that keeps
       Yes where the install lets it, Yes and No. -->
  {@const title = word(`dialog:${ABYSSAL_SCAN_QUESTION}/title`, word(QUESTION_WORDS.title, OWN_QUESTION[0]))}
  <div class="scan-question" role="alertdialog" aria-label={title}>
    <strong>{title}</strong>
    <p>{word(`dialog:${ABYSSAL_SCAN_QUESTION}/body`, OWN_QUESTION[1])}</p>
    {#if $words.templates[suppressableKey(ABYSSAL_SCAN_QUESTION)] === "1"}
      <label><input type="checkbox" bind:checked={dontAskAgain} /> {word(DO_NOT_ASK_AGAIN_LABEL, "Skip this question from now on")}</label>
    {/if}
    <p class="controls">
      <button type="button" onclick={() => answerAbyssal(true)}>{word(QUESTION_WORDS.yes, "Yes")}</button>
      <button type="button" class="minor" onclick={() => answerAbyssal(false)}>{word(QUESTION_WORDS.no, "No")}</button>
    </p>
  </div>
{/if}
{#if retail}
  {@const ops = $scanner.operations.status === "ready" ? $scanner.operations.value : null}
  {@const probeTypeID = ops?.probes[0]?.typeID ?? ops?.launcher?.chargeTypeID ?? null}
  {@const numProbes = ops?.probes.length ?? 0}
  <div class="ps-window">
    <div class="ps-results">
      {#if $scanner.probeResults === null}
        <!-- Before a scan: the filter row's caption (ScanResults) and the scroll's hint (NoScanResults) -->
        <div class="ps-filter">{word("UI/Inflight/Scanner/ScanResults", "Scan Results")}</div>
        <p class="ps-none">{word("UI/Inflight/Scanner/NoScanResults", "No scan results")}</p>
      {/if}
      <ProbeScanResults {store} {flow} />
    </div>
    <div class="ps-bottom">
      <div class="ps-state">
        <span class="ps-probe" class:dim={numProbes === 0}>{#if probeTypeID}<TypeIcon typeID={probeTypeID} name={typeNames[probeTypeID] ?? ""} />{/if}</span>
        <span class="ps-count" class:warn={numProbes === 0}>{numProbes > 0 ? `X ${numProbes}`
          : ops?.launcher === null ? word("UI/Inflight/Scanner/NoLauncherFitted", "No probe launcher fitted")
          : (ops?.launcher?.loadedCount ?? 0) > 0 ? word("UI/Inflight/Scanner/NoProbesLaunched", "No probes launched")
          : word("UI/Inflight/Scanner/NoProbesInLauncher", "No probes in launcher")}</span>
        <span class="ps-gap"></span>
        <button type="button" class="ps-icon" title={word("UI/Inflight/Scanner/ReconnectActiveProbes", "Reconnect to lost probes")}
          disabled={actions.reconnect?.blocked !== undefined} onclick={() => void flow.reconnectScannerProbes()}><img alt="" src="/client-res/ui/texture/classes/probescanner/16/reconnectprobesicon.png" /></button>
        <button type="button" class="ps-icon" title={word("UI/Inflight/Scanner/RecoverActiveProbes", "Recover active probes")}
          disabled={actions.recover?.blocked !== undefined || !actions.recover?.probeIDs.length} onclick={() => void flow.recoverScannerProbes()}><img alt="" src="/client-res/ui/texture/classes/probescanner/16/recoverprobesicon.png" /></button>
      </div>
      <div class="ps-footer">
        <button type="button" class="ps-form" title={word("UI/Inflight/Scanner/LaunchPinpointFormation", "Launch pinpoint formation")} disabled={ops === null || !ops.inSpace}
          onclick={() => void flow.launchProbeFormation(PINPOINT_FORMATION)}><img alt="" src="/client-res/ui/texture/classes/probescanner/32/pinpointformation.png" /></button>
        <button type="button" class="ps-form" title={word("UI/Inflight/Scanner/LaunchSpreadFormation", "Launch spread formation")} disabled={ops === null || !ops.inSpace}
          onclick={() => void flow.launchProbeFormation(SPREAD_FORMATION)}><img alt="" src="/client-res/ui/texture/classes/probescanner/32/spreadformation.png" /></button>
        <button type="button" class="ps-form" title={word("UI/Inflight/Scanner/CenterOnSelf", "Center on self")} disabled>
          <img alt="" src="/client-res/ui/texture/classes/probescanner/32/centerprobes.png" /></button>
        <span class="ps-slider"><input type="range" min="1" max="8" step="1" value="4" disabled title={word("UI/Inflight/Scanner/ProbeSize", "Probe size")} /></span>
        <button type="button" class="ps-analyze" disabled={actions.analyze?.blocked !== undefined} title={actions.analyze?.blocked ?? ""}
          onclick={() => void analyze()}>{word("UI/Inflight/Scanner/Analyze", "Analyze")}</button>
      </div>
    </div>
  </div>
{:else}
<ScannerProbes {store} {flow} />
<ProbeScanResults {store} {flow} />
{/if}

<style>
  .scan-question {
    border: 1px solid currentColor;
    padding: 0.5rem;
    margin: 0.5rem 0;
  }
</style>
