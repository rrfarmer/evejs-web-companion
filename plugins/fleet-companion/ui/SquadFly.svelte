<script lang="ts">
  // FLY on a squad in the Hangar: start its companions on the server, which keeps flying with
  // the tab shut and does not need them signed in here at all.
  //
  // A different thing from the Hangar's "ALL", which signs pilots into this tab, where they stop
  // when it closes. The title says so.
  import { createPluginRunGrant, startPluginRun, type JsonValue, type SquadControlProps } from "../../../web/src/plugin-api/index.ts";
  import { companionSetups, squadRoster } from "../lib/companionSettings.ts";
  import { analyzeCompanionRunPolicy } from "../lib/companionRunPolicy.ts";
  import { squadStartSummary, squadStartWarnings, startCompanionSquad, type SquadStartEntry } from "../lib/squadStart.ts";
  import { startCompanionFor } from "../lib/startCompanionFor.ts";

  let { squad, memberIDs, pilotNameFor, optionsFor, accountNameFor, onHandedOver, onChanged, say }: SquadControlProps = $props();
  const setups = companionSetups;
  const roster = $derived(squadRoster($setups, squad.id, memberIDs));
  let starting = $state(false);

  function words(rows: readonly SquadStartEntry[], notes: readonly string[], done: string | null): readonly string[] {
    return [
      ...notes.map((note) => `Before they go: ${note}`),
      ...rows.map((row) => {
        const state = row.state === "queued" ? "waiting" : row.state === "starting" ? "starting" : row.state === "started" ? "started" : (row.sentence ?? "could not start");
        return `${pilotNameFor(row.characterID)} - ${state}`;
      }),
      ...(done === null ? [] : [done]),
    ];
  }

  async function fly(): Promise<void> {
    if (starting) return;
    const targets = roster;
    const notes = squadStartWarnings(targets);
    say(words(targets.map((target) => ({ characterID: target.characterID, state: "queued" as const })), notes, null));
    starting = true;
    try {
      const entries = await startCompanionSquad(
        {
          // The grant is built per pilot, from that pilot's own setup: the host works out what
          // the setup risks and refuses a start whose grant does not match.
          startCompanion: async (characterID, setup) => {
            const policy = analyzeCompanionRunPolicy(setup);
            const grant = createPluginRunGrant({ riskClasses: policy.riskClasses, restartSafe: policy.restartSafe });
            // That pilot's own identity, not the tab's. Signed in here, its own session must be
            // the caller, because the start hands that session's hull over.
            const held = optionsFor(characterID);
            if (held === null) {
              await startCompanionFor(accountNameFor(characterID), characterID, setup, grant);
              return;
            }
            // Start first, then sync: a refused start must change nothing, so the tab only lets
            // go of a hull the host has actually taken.
            await startPluginRun(characterID, "fleet-companion", "fly", setup as unknown as JsonValue, grant, held);
            try {
              await onHandedOver(characterID);
            } catch {
              // The bot has the hull either way; the tab's next read notices.
            }
          },
        },
        targets,
        (rows) => say(words(rows, notes, null)),
      );
      say(words(entries, notes, squadStartSummary(entries)));
      onChanged();
    } finally {
      starting = false;
    }
  }
</script>

{#if roster.length > 0}
  <button
    type="button"
    class="hangar-launch"
    disabled={starting}
    title={`Start the fleet companions of ${squad.name} on the server - they keep flying when this tab closes`}
    onclick={() => void fly()}
  >FLY</button>
{/if}
