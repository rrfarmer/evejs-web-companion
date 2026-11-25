<script lang="ts">
  import { onMount } from "svelte";
  import {
    checkPluginRun,
    createPluginRunGrant,
    startPluginRun,
    stopServerBot,
  } from "../../../../web/src/plugin-api/index.ts";
  import {
    active,
    positive,
    type Carrier,
    type Config,
    type Operation,
  } from "../../logistics/model.ts";
  import type { DistributionView, FleetRow } from "../../logistics/store.ts";
  import {
    findAccessibleStructures,
    findHangarPilot,
    findMapLocations,
    openPageAccount,
    resolveDestination,
    type VerifiedOperationPilot,
  } from "../app/api.ts";
  import { authenticatedJson, ownerOptions, type ApiOptions } from "../app/context.ts";
  import { pollWhileVisible } from "../app/pageVisibility.ts";
  import { readTrainingActiveShip } from "../adapters/training.ts";
  import DistributionEditor from "./DistributionEditor.svelte";
  import DistributionWorkspace, {
    type Availability,
    type Section,
  } from "./DistributionWorkspace.svelte";
  import OperationPilotPicker from "./OperationPilotPicker.svelte";
  import CenterHeading from "./CenterHeading.svelte";

  const prefix = "/api/plugins/uoc/logistics";
  let { operatorAccount }: { operatorAccount?: string } = $props();
  let access: ApiOptions | undefined;
  let view = $state.raw<DistributionView | null>(null),
    section = $state<Section>("operations");
  let selectedID = $state<string | null>(null),
    editing = $state.raw<{ operation?: Operation } | null>(null);
  let adding = $state(false),
    loading = $state(true),
    busy = $state(false),
    issue = $state("");
  let availability = $state<Record<number, Availability>>({});
  let names = $state<Record<number, string | null>>({}),
    docks = $state<Record<number, string | null>>({});
  let generation = 0,
    disposed = false;
  let visible: AbortSignal | undefined, enriching: AbortSignal | undefined;
  const selected = $derived(
    view?.operations.find((row) => row.id === selectedID) ?? view?.operations[0],
  );
  const corporations = $derived([
    ...new Map(
      (view?.roster ?? []).flatMap((row) => {
        const id = row.hosted?.corporationID ?? row.corporationID;
        return positive(id)
          ? [[id, { id, name: row.corporationName ?? "Hauler's corporation" }] as const]
          : [];
      }),
    ).values(),
  ]);

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const options = () => {
    if (!access) throw Error("Open a saved WC account in Pilot Hangar.");
    return access;
  };

  function show(latest: DistributionView) {
    if (disposed) return;
    for (const row of latest.roster)
      if (
        !row.hosted &&
        view?.roster.some((previous) => previous.characterID === row.characterID && previous.hosted)
      )
        delete availability[row.characterID];
    view = latest;
    if (visible && !visible.aborted && enriching !== visible) void readLabels(latest, visible);
  }
  async function readLabels(latest: DistributionView, signal: AbortSignal) {
    enriching = signal;
    try {
      const typeIDs = new Set<number>();
      for (const row of latest.roster) {
        if (positive(row.hosted?.shipTypeID)) typeIDs.add(row.hosted.shipTypeID);
        for (const item of row.trip?.cargo ?? []) typeIDs.add(item.typeID);
        if (row.trip?.checking) typeIDs.add(row.trip.checking.typeID);
      }
      const locations = new Set<number>();
      for (const op of latest.operations) {
        for (const item of op.config.items) if (!item.name) typeIDs.add(item.typeID);
        for (const id of Object.keys(op.execution?.delivered ?? {})) typeIDs.add(Number(id));
        for (const item of op.execution?.unshipped ?? []) typeIDs.add(item.typeID);
        for (const dock of [op.config.source, op.config.destination])
          if (!dock.name && docks[dock.destinationID] === undefined)
            locations.add(dock.destinationID);
      }
      const pending = [...typeIDs].filter((id) => names[id] === undefined);
      for (let start = 0; start < pending.length; start += 50) {
        const batch = pending.slice(start, start + 50);
        const result = await authenticatedJson(
          "/api/names",
          { ...options(), signal },
          { items: batch.map((id) => ({ kind: "type", id })) },
        );
        if (signal.aborted) return;
        for (const id of batch) names[id] = result.names?.["type:" + id] ?? null;
      }
      for (const id of locations) {
        const resolved = await resolveDestination(id, { ...options(), signal }).catch(() => null);
        if (signal.aborted) return;
        docks[id] = resolved?.name ?? null;
      }
    } catch {
      /* Names are optional and do not delay fleet commands. */
    } finally {
      if (enriching === signal) enriching = undefined;
    }
  }

  async function sync(path: string, body: unknown, auth = options()) {
    const latest = await authenticatedJson<DistributionView>(prefix + path, auth, body);
    show(latest);
    return latest;
  }
  async function poll(signal: AbortSignal, initial: boolean) {
    visible = signal;
    if (busy || disposed) return;
    const at = generation;
    try {
      if (initial && !access) {
        const selected = await openPageAccount(operatorAccount, undefined, signal);
        if (signal.aborted) return;
        access = selected?.options;
      }
      if (!access) return;
      const latest = await authenticatedJson<DistributionView>(prefix, { ...access, signal });
      if (!signal.aborted && at === generation) show(latest);
    } catch (error) {
      if (!signal.aborted && at === generation) issue = message(error);
    } finally {
      if (!signal.aborted) loading = false;
    }
  }

  onMount(() => {
    const stop = pollWhileVisible(4_000, poll);
    return () => {
      disposed = true;
      stop();
    };
  });

  async function task(action: () => Promise<void>) {
    if (busy) return;
    ++generation;
    busy = true;
    issue = "";
    try {
      await action();
    } catch (error) {
      issue = message(error);
    } finally {
      busy = false;
    }
  }

  type ActiveBot = {
    botID: string;
    characterID: number;
    endedAt: string | null;
    plugin?: { pluginID: string; run: string };
  };
  async function check(carrier: Carrier) {
    const { account, options: auth } = await findHangarPilot(carrier.characterID);
    const [data, response] = await Promise.all([
      authenticatedJson<{ bots: ActiveBot[]; hostedRunPolicy?: { maxRuntimeMinutes: number } }>(
        "/api/bots",
        auth,
      ),
      authenticatedJson("/api/pilot-training/ownership?characterID=" + carrier.characterID, auth),
    ]);
    if (!Array.isArray(data.bots) || response.ownership?.characterID !== carrier.characterID)
      throw Error("Could not verify this pilot in Bot Host.");
    const bot = data.bots.find((row) => row.characterID === carrier.characterID && !row.endedAt);
    const ours =
      bot?.plugin?.pluginID === "uoc" && bot.plugin.run === "distribution-carrier"
        ? bot.botID
        : undefined;
    const accountBusy = data.bots.some(
      (row) => row.characterID !== carrier.characterID && !row.endedAt,
    );
    const free =
      !bot &&
      !accountBusy &&
      response.ownership.owner === "OFF" &&
      response.ownership.online === false;
    const label = ours
      ? "Connected"
      : free
        ? "Available"
        : accountBusy
          ? "Account in use"
          : bot || response.ownership.online === true
            ? "In use elsewhere"
            : "Availability unknown";
    availability[carrier.characterID] = {
      label,
      available: free,
      botID: ours,
      shipName: availability[carrier.characterID]?.shipName,
    };
    return { account, auth, ours, free, label, maximum: data.hostedRunPolicy?.maxRuntimeMinutes };
  }

  async function connect(carrier: Carrier) {
    try {
      const state = await check(carrier);
      if (state.ours) return;
      if (!state.free) throw Error(state.label);
      if (!positive(state.maximum))
        throw Error("Bot Host did not provide a permitted run duration.");
      const auth = await ownerOptions(state.account);
      const reviewed = await checkPluginRun(
        "uoc",
        "distribution-carrier",
        { characterID: carrier.characterID },
        auth,
      );
      const bot = await startPluginRun(
        carrier.characterID,
        "uoc",
        "distribution-carrier",
        reviewed.setup,
        createPluginRunGrant(reviewed.policy, state.maximum),
        auth,
      );
      if (bot.characterID !== carrier.characterID || bot.endedAt || !bot.botID)
        throw Error("Bot Host did not accept this hauler.");
      availability[carrier.characterID] = {
        label: "Connected",
        available: false,
        botID: bot.botID,
      };
    } catch (error) {
      const status = availability[carrier.characterID];
      availability[carrier.characterID] = {
        ...status,
        label: status?.label ?? "Connection unavailable",
        available: status?.available ?? true,
        issue: message(error),
      };
    }
  }

  async function refreshCarrier(carrier: Carrier) {
    try {
      const { auth } = await check(carrier);
      const shipName = await readTrainingActiveShip(carrier.characterID, auth).catch(() => null);
      if (shipName)
        availability[carrier.characterID] = { ...availability[carrier.characterID]!, shipName };
    } catch (error) {
      availability[carrier.characterID] = {
        label: "Availability unknown",
        available: true,
        issue: message(error),
      };
    }
  }

  function refreshAvailability() {
    return task(async () => {
      for (const carrier of view?.roster ?? []) if (!carrier.hosted) await refreshCarrier(carrier);
    });
  }

  function addHauler(pilot: VerifiedOperationPilot) {
    void task(async () => {
      const { pilot: current, options: auth } = await findHangarPilot(
        pilot.characterID,
        pilot.accountName,
      );
      const latest = await sync(
        "/roster",
        {
          characterID: current.characterID,
          name: current.name,
          shipName: current.shipName ?? current.shipTypeName ?? pilot.shipName,
          corporationID: current.corporationID,
          corporationName: current.corporationName,
        },
        auth,
      );
      adding = false;
      const row = latest.roster.find((carrier) => carrier.characterID === pilot.characterID);
      if (
        row &&
        latest.operations.some(
          (op) =>
            op.execution?.state === "RUNNING" && op.config.corporationID === row.corporationID,
        )
      ) {
        await connect(row);
      } else if (row) await refreshCarrier(row);
    });
  }

  function disconnect(carrier: FleetRow) {
    void task(async () => {
      if (carrier.trip || (carrier.hosted && carrier.hosted.phase !== "Idle"))
        throw Error("This hauler still has an assigned trip.");
      const state = await check(carrier);
      if (!state.ours) return;
      await stopServerBot(state.ours, await ownerOptions(state.account));
      delete availability[carrier.characterID];
      show(await authenticatedJson<DistributionView>(prefix, options()));
    });
  }

  function start(op: Operation) {
    if (op.config.allItems) {
      const { source, destination, mode } = op.config;
      const division = (office: Config["source"]) => {
        const dock = office.name ?? docks[office.destinationID] ?? `${office.kind} ${office.destinationID}`;
        return `Division ${office.division} at ${dock}`;
      };
      const message = [
        `Move all eligible items from ${division(source)} to ${division(destination)}?`,
        "This includes containers and their contents, as well as stock set aside for other work. Assembled ships stay at the source.",
      ];
      if (mode === "COLLECTION")
        message.push("Collection keeps any configured reserves at the source and picks up new arrivals until stopped.");
      if (!window.confirm(message.join("\n\n"))) return;
    }

    void task(async () => {
      const latest = await sync("/" + op.id + "/start", {});
      const corporation = latest.operations.find((row) => row.id === op.id)?.config.corporationID;
      const available = latest.roster.filter(
        (row) => !row.hosted && (row.corporationID === corporation || !row.corporationID),
      );
      for (const row of available) await connect(row);
      const failed = available.filter((row) => availability[row.characterID]?.issue);
      if (failed.length)
        issue = failed
          .map((row) => row.name + " — " + availability[row.characterID]!.issue)
          .join(" · ");
      show(await authenticatedJson<DistributionView>(prefix, options()));
    });
  }

  function save(config: Config) {
    const id = editing?.operation?.id;
    void task(async () => {
      const latest = await sync("/save", { id, config });
      selectedID = id ?? latest.operations.at(-1)?.id ?? null;
      editing = null;
    });
  }

  async function searchDocks(query: string, corporationID: number | null) {
    const stationSearch = findMapLocations(query, "station", options());
    const representative = view?.roster.find(
      (row) =>
        corporationID === null ||
        (row.hosted?.corporationID ?? row.corporationID) === corporationID,
    );
    const upwellSearch = representative
      ? findHangarPilot(representative.characterID).then(({ options: auth }) =>
          findAccessibleStructures(query, auth, representative.characterID),
        )
      : Promise.reject(Error("Add a hauler from this corporation to search its Upwell docks."));
    const [stations, upwell] = await Promise.allSettled([stationSearch, upwellSearch]);
    const matches = [
      ...(stations.status === "fulfilled" ? stations.value.matches : []),
      ...(upwell.status === "fulfilled" ? upwell.value : []),
    ].flatMap((row) =>
      (row.kind === "station" || row.kind === "structure") && positive(row.solarSystemID)
        ? [
            {
              destinationID: row.id,
              systemID: row.solarSystemID,
              kind: row.kind,
              name: row.name,
              solarSystemName: row.solarSystemName,
            },
          ]
        : [],
    );
    const notes = [
      stations.status === "rejected" ? "Station search is unavailable." : "",
      upwell.status === "rejected"
        ? representative
          ? "Could not read this pilot's Upwell docks."
          : message(upwell.reason)
        : "",
    ].filter(Boolean);
    return { matches, note: notes.join(" ") || undefined };
  }

  async function searchItems(query: string) {
    const result = await authenticatedJson(
      "/api/market/find?q=" + encodeURIComponent(query),
      options(),
    );
    if (!Array.isArray(result.matches)) throw Error("The item catalog is unavailable.");
    return (result.matches as { typeID: number; name: string; groupName?: string }[]).filter(
      (item) => positive(item.typeID) && typeof item.name === "string" && !!item.name,
    );
  }
