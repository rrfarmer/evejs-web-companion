<script lang="ts">
  import { onMount } from "svelte";
  import { workspaceAccounts } from "../app/context.ts";

  let { account = "", disabled = false, label, onChoose }: {
    account?: string; disabled?: boolean; label: string;
    onChoose: (name: string) => void;
  } = $props();
  let choices = $state<string[]>([]);

  function refresh() { choices = workspaceAccounts(); }
  onMount(refresh);
</script>

{#if choices.length > 1}
  <label>{label}
    <select value={account} {disabled} onfocus={refresh} onchange={event => onChoose(event.currentTarget.value)}>
      {#each choices as name (name)}<option value={name}>{name}</option>{/each}
    </select>
  </label>
{/if}
