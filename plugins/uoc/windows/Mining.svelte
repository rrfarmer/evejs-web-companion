<script lang="ts">
 import ModulePage from '../page/ModulePage.svelte';
 import type {GlobalWindowProps} from '../../../web/src/plugin-api/index.ts';
 let {sessions=[],onOpen}:GlobalWindowProps=$props();
</script>
<ModulePage page="mining-operations" {sessions} {onOpen}/>
