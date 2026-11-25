<script lang="ts">
  import type { Snippet } from "svelte";
  let { title, description, actions }: { title: string; description?: string; actions?: Snippet } =
    $props();
</script>

<header class="center-heading">
  <a class="center-back" href="/uoc/">‹ Operations Center</a>
  <div class="center-title-row">
    <div
      ><h1>{title}</h1>{#if description}<p>{description}</p>{/if}</div
    >
    {#if actions}<div class="center-actions">{@render actions()}</div>{/if}
  </div>
</header>
