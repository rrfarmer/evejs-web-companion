<script lang="ts">
  // WHICH CORPORATION an agent finder step is limited to: "any corporation", or
  // one of the corporations that employ agents of the step's kind.
  //
  // A list, not a text field, because the finder filters by corporation ID and a
  // typed name carries none: every name a player typed used to fail the step's
  // check. The list is read from the static agent table, once per finder kind.
  //
  // Its own component for the reason `CorpHangarPicker.svelte` is one: Svelte
  // templates are not type-checked here, and an SSR render is the only net a
  // template has. Everything arrives as a prop.

  import type { AppFlow } from "../app/flow.ts";
  import type { AgentCorporation, AgentFinderKind } from "../bots/agentCorporations.ts";

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
    kind: AgentFinderKind;
    /** The corporation the step holds now, or null for any corporation. */
    value: { id: number | null; name: string | null } | null;
    onPick: (corporation: AgentCorporation | null) => void;
  } = $props();

  let corporations = $state<readonly AgentCorporation[]>([]);
  let readError = $state<string | null>(null);
  let loading = $state(true);
  // The inspector keeps this picker when the selection moves from one finder
  // step to another (the argument is "corporation" on both), so the list is
  // read again whenever the kind changes, and a late answer for the old kind is
  // dropped rather than shown under the new one.
  let readFor: AgentFinderKind | null = null;

  $effect(() => {
    const wanted = kind;
    if (readFor === wanted) {
      return;
    }
    readFor = wanted;
    corporations = [];
    readError = null;
    loading = true;
    void (async () => {
      let answer: { corporations: readonly AgentCorporation[]; error: string | null };
      try {
        answer = await flow.loadAgentCorporations(wanted);
      } catch {
        answer = { corporations: [], error: "the read failed" };
      }
      if (readFor !== wanted) {
        return;
      }
      corporations = answer.corporations;
      readError = answer.error;
      loading = false;
    })();
  });

  // A step saved before this list existed holds a typed name and no ID. It is
  // shown as it is, so the player sees what the step's check is refusing, and
  // can choose a corporation from the list or "any corporation" instead.
  const typedOnly = $derived(value !== null && value.id === null ? value.name ?? "" : null);
  // A chosen corporation the list does not hold (still loading, a failed read)
  // is listed under the name the step saved with it. It is one keyed list with
  // the read ones, so when the read lands the chosen option is the same element
  // and stays selected, instead of being removed and added back.
  const shown = $derived.by((): readonly AgentCorporation[] => {
    if (value === null || value.id === null || corporations.some((c) => c.id === value.id)) {
      return corporations;
    }
    return [{ id: value.id, name: value.name ?? `Corporation ${value.id}` }, ...corporations];
  });
  const selected = $derived(value === null ? "" : value.id === null ? "typed" : String(value.id));

  function pick(raw: string): void {
    if (raw === "") {
      onPick(null);
      return;
    }
    const match = shown.find((c) => String(c.id) === raw);
    if (match !== undefined) {
      onPick(match);
    }
  }
</script>

<select {id} value={selected} onchange={(e) => pick(e.currentTarget.value)}>
  <option value="">any corporation</option>
  {#if typedOnly !== null}<option value="typed" disabled>{typedOnly} (typed, choose from the list)</option>{/if}
  {#each shown as corporation (corporation.id)}<option value={String(corporation.id)} selected={String(corporation.id) === selected}>{corporation.name}</option>{/each}
</select>
{#if loading}<span class="inspector-unit">reading corporations...</span>{/if}
{#if readError !== null}<p class="note">Could not read the corporations: {readError}</p>{/if}
