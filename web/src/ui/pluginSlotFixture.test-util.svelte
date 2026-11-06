<script lang="ts">
  // What a plugin might draw in the Pilot Hangar, for pilotHangar.test.ts to see it drawn.
  let props: Record<string, unknown> = $props();
</script>

<span class="plugin-slot-fixture">{JSON.stringify(props.memberIDs ?? props.characterID)}</span>
