<script lang="ts">
  // corporation/war/warMutalWarInvite.py MutualWarInvites (Administration > Wars > Mutual War Invites, a director's):
  // the BlockMutualInvites checkbox (hint BlockMutualInvitesHint; IsCorpInvitesBlocked, disabled without the director
  // role; SetInvitesBlocked), the combo - Show all / outgoing / incoming (mutualWarsFilter) -, then the scroll, newest
  // sent first (NoMutualWarInvitesFound where none). Each entry (55 high): the from logo 32, the swords (wars.png at
  // 0.3), the to logo 32 (each click Show Info); InvitedToMutualWar {toLink} for one sent (Withdraw) or
  // HaveBeenInvitedToMutualWar {fromLink} for one received (Accept / Reject), over MutualInviteSentAt {FmtDate}.
  // OnMutualWarsUpdated reloads it.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, MutualWarInvite } from "../app/flow.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { allianceLogoUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { showInfo } from "./showInfo.ts";
  import CorpLogo from "./CorpLogo.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const corpLogos = flow.corpLogos;
  // svelte-ignore state_referenced_locally
  const corpLogoLibrary = flow.corpLogoLibrary;
  // svelte-ignore state_referenced_locally
  const ownerLogos = flow.ownerLogos;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  // svelte-ignore state_referenced_locally
  const changed = flow.mutualWarsChanged;
  const W = "UI/Corporations/Wars/";
  const LABELS = ["BlockMutualInvites", "BlockMutualInvitesHint", "ShowAllMutualWarInvites", "ShowOutgoingMutualWarInvites", "ShowIncomingMutualWarInvites",
    "NoMutualWarInvitesFound", "MutualInviteSentAt", "WithdrawMutualWarInvite", "InvitedToMutualWar", "HaveBeenInvitedToMutualWar", "AcceptMutualWar", "RejectMutualWar"]
    .map((k) => W + k).concat([DATE_LABELS.ll!, ...Object.keys(LINK_WORDS)]);
  const fill = (label: string, values: Record<string, unknown> = {}) =>
    formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  const isAlliance = (id: number) => id >= 99_000_000 && id < 100_000_000;
  const isNpcCorp = (id: number) => id >= 1_000_000 && id < 2_000_000;
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "") || resolvedName($names.resolved, isAlliance(id) ? "alliance" : "corporation", id, String(id));
  const link = (id: number) => `<url=showinfo:${isAlliance(id) ? 16159 : 2}//${id}>${nameOf(id)}</url>`;
  // ALL_INVITES 0, OUTGOING_INVITES 1, INCOMING_INVITES 2
  const FILTERS = [[W + "ShowAllMutualWarInvites", 0], [W + "ShowOutgoingMutualWarInvites", 1], [W + "ShowIncomingMutualWarInvites", 2]] as const;
  let filter = $state(0), invites = $state<readonly MutualWarInvite[]>([]), blocked = $state(false), error = $state(""), busy = $state(false);
  const mine = $derived([$station.online?.allianceID ?? 0, $station.online?.corporationID ?? 0].filter((id) => id > 0));
  const director = $derived((BigInt($station.online?.corpRole ?? "0") & 1n) === 1n);
  const shown = $derived(invites.filter((i) => (filter === 1 ? mine.includes(i.fromOwnerID) : filter === 2 ? mine.includes(i.toOwnerID) : true))
    .slice().sort((a, b) => Number(b.sentDate - a.sentDate)));
  function load(): void {
    void flow.mutualWarInvites().then((r) => {
      invites = r.invites; blocked = r.blocked; error = "";
      flow.requestCorpLogos([...new Set(r.invites.flatMap((i) => [i.fromOwnerID, i.toOwnerID]))].filter((id) => !isAlliance(id) && !isNpcCorp(id)));
    }, (cause) => { error = cause instanceof Error ? cause.message : String(cause); });
  }
  onMount(() => { flow.requestWords(LABELS); flow.loadOwnerLogos(); flow.loadImageServer(); });
  $effect(() => { void $changed; load(); });
  async function act(a: Parameters<AppFlow["mutualWarInviteAct"]>[0]): Promise<void> {
    if (busy) return;
    busy = true;
    try { await flow.mutualWarInviteAct(a); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); } finally { busy = false; load(); }
  }
  function logoOf(id: number): { kind: "corp"; logo: NonNullable<(typeof $corpLogos)[string]> } | { kind: "img"; url: string | null } {
    const l = isAlliance(id) || isNpcCorp(id) ? null : $corpLogos[String(id)] ?? null;
    if (l && l.shapes.some((s) => s !== null)) return { kind: "corp", logo: l };
    return { kind: "img", url: isAlliance(id) ? allianceLogoUrl($imageServer, id) : (() => { const t = $ownerLogos?.corporations[String(id)]; return t ? clientTexture(t) : null; })() };
  }
