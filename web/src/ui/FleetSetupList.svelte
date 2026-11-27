<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { SavedFleetSetup } from "../bridge/fleetSetups.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const { fleet, words } = store;
  // svelte-ignore state_referenced_locally
  const revision = flow.fleetSetupRevision;
  const F = "UI/Fleet/FleetWindow/";
  const loadLabel = F + "LoadFleetSetup", deleteLabel = "UI/Common/Buttons/Delete";
  let setups = $state<SavedFleetSetup[]>([]);
  let pending = $state(false), error = $state("");

  $effect(() => {
    void $revision;
    let active = true;
    void flow.readFleetSetups().then(list => { if (active) setups = list.sort((a, b) => a.name.localeCompare(b.name)); }, cause => {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
    });
    return () => { active = false; };
  });
  $effect(() => flow.requestWords([loadLabel, deleteLabel, F + "FreeMoveOn", F + "FreeMoveOff", F + "UnnamedSquad"]));

  function word(label: string, fallback: string): string {
    return $words.templates[label] || fallback;
  }

  async function apply(work: () => Promise<void>): Promise<void> {
    if (pending) return;
    pending = true;
    error = "";
    try { await work(); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { pending = false; }
  }
</script>

<section class="fleet-setup-list">
  {#if error}<p role="alert">{error}</p>{/if}
  <ul>
    {#each setups as setup (setup.name)}
      {@const fleetID = $fleet.authoritativeFleetID}
      {@const hierarchy = setup.wings.flatMap(wing => [wing.wing, ...wing.squads.map(squad => `  ${squad || word(F + "UnnamedSquad", "Unnamed Squad")}`)]).join("\n")}
      <li data-fleet-setup={setup.name} title={hierarchy}>
        <span class="setup-title">{setup.name}</span>
        {#if setup.motd !== undefined}<span class="detail" title={plainText(setup.motd)} aria-label="Message of the Day">MOTD</span>{/if}
        {#if setup.freeMove !== undefined}<span class="detail">{setup.freeMove ? word(F + "FreeMoveOn", "Free-Move On") : word(F + "FreeMoveOff", "Free-Move Off")}</span>{/if}
        <button type="button" disabled={pending || fleetID === null} onclick={() => {
          if (fleetID !== null) void apply(() => flow.loadFleetSetup(fleetID, setup.name));
        }}>{word(loadLabel, "Load Fleet Setup")}</button>
        <button type="button" disabled={pending} onclick={() => void apply(() => flow.deleteFleetSetup(setup.name))}>{word(deleteLabel, "Delete")}</button>
      </li>
    {/each}
  </ul>
</section>

<style>
  section { padding: .45rem .6rem; }
  ul { padding: 0; margin: 0; list-style: none; }
  li { display: flex; align-items: center; gap: .25rem; flex-wrap: wrap; min-height: 30px; }
  .setup-title { flex: 1; overflow-wrap: anywhere; }
  .detail { color: var(--color-muted); font-size: .8em; }
  button { min-height: 23px; }
</style>
