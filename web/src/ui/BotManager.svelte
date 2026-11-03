<script lang="ts">
  // BOT MANAGER — regions A, B and C (docs/bot-manager-brainstorm.md §4), plus
  // a GROUPS region above them.
  //
  // Groups (top): one row per pilot group — the built-in Companions group and
  // every squad the player made on the Pilot Hangar — each able to start one
  // bot on all of its free members at once. It sits ABOVE Pilots on purpose:
  // launching for a group is the coarse action and launching for one pilot is
  // the exception to it, and a player with six pilots arranged into two ops
  // should meet the two ops first. The membership is NOT this panel's to
  // invent — it is `app/hangarPrefs.ts`, the same squads the landing screen
  // shows — and every rule about who can be started lives in
  // `bots/pilotGroups.ts`.
  //
  // Region A (pilots, top): one row per held session in THIS browser tab, plus
  // one row per character with a live server bot and no held session here
  // (§4's "multibox wrinkle", option (a) — the roster is threaded in from
  // App.svelte as `sessions`, an optional prop so every existing caller and
  // the no-props SSR test keep working). All run-state logic — which mode a
  // pilot is in, its status words, its detail line — lives in
  // `bots/pilotRoster.ts`; this panel only fetches the server roster and hands
  // each pilot's inputs to `BotManagerPilotRow.svelte`.
  //
  // Region B (library, below): every saved bot, from every account, in one
  // list (Decision 1). "Saved by" names who wrote it for display only — it
  // confers no rights (Decision 5): any account here can load, edit or delete
  // any row.
  //
  // Both regions follow ServerBots.svelte's shape: poll-free (each list only
  // changes on an action taken here or elsewhere in the app), onMount load,
  // and error/empty/loading kept as three distinguishable states rather than
  // collapsed into one "nothing to show".
  //
  // THE LAYOUT IS THE PI MANAGER'S (plugins/pi-manager/ui/PiManager.svelte): a menu rail down the left, one view at a
  // time beside it, and a strip of four numbers over every view. The regions
  // used to be stacked, which put the library a long scroll under five groups
  // whose rows each repeated the same two explanations. Every view is still
  // RENDERED, only `hidden` — so a view's loading/error wording is decided the
  // same way whether or not it is the one on screen.
  import { onMount } from "svelte";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import {
    listBotScripts,
    getBotScript,
    deleteBotScript,
    listBotCategories,
    createBotCategory,
    renameBotCategory,
    moveBotCategory,
    deleteBotCategory,
    setBotScriptsCategory,
    type BotCategory,
    type BotScriptSummary,
    type ServerBot,
  } from "../app/api.ts";
  import { createPilotReach } from "../app/pilotReach.ts";
  import type { Session } from "../app/sessions.ts";
  import type { TabID } from "./tabs.ts";
  import {
    ALL_BOTS,
    deleteCategoryPrompt,
    categoryLabel,
    effectiveCategory,
    lastSavedPhrase,
    libraryView,
    liveShelf,
    savedByLabel,
    shelfCounts,
    type LibraryShelf,
  } from "../bots/libraryView.ts";
  import { ACTION_GLYPHS } from "./actionIcons.ts";
  import { editInBuilder, libraryChanged, newInBuilder, noteLibraryChanged } from "../bots/builderTarget.ts";
  import {
    serverBotFor,
    serverOnlyBots,
    endedRuns,
    runOutcomePhrase,
    lastAlertPhrase,
    RECENT_RUNS_ARE_NOT_DURABLE,
  } from "../bots/pilotRoster.ts";
  import { loadHangarPrefs } from "../app/hangarPrefs.ts";
  import { loadKnownAccounts, loadKnownCharacters } from "../app/knownCharacters.ts";
  import { companionGroupRoster, pilotGroups } from "../bots/pilotGroups.ts";
  import BotManagerGroupRow from "./BotManagerGroupRow.svelte";
  import BotManagerPilotRow from "./BotManagerPilotRow.svelte";
  import ActionButton from "./ActionButton.svelte";
  import { DEFAULT_SERVER_BOT_RUNTIME_MINUTES } from "../bots/runPolicy.ts";

  let {
    onOpen,
    sessions,
  }: {
    onOpen?: (tab: TabID, sessionID?: string) => void;
    sessions?: readonly Session[];
  } = $props();

  /**
   * How often the server roster is re-read.
   *
   * ⚠ THE SERVER ROSTER IS THE ONE LIST HERE THAT CHANGES BY ITSELF. Every other
   * list in this panel only moves when somebody acts — in this tab or another —
   * so an onMount read is enough for them. A server bot is running on a machine
   * nobody in this browser is driving: it changes phase, raises an alert and hits
   * its runtime cap with no local event to notice. Without this the roster would
   * be frozen at whenever the panel was opened, which is worse than showing
   * nothing — a stale "Running" is a lie a player will act on. 3s matches what
   * the standalone Server Bots panel polled at.
   */
  const SERVER_ROSTER_POLL_MS = 3000;

  // --- whose token a call rides ---------------------------------------------
  //
  // ⚠ NEVER THE ACTIVE PILOT'S. This window opens from the Pilot Hangar with
  // nobody in the client, and over a cockpit it is about every pilot. Each call
  // is made by the account it is about — see app/pilotReach.ts.
  const reach = createPilotReach({
    held: () => heldSessions,
    known: () => known,
    accounts: () => accounts,
  });
  onMount(() => () => void reach.release());
  const ownerOptions = (characterID: number) => reach.ownerOptions(characterID);
  const libraryOptions = () => reach.libraryOptions();

  // --- region A: pilots -------------------------------------------------
  // Three honest states, same as region B below: loading, empty ("no pilots
  // online"), and a read error — a failed read of the server roster must
  // never collapse into "nothing running" (a player could act on that lie).
  let pilotsLoaded = $state(false);
  let pilotsError = $state<string | null>(null);
  /** Accounts whose bots could not be read this beat, when others could. */
  let pilotsMissing = $state<readonly string[]>([]);
  let serverBots = $state<ServerBot[]>([]);

  async function refreshPilots(): Promise<void> {
    try {
      // Every account this browser knows, not just the one on screen.
      const read = await reach.readServerBots();
      if (read.allFailed) {
        pilotsError = "Could not load the server's bot roster — is the server up?";
        pilotsMissing = [];
      } else {
        serverBots = [...read.bots];
        pilotsError = null;
        pilotsMissing = read.missing;
      }
    } finally {
      pilotsLoaded = true;
    }
  }

  const heldSessions = $derived(sessions ?? []);
  // Characters a held session already covers, so a server-only row is never
  // shown twice for a pilot whose tab happens to be open right here.
  const heldCharacterIDs = $derived(
    heldSessions
      .map((session) => session.store.station.get().online?.characterID ?? null)
      .filter((id): id is number => id !== null),
  );
  const extraServerBots = $derived(serverOnlyBots(serverBots, heldCharacterIDs));

  // --- groups ---------------------------------------------------------------
  //
  // ⚠ RE-READ ON THE ROSTER'S OWN BEAT, NOT ONCE AT MOUNT. Squads are edited on
  // the Pilot Hangar and companion ticks are set there too; this panel can be
  // left open across both. localStorage gives no change event to this tab (the
  // `storage` event fires only in OTHER tabs), so the only honest options are
  // to re-read or to show an arrangement the player has already changed. A
  // parse of a few hundred bytes beside a network poll is not a cost worth
  // being clever about.
  let prefs = $state(loadHangarPrefs());
  let known = $state(loadKnownCharacters());
  let accounts = $state(loadKnownAccounts());

  function refreshGroups(): void {
    prefs = loadHangarPrefs();
    known = loadKnownCharacters();
    accounts = loadKnownAccounts();
  }

  const groups = $derived(pilotGroups(prefs));
  /**
   * How long any group's server start may fly. One setting under the list, not
   * a picker on every row: nobody set the five differently.
   */
  let runtimeMinutes = $state(DEFAULT_SERVER_BOT_RUNTIME_MINUTES);
  /** Each companion's saved setup, so the Companions row can start them. */
  const companionSetups = $derived(
    new Map(companionGroupRoster(prefs).map((member) => [member.characterID, member.setup])),
  );

  /**
   * A pilot's name from whichever source knows it.
   *
   * ⚠ THREE SOURCES BECAUSE A GROUP MEMBER NEED NOT BE ANYWHERE NEAR THIS TAB.
   * A held session knows its own pilot; a server bot carries the name the host
   * resolved; and a member that is neither — signed into nothing, flying
   * nothing — is known only to this browser's own roster. Without the third, a
   * group of six with one tab open would print five "Unknown pilot" rows, and
   * a raw id in their place is not an option (R7d).
   *
   * ⚠ A PLAIN FUNCTION, NOT A `$derived` HOLDING ONE — see the house sweep in
   * ui/panelFirstMount.test.ts. Its reads of `heldSessions`, `serverBots` and
   * `known` are tracked wherever it is called, including inside the group
   * row's own `$derived`, so nothing is lost by not wrapping it.
   */
  function nameOf(characterID: number): string | null {
    for (const session of heldSessions) {
      const online = session.store.station.get().online;
      if (online?.characterID === characterID) return online.characterName ?? null;
    }
    const bot = serverBots.find((entry) => entry.characterID === characterID);
    if (bot?.characterName) return bot.characterName;
    return known.find((entry) => entry.characterID === characterID)?.characterName ?? null;
  }

  // --- region C: recent runs ---------------------------------------------
  // Same fetch as region A (`serverBots`), just the ended slice of it — no
  // second call. 20 matches MAX_ENDED_RUNS in src/botHost.js, the server's
  // own memory bound, so asking for more can never return more.
  const recentRuns = $derived(endedRuns(serverBots, 20));

  let loaded = $state(false);
  let error = $state<string | null>(null);
  let scripts = $state<BotScriptSummary[]>([]);
  let categories = $state<BotCategory[]>([]);
  let query = $state("");

  /** Which row's buttons are disabled while a call for it is in flight. */
  let busyID = $state<string | null>(null);

  /** The row whose Export box is open, and the JSON text inside it. */
  let exportID = $state<string | null>(null);
  let exportText = $state("");
  let exportError = $state<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const options = await libraryOptions();
      // One read, both halves: a list of bots with no categories to put them
      // in would count every one of them as Uncategorized for a beat.
      const [nextScripts, nextCategories] = await Promise.all([
        listBotScripts(options),
        listBotCategories(options),
      ]);
      scripts = nextScripts;
      categories = nextCategories;
      error = null;
    } catch {
      // Keep whatever was last known on screen; say the read is failing —
      // never let a failed read collapse into "no bots saved" (see below).
      error = "Could not load the bot library — is the server up?";
    } finally {
      loaded = true;
    }
  }

  // The builder saved something. This list is poll-free — right for a list of
  // saved bots, wrong the moment the only thing that writes to it moved into
  // another window — so a save says so and this re-reads (builderTarget.ts).
  //
  // ⚠ THE MARK IS SEEDED AT MOUNT, NOT AT ZERO. Every effect runs once on
  // mount, and `onMount` below is already fetching; starting from zero would
  // make every open of this window fire two reads of the same list.
  const libraryWrites = libraryChanged;
  let servedLibraryWrite = libraryChanged.get();
  $effect(() => {
    const count = $libraryWrites;
    if (count === servedLibraryWrite) return;
    servedLibraryWrite = count;
    void refresh();
  });

  onMount(() => {
    void refresh();
    // Guarded, like every other periodic read — see app/skipWhileBusy.ts. Only
    // the roster repeats; the library is not a self-changing list.
    const beat = skipWhileBusy(async () => {
      refreshGroups();
      await refreshPilots();
    });
    void beat();
    const timer = setInterval(() => void beat(), SERVER_ROSTER_POLL_MS);
    return () => clearInterval(timer);
  });

  // --- categories -----------------------------------------------------------
  //
  // Folders over the saved bots, listed under "Saved bots" on the rail and
  // managed right there: "+ New category" at the end, and rename / delete on
  // each one. A bot is filed with the Category menu on its row, or when it is
  // saved in the Bot Builder. ⚠ DELETING A CATEGORY NEVER DELETES A BOT: the
  // server moves its bots to Uncategorized, and the confirm says so.

  /** The rail's selected slice of the library. */
  let shelf = $state<LibraryShelf>(ALL_BOTS);
  // A category deleted (here or in another window) drops back to All.
  const shownShelf = $derived(liveShelf(shelf, categories));
  const counts = $derived(shelfCounts(scripts, categories));

  function showShelf(next: LibraryShelf): void {
    shelf = next;
    page = "library";
  }

  function isShown(next: LibraryShelf): boolean {
    if (page !== "library" || next.kind !== shownShelf.kind) return false;
    return next.kind !== "category" || (shownShelf.kind === "category" && shownShelf.categoryID === next.categoryID);
  }

  /** The rail row being typed into: a new category, or one being renamed. */
  let naming = $state<{ kind: "new" } | { kind: "rename"; categoryID: string } | null>(null);
  let draftName = $state("");
  let categoryError = $state<string | null>(null);
  let categoryBusy = $state(false);

  function startNew(): void {
    naming = { kind: "new" };
    draftName = "";
    categoryError = null;
  }

  function startRename(category: BotCategory): void {
    naming = { kind: "rename", categoryID: category.categoryID };
    draftName = category.name;
    categoryError = null;
  }

  function stopNaming(): void {
    naming = null;
    draftName = "";
    categoryError = null;
  }

  /** The server's own words for a refusal ("There is already a category called ..."). */
  function refusalMessage(caught: unknown, fallback: string): string {
    const message = caught instanceof Error ? caught.message : "";
    return message.length > 0 ? message : fallback;
  }

  /**
   * Every category write ends the same way: tell the Builder (its save picker
   * lists these too) and re-read. ⚠ The mark is taken BEFORE the re-read, or
   * the effect above would fetch the same list a second time.
   */
  async function afterCategoryWrite(): Promise<void> {
    noteLibraryChanged();
    servedLibraryWrite = libraryChanged.get();
    await refresh();
  }

  async function saveName(): Promise<void> {
    if (naming === null || categoryBusy) return;
    const name = draftName.trim();
    if (name.length === 0) {
      categoryError = "Give the category a name.";
      return;
    }
    categoryBusy = true;
    try {
      const options = await libraryOptions();
      if (naming.kind === "new") {
        const { categoryID } = await createBotCategory(name, options);
        shelf = { kind: "category", categoryID };
        page = "library";
      } else {
        await renameBotCategory(naming.categoryID, name, options);
      }
      stopNaming();
      await afterCategoryWrite();
    } catch (caught) {
      categoryError = refusalMessage(caught, "Could not save that category.");
    } finally {
      categoryBusy = false;
    }
  }

  function nameKey(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveName();
    } else if (event.key === "Escape") {
      event.preventDefault();
      stopNaming();
    }
  }

  async function moveCategory(categoryID: string, by: -1 | 1): Promise<void> {
    const index = categories.findIndex((category) => category.categoryID === categoryID);
    const to = index + by;
    if (index < 0 || to < 0 || to >= categories.length || categoryBusy) return;
    categoryBusy = true;
    try {
      await moveBotCategory(categoryID, to, await libraryOptions());
      await afterCategoryWrite();
    } catch (caught) {
      categoryError = refusalMessage(caught, "Could not move that category.");
    } finally {
      categoryBusy = false;
    }
  }

  async function removeCategory(category: BotCategory): Promise<void> {
    if (categoryBusy) return;
    const held = counts.byCategory.get(category.categoryID) ?? 0;
    if (!window.confirm(deleteCategoryPrompt(category.name, held))) return;
    categoryBusy = true;
    try {
      await deleteBotCategory(category.categoryID, await libraryOptions());
      if (naming?.kind === "rename" && naming.categoryID === category.categoryID) stopNaming();
      await afterCategoryWrite();
    } catch (caught) {
      categoryError = refusalMessage(caught, "Could not delete that category.");
    } finally {
      categoryBusy = false;
    }
  }

  /**
   * The one row whose Category cell is a menu right now.
   *
   * ⚠ A CELL IS A LABEL UNTIL IT IS CLICKED. Moving a bot is rare, and eleven
   * permanent dropdowns made a quiet list look like a form. The label is a
   * button (keyboard and screen readers reach it), and the menu it becomes
   * goes back to a label on a pick, on Esc, or when focus leaves it.
   */
  let movingID = $state<string | null>(null);

  /** Focus the menu as it appears and open its list, so one click is enough. */
  function openMenu(select: HTMLSelectElement): void {
    select.focus();
    try {
      select.showPicker?.();
    } catch {
      // No user activation left, or no showPicker: focused is enough.
    }
  }

  function menuKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      movingID = null;
    }
  }

  /** File one bot from its row's Category menu ("" = Uncategorized). */
  async function fileBot(script: BotScriptSummary, value: string): Promise<void> {
    movingID = null;
    if (busyID !== null) return;
    const categoryID = value === "" ? null : value;
    if (categoryID === effectiveCategory(script, categories)) return;
    busyID = script.scriptID;
    try {
      await setBotScriptsCategory([script.scriptID], categoryID, await libraryOptions());
      error = null;
    } catch {
      error = "Could not move that bot — it may have just been deleted.";
    } finally {
      busyID = null;
    }
    await afterCategoryWrite();
  }

  /** What the empty state calls the selected shelf. */
  const shelfName = $derived.by(() => {
    const shown = shownShelf;
    if (shown.kind === "all") return "All";
    if (shown.kind === "uncategorized") return "Uncategorized";
    return categories.find((category) => category.categoryID === shown.categoryID)?.name ?? "";
  });

  // Which of the honest states we are in, decided by the pure module so the
  // "a failed read is never 'no bots saved'" rule is stated and tested once.
  const view = $derived(libraryView(loaded, error, scripts, query, categories, shownShelf));
  const filtered = $derived(view.kind === "rows" ? view.rows : []);

  // --- the window strip ---------------------------------------------------
  //
  // Every window names itself once, in its title bar; a panel underneath
  // never repeats it. Region A used to sit right under the title bar with its
  // own `<header class="panel-head"><h2>Pilots</h2></header>`, which is styled
  // exactly like a window strip and, sitting first, READ as one — a band that
  // looked like it was answering for the whole window while it was really
  // just region A's own band, the same idiom Recent runs and Saved bots use
  // below it. This gives the window a strip of its own, in FleetCompanions.svelte's
  // shape, so the band directly under the title bar is honestly the window's.
  //
  // ⚠ TWO INDEPENDENT READS, ONE LINE, GATED ON BOTH. Region A/C's roster
  // (`serverBots`, fetched by `refreshPilots`) and region B's library
  // (`scripts`, fetched by `refresh`) are two unrelated calls, each still able
  // to be in flight or failed on its own schedule. Printing whatever answered
  // first would make the strip flicker between an honest partial and a
  // wrong-looking whole on every render, so it says nothing until BOTH have
  // settled — `pilotsLoaded` is set true in `refreshPilots`'s `finally`
  // regardless of outcome, and `view.kind === "loading"` is `libraryView`'s
  // own word for "the fetch has not answered yet" (see its doc). Nothing
  // rendered during loading is the CSS's cue too: a `.panel-head` holding
  // only the clipped `.panel-title` collapses its band rather than drawing an
  // empty strip (styles.css, the rule beside `.panel-title` itself).
  //
  // ⚠ A FAILED READ IS NEVER "0". `scripts.length` only appears once `view`
  // says the library actually loaded (`view.kind !== "error"`, `!== "loading"`);
  // `pilotsPart` reads `pilotsError` the same way region A's own rows do. Two
  // more places drawing that line, not a looser copy of it.
  //
  // `scripts.length`, not `filtered.length` — the strip is the LIBRARY's size,
  // and a search query narrowing `filtered` to zero rows must not read here as
  // "no bots saved" (that lie is exactly what the "no-matches" state below
  // exists to tell apart from "empty").
  //
  // ⚠ NOW FOUR NUMBERS, SAME RULES. The strip became PiManager's summary `dl`,
  // one figure per fact, and each figure still waits on the read it comes
  // from: "-" while that read has not answered, "?" when it failed. The
  // strip no longer waits for BOTH reads, because each figure now stands
  // alone and one cannot be mistaken for a total of the other.
  type Stat = number | "loading" | "failed";

  function rosterStat(count: number): Stat {
    if (!pilotsLoaded) return "loading";
    return pilotsError !== null ? "failed" : count;
  }

  const stats = $derived.by(() => ({
    online: rosterStat(heldSessions.length + extraServerBots.length),
    onServer: rosterStat(serverBots.filter((bot) => bot.endedAt === null).length),
    recent: rosterStat(recentRuns.length),
    saved: (view.kind === "loading"
      ? "loading"
      : view.kind === "error"
        ? "failed"
        : scripts.length) as Stat,
  }));

  function statWords(stat: Stat): string {
    if (stat === "loading") return "-";
    if (stat === "failed") return "?";
    return String(stat);
  }

  // --- the rail -------------------------------------------------------------
  type Page = "groups" | "pilots" | "runs" | "library";
  let page = $state<Page>("groups");

  const menu = $derived<readonly { id: Page; label: string; badge: Stat; live?: boolean }[]>([
    { id: "groups", label: "Groups", badge: groups.length },
    { id: "pilots", label: "Pilots", badge: stats.online, live: true },
    { id: "runs", label: "Recent runs", badge: stats.recent },
    { id: "library", label: "Saved bots", badge: stats.saved },
  ]);

  /**
   * Open the Bot Builder ON THIS ROW'S BOT.
   *
   * ⚠ THE id IS HALF THE BUTTON, and it used to be dropped here. Opening the
   * builder's window is not editing a bot: the builder that appeared was
   * showing whatever it had last, and the bot whose Edit button had just been
   * pressed had to be found again in a SECOND copy of this library that the
   * builder carried for that purpose. `editInBuilder` is the other half —
   * which bot — and it travels on its own signal because the open request
   * between these two windows addresses a tab and carries no payload
   * (bots/builderTarget.ts).
   */
  function edit(scriptID: string): void {
    editInBuilder(scriptID);
    onOpen?.("botBuilder");
  }

  /**
   * Open the Bot Builder with nothing selected — "I want a bot that does not
   * exist yet".
   *
   * ⚠ THIS IS THE ONLY WAY TO REACH THE BUILDER WITH AN EMPTY LIBRARY, and that
   * is why it exists. The Builder has no launcher entry of its own any more (it
   * is reached through this panel, which is the one door onto bots); before this
   * button the only route here was the Edit action on a saved row, so a player
   * with no saved bots had no way to write their first one.
   *
   * It says "new" out loud for the same reason Edit says which bot: a builder
   * already open on a saved bot would otherwise answer this button by showing
   * that bot, and the player would edit it thinking it was their new one.
   *
   * It works with nobody in the client too: App floats the builder over the
   * hangar then (globalWindow.ts `BUILDER_TAB`). Both buttons used to be
   * greyed out there, so a player could list their bots but not write one.
   */

  function newBot(): void {
    newInBuilder();
    onOpen?.("botBuilder");
  }

  async function toggleExport(scriptID: string): Promise<void> {
    if (exportID === scriptID) {
      exportID = null;
      exportText = "";
      exportError = null;
      return;
    }
    if (busyID !== null) {
      return;
    }
    busyID = scriptID;
    exportID = scriptID;
    exportText = "";
    exportError = null;
    try {
      const record = await getBotScript(scriptID, await libraryOptions());
      if (record === null) {
        exportError = "That bot could not be found — it may have just been deleted.";
      } else {
        exportText = JSON.stringify(record.doc, null, 2);
      }
    } catch {
      exportError = "Could not load that bot to export it.";
    } finally {
      busyID = null;
    }
  }

  async function remove(script: BotScriptSummary): Promise<void> {
    if (busyID !== null) {
      return;
    }
    // The library is shared (Decision 5) — say so in the confirm, not just
    // "delete this bot", since the row deleted may not be the caller's own.
    const ok = window.confirm(
      `Delete “${script.name}” from the shared bot library? Anyone who saved, edited or ran it will lose it. This cannot be undone.`,
    );
    if (!ok) {
      return;
    }
    busyID = script.scriptID;
    try {
      await deleteBotScript(script.scriptID, await libraryOptions());
      if (exportID === script.scriptID) {
        exportID = null;
        exportText = "";
        exportError = null;
      }
      error = null;
      // ⚠ THE BUILDER'S PICKERS HOLD THIS ROW TOO. Deleting used to happen in
      // the builder as well, where it re-read its own list; this panel is the
      // only place it happens now, so without this the builder goes on offering
      // a bot that is gone — and "+ Saved bot" would point a sub-bot node at a
      // script id nothing can resolve.
      noteLibraryChanged();
      // Its own change, already accounted for: `refresh()` runs below either
      // way, and without this the effect above would read the same list twice.
      servedLibraryWrite = libraryChanged.get();
    } catch {
      error = "Could not delete that bot — it may have already been removed.";
    } finally {
      busyID = null;
    }
    await refresh();
  }

