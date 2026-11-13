<script lang="ts">
  // Alliances/all_ui_members.py FormAlliancesMembers (Alliances > General > Members): a director's Declare Support
  // button group at the top (else DirectorDeclareWarHint), then the scroll with the headers Logo, Name, Chosen
  // Executor, Joined: each corporation (listentry.Corporation: its logo 24, the label '<t>name<t>chosen executor (Secret
  // where None)<t>FmtDate(startDate)'); NoMembersFound where none. A row's menu: the corporation's own (Show Info), Quit
  // Alliance (its own) or Kick Member (another's) - AllComfirmKickSelf / AllComfirmKickMember -, and Declare Support
  // (DeclareExecutorSupport(corpID)). DeclareSupportForm (DeclarationExecutorSupport, 500 wide): PledgeSupportTo, each
  // member corporation as a choice of one group (the own corporation's chosen executor checked); OK declares for it.
  // (Quit / Kick are shown, not acting.)
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, AllianceMember } from "../app/flow.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { showInfo } from "./showInfo.ts";
  import CorpLogo from "./CorpLogo.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
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
  const M = "UI/Corporations/CorporationWindow/Alliances/Members/";
  const LABELS = ["Logo", "ChosenExecutor", "DeclareSupport", "DirectorDeclareWarHint", "NoMembersFound", "QuitAlliance", "KickMember", "PledgeSupportTo",
    "DeclarationExecutorSupport"].map((k) => M + k)
    .concat(["UI/Common/Name", "UI/Corporations/CorporationWindow/Members/Tracking/JoinedColumnHeader", "UI/Common/Secret", "UI/Commands/ShowInfo",
      "UI/Common/Buttons/OK", "UI/Common/Buttons/Cancel", DATE_LABELS.ll!]);
  const fill = (label: string, values: Record<string, unknown> = {}) =>
    plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "") || resolvedName($names.resolved, "corporation", id, String(id));
  let members = $state<readonly AllianceMember[] | null>(null), error = $state(""), menuFor = $state<number | null>(null);
  let pledging = $state(false), pledgeTo = $state<number | null>(null), busy = $state(false);
  const myCorp = $derived($station.online?.corporationID ?? 0);
  const director = $derived((BigInt($station.online?.corpRole ?? "0") & 1n) === 1n);
  function load(): void {
    void flow.allianceMembers().then((m) => { members = m; flow.requestCorpLogos(m.map((x) => x.corporationID)); }, (e) => { error = e instanceof Error ? e.message : String(e); members = []; });
  }
  onMount(() => { flow.requestWords(LABELS); flow.loadOwnerLogos(); load(); });
  async function declare(corporationID: number): Promise<void> {
    if (busy) return;
    busy = true;
    try { await flow.declareExecutorSupport(corporationID); } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; load(); }
  }
  const joined = (t: bigint) => fill(DATE_LABELS.ll!, { datetime: { type: "long", value: t.toString() } });
  function logoOf(id: number) {
    const l = $corpLogos[String(id)] ?? null;
    if (l && l.shapes.some((s) => s !== null)) return { kind: "corp" as const, l };
    const t = $ownerLogos?.corporations[String(id)];
    return { kind: "img" as const, url: t ? clientTexture(t) : null };
  }
</script>

