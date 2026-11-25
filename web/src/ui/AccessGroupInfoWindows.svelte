<script lang="ts">
  import { untrack } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { accessGroupInfoRequests } from "./accessGroupInfo.ts";
  import AccessGroupInformation from "./AccessGroupInformation.svelte";
  import DesktopWindow from "./DesktopWindow.svelte";
  import type { InfoWindowHost } from "./infoWindowHost.ts";
  import { portal } from "./portal.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { session, inFront, host }: { session: Session; inFront: boolean; host: InfoWindowHost | null } = $props();
  type GroupWindow = { id: string; groupID: number; x: number; y: number; w: number; h: number; z: number; minimized: boolean };
  let windows = $state.raw<readonly GroupWindow[]>([]);
  const words = $derived(session.store.words);
  const caption = "UI/Structures/AccessGroups/AccessGroup";
  let served = accessGroupInfoRequests.get();

  function update(id: string, patch: Partial<GroupWindow>) {
    windows = windows.map(win => win.id === id ? { ...win, ...patch } : win);
  }

  $effect(() => {
    const visibleHost = host;
    const flow = session.flow;
    if (!inFront || !visibleHost) return;
    return accessGroupInfoRequests.subscribe(request => {
      if (!request || request === served || request.source !== flow) return;
      served = request;
      untrack(() => {
        visibleHost.reveal();
        flow.requestWords([caption]);
        const id = `groupInfoWnd_${request.groupID}`;
        const z = visibleHost.topZ() + 1;
        if (windows.some(win => win.id === id)) {
          update(id, { z, minimized: false });
          return;
        }
        const w = Math.min(300, visibleHost.element.clientWidth || 300);
        const h = Math.min(210, visibleHost.element.clientHeight || 210);
        windows = [...windows, { id, groupID: request.groupID, w, h, z, minimized: false,
          x: Math.max(0, (visibleHost.element.clientWidth - w) / 2),
          y: Math.max(0, (visibleHost.element.clientHeight - h) / 2) }];
      });
    });
  });
</script>

{#if inFront && host && windows.length}
  <div class="access-group-info-layer" use:portal={host.element}>
    {#each windows as win (win.id)}
      <DesktopWindow {win} title={plainText($words.templates[caption] ?? "Access List")}
        icon={clientTexture("res:/ui/Texture/WindowIcons/accessGroups.png")}
        focused={win.z >= host.topZ()} resizable={!host.mobile}
        onFocus={() => update(win.id, { z: host!.topZ() + 1 })}
        onMove={(x, y) => update(win.id, { x, y })}
        onResize={(w, h) => update(win.id, { w: Math.max(200, w), h: Math.max(130, h) })}
        onToggleMinimize={() => update(win.id, { minimized: !win.minimized })}
        onClose={() => { windows = windows.filter(item => item.id !== win.id); }}>
        <AccessGroupInformation flow={session.flow} store={session.store} groupID={win.groupID} />
      </DesktopWindow>
    {/each}
  </div>
{/if}

<style>
  .access-group-info-layer { position: absolute; inset: 0; pointer-events: none; }
  .access-group-info-layer :global(.win) { pointer-events: auto; }
</style>
