<script lang="ts">
  // The bridge's mount point. Renders nothing.
  //
  // Keeps the store and gateway notification listeners bound to the displayed pilot.
  //
  // ⚠ MOUNTED EXACTLY ONCE PER WORKSPACE, ALONGSIDE THE FLASH. Two of these
  // over the same store would double every notice past the dedupe window.
  import { watchNotices } from "./noticeBridge.ts";
  import { notify } from "./notices.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  $effect(() => watchNotices(store));
  $effect(() => {
    const header = "UI/Seasons/Notifications/VanguardNemesisConvoyStartedHeader";
    const body = "UI/Seasons/Notifications/VanguardNemesisConvoyStartedBody";
    flow.requestWords([header, body]);
    const completed = flow.agencyVanguardCompleted;
    let previous = completed.get();
    return completed.subscribe(n => {
      if (n === previous) return;
      previous = n;
      const words = store.words.get().templates;
      notify({
        kind: "info",
        title: plainText(words[header] ?? "") || "SARO Black Sites revealed",
        detail: plainText(words[body] ?? "") || "SARO Black Sites have been revealed near your location.",
        key: `vanguard-track:${store.station.get().online?.characterID}:${n}`,
      });
    });
  });
</script>
