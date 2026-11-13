<script lang="ts">
  // corporation/war/warEntry.py WarEntry (40 high) and warContainerForWarEntry.py WarContainer (36): the attacker's
  // logo 32 (hint "<name><br>Offender", click - Show Info), the swords (wars.png at 0.3, hint Vs), the defender's
  // logo 32 ("<name><br>Defender"); WarNotMutual / WarMutual ("{attacker} vs. {defender}", each a show-info link)
  // over the date line (evewar/warText.GetWarText); at the right (30 wide) the war's UtilMenu and, while not
  // finished, the open-for-allies icon (Mercenary_Add, hint DefenderOpenForAllies) where the defender is open (not
  // for a mutual war). WarMenu: for a director in the war and not finished - the defender's Open for Allies
  // checkbox; another's war - Offer Assistance; View Allies (n); for a director in the war - Retract War (mutual)
  // or Send Surrender Offer; Open War Report. (The menu's entries are shown, not acting: the war's writes and the
  // war report are not on the page; the surrender-pending icon is not read.)
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { warTextList, type CorpWar } from "../bridge/corpWars.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { allianceLogoUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { showInfo } from "./showInfo.ts";
  import CorpLogo from "./CorpLogo.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  import WarReport from "./WarReport.svelte";
  import WarSurrender from "./WarSurrender.svelte";
  import WarAllyWindow from "./WarAllyWindow.svelte";
  import type { WarNegotiation } from "../app/flow.ts";
  // allyOffers: war.GetAllyNegotiations(), read once by the list (IsNegotiating); onChanged: the list to read again
  let { store, flow, war, myWars = false, allyOffers = [], onChanged }: { store: ClientStore; flow: AppFlow; war: CorpWar; myWars?: boolean;
    allyOffers?: readonly WarNegotiation[]; onChanged?: () => void } = $props();
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
  const W = "UI/Corporations/Wars/";
  const WAR_ENTRY_WORDS = ["WarNotMutual", "WarMutual", "Vs", "Offender", "Defender", "DefenderOpenForAllies", "WarStartedCanFight", "WarEndsAt", "WarStartedEndsAt",
    "WarStartedAndFinished", "WarStartedAndRetracted", "WarStarted", "OpenForAllies", "OfferAssistance", "ViewNumAllies", "ViewAllies", "RetractWar",
    "SendSurrenderOffer", "ViewSurrenderOffer", "SurrenderPending", "OpenWarReport", "ViewAssistanceOffer", "YouOfferedHelp"].map((k) => W + k).concat(["UI/Common/Unknown", DATE_LABELS.sn!, DATE_LABELS.ns!, DATE_LABELS.ss!, DATE_LABELS.xn!]);
  const fill = (label: string, values: Record<string, unknown> = {}) =>
    formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  const isAlliance = (id: number) => id >= 99_000_000 && id < 100_000_000;
  const isFaction = (id: number) => id >= 500_000 && id < 1_000_000;
  const isNpcCorp = (id: number) => id >= 1_000_000 && id < 2_000_000;
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "") || resolvedName($names.resolved, isAlliance(id) ? "alliance" : "corporation", id, String(id));
  // the link type: typeCorporation 2, typeAlliance 16159, typeFaction 30
  const typeOf = (id: number) => (isAlliance(id) ? 16159 : isFaction(id) ? 30 : 2);
  const link = (id: number) => `<url=showinfo:${typeOf(id)}//${id}>${nameOf(id)}</url>`;
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  const nowTicks = () => BigInt(Date.now()) * 10000n + 116444736000000000n;
  const date = (t: bigint, f: string) => plainText(fill(DATE_LABELS[f]!, { datetime: { type: "long", value: t.toString() } }));
  const dateLine = $derived.by(() => {
    void $words;
    return warTextList(war, nowTicks(), (t) => date(t, "xn")).map(([label, values]) =>
      plainText(fill(label, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? plainText($words.templates[v] ?? "") : date(v[0], v[1])]))))).join("");
  });
  const finished = $derived(war.timeFinished !== null && nowTicks() >= war.timeFinished);
  const openForAllies = $derived(!war.mutual && war.openForAllies && !finished && !isFaction(war.declaredByID));
  const me = $derived($station.online?.allianceID ?? $station.online?.corporationID ?? 0);
  const myWar = $derived([war.declaredByID, war.againstID].includes(me));
  const director = $derived((BigInt($station.online?.corpRole ?? "0") & 1n) === 1n);
  let menu = $state(false), report = $state(false), surrender = $state(false), allyWindow = $state(false);
  // the ally offer window: a request (Offer Assistance) or one's own offer (View Assistance Offer)
  let assistance = $state<"request" | WarNegotiation | null>(null);
  const nowT = () => BigInt(Date.now()) * 10000n + 116444736000000000n;
  // GetAllies: the allies still fighting
  const numAllies = $derived(war.allies.filter((a) => a.timeFinished !== null && nowT() < a.timeFinished).length);
  // IsAlly: war_cso.IsAllyInWar - one's own row among the allies, not finished
  const isAlly = $derived(war.allies.some((a) => a.allyID === me && (a.timeFinished === null || nowT() < a.timeFinished)));
  // IsNegotiating: one's own ally offer in this war, not declined or retracted
  const myOffer = $derived(allyOffers.find((n) => n.warID === war.warID && n.ownerID1 === me && n.state !== 2 && n.state !== 3) ?? null);
  async function setOpen(open: boolean): Promise<void> {
    menu = false;
    if (await flow.allyAct({ kind: "open", warID: war.warID, open })) onChanged?.();
  }
  // GetSurrenderStatus (a director, in the war, not retracted): the war's surrender offers - the pending icon and the
  // menu's View Surrender Offer for the last one
  let surrenders = $state<readonly WarNegotiation[]>([]);
  function loadSurrenders(): void {
    if (director && myWar && war.retracted === null) void flow.surrenderNegotiations(war.warID).then((s) => { surrenders = s.filter((n) => n.state === 0); }).catch(() => {});
  }
  $effect(() => { void war; loadSurrenders(); });
  const pendingSurrender = $derived(surrenders.length ? surrenders[surrenders.length - 1]! : null);
  $effect(() => { flow.requestWords(WAR_ENTRY_WORDS); flow.requestCorpLogos([war.declaredByID, war.againstID].filter((id) => !isAlliance(id) && !isNpcCorp(id) && !isFaction(id))); flow.loadOwnerLogos(); flow.loadImageServer(); });
  function logoOf(id: number): { kind: "corp"; logo: NonNullable<ReturnType<typeof playerLogo>> } | { kind: "img"; url: string | null } {
    const p = playerLogo(id);
    if (p) return { kind: "corp", logo: p };
    return { kind: "img", url: isAlliance(id) ? allianceLogoUrl($imageServer, id) : (() => { const t = $ownerLogos?.corporations[String(id)]; return t ? clientTexture(t) : null; })() };
  }
  function playerLogo(id: number) {
    if (isAlliance(id) || isNpcCorp(id) || isFaction(id)) return null;
    const l = $corpLogos[String(id)] ?? null;
    return l && l.shapes.some((s) => s !== null) ? l : null;
  }
