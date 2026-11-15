<script lang="ts">
  // WHICH CORPORATION an agent finder step is limited to: "any corporation", or
  // one of the corporations that employ agents of the step's kind.
  //
  // A list, not a text field, because the finder filters by corporation ID and a
  // typed name carries none: every name a player typed used to fail the step's
  // check. The list is read once per mount from the static agent table.
  //
  // Its own component for the reason `CorpHangarPicker.svelte` is one: Svelte
  // templates are not type-checked here, and an SSR render is the only net a
  // template has. Everything arrives as a prop.

  import type { AppFlow } from "../app/flow.ts";
  import type { AgentCorporation } from "../bots/agentCorporations.ts";

  let {
    id,
    flow,
    kind,
    value,
    onPick,
  }: {
    id: string;
    flow: Pick<AppFlow, "loadAgentCorporations">;
    /** The agents the step looks for: "courier" (delivery) or "encounter" (combat). */
    kind: "courier" | "encounter";
    /** The corporation the step holds now, or null for any corporation. */
    value: { id: number | null; name: string | null } | null;
    onPick: (corporation: AgentCorporation | null) => void;
  } = $props();

  let corporations = $state<readonly AgentCorporation[]>([]);
  let readError = $state<string | null>(null);
  let loading = $state(true);
  let loaded = false;

  $effect(() => {
    if (loaded) {
      return;
    }
    loaded = true;
    void (async () => {
      try {
        const result = await flow.loadAgentCorporations(kind);
        corporations = result.corporations;
        readError = result.error;
      } catch {
        readError = "the read failed";
      } finally {
        loading = false;
      }
    })();
  });

  // A step saved before this list existed holds a typed name and no ID. It is
  // shown as it is, so the player sees what the step's check is refusing, and
  // can choose a corporation from the list or "any corporation" instead.
  const typedOnly = $derived(value !== null && value.id === null ? value.name ?? "" : null);
  // A chosen corporation the list does not hold (still loading, a failed read)
  // stays selected under the name the step saved with it.
  const heldOutside = $derived(
    value !== null && value.id !== null && !corporations.some((c) => c.id === value.id) ? value : null,
  );
  const selected = $derived(value === null ? "" : value.id === null ? "typed" : String(value.id));

  function pick(raw: string): void {
    if (raw === "") {
      onPick(null);
      return;
    }
    const match = corporations.find((c) => String(c.id) === raw);
    if (match !== undefined) {
      onPick(match);
    }
  }
</script>

<select {id} value={selected} onchange={(e) => pick(e.currentTarget.value)}>
  <option value="">any corporation</option>
  {#if typedOnly !== null}<option value="typed" disabled>{typedOnly} (typed, choose from the list)</option>{/if}
  {#if heldOutside !== null && heldOutside.id !== null}<option value={String(heldOutside.id)}>{heldOutside.name ?? `Corporation ${heldOutside.id}`}</option>{/if}
  {#each corporations as corporation (corporation.id)}<option value={String(corporation.id)}>{corporation.name}</option>{/each}
</select>
{#if loading}<span class="inspector-unit">reading corporations...</span>{/if}
{#if readError !== null}<p class="note">Could not read the corporations: {readError}</p>{/if}
