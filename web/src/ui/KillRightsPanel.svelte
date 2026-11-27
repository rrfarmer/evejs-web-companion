<script lang="ts">
  import { getContext, onMount, tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { unixMsToFiletime } from "../bridge/activity.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { KillRight } from "../bridge/killRights.ts";
  import type { AddressBook } from "../bridge/contacts.ts";
  import { isAllianceOwner, isCorporationOwner } from "../bridge/mail.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { resolvedName } from "../store/names.ts";
  import { formatWholeIsk } from "./isk.ts";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const station = $derived(store.station), names = $derived(store.names), words = $derived(store.words), image = $derived(flow.imageServer);
  const pilot = $derived($station.online);
  const addressBook = $derived(store.addressBook);
  const openOwnerMenu = getContext<((event: MouseEvent | KeyboardEvent, characterID: number) => void) | undefined>("killRightOwnerMenu");
  const root = "UI/CharacterSheet/CharacterSheetWindow/";
  const labels = {
    outgoing: "UI/InfoWindow/CanKill", incoming: "UI/InfoWindow/CanBeKilledBy",
    empty: root + "KillsTabs/NoKillRightsFound", time: root + "TimeRemaining", price: root + "ForSale",
    public: root + "AvailableToAll", limited: root + "AvailableToSpecific",
    sellPublic: root + "SellToPublic", sellCorp: root + "SellToMyCorporation", sellAlliance: root + "SellToMyAlliance", sellSpecific: root + "SellToSpecific",
    sell: root + "SellKillRight", apply: root + "SellKillRightBtn", available: root + "Availability", everyone: root + "Everyone",
    unlist: root + "MakeUnavailable", unlistPublic: root + "MakeUnavailableQuestionAll", unlistLimited: root + "MakeUnavailableQuestion",
    search: "UI/Station/BountyOffice/SearchForUser", noOwner: "UI/Station/BountyOffice/NoOneFound",
    online: "UI/Common/Online", offline: "UI/Common/Offline", blocked: "UI/PeopleAndPlaces/Blocked",
  } as const;
  function word(label: keyof typeof labels, fallback: string, values: Record<string, string> = {}): string {
    const template = $words.templates[labels[label]];
    return template ? plainText(formatTemplate(template, values, { nameOf: (_kind, id) => owner(id) })).trim() || fallback : fallback;
  }
  const owner = (id: number): string => resolvedName($names.resolved, "owner", id, "Unknown owner");
  function info(id: number): void {
    showInfo(isCorporationOwner(id) ? { kind: "corporation", corporationID: id }
      : isAllianceOwner(id) ? { kind: "alliance", allianceID: id } : { kind: "character", characterID: id });
  }

  type Availability = "public" | "corporation" | "alliance" | "specific";
  type Draft = { right: KillRight; mode: Availability; recipient: number | null };
  const groups = [{ mine: true, word: "outgoing", fallback: "Can Kill" }, { mine: false, word: "incoming", fallback: "Can Be Killed By" }] as const;
  let rows = $state.raw<readonly KillRight[] | null>(null);
  let error = $state("");
  let menu = $state<number | null>(null);
  let now = $state(Date.now());
  let revision = 0;
  let contacts = $state.raw<AddressBook | null>(null);
  let contactRead = 0;
  const active = $derived((rows ?? []).filter(right => right.expiryTime !== null && right.expiryTime > unixMsToFiletime(now)));
  let draft = $state<Draft | null>(null);
  let withdrawal = $state<KillRight | null>(null);
  let dialog = $state<HTMLDialogElement>();
  let amount = $state("0");
  let query = $state("");
  let candidates = $state.raw<readonly { id: number; name: string }[]>([]);
  let selected = $state<{ id: number; name: string } | null>(null);
  let busy = $state(false);
  let actionError = $state("");
  const price = $derived(/^\d+$/.test(amount.trim()) && Number(amount) <= 100_000_000_000 ? Number(amount) : null);

  async function refresh(): Promise<void> {
    const request = ++revision;
    try {
      const next = await flow.myKillRights();
      if (request === revision) {
        rows = next;
        error = "";
        if (next.length && contacts === null && contactRead === 0) void refreshContacts();
      }
    } catch (cause) { if (request === revision) error = panelErrorWords(cause); }
  }

  async function refreshContacts(): Promise<void> {
    const request = ++contactRead;
    try {
      const book = await flow.killRightContacts();
      if (request !== contactRead) return;
      contacts = book;
      if (book.contacts.some(contact => contact.inWatchlist)) await flow.primeContactsOnline();
    } catch {
      // Rights are still readable while the address book is unavailable.
    }
  }

  function status(id: number): "online" | "offline" | "blocked" | null {
    if (contacts?.blocked.includes(id)) return "blocked";
    if (!contacts?.contacts.some(contact => contact.contactID === id && contact.inWatchlist)) return null;
    const online = $addressBook.online?.[id];
    return typeof online === "boolean" ? online ? "online" : "offline" : null;
  }

  function keyboardMenu(event: KeyboardEvent, id: number): void {
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) openOwnerMenu?.(event, id);
  }

  onMount(() => {
    flow.requestWords(Object.values(labels));
    flow.loadImageServer();
    const unsub = flow.killRightsChanged.subscribe(() => { void refresh(); });
    const uncontact = flow.contactStandingsChanged.subscribe(() => { if (rows?.length) void refreshContacts(); });
    const seen = new WeakSet<object>(store.live.get().notifications);
    const unlive = store.live.subscribe(state => {
      let changed = false;
      for (const notice of state.notifications) {
        if (seen.has(notice)) continue;
        seen.add(notice);
        if (notice.method === "OnBlockContacts" || notice.method === "OnUnblockContacts") changed = true;
      }
      if (changed && rows?.length) void refreshContacts();
    });
    const timer = setInterval(() => { now = Date.now(); }, 15_000);
    return () => { ++revision; ++contactRead; unsub(); uncontact(); unlive(); clearInterval(timer); };
  });

  function timeLeft(expiry: bigint | null): string {
    const minutes = Math.max(0, Number(((expiry ?? 0n) - unixMsToFiletime(now)) / 600000000n));
    const units = [[Math.floor(minutes / 1440), "d"], [Math.floor(minutes / 60) % 24, "h"], [minutes % 60, "m"]] as const;
    return units.filter(([value]) => value > 0).map(([value, unit]) => value + unit).join(" ") || "< 1m";
  }

  async function openSale(right: KillRight, mode: Availability, recipient: number | null): Promise<void> {
    menu = null;
    actionError = "";
    amount = "0";
    query = "";
    selected = null;
    candidates = [];
    draft = { right, mode, recipient };
    if (recipient !== null) flow.requestNames([{ kind: "owner", id: recipient }]);
    await tick();
    dialog?.showModal();
  }

  async function openWithdrawal(right: KillRight): Promise<void> {
    menu = null;
    actionError = "";
    withdrawal = right;
    await tick();
    dialog?.showModal();
  }

  async function search(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const text = query.trim(), current = draft;
    if (!text || busy || !current) return;
    actionError = "";
    busy = true;
    try {
      const results = await flow.searchOwners(text, [2, 3, 4], 0);
      if (draft !== current || query.trim() !== text) return;
      candidates = [...results.values()].flat();
      selected = candidates.length === 1 ? candidates[0]! : null;
      if (!candidates.length) actionError = word("noOwner", "No one found");
    } catch (cause) { actionError = panelErrorWords(cause); }
    finally { busy = false; }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const sell = draft, cancel = withdrawal;
    if (!cancel && (!sell || price === null || (sell.mode === "specific" && !selected))) return;
    actionError = "";
    busy = true;
    try {
      if (cancel) await flow.withdrawKillRight(cancel.killRightID, cancel.toID);
      else if (sell && price !== null) await flow.listKillRight(sell.right.killRightID, price, selected?.id ?? sell.recipient);
      close();
    } catch (cause) { actionError = panelErrorWords(cause); }
    finally { busy = false; }
  }

  function close(): void { draft = null; withdrawal = null; }
  function clearRecipient(): void {
    if (draft) draft = { ...draft, mode: "specific", recipient: null };
    selected = null;
    candidates = [];
    query = "";
  }