</script>

{#if report}<WarReport {store} {flow} warID={war.warID} onClose={() => (report = false)} />{/if}
{#if surrender}<WarSurrender {store} {flow} {war} negotiation={pendingSurrender} onClose={() => { surrender = false; loadSurrenders(); }} />{/if}
{#if assistance !== null}<WarSurrender {store} {flow} {war} kind="ally" negotiation={assistance === "request" ? null : assistance} onClose={(done) => { assistance = null; if (done) onChanged?.(); }} />{/if}
{#if allyWindow}<WarAllyWindow {store} {flow} {war} onClose={() => (allyWindow = false)} />{/if}
<div class="war-entry" class:mine={myWars}>
  <div class="we-war">
    {#each [{ id: war.declaredByID, role: "Offender" }, null, { id: war.againstID, role: "Defender" }] as side, i (i)}
      {#if side === null}
        <span class="we-swords" title={plainText(fill(W + "Vs"))}>⚔</span>
      {:else}
        {@const l = logoOf(side.id)}
        <button type="button" class="we-logo" title={`${nameOf(side.id)}\n${plainText(fill(W + side.role))}`} onclick={() => showInfo(isAlliance(side.id) ? { kind: "alliance", allianceID: side.id } : { kind: "corporation", corporationID: side.id })}>
          {#if l.kind === "corp" && $corpLogoLibrary}<CorpLogo library={$corpLogoLibrary} logo={l.logo} name={nameOf(side.id)} />{:else}<OwnerPicture name={nameOf(side.id)} urls={l.kind === "img" && l.url ? [l.url] : []} size={32} />{/if}
        </button>
      {/if}
    {/each}
    <span class="we-text">
      <span class="we-corps"><LabelText markup={fill(W + (war.mutual ? "WarMutual" : "WarNotMutual"), { attackerName: link(war.declaredByID), defenderName: link(war.againstID) })} {followerOf} /></span>
      <span class="we-date">{dateLine}</span>
    </span>
  </div>
  <div class="we-buttons">
    {#if pendingSurrender}<span class="we-allies" title={plainText(fill(W + "SurrenderPending"))}>🏳</span>{/if}
    {#if openForAllies}<span class="we-allies" title={plainText(fill(W + "DefenderOpenForAllies"))}>✚</span>{/if}
    {#if !war.mutual && !myWar && director && myOffer && !isAlly}<span class="we-allies" title={plainText(fill(W + "YouOfferedHelp"))}>❗</span>{/if}
    <button type="button" class="we-menu-btn" aria-expanded={menu} onclick={() => (menu = !menu)}>☰</button>
    {#if menu}
      <div class="we-menu" role="menu">
        {#if !war.mutual}
          {#if myWar && director && !finished && war.againstID === me}<label><input type="checkbox" checked={war.openForAllies} onchange={() => void setOpen(!war.openForAllies)} />{plainText(fill(W + "OpenForAllies"))}</label>{/if}
          {#if !myWar && director && !isAlly && !finished}
            {#if myOffer}<button type="button" role="menuitem" onclick={() => { menu = false; assistance = myOffer; }}>{plainText(fill(W + "ViewAssistanceOffer"))}</button>
            {:else}<button type="button" role="menuitem" onclick={() => { menu = false; assistance = "request"; }}>{plainText(fill(W + "OfferAssistance"))}</button>{/if}
          {/if}
          {#if numAllies > 0}<button type="button" role="menuitem" onclick={() => { menu = false; allyWindow = true; }}>{plainText(fill(W + "ViewNumAllies", { num: numAllies }))}</button>
          {:else}<button type="button" role="menuitem" disabled>{plainText(fill(W + "ViewAllies"))}</button>{/if}
        {/if}
        {#if myWar && director && !finished && war.retracted === null}
          {#if war.mutual}<button type="button" role="menuitem" onclick={() => { menu = false; void flow.retractMutualWar(war.warID).catch(() => {}); }}>{plainText(fill(W + "RetractWar"))}</button>
          {:else}<button type="button" role="menuitem" onclick={() => { menu = false; surrender = true; }}>{plainText(fill(W + (pendingSurrender ? "ViewSurrenderOffer" : "SendSurrenderOffer")))}</button>{/if}
        {/if}
        <button type="button" role="menuitem" onclick={() => { menu = false; report = true; }}>{plainText(fill(W + "OpenWarReport"))}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .war-entry { position: relative; height: 40px; display: flex; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
  .we-war { flex: 1; min-width: 0; display: flex; align-items: center; height: 36px; padding-top: 2px; }
  .we-logo { width: 32px; height: 32px; margin: 2px; padding: 0; border: 0; background: none; cursor: pointer; display: grid; }
  .we-logo :global(.corp-logo) { width: 32px; height: 32px; }
  .we-swords { width: 24px; text-align: center; opacity: 0.3; }
  .we-text { flex: 1; min-width: 0; display: flex; flex-direction: column; padding-left: 5px; white-space: nowrap; overflow: hidden; }
  .we-date { opacity: 0.8; overflow: hidden; text-overflow: ellipsis; }
  .we-buttons { width: 50px; display: flex; justify-content: flex-end; align-items: center; gap: 4px; padding-right: 4px; }
  .we-allies { opacity: 0.8; }
  .we-menu-btn { background: none; border: 0; color: inherit; cursor: pointer; }
  .we-menu { position: absolute; right: 4px; top: 36px; z-index: 5; display: flex; flex-direction: column; min-width: 180px; padding: 4px; background: rgba(20, 22, 25, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); }
  .we-menu button { text-align: left; background: none; border: 0; color: inherit; padding: 3px 4px; }
</style>