</script>

<svelte:head><title>Distribution Center · EveJS Web Companion</title></svelte:head>

{#snippet picker()}
  <OperationPilotPicker
    disabled={busy}
    chooseLabel="Add from Pilot Hangar"
    canChoose={(pilot) => !view?.roster.some((row) => row.characterID === pilot.characterID)}
    onChoose={addHauler}
  />
{/snippet}

{#snippet editor()}
  {#key editing}
    <DistributionEditor
      initial={editing?.operation?.config}
      {corporations}
      {busy}
      onSearchDocks={searchDocks}
      onSearchItems={searchItems}
      onSave={save}
      onCancel={() => {
        editing = null;
      }}
    />
  {/key}
{/snippet}

{#if view}
  <DistributionWorkspace
    {view}
    {section}
    {selected}
    {availability}
    {names}
    {docks}
    {busy}
    {issue}
    {adding}
    addPilot={picker}
    editor={editing ? editor : undefined}
    onSection={(next) => {
      section = next;
      if (next === "fleet") void refreshAvailability();
    }}
    onSelect={(id) => {
      selectedID = id;
      editing = null;
    }}
    onNew={() => {
      editing = {};
    }}
    onEdit={(operation) => {
      editing = { operation };
    }}
    onStart={start}
    onStop={(op) => {
      void task(async () => {
        await sync("/" + op.id + "/stop", { executionID: op.execution?.id });
      });
    }}
    onAdd={() => {
      adding = !adding;
    }}
    onRefresh={refreshAvailability}
    onConnect={(carrier) => {
      void task(async () => {
        await connect(carrier);
      });
    }}
    onDisconnect={disconnect}
    onRemove={(carrier) => {
      void task(async () => {
        await sync("/roster/remove", { characterID: carrier.characterID });
      });
    }}
  />
{:else}
  <main class="uoc-center">
    <CenterHeading title="Distribution Center" />
    {#if loading}<p role="status">Loading the transport fleet…</p>
    {:else if issue}<p class="center-message" role="alert">{issue}</p>
    {:else}<p>
        Open a saved WC account in <a href="/">Pilot Hangar</a> to manage the transport fleet.
      </p>{/if}
  </main>
{/if}