</script>

<section class="kill-rights" data-kill-rights>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if rows === null && !error}
    <p role="status">Reading kill rights…</p>
  {:else if rows && !active.length}
    <p data-kill-rights-empty>{word("empty", "No kill rights found")}</p>
  {/if}
  {#each groups as group (group.word)}
    {@const rights = active.filter(right => (group.mine ? right.fromID : right.toID) === pilot?.characterID)}
    {#if rights.length}
      <h3>{word(group.word, group.fallback)}</h3>
      {#each rights as right (right.killRightID)}
        {@const other = group.mine ? right.toID : right.fromID}
        {@const badge = status(other)}
        <article data-kill-right={right.killRightID} data-mine={group.mine} oncontextmenu={(event) => openOwnerMenu?.(event, other)}>
          <button type="button" class="portrait" aria-label={"Show info for " + owner(other)} onclick={() => info(other)} onkeydown={event => keyboardMenu(event, other)}>
            <img width="64" height="64" alt="" src={portraitUrl($image, other, 64) ?? clientTexture(portraitDefaultPath(64))} />
            {#if badge}
              {@const caption = word(badge, badge[0]!.toUpperCase() + badge.slice(1))}
              <span class="presence" class:online={badge === "online"} class:offline={badge === "offline"}
                class:blocked={badge === "blocked"} data-kill-right-presence={badge} title={caption} aria-label={caption}
                style:--presence-icon={"url(" + clientTexture("res:/UI/Texture/classes/Chat/" + (badge === "blocked" ? "Blocked.png" : "Status.png")) + ")"}></span>
            {/if}
          </button>
          <div class="description">
            <button type="button" class="link" onclick={() => info(other)} onkeydown={event => keyboardMenu(event, other)}>{owner(other)}</button>
            <span class="time">{word("time", "Time remaining " + timeLeft(right.expiryTime), { timeRemaining: timeLeft(right.expiryTime) })}</span>
            {#if right.price !== null}
              {#if Number(right.price) > 0}<div data-kill-right-price>{word("price", "For sale " + formatWholeIsk(right.price, "round"), { amount: formatWholeIsk(right.price, "round") })}</div>{/if}
              <div data-kill-right-availability>
                {#if right.restrictedTo !== null}
                  <button type="button" class="link" onclick={() => info(right.restrictedTo!)}>{word("limited", "Available to " + owner(right.restrictedTo), { entityName: owner(right.restrictedTo) })}</button>
                {:else}{word("public", "Available to everyone")}{/if}
              </div>
            {/if}
          </div>
          {#if group.mine}
            <div class="actions">
              <button type="button" aria-label={"Kill right actions for " + owner(other)} aria-expanded={menu === right.killRightID}
                onclick={() => { menu = menu === right.killRightID ? null : right.killRightID; }}>⋯</button>
              {#if menu === right.killRightID}
                <div class="menu">
                  {#if right.price === null}
                    <button type="button" onclick={() => openSale(right, "public", null)}>{word("sellPublic", "Make available to everyone")}</button>
                    {#if pilot?.corporationID}<button type="button" onclick={() => openSale(right, "corporation", pilot!.corporationID)}>{word("sellCorp", "Make available to my corporation")}</button>{/if}
                    {#if pilot?.allianceID}<button type="button" onclick={() => openSale(right, "alliance", pilot!.allianceID!)}>{word("sellAlliance", "Make available to my alliance")}</button>{/if}
                    <button type="button" onclick={() => openSale(right, "specific", null)}>{word("sellSpecific", "Make available to a specific entity")}</button>
                  {:else}
                    <button type="button" onclick={() => openWithdrawal(right)}>{word("unlist", "Make unavailable")}</button>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </article>
      {/each}
    {/if}
  {/each}
</section>

{#if draft || withdrawal}
  <dialog bind:this={dialog} data-window={withdrawal ? "KillRightWithdrawal" : "SellKillRightWnd"}
    aria-label={withdrawal ? word("unlist", "Make Unavailable") : word("sell", "Sell Kill Right")}
    oncancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <h2>{withdrawal ? word("unlist", "Make Unavailable") : word("sell", "Sell Kill Right")}</h2>
    {#if withdrawal}
      <p>{withdrawal.restrictedTo === null ? word("unlistPublic", "Make this kill right unavailable to everyone?")
        : word("unlistLimited", "Make this kill right unavailable to " + owner(withdrawal.restrictedTo) + "?", { entityName: owner(withdrawal.restrictedTo) })}</p>
    {:else if draft}
      <strong>{word("available", "Availability")}</strong>
      {#if draft.mode === "public"}<p>{word("everyone", "Everyone")}</p>
      {:else if draft.recipient !== null || selected}
        <p>{draft.recipient !== null ? owner(draft.recipient) : selected?.name} <button type="button" disabled={busy} onclick={clearRecipient}>Clear</button></p>
      {:else}
        <form class="search" onsubmit={search}>
          <input aria-label={word("search", "Search for owner")} maxlength="32" bind:value={query} />
          <button type="submit" disabled={busy || !query.trim()}>Search</button>
        </form>
        {#if candidates.length > 1}
          <div class="owners">
            {#each candidates as candidate (candidate.id)}
              <button type="button" onclick={() => { selected = candidate; }}>{candidate.name}</button>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}
    {#if actionError}<p role="alert">{actionError}</p>{/if}
    <form class="footer" onsubmit={submit}>
      {#if draft}<label>ISK <input inputmode="numeric" maxlength="12" bind:value={amount} /></label>{/if}
      <button type="button" disabled={busy} onclick={close}>{withdrawal ? "No" : "Cancel"}</button>
      <button type="submit" disabled={busy || Boolean(draft && (price === null || (draft.mode === "specific" && !selected)))}>
        {withdrawal ? "Yes" : word("apply", "Make Available")}
      </button>
    </form>
  </dialog>
{/if}

<style>
  h3 { padding: 6px 8px; margin: 0; background: var(--color-panel); }
  article { min-height: 68px; display: flex; align-items: center; padding: 2px 8px; gap: 8px; border-bottom: 1px solid var(--color-line); }
  .description { flex: 1; min-width: 0; }
  .portrait { position: relative; padding: 0; border: 0; background: none; flex-shrink: 0; }
  .portrait img { display: block; }
  .presence { position: absolute; left: 2px; top: 3px; width: 10px; height: 10px; mask: var(--presence-icon) center / contain no-repeat; }
  .presence.online { background: #00bf00; }
  .presence.offline { background: #bf0000; }
  .presence.blocked { background: white; }
  .link { padding: 0; border: 0; background: none; text-decoration: underline; color: var(--color-accent); }
  .time { margin-left: 6px; }
  .actions { position: relative; }
  .menu { position: absolute; z-index: 2; right: 0; min-width: 206px; display: grid; background: var(--color-panel); border: 1px solid var(--color-line); }
  .menu button { text-align: left; }
  dialog { width: min(350px, calc(100vw - 2rem)); color: var(--color-text); background: var(--color-panel); border: 1px solid var(--color-line); }
  h2 { margin: 0 0 12px; font-size: 16px; }
  .search, .footer { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }
  .search input, .footer input { width: 100%; min-width: 0; }
  .footer label { display: flex; align-items: center; gap: 4px; margin-right: auto; min-width: 0; }
  .owners { display: grid; max-height: 140px; overflow: auto; }
</style>
