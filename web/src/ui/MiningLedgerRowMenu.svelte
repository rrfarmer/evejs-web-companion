<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { assetSearchTextForType } from "../bridge/assetSearch.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { COMPARE_CATEGORIES } from "../bridge/dogmaAttributeGroups.ts";
  import { isNpcOwner } from "../bridge/mail.ts";
  import type { NamedAddressBook } from "../bridge/contacts.ts";
  import { avoidanceItems, isAvoidablePlace } from "../nav/autopilotSettings.ts";
  import { celestialRouteEntries, isWaypointPlace } from "../nav/waypoints.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { findInContracts } from "./contractsSearch.ts";
  import ContactActionDialog from "./ContactActionDialog.svelte";
  import type { ContactAction } from "./contactAction.ts";
  import type { LedgerRowMenu } from "./ledgerRowMenu.ts";
  import { focusMail } from "./mailFocus.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { notify } from "./notices.ts";
  import OwnerChatMenu from "./OwnerChatMenu.svelte";
  import OwnerDuelMenu from "./OwnerDuelMenu.svelte";
  import OwnerFleetMenu from "./OwnerFleetMenu.svelte";
  import OwnerTradeMenu from "./OwnerTradeMenu.svelte";
  import { portal } from "./portal.ts";
  import { showInfo, type InfoSubject } from "./showInfo.ts";
  import { compareType } from "./typeCompare.ts";

  let { store, flow, menu, onClose, openMail, openWatchlist, onShowSystem }: {
    store: ClientStore; flow: AppFlow; menu: LedgerRowMenu | null; onClose: () => void;
    openMail?: () => void; openWatchlist?: () => void; onShowSystem?: (systemID: number) => void;
  } = $props();
  const names = $derived(store.names), words = $derived(store.words), station = $derived(store.station);
  const flight = $derived(store.flight), waypoints = $derived(flow.waypoints);
  const LABELS = {
    system: ["UI/Common/SolarSystem", "Solar System"],
    corporation: ["UI/Common/Corporation", "Corporation"],
    info: ["UI/Commands/ShowInfo", "Show Info"],
    destination: ["UI/Inflight/SetDestination", "Set Destination"],
    add: ["UI/Inflight/AddWaypoint", "Add Waypoint"],
    remove: ["UI/Inflight/RemoveWaypoint", "Remove Waypoint"],
    map: ["UI/Commands/ShowLocationOnMap", "Show on Map"],
    market: ["UI/Inventory/ItemActions/ViewTypesMarketDetails", "View Market Details"],
    contracts: ["UI/Inventory/ItemActions/FindInContracts", "Find in Contracts"],
    assets: ["UI/Inventory/ItemActions/FindPersonalAssets", "Find in Personal Assets"],
    exact: ["UI/Inventory/AssetSearch/KeywordTypeExact", "typeExact"],
    compare: ["UI/Compare/CompareButton", "Compare"],
    mail: ["UI/EVEMail/SendPilotEVEMail", "Send Pilot EVEmail"],
    money: ["UI/Commands/GiveMoney", "Give Money"],
    addContact: ["UI/PeopleAndPlaces/AddContact", "Add Contact"],
    editContact: ["UI/PeopleAndPlaces/EditContact", "Edit Contact"],
    removeContact: ["UI/PeopleAndPlaces/RemoveContact", "Remove Contact"],
    block: ["UI/PeopleAndPlaces/BlockContact", "Block Contact"],
    unblock: ["UI/PeopleAndPlaces/UnblockContact", "Unblock Contact"],
  } as const;
  const word = (key: keyof typeof LABELS) => {
    const [label, fallback] = LABELS[key];
    return plainText($words.templates[label] ?? fallback) || fallback;
  };

  type Group = "system" | "pilot" | "corporation" | "ore";
  let group = $state<Group | null>(null);
  let popup: HTMLDivElement | undefined = $state();
  let position = $state({ x: 0, y: 0 });
  let book = $state.raw<NamedAddressBook | null>(null);
  let contact = $state.raw<ContactAction | null>(null);
  let facts = $state.raw<NonNullable<Awaited<ReturnType<AppFlow["typeFacts"]>>> | null>(null);
  const typeID = $derived(menu?.row.typeID ?? null);
  const typeName = $derived(typeID === null ? "" : resolvedName($names.resolved, "type", typeID, `Type ${typeID}`));
  const typeFacts = $derived(typeID === null ? null : facts?.get(typeID) ?? null);
  const subject = $derived.by((): InfoSubject | null => {
    if (!menu || !group) return null;
    if (group === "ore") return { kind: "type", typeID: menu.row.typeID };
    if (group === "system") return { kind: "mapLocation", typeID: 5, itemID: menu.row.systemID };
    if (menu.kind !== "corporation") return null;
    return group === "pilot"
      ? { kind: "character", characterID: menu.row.characterID }
      : { kind: "corporation", corporationID: menu.row.corporationID };
  });
  const ownerID = $derived(subject?.kind === "character" ? subject.characterID : subject?.kind === "corporation" ? subject.corporationID : null);
  const ownerName = $derived(ownerID === null ? "" : resolvedName($names.resolved, group === "pilot" ? "character" : "corporation", ownerID, String(ownerID)));
  const canContact = $derived(ownerID !== null && ownerID !== $station.online?.characterID);
  const canBlock = $derived(canContact && ownerID !== null && !isNpcOwner(ownerID));
  const isContact = $derived(book?.contacts.some(row => row.contactID === ownerID) ?? false);
  const isBlocked = $derived(book?.blocked.some(row => row.ownerID === ownerID) ?? false);
  const here = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const route = $derived(subject?.kind === "mapLocation" ? celestialRouteEntries(subject.itemID, isWaypointPlace(subject.itemID), here, $waypoints) : null);
  let avoiding = $state(false);

  $effect(() => {
    const active = menu, owner = flow;
    group = null;
    facts = null;
    if (!active) return;
    owner.requestWords(Object.values(LABELS).map(([label]) => label));
    let current = true;
    void owner.typeFacts([active.row.typeID]).then(read => { if (current) facts = read; }).catch(() => {});
    return () => { current = false; };
  });

  $effect(() => {
    const owner = flow, id = ownerID;
    book = null;
    if (id === null || !canContact) return;
    let current = true;
    void owner.addressBook().then(read => { if (current) book = read; }).catch(() => {});
    return () => { current = false; };
  });

  $effect(() => {
    const anchor = menu, node = popup;
    if (!anchor || !node) return;
    const fit = () => {
      position = {
        x: Math.max(0, Math.min(anchor.x, window.innerWidth - node.offsetWidth)),
        y: Math.max(0, Math.min(anchor.y, window.innerHeight - node.offsetHeight)),
      };
    };
    const resize = new ResizeObserver(fit);
    resize.observe(node);
    window.addEventListener("resize", fit);
    fit();
    node.querySelector("button")?.focus();
    return () => { resize.disconnect(); window.removeEventListener("resize", fit); };
  });

  function dismiss(restoreFocus = false) {
    const anchor = menu?.anchor;
    onClose();
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  }

  function pressed(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    } else if (event.key === "Tab") {
      dismiss(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = [...popup?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []];
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  }

  function toggle(next: Group) {
    group = group === next ? null : next;
    if (group === "system" && menu) avoiding = avoidanceItems(flow.autopilotSettings()).includes(menu.row.systemID);
  }

  function choose(action: () => unknown) {
    action();
    dismiss();
  }

  function manageContact(kind: ContactAction["kind"]) {
    if (ownerID === null || !book) return;
    contact = { kind, ownerID, name: ownerName, book };
    dismiss();
  }

  function run(action: Promise<unknown>) {
    dismiss();
    void action.catch(error => {
      if (error?.code !== "SESSION_REQUEST_RETIRED") notify({ kind: "danger", title: "Mining Ledger", detail: String(error) });
    });
  }
</script>

<svelte:window onpointerdown={event => {
  if (menu && event.target instanceof Node && !popup?.contains(event.target)) dismiss();
}} />
<svelte:document onkeydown={event => {
  if (menu && event.target instanceof Node && popup?.contains(event.target)) pressed(event);
}} />

{#snippet heading(id: Group, label: string)}
  <button type="button" class="ledger-menu-heading" aria-expanded={group === id} onclick={() => toggle(id)}>{label}</button>
{/snippet}

{#if menu}
  <div class="hull-menu ledger-row-menu" role="group" aria-label="Extraction row actions" use:portal bind:this={popup}
    style:left={`${position.x}px`} style:top={`${position.y}px`}>
    {#if menu.kind === "personal"}
      {@render heading("system", word("system"))}
      {#if subject?.kind === "mapLocation"}
        {@const location = subject}
        <div class="ledger-menu-entries" data-ledger-group="system">
          {#if route?.setDestination}<button type="button" onclick={() => choose(() => flow.setDestination(location.itemID))}>{word("destination")}</button>{/if}
          {#if route?.addWaypoint}<button type="button" onclick={() => choose(() => flow.addWaypoint(location.itemID))}>{word("add")}</button>{/if}
          {#if route?.removeWaypoint}<button type="button" onclick={() => choose(() => flow.clearWaypoints(location.itemID))}>{word("remove")}</button>{/if}
          {#if isAvoidablePlace(location.itemID)}
            {#if onShowSystem}<button type="button" onclick={() => choose(() => onShowSystem?.(location.itemID))}>{word("map")}</button>{/if}
            <button type="button" onclick={() => choose(() => avoiding ? flow.stopAvoidingLocation(location.itemID) : flow.avoidLocation(location.itemID))}>{avoiding ? "Stop Avoiding System" : "Avoid System"}</button>
          {/if}
          <button type="button" onclick={() => choose(() => showInfo(location))}>{word("info")}</button>
        </div>
      {/if}
    {:else}
      {@render heading("pilot", `Pilot: ${resolvedName($names.resolved, "character", menu.row.characterID, String(menu.row.characterID))}`)}
      {#if subject?.kind === "character"}
        {@render ownerActions(subject, subject.characterID)}
      {/if}
      {@render heading("corporation", word("corporation"))}
      {#if subject?.kind === "corporation"}
        {@render ownerActions(subject, subject.corporationID)}
      {/if}
    {/if}
    <hr />
    {@render heading("ore", typeName)}
    {#if subject?.kind === "type"}
      {@const ore = subject}
      <div class="ledger-menu-entries" data-ledger-group="ore">
        <button type="button" onclick={() => choose(() => showInfo(ore))}>{word("info")}</button>
        {#if typeFacts?.marketGroupID != null}
          <button type="button" onclick={() => choose(() => showMarketDetails(ore.typeID))}>{word("market")}</button>
        {/if}
        {#if typeFacts?.published}
          <button type="button" onclick={() => choose(() => findInContracts(ore.typeID))}>{word("contracts")}</button>
          <button type="button" onclick={() => choose(() => findInPersonalAssets(assetSearchTextForType(word("exact"), typeName)))}>{word("assets")}</button>
        {/if}
        {#if typeFacts?.categoryID != null && COMPARE_CATEGORIES.includes(typeFacts.categoryID)}
          <button type="button" onclick={() => choose(() => compareType(ore.typeID))}>{word("compare")}</button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

{#snippet ownerActions(target: Extract<InfoSubject, { kind: "character" | "corporation" }>, id: number)}
  <div class="ledger-menu-entries" data-ledger-group={target.kind === "character" ? "pilot" : "corporation"}>
    <button type="button" onclick={() => choose(() => showInfo(target))}>{word("info")}</button>
    {#if target.kind === "character"}
      <OwnerChatMenu {store} {flow} ownerID={id} onDone={dismiss} />
      {#if canContact && openMail}
        <button type="button" onclick={() => choose(() => { openMail?.(); focusMail({ kind: "compose", characterID: id, name: ownerName }); })}>{word("mail")}</button>
      {/if}
      <OwnerFleetMenu {store} {flow} ownerID={id} {openWatchlist} onDone={dismiss} />
      <OwnerDuelMenu {store} {flow} ownerID={id} onDone={dismiss} />
      <OwnerTradeMenu {store} {flow} ownerID={id} onDone={dismiss} />
    {/if}
    {#if canBlock}<button type="button" onclick={() => run(flow.openMoneyTransfer(id))}>{word("money")}</button>{/if}
    {#if book && canContact}
      <button type="button" onclick={() => manageContact("manage")}>{word(isContact ? "editContact" : "addContact")}</button>
      {#if isContact}<button type="button" onclick={() => manageContact("remove")}>{word("removeContact")}</button>{/if}
      {#if canBlock}<button type="button" onclick={() => run(isBlocked ? flow.unblockOwners([id]) : flow.blockOwners([id]))}>{word(isBlocked ? "unblock" : "block")}</button>{/if}
    {/if}
  </div>
{/snippet}

{#if contact}<ContactActionDialog {store} {flow} action={contact} done={() => { contact = null; }} />{/if}

<style>
  .ledger-row-menu { align-items: stretch; min-width: 188px; max-width: min(260px, 100vw); max-height: 100vh; overflow: auto; }
  .ledger-row-menu :global(button) { text-align: left; background: transparent; border: 0; padding: 4px 8px; font: inherit; color: inherit; }
  .ledger-row-menu :global(button:hover), .ledger-row-menu :global(button:focus-visible) { background: #ffffff18; }
  .ledger-menu-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ledger-menu-heading::after { content: "▸"; }
  .ledger-menu-heading[aria-expanded=true]::after { content: "▾"; }
  .ledger-menu-entries { display: grid; padding-left: 8px; border-left: 1px solid #738c9880; margin-left: 8px; }
  hr { width: 100%; margin: 2px 0; border: 0; border-top: 1px solid #ffffff26; }
</style>
