<script lang="ts">
  // corporation/war/warReport.py WarReportWnd (WarReport, 600 x 640) with WarReportController: the date line at the
  // right (GetWarDateText); MutualWar for a mutual war; the sides (0.45 / 0.1 / 0.45): the attacker - its name
  // (EveLabelLarge, a link), WarAttacker in ATTACKER_COLOR, ISKKilled and NumShipsKilled (bold amounts), its logo 64 at
  // the right -, the swords (wars.png; limitedengagement.png before the fighting starts), the defender mirrored
  // (DEFENDER_COLOR); WarHQTextWithLink between the attacker-coloured arrows with WarHQExtraInfoWarReport where there is
  // an HQ; for an aggressive war the buttons - Offer Surrender (a director in the war, not retracted; OffereToSurrender)
  // and View Allies (disabled with DefenderHasNoAllies, else DefenderHasNumAllies). Then the kills: the combo (Show All /
  // Aggressor / Defender kills, killComboValue), Show Graph (killShowGraph), DelayedKillboardDetails; the kills
  // (warStatisticMgr.GetKills) newest first under their days' headers ('sn'), each the victim and killer
  // (KillVictim(InAlliance), KillKiller(InAlliance)); NoKillsFound. The graph (warReportKillGroups.py
  // WarReportKillsByGroupParent, 206 high, killShowGraph): the ten ship classes' names at the left (EveLabelSmall,
  // right-aligned, 18 apart, half alpha with no kills), each a KillsBarContainer (18 high) - the attacker's kills' ISK
  // a 5 high bar in ATTACKER_COLOR at the top, the defender's in DEFENDER_COLOR at the bottom, as parts of maxKills
  // (GetMaxKills: the largest ISK rounded up to a power of ten, halved where under half, at least 10) - over a grey
  // ground with ten column lines, Legend FmtISK(0) / FmtISK(maxKills) below; a bar's tooltip each side's name,
  // WarReportNumKills and FmtISK(isk, 0); a click (or its name) selects the class (killGroupDisplayed, again to clear)
  // and loads its kills (GetKills(entity, class); NoKillsFoundForGroup). Offer Surrender opens WarSurrenderWnd (the
  // war's surrender offer, else a request); View Allies (disabled with none) opens AllyWnd with GetBaseInfo's allies.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, WarReportInfo } from "../app/flow.ts";
  import type { KillReport } from "../bridge/corpKillReports.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { NUMERIC_WORD_LABELS, iskWords } from "../bridge/questions.ts";
  import type { WarClassKills } from "../app/flow.ts";
  import { resolvedName } from "../store/names.ts";
  import { allianceLogoUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import CorpLogo from "./CorpLogo.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  import WarSurrender from "./WarSurrender.svelte";
  import WarAllyWindow from "./WarAllyWindow.svelte";
  import type { WarNegotiation } from "../app/flow.ts";
  let { store, flow, warID, onClose }: { store: ClientStore; flow: AppFlow; warID: number; onClose: () => void } = $props();
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
  // GetShipGroupList's order and GetShipGroupNamesByGroupID's labels (GROUP_CAPSULES 0 ... GROUP_STRUCTURES 9)
  const CLASS_ORDER = [0, 1, 2, 3, 5, 4, 7, 6, 9, 8] as const;
  const CLASS_LABELS: Record<number, string> = { 0: "Capsules", 1: "Frigate", 2: "Destroyers", 3: "Cruisers", 5: "Battlecruisers", 4: "Battleships", 7: "IndustrialShips",
    6: "CapitalShips", 9: "Structures", 8: "POS" };
  const LABELS = ["WarReport", "MutualWar", "WarHQExtraInfoWarReport", "OfferSurrenderBtn", "ViewAlliesBtn", "WarAttacker", "WarDefender", "Vs", "ShowAllKills",
    "ShowAggressorKills", "ShowDefenderKills", "ShowGraph", "NumShipsKilled", "ISKKilled", "WarHQTextWithLink", "WarReportFutureWarWithStartAndEndDate",
    "WarReportActiveWarWithStartAndEndDate", "WarReportFinishedWarWithStartAndEndDate", "WarReportWarDeclaredCanFightDetailed", "WarStarted", "NoKillsFound",
    "KillVictim", "KillVictimInAlliance", "KillKiller", "KillKillerInAlliance", "DefenderHasNoAllies", "DefenderHasNumAllies", "OffereToSurrender", "OfferedToSurrender", "Offender", "Defender",
    "NoKillsFoundForGroup", "Legend", "WarReportNumKills", ...Object.values(CLASS_LABELS).map((k) => "ShipGroups/" + k)]
    .map((k) => W + k).concat([...NUMERIC_WORD_LABELS, "UI/Corporations/CorporationWindow/Wars/DelayedKillboardDetails", "UI/Common/Unknown", DATE_LABELS.ss!, DATE_LABELS.sn!, ...Object.keys(LINK_WORDS)]);
  const fill = (label: string, values: Record<string, unknown> = {}) =>
    formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, ""),
      // (OfferedToSurrender's {[numeric]amount.isk, decimalPlaces=0}: FmtISK)
      writeIsk: (value, places) => iskWords(value, places, $words.templates, (kind, id) => resolvedName($names.resolved, kind, id, "")) });
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  const isAlliance = (id: number) => id >= 99_000_000 && id < 100_000_000;
  const isFaction = (id: number) => id >= 500_000 && id < 1_000_000;
  const isNpcCorp = (id: number) => id >= 1_000_000 && id < 2_000_000;
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "") || resolvedName($names.resolved, isAlliance(id) ? "alliance" : "corporation", id, String(id));
  const link = (id: number) => `<url=showinfo:${isAlliance(id) ? 16159 : isFaction(id) ? 30 : 2}//${id}>${nameOf(id)}</url>`;
  const date = (t: bigint | null, f: string) => (t === null ? "" : plainText(fill(DATE_LABELS[f]!, { datetime: { type: "long", value: t.toString() } })));
  let info = $state<WarReportInfo | null>(null), error = $state("");
  const read = (k: string, d: number) => { try { const v = localStorage.getItem(`evejs.play.${k}`); return v === null ? d : Number(v); } catch { return d; } };
  let combo = $state(read("killComboValue", 0)), showGraph = $state(read("killShowGraph", 0) === 1);
  let kills = $state<readonly KillReport[] | null>(null);
  // the buttons: OpenSurrenderWnd (the war's surrender offer where there is one - the last of GetSurrenderNegotiations,
  // whose OfferedToSurrender {amount, corpName} is the hint - else a request) and OpenAllyWnd (AllyWnd with the allies)
  let surrenders = $state<readonly WarNegotiation[]>([]), surrenderOpen = $state(false), alliesOpen = $state(false);
  // killGroupDisplayed: the class selected on the graph (null none)
  let shownGroup = $state<number | null>((() => { const v = read("killGroupDisplayed", -1); return Number.isInteger(v) && v >= 0 ? v : null; })());
  let byClass = $state<ReadonlyMap<number, WarClassKills> | null>(null);
  async function loadKills(): Promise<void> {
    if (!info) return;
    // GetKillsScrollList: the side's ID for its combo value (None for all); then kept to that side's kills; with the
    // graph shown, the class selected on it (UpdateGraphsAndKillScroll)
    const entityID = combo === 1 ? info.war.declaredByID : combo === 2 ? info.war.againstID : null;
    try { kills = await flow.warReportKills(warID, entityID, showGraph ? shownGroup : null); } catch (e) { error = e instanceof Error ? e.message : String(e); kills = []; }
  }
  function loadGraph(): void {
    if (byClass === null) void flow.warKillsByGroup(warID).then((m) => { byClass = m; }).catch((e) => { error = e instanceof Error ? e.message : String(e); });
  }
  const classKills = (c: number): WarClassKills => byClass?.get(c) ?? { attackerKills: 0, defenderKills: 0, attackerKillsIsk: 0, defenderKillsIsk: 0 };
  // GetMaxKills
  const maxKills = $derived.by(() => {
    if (!byClass || !byClass.size) return 10;
    const most = Math.max(...[...byClass.values()].map((k) => Math.max(k.attackerKillsIsk, k.defenderKillsIsk)));
    if (most < 10) return 10;
    let top = 10 ** Math.ceil(Math.log10(most));
    if (most / top < 0.5) top *= 0.5;
    return Math.max(10, top);
  });
  const isk = (amount: number, places: number) => iskWords(amount, places, $words.templates, (kind, id) => resolvedName($names.resolved, kind, id, "")) ?? `${amount.toLocaleString("en-US")} ISK`;
  function pickClass(c: number): void {
    // BarOnClick: the same class again clears it
    shownGroup = shownGroup === c ? null : c;
    try { localStorage.setItem("evejs.play.killGroupDisplayed", shownGroup === null ? "-1" : String(shownGroup)); } catch { /* not kept */ }
    void loadKills();
  }
  const barHint = (k: WarClassKills) => info ? [nameOf(info.war.declaredByID), plainText(fill(W + "WarReportNumKills", { numKills: k.attackerKills })), isk(k.attackerKillsIsk, 0), "",
    nameOf(info.war.againstID), plainText(fill(W + "WarReportNumKills", { numKills: k.defenderKills })), isk(k.defenderKillsIsk, 0)].join("\n") : "";
  onMount(() => {
    flow.requestWords(LABELS); flow.loadOwnerLogos(); flow.loadImageServer();
    void flow.warReport(warID).then((i) => {
      info = i;
      if (i) {
        flow.requestCorpLogos([i.war.declaredByID, i.war.againstID].filter((id) => !isAlliance(id) && !isNpcCorp(id) && !isFaction(id))); void loadKills(); if (showGraph) loadGraph();
        if (!i.war.mutual && [i.war.declaredByID, i.war.againstID].includes(me) && i.war.retracted === null && director) void flow.surrenderNegotiations(warID).then((s) => { surrenders = s; }).catch(() => {});
      }
    }).catch((e) => { error = e instanceof Error ? e.message : String(e); });
  });
  const nowTicks = () => BigInt(Date.now()) * 10000n + 116444736000000000n;
  const dateText = $derived.by(() => {
    if (!info) return "";
    const w = info.war, now = nowTicks();
    const declare = w.timeDeclared ? date(w.timeDeclared, "ss") : plainText(fill("UI/Common/Unknown"));
    const fight = w.timeStarted ? date(w.timeStarted, "ss") : null, finish = w.timeFinished ? date(w.timeFinished, "ss") : null;
    const notStarted = now <= (w.timeStarted ?? 0n);
    if (finish) return plainText(fill(W + (notStarted ? "WarReportFutureWarWithStartAndEndDate" : now < w.timeFinished! ? "WarReportActiveWarWithStartAndEndDate" : "WarReportFinishedWarWithStartAndEndDate"), { fightDate: fight, endDate: finish }));
    if (notStarted) return plainText(fill(W + "WarReportWarDeclaredCanFightDetailed", { declareTime: declare, endDate: fight }));
    return plainText(fill(W + "WarStarted", { date: fight }));
  });
  const me = $derived($station.online?.allianceID ?? $station.online?.corporationID ?? 0);
  const director = $derived((BigInt($station.online?.corpRole ?? "0") & 1n) === 1n);
  const sideFigures = (id: number) => ({
    isk: plainText(fill(W + "ISKKilled", { iskAmount: `${Math.round(info?.iskKilled.get(id) ?? 0).toLocaleString("en-US")} ISK` })),
    ships: plainText(fill(W + "NumShipsKilled", { ships: (info?.shipsKilled.get(id) ?? 0).toLocaleString("en-US") })),
  });
  function logoUrl(id: number): string | null {
    if (isAlliance(id)) return allianceLogoUrl($imageServer, id);
    const t = $ownerLogos?.corporations[String(id)];
    return t ? clientTexture(t) : null;
  }
  const playerLogo = (id: number) => { if (isAlliance(id) || isNpcCorp(id) || isFaction(id)) return null; const l = $corpLogos[String(id)] ?? null; return l && l.shapes.some((s) => s !== null) ? l : null; };
  // _GetKillsScrollList: the side filter, newest first, a header for each day
  const killRows = $derived.by(() => {
    if (!info || !kills) return [];
    const attackerID = info.war.declaredByID;
    const rows = kills.filter((k) => { const att = [k.finalCorporationID, k.finalAllianceID].includes(attackerID); return combo === 1 ? att : combo === 2 ? !att : true; })
      .slice().sort((a, b) => (b.killTimeMs ?? 0) - (a.killTimeMs ?? 0));
    const out: ({ header: string } | { kill: KillReport })[] = [];
    let day = "";
    for (const k of rows) {
      const d = k.killTimeMs === null ? "" : date(BigInt(k.killTimeMs) * 10000n + 116444736000000000n, "sn");
      if (d !== day) { out.push({ header: d }); day = d; }
      out.push({ kill: k });
    }
    return out;
  });
  const ownerLink = (id: number | null) => (id ? link(id) : "");
