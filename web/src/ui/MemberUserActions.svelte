<script lang="ts">
  // Plain User entries in corp_ui_member_view_simple.py:63-68 use User.GetMenu,
  // including CharacterMenu's normal merged selection actions. No tracking data.
  import { onMount, onDestroy, untrack } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import { focusMail } from "./mailFocus.ts";
  import ContactActionDialog from "./ContactActionDialog.svelte";
  import OwnerFleetMenu from "./OwnerFleetMenu.svelte";
  import OwnerChatMenu from "./OwnerChatMenu.svelte";
  import OwnerDuelMenu from "./OwnerDuelMenu.svelte";
  import OwnerTradeMenu from "./OwnerTradeMenu.svelte";
  import OwnerMemberMenu from "./OwnerMemberMenu.svelte";
  import OwnerExpelMenu from "./OwnerExpelMenu.svelte";
  import OwnerDecorationMenu from "./OwnerDecorationMenu.svelte";
  import OwnerCorporationInviteMenu from "./OwnerCorporationInviteMenu.svelte";
  import OwnerCorporationCashMenu from "./OwnerCorporationCashMenu.svelte";
  import MemberFleetInvites from "./MemberFleetInvites.svelte";
  import type { ContactScope, NamedAddressBook } from "../bridge/contacts.ts";
  import type { ContactAction } from "./contactAction.ts";
  import { isNpcOwner } from "../bridge/mail.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";


  let { store, flow, ownerIDs, active, onDone, openMail, openWatchlist }: { store: ClientStore; flow: AppFlow; ownerIDs: readonly number[]; active: boolean; onDone: () => void; openMail?: () => void; openWatchlist?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const station = store.station, words = store.words, names = store.names;
  const diplomat = $derived((BigInt($station.online?.corpRole ?? "0") & (1n | 17179869184n)) !== 0n);
  const word = (label: string, fallback: string): string => plainText($words.templates[label] ?? fallback);
  const LABELS = { info: "UI/Commands/ShowInfo", mail: "UI/EVEMail/SendPilotEVEMail", addCorpContact: "UI/PeopleAndPlaces/AddCorpContact", editCorpContact: "UI/PeopleAndPlaces/EditCorpContact", removeCorpContact: "UI/PeopleAndPlaces/RemoveCorpContact", addAllianceContact: "UI/PeopleAndPlaces/AddAllianceContact", editAllianceContact: "UI/PeopleAndPlaces/EditAllianceContact", removeAllianceContact: "UI/PeopleAndPlaces/RemoveAllianceContact" };
  let disposed = false;
  let contactBook = $state<NamedAddressBook | null>(null);
  let contactError = $state("");
  let corporateContactBook = $state<NamedAddressBook | null>(null);
  let allianceContactBook = $state<NamedAddressBook | null>(null);
  const contactAuthority = $derived(`${$station.online?.characterID}:${$station.online?.corporationID}:${$station.online?.allianceID}:${$station.online?.corpRole}`);
  type ScopedAction = ContactAction & { readonly scope: ContactScope };
  let contactActions = $state<readonly ScopedAction[]>([]);
  let contactMenuSerial = 0;
  let contactBusy = $state(false);
  let capturing = $state(false), captureProgress = $state<readonly [number, number] | null>(null);
  let captures = $state<readonly { readonly id: number; readonly url: string }[]>([]);
  $effect(() => {
    const authority = contactAuthority;
    untrack(() => {
      void authority;
      contactMenuSerial++;
      onDone();
      contactBook = null;
      corporateContactBook = null;
      allianceContactBook = null;
      contactActions = [];
    });
  });

  const selected = $derived(ownerIDs.map(id => ({ member: { characterID: id }, text: { name: resolvedName($names.resolved, "owner", id, String(id)) } })));
  const personalContactTarget = $derived(selected.length === 1 && selected[0]!.member.characterID !== $station.online?.characterID && !isNpcOwner(selected[0]!.member.characterID) ? selected[0]! : null);
  const targetIsContact = $derived(contactBook?.contacts.some(each => each.contactID === personalContactTarget?.member.characterID) ?? false);
  const targetIsBlocked = $derived(contactBook?.blocked.some(each => each.ownerID === personalContactTarget?.member.characterID) ?? false);
  const corporateTargets = $derived(diplomat ? selected.filter(row => !isNpcOwner(row.member.characterID)) : []);
  const corporateExisting = $derived(new Set(corporateContactBook?.contacts.map(each => each.contactID) ?? []));
  const corporateAddTargets = $derived(corporateTargets.filter(row => !corporateExisting.has(row.member.characterID)));
  const corporateEditTargets = $derived(corporateTargets.filter(row => corporateExisting.has(row.member.characterID)));
  const allianceExisting = $derived(new Set(allianceContactBook?.contacts.map(each => each.contactID) ?? []));
  const allianceAddTargets = $derived(corporateTargets.filter(row => !allianceExisting.has(row.member.characterID)));
  const allianceEditTargets = $derived(corporateTargets.filter(row => allianceExisting.has(row.member.characterID)));

  const selection = $derived(ownerIDs.join(":"));
  function close(): void { onDone(); }
  $effect(() => {
    const visible = active, identity = selection, authority = contactAuthority;
    untrack(() => {
      void identity; void authority;
      const request = ++contactMenuSerial;
      contactBook = null; corporateContactBook = null; allianceContactBook = null; contactError = "";
      if (!visible) return;
      const current = () => !disposed && request === contactMenuSerial;
      if (personalContactTarget) void flow.addressBook().then(book => { if (current()) contactBook = book; }, cause => { if (current()) contactError = String(cause); });
      if (diplomat && selected.some(row => !isNpcOwner(row.member.characterID))) {
        void flow.addressBook("corpcontact").then(book => { if (current()) corporateContactBook = book; }, cause => { if (current()) contactError = String(cause); });
        if ($station.online?.allianceID) void (async () => {
          if (!await flow.saveForAllianceOffered() || !current()) return;
          const book = await flow.addressBook("alliancecontact"); if (current()) allianceContactBook = book;
        })().catch(cause => { if (current()) contactError = String(cause); });
      }
    });
  });
  function contactManage(kind: ContactAction["kind"]): void {
    const target = personalContactTarget;
    if (!target || !contactBook) return;
    contactActions = [{ kind, ownerID: target.member.characterID, name: target.text.name!, book: contactBook, scope: "contact" }];
    close();
  }
  function corporateManage(kind: "add" | "edit" | "remove", scope: ContactScope = "corpcontact"): void {
    const book = scope === "alliancecontact" ? allianceContactBook : corporateContactBook;
    if (!diplomat || !book) return;
    // menusvc 604-609 + compiled menuMerge: separate callbacks for the
    // eligible owners, including mixed selections; no bulk standing editor.
    const targets = scope === "alliancecontact" ? kind === "add" ? allianceAddTargets : allianceEditTargets : kind === "add" ? corporateAddTargets : corporateEditTargets;
    contactActions = targets.map(row => ({ kind: kind === "remove" ? "remove" : "manage", ownerID: row.member.characterID,
      name: row.text.name!, book, scope }));
    close();
  }
  function contactDone(action: ScopedAction, book: NamedAddressBook | null): void {
    if (action.scope === "contact" && book) contactBook = book;
    // Each native dialog owns one target's draft. A future menu reads the
    // service's current held book, which includes all independently completed writes.
    if (action.scope === "corpcontact") corporateContactBook = null;
    if (action.scope === "alliancecontact") allianceContactBook = null;
    contactActions = contactActions.filter(each => each !== action);
  }
  async function contactBlock(blocked: boolean): Promise<void> {
    const target = personalContactTarget;
    const id = target?.member.characterID;
    const book = contactBook;
    if (!id || !book) return;
    contactBusy = true;
    contactError = "";
    try {
      if (blocked) await flow.blockOwners([id]);
      else await flow.unblockOwners([id]);
      if (disposed || personalContactTarget?.member.characterID !== id) return;
      contactBook = { ...book, blocked: blocked ? [...book.blocked, { ownerID: id, name: target?.text.name ?? "" }] : book.blocked.filter(each => each.ownerID !== id) };
      close();
    } catch (cause) { contactError = cause instanceof Error ? cause.message : String(cause); }
    finally { contactBusy = false; }
  }
  function infoSelected(): void {
    close();
    // User._GetMultiMenu -> CharacterMenu -> menuMerge._ExecMulti: ShowInfo runs for each selected row.
    for (const row of selected) showInfo({ kind: "character", characterID: row.member.characterID });
  }
  function mailSelected(): void {
    // CharacterChecker excludes self. Compiled menuMerge drops the multi-row mail entry's unsupported tuple args.
    const row = selected.length === 1 ? selected[0] : null;
    if (!row || row.member.characterID === $station.online?.characterID) return;
    close();
    openMail?.();
    focusMail({ kind: "compose", characterID: row.member.characterID, name: row.text.name! });
  }
  function giveMoney(): void {
    const target = personalContactTarget;
    if (!target) return;
    const opening = flow.openMoneyTransfer(target.member.characterID); close();
    void opening.catch(cause => { if (!disposed && cause?.code !== "SESSION_REQUEST_RETIRED") contactError = String(cause); });
  }
  async function capture(): Promise<void> {
    const targets = selected.filter(row => !isNpcOwner(row.member.characterID)).map(row => row.member.characterID);
    if (capturing || !targets.length) return;
    capturing = true; contactError = ""; close();
    try {
      await flow.capturePortraits(targets, (id, image) => {
        const bytes = Uint8Array.from(atob(image.base64), ch => ch.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: image.contentType }));
        for (const previous of captures.filter(image => image.id === id)) URL.revokeObjectURL(previous.url);
        captures = [...captures.filter(image => image.id !== id), { id, url }];
        const link = document.createElement("a"); link.href = url; link.download = `${id}.jpg`;
        document.body.append(link); link.click(); link.remove();
        if (disposed) setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }, (done, total) => { if (!disposed) captureProgress = [done, total]; });
    } catch (cause) { if (!disposed && !(cause instanceof BridgeCallError && cause.code === "SESSION_REQUEST_RETIRED")) contactError = String(cause); }
    finally { if (!disposed) capturing = false; }
  }

  onMount(() => flow.requestWords([...Object.values(LABELS), "UI/Commands/GiveMoney", "UI/Commands/CapturePortrait", "UI/Shared/GeneratingPicture", ...["AddContact", "EditContact", "RemoveContact", "BlockContact", "UnblockContact"].map(key => "UI/PeopleAndPlaces/" + key)]));
  onDestroy(() => { disposed = true; contactMenuSerial++; for (const image of captures) URL.revokeObjectURL(image.url); });
