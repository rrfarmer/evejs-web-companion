<script lang="ts" generics="Option extends { name: string }">
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { label, clear, selected, load, choiceKey, detail, choose }: {
    label: string;
    clear: string;
    selected: Option | undefined;
    load: (query: string) => Promise<readonly Option[]>;
    choiceKey: (choice: Option) => string | number;
    detail?: (choice: Option) => string;
    choose: (choice?: Option) => void;
  } = $props();

  let query = $state("");
  let choices = $state.raw<readonly Option[]>([]);
  let status = $state("");

  function select(choice?: Option) {
    query = "";
    choose(choice);
  }

  $effect(() => {
    void selected;
    query = "";
  });

  $effect(() => {
    const text = query.trim();
    choices = [];
    status = "";
    if (text.length < 2) return;
    status = "Searching…";
    let current = true;
    const timer = window.setTimeout(() => {
      void load(text).then(results => {
        if (!current) return;
        choices = results;
        status = results.length ? "" : "No matches";
      }, cause => {
        if (current) status = panelErrorWords(cause);
      });
    }, 200);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  });
</script>

<fieldset>
  <legend>{label}</legend>
  {#if selected}
    <span>{selected.name}</span>
    <button type="button" onclick={() => select()}>{clear}</button>
  {/if}
  <input type="search" aria-label={label} bind:value={query} autocomplete="off"
    onkeydown={event => { if (event.key === "Enter" && choices.length === 1) select(choices[0]); }} />
  {#if status}<p role="status">{status}</p>{/if}
  {#if choices.length}
    <div class="choices">
      {#each choices as choice (choiceKey(choice))}
        <button type="button" data-history-choice={choiceKey(choice)} onclick={() => select(choice)}>
          {choice.name}
          {#if detail}<small>{detail(choice)}</small>{/if}
        </button>
      {/each}
    </div>
  {/if}
</fieldset>

<style>
  fieldset { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0; }
  input { width: min(230px, 100%); }
  .choices { flex-basis: 100%; display: grid; gap: 3px; max-height: 12em; overflow: auto; }
  .choices button { text-align: start; }
  small { color: #b8c3cc; margin-inline-start: 4px; }
  p { margin: 0; }
</style>
