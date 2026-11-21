<script lang="ts">
  // The Bounty Office (bountyWindow.BountyWindow, 400x510, 'bounties'), as openFunctions.OpenBountyOffice(charID) opens
  // it from a pilot's menu: the expandable lists - Most Wanted (open: GetTopPilotBounties / Corp / Alliance with the
  // Characters / Corporations / Alliances toggle; the first entry large, the rest numbered), Top Bounty Hunters and My
  // Bounties (GetMyBounties; NoOutstandingBounties when none) - over Place Bounty at the foot: ShowResult's owner
  // (portrait, name, "Bounty: <char + corp + alliance> ISK" with BountyHint), the clear button back to the search, the
  // amount (InsertAmount with the minimum; TooLowEnterMore under it) and Place (AddToBounty, then the amount read again).
  import { onMount } from "svelte";
  import DesktopWindow from "./DesktopWindow.svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { resolvedName } from "../store/names.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { formatIsk } from "./isk.ts";
  import { portraitUrl, portraitDefaultPath, remoteImageUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, target, onClose, showInfo }: {
    store: ClientStore; flow: AppFlow;
    /** The owner the window opened on (OpenBountyOffice's charID) with its corporation and alliance; null for none. */
    target: { ownerID: number; corporationID: number | null; allianceID: number | null } | null;
    onClose: () => void;
    showInfo: (ownerID: number, kind: "char" | "corp" | "alliance") => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const words = store.words, names = store.names;
  const LABELS = ["UI/Station/BountyOffice/BountyOffice", "UI/Station/BountyOffice/PlaceBounty", "UI/Station/BountyOffice/SearchForUser",
    "UI/Station/BountyOffice/Place", "UI/Station/BountyOffice/EnterAmount", "UI/Station/BountyOffice/InsertAmount", "UI/Station/BountyOffice/TooLowEnterMore",
    "UI/Station/BountyOffice/MostWanted", "UI/Station/BountyOffice/TopBountyHunters", "UI/Station/BountyOffice/MyBounties",
    "UI/Station/BountyOffice/ShowCharacters", "UI/Station/BountyOffice/ShowCorporations", "UI/Station/BountyOffice/ShowAlliances",
    "UI/Station/BountyOffice/NoOutstandingBounties", "UI/Common/BountyAmount", "UI/Station/BountyOffice/BountyHint", "UI/Inventory/Clear",
    "UI/Station/BountyOffice/BountyClaimed", "UI/Station/BountyOffice/NoOneFound", "UI/Search/UniversalSearch/Characters",
    "UI/Search/UniversalSearch/Corporations", "UI/Search/UniversalSearch/Alliances", "UI/Generic/OK", "UI/Generic/Cancel"];
  const word = (label: string, own: string, args: Record<string, string | number> = {}): string => {
    const t = $words.templates[label];
    return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args, { nameOf: (_k, id) => String(id) })).trim() : own;
  };
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "") || "…";
  /** eveFormat.FmtISK(amount, False): whole ISK. */
  const isk = (n: number) => formatIsk(String(Math.round(n)));
  /** bountyUtil.GetMinimumBountyAmount: MIN_BOUNTY_AMOUNT_CHAR / _CORP / _ALLIANCE (the window opens on pilots only). */
  const minimum = (_id: number, kind: "char" | "corp" | "alliance") => (kind === "char" ? 1_000_000 : kind === "corp" ? 20_000_000 : 100_000_000);
  const image = (id: number, kind: "char" | "corp" | "alliance", size: number) => kind === "char"
    ? portraitUrl(flow.imageServer.get(), id, size) ?? clientTexture(portraitDefaultPath(size))
    : remoteImageUrl(flow.imageServer.get(), kind === "corp" ? "Corporation" : "Alliance", id, size, ".png") ?? clientTexture("res:/UI/Texture/silhouette_64.png");

  let win = $state({ x: 120, y: 90, w: 400, h: 510, z: 30, minimized: false });
  // svelte-ignore state_referenced_locally
  type Owner = { ownerID: number; corporationID: number | null; allianceID: number | null; kind?: "char" | "corp" | "alliance" };
  let owner = $state<Owner | null>(target);
  const kindOf = (o: Owner) => o.kind ?? "char";
  // Search: searchUtil.GetResultsList(text, [character, corporation, alliance], hideNPC) - one found is the owner
  // (ShowResult), several open BountyPicker (grouped Characters / Corporations / Alliances), none says NoOneFound
  let searchText = $state("");
  let searchHint = $state("");
  let picking = $state<readonly { id: number; name: string; kind: "char" | "corp" | "alliance" }[] | null>(null);
  let picked = $state<number | null>(null);
  const isNpcOwner = (id: number) => (id >= 1_000_000 && id < 2_000_000) || (id >= 3_000_000 && id < 4_000_000) || (id >= 500_000 && id < 1_000_000);
  async function search(): Promise<void> {
    const text = searchText.replace(/\*/g, "").trim();
    if (!text || owner) return;
    let found: { id: number; name: string; kind: "char" | "corp" | "alliance" }[] = [];
    try {
      const byType = await flow.searchOwners(text, [2, 3, 4], 0);
      const kinds = { 2: "char", 3: "corp", 4: "alliance" } as const;
      for (const t of [2, 3, 4] as const) for (const r of byType.get(t) ?? []) if (!isNpcOwner(r.id)) found.push({ id: r.id, name: r.name, kind: kinds[t] });
    } catch (cause) { error = String((cause as Error)?.message ?? cause); return; }
    if (!found.length) { searchText = ""; searchHint = word("UI/Station/BountyOffice/NoOneFound", "No one found"); return; }
    if (found.length === 1) { choose(found[0]!); return; }
    picked = null;
    picking = found;
  }
  function choose(r: { id: number; kind: "char" | "corp" | "alliance" }): void {
    picking = null;
    searchText = "";
    owner = { ownerID: r.id, corporationID: null, allianceID: null, kind: r.kind };
    amountHint = "";
    void readAmounts();
  }
  let amounts = $state<Map<number, number>>(new Map());
  let amountText = $state("");
  let amountHint = $state("");
  let error = $state("");
  let busy = $state(false);
  let open = $state<"top" | "hunters" | "mine">("top");
  let showType = $state<"char" | "corp" | "alliance">("char");
  let top = $state<readonly { ownerID: number; bounty: number }[] | null>(null);
  let hunters = $state<readonly { ownerID: number; claimed: number; kills: number }[] | null>(null);
  let mine = $state<readonly { targetID: number; amount: number }[] | null>(null);

  const ids = (o: NonNullable<typeof owner>) => [o.ownerID, o.corporationID, o.allianceID].filter((x): x is number => !!x);
  const total = $derived(owner ? ids(owner).reduce((sum, id) => sum + (amounts.get(id) ?? 0), 0) : 0);
  const hint = $derived(owner ? word("UI/Station/BountyOffice/BountyHint", `Character: ${isk(amounts.get(owner.ownerID) ?? 0)}`, {
    charBounty: isk(amounts.get(owner.ownerID) ?? 0), corpBounty: isk(owner.corporationID ? amounts.get(owner.corporationID) ?? 0 : 0),
    allianceBounty: isk(owner.allianceID ? amounts.get(owner.allianceID) ?? 0 : 0) }) : "");

  async function readAmounts(): Promise<void> {
    if (!owner) return;
    try { amounts = await flow.bountyAmounts(ids(owner)); } catch (cause) { error = String((cause as Error)?.message ?? cause); }
  }
  function load(which: typeof open): void {
    if (which === "top") void flow.topBounties(showType).then((r) => { top = r; }).catch(() => { top = []; });
    if (which === "hunters") void flow.topBountyHunters(showType).then((r) => { hunters = r; }).catch(() => { hunters = []; });
    if (which === "mine") void flow.myBounties().then((r) => { mine = r; }).catch(() => { mine = []; });
  }
  function expand(which: typeof open): void { open = which; load(which); }
  function pickType(kind: typeof showType): void { showType = kind; if (open === "top") top = null; else hunters = null; load(open); }
  async function place(): Promise<void> {
    if (!owner || busy) return;
    const amount = Number(amountText.replace(/[^\d]/g, ""));
    const min = minimum(owner.ownerID, kindOf(owner));
    if (!(amount >= min)) {
      amountText = "";
      amountHint = word("UI/Station/BountyOffice/TooLowEnterMore", `Too low, enter at least ${isk(min)}`, { minAmount: isk(min) });
      return;
    }
    busy = true; error = "";
    try {
      await flow.placeBounty(owner.ownerID, amount);
      amountText = "";
      await readAmounts();
      mine = null;
      if (open === "mine") load("mine");
    } catch (cause) { error = String((cause as Error)?.message ?? cause); }
    finally { busy = false; }
  }
  onMount(() => { flow.requestWords(LABELS); void readAmounts(); load("top"); });