</script>
{#if contactError}<p role="alert" class="note">{contactError}</p>{/if}
{#if captureProgress}<p role="status">{word("UI/Shared/GeneratingPicture", "Generating picture")}: {captureProgress[0]}/{captureProgress[1]}</p>{/if}
{#if captures.length}<ul aria-label="Captured portraits">{#each captures as image}<li><a href={image.url} download={`${image.id}.jpg`}>{image.id}.jpg</a></li>{/each}</ul>{/if}
    {#if active && selected.length > 0}
      <div class="controls member-menu" aria-label="Member actions">
        <span>{selected.length} selected</span>
        <button type="button" class="minor" onclick={infoSelected}>{word(LABELS.info, "Show Info")}</button>
        {#if selected.length === 1 && selected[0]!.member.characterID !== $station.online?.characterID}
          <button type="button" class="minor" onclick={mailSelected}>{word(LABELS.mail, "Send Pilot EVEMail")}</button>
        {/if}
        {#if personalContactTarget}<button type="button" class="minor" onclick={giveMoney}>{word("UI/Commands/GiveMoney", "Give Money")}</button>{/if}
        {#if selected.some(row => !isNpcOwner(row.member.characterID))}<button type="button" class="minor" disabled={capturing} onclick={() => void capture()}>{word("UI/Commands/CapturePortrait", "Capture Portrait")}</button>{/if}
        {#if personalContactTarget && contactBook}
          {#if targetIsContact}
            <button type="button" class="minor" onclick={() => contactManage("manage")}>{word("UI/PeopleAndPlaces/EditContact", "Edit Contact")}</button>
            <button type="button" class="minor" onclick={() => contactManage("remove")}>{word("UI/PeopleAndPlaces/RemoveContact", "Remove Contact")}</button>
          {:else}
            <button type="button" class="minor" onclick={() => contactManage("manage")}>{word("UI/PeopleAndPlaces/AddContact", "Add Contact")}</button>
          {/if}
          <button type="button" class="minor" disabled={contactBusy} onclick={() => void contactBlock(!targetIsBlocked)}>{word(targetIsBlocked ? "UI/PeopleAndPlaces/UnblockContact" : "UI/PeopleAndPlaces/BlockContact", targetIsBlocked ? "Unblock" : "Block")}</button>
        {/if}
        {#if diplomat && corporateContactBook}
          {#if corporateAddTargets.length > 0}<button type="button" class="minor" onclick={() => corporateManage("add")}>{word(LABELS.addCorpContact, "Add Corporation Contact")}</button>{/if}
          {#if corporateEditTargets.length > 0}
            <button type="button" class="minor" onclick={() => corporateManage("remove")}>{word(LABELS.removeCorpContact, "Remove Corporation Contact")}</button>
            <button type="button" class="minor" onclick={() => corporateManage("edit")}>{word(LABELS.editCorpContact, "Edit Corporation Contact")}</button>
          {/if}
        {/if}
        {#if diplomat && allianceContactBook}
          {#if allianceAddTargets.length > 0}<button type="button" class="minor" onclick={() => corporateManage("add", "alliancecontact")}>{word(LABELS.addAllianceContact, "Add Alliance Contact")}</button>{/if}
          {#if allianceEditTargets.length > 0}
            <button type="button" class="minor" onclick={() => corporateManage("remove", "alliancecontact")}>{word(LABELS.removeAllianceContact, "Remove Alliance Contact")}</button>
            <button type="button" class="minor" onclick={() => corporateManage("edit", "alliancecontact")}>{word(LABELS.editAllianceContact, "Edit Alliance Contact")}</button>
          {/if}
        {/if}
        <MemberFleetInvites {store} {flow} targets={selected.map(row => row.member.characterID)} onDone={() => close()} />
        {#if selected.length === 1}
          <OwnerDuelMenu {store} {flow} ownerID={selected[0]!.member.characterID} onDone={() => close()} />
          <OwnerTradeMenu {store} {flow} ownerID={selected[0]!.member.characterID} onDone={() => close()} />
          <OwnerChatMenu {store} {flow} ownerID={selected[0]!.member.characterID} onDone={() => close()} />
          <OwnerFleetMenu {store} {flow} ownerID={selected[0]!.member.characterID} {openWatchlist} onDone={() => close()} />
        {/if}
        {#if selected.length === 1}<OwnerMemberMenu {store} {flow} ownerID={selected[0]!.member.characterID} onDone={() => close()} />{/if}
        <OwnerExpelMenu {store} {flow} ownerIDs={selected.map(row => row.member.characterID)} onDone={() => close()} />
        <OwnerDecorationMenu {store} {flow} ownerIDs={selected.map(row => row.member.characterID)} onDone={() => close()} />
        <OwnerCorporationInviteMenu {store} {flow} ownerIDs={selected.map(row => row.member.characterID)} onDone={() => close()} />
        <OwnerCorporationCashMenu {store} {flow} ownerIDs={selected.map(row => row.member.characterID)} onDone={() => close()} />
        <button type="button" class="minor" aria-label="Close member actions" onclick={() => close()}>×</button>
      </div>
    {/if}

{#each contactActions as action (`${action.scope}:${action.ownerID}`)}
  <ContactActionDialog {store} {flow} {action} contactType={action.scope} done={book => contactDone(action, book)} />
{/each}


<style>.member-menu { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 8px 0; }</style>
