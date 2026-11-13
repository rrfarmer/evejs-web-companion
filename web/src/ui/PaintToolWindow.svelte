<script lang="ts">
  // cosmetics/structure/paintToolWnd.PaintToolWnd (OpenPaintToolWindow - Brand Management's Open SKINR; caption
  // UI/Personalization/PaintTool/TrySKINRTitle, min 1030 x 650; for a brand manager only - Open and a corprole change
  // without corpRoleBrandManager say InsufficientRolesForSKINR). Its pages (SELECTED_PAGE, back to the first on close):
  // StructureSelectionPage - SelectStructureCaption and SelectStructureInfo, the PAINT_ELIGIBLE_STRUCTURE_TYPE_IDS'
  // cards (classes/paintTool/structureIcons/<graphicID>_512_tr.png, the glow one where selected, the type's name; the
  // selection kept as the character setting paintTool_selectedStructure, Astrahus by default) and StartDesigning;
  // DesignCreationPage - Back, the paint slots in SLOT_ORDER (Primary, Secondary, Detailing; the slot's name as the
  // hint, its paint's icon where chosen; Primary selected first; SELECTED_PAINTWORK cleared when the page is made), the
  // structure selector (the eligible types by name), and on the right PaintLibraryPanel: PaintSelection {slotName},
  // ShowNames (setting paintLibraryPanel_showNames, on by default), the Matte / Coated / Satin headers, the paints in
  // _get_sorted_paints' order (the BFF works it out as the client's Python 2.7 does), a card's click setting the
  // target slot's paint or clearing it when it is the one set; Apply (enabled while any slot holds a paint) to
  // DesignApplicationPage.
  // DesignApplicationPage (selected structures cleared when made; the catalogue loaded behind LoadingContainer -
  // CatalogueLoadingError where it fails): Back to the design; DurationSelector (SelectDuration, a card per catalogue
  // duration - its days and LicenseDuration -, the first selected; the info line DurationSelectionInfo with
  // DurationSelectionHintTitle / Body as its tooltip); CorpStructureSelector (SelectStructures; SelectAll over the
  // displayed rows eligible for application, StructureTypeFilterShowAll + the eligible types, the quick filter on the
  // name and the location; the corporation's structures - Name with the system's "<system> - " prefix stripped,
  // Location, Type, Status - Ineligible, HasLicense with LicenseDurationHint, or the upkeep state's FullPower / LowPower
  // / Abandoned -, Cost in EverMarks for the selected duration or "-"; a row selectable only for an eligible type at
  // full power; sorted by Name; NoStructuresFound); CorpCheckoutPanel (EvermarksBalance - the insufficient-funds icon
  // where short -, TotalCostTitle); BuyLicense (enabled with structures selected and the balance enough) opening
  // ConfirmApplyWnd (PurchaseSummary, 450 x 240: LicenseType {duration_days}, NumberOfStructures {amount}, TotalCost;
  // BuyAndActivate sends IssueRequest - its error shown in place -, Cancel) and on success SummaryPage (paragon_logo.png,
  // ThankPurchase, ActivatedLicenseDetails {numStructures, numDays}, ActivationProcessDelay; CloseButton closes the
  // window, NewDesignButton back to the first page - the paintwork and the selected structures kept, as the
  // window's selections are).
  // The live preview (PreviewPanel, play/paintPreview.ts) on the design and summary pages: the selected structure
  // type with the paintwork's materials, refitted to the view only when the type changes.
  // Not here yet: the location's security colour.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow, onClose }: { store: ClientStore; flow: AppFlow; onClose?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const P = "UI/Personalization/PaintTool/";
  const SLOTS = [["primary", "UI/Personalization/Slots/Primary"], ["secondary", "UI/Personalization/Slots/Secondary"], ["detailing", "UI/Personalization/Slots/Detailing"]] as const;
  type Slot = (typeof SLOTS)[number][0];
  const S = P + "StructureStates/";
  const LABELS2 = [P + "SelectDuration", P + "DurationSelectionInfo", P + "DurationSelectionHintTitle", P + "DurationSelectionHintBody", P + "LicenseDuration", P + "SelectStructures",
    P + "StructureTypeFilterShowAll", "UI/Common/SelectAll", "UI/Common/Name", "UI/Common/Location", "UI/Common/Type", "UI/Common/Status", "UI/Common/Cost", P + "EvermarksBalance",
    P + "TotalCostTitle", P + "BuyLicense", S + "Ineligible", S + "HasLicense", S + "LicenseDurationHint", S + "FullPower", S + "LowPower", S + "Abandoned",
    "UI/Structures/Browser/NoStructuresFound", P + "CatalogueLoadingError", P + "PurchaseSummary", P + "LicenseType", P + "NumberOfStructures", P + "TotalCost", P + "BuyAndActivate",
    "UI/Common/Buttons/Cancel", P + "IssueRequestErrorDescription", P + "IssueRequestRolesErrorDescription", P + "IssueRequestBalanceErrorDescription", P + "CloseButton",
    P + "NewDesignButton", P + "ActivationProcessDelay", P + "ThankPurchase", P + "ActivatedLicenseDetails"];
  const LABELS = [...LABELS2, P + "TrySKINRTitle", P + "SelectStructureCaption", P + "SelectStructureInfo", P + "StartDesigning", P + "PaintLibrary/Apply", P + "PaintLibrary/ShowNames",
    P + "PaintLibrary/Finishes/Matte", P + "PaintLibrary/Finishes/Coated", P + "PaintLibrary/Finishes/Satin", P + "PaintLibrary/PaintSelection", "UI/Commands/Back", ...SLOTS.map(([, l]) => l)];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const setting = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v) as T; } catch { return fallback; } };
  const keep = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* the session keeps it */ } };
  let data = $state<Awaited<ReturnType<AppFlow["paintToolData"]>> | undefined>(undefined);
  // corpRoleBrandManager (1 << 35).
  const brandManager = $derived((BigInt($station.online?.corpRole ?? "0") & 34359738368n) !== 0n);
  onMount(() => {
    flow.requestWords(LABELS);
    if (!brandManager) { flow.sayDialog("InsufficientRolesForSKINR", null, "You need the Brand Manager role."); onClose?.(); return; }
    void flow.paintToolData().then((d) => { data = d; }, () => { data = null; });
  });
  let page = $state<0 | 1 | 2 | 3>(0);
  let selectedType = $state<number>(setting("evejs.paintTool_selectedStructure", 35832));
  function selectType(typeID: number): void { selectedType = typeID; keep("evejs.paintTool_selectedStructure", typeID); }
  // SELECTED_PAINTWORK: cleared as DesignCreationPage is made (here when it is first shown).
  let paintwork = $state<Record<Slot, number | null>>({ primary: null, secondary: null, detailing: null });
  let targetSlot = $state<Slot>("primary"), showNames = $state<boolean>(setting("evejs.paintLibraryPanel_showNames", true));
  const icon = (paintID: number) => clientTexture(`res:/UI/Texture/classes/paintTool/paintIcons/${paintID}.png`);
  const structureIcon = (graphicID: number | null, glow = false) => clientTexture(`res:/UI/Texture/classes/paintTool/structureIcons/${glow ? "glows/" : ""}${graphicID}_512_tr.png`);
  const paintName = (id: number) => { const p = data?.paints.find((x) => x.id === id); return p?.nameID ? word(`#${p.nameID}`) : String(id); };
  function pick(paintID: number): void { paintwork = { ...paintwork, [targetSlot]: paintwork[targetSlot] === paintID ? null : paintID }; }
  const canApply = $derived(Object.values(paintwork).some((v) => v !== null));
  const slotWord = (slot: Slot) => word(SLOTS.find(([s]) => s === slot)![1]);
  // PreviewPanel: the scene mounted where the page shows it; update(type) with the paintwork's material names.
  const materialOf = (id: number | null) => (id === null ? null : data?.paints.find((p) => p.id === id)?.material ?? null);
  // (three.js is loaded when a preview is first shown, not with the page: its modules load in the browser only)
  function preview(node: HTMLElement, args: { typeID: number; paintwork: Record<Slot, number | null> }) {
    let scene: import("../play/paintPreview.ts").PaintPreviewScene | null = null, last = args, gone = false;
    const show = (a: typeof args) => {
      last = a;
      const stateObjectDna = data?.structures.find((s) => s.typeID === a.typeID)?.stateObjectDna ?? null;
      void scene?.show(a.typeID, { primary: materialOf(a.paintwork.primary), secondary: materialOf(a.paintwork.secondary), detailing: materialOf(a.paintwork.detailing) }, stateObjectDna);
    };
    void import("../play/paintPreview.ts").then((m) => { if (gone) return; scene = new m.PaintPreviewScene(node); show(last); });
    return { update: show, destroy: () => { gone = true; scene?.close(); } };
  }
  // DesignApplicationPage.
  let app = $state<Awaited<ReturnType<AppFlow["paintToolApplication"]>> | null | undefined>(undefined);
  let duration = $state(0), chosen = $state<number[]>([]), typeFilter = $state<number | null>(null), textFilter = $state("");
  let sortBy = $state<"name" | "location" | "type" | "status" | "cost">("name"), sortDown = $state(false);
  async function openApplication(): Promise<void> {
    page = 2; app = undefined;
    try { app = await flow.paintToolApplication(); duration = app.durations[0] ?? 0; } catch { app = null; }
  }
  const ELIGIBLE = new Set([35832, 35833, 35834, 35825, 35826, 35827, 35835, 35836, 35840, 37534, 35841]);
  type Row = NonNullable<typeof app>["structures"][number];
  const eligibleForApplication = (r: Row) => ELIGIBLE.has(r.typeID) && r.upkeepState === 1;
  const price = (r: Row) => app?.prices[r.typeID]?.[duration] ?? null;
  // _strip_system_name.
  const sysName = (r: Row) => nameAny("system", r.solarSystemID) || String(r.solarSystemID);
  const shortName = (r: Row) => (r.name.startsWith(sysName(r)) ? r.name.replace(`${sysName(r)} - `, "") : r.name);
  function status(r: Row): { text: string; hint: string } {
    if (!ELIGIBLE.has(r.typeID)) return { text: word(S + "Ineligible"), hint: "" };
    if (r.licenseID) return { text: word(S + "HasLicense"), hint: word(S + "LicenseDurationHint", { numDays: Math.floor(Math.max(0, r.remainingSeconds ?? 0) / 86400) }) };
    return { text: word(S + (r.upkeepState === 1 ? "FullPower" : r.upkeepState === 2 ? "LowPower" : "Abandoned")), hint: "" };
  }
  // _get_state_sort_order.
  const stateOrder = (r: Row) => (!ELIGIBLE.has(r.typeID) ? -3 : r.upkeepState === 3 ? -2 : r.upkeepState === 2 ? -1 : r.licenseID ? 0 : r.upkeepState === 1 ? 1 : -10);
  const rows = $derived.by(() => {
    if (!app) return [] as Row[];
    const t = textFilter.toLowerCase();
    const list = app.structures.filter((r) => (typeFilter === null || r.typeID === typeFilter) && (!t || r.name.toLowerCase().includes(t) || sysName(r).toLowerCase().includes(t)));
    const key = (r: Row): string | number => sortBy === "name" ? shortName(r).toLowerCase() : sortBy === "location" ? sysName(r) : sortBy === "type" ? nameAny("type", r.typeID) : sortBy === "status" ? stateOrder(r) : price(r) ?? 0;
    return [...list].sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return sortDown ? -c : c; });
  });
  const total = $derived(chosen.reduce((sum, id) => { const r = app?.structures.find((x) => x.structureID === id); const v = r ? price(r) : null; return sum + (v ?? 0); }, 0));
  const funds = $derived((app?.evermarks ?? 0) >= total);
  const eligibleShown = $derived(rows.filter(eligibleForApplication));
  const allChosen = $derived(eligibleShown.length > 0 && eligibleShown.every((r) => chosen.includes(r.structureID)));
  function toggle(id: number, on: boolean): void { chosen = on ? (chosen.includes(id) ? chosen : [...chosen, id]) : chosen.filter((x) => x !== id); }
  const fmt = (v: number) => v.toLocaleString("en-US");
  // ConfirmApplyWnd.
  let confirm = $state(false), sending = $state(false), confirmError = $state("");
  async function buy(): Promise<void> {
    sending = true; confirmError = "";
    try {
      const e = await flow.issueStructureLicenses(paintwork, duration, chosen);
      if (e) { confirmError = word(e) || e; return; }
      confirm = false; summary = { structures: chosen.length, days: Math.floor(duration / 86400) }; page = 3;
    } finally { sending = false; }
  }
  let summary = $state<{ structures: number; days: number } | null>(null);
