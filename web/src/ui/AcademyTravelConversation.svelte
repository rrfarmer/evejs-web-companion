<script lang="ts">
  import { onMount } from "svelte";
  import { getAcademyTravelConversation } from "../app/api.ts";
  import type { Session } from "../app/sessions.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import ConversationTransmission from "./ConversationTransmission.svelte";

  let { session }: { session: Session } = $props();
  // svelte-ignore state_referenced_locally
  const { flow, store: { words } } = session;
  const CLOSE = "UI/Conversations/UI/Close";
  const LINE = "UI/Conversations/Dialogue/Lines/AcademyShipCannotLeaveExordium";
  let portrait = $state<string | null>(null);
  let speakerKey = $state("#519116");
  let lineKey = $state(LINE);
  const speaker = $derived(plainText($words.templates[speakerKey] ?? "Aura"));
  const closeLabel = $derived(plainText($words.templates[CLOSE] ?? "Close"));
  const line = $derived($words.templates[lineKey] ?? $words.templates[LINE]
    ?? "Academy ships cannot leave Exordium. Return to a station to board another ship.");

  onMount(() => {
    let current = true;
    flow.requestWords([CLOSE, LINE, speakerKey]);
    void getAcademyTravelConversation(flow.requestOptions()).then(record => {
      if (!current || !record) return;
      if (record.textID !== null) lineKey = `#${record.textID}`;
      if (record.speakerID !== null) speakerKey = `#${record.speakerID}`;
      portrait = record.portrait;
      flow.requestWords([lineKey, speakerKey]);
    }).catch(() => {});
    return () => { current = false; };
  });
</script>

<ConversationTransmission {speaker} {line} {closeLabel} {portrait} close={flow.closeAcademyTravelConversation} />