</script>

<div class="bounty-layer">
  <DesktopWindow {win} title={word("UI/Station/BountyOffice/BountyOffice", "Bounty Office")} icon={clientTexture("res:/ui/Texture/WindowIcons/bountyoffice.png")}
    focused={true} onFocus={() => {}} {onClose} onMove={(x, y) => { win.x = x; win.y = y; }}
    onResize={(w, h) => { win.w = Math.max(400, w); win.h = Math.max(510, h); }}>
    <div class="bounty" data-window="bounties">
      <div class="bounty-lists">
        {#each [["top", "UI/Station/BountyOffice/MostWanted", "Most Wanted"], ["hunters", "UI/Station/BountyOffice/TopBountyHunters", "Top Bounty Hunters"], ["mine", "UI/Station/BountyOffice/MyBounties", "My Bounties"]] as [id, label, own] (id)}
          <button type="button" class="bounty-head" class:open={open === id} onclick={() => expand(id as typeof open)}>
            <span class="bounty-caret">{open === id ? "▾" : "▸"}</span>{word(label!, own!)}
          </button>
          {#if open === id}
            <div class="bounty-part">
              {#if id !== "mine"}
                <div class="bounty-toggle">
                  {#each [["char", "UI/Station/BountyOffice/ShowCharacters", "Characters"], ["corp", "UI/Station/BountyOffice/ShowCorporations", "Corporations"], ["alliance", "UI/Station/BountyOffice/ShowAlliances", "Alliances"]] as [kind, l, o] (kind)}
                    <button type="button" class:on={showType === kind} onclick={() => pickType(kind as typeof showType)}>{word(l!, o!)}</button>
                  {/each}
                </div>
              {/if}
              <div class="bounty-scroll">
                {#if id === "top"}
                  {#each top ?? [] as row, i (row.ownerID)}
                    <div class="bounty-row" class:first={i === 0}>
                      {#if i > 0}<span class="bounty-place">{i + 1}</span>{/if}
                      <button type="button" class="bounty-img" onclick={() => showInfo(row.ownerID, showType)}><img src={image(row.ownerID, showType, i === 0 ? 128 : 32)} alt="" /></button>
                      <span class="bounty-text"><span class="bounty-name">{nameOf(row.ownerID)}</span><span class="bounty-small">{word("UI/Common/BountyAmount", `Bounty: ${isk(row.bounty)}`, { bountyAmount: isk(row.bounty) })}</span></span>
                    </div>
                  {/each}
                {:else if id === "hunters"}
                  {#each hunters ?? [] as row, i (row.ownerID)}
                    <div class="bounty-row" class:first={i === 0}>
                      {#if i > 0}<span class="bounty-place">{i + 1}</span>{/if}
                      <button type="button" class="bounty-img" onclick={() => showInfo(row.ownerID, showType)}><img src={image(row.ownerID, showType, i === 0 ? 128 : 32)} alt="" /></button>
                      <span class="bounty-text"><span class="bounty-name">{nameOf(row.ownerID)}</span><span class="bounty-small">{word("UI/Station/BountyOffice/BountyClaimed", `${row.kills} kills, ${isk(row.claimed)}`, { kills: row.kills, iskAmount: isk(row.claimed) })}</span></span>
                    </div>
                  {/each}
                {:else if mine && mine.length === 0}
                  <div class="bounty-none">{word("UI/Station/BountyOffice/NoOutstandingBounties", "No outstanding bounties")}</div>
                {:else}
                  {#each mine ?? [] as row (row.targetID)}
                    <div class="bounty-row">
                      <button type="button" class="bounty-img" onclick={() => showInfo(row.targetID, "char")}><img src={image(row.targetID, "char", 32)} alt="" /></button>
                      <span class="bounty-text"><span class="bounty-name">{nameOf(row.targetID)}</span><span class="bounty-small">{word("UI/Common/BountyAmount", `Bounty: ${isk(row.amount)}`, { bountyAmount: isk(row.amount) })}</span></span>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      </div>
      <div class="bounty-place-part">
        <div class="bounty-caption">{word("UI/Station/BountyOffice/PlaceBounty", "Place Bounty")}</div>
        {#if owner}
          {@const o = owner}
          <div class="bounty-verified">
            <button type="button" class="bounty-img" onclick={() => showInfo(o.ownerID, kindOf(o))}><img src={image(o.ownerID, kindOf(o), 32)} alt="" /></button>
            <span class="bounty-text"><button type="button" class="bounty-link" onclick={() => showInfo(o.ownerID, kindOf(o))}>{nameOf(o.ownerID)}</button>
              <span class="bounty-small" title={hint}>{word("UI/Common/BountyAmount", `Bounty: ${isk(total)}`, { bountyAmount: isk(total) })}</span></span>
            <button type="button" class="bounty-clear" title={word("UI/Inventory/Clear", "Clear")} onclick={() => { owner = null; amountHint = ""; }}><img src={clientTexture("res:/UI/Texture/Icons/73_16_210.png")} alt="" /></button>
          </div>
        {:else}
          <div class="bounty-search"><img src={clientTexture("res:/UI/Texture/silhouette_64.png")} alt="" /><input type="text" maxlength="32" bind:value={searchText} onkeydown={(e) => { if (e.key === "Enter") void search(); }} placeholder={searchHint || word("UI/Station/BountyOffice/SearchForUser", "Search for user")} /></div>
          {#if picking}
            <div class="bounty-picker" role="dialog" aria-label={word("UI/Station/BountyOffice/PlaceBounty", "Place Bounty")}>
              {#each [["char", "UI/Search/UniversalSearch/Characters", "Characters"], ["corp", "UI/Search/UniversalSearch/Corporations", "Corporations"], ["alliance", "UI/Search/UniversalSearch/Alliances", "Alliances"]] as [kind, label, own] (kind)}
                {#if picking.some((r) => r.kind === kind)}
                  <div class="bounty-picker-head">{word(label!, own!)}</div>
                  {#each picking.filter((r) => r.kind === kind) as r (r.id)}
                    <button type="button" class="bounty-picker-row" class:on={picked === r.id} onclick={() => (picked = r.id)} ondblclick={() => choose(r)}>{r.name}</button>
                  {/each}
                {/if}
              {/each}
              <div class="bounty-picker-btns">
                <button type="button" disabled={picked === null} onclick={() => { const r = picking?.find((x) => x.id === picked); if (r) choose(r); }}>{word("UI/Generic/OK", "OK")}</button>
                <button type="button" onclick={() => { picking = null; searchText = ""; }}>{word("UI/Generic/Cancel", "Cancel")}</button>
              </div>
            </div>
          {/if}
        {/if}
        <div class="bounty-amount">
          <input type="text" inputmode="numeric" bind:value={amountText} onkeydown={(e) => { if (e.key === "Enter") void place(); }}
            placeholder={amountHint || (owner ? word("UI/Station/BountyOffice/InsertAmount", `Enter at least ${isk(minimum(owner.ownerID, kindOf(owner)))}`, { bountyAmount: isk(minimum(owner.ownerID, kindOf(owner))) }) : word("UI/Station/BountyOffice/EnterAmount", "Enter amount"))} />
          <button type="button" disabled={!owner || busy} onclick={() => void place()}>{word("UI/Station/BountyOffice/Place", "Place")}</button>
        </div>
        {#if error}<div class="bounty-error" role="status">{error}</div>{/if}
      </div>
    </div>
  </DesktopWindow>
</div>

<style>
  .bounty-layer { position: fixed; inset: 0; pointer-events: none; z-index: 40; }
  .bounty-layer :global(> *) { pointer-events: auto; }
  .bounty { display: flex; flex-direction: column; height: 100%; padding: 4px; box-sizing: border-box; gap: 16px; font: 13px var(--font); color: rgba(255, 255, 255, 0.85); }
  .bounty-lists { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .bounty-head { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px; background: rgba(255, 255, 255, 0.06); border: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .bounty-head.open { background: rgba(255, 255, 255, 0.1); }
  .bounty-caret { width: 10px; font-size: 10px; }
  .bounty-part { flex: 1; display: flex; flex-direction: column; min-height: 0; padding-top: 4px; }
  .bounty-toggle { display: flex; gap: 2px; }
  .bounty-toggle button { flex: 1; height: 22px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); color: inherit; font: 12px var(--font); cursor: pointer; }
  .bounty-toggle button.on { background: rgba(255, 255, 255, 0.18); }
  .bounty-scroll { flex: 1; overflow-y: auto; padding-top: 4px; }
  .bounty-row { display: flex; align-items: center; gap: 6px; height: 36px; }
  .bounty-row.first { height: 132px; }
  .bounty-row.first .bounty-img img { width: 128px; height: 128px; }
  .bounty-place { width: 18px; text-align: right; color: rgba(255, 255, 255, 0.5); }
  .bounty-img { padding: 0; border: 0; background: none; cursor: pointer; }
  .bounty-img img { width: 32px; height: 32px; display: block; }
  .bounty-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .bounty-name, .bounty-link { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bounty-link { padding: 0; border: 0; background: none; color: #d0a96c; font: inherit; text-align: left; cursor: pointer; }
  .bounty-small { font-size: 11px; color: rgba(255, 255, 255, 0.6); }
  .bounty-none { display: flex; align-items: center; justify-content: center; height: 100%; font-size: 18px; }
  .bounty-caption { font-size: 18px; }
  .bounty-verified, .bounty-search { display: flex; align-items: center; gap: 4px; min-height: 32px; margin-top: 4px; }
  .bounty-search img { width: 32px; height: 32px; }
  .bounty-search input, .bounty-amount input { flex: 1; height: 28px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; font: inherit; padding: 0 6px; }
  .bounty-picker { margin-top: 4px; max-height: 180px; overflow-y: auto; border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(0, 0, 0, 0.35); padding: 4px; }
  .bounty-picker-head { font-size: 11px; color: rgba(255, 255, 255, 0.55); margin: 4px 0 2px; }
  .bounty-picker-row { display: block; width: 100%; padding: 2px 6px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .bounty-picker-row.on, .bounty-picker-row:hover { background: rgba(255, 255, 255, 0.12); }
  .bounty-picker-btns { display: flex; justify-content: flex-end; gap: 4px; margin-top: 4px; }
  .bounty-picker-btns button { width: 81px; height: 24px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.25); color: inherit; font: inherit; cursor: pointer; }
  .bounty-clear { width: 24px; padding: 0; border: 0; background: none; cursor: pointer; }
  .bounty-amount { display: flex; gap: 4px; height: 32px; margin-top: 4px; align-items: center; }
  .bounty-amount button { height: 28px; padding: 0 14px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.25); color: inherit; font: inherit; cursor: pointer; }
  .bounty-amount button:disabled { opacity: 0.4; cursor: default; }
  .bounty-error { margin-top: 4px; color: #e07070; font-size: 12px; }
</style>