</script>

<section class="panel bm">
  <header class="panel-head">
    <h2 class="panel-title">Bot Manager</h2>
  </header>

  <div class="bm-body">
    <!-- THE WINDOW'S OWN MENU, PiManager's rail. A side rail while the window
         is wide, a row across the top when it is narrow; the same buttons
         either way. -->
    <nav class="bm-menu" aria-label="Bot Manager">
      <div role="tablist" class="bm-menu-list">
        {#each menu as item (item.id)}
          <button
            type="button"
            role="tab"
            id="bm-tab-{item.id}"
            class="bm-menu-item"
            class:on={page === item.id}
            aria-selected={page === item.id}
            aria-controls="bm-view-{item.id}"
            onclick={() => (page = item.id)}
          >
            <span>{item.label}</span>
            <span
              class="bm-badge"
              class:live={item.live === true && typeof item.badge === "number" && item.badge > 0}
            >{statWords(item.badge)}</span>
          </button>
        {/each}
      </div>
      <!-- THE LIBRARY'S SHELVES, under the rail. Not tabs: they all show the
           one Saved bots view, each a different slice of it, so they sit
           outside the tablist as a list of their own. -->
      <ul class="bm-shelves" aria-label="Saved bot categories">
        <li class="bm-shelf" class:on={isShown(ALL_BOTS)}>
          <button
            type="button"
            class="bm-shelf-pick"
            aria-current={isShown(ALL_BOTS) ? "true" : undefined}
            onclick={() => showShelf(ALL_BOTS)}
          >
            <span class="bm-shelf-name">All</span>
            <span class="bm-badge">{statWords(stats.saved)}</span>
          </button>
        </li>
        {#each categories as category, index (category.categoryID)}
          {@const mine = { kind: "category", categoryID: category.categoryID } as const}
          {#if naming?.kind === "rename" && naming.categoryID === category.categoryID}
            <li class="bm-shelf bm-shelf-edit">
              <!-- svelte-ignore a11y_autofocus -->
              <input
                type="text"
                class="bm-shelf-input"
                aria-label="Category name"
                maxlength="40"
                autofocus
                bind:value={draftName}
                onkeydown={nameKey}
              />
              <span class="bm-shelf-edit-actions">
                <button type="button" class="bm-mini" disabled={categoryBusy} onclick={() => void saveName()}>Save</button>
                <button type="button" class="bm-mini" onclick={stopNaming}>Cancel</button>
                <button
                  type="button"
                  class="bm-mini"
                  disabled={categoryBusy || index === 0}
                  onclick={() => void moveCategory(category.categoryID, -1)}>Up</button
                >
                <button
                  type="button"
                  class="bm-mini"
                  disabled={categoryBusy || index === categories.length - 1}
                  onclick={() => void moveCategory(category.categoryID, 1)}>Down</button
                >
              </span>
            </li>
          {:else}
            <li class="bm-shelf" class:on={isShown(mine)}>
              <button
                type="button"
                class="bm-shelf-pick"
                aria-current={isShown(mine) ? "true" : undefined}
                onclick={() => showShelf(mine)}
              >
                <span class="bm-shelf-name">{category.name}</span>
                <span class="bm-badge">{loaded && error === null ? (counts.byCategory.get(category.categoryID) ?? 0) : "-"}</span>
              </button>
              <span class="bm-shelf-tools">
                <button
                  type="button"
                  class="bm-shelf-tool"
                  title="Rename or reorder"
                  aria-label="Rename or reorder {category.name}"
                  disabled={categoryBusy}
                  onclick={() => startRename(category)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    {#each ACTION_GLYPHS.edit as d (d)}<path {d} />{/each}
                  </svg>
                </button>
                <button
                  type="button"
                  class="bm-shelf-tool danger"
                  title="Delete category (its bots are kept)"
                  aria-label="Delete category {category.name}"
                  disabled={categoryBusy}
                  onclick={() => void removeCategory(category)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    {#each ACTION_GLYPHS.delete as d (d)}<path {d} />{/each}
                  </svg>
                </button>
              </span>
            </li>
          {/if}
        {/each}
        <li class="bm-shelf" class:on={isShown({ kind: "uncategorized" })}>
          <button
            type="button"
            class="bm-shelf-pick"
            aria-current={isShown({ kind: "uncategorized" }) ? "true" : undefined}
            onclick={() => showShelf({ kind: "uncategorized" })}
          >
            <span class="bm-shelf-name">Uncategorized</span>
            <span class="bm-badge">{loaded && error === null ? counts.uncategorized : "-"}</span>
          </button>
        </li>
        {#if naming?.kind === "new"}
          <li class="bm-shelf bm-shelf-edit">
            <!-- svelte-ignore a11y_autofocus -->
            <input
              type="text"
              class="bm-shelf-input"
              aria-label="New category name"
              placeholder="Mining"
              maxlength="40"
              autofocus
              bind:value={draftName}
              onkeydown={nameKey}
            />
            <span class="bm-shelf-edit-actions">
              <button type="button" class="bm-mini" disabled={categoryBusy} onclick={() => void saveName()}>Add</button>
              <button type="button" class="bm-mini" onclick={stopNaming}>Cancel</button>
            </span>
          </li>
        {:else}
          <li class="bm-shelf">
            <button type="button" class="bm-shelf-pick bm-shelf-new" onclick={startNew}>+ New category</button>
          </li>
        {/if}
        {#if categoryError !== null}
          <li class="bm-shelf-error" role="alert">{categoryError}</li>
        {/if}
      </ul>
    </nav>

    <div class="bm-views">
      <!-- THE STRIP: the whole estate in four numbers, over every view. -->
      <dl class="bm-summary">
        <div>
          <dt>Pilots online</dt>
          <dd class:good={typeof stats.online === "number" && stats.online > 0}>{statWords(stats.online)}</dd>
        </div>
        <div>
          <dt>On the server</dt>
          <dd>{statWords(stats.onServer)}</dd>
        </div>
        <div>
          <dt>Recent runs</dt>
          <dd>{statWords(stats.recent)}</dd>
        </div>
        <div>
          <dt>Saved bots</dt>
          <dd>{statWords(stats.saved)}</dd>
        </div>
      </dl>

      <div
        class="bm-view"
        id="bm-view-groups"
        role="tabpanel"
        aria-labelledby="bm-tab-groups"
        hidden={page !== "groups"}
      >
        <!-- ⚠ NO LOADING STATE, AND NO ERROR ONE. Unlike every other list in this
             window, this one is not fetched: squads live in localStorage, so the
             first render already has the true answer. A "Loading groups…" here would
             be a state that never happens. -->
        <p class="note">
          Start one bot on a whole group at once. Groups are the squads you make on
          the Pilot Hangar; Companions is built in and always flies the fleet
          companion.
        </p>

        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow bm-groups">
            <thead>
              <tr>
                <th class="bm-col-group">Group</th>
                <th class="bm-col-bot">Bot</th>
                <th class="bm-col-tight">Server</th>
                <th class="bm-col-tight"><span class="sr-only">Start or stop</span></th>
                <th class="bm-col-status">Status</th>
              </tr>
            </thead>
            <tbody>
              {#each groups as group (group.id)}
                <BotManagerGroupRow
                  {group}
                  {scripts}
                  {serverBots}
                  {ownerOptions}
                  {libraryOptions}
                  {companionSetups}
                  {nameOf}
                  {runtimeMinutes}
                  sessions={heldSessions}
                  onChanged={refreshPilots}
                />
              {/each}
            </tbody>
          </table>
        </div>

        <!-- ⚠ SAID ONCE, UNDER THE LIST, NOT UNDER EVERY ROW. Both sentences are
             true of every group alike; repeated per row they were most of each
             row's height and read as noise by the third group. What differs per
             row — how many pilots each button reaches — stays on the row. -->
        <ul class="bm-legend">
          <li class="note bm-limit">
            <span><strong>Server</strong> ticked: keeps flying if this tab closes, and stops after</span>
            <select aria-label="Server run time limit" bind:value={runtimeMinutes}>
              <option value={60}>1 hour</option>
              <option value={240}>4 hours</option>
              <option value={720}>12 hours</option>
              <option value={1440}>24 hours</option>
              <option value={2880}>48 hours</option>
              <option value={4320}>72 hours</option>
            </select>
          </li>
          <li class="note">
            Unticked: flies only the pilots signed in to this tab, and stops when this tab closes.
          </li>
          <li class="note">
            Built-in bots are set up against one pilot's own ship, so they start from that
            pilot's row under <button type="button" class="bm-link" onclick={() => (page = "pilots")}>Pilots</button>.
          </li>
        </ul>
      </div>

      <div
        class="bm-view"
        id="bm-view-pilots"
        role="tabpanel"
        aria-labelledby="bm-tab-pilots"
        hidden={page !== "pilots"}
      >
        {#if pilotsMissing.length > 0}
          <!-- ⚠ NAMED, NOT DROPPED: a bot on an account that could not be read is
               missing from the rows below, and that must not read as "not running". -->
          <p class="note error">
            Could not read the bots on {pilotsMissing.join(", ")} — any running there are not listed.
          </p>
        {/if}
        {#if pilotsError}
          <p class="note error">{pilotsError}</p>
        {:else if !pilotsLoaded}
          <p class="note">Loading pilots…</p>
        {:else if heldSessions.length === 0 && extraServerBots.length === 0}
          <p class="empty">No pilots online.</p>
        {:else}
          <div class="table-wrap overflow-x-auto">
            <table class="guests reflow">
              <thead>
                <tr>
                  <th>Pilot</th>
                  <th>Where</th>
                  <th>Running</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {#each heldSessions as session (session.id)}
                  {@const characterID = session.store.station.get().online?.characterID ?? null}
                  <!-- ⚠ `onSetUpBuiltIn` NAMES THIS ROW'S PILOT, never the active one.
                       The panel it opens reads the MOUNTED pilot's ship, so an
                       unaddressed open would show one pilot's hull under another's
                       name — a requirement checklist about the wrong ship. -->
                  <BotManagerPilotRow
                    {session}
                    serverBot={characterID === null ? null : serverBotFor(serverBots, characterID)}
                    {scripts}
                    {ownerOptions}
                    onChanged={refreshPilots}
                    onSetUpBuiltIn={() => onOpen?.("bots", session.id)}
                  />
                {/each}
                {#each extraServerBots as bot (bot.botID)}
                  <BotManagerPilotRow serverBot={bot} {scripts} {ownerOptions} onChanged={refreshPilots} />
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>

      <div
        class="bm-view"
        id="bm-view-runs"
        role="tabpanel"
        aria-labelledby="bm-tab-runs"
        hidden={page !== "runs"}
      >
        <p class="note">{RECENT_RUNS_ARE_NOT_DURABLE}</p>

        {#if pilotsError}
          <p class="note error">{pilotsError}</p>
        {:else if !pilotsLoaded}
          <p class="note">Loading recent runs…</p>
        {:else if recentRuns.length === 0}
          <p class="empty">Nothing has finished yet.</p>
        {:else}
          <div class="table-wrap overflow-x-auto">
            <table class="guests reflow">
              <thead>
                <tr>
                  <th>Bot</th>
                  <th>Pilot</th>
                  <th>Outcome</th>
                  <th>Last alert</th>
                </tr>
              </thead>
              <tbody>
                {#each recentRuns as bot (bot.botID)}
                  <tr>
                    <td data-label="Bot">{bot.scriptName}</td>
                    <td data-label="Pilot">{bot.characterName ?? "Unknown pilot"}</td>
                    <td data-label="Outcome">
                      {runOutcomePhrase(bot)}{#if bot.why}<br />{bot.why}{/if}
                    </td>
                    <td data-label="Last alert">{lastAlertPhrase(bot, Date.now()) ?? "—"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>

      <!-- ⚠ NOT "BOT MANAGER" — that is the WINDOW's name. What this view is,
           is the library of saved bots, and the rail says so. -->
      <div
        class="bm-view"
        id="bm-view-library"
        role="tabpanel"
        aria-labelledby="bm-tab-library"
        hidden={page !== "library"}
      >
        <div class="bm-toolbar">
          <input
            type="search"
            class="bm-search"
            aria-label="Search saved bots"
            placeholder="Search by name or who saved it"
            bind:value={query}
          />
          <button
            type="button"
            class="primary"
            onclick={newBot}>New bot</button
          >
        </div>

        <!-- One switch over the pure view, so "a failed read is never 'no bots
             saved'" is decided in libraryView.ts and merely rendered here. -->
        {#if view.kind === "error"}
          <p class="note error">{view.message}</p>
        {:else if view.kind === "loading"}
          <p class="note">Loading the bot library…</p>
        {:else if view.kind === "empty"}
          <!-- ⚠ IT NAMES THE BUTTON, NOT A LAUNCHER ENTRY. This used to read "Build
               one in the Bot Builder", which was a direction to a rail entry that no
               longer exists — the worst kind of empty state, one that sends a player
               somewhere they cannot go. -->
          <p class="empty">No bots saved yet. Choose <strong>New bot</strong> above to write your first one.</p>
        {:else if view.kind === "empty-shelf"}
          <p class="empty">
            No bots in {shelfName} yet. Move one here with the <strong>Category</strong> menu on its row under
            <strong>All</strong>, or pick {shelfName} when you save in the Bot Builder.
          </p>
        {:else if view.kind === "no-matches"}
          <p class="empty">No saved bots in {shelfName} match “{query}”.</p>
        {:else}
          <div class="table-wrap overflow-x-auto">
            <table class="guests reflow">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Saved by</th>
                  <th class="num">Revision</th>
                  <th>Last saved</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {#each filtered as script (script.scriptID)}
                  <tr>
                    <td data-label="Name">{script.name}</td>
                    <td data-label="Category">
                      {#if movingID === script.scriptID}
                        <select
                          class="bm-category"
                          aria-label="Category for {script.name}"
                          value={effectiveCategory(script, categories) ?? ""}
                          use:openMenu
                          onchange={(event) => void fileBot(script, event.currentTarget.value)}
                          onkeydown={menuKey}
                          onblur={() => (movingID = null)}
                        >
                          <option value="">Uncategorized</option>
                          {#each categories as category (category.categoryID)}
                            <option value={category.categoryID}>{category.name}</option>
                          {/each}
                        </select>
                      {:else}
                        <button
                          type="button"
                          class="bm-category-label"
                          class:none={effectiveCategory(script, categories) === null}
                          title="Change category"
                          aria-label="Category: {categoryLabel(script, categories)}. Change category for {script.name}"
                          disabled={busyID !== null}
                          onclick={() => (movingID = script.scriptID)}
                        >{busyID === script.scriptID ? "Moving…" : categoryLabel(script, categories)}</button>
                      {/if}
                    </td>
                    <td data-label="Saved by">{savedByLabel(script)}</td>
                    <td class="num" data-label="Revision">{script.rev}</td>
                    <td data-label="Last saved">{lastSavedPhrase(script.updatedAt, Date.now())}</td>
                    <td data-label="Actions">
                      <span class="row-actions">
                        <ActionButton
                          action="edit"
                          primary
                          disabled={busyID !== null}
                          onclick={() => edit(script.scriptID)}
                        />
                        <ActionButton
                          action="export"
                          disabled={busyID !== null && busyID !== script.scriptID}
                          expanded={exportID === script.scriptID}
                          label={exportID === script.scriptID
                            ? "Hide export"
                            : busyID === script.scriptID
                              ? "Loading…"
                              : undefined}
                          onclick={() => toggleExport(script.scriptID)}
                        />
                        <ActionButton
                          action="delete"
                          danger
                          disabled={busyID !== null}
                          label={busyID === script.scriptID ? "Deleting…" : undefined}
                          onclick={() => remove(script)}
                        />
                      </span>
                    </td>
                  </tr>
                  {#if exportID === script.scriptID}
                    <tr>
                      <td data-label="Export" colspan="6">
                        {#if exportError}
                          <p class="note error">{exportError}</p>
                        {:else}
                          <label>
                            Copy this bot's saved contents
                            <textarea readonly rows="10" value={exportText}></textarea>
                          </label>
                        {/if}
                      </td>
                    </tr>
                  {/if}
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  /* The PI Manager's rail and strip, value for value, so the two windows read
     as one family. Kept scoped rather than shared: each window owns its layout,
     and a change to one must not quietly move the other. */
  /* ⚠ THE PANEL IS ITS OWN SIZE CONTAINER, or the `@container` rules below
     never fire: nothing between here and the page is one, so a query would
     find no container and the rail stayed a rail in a 450px window. Safe to
     contain: a panel's width comes from its window, never its contents. */
  .bm {
    container-type: inline-size;
  }
  .bm-body {
    display: grid;
    grid-template-columns: 11rem minmax(0, 1fr);
    gap: 1rem;
    margin-top: 0.75rem;
  }
  /* The rail is a column: the tabs, then the library's shelves right under
     "Saved bots", which take the rest of the height so the rail's line runs
     to the bottom as it did when the tabs alone filled it. */
  .bm-menu {
    display: flex;
    flex-direction: column;
  }
  .bm-menu-list {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--color-line);
  }
  /* ⚠ NOT `class:active` — a bare `button.active` is a filled accent control
   * in the app's component layer (see StationPanel's tabs). */
  .bm-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 40px;
    padding: 0 0.75rem;
    background: transparent;
    border: 0;
    border-left: 2px solid transparent;
    color: var(--color-muted);
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .bm-menu-item:hover:not(.on) {
    color: var(--color-text-bright);
    background: var(--color-panel-3);
  }
  .bm-menu-item.on {
    color: var(--color-text-bright);
    border-left-color: var(--color-accent);
    background: var(--color-panel-3);
  }
  /* The library's shelves: indented under the rail, each one a row that shows
     its rename / delete tools on hover or keyboard focus. */
  .bm-shelves {
    flex: 1 1 auto;
    list-style: none;
    margin: 0;
    padding: 0 0 0.5rem;
    border-right: 1px solid var(--color-line);
  }
  .bm-shelf {
    position: relative;
    display: flex;
    align-items: center;
    border-left: 2px solid transparent;
  }
  .bm-shelf:hover:not(.on) {
    background: var(--color-panel-3);
  }
  .bm-shelf.on {
    border-left-color: var(--color-accent);
    background: var(--color-panel-3);
  }
  .bm-shelf-pick {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 30px;
    padding: 0 0.75rem 0 1.6rem;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font-size: 0.92em;
    text-align: left;
    cursor: pointer;
  }
  .bm-shelf:hover .bm-shelf-pick,
  .bm-shelf.on .bm-shelf-pick {
    color: var(--color-text-bright);
  }
  .bm-shelf-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bm-shelf-new {
    color: var(--color-accent);
  }
  /* The tools cover the count while shown, so the row keeps its width. */
  .bm-shelf-tools {
    position: absolute;
    right: 0.35rem;
    top: 50%;
    transform: translateY(-50%);
    display: none;
    gap: 0.2rem;
    background: var(--color-panel-3);
  }
  .bm-shelf:hover .bm-shelf-tools,
  .bm-shelf:focus-within .bm-shelf-tools {
    display: flex;
  }
  .bm-shelf-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    min-height: 0;
    padding: 0;
    background: transparent;
    border: 1px solid var(--color-line);
    color: var(--color-muted);
    cursor: pointer;
  }
  .bm-shelf-tool:hover {
    color: var(--color-text-bright);
    border-color: var(--color-accent);
  }
  .bm-shelf-tool.danger:hover {
    color: var(--color-danger);
    border-color: var(--color-danger);
  }
  .bm-shelf-tool svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .bm-shelf-edit {
    flex-direction: column;
    align-items: stretch;
    gap: 0.25rem;
    padding: 0.3rem 0.5rem 0.3rem 1.4rem;
  }
  .bm-shelf-input {
    min-width: 0;
    min-height: 28px;
    padding: 0 0.4rem;
  }
  .bm-shelf-edit-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .bm-mini {
    min-height: 22px;
    padding: 0 0.4rem;
    font-size: 11px;
  }
  .bm-shelf-error {
    padding: 0.25rem 0.75rem 0 1.6rem;
    color: var(--color-danger);
    font-size: 11px;
    white-space: normal;
  }
  .bm-category {
    width: auto;
    max-width: 12rem;
  }
  /* Reads as text with a faint underline: a hint that it can be changed,
     without eleven dropdowns down the column. */
  .bm-category-label {
    width: auto; /* not the reflow card's full-width action button */
    min-height: 0;
    padding: 0;
    background: transparent;
    border: 0;
    border-bottom: 1px dashed var(--color-line-strong);
    color: var(--color-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .bm-category-label.none {
    color: var(--color-muted);
  }
  .bm-category-label:hover:not(:disabled),
  .bm-category-label:focus-visible {
    color: var(--color-accent);
    border-bottom-color: var(--color-accent);
  }
  .bm-badge {
    min-width: 1.4rem;
    padding: 0 0.35rem;
    color: var(--color-muted);
    font-size: 11px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  /* Somebody is online: the one count on the rail worth the eye going to. */
  .bm-badge.live {
    border: 1px solid var(--color-good);
    color: var(--color-good);
  }
  .bm-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0 0 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--color-line);
  }
  .bm-summary dt {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .bm-summary dd {
    margin: 0;
    font-size: 1.35rem;
    color: var(--color-text-bright);
    font-variant-numeric: tabular-nums;
  }
  .bm-summary dd.good {
    color: var(--color-good);
  }
  .bm-view > :first-child {
    margin-top: 0;
  }
  /* The group table: name and bot get fixed shares so the five pickers line
     up under each other, and Launch takes what is left. */
  .bm-groups .bm-col-group {
    width: 26%;
  }
  .bm-groups .bm-col-bot {
    width: 22%;
  }
  .bm-groups .bm-col-tight {
    width: 1%;
    white-space: nowrap;
  }
  .bm-groups .bm-col-status {
    width: 16%;
  }
  .bm-limit {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .bm-limit select {
    width: auto;
  }
  .bm-legend {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0.6rem 0 0;
    border-top: 1px solid var(--color-line);
    display: grid;
    gap: 0.2rem;
  }
  .bm-legend .note {
    margin: 0;
  }
  .bm-link {
    background: none;
    border: 0;
    padding: 0;
    min-height: 0;
    color: var(--color-accent);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  .bm-toolbar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  .bm-search {
    flex: 1 1 auto;
    min-width: 0;
  }
  @container (max-width: 640px) {
    /* Too narrow for a rail: the menu becomes a row across the top. */
    .bm-body {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.5rem;
    }
    .bm-menu-list {
      flex-direction: row;
      flex-wrap: wrap;
      border-right: 0;
      border-bottom: 1px solid var(--color-line);
    }
    .bm-menu-item {
      border-left: 0;
      border-bottom: 2px solid transparent;
    }
    .bm-menu-item.on {
      border-bottom-color: var(--color-accent);
    }
    .bm-shelves {
      display: flex;
      flex-wrap: wrap;
      border-right: 0;
      border-bottom: 1px solid var(--color-line);
    }
    .bm-shelf {
      border-left: 0;
      border-bottom: 2px solid transparent;
    }
    .bm-shelf.on {
      border-bottom-color: var(--color-accent);
    }
    .bm-shelf-pick {
      padding-left: 0.75rem;
    }
    .bm-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .bm-groups .bm-col-group,
    .bm-groups .bm-col-bot,
    .bm-groups .bm-col-status {
      width: auto;
    }
  }
</style>
