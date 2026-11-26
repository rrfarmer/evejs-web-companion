<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { dungeonTravelAction } from "../bridge/dungeonJobs.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { isWaypointPlace } from "../nav/waypoints.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, solarSystemID }: { store: ClientStore; flow: AppFlow; solarSystemID: number } = $props();
  const flight = $derived(store.flight);
  const station = $derived(store.station);
  const waypoints = $derived(flow.waypoints);
  const names = $derived(store.names);
  const words = $derived(store.words);
  const here = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const docked = $derived($flight.status?.docked ?? Boolean($station.online?.stationID || $station.online?.structureID));
  const local = $derived(here === solarSystemID);
  const jumps = $derived(local ? 0 : ($names.autopilotJumps?.[`${here}:${solarSystemID}`] ?? null));
  const destinationSet = $derived($waypoints.at(-1) === solarSystemID);
  const action = $derived(isWaypointPlace(solarSystemID) ? dungeonTravelAction({
    local, inside: false, docked, destinationSet, jumps, targetID: null,
  }) : null);
  const warping = $derived(/warp/i.test($flight.status?.shipMode ?? ""));
  const labels = {
    destination: ["UI/Inflight/SetDestination", "Set Destination"],
    undock: ["UI/Neocom/UndockBtn", "Undock"],
    jump: ["UI/Inflight/Jump", "Jump"],
    jumps: ["UI/Common/numberOfJumps", "{numJumps} jumps"],
  } as const;
  const word = (key: keyof typeof labels, args: Record<string, number> = {}) =>
    plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1], args, { nameOf: () => "" }));
  let busy = $state(false);
  let failure = $state<{ target: number; message: string } | null>(null);
  $effect(() => {
    if (here !== null && isWaypointPlace(solarSystemID) && !local) flow.requestAutopilotJumps(here, [solarSystemID]);
  });
  $effect(() => { flow.requestWords(Object.values(labels).map(([path]) => path)); });

  async function travel() {
    const current = action;
    if (!current || current === "warp" || busy || warping) return;
    const target = solarSystemID;
    busy = true;
    failure = null;
    try {
      if (current === "destination") await flow.setDestination(target);
      else if (current === "undock") await flow.undock();
      else await flow.jumpAlongWaypoints(target);
    } catch (cause) {
      failure = { target, message: panelErrorWords(cause) };
    } finally { busy = false; }
  }
</script>

{#if action && action !== "warp"}
  <div class="mto-travel">
    {#if jumps && jumps > 0}<small>{word("jumps", { numJumps: jumps })}</small>{/if}
    <button class="mto-travel-action" type="button" disabled={busy || warping} onclick={() => void travel()}>{word(action)}</button>
  </div>
{/if}
{#if failure?.target === solarSystemID}<small role="alert">{failure.message}</small>{/if}

<style>
  .mto-travel { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  small { color: #b8c3cc; }
</style>
