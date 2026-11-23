<script lang="ts">
  import { onMount, type Component } from "svelte";
  import { followPageRoster, type PluginPageProps } from "../app/pluginPageSession.ts";

  let { Page, link }: { Page: Component<PluginPageProps>; link: string | null } = $props();
  let roster = $state.raw<PluginPageProps | null>(null);

  onMount(() => {
    const connect = () => followPageRoster(link, context => { roster = context; });
    let disconnect = connect();
    const hide = () => disconnect();
    const show = (event: PageTransitionEvent) => { if (event.persisted) disconnect = connect(); };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      disconnect();
    };
  });
</script>

{#if roster}
  <Page sessions={roster.sessions} activeSession={roster.activeSession} />
{:else}
  <p role="status">Connecting to Web Companion...</p>
{/if}
