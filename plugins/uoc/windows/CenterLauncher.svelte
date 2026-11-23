<script lang="ts">
 import {onMount} from 'svelte';
 let {href,title}:{href:string;title:string}=$props();
 onMount(()=>{window.open(href,'_blank','noopener,noreferrer');});
</script>
<p>{title} opens in its own page.</p><a {href} target="_blank" rel="noopener noreferrer">Open {title}</a>