</script>

{#if surrenderOpen && info}<WarSurrender {store} {flow} war={info.war} negotiation={surrenders.length ? surrenders[surrenders.length - 1]! : null} onClose={() => { surrenderOpen = false; void flow.surrenderNegotiations(warID).then((s) => { surrenders = s; }).catch(() => {}); }} />{/if}
{#if alliesOpen && info}<WarAllyWindow {store} {flow} war={{ ...info.war, allies: info.allyRows }} onClose={() => (alliesOpen = false)} />{/if}
<div class="wr-back">
  <div class="wr" role="dialog" aria-modal="true" aria-label={plainText(fill(W + "WarReport")) || "War Report"}>
    <header>{plainText(fill(W + "WarReport")) || "War Report"}<button type="button" class="wr-x" aria-label="Close" onclick={onClose}>×</button></header>
    {#if error}<p class="error">{error}</p>{/if}
    {#if info}
      {@const w = info.war}
      <div class="wr-date">{dateText}</div>
      {#if w.mutual}<div class="wr-mutual">{plainText(fill(W + "MutualWar"))}</div>{/if}
      <div class="wr-sides">
        {#each [{ id: w.declaredByID, attacker: true }, { id: w.againstID, attacker: false }] as side, i (i)}
          {@const f = sideFigures(side.id)}
          {@const pl = playerLogo(side.id)}
          {@const url = logoUrl(side.id)}
          {#if i === 1}<span class="wr-swords" title={plainText(fill(W + "Vs"))}>{(w.timeStarted ?? 0n) >= nowTicks() ? "🛡" : "⚔"}</span>{/if}
          <div class="wr-side" class:attacker={side.attacker}>
            <span class="wr-logo" title={`${plainText(fill(W + (side.attacker ? "Offender" : "Defender")))}:\n${nameOf(side.id)}`}>
              {#if pl && $corpLogoLibrary}<CorpLogo library={$corpLogoLibrary} logo={pl} name={nameOf(side.id)} />{:else}<OwnerPicture name={nameOf(side.id)} urls={url ? [url] : []} size={64} />{/if}
            </span>
            <span class="wr-text">
              <span class="wr-name"><LabelText markup={link(side.id)} {followerOf} /></span>
              {#if !w.mutual}<span class={side.attacker ? "wr-att" : "wr-def"}>{plainText(fill(W + (side.attacker ? "WarAttacker" : "WarDefender")))}</span>{/if}
              <span>{f.isk}</span><span>{f.ships}</span>
            </span>
          </div>
        {/each}
      </div>
      {#if info.warHQ}
        <div class="wr-hq" title={plainText(fill(W + "WarHQExtraInfoWarReport"))}>
          <span class="wr-arrow">◀</span>
          <LabelText markup={fill(W + "WarHQTextWithLink", { hqLink: `<url=showinfo:${info.hqTypeID ?? 0}//${info.warHQ}>${info.hqName ?? info.warHQ}</url>` })} {followerOf} />
          <span class="wr-arrow">▶</span>
        </div>
      {/if}
      {#if !w.mutual}
        <div class="wr-buttons">
          {#if [w.declaredByID, w.againstID].includes(me) && w.retracted === null && director}
            {@const last = surrenders.length ? surrenders[surrenders.length - 1]! : null}
            <button type="button" title={last ? plainText(fill(W + "OfferedToSurrender", { amount: last.iskValue, corpName: nameOf(last.ownerID1) })) : plainText(fill(W + "OffereToSurrender"))} onclick={() => (surrenderOpen = true)}>🏳 {plainText(fill(W + "OfferSurrenderBtn"))}</button>
          {:else}<span></span>{/if}
          <!-- SetAllyBtnIcon: Mercenary_Ally with allies, Mercenary_Add where open for allies, else Mercenary -->
          <button type="button" disabled={!info.allies.length} title={info.allies.length ? plainText(fill(W + "DefenderHasNumAllies", { num: info.allies.length })) : plainText(fill(W + "DefenderHasNoAllies"))} onclick={() => (alliesOpen = true)}>{info.allies.length ? "🛡" : w.openForAllies ? "✚" : "⚔"} {plainText(fill(W + "ViewAlliesBtn"))}</button>
        </div>
      {/if}
      {#if showGraph}
        <div class="wr-graph">
          <div class="wr-graph-names">
            {#each CLASS_ORDER as c (c)}
              {@const k = classKills(c)}
              <button type="button" class:quiet={k.attackerKills === 0 && k.defenderKills === 0} onclick={() => pickClass(c)}>{plainText(fill(W + "ShipGroups/" + CLASS_LABELS[c]))}</button>
            {/each}
          </div>
          <div class="wr-graph-main">
            <div class="wr-graph-data">
              <div class="wr-graph-lines">{#each Array(10) as _, i (i)}<span></span>{/each}</div>
              {#each CLASS_ORDER as c (c)}
                {@const k = classKills(c)}
                <button type="button" class="wr-bar" class:selected={shownGroup === c} title={barHint(k)} onclick={() => pickClass(c)}>
                  <span class="wr-bar-att" style:width={`${Math.min(1, k.attackerKillsIsk / maxKills) * 100}%`}></span>
                  <span class="wr-bar-def" style:width={`${Math.min(1, k.defenderKillsIsk / maxKills) * 100}%`}></span>
                </button>
              {/each}
            </div>
            <div class="wr-graph-legend"><span>{plainText(fill(W + "Legend", { legend: isk(0, 2) }))}</span><span>{plainText(fill(W + "Legend", { legend: isk(maxKills, 2) }))}</span></div>
          </div>
        </div>
      {/if}
      <div class="wr-filter">
        <select value={combo} onchange={(e) => { combo = Number((e.currentTarget as HTMLSelectElement).value); try { localStorage.setItem("evejs.play.killComboValue", String(combo)); } catch { /* not kept */ } void loadKills(); }}>
          <option value={0}>{plainText(fill(W + "ShowAllKills"))}</option><option value={1}>{plainText(fill(W + "ShowAggressorKills"))}</option><option value={2}>{plainText(fill(W + "ShowDefenderKills"))}</option>
        </select>
        <label><input type="checkbox" checked={showGraph} onchange={() => { showGraph = !showGraph; try { localStorage.setItem("evejs.play.killShowGraph", showGraph ? "1" : "0"); } catch { /* not kept */ } if (showGraph) loadGraph(); void loadKills(); }} />{plainText(fill(W + "ShowGraph"))}</label>
        <span class="wr-delay">{plainText(fill("UI/Corporations/CorporationWindow/Wars/DelayedKillboardDetails"))}</span>
      </div>
      <div class="wr-kills">
        {#if kills !== null && !killRows.length}<p class="wr-hint">{plainText(fill(W + (showGraph && shownGroup !== null ? "NoKillsFoundForGroup" : "NoKillsFound")))}</p>{/if}
        {#each killRows as r, i (i)}
          {#if "header" in r}<div class="wr-day">{r.header}</div>
          {:else}
            {@const k = r.kill}
            <div class="wr-kill">
              <LabelText markup={fill(W + (k.victimAllianceID ? "KillVictimInAlliance" : "KillVictim"), { victimName: ownerLink(k.victimCharacterID), victimCorp: ownerLink(k.victimCorporationID), victimAlliance: ownerLink(k.victimAllianceID) })} {followerOf} />
              <LabelText markup={fill(W + (k.finalAllianceID ? "KillKillerInAlliance" : "KillKiller"), { killerName: ownerLink(k.finalCharacterID), killerCorp: ownerLink(k.finalCorporationID), killerAlliance: ownerLink(k.finalAllianceID) })} {followerOf} />
            </div>
          {/if}
        {/each}
      </div>
    {:else if !error}<p class="wr-hint">…</p>{/if}
  </div>
</div>

<style>
  .wr-back { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0, 0, 0, 0.35); }
  .wr { width: 600px; height: 640px; display: flex; flex-direction: column; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); padding: 0 4px 4px; }
  header { display: flex; justify-content: space-between; padding: 6px 4px; font-weight: bold; }
  .wr-x { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .wr-date { text-align: right; padding: 4px 10px 6px; }
  .wr-mutual { text-align: center; padding: 4px 0 6px; }
  .wr-sides { height: 70px; display: grid; grid-template-columns: 45fr 10fr 45fr; align-items: start; }
  .wr-side { display: flex; gap: 8px; }
  .wr-side.attacker { flex-direction: row-reverse; text-align: right; }
  .wr-side.attacker { grid-column: 1; }
  .wr-swords { grid-column: 2; grid-row: 1; text-align: center; align-self: center; opacity: 0.3; font-size: 24px; }
  .wr-logo { width: 64px; height: 64px; flex: none; display: grid; }
  .wr-logo :global(.corp-logo) { width: 64px; height: 64px; }
  .wr-text { display: flex; flex-direction: column; min-width: 0; }
  .wr-name { font-size: 15px; white-space: nowrap; overflow: hidden; }
  .wr-att { color: rgb(199, 66, 50); }
  .wr-def { color: rgb(81, 120, 182); }
  .wr-hq { display: flex; justify-content: space-between; align-items: center; padding: 2px 0; text-align: center; }
  .wr-arrow { color: rgb(199, 66, 50); }
  .wr-buttons { height: 33px; display: flex; justify-content: space-between; align-items: center; padding: 0 4px; }
  .wr-filter { display: flex; align-items: center; gap: 8px; padding-top: 8px; }
  .wr-graph { height: 206px; display: flex; flex: none; padding-top: 8px; }
  .wr-graph-names { display: flex; flex-direction: column; align-items: flex-end; padding: 2px 4px 0 10px; }
  .wr-graph-names button { height: 18px; min-height: 0; padding: 0; border: 0; background: none; color: inherit; font-size: 11px; cursor: pointer; }
  .wr-graph-names button.quiet { opacity: 0.5; }
  .wr-graph-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .wr-graph-data { position: relative; flex: 1; margin: 0 0 4px 4px; background: rgba(102, 102, 102, 0.2); }
  .wr-graph-lines { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(10, 1fr); pointer-events: none; }
  .wr-graph-lines span { border-right: 1px solid rgba(255, 255, 255, 0.1); }
  .wr-bar { box-sizing: border-box; min-height: 0; position: relative; display: flex; flex-direction: column; justify-content: space-between; width: 100%; height: 18px; padding: 4px 0; border: 0; background: none; cursor: pointer; }
  .wr-bar:hover { background: rgba(255, 255, 255, 0.1); }
  .wr-bar.selected { background: rgba(255, 255, 255, 0.15); }
  .wr-bar-att { height: 5px; background: rgb(199, 66, 50); }
  .wr-bar-def { height: 5px; background: rgb(81, 120, 182); }
  .wr-graph-legend { height: 20px; display: flex; justify-content: space-between; font-size: 11px; padding: 0 4px 0 4px; }
  .wr-filter label { display: flex; gap: 4px; align-items: center; }
  .wr-delay { margin-left: auto; font-size: 11px; opacity: 0.7; }
  .wr-kills { flex: 1; overflow: auto; margin-top: 4px; border: 1px solid rgba(255, 255, 255, 0.08); }
  .wr-day { font-weight: bold; padding: 2px 4px; background: rgba(255, 255, 255, 0.05); }
  .wr-kill { min-height: 41px; padding: 2px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .wr-hint { opacity: 0.7; padding: 4px; }
  .error { color: #e06666; }
</style>
