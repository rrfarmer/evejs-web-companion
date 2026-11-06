<script lang="ts">
  // THE PILOT HANGAR — the first screen of the app.
  //
  // What it replaced: one flat list of every character the tab had ever seen,
  // with a login panel under it. That works at three pilots. At fifty it is a
  // wall of identical rows with no structure at all — you scroll past four
  // accounts to find one hauler, and nothing on screen says which pilots belong
  // to the same operation.
  //
  // So this screen does three things the list could not:
  //   • GROUPS BY ACCOUNT. The one grouping the server actually knows about, and
  //     the one that matches how a multiboxer signs in.
  //   • ADDS SQUADS. A second, cross-account grouping the player makes — a
  //     mining op, a scout net — brought online in one click. Squads live only
  //     in this browser (app/hangarPrefs.ts); the server has no idea.
  //   • SHOWS ENOUGH TO CHOOSE. Wallet, skill points, where the pilot is and what
  //     it is training, without bringing it online first. All four come from the
  //     roster (app/knownCharacters.ts), refreshed on mount by a throwaway
  //     sign-in per account (app/rosterRefresh.ts).
  //
  // WHAT THIS FILE OWNS: the screen's own transient state — the search box, the
  // scope chip, the selection, which popover is open, manage mode, and the
  // launch queue. Persisted arrangement goes straight through to hangarPrefs;
  // every filter, sort, count and formatted string is computed in app/hangar.ts,
  // which is pure and tested. Nothing here fetches, and nothing here creates a
  // session: `onLaunch` hands that to App, which owns the multibox roster.
  //
  // "Bring online" means the web client opens that pilot's interface. Several
  // pilots are live in the one tab at once; the switcher between them is the
  // character bar, and is not this screen's business.
  import HangarPilotRow from "./HangarPilotRow.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { pluginSquadControls } from "./pluginHangarViews.ts";
  import { untrack } from "svelte";
  import HangarLoginDialog from "./HangarLoginDialog.svelte";
  import HangarAddCharacter from "./HangarAddCharacter.svelte";
  import HangarSquadEditor from "./HangarSquadEditor.svelte";
  import HangarSquadPicker from "./HangarSquadPicker.svelte";
  import HangarSquadAssign from "./HangarSquadAssign.svelte";
  import HangarLaunchProgress from "./HangarLaunchProgress.svelte";
  import {
    loadKnownCharacters,
    loadKnownAccounts,
    forgetKnownCharacter,
    forgetKnownAccount,
    type KnownCharacter,
  } from "../app/knownCharacters.ts";
  import {
    loadHangarPrefs,
    saveHangarPrefs,
    addSquad,
    addSquadMembers,
    deleteSquad,
    forgetPilots,
    nextSquadColor,
    nextSquadId,
    squadMemberCount,
    toggleCollapsedAccount,
    togglePinnedPilot,
    togglePinnedSquad,
    toggleSquadMember,
    updateSquad,
    type HangarPrefs,
    type Squad,
  } from "../app/hangarPrefs.ts";
  import {
    groupByAccount,
    pilotCountLabel,
    scopeLabel,
    selectionDetail,
    selectionLabel,
    toHangarPilots,
    totalsLabel,
    visiblePilots,
    MAX_SLOTS,
    type HangarPilot,
    type HangarScope,
  } from "../app/hangar.ts";
  import {
    launchFinished,
    newQueue,
    withEntryState,
    type LaunchEntry,
    type LaunchTarget,
  } from "../app/hangarLaunch.ts";
  import { refreshRoster } from "../app/rosterRefresh.ts";
  import {
    listActiveServerBots,
    type ActiveServerBot,
    type ApiOptions,
  } from "../app/api.ts";
  import { stopServerBotFor } from "../app/stopBotFor.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import GlobalLaunchers from "./GlobalLaunchers.svelte";
  import type { TabID } from "./tabs.ts";
  import type { Session } from "../app/sessions.ts";

  let {
    onlineIDs = new Set<number>(),
    sessionFor = () => undefined,
    onLaunch,
    onShowPilot,
    onClose = null,
    optionsFor = () => null,
    onHandedOver = async () => {},
    globalOpenIds = new Set<TabID>(),
    onOpenGlobal,
  }: {
    /** The global windows open right now, so their doors light up. */
    globalOpenIds?: ReadonlySet<TabID>;
    /**
     * Open a global window — Bot Manager, Planetary Industry, a plugin's —
     * over this screen. They are about every pilot, so they open here with
     * nobody in the client just as they do over a cockpit. Absent in tests and
     * harnesses, which then draw no doors.
     */
    onOpenGlobal?: (id: TabID) => void;
    /** Character IDs already in the client, from App's live session list. */
    onlineIDs?: Set<number>;
    /** The session flying a pilot in the client, for the place it is in now (HangarPilotRow.svelte). */
    sessionFor?: (characterID: number) => Session | undefined;
    /**
     * The token a call about THIS pilot must ride (R107 multibox), or NULL when
     * no session in this tab is flying it.
     *
     * ⚠ WITHOUT IT A SQUAD START SPEAKS FOR ONE ACCOUNT AND REFUSES THE REST.
     * Every pilot in this tab has its OWN session token; a call made with no
     * options falls back to the per-tab cookie, which names exactly one of them.
     * A squad whose pilots sit on different accounts then reaches the gateway as
     * the wrong owner and comes back "Character does not belong to the supplied
     * account" for every member but one — and that one is refused too, with
     * "A web session is flying this character", because `/api/bots/start`
     * hands over the CALLER's held session and the caller was somebody else.
     *
     * ⚠ NULL IS A DIFFERENT ANSWER FROM AN EMPTY OPTIONS OBJECT, which is why
     * this returns one. A pilot with no session here has no hull to hand over
     * and no token to borrow, so the start signs in as that pilot's own account
     * for the length of the call instead of riding
     * whatever the tab happens to be.
     */
    optionsFor?: (characterID: number) => ApiOptions | null;
    /**
     * Catch this tab's own UI up after the host took a hull a session here held.
     *
     * ⚠ NOT THE HANDOVER — `/api/bots/start` already did that, atomically, as
     * part of the start. A failure here is not a failed start: the bot has the
     * hull either way, and the tab's next read notices.
     */
    onHandedOver?: (characterID: number) => Promise<void>;
    /**
     * Bring these pilots online, reporting each one as it lands. App owns the
     * session roster, so it owns this; the hangar only says who.
     */
    onLaunch: (
      targets: readonly LaunchTarget[],
      onProgress: (characterID: number, state: LaunchEntry["state"], note?: string) => void,
    ) => Promise<void>;
    /**
     * Leave the hangar showing one pilot's cockpit. Used by the launch dialog's
     * "go to first pilot", and by clicking a pilot that is ALREADY in the
     * client — for that pilot there is nothing to launch, so the row's job is to
     * take you to it instead of doing nothing at all.
     */
    onShowPilot: (characterID: number) => void;
    /**
     * Leave the hangar without launching anything. Null when the hangar IS the
     * screen (no pilot is online yet) and there is nowhere to go back to.
     */
    onClose?: (() => void) | null;
  } = $props();

  // --- persisted state, read once and written back on every edit -------------

  let known = $state<KnownCharacter[]>(loadKnownCharacters());
  // Re-read whenever `known` is: every path that records or forgets an account
  // (sign-in, refresh, remove) already reassigns `known` straight after.
  const knownAccounts = $derived.by(() => {
    void known;
    return loadKnownAccounts();
  });
  let prefs = $state<HangarPrefs>(loadHangarPrefs());

  function commit(next: HangarPrefs): void {
    prefs = next;
    saveHangarPrefs(next);
  }

  // --- screen state ----------------------------------------------------------

  let query = $state("");
  let scope = $state<HangarScope>({ kind: "all" });
  let selected = $state<Set<number>>(new Set());
  let manage = $state(false);
  let pickerOpen = $state(false);
  let squadMenuFor = $state<number | null>(null);
  /**
   * The squad the editor is open on. When `editingIsNew` it is a DRAFT that does
   * not exist in `prefs` yet — cancelling one is genuinely free, because there is
   * nothing to undo.
   */
  let editing = $state<Squad | null>(null);
  let editingIsNew = $state(false);
  /** "Save as squad" is open: pick an existing squad, or describe a new one. */
  let assigning = $state(false);
  let loginOpen = $state(false);
  /** The account whose empty slot was clicked, i.e. "put a pilot in here". */
  let addingTo = $state<string | null>(null);
  let queue = $state<LaunchEntry[]>([]);
  let launching = $state(false);

  // The clock the "4d 6h" countdowns are measured against. Re-read once a minute
  // so a hangar left open does not sit there claiming a skill finishes in six
  // hours all evening; a minute is as fine as the coarsest unit it prints.
  let now = $state(Date.now());
  $effect(() => {
    const handle = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(handle);
  });

  // Below 760px a tap on a pilot SELECTS rather than launching. Mis-tap
  // protection: on a phone the row is the only comfortable target on it, and an
  // accidental brush must not sign a pilot in. The selection bar's "Bring
  // online ▶" is the deliberate action there.
  let tapSelects = $state(false);
  $effect(() => {
    const media = globalThis.matchMedia?.("(max-width: 759px)");
    if (!media) return;
    tapSelects = media.matches;
    const onChange = (event: MediaQueryListEvent): void => {
      tapSelects = event.matches;
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  });

  // --- the rows --------------------------------------------------------------

  const pilots = $derived(toHangarPilots(known, prefs, onlineIDs, now));
  const visible = $derived(visiblePilots(pilots, scope, query));
  const padSlots = $derived(scope.kind === "all" && query.trim().length === 0);
  const accounts = $derived(
    groupByAccount(visible, { padSlots, accounts: knownAccounts }),
  );
  const knownIDs = $derived(new Set(known.map((row) => row.characterID)));
  const selectedPilots = $derived(pilots.filter((p) => selected.has(p.characterID)));
  const onlineCount = $derived(pilots.filter((p) => p.online).length);
  const idleCount = $derived(pilots.filter((p) => p.training === null).length);
  // EVERY squad is on the chip row, beside "All pilots" / "Not training" / "In
  // client". It used to be only the pinned ones, which meant a fresh install —
  // where nothing is pinned — could reach its squads solely through the "All
  // squads ▼" dropdown, i.e. the feature was invisible to anyone who had not
  // already found the picker. Pinning now decides ORDER, not existence: pinned
  // squads lead, the rest follow in the order they were made. The picker stays
  // for searching, pinning and editing once the row is long.
  const chipSquads = $derived([
    ...prefs.squads.filter((s) => prefs.pinnedSquads.includes(s.id)),
    ...prefs.squads.filter((s) => !prefs.pinnedSquads.includes(s.id)),
  ]);

  // --- refresh on mount ------------------------------------------------------
  //
  // The roster is a snapshot from the last sign-in, so a hangar opened cold shows
  // yesterday's wallets and locations. Re-read every account, one at a time, and
  // repaint each as it lands. Best-effort throughout: an account that fails keeps
  // the rows it already had, because a landing screen that empties itself when a
  // read fails is worse than one showing a slightly stale figure.
  let refreshStarted = false;
  $effect(() => {
    if (refreshStarted) return;
    refreshStarted = true;
    // Accounts with no pilots are refreshed too: a pilot made on one elsewhere
    // shows up here on the next open.
    const accountNames = loadKnownAccounts();
    if (accountNames.length === 0) {
      // First run: nothing to refresh, and nothing to look at either — open the
      // login straight away rather than leaving the player on an empty page
      // hunting for the way in.
      loginOpen = true;
      return;
    }
    void refreshRoster(accountNames, () => {
      known = loadKnownCharacters();
    });
  });

  // --- server bots ------------------------------------------------------------
  //
  // ⚠ THIS IS THE SCREEN A PLAYER COMES BACK TO. A server bot keeps flying with
  // the tab shut (src/botHost.js), so the hangar is the first thing they see
  // afterwards — and it used to say nothing about bots at all. Worse than
  // silent: the BFF refuses to select a bot-flown character
  // (CHARACTER_IN_USE_BY_BOT), so the row was a refusal with no remedy printed
  // on it, and a browser whose pilots were ALL bot-flown had no reachable Stop
  // anywhere on it. The one Stop that existed was on the "Add character"
  // overlay, which you have to already know to go looking for.
  //
  // The read is /api/bots/active — unauthenticated by design, because this
  // screen exists before any sign-in; it carries each bot's phase and the
  // host's ~15s ship-vitals sample. Stopping DOES need auth and is
  // app/stopBotFor.ts's job.
  let botStatuses = $state<Map<number, ActiveServerBot>>(new Map());
  let botPollAlive = true;

  async function refreshBotFlown(): Promise<void> {
    try {
      const rows = await listActiveServerBots({ priority: "poll" });
      if (botPollAlive) botStatuses = new Map(rows.map((row) => [row.characterID, row]));
    } catch {
      // Keep the last known rows and let the next poll retry: a landing screen
      // that blinks its markers off because one read failed is worse than one
      // showing a marker a few seconds stale.
    }
  }

  $effect(() => {
    // Guarded, like every periodic read in the client — see app/skipWhileBusy.ts.
    const beat = skipWhileBusy(refreshBotFlown);
    void beat();
    const handle = setInterval(() => void beat(), 5000);
    return () => {
      botPollAlive = false;
      clearInterval(handle);
    };
  });

  const botFlownCount = $derived(pilots.filter((p) => botStatuses.has(p.characterID)).length);

  /** The pilot whose bot a stop is in flight for — one stop at a time. */
  let stoppingID = $state<number | null>(null);
  let botError = $state("");

  async function stopBot(pilot: HangarPilot): Promise<void> {
    if (stoppingID !== null) return;
    stoppingID = pilot.characterID;
    botError = "";
    try {
      await stopServerBotFor(pilot.accountName, pilot.characterID);
    } catch (cause) {
      botError = `Could not stop the bot flying ${pilot.name} — ${panelErrorWords(cause)}`;
    } finally {
      stoppingID = null;
    }
    // Repaint from the server either way: a stop that threw on the way back may
    // still have landed, and a run that had already ended on its own has to
    // stop being marked.
    await refreshBotFlown();
  }

  // --- selection -------------------------------------------------------------

  function toggleSelected(characterID: number): void {
    const next = new Set(selected);
    if (next.has(characterID)) next.delete(characterID);
    else next.add(characterID);
    selected = next;
  }

  function setAccountSelected(account: readonly HangarPilot[], on: boolean): void {
    const next = new Set(selected);
    for (const pilot of account) {
      if (on) next.add(pilot.characterID);
      else next.delete(pilot.characterID);
    }
    selected = next;
  }

  function accountAllSelected(account: readonly HangarPilot[]): boolean {
    return account.length > 0 && account.every((p) => selected.has(p.characterID));
  }

  // --- launching -------------------------------------------------------------

  function targetsFor(list: readonly HangarPilot[]): LaunchTarget[] {
    // A pilot already in the client is not launched again — selecting a whole
    // squad when two of it are up must bring the other four, not fail twice.
    return list
      .filter((p) => !p.online)
      .map((p) => ({
        accountName: p.accountName,
        characterID: p.characterID,
        characterName: p.name,
      }));
  }

  /**
   * The account to speak as for a pilot with no session in this tab.
   *
   * Read from the remembered roster, which is where the launch path and the
   * Stop control both get it (`targetsFor`, `stopServerBotFor`) — a pilot this
   * screen can show is a pilot this browser has signed in at least once, so the
   * name is there. An empty string is the honest miss: the server then refuses
   * the login and that pilot's row carries the refusal, which beats guessing an
   * account and starting a bot on the wrong one.
   */
  function accountNameFor(characterID: number): string {
    return known.find((row) => row.characterID === characterID)?.accountName ?? "";
  }

  // What a plugin's squad control has to say, under the squads (pluginHangarViews.ts).
  let pluginSquadLines = $state.raw<ReadonlyMap<string, readonly string[]>>(new Map());
  function sayForPlugin(pluginID: string, lines: readonly string[] | null): void {
    // Untracked: a control may say this from an effect, which must not then depend on what it writes.
    const next = new Map(untrack(() => pluginSquadLines));
    if (lines === null) next.delete(pluginID);
    else next.set(pluginID, lines);
    pluginSquadLines = next;
  }

  function pilotNameFor(characterID: number): string {
    return pilots.find((pilot) => pilot.characterID === characterID)?.name ?? "Unknown pilot";
  }

  async function launch(list: readonly HangarPilot[]): Promise<void> {
    if (manage || launching) return;
    const targets = targetsFor(list);
    if (targets.length === 0) return;
    queue = newQueue(targets);
    launching = true;
    closePopovers();
    try {
      await onLaunch(targets, (characterID, state, note) => {
        queue = withEntryState(queue, characterID, state, note);
      });
    } finally {
      launching = false;
      // Whatever came online is online now; drop the selection so the bar does
      // not keep offering to launch pilots that are already up.
      selected = new Set();
    }
  }

  function squadPilots(squadID: string): HangarPilot[] {
    return pilots.filter((p) => p.squads.some((s) => s.id === squadID));
  }

  function closeLaunchDialog(): void {
    queue = [];
  }

  function goToFirst(): void {
    const first = queue.find((entry) => entry.state === "online");
    queue = [];
    if (first) onShowPilot(first.characterID);
  }

  /**
   * What clicking a pilot row does. A pilot that is not in the client comes
   * online; one that already is takes you to its cockpit. Before this the second
   * case fell through `launch`'s "already online" filter and the row was simply
   * dead — with a pilot up and the hangar still open there was no way back into
   * the client except the header.
   */
  function activatePilot(pilot: HangarPilot): void {
    if (pilot.online) onShowPilot(pilot.characterID);
    else void launch([pilot]);
  }

  // --- popovers --------------------------------------------------------------

  function closePopovers(): void {
    pickerOpen = false;
    squadMenuFor = null;
  }

  function toggleManage(): void {
    manage = !manage;
    selected = new Set();
    closePopovers();
  }

  // --- squads ----------------------------------------------------------------
  //
  // NOTHING HERE WRITES UNTIL THE PLAYER CONFIRMS. Both dialogs used to be opened
  // on a squad that had already been created, so cancelling either one left a
  // "New squad 3" on the chip row that the player never asked for. A new squad is
  // now a DRAFT — a Squad value with an id, held in `editing` and never committed
  // — and it becomes real in `saveSquadEdit`, on Save, or not at all.

  function draftSquad(): Squad {
    return {
      id: nextSquadId(),
      name: `New squad ${prefs.squads.length + 1}`,
      color: nextSquadColor(prefs),
    };
  }

  /** "+ New squad" in the picker: an empty draft, named and saved or dropped. */
  function newSquad(): void {
    editing = draftSquad();
    editingIsNew = true;
    closePopovers();
  }

  /**
   * Open the editor on an existing squad — the only route to Delete.
   *
   * It hung off the chips' manage mode alone, which meant deleting a squad was
   * reachable only by pressing Manage and noticing that "▶ ALL" had quietly
   * become "edit". The picker offers it too now: it already lists every squad by
   * name and is where you go when the chip row is long.
   */
  function editSquad(squad: Squad): void {
    editing = squad;
    editingIsNew = false;
    closePopovers();
  }

  function saveSquadEdit(patch: { name: string; color: string }): void {
    if (!editing) return;
    // A draft has no entry in prefs yet, so saving it is an add, not an update.
    commit(
      editingIsNew
        ? addSquad(prefs, { ...editing, ...patch })
        : updateSquad(prefs, editing.id, patch),
    );
    closeSquadEditor();
  }

  function removeSquad(): void {
    if (!editing) return;
    const id = editing.id;
    commit(deleteSquad(prefs, id));
    closeSquadEditor();
    if (scope.kind === "squad" && scope.value === id) scope = { kind: "all" };
  }

  function closeSquadEditor(): void {
    editing = null;
    editingIsNew = false;
  }

  // "Save as squad" on the selection bar. It only OPENS the chooser; the squad
  // is created, or the selection added to an existing one, in `assignSquad`.
  function openSquadAssign(): void {
    if (selectedPilots.length === 0) return;
    assigning = true;
    closePopovers();
  }

  function assignSquad(
    choice: { kind: "existing"; squadID: string } | { kind: "new"; name: string; color: string },
  ): void {
    const memberIDs = selectedPilots.map((p) => p.characterID);
    if (choice.kind === "existing") {
      commit(addSquadMembers(prefs, choice.squadID, memberIDs));
    } else {
      commit(
        addSquad(prefs, { ...draftSquad(), name: choice.name, color: choice.color }, memberIDs),
      );
    }
    assigning = false;
    selected = new Set();
  }

  // --- manage-mode removals --------------------------------------------------
  //
  // Local only: forgetting a pilot drops it from THIS browser's roster. Nothing
  // is deleted on the server, and signing the account in again brings it back.

  function removePilot(characterID: number): void {
    forgetKnownCharacter(characterID);
    known = loadKnownCharacters();
    commit(forgetPilots(prefs, [characterID]));
    const next = new Set(selected);
    next.delete(characterID);
    selected = next;
  }

  function removeAccount(accountName: string): void {
    const gone = forgetKnownAccount(accountName);
    known = loadKnownCharacters();
    commit(forgetPilots(prefs, gone));
    const next = new Set(selected);
    for (const id of gone) next.delete(id);
    selected = next;
  }

  function afterLogin(accountName: string): void {
    loginOpen = false;
    known = loadKnownCharacters();
    // A brand-new account arrives with no characters; say nothing about it here,
    // the empty slots under its header already do (its header comes from the
    // accounts list, app/knownCharacters.ts, not from its pilots).
    void accountName;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- Over a live client (onClose given) the character bar is drawn above the hangar, so the hangar starts below it. -->
<div class="hangar" class:under-char-bar={onClose !== null} onclick={closePopovers}>
  <header class="hangar-head">
    <div class="hangar-brand">
      <span class="hangar-wordmark">EveJS Web</span>
      {#if onOpenGlobal}
        <GlobalLaunchers openIds={globalOpenIds} onOpen={onOpenGlobal} />
      {/if}
    </div>

    <div class="hangar-search">
      <span class="hangar-search-slash" aria-hidden="true">/</span>
      <input
        type="search"
        aria-label="Filter pilots, ships, systems"
        placeholder="Filter pilots, ships, systems"
        bind:value={query}
      />
      <span class="hangar-match">{visible.length}/{pilots.length}</span>
    </div>

    <div class="hangar-head-actions">
      <a class="hangar-manage" href="/pilot-training" target="_blank" rel="noopener">Pilot Training</a>
      <button
        type="button"
        class="hangar-manage"
        class:is-on={manage}
        aria-pressed={manage}
        onclick={toggleManage}
      >{manage ? "Done" : "Manage"}</button>
      <button type="button" class="hangar-add" onclick={() => (loginOpen = true)}>
        + Add account
      </button>
      {#if onClose}
        <!-- The way back into the client. Labelled for where it GOES, not for
             what it undoes: with pilots already up, "Back" gave no hint that
             the cockpit was still there behind the hangar. -->
        <button type="button" class="hangar-manage is-exit" onclick={onClose}>
          ◀ To client
        </button>
      {/if}
    </div>
  </header>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="hangar-chiprow" onclick={(event) => event.stopPropagation()}>
    <div class="hangar-chip" class:is-on={scope.kind === "all"}>
      <button
        type="button"
        class="hangar-chip-select"
        onclick={() => (scope = { kind: "all" })}
      >
        <span class="hangar-chip-name">All pilots</span>
        <span class="hangar-chip-count">{pilots.length}</span>
      </button>
    </div>

    <div
      class="hangar-chip"
      class:is-on={scope.kind === "idle"}
      style:border-color={scope.kind === "idle" ? "#4a3a16" : undefined}
    >
      <button type="button" class="hangar-chip-select" onclick={() => (scope = { kind: "idle" })}>
        <span class="hangar-swatch" style:background="#e0b155"></span>
        <span class="hangar-chip-name">Not training</span>
        <span class="hangar-chip-count">{idleCount}</span>
      </button>
    </div>

    <div
      class="hangar-chip"
      class:is-on={scope.kind === "online"}
      style:border-color={scope.kind === "online" ? "#1e5c45" : undefined}
    >
      <button type="button" class="hangar-chip-select" onclick={() => (scope = { kind: "online" })}>
        <span class="hangar-swatch" style:background="#52d9a3"></span>
        <span class="hangar-chip-name">In client</span>
        <span class="hangar-chip-count">{onlineCount}</span>
      </button>
    </div>

    {#if chipSquads.length > 0}
      <span class="hangar-chip-divider" aria-hidden="true"></span>
    {/if}

    <!-- Every squad, pinned ones first. See `chipSquads`. -->
    {#each chipSquads as squad (squad.id)}
      {@const count = squadMemberCount(prefs, squad.id, knownIDs)}
      <div
        class="hangar-chip"
        class:is-on={scope.kind === "squad" && scope.value === squad.id}
        style:border-color={scope.kind === "squad" && scope.value === squad.id
          ? squad.color
          : undefined}
      >
        <button
          type="button"
          class="hangar-chip-select"
          onclick={() => (scope = { kind: "squad", value: squad.id })}
        >
          <span class="hangar-swatch" style:background={squad.color}></span>
          <span class="hangar-chip-name">{squad.name}</span>
          <span class="hangar-chip-count">{count}</span>
        </button>
        {#if manage}
          <button
            type="button"
            class="hangar-chip-edit"
            title="Rename, recolour or delete"
            onclick={() => editSquad(squad)}
          >edit</button>
        {:else}
          <button
            type="button"
            class="hangar-launch"
            title={`Bring all of ${squad.name} online`}
            onclick={() => launch(squadPilots(squad.id))}
          >▶ ALL</button>
          {#each pluginSquadControls() as control (control.pluginID)}
            <ErrorBoundary name={`${control.pluginID} on ${squad.name}`}>
              <control.view
                {squad}
                memberIDs={prefs.members[squad.id] ?? []}
                {pilotNameFor}
                {optionsFor}
                {accountNameFor}
                {onHandedOver}
                onChanged={() => void refreshBotFlown()}
                say={(lines) => sayForPlugin(control.pluginID, lines)}
              />
            </ErrorBoundary>
          {/each}
        {/if}
      </div>
    {/each}

    {#each [...pluginSquadLines] as [pluginID, lines] (pluginID)}
      <div class="hangar-squadstart">
        <!-- No key: a plugin may well say the same line twice, and a repeated key throws. -->
        {#each lines as line}
          <p class="note">{line}</p>
        {/each}
      </div>
    {/each}

    <!-- The picker is no longer the only way to a squad — every squad is a chip
         above. It is what the row needs once there are a dozen: search, the pin
         that decides which lead, and the "edit" that reaches Delete. -->
    <HangarSquadPicker
      squads={prefs.squads}
      {prefs}
      {knownIDs}
      open={pickerOpen}
      onToggleOpen={() => (pickerOpen = !pickerOpen)}
      onSelect={(squadID) => {
        scope = { kind: "squad", value: squadID };
        pickerOpen = false;
      }}
      onTogglePin={(squadID) => commit(togglePinnedSquad(prefs, squadID))}
      onLaunch={(squadID) => launch(squadPilots(squadID))}
      onEdit={editSquad}
      onNew={newSquad}
    />
  </div>

  <div class="hangar-summary">
    <span>{scopeLabel(scope, prefs.squads)}</span>
    <span class="hangar-summary-bar" aria-hidden="true">|</span>
    <span>{totalsLabel(visible, pilots)}</span>
    {#if botFlownCount > 0}
      <span class="hangar-summary-bar" aria-hidden="true">|</span>
      <span class="hangar-summary-bots">
        {botFlownCount === 1 ? "1 pilot" : `${botFlownCount} pilots`} flown by a server bot — Stop is on the row
      </span>
    {/if}
    {#if manage}
      <span class="hangar-summary-manage">
        manage mode — remove pilots, remove accounts, assign squads
      </span>
    {/if}
  </div>

  {#if botError}
    <p class="hangar-boterror" role="alert">{botError}</p>
  {/if}

  <main class="hangar-grid" class:has-selection={selectedPilots.length > 0}>
    {#each accounts as account (account.name)}
      {@const collapsed = prefs.collapsedAccounts.includes(account.name)}
      <article class="hangar-account">
        <div class="hangar-account-head">
          {#if !manage}
            <input
              type="checkbox"
              checked={accountAllSelected(account.pilots)}
              aria-label={`Select every pilot in ${account.name}`}
              onchange={() =>
                setAccountSelected(account.pilots, !accountAllSelected(account.pilots))}
            />
          {/if}
          <button
            type="button"
            class="hangar-caret"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Show ${account.name}` : `Hide ${account.name}`}
            onclick={() => commit(toggleCollapsedAccount(prefs, account.name))}
          >{collapsed ? "▶" : "▼"}</button>
          <span class="hangar-account-name">{account.name}</span>
          <span class="hangar-account-count">{pilotCountLabel(account.pilots.length)}</span>
          {#if !manage && account.pilots.length > 0}
            <button
              type="button"
              class="hangar-launch is-account"
              title={`Bring every pilot in ${account.name} online`}
              onclick={() => launch(account.pilots)}
            >▶ ALL</button>
          {:else if manage}
            <button
              type="button"
              class="hangar-remove"
              title={`Remove ${account.name} and its pilots from this list`}
              onclick={() => removeAccount(account.name)}
            >✕</button>
          {/if}
        </div>

        {#if !collapsed}
          <div class="hangar-pilots">
            {#each account.pilots as pilot (pilot.characterID)}
              <HangarPilotRow
                {pilot}
                session={pilot.online ? (sessionFor(pilot.characterID) ?? null) : null}
                {manage}
                {tapSelects}
                selected={selected.has(pilot.characterID)}
                bot={botStatuses.get(pilot.characterID) ?? null}
                stopping={stoppingID === pilot.characterID}
                stopBusy={stoppingID !== null}
                onStopBot={() => void stopBot(pilot)}
                squads={prefs.squads}
                squadMenuOpen={squadMenuFor === pilot.characterID}
                onActivate={() => activatePilot(pilot)}
                onToggleSelect={() => toggleSelected(pilot.characterID)}
                onTogglePin={() => commit(togglePinnedPilot(prefs, pilot.characterID))}
                onRemove={() => removePilot(pilot.characterID)}
                onToggleSquadMenu={() =>
                  (squadMenuFor = squadMenuFor === pilot.characterID ? null : pilot.characterID)}
                onToggleSquad={(squadID) =>
                  commit(toggleSquadMember(prefs, squadID, pilot.characterID))}
              />
            {/each}
            {#each { length: account.emptySlots } as _, index (index)}
              <button
                type="button"
                class="hangar-slot"
                onclick={() => (addingTo = account.name)}
              >
                <span>+ Add character</span>
                <span class="hangar-slot-count">
                  slot {account.pilots.length + index + 1}/{MAX_SLOTS}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </article>
    {/each}
  </main>

  {#if accounts.length === 0 && pilots.length === 0}
    <div class="hangar-empty-screen">
      <div class="hangar-empty-title">No pilots yet</div>
      <p class="hangar-empty-copy">
        Add an EveJS account and its pilots appear here, grouped by account.
      </p>
      <button type="button" class="hangar-empty-action" onclick={() => (loginOpen = true)}>
        Add your first account
      </button>
    </div>
  {/if}

  {#if selectedPilots.length > 0}
    <div class="hangar-selbar">
      <div class="hangar-selbar-text">
        <span class="hangar-selbar-count">{selectionLabel(selectedPilots.length)}</span>
        <span class="hangar-selbar-detail">{selectionDetail(selectedPilots)}</span>
      </div>
      <div class="hangar-selbar-spacer"></div>
      <button type="button" class="hangar-ghost" onclick={openSquadAssign}>
        Save as squad
      </button>
      <button type="button" class="hangar-ghost" onclick={() => (selected = new Set())}>
        Clear
      </button>
      <button type="button" class="hangar-primary" onclick={() => launch(selectedPilots)}>
        Bring online ▶
      </button>
    </div>
  {/if}
</div>

{#if queue.length > 0}
  <HangarLaunchProgress
    {queue}
    done={launchFinished(queue)}
    onGoToFirst={goToFirst}
    onStay={closeLaunchDialog}
  />
{/if}

{#if addingTo}
  <HangarAddCharacter
    accountName={addingTo}
    onClose={() => (addingTo = null)}
    onCreated={() => {
      addingTo = null;
      known = loadKnownCharacters();
    }}
  />
{/if}

{#if loginOpen}
  <HangarLoginDialog onClose={() => (loginOpen = false)} onAdded={afterLogin} />
{/if}

{#if editing}
  <!-- Keyed on the squad: opening a different one must reset the form, not
       leave the previous squad's name sitting in the field. -->
  {#key editing.id}
    <HangarSquadEditor
      squad={editing}
      isNew={editingIsNew}
      onSave={saveSquadEdit}
      onDelete={removeSquad}
      onCancel={closeSquadEditor}
    />
  {/key}
{/if}

{#if assigning && selectedPilots.length > 0}
  <HangarSquadAssign
    pilotCount={selectedPilots.length}
    squads={prefs.squads}
    {prefs}
    {knownIDs}
    suggestedName={`New squad ${prefs.squads.length + 1}`}
    suggestedColor={nextSquadColor(prefs)}
    onConfirm={assignSquad}
    onCancel={() => (assigning = false)}
  />
{/if}