</script>

<div class="mwi">
  <label class="mwi-block" title={plainText(fill(W + "BlockMutualInvitesHint"))}>
    <input type="checkbox" checked={blocked} disabled={!director || busy} onchange={(e) => void act({ kind: "block", blocked: e.currentTarget.checked })} />{plainText(fill(W + "BlockMutualInvites"))}
  </label>
  <div class="mwi-combo"><select bind:value={filter}>{#each FILTERS as [label, value] (value)}<option {value}>{plainText(fill(label))}</option>{/each}</select></div>
  {#if error}<p class="error">{error}</p>{/if}
  <div class="mwi-scroll">
    {#each shown as invite (invite.fromOwnerID + ":" + invite.toOwnerID)}
      {@const outgoing = mine.includes(invite.fromOwnerID)}
      <div class="mwi-entry">
        <span class="mwi-logos">
          {#each [invite.fromOwnerID, null, invite.toOwnerID] as id, i (i)}
            {#if id === null}<span class="mwi-swords">⚔</span>
            {:else}
              {@const l = logoOf(id)}
              <button type="button" class="mwi-logo" title={nameOf(id)} onclick={() => showInfo(isAlliance(id) ? { kind: "alliance", allianceID: id } : { kind: "corporation", corporationID: id })}>
                {#if l.kind === "corp" && $corpLogoLibrary}<CorpLogo library={$corpLogoLibrary} logo={l.logo} name={nameOf(id)} />{:else}<OwnerPicture name={nameOf(id)} urls={l.kind === "img" && l.url ? [l.url] : []} size={32} />{/if}
              </button>
            {/if}
          {/each}
        </span>
        <span class="mwi-name">
          <LabelText markup={outgoing ? fill(W + "InvitedToMutualWar", { toLink: link(invite.toOwnerID) }) : fill(W + "HaveBeenInvitedToMutualWar", { fromLink: link(invite.fromOwnerID) })} {followerOf} /><br />
          {plainText(fill(W + "MutualInviteSentAt", { timestamp: plainText(fill(DATE_LABELS.ll!, { datetime: { type: "long", value: invite.sentDate.toString() } })) }))}
        </span>
        <span class="mwi-buttons">
          {#if outgoing}
            <button type="button" disabled={busy} onclick={() => void act({ kind: "withdraw", toOwnerID: invite.toOwnerID })}>{plainText(fill(W + "WithdrawMutualWarInvite"))}</button>
          {:else}
            <button type="button" disabled={busy} onclick={() => void act({ kind: "respond", fromOwnerID: invite.fromOwnerID, accepts: true })}>{plainText(fill(W + "AcceptMutualWar"))}</button>
            <button type="button" disabled={busy} onclick={() => void act({ kind: "respond", fromOwnerID: invite.fromOwnerID, accepts: false })}>{plainText(fill(W + "RejectMutualWar"))}</button>
          {/if}
        </span>
      </div>
    {:else}
      <p class="mwi-none">{plainText(fill(W + "NoMutualWarInvitesFound"))}</p>
    {/each}
  </div>
</div>

<style>
  .mwi { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .mwi-block { display: flex; gap: 4px; align-items: center; padding: 4px 0 0 4px; }
  .mwi-combo { padding: 4px; }
  .mwi-scroll { flex: 1; overflow-y: auto; margin: 4px; }
  .mwi-entry { height: 55px; display: flex; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
  .mwi-logos { width: 96px; height: 48px; margin-left: 4px; display: flex; align-items: center; justify-content: space-between; }
  .mwi-logo { width: 32px; height: 32px; padding: 0; border: 0; background: none; cursor: pointer; display: grid; }
  .mwi-logo :global(.corp-logo) { width: 32px; height: 32px; }
  .mwi-swords { opacity: 0.3; }
  .mwi-name { flex: 1; min-width: 0; padding-left: 10px; font-size: 13px; white-space: nowrap; overflow: hidden; }
  .mwi-buttons { display: flex; gap: 4px; padding-right: 4px; }
  .mwi-none { opacity: 0.7; padding: 8px; }
</style>
