<script lang="ts">
  import ModulePage from "../page/ModulePage.svelte";
  import type { GlobalWindowProps } from "../../../web/src/plugin-api/index.ts";
  let {sessions=[],onOpen}:GlobalWindowProps=$props();
</script>
<ModulePage page="home" {sessions} {onOpen}/>
<p><a href="/uoc/" target="_blank" rel="noopener noreferrer">Open a separate Operations Center page</a> · Existing Cockpit controls are available in this workspace.</p>