{#if pledging && members}
  <div class="am-back">
    <div class="am-pledge" role="dialog" aria-modal="true" aria-label={fill(M + "DeclarationExecutorSupport")}>
      <header>{fill(M + "DeclarationExecutorSupport")}<button type="button" class="am-x" aria-label="Close" onclick={() => (pledging = false)}>×</button></header>
      <div class="am-pledge-head">{fill(M + "PledgeSupportTo")}</div>
      {#each members as m (m.corporationID)}<label class="am-choice"><input type="radio" name="am-pledge" value={m.corporationID} bind:group={pledgeTo} />{nameOf(m.corporationID)}</label>{/each}
      <div class="am-buttons">
        <button type="button" disabled={busy || pledgeTo === null} onclick={() => { const to = pledgeTo; pledging = false; if (to !== null) void declare(to); }}>{fill("UI/Common/Buttons/OK")}</button>
        <button type="button" onclick={() => (pledging = false)}>{fill("UI/Common/Buttons/Cancel")}</button>
      </div>
    </div>
  </div>
{/if}
<div class="am">
  {#if director}
    <div class="am-buttons"><button type="button" disabled={!members} onclick={() => { pledgeTo = members?.find((m) => m.corporationID === myCorp)?.chosenExecutorID ?? null; pledging = true; }}>{fill(M + "DeclareSupport")}</button></div>
  {:else}
    <p class="am-hint">{fill(M + "DirectorDeclareWarHint")}</p>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
  <div class="am-scroll">
    <div class="am-row am-head"><span>{fill(M + "Logo")}</span><span>{fill("UI/Common/Name")}</span><span>{fill(M + "ChosenExecutor")}</span><span>{fill("UI/Corporations/CorporationWindow/Members/Tracking/JoinedColumnHeader")}</span></div>
    {#if members}
      {#each members as m (m.corporationID)}
        {@const l = logoOf(m.corporationID)}
        <div class="am-row" role="row" tabindex="-1" oncontextmenu={(e) => { e.preventDefault(); menuFor = menuFor === m.corporationID ? null : m.corporationID; }}>
          <span class="am-logo">{#if l.kind === "corp" && $corpLogoLibrary}<CorpLogo library={$corpLogoLibrary} logo={l.l} name={nameOf(m.corporationID)} />{:else if l.kind === "img"}<OwnerPicture name={nameOf(m.corporationID)} urls={l.url ? [l.url] : []} size={24} />{/if}</span>
          <span>{nameOf(m.corporationID)}</span>
          <span>{m.chosenExecutorID === null ? fill("UI/Common/Secret") : nameOf(m.chosenExecutorID)}</span>
          <span>{joined(m.startDate)}</span>
          {#if menuFor === m.corporationID}
            <div class="am-menu" role="menu">
              <button type="button" role="menuitem" onclick={() => { menuFor = null; showInfo({ kind: "corporation", corporationID: m.corporationID }); }}>{fill("UI/Commands/ShowInfo")}</button>
              <button type="button" role="menuitem" disabled>{fill(M + (m.corporationID === myCorp ? "QuitAlliance" : "KickMember"))}</button>
              <button type="button" role="menuitem" onclick={() => { menuFor = null; void declare(m.corporationID); }}>{fill(M + "DeclareSupport")}</button>
            </div>
          {/if}
        </div>
      {:else}
        <p class="am-hint">{fill(M + "NoMembersFound")}</p>
      {/each}
    {/if}
  </div>
</div>

<style>
  .am { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .am-buttons { display: flex; justify-content: center; gap: 4px; padding: 4px; }
  .am-hint { opacity: 0.8; padding: 4px; }
  .am-scroll { flex: 1; overflow-y: auto; }
  .am-row { position: relative; display: grid; grid-template-columns: 34px 1.4fr 1.2fr 1fr; align-items: center; min-height: 26px; padding: 0 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .am-head { min-height: 20px; font-size: 11px; opacity: 0.7; }
  .am-logo { width: 24px; height: 24px; display: grid; }
  .am-logo :global(.corp-logo) { width: 24px; height: 24px; }
  .am-menu { position: absolute; left: 40px; top: 24px; z-index: 5; display: flex; flex-direction: column; min-width: 160px; padding: 4px; background: rgba(20, 22, 25, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); }
  .am-menu button { text-align: left; background: none; border: 0; color: inherit; padding: 3px 6px; cursor: pointer; }
  .am-back { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0, 0, 0, 0.35); }
  .am-pledge { width: 500px; display: flex; flex-direction: column; padding: 0 8px 8px; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  .am-pledge header { display: flex; justify-content: space-between; padding: 6px 0; font-weight: bold; }
  .am-x { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .am-pledge-head { font-weight: bold; padding: 4px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .am-choice { display: flex; align-items: center; gap: 4px; height: 20px; }
</style>
