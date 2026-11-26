<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import { SESSION_CHANNEL_WORDS } from "../app/chatConversations.ts";
  import ChatInvitationWindow from "./ChatInvitationWindow.svelte";
  import ContactActionDialog from "./ContactActionDialog.svelte";
  let { session, inFront }: { session: Session; inFront: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const station = session.store.station;
  // svelte-ignore state_referenced_locally
  const conversations = session.flow.conversations.state;
  const pilot = $derived($station.online?.characterID ?? null);
  const senders = $derived([...new Set($conversations.invitations.map(invitation => invitation.senderCharacterID))]);
  let timer: ReturnType<typeof setInterval> | null = null;
  async function refresh() { if (session.store.station.get().online) await session.flow.conversations.refresh().catch(() => {}); }
  $effect(() => {
    if (pilot === null) return;
    void session.flow.conversations.loadActivity().catch(() => {});
    void refresh();
  });
  onMount(() => {
    session.flow.requestWords(SESSION_CHANNEL_WORDS);
    session.flow.requestWords(["UI/Chat/ChatInvite", "UI/Chat/InvitedToConversation", "UI/Chat/AcceptInvitation", "UI/Chat/AcceptInvitationAndAddContact", "UI/Chat/RejectInvitation", "UI/Chat/RejectInvitationAndBlock", "UI/Chat/PrivateChatAlone", "UI/Chat/PrivateChat", "UI/Chat/GroupChat", "UI/Chat/StartConversation", "UI/Chat/InviteToChat", "UI/Chat/ErrorNotAPlayerCharacter", "UI/Generic/OK"]);
    timer = setInterval(() => void refresh(), 2000);
  });
  onDestroy(() => { if (timer !== null) clearInterval(timer); });
</script>

{#if pilot !== null}
  {#each senders as sender (`${$conversations.generation}:${sender}`)}<ChatInvitationWindow {session} {sender} generation={$conversations.generation} {inFront} />{/each}
  {#each $conversations.contactAdds as entry (entry.id)}<ContactActionDialog store={session.store} flow={session.flow} action={entry.action} current={entry.current} done={() => session.flow.conversations.contactDone(entry.id)} />{/each}
{/if}
