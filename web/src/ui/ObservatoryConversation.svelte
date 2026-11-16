<script lang="ts">
  import type { Session } from "../app/sessions.ts";
  import type { ObservatoryTransmission } from "../app/api.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import ConversationTransmission from "./ConversationTransmission.svelte";

  let { session, conversation }: { session: Session; conversation: ObservatoryTransmission } = $props();
  const words = $derived(session.store.words);
  const speaker = $derived(plainText($words.templates[`#${conversation.speakerID}`] ?? ""));
  const line = $derived($words.templates[`#${conversation.textID}`] ?? "");
  const closeLabel = $derived(plainText($words.templates["UI/Conversations/UI/Close"] ?? "Close"));
</script>

{#if speaker && line}
  <ConversationTransmission {speaker} {line} {closeLabel} portrait={conversation.portrait} close={session.flow.closeObservatoryConversation} />
{/if}
