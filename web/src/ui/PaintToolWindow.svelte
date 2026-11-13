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
  // Not here yet: the 3D live preview (PreviewPanel), DesignApplicationPage (the corporation's structures, the duration,
  // the cost), SummaryPage and ConfirmApplyWnd - Apply leads nowhere yet.
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
  const LABELS = [P + "TrySKINRTitle", P + "SelectStructureCaption", P + "SelectStructureInfo", P + "StartDesigning", P + "PaintLibrary/Apply", P + "PaintLibrary/ShowNames",
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
        <div class="pt-stage"><img src={structureIcon(data.structures.find((s) => s.typeID === selectedType)?.graphicID ?? null)} alt="" /></div>
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
        <button class="pt-primary pt-apply" disabled={!canApply}>{word(P + "PaintLibrary/Apply")}</button>
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
  .pt-stage img { max-width: 70%; max-height: 80%; }
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
</style>
