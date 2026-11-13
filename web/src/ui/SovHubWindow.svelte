<script lang="ts">
  // sov/sovHub/sovHubWnd.SovHubWnd (OpenSovHubWnd; min 960 x 590, compact; caption the hub's name): the left - the
  // hub's name, SummaryCont (NumUpgradesOnline {numOnline} / NumUpgradesInstalled {numInstalled}), the UpgradeScrollCont
  // (columns ColumnPriority, ColumnUpgrade, ColumnPowerAllocation, ColumnWorkforceAllocation, ColumnUpkeep,
  // ColumnStartupCost, the online toggle, ColumnState; a row: its priority + 1, the type list's icon and the type's
  // name, power and workforce - a producer's ExtraAmount in green, else what it needs -, ConsumptionPerHour {amount},
  // the startup cost, the configured-online toggle, the state - Online, or PendingPowerState / LowPowerState in red with
  // the lacking resource's tooltip, Offline; the lacking resources from hubUtil.UpdateEffectiveStatesForUpgrades in
  // priority order), NoUpgradesInstalled or DropUpgradesToAdd where empty, and SaveChanges (disabled without changes).
  // The right, 300 wide: PowerCont and WorkforceCont (in use / total available, the max; the gauge), the workforce
  // transport, FuelLevels with the magma and ice gauges, and StartupCostHeader with the pending startups' lava and ice
  // ("000" where none).
  // Editing (HubController): the toggle (SetOnlineState: configured online or offline), the order (DoMove - here the
  // up / down arrows in place of the drag), removal (DeleteUpgrade: ConfirmDestroyUpgrade, Proceed / Cancel, then
  // UninstallRequest at once; FailedToRemoveUpgrade on failure) and Save Changes (with unsaved changes - the list of
  // (type, configured online) differs from the server's: ConfirmSovHubUpgradeChanges, ProcessConfigurationRequest with
  // every upgrade in order; ConfigurationSuccessfullySaved where the power states came back as simulated, else
  // ConfigurationSavedNotSame; SovHubChangeNotSaved on failure). While editing, the states are the simulation's
  // (UpdateEffectiveStatesForUpgrades with unsaved changes: a lacking one shows Offline). Closing with unsaved changes
  // asks ConfirmCloseSovHubWnd.
  // The right's TransitCont (SectionWorkforceTransport): the configured mode's label, GetWorkforceTransportDesc, the
  // import sources with their amounts (SourceSystemNotConnected / NotSendingWorkforce), and SectionEdit opening
  // EditTransitCont: SectionWorkforceTransportSettings, WorceforceMode (Import, Export, Transit - the idle mode is not
  // offered), for export WorkforceTransitAmount and WorkforceTransitReceiver, for import WorkforceTransitSenderNum 1-3
  // (each SectionACLNotSet or a networkable hub's system - GetNetworkableHubs, less the inactive, the transiting, the
  // importing ones for an import and the exporting for an export, one exporting elsewhere, a full importer; and less
  // the other senders' choices); SectionEditApply (enabled where the choice differs: an export needs an amount) asks
  // ConfirmWorkforceChanged {infoText: WorkforceChangeFrom<old>, confirmText: WorkforceChangeTo<new>} and sends
  // ConfigureRequest.
  // AclSectionCont (SectionACL, SectionACLDesc as the header's hint; the fuel access list's name - SectionACLNotSet
  // where none, the list's, its NPC creator's, or UnknownACL - from sovMgr.GetSovHubFuelAccessGroup; for a director
  // (CanEditACL) SectionEdit swaps the name for a combo of the access group options - NoAccessList first - and
  // SectionEditApply: SetSovHubFuelAccessGroup, the name read again).
  // New upgrades (HubController.DoDropData): an upgrade item (UPGRADE_GROUP_IDS) from the ship, here listed under the
  // table while the hub is in the pilot's system, dragged onto the table (at a row: before it) or clicked; GetDropError
  // in its order - AlreadyInstalled (its type in the list), UpgradeSlotFilled (an upgrade of its mutually exclusive
  // group in the list), NotInRange (beyond maxCargoContainerTransferDistance, 2,500 m, of the hub), SovLevelTooLow
  // (attributeDevIndexSovereignty above GetTimeIndexLevelForDays of the days since the claim) - as CustomNotify; else
  // the item's type is put in the list configured online, its removal drops it with no question, and Save Changes
  // sends the items as new_upgrades. ConfirmSovHubUpgradeChanges' body is changesWarning.ConfirmSovHubChanges: each
  // upgrade in the new order - its old place where moved (chevron, old priority), the priority, the name, "New," and the
  // simulated state for an added one or old -> new state where it changed (Offline grey, Online plain, else red) - and
  // ColumnStartupCost with the magma and ice startup cost of the upgrades going from offline or pending to on.
  // Not here yet: dropping an access list on the combo, Show on Map.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, MySovHub, SovHubDetails, SovHubExtras, SovHubUpgrade } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  let { store, flow, hub, details, extras, rangeTo, onClose, onChanged }: { store: ClientStore; flow: AppFlow; hub: MySovHub; details: SovHubDetails | undefined; extras: SovHubExtras | undefined; rangeTo?: (itemID: number) => number | null; onClose: () => void; onChanged: () => Promise<void> } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  const W = "UI/Sovereignty/SovHub/HubWnd/", U = "UI/Sovereignty/SovHub/Upgrades/";
  const COLUMNS = ["ColumnPriority", "ColumnUpgrade", "ColumnPowerAllocation", "ColumnWorkforceAllocation", "ColumnUpkeep", "ColumnStartupCost", "", "ColumnState"];
  const LABELS = [...COLUMNS.filter(Boolean).map((k) => W + k), W + "SovHub", W + "SovHubName", W + "NumUpgradesOnline", W + "NumUpgradesInstalled", W + "SaveChanges", W + "FuelLevels",
    W + "StartupCostHeader", W + "ProceedBtn", W + "ConfigurationSuccessfullySaved", W + "ConfigurationSavedNotSame", U + "FailedToRemoveUpgrade", U + "MoveUpgrades",
    U + "DeleteUpgrade", U + "LackingResourcesHint", W + "SectionWorkforceTransport", W + "SectionEdit", W + "SectionWorkforceTransportSettings", W + "WorceforceMode",
    W + "WorkforceTransitAmount", W + "WorkforceTransitReceiver", W + "WorkforceTransitSenderNum", W + "SectionACLNotSet", W + "SectionEditApply", W + "SourceSystemNotConnected",
    W + "SourceSystemNotSendingWorkforce", W + "WorkforceIdle", W + "WorkforceImport", W + "WorkforceExport", W + "WorkforceTransit", "UI/Sovereignty/SovHub/UnknownWorkforceMode",
    ...["Transit", "Import", "Export", "Inactive"].flatMap((k) => [W + "WorkforceChangeFrom" + k, W + "WorkforceChangeTo" + k]),
    ...["Inactive", "Import", "Export", "ExportNoConnection", "ExportNotConfigured", "Transit"].map((k) => U + "WorkforceTransport" + k),
    W + "SectionACL", W + "SectionACLDesc", "UI/Sovereignty/UnknownACL",
    ...["AlreadyInstalled", "NotInRange", "SovLevelTooLow", "NotItem", "TypeNotValid", "NotInShip"].map((k) => U + "SovHubUpgradeCannotBeAdded" + k), U + "UpgradeSlotFilled", U + "NoUpgradesInstalled", U + "DropUpgradesToAdd", U + "ExtraAmount", U + "ConsumptionPerHour", U + "PendingPowerState", U + "LowPowerState", U + "UnknownPowerState",
    "UI/Common/Online", "UI/Common/Offline", "UI/Sovereignty/Power", "UI/Sovereignty/Workforce", "Tooltips/StructureUI/SovHubRedFuelState", "Tooltips/StructureUI/SovHubRedResourceState",
    "Tooltips/StructureUI/SovHubRedPowerState", "Tooltips/StructureUI/SovHubRedWorkforceState", "Tooltips/StructureUI/SovHubOnlineUpgrade", "Tooltips/StructureUI/SovHubOfflineUpgrade",
    ...COLUMNS.filter(Boolean).map((k) => "Tooltips/StructureUI/SovHub" + ({ ColumnPriority: "Priority", ColumnUpgrade: "InstalledUpgrades", ColumnPowerAllocation: "Allocation", ColumnWorkforceAllocation: "Allocation", ColumnUpkeep: "Upkeep", ColumnStartupCost: "Startup", ColumnState: "State" } as Record<string, string>)[k])];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  onMount(() => {
    flow.requestWords(LABELS);
    flow.requestNames([...(details?.upgrades ?? []).map((u) => ({ kind: "type" as const, id: u.typeID })), { kind: "type", id: 81143 }, { kind: "type", id: 81144 }]);
  });
  const n = (v: number) => v.toLocaleString("en-US");
  // The simulated list (installedUpgradesSimulated): each upgrade with its configured state, in priority order.
  type Sim = { u: SovHubUpgrade; online: boolean; itemID?: number };
  let sim = $state<Sim[]>([]), busy = $state(false);
  let seen: SovHubDetails | undefined;
  $effect(() => { if (details !== seen) { seen = details; sim = (details?.upgrades ?? []).map((u) => ({ u, online: u.powerState !== "POWER_STATE_OFFLINE" })); } });
  const unsaved = $derived.by(() => {
    const original = (details?.upgrades ?? []).map((u) => `${u.typeID}:${u.powerState !== "POWER_STATE_OFFLINE"}`).join(",");
    return sim.map((x) => `${x.u.typeID}:${x.online}`).join(",") !== original;
  });
  function move(i: number, to: number): void { if (to < 0 || to >= sim.length) return; const next = [...sim]; const [x] = next.splice(i, 1); next.splice(to, 0, x!); sim = next; }
  async function remove(x: Sim): Promise<void> {
    if (x.itemID) { sim = sim.filter((y) => y.itemID !== x.itemID); return; }
    if (busy || !(await flow.askClientDialog("ConfirmDestroyUpgrade", "Destroy this upgrade?"))) return;
    busy = true;
    try {
      if (!(await flow.uninstallSovHubUpgrade(hub.hubID, x.u.upgradeKey))) { flow.sayDialog("CustomInfo", { type: "dict", entries: [["info", word(U + "FailedToRemoveUpgrade")]] } as never, word(U + "FailedToRemoveUpgrade")); return; }
      await onChanged();
    } finally { busy = false; }
  }
  async function save(): Promise<void> {
    if (busy || !unsaved || !(await flow.askClientDialogBody("ConfirmSovHubUpgradeChanges", changesMarkup(), "Save these changes?", true))) return;
    busy = true;
    try {
      const before = effective.map((e) => `${e.u.typeID}:${e.state}`).join(",");
      const r = await flow.saveSovHubUpgrades(hub.hubID, sim.map((x) => [x.u.typeID, x.online] as const), sim.flatMap((x) => (x.itemID ? [x.itemID] : [])));
      if ("status" in r) { flow.sayDialog("SovHubChangeNotSaved", null, "The changes were not saved."); return; }
      const after = r.states.map(([t, st]) => `${t}:${st}`).join(",");
      if (before === after) flow.sayDialog("CustomNotify", { type: "dict", entries: [["notify", word(W + "ConfigurationSuccessfullySaved")]] } as never, word(W + "ConfigurationSuccessfullySaved"));
      else flow.sayDialog("CustomInfo", { type: "dict", entries: [["info", word(W + "ConfigurationSavedNotSame")]] } as never, word(W + "ConfigurationSavedNotSame"));
      await onChanged();
      void loadCargo();
    } finally { busy = false; }
  }
  // The drop source: the ship's upgrade items, while the hub is in the pilot's system.
  type Cargo = NonNullable<Awaited<ReturnType<AppFlow["sovHubUpgradeItems"]>>>;
  let cargo = $state<Cargo | null>(null);
  // session.solarsystemid: the space snapshot's system, else the station's.
  const inSystem = $derived(hub.solarSystemID === ($space.snapshot?.solarSystemID ?? $station.online?.solarSystemID));
  async function loadCargo(): Promise<void> { cargo = inSystem ? await flow.sovHubUpgradeItems(hub.solarSystemID) : null; }
  onMount(() => { void loadCargo(); });
  // devIndexUtil.timeIndexLevels: the days of held sovereignty for levels 1 - 5.
  const TIME_INDEX_DAYS = [7, 21, 35, 65, 100];
  function dropError(item: Cargo["items"][number]): string | null {
    if (sim.some((x) => x.u.typeID === item.typeID)) return word(U + "SovHubUpgradeCannotBeAddedAlreadyInstalled");
    if (sim.some((x) => x.u.mutuallyExclusiveGroup === item.def.mutuallyExclusiveGroup)) return word(U + "UpgradeSlotFilled");
    const d = rangeTo?.(hub.hubID) ?? null;
    if (d === null || d > 2500) return word(U + "SovHubUpgradeCannotBeAddedNotInRange");
    if (item.sovLevel) {
      if (cargo?.claimMs == null) return word(U + "SovHubUpgradeCannotBeAddedSovLevelTooLow");
      const days = (Date.now() - cargo.claimMs) / 86_400_000;
      let level = 0;
      for (let l = 5; l >= 1; l--) if (days >= TIME_INDEX_DAYS[l - 1]!) { level = l; break; }
      if (level < item.sovLevel) return word(U + "SovHubUpgradeCannotBeAddedSovLevelTooLow");
    }
    return null;
  }
  function addItem(itemID: number, at: number): void {
    const item = cargo?.items.find((i) => i.itemID === itemID);
    const err = item ? dropError(item) : word(U + "SovHubUpgradeCannotBeAddedNotItem");
    if (err || !item) { flow.sayDialog("CustomNotify", { type: "dict", entries: [["notify", err]] } as never, err ?? ""); return; }
    const entry: Sim = { u: { typeID: item.typeID, powerState: "POWER_STATE_OFFLINE", upgradeKey: 0, ...item.def }, online: true, itemID: item.itemID };
    const next = [...sim];
    if (at < 0) next.push(entry); else next.splice(at, 0, entry);
    sim = next;
  }
  const DRAG = "application/x-sov-upgrade";
  function dropAt(e: DragEvent, at: number): void {
    const id = Number(e.dataTransfer?.getData(DRAG) || NaN);
    if (Number.isNaN(id)) return;
    e.preventDefault(); e.stopPropagation();
    addItem(id, at);
  }
  // changesWarning._GetTooltipContent (GetChanges with getOnline False, GetPriorityChanges, GetStartupCost) as markup.
  function changesMarkup(): string {
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const before = new Map((details?.upgrades ?? []).map((u, i) => [u.typeID, { state: u.powerState, i }]));
    const stateText = (st: SovHubUpgrade["powerState"]) => st === "POWER_STATE_ONLINE" ? esc(word("UI/Common/Online"))
      : st === "POWER_STATE_OFFLINE" ? `<color=0xff6b7280>${esc(word("UI/Common/Offline"))}</color>`
      : `<color=0xffd4534f>${esc(word(st === "POWER_STATE_PENDING" ? U + "PendingPowerState" : st === "POWER_STATE_LOW" ? U + "LowPowerState" : U + "UnknownPowerState"))}</color>`;
    const lines = effective.map((e, i) => {
      const b = before.get(e.u.typeID);
      const text = !b ? `New, ${stateText(e.state)}` : b.state !== e.state ? `${stateText(b.state)} \u2192 ${stateText(e.state)}` : "";
      const moved = b && b.i !== i ? `${i > b.i ? "\u25be" : "\u25b4"}${b.i + 1}` : "";
      return `${moved}<t>${i + 1}<t>${esc(nameAny("type", e.u.typeID) || String(e.u.typeID))}<t>${text}`;
    });
    let first = true;
    for (const t of [81143, 81144]) {
      const cost = effective.filter((e) => e.u.fuelTypeID === t && e.state !== "POWER_STATE_OFFLINE" && ((p) => p === "POWER_STATE_OFFLINE" || p === "POWER_STATE_PENDING")(before.has(e.u.typeID) ? before.get(e.u.typeID)!.state : "POWER_STATE_OFFLINE"))
        .reduce((sum, e) => sum + e.u.startupCost, 0);
      if (!cost) continue;
      if (first) lines.push(" ");
      lines.push(`${first ? esc(word(W + "ColumnStartupCost")) : ""}<t><t><t>${n(cost)} ${esc(nameAny("type", t))}`);
      first = false;
    }
    return lines.join("<br>");
  }
  // WorkforceController's texts for the configured mode and the state.
  const MODE_LABELS: Record<string, string> = { inactive: W + "WorkforceIdle", import_settings: W + "WorkforceImport", export_settings: W + "WorkforceExport", transit: W + "WorkforceTransit" };
  const sysName = (id: number) => nameAny("system", id) || String(id);
  const transport = $derived.by(() => {
    const c = extras?.configuration, w = details?.workforce;
    if (!c) return { mode: word("UI/Sovereignty/HubPage/NotAvailable", { color: "" }) || "N/A", desc: "", sources: [] as { name: string; amount: number | null }[] };
    const mode = c.mode ? word(MODE_LABELS[c.mode]!) : word("UI/Sovereignty/SovHub/UnknownWorkforceMode");
    if (!w) return { mode, desc: "", sources: [] };
    const T = U + "WorkforceTransport";
    if (c.mode === "inactive") return { mode, desc: word(T + "Inactive"), sources: [] };
    if (c.mode === "transit") return { mode, desc: word(T + "Transit"), sources: [] };
    if (c.mode === "import_settings") {
      const got = new Map(w.imports);
      return { mode, desc: word(T + "Import", { amount: w.imports.reduce((n, [, a]) => n + a, 0), solarSystemNames: "" }),
        sources: [...w.imports.map(([id, a]) => ({ name: sysName(id), amount: a })), ...c.sources.filter((id) => !got.has(id)).map((id) => ({ name: sysName(id), amount: null }))] };
    }
    if (w.exportTo) return { mode, desc: word(T + "Export", { amount: w.exportAmount, solarSystemName: sysName(w.exportTo) }), sources: [] };
    if (c.exportTo) return { mode, desc: word(T + "ExportNoConnection", { amount: c.exportAmount, solarSystemName: sysName(c.exportTo) }), sources: [] };
    return { mode, desc: word(T + "ExportNotConfigured", { amount: w.exportAmount }), sources: [] };
  });
  // EditTransitCont.
  type Mode = "inactive" | "transit" | "import_settings" | "export_settings";
  let editing = $state(false), editMode = $state<Mode>("transit"), amount = $state(0), receiver = $state<number | null>(null), senders = $state<(number | null)[]>([null, null, null]);
  let networkable = $state<Awaited<ReturnType<AppFlow["sovHubNetworkableHubs"]>>>(null);
  async function openEdit(): Promise<void> {
    const c = extras?.configuration;
    editMode = c?.mode && c.mode !== "inactive" ? c.mode : c?.mode === "inactive" ? "inactive" : "transit";
    amount = c?.mode === "export_settings" ? c.exportAmount : 0; receiver = c?.mode === "export_settings" ? c.exportTo : null;
    senders = [0, 1, 2].map((i) => (c?.mode === "import_settings" ? c.sources[i] ?? null : null));
    editing = true;
    networkable = await flow.sovHubNetworkableHubs(hub.hubID);
  }
  // _FilterOutHub.
  function options(importing: boolean, others: readonly (number | null)[]): number[] {
    return (networkable ?? []).filter((h) => {
      if (h.mode === "inactive" || h.mode === "transit") return false;
      if (importing && h.mode === "import_settings") return false;
      if (!importing && h.mode === "export_settings") return false;
      if (importing && h.exportTo && h.exportTo !== hub.solarSystemID) return false;
      if (!importing && h.importSources.length >= 3 && !h.importSources.includes(hub.solarSystemID)) return false;
      return !others.includes(h.systemID);
    }).map((h) => h.systemID);
  }
  const applyEnabled = $derived.by(() => {
    const c = extras?.configuration;
    if (!c) return false;
    if (c.mode === editMode && (editMode === "inactive" || editMode === "transit")) return false;
    if (editMode === "export_settings") { if (!amount) return false; if (c.mode === "export_settings" && amount === c.exportAmount && receiver === c.exportTo) return false; }
    if (editMode === "import_settings" && c.mode === "import_settings") { const a = new Set(senders.filter((x): x is number => x !== null)), b = new Set(c.sources); if (a.size === b.size && [...a].every((x) => b.has(x))) return false; }
    return true;
  });
  async function applyTransport(): Promise<void> {
    const old = extras?.configuration?.mode ?? "inactive", NAMES: Record<string, string> = { transit: "Transit", import_settings: "Import", export_settings: "Export", inactive: "Inactive" };
    const ok = await flow.askClientDialogWith("ConfirmWorkforceChanged", { infoText: word(W + "WorkforceChangeFrom" + NAMES[old], { systemName: hub.systemName }), confirmText: word(W + "WorkforceChangeTo" + NAMES[editMode], { systemName: hub.systemName }) }, "Change the workforce transport?");
    if (!ok) return;
    busy = true;
    try {
      if (await flow.configureSovHubWorkforce(hub.hubID, { mode: editMode, sources: senders.filter((x): x is number => x !== null), exportTo: receiver, amount })) { editing = false; await onChanged(); }
    } finally { busy = false; }
  }
  // HubController's fuel ACL.
  let acl = $state<Awaited<ReturnType<AppFlow["sovHubFuelAcl"]>>>(null), aclEditing = $state(false), aclChoice = $state<number | null>(null);
  const canEditAcl = $derived((BigInt($station.online?.corpRole ?? "0") & 1n) === 1n);
  async function loadAcl(): Promise<void> { acl = await flow.sovHubFuelAcl(hub.solarSystemID); }
  onMount(() => { void loadAcl(); });
  const aclName = $derived(!acl ? "" : acl.current === null ? word(W + "SectionACLNotSet") : acl.options.find((o) => o.groupID === acl!.current)?.name ?? word("UI/Sovereignty/UnknownACL"));
  async function applyAcl(): Promise<void> {
    busy = true;
    try { if (await flow.setSovHubFuelAcl(hub.solarSystemID, aclChoice)) { aclEditing = false; await loadAcl(); } else aclEditing = false; } finally { busy = false; }
  }
  async function close(): Promise<void> {
    if (unsaved && !(await flow.askClientDialog("ConfirmCloseSovHubWnd", "Close without saving?"))) return;
    onClose();
  }
  const LIST_ICONS: Record<number, string> = { 829: "☷", 622: "✸", 830: "⇄", 828: "◈", 620: "▣", 621: "⛏" };
  // hubUtil.UpdateEffectiveStatesForUpgrades over the simulated list, in priority order: power / workforce against the
  // hub's available plus what an online producer before adds; fuel - a new, pending or offline one's startup cost
  // plus an hour's upkeep - against the hub's fuel. Configured online and nothing lacking: online and counted; else
  // offline (configured so), offline with unsaved changes or low without them where lacking, pending where only the
  // startup lacks.
  const effective = $derived.by(() => {
    let power = details?.resources?.powerAvailable ?? 0, work = details?.resources?.workforceAvailable ?? 0, pUsed = 0, wUsed = 0;
    const fuelUsed = new Map<number, number>();
    return sim.map(({ u, online, itemID }) => {
      const lackP = u.powerRequired + pUsed > power, lackW = u.workforceRequired + wUsed > work;
      let cost = 0, lackS = false, lackF = false;
      if (u.fuelTypeID) {
        const used = fuelUsed.get(u.fuelTypeID) ?? 0, have = details?.fuel?.[u.fuelTypeID]?.amount ?? 0;
        if (u.powerState === "POWER_STATE_PENDING" || u.powerState === "POWER_STATE_OFFLINE") { lackS = u.startupCost + used > have; cost += u.startupCost; }
        cost += u.fuelPerHour ? 1 : 0;
        lackF = cost + used > have;
      }
      if (online && !lackP && !lackW && !lackF) { pUsed += u.powerRequired; wUsed += u.workforceRequired; if (cost) fuelUsed.set(u.fuelTypeID, (fuelUsed.get(u.fuelTypeID) ?? 0) + cost); }
      let state: SovHubUpgrade["powerState"];
      if (!online) state = "POWER_STATE_OFFLINE";
      else if (lackF || lackP || lackW) state = unsaved ? "POWER_STATE_OFFLINE" : "POWER_STATE_LOW";
      else if (lackS) state = "POWER_STATE_PENDING";
      else { state = "POWER_STATE_ONLINE"; power += u.powerProduced; work += u.workforceProduced; }
      return { u, online, itemID, state, lacking: [lackS ? "startup" : "", lackF ? "fuel" : "", lackP ? "power" : "", lackW ? "workforce" : ""].filter(Boolean) };
    });
  });
  const lacking = $derived(new Map(effective.map((e) => [e.u.typeID, e.lacking])));
  function stateOf(u: SovHubUpgrade, configured: boolean, powerState: SovHubUpgrade["powerState"]): { text: string; hint: string; red: boolean } {
    const T = "Tooltips/StructureUI/";
    // upgradeStateText: not configured online is Offline; else by the effective state.
    if (!configured) return { text: word("UI/Common/Offline"), hint: word(T + "SovHubOfflineUpgrade"), red: false };
    u = { ...u, powerState };
    // Configured online yet simulated offline (lacking, with unsaved changes): UnknownPowerState in red.
    if (u.powerState === "POWER_STATE_OFFLINE") return { text: word(U + "UnknownPowerState"), hint: "", red: true };
    if (u.powerState === "POWER_STATE_ONLINE") return { text: word("UI/Common/Online"), hint: word(T + "SovHubOnlineUpgrade"), red: false };
    const l = lacking.get(u.typeID) ?? [];
    if (u.powerState === "POWER_STATE_PENDING") return { text: word(U + "PendingPowerState"), hint: l.includes("startup") ? word(T + "SovHubRedFuelState") : "", red: true };
    if (u.powerState === "POWER_STATE_LOW") {
      const r = l.filter((x) => x !== "startup");
      return { text: word(U + "LowPowerState"), red: true, hint: r.length > 1 ? word(T + "SovHubRedResourceState") : r[0] === "power" ? word(T + "SovHubRedPowerState") : r[0] === "workforce" ? word(T + "SovHubRedWorkforceState") : "" };
    }
    return { text: word(U + "UnknownPowerState"), hint: "", red: true };
  }
  const listIcon = (typeID: number) => { const l = (extras?.listsByType[typeID] ?? [])[0]; return l ? LIST_ICONS[l] ?? "" : ""; };
  const produced = (key: "powerProduced" | "workforceProduced") => (details?.upgrades ?? []).filter((u) => u.powerState === "POWER_STATE_ONLINE").reduce((s, u) => s + u[key], 0);
  const power = $derived.by(() => { const p = produced("powerProduced"), max = (details?.maxPower ?? 0) + p, avail = (details?.resources?.powerAvailable ?? 0) + p, use = details?.resources?.powerAllocated ?? 0; return { use, avail, max }; });
  const work = $derived.by(() => {
    const p = produced("workforceProduced"), imported = details?.workforce?.mode === "import_settings" ? details.workforce.imports.reduce((s, [, a]) => s + a, 0) : 0;
    const exported = details?.workforce?.mode === "export_settings" ? details.workforce.exportAmount : 0;
    return { use: details?.resources?.workforceAllocated ?? 0, avail: (details?.resources?.workforceAvailable ?? 0) + p, max: (details?.maxWorkforce ?? 0) + p + imported, exported };
  });
  const startup = (typeID: number) => (details?.upgrades ?? []).filter((u) => u.fuelTypeID === typeID && u.powerState === "POWER_STATE_PENDING").reduce((s, u) => s + u.startupCost, 0);
  function timeLeft(typeID: number): { text: string; progress: number; amount: number; perHour: number } {
    const f = details?.fuel?.[typeID];
    if (!f || !f.perHour) return { text: "-", progress: 0, amount: f?.amount ?? 0, perHour: f?.perHour ?? 0 };
    const hours = f.amount / f.perHour;
    return { text: hours > 336 ? word(W + "NumWeeksShort", { numWeeks: Math.floor(hours / 168) }) : hours > 168 ? `${Math.floor(hours / 24)}d` : hours > 24 ? `${Math.floor(hours)}h` : `${Math.floor(hours)}h ${Math.floor((hours % 1) * 60)}m`,
      progress: Math.min(1, hours / 672), amount: f.amount, perHour: f.perHour };
  }
  const online = $derived(effective.filter((e) => e.state === "POWER_STATE_ONLINE").length);