</script>

<div class="pt">
  {#if data === undefined}<p class="pt-hint">…</p>
  {:else if data === null}<p class="pt-hint">{word(P + "TrySKINRTitle")}</p>
  {:else if page === 0}
    <div class="pt-select">
      <div class="pt-caption"><h2>{word(P + "SelectStructureCaption")}</h2><span>{word(P + "SelectStructureInfo")}</span></div>
      <div class="pt-grid">
        {#each data.structures as s (s.typeID)}
          <button class="pt-card" class:on={selectedType === s.typeID} onclick={() => selectType(s.typeID)}>
            <span class="pt-art"><img src={structureIcon(s.graphicID)} alt="" />{#if selectedType === s.typeID}<img class="pt-glow" src={structureIcon(s.graphicID, true)} alt="" />{/if}</span>
            <span>{nameAny("type", s.typeID) || s.typeID}</span>
          </button>
        {/each}
      </div>
      <div class="pt-start"><button class="pt-primary" onclick={() => { page = 1; }}>{word(P + "StartDesigning")}</button></div>
    </div>
  {:else if page === 1}
    <div class="pt-design">
      <div class="pt-left">
        <button class="pt-back" onclick={() => { page = 0; }}>‹ {word("UI/Commands/Back")}</button>
        <div class="pt-stage" use:preview={{ typeID: selectedType, paintwork }}></div>
        <div class="pt-slots">
          {#each SLOTS as [slot] (slot)}
            <button class="pt-slot" class:on={targetSlot === slot} title={paintwork[slot] !== null ? `${slotWord(slot)}: ${paintName(paintwork[slot]!)}` : slotWord(slot)} onclick={() => { targetSlot = slot; }}>
              {#if paintwork[slot] !== null}<img src={icon(paintwork[slot]!)} alt="" />{:else}<span>+</span>{/if}</button>
          {/each}
        </div>
        <div class="pt-carousel"><select value={String(selectedType)} onchange={(e) => selectType(Number(e.currentTarget.value))}>
          {#each data.structures as s (s.typeID)}<option value={String(s.typeID)}>{nameAny("type", s.typeID) || s.typeID}</option>{/each}</select></div>
      </div>
      <div class="pt-right">
        <div class="pt-libhead">
          <b>{word(P + "PaintLibrary/PaintSelection", { slotName: slotWord(targetSlot) })}</b>
          <label><input type="checkbox" checked={showNames} onchange={(e) => { showNames = e.currentTarget.checked; keep("evejs.paintLibraryPanel_showNames", showNames); }} /> {word(P + "PaintLibrary/ShowNames")}</label>
          <div class="pt-finishes"><span>{word(P + "PaintLibrary/Finishes/Matte")}</span><span>{word(P + "PaintLibrary/Finishes/Coated")}</span><span>{word(P + "PaintLibrary/Finishes/Satin")}</span></div>
        </div>
        <div class="pt-library">
          {#each data.paints as p (p.id)}
            <button class="pt-paint" class:on={paintwork[targetSlot] === p.id} title={p.nameID ? word(`#${p.nameID}`) : ""} onclick={() => pick(p.id)}>
              <img src={icon(p.id)} alt="" />{#if showNames}<small>{p.nameID ? word(`#${p.nameID}`) : p.id}</small>{/if}</button>
          {/each}
        </div>
        <button class="pt-primary pt-apply" disabled={!canApply} onclick={() => void openApplication()}>{word(P + "PaintLibrary/Apply")}</button>
      </div>
    </div>
  {:else if page === 2}
    <div class="pt-apply-page">
      <button class="pt-back" onclick={() => { page = 1; }}>‹ {word("UI/Commands/Back")}</button>
      {#if app === undefined}<p class="pt-hint">…</p>
      {:else if app === null}<p class="pt-hint">{word(P + "CatalogueLoadingError")}</p>
      {:else}
        <div class="pt-panel">
          <h3>{word(P + "SelectDuration")}</h3>
          <div class="pt-durations">{#each app.durations as d (d)}<button class="pt-duration" class:on={duration === d} onclick={() => { duration = d; }}><b>{Math.floor(d / 86400)}</b><span>{word(P + "LicenseDuration")}</span></button>{/each}</div>
          <div class="pt-info" title={`${word(P + "DurationSelectionHintTitle")}\n\n${word(P + "DurationSelectionHintBody")}`}>ⓘ {word(P + "DurationSelectionInfo")}</div>
          <h3 class="pt-center">{word(P + "SelectStructures")}</h3>
          <div class="pt-filters">
            <label><input type="checkbox" checked={allChosen} disabled={!eligibleShown.length} onchange={(e) => { const on = e.currentTarget.checked; for (const r of eligibleShown) toggle(r.structureID, on); }} /> {word("UI/Common/SelectAll")}</label>
            <select value={typeFilter === null ? "" : String(typeFilter)} onchange={(e) => { typeFilter = e.currentTarget.value ? Number(e.currentTarget.value) : null; }}>
              <option value="">{word(P + "StructureTypeFilterShowAll")}</option>{#each [...ELIGIBLE] as id (id)}<option value={String(id)}>{nameAny("type", id) || id}</option>{/each}</select>
            <input type="search" value={textFilter} oninput={(e) => { textFilter = e.currentTarget.value; }} />
          </div>
          <div class="pt-table">
            <div class="pt-row pt-head"><span></span>{#each [["name", "UI/Common/Name"], ["location", "UI/Common/Location"], ["type", "UI/Common/Type"], ["status", "UI/Common/Status"], ["cost", "UI/Common/Cost"]] as const as [k, l] (k)}
              <button onclick={() => { if (sortBy === k) sortDown = !sortDown; else { sortBy = k; sortDown = false; } }}>{word(l)}{sortBy === k ? (sortDown ? " ▾" : " ▴") : ""}</button>{/each}</div>
            {#each rows as r (r.structureID)}
              {@const st = status(r)}
              {@const cost = price(r)}
              <div class="pt-row" class:off={!eligibleForApplication(r)}>
                <span>{#if eligibleForApplication(r)}<input type="checkbox" checked={chosen.includes(r.structureID)} onchange={(e) => toggle(r.structureID, e.currentTarget.checked)} />{/if}</span>
                <span>{shortName(r)}</span><span>{sysName(r)}</span><span>{nameAny("type", r.typeID) || r.typeID}</span><span title={st.hint}>{st.text}</span>
                <span>{#if cost !== null}<img class="pt-em" src={clientTexture("res:/UI/Texture/Icons/evermarks.png")} alt="" />{fmt(cost)}{:else}-{/if}</span>
              </div>
            {:else}<p class="pt-hint">{word("UI/Structures/Browser/NoStructuresFound")}</p>{/each}
          </div>
          <div class="pt-checkout">
            <div><small>{word(P + "EvermarksBalance")}</small><b>{#if !funds}<img class="pt-em" src={clientTexture("res:/UI/Texture/classes/paintTool/insufficient_funds.png")} alt="" />{/if}<img class="pt-em" src={clientTexture("res:/UI/Texture/Icons/evermarks.png")} alt="" />{fmt(app.evermarks)}</b></div>
            <div class="pt-right-text"><small>{word(P + "TotalCostTitle")}</small><b class:short={!funds}><img class="pt-em" src={clientTexture("res:/UI/Texture/Icons/evermarks.png")} alt="" />{fmt(total)}</b></div>
          </div>
          <div class="pt-start"><button class="pt-primary" disabled={!chosen.length || !funds} onclick={() => { confirm = true; confirmError = ""; }}>{word(P + "BuyLicense")}</button></div>
        </div>
      {/if}
    </div>
  {:else if page === 3}
    <div class="pt-summary">
      <div class="pt-summary-stage" use:preview={{ typeID: selectedType, paintwork }}></div>
      <img src={clientTexture("res:/UI/Texture/classes/paintTool/paragon_logo.png")} alt="" />
      <h2>{word(P + "ThankPurchase")}</h2>
      <span>{word(P + "ActivatedLicenseDetails", { numStructures: summary?.structures ?? 0, numDays: summary?.days ?? 0 })}</span>
      <small>{word(P + "ActivationProcessDelay")}</small>
      <div class="pt-summary-buttons"><button onclick={() => onClose?.()}>{word(P + "CloseButton")}</button>
        <button class="pt-primary" onclick={() => { page = 0; }}>{word(P + "NewDesignButton")}</button></div>
    </div>
  {/if}
  {#if confirm}
    <div class="pt-modal-back" role="presentation">
      <div class="pt-modal" role="dialog" aria-label={word(P + "PurchaseSummary")}>
        <header>{word(P + "PurchaseSummary")}</header>
        {#if sending}<p class="pt-hint">…</p>
        {:else if confirmError}<p>{confirmError}</p>
        {:else}
          <div class="pt-modal-body">
            <span>{word(P + "LicenseType", { description_color: "", duration_color: "", duration_days: Math.floor(duration / 86400) })}</span>
            <span>{word(P + "NumberOfStructures", { description_color: "", amount_color: "", amount: chosen.length })}</span>
            <span><span class="pt-dim">{word(P + "TotalCost")}</span> <img class="pt-em" src={clientTexture("res:/UI/Texture/Icons/evermarks.png")} alt="" />{fmt(total)}</span>
          </div>
        {/if}
        <div class="pt-modal-buttons"><button class="pt-primary" disabled={sending} onclick={() => void buy()}>{word(P + "BuyAndActivate")}</button><button disabled={sending} onclick={() => { confirm = false; }}>{word("UI/Common/Buttons/Cancel")}</button></div>
      </div>
    </div>
  {/if}
</div>

<style>
  .pt { height: 100%; min-height: 0; display: flex; flex-direction: column; background: #0d0f12; }
  .pt-hint { text-align: center; opacity: 0.65; }
  .pt-select { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .pt-caption { text-align: center; padding: 16px; }
  .pt-caption h2 { margin: 0 0 4px; }
  .pt-grid { flex: 1; overflow: auto; display: flex; flex-wrap: wrap; justify-content: center; align-content: flex-start; gap: 20px; padding: 8px; }
  .pt-card { all: unset; cursor: pointer; width: 180px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .pt-card.on span:last-child { color: #fff; }
  .pt-art { position: relative; width: 160px; height: 160px; }
  .pt-art img { position: absolute; inset: 0; width: 100%; height: 100%; }
  .pt-start { display: flex; justify-content: center; padding: 16px; }
  .pt-primary { padding: 6px 24px; background: #2b5f84; color: #fff; border: 1px solid #58a6dc; cursor: pointer; }
  .pt-primary:disabled { opacity: 0.4; cursor: default; }
  .pt-design { flex: 1; display: flex; min-height: 0; }
  .pt-left { position: relative; flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .pt-back { all: unset; cursor: pointer; position: absolute; left: 23px; top: 23px; z-index: 2; opacity: 0.85; }
  .pt-stage { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
  .pt-stage { position: relative; }
  .pt-summary-stage { flex: 1; align-self: stretch; min-height: 0; }
  .pt-slots { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 22px; }
  .pt-slot { all: unset; cursor: pointer; width: 56px; height: 56px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.25); display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .pt-slot.on { border-color: #58a6dc; box-shadow: 0 0 0 3px rgba(88, 166, 220, 0.3); }
  .pt-slot img { width: 100%; height: 100%; }
  .pt-carousel { height: 100px; display: flex; align-items: center; justify-content: center; }
  .pt-right { width: 306px; display: flex; flex-direction: column; padding: 37px 2px 54px 24px; box-sizing: border-box; background: rgba(0, 0, 0, 0.4); }
  .pt-libhead { display: flex; flex-direction: column; gap: 8px; padding-right: 24px; padding-bottom: 8px; }
  .pt-finishes { display: grid; grid-template-columns: repeat(3, 76px); gap: 8px; }
  .pt-library { flex: 1; overflow: auto; display: grid; grid-template-columns: repeat(3, 76px); gap: 8px; align-content: flex-start; padding-bottom: 26px; }
  .pt-paint { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; background: rgba(255, 255, 255, 0.1); padding: 4px 0; }
  .pt-paint.on { outline: 2px solid #58a6dc; }
  .pt-paint img { width: 64px; height: 64px; }
  .pt-paint small { font-size: 10px; text-align: center; line-height: 1.1; max-width: 72px; }
  .pt-apply { height: 40px; margin-right: 22px; }
  .pt { position: relative; }
  .pt-apply-page { position: relative; flex: 1; min-height: 0; overflow: auto; }
  .pt-panel { width: 688px; max-width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 8px; padding-top: 16px; }
  .pt-durations { display: flex; flex-wrap: wrap; gap: 28px; }
  .pt-duration { all: unset; cursor: pointer; width: 210px; height: 87px; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px solid rgba(255, 255, 255, 0.3); }
  .pt-duration b { font-size: 24px; }
  .pt-duration.on { border-color: #5fb85f; color: #5fb85f; box-shadow: 0 0 8px rgba(95, 184, 95, 0.5); }
  .pt-info { padding-bottom: 16px; border-bottom: 2px solid rgba(255, 255, 255, 0.3); }
  .pt-center { text-align: center; }
  .pt-filters { display: flex; gap: 20px; align-items: center; }
  .pt-table { display: flex; flex-direction: column; min-height: 120px; border-bottom: 2px solid rgba(255, 255, 255, 0.3); }
  .pt-row { display: grid; grid-template-columns: 28px 1.6fr 1fr 1fr 1fr 0.8fr; gap: 6px; min-height: 30px; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .pt-row.off { opacity: 0.5; }
  .pt-head button { all: unset; cursor: pointer; font-size: 11px; opacity: 0.7; }
  .pt-em { width: 16px; height: 16px; vertical-align: middle; margin-right: 2px; }
  .pt-checkout { display: flex; justify-content: space-between; padding: 8px 0; }
  .pt-checkout > div { display: flex; flex-direction: column; }
  .pt-right-text { text-align: right; }
  .short { color: #d4534f; }
  .pt-summary { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 8px; padding-bottom: 32px; }
  .pt-summary img { width: 34px; height: 32px; }
  .pt-summary-buttons { display: flex; gap: 12px; padding-top: 24px; }
  .pt-summary-buttons button { width: 200px; height: 40px; }
  .pt-modal-back { position: absolute; inset: 0; z-index: 5; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; }
  .pt-modal { width: 450px; min-height: 240px; display: flex; flex-direction: column; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.2); }
  .pt-modal header { padding: 8px 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .pt-modal-body { flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 16px 12px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .pt-modal p { flex: 1; padding: 12px; }
  .pt-modal-buttons { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; }
  .pt-dim { opacity: 0.65; }
</style>