</script>

<div class="hw-back" role="presentation">
  <div class="hw" role="dialog" aria-label={word(W + "SovHubName", { solarSystemName: hub.systemName })}>
    <header><span>{word(W + "SovHubName", { solarSystemName: hub.systemName }) || word(W + "SovHub")}</span><button class="hw-x" onclick={() => void close()}>✕</button></header>
    <div class="hw-body">
      <div class="hw-left">
        <div class="hw-name">{word(W + "SovHubName", { solarSystemName: hub.systemName })}</div>
        <div class="hw-summary"><span>{word(W + "NumUpgradesOnline", { numOnline: online })}</span><span>/</span><span class="hw-dim">{word(W + "NumUpgradesInstalled", { numInstalled: sim.length })}</span></div>
        <div class="hw-table" role="list" ondragover={(e) => { if (e.dataTransfer?.types.includes(DRAG)) e.preventDefault(); }} ondrop={(e) => dropAt(e, -1)}>
          <div class="hw-row hw-head">{#each COLUMNS as c, i (i)}<span>{c ? word(W + c) : ""}</span>{/each}</div>
          {#if !details?.upgrades}<p class="hw-hint">{word("UI/Sovereignty/NotAvailable")}</p>
          {:else}
            {#each effective as e, i (e.u.typeID)}
              {@const u = e.u}
              {@const st = stateOf(u, e.online, e.state)}
              {@const l = e.lacking}
              <div class="hw-row" class:restricted={st.red} role="listitem" ondrop={(e) => dropAt(e, i)}>
                <span class="hw-num"><span class="hw-move" title={word(U + "MoveUpgrades")}><button disabled={busy || i === 0} onclick={() => move(i, i - 1)}>▴</button><button disabled={busy || i === effective.length - 1} onclick={() => move(i, i + 1)}>▾</button></span>{i + 1}</span>
                <span><span class="hw-dim">{listIcon(u.typeID)}</span> {nameAny("type", u.typeID) || u.typeID}</span>
                <span class="hw-num" class:green={u.powerProduced > 0} class:red={l.includes("power")}>{u.powerProduced > 0 ? word(U + "ExtraAmount", { amount: n(u.powerProduced) }) : n(u.powerRequired)} ⚡</span>
                <span class="hw-num" class:green={u.workforceProduced > 0} class:red={l.includes("workforce")}>{u.workforceProduced > 0 ? word(U + "ExtraAmount", { amount: n(u.workforceProduced) }) : n(u.workforceRequired)} ⚇</span>
                <span class="hw-num" class:red={l.includes("fuel")} title={nameAny("type", u.fuelTypeID)}>{word(U + "ConsumptionPerHour", { amount: n(u.fuelPerHour) })}</span>
                <span class="hw-num" class:red={l.includes("startup")} title={nameAny("type", u.fuelTypeID)}>{n(u.startupCost)}</span>
                <span title={!e.online && l.length ? word(U + "LackingResourcesHint") : ""}><input type="checkbox" disabled={busy} checked={e.online} onchange={(ev) => { sim = sim.map((x) => (x.u.typeID === u.typeID ? { ...x, online: ev.currentTarget.checked } : x)); }} /></span>
                <span class="hw-state"><span class:red={st.red} title={st.hint}>{st.text}</span><button class="hw-trash" title={word(U + "DeleteUpgrade")} disabled={busy} onclick={() => void remove(e)}>🗑</button></span>
              </div>
            {:else}<p class="hw-hint">{word(inSystem ? U + "DropUpgradesToAdd" : U + "NoUpgradesInstalled")}</p>{/each}
          {/if}
        </div>
        {#if cargo?.items.length}
          <div class="hw-cargo">{#each cargo.items as item (item.itemID)}<button draggable="true" disabled={busy} ondragstart={(e) => { e.dataTransfer?.setData(DRAG, String(item.itemID)); }} onclick={() => addItem(item.itemID, -1)}>{nameAny("type", item.typeID) || item.typeID}</button>{/each}</div>
        {/if}
        <div class="hw-buttons"><button disabled={!unsaved || busy} onclick={() => void save()}>{word(W + "SaveChanges")}</button></div>
      </div>
      <div class="hw-right">
        {#each [["UI/Sovereignty/Power", power.use, power.avail, power.max, 0], ["UI/Sovereignty/Workforce", work.use, work.avail, work.max, work.exported]] as const as [label, use, avail, max, exported] (label)}
          <small class="hw-dim">{word(label)}</small>
          <div class="hw-res"><span><b>{n(use)}</b> <span class="hw-dim">/ {n(avail)}</span></span><span class="hw-dim">{n(max)}</span></div>
          <div class="hw-gauge"><i class="avail" style:width={`${max ? Math.min(1, (avail + exported) / max) * 100 : 0}%`}></i><i class="avail2" style:width={`${max ? Math.min(1, avail / max) * 100 : 0}%`}></i><i class="use" style:width={`${max ? Math.min(1, use / max) * 100 : 0}%`}></i></div>
        {/each}
        <div class="hw-section">
          <div class="hw-section-head"><small class="hw-dim">{word(W + "SectionWorkforceTransport")}</small></div>
          <div class="hw-section-state"><span>⚇ <b>{transport.mode}</b></span><button class="hw-edit" onclick={() => void openEdit()}>{word(W + "SectionEdit")}</button></div>
          <small class="hw-dim">{transport.desc}</small>
          <div class="hw-sources">{#each transport.sources as src (src.name)}<span title={src.amount === null ? word(W + "SourceSystemNotConnected") : !src.amount ? word(W + "SourceSystemNotSendingWorkforce") : ""}>{src.amount ? `${src.name} (${src.amount})` : `⚠ ${src.name}`}</span>{/each}</div>
          {#if editing}
            <div class="hw-edit-pop" role="dialog">
              <div>{word(W + "SectionWorkforceTransportSettings")}</div>
              <label>{word(W + "WorceforceMode")}<select value={editMode} onchange={(e) => { editMode = e.currentTarget.value as Mode; }}>
                {#each ["import_settings", "export_settings", "transit"] as const as m (m)}<option value={m}>{word(MODE_LABELS[m]!)}</option>{/each}</select></label>
              {#if editMode === "export_settings"}
                <label>{word(W + "WorkforceTransitAmount")}<input type="number" min="0" value={amount} oninput={(e) => { amount = Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)); }} /></label>
                <label>{word(W + "WorkforceTransitReceiver")}<select value={receiver === null ? "" : String(receiver)} onchange={(e) => { receiver = e.currentTarget.value ? Number(e.currentTarget.value) : null; }}>
                  <option value="">{word(W + "SectionACLNotSet")}</option>{#each options(false, []) as id (id)}<option value={String(id)}>{sysName(id)}</option>{/each}</select></label>
              {:else if editMode === "import_settings"}
                {#each [0, 1, 2] as i (i)}
                  <label>{word(W + "WorkforceTransitSenderNum", { senderNum: i + 1 })}<select value={senders[i] === null ? "" : String(senders[i])} onchange={(e) => { const next = [...senders]; next[i] = e.currentTarget.value ? Number(e.currentTarget.value) : null; senders = next; }}>
                    <option value="">{word(W + "SectionACLNotSet")}</option>{#each [...(senders[i] !== null ? [senders[i]!] : []), ...options(true, senders.filter((x, j) => j !== i && x !== null))].filter((v, k, a) => a.indexOf(v) === k) as id (id)}<option value={String(id)}>{sysName(id)}</option>{/each}</select></label>
                {/each}
              {/if}
              <div class="hw-edit-buttons"><button disabled={!applyEnabled || busy} onclick={() => void applyTransport()}>{word(W + "SectionEditApply")}</button><button onclick={() => { editing = false; }}>✕</button></div>
            </div>
          {/if}
        </div>
        <div class="hw-section">
          <div class="hw-section-head"><small class="hw-dim" title={word(W + "SectionACLDesc")}>{word(W + "SectionACL")}</small></div>
          {#if aclEditing}
            <div class="hw-section-state"><select value={aclChoice === null ? "" : String(aclChoice)} onchange={(e) => { aclChoice = e.currentTarget.value ? Number(e.currentTarget.value) : null; }}>
              {#each acl?.options ?? [] as o (o.groupID ?? 0)}<option value={o.groupID === null ? "" : String(o.groupID)}>{o.name}</option>{/each}</select>
              <button disabled={busy} onclick={() => void applyAcl()}>{word(W + "SectionEditApply")}</button></div>
          {:else}
            <div class="hw-section-state"><span>☷ <b>{acl ? aclName : "…"}</b></span>{#if canEditAcl}<button class="hw-edit" disabled={!acl} onclick={() => { aclChoice = acl?.current ?? null; aclEditing = true; }}>{word(W + "SectionEdit")}</button>{/if}</div>
          {/if}
        </div>
        <small class="hw-dim">{word(W + "FuelLevels")}</small>
        <div class="hw-fuels">
          {#each [81143, 81144] as typeID (typeID)}
            {@const t = timeLeft(typeID)}
            <div class="hw-fuel" style:--p={`${t.progress * 360}deg`}><span><b>{t.text}</b><small>{details?.fuel ? t.amount : word("UI/Sovereignty/NotAvailable")}</small><small>{word("UI/Sovereignty/AmountPerHour", { value: t.perHour })}</small></span></div>
          {/each}
        </div>
        <small class="hw-dim">{word(W + "StartupCostHeader")}</small>
        <div class="hw-startup">{#each [81143, 81144] as typeID (typeID)}<span title={nameAny("type", typeID)}>{typeID === 81143 ? "♨" : "❄"} <b>{startup(typeID) || "000"}</b></span>{/each}</div>
      </div>
    </div>
  </div>
</div>

<style>
  .hw-back { position: absolute; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.45); }
  .hw { width: 960px; max-width: 98%; min-height: 590px; max-height: 98%; display: flex; flex-direction: column; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .hw > header { display: flex; justify-content: space-between; padding: 6px 8px; font-weight: bold; }
  .hw-x { all: unset; cursor: pointer; }
  .hw-body { flex: 1; min-height: 0; display: flex; gap: 24px; padding: 8px; }
  .hw-left { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .hw-name { font-size: 15px; padding-left: 26px; }
  .hw-summary { display: flex; gap: 10px; padding: 6px 0 6px 10px; font-size: 12px; }
  .hw-table { flex: 1; min-height: 0; overflow: auto; }
  .hw-row { display: grid; grid-template-columns: 50px 1.6fr 90px 90px 90px 80px 40px 1fr; gap: 6px; min-height: 30px; align-items: center; padding: 0 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .hw-head { font-size: 11px; opacity: 0.7; min-height: 22px; }
  .hw-num { text-align: right; }
  .hw-row.restricted > span:nth-child(2) { color: #d4534f; }
  .red { color: #d4534f; }
  .green { color: #6fbf73; }
  .hw-dim { opacity: 0.65; }
  .hw-hint { text-align: center; opacity: 0.65; }
  .hw-move { display: inline-flex; flex-direction: column; margin-right: 6px; vertical-align: middle; }
  .hw-move button, .hw-trash { all: unset; cursor: pointer; font-size: 10px; line-height: 10px; opacity: 0.6; }
  .hw-move button:disabled, .hw-trash:disabled { opacity: 0.2; cursor: default; }
  .hw-state { display: flex; justify-content: space-between; }
  .hw-trash { font-size: 12px; }
  .hw-section { position: relative; display: flex; flex-direction: column; gap: 2px; margin: 4px 0 20px; }
  .hw-section-state { display: flex; justify-content: space-between; align-items: center; }
  .hw-edit { all: unset; cursor: pointer; color: #58a6dc; }
  .hw-sources { display: flex; flex-wrap: wrap; gap: 10px; }
  .hw-edit-pop { position: absolute; right: 0; top: 100%; z-index: 3; width: 260px; padding: 8px; display: flex; flex-direction: column; gap: 4px; background: #23262b; border: 1px solid rgba(255, 255, 255, 0.2); }
  .hw-edit-pop label { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .hw-edit-pop select, .hw-edit-pop input { width: 140px; }
  .hw-edit-buttons { display: flex; justify-content: center; gap: 6px; padding-top: 6px; }
  .hw-cargo { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0; border-top: 1px dashed rgba(255, 255, 255, 0.15); }
  .hw-cargo button { cursor: grab; }
  .hw-buttons { display: flex; justify-content: flex-end; padding-top: 8px; }
  .hw-right { width: 300px; flex: none; display: flex; flex-direction: column; gap: 4px; }
  .hw-res { display: flex; justify-content: space-between; align-items: baseline; }
  .hw-res b { font-size: 18px; }
  .hw-gauge { position: relative; height: 4px; background: rgba(255, 255, 255, 0.08); margin-bottom: 10px; }
  .hw-gauge i { position: absolute; left: 0; top: 0; bottom: 0; }
  .hw-gauge i.avail { background: #6fbf73; }
  .hw-gauge i.avail2 { background: #58a6dc; }
  .hw-gauge i.use { background: #5a6c80; }
  .hw-fuels { display: flex; gap: 10px; justify-content: center; height: 120px; align-items: center; }
  .hw-fuel { width: 110px; height: 110px; border-radius: 50%; background: conic-gradient(#58a6dc var(--p), rgba(255, 255, 255, 0.08) 0); display: flex; align-items: center; justify-content: center; }
  .hw-fuel > span { width: 104px; height: 104px; border-radius: 50%; background: #1b1d21; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .hw-fuel small { opacity: 0.65; }
  .hw-startup { display: flex; gap: 60px; padding-top: 4px; }
  .hw-startup b { font-size: 15px; }
</style>
