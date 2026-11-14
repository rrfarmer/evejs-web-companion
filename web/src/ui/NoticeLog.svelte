<script lang="ts">
  // THE LOG (goal R80) — everything the toasts showed, kept.
  //
  // The permanent half of the same list. A toast is on screen for seven seconds;
  // this is where a player looks when they were reading something else at the
  // time, which for a bot run is most of the time.
  //
  // Newest first, because the question is almost always "what just happened".
  import { getContext } from "svelte";
  import { noticeBoard } from "./notices.ts";
  import { gameLog, logCount, logFilters, logShows, setLogCount, setLogFilter, LOG_COUNTS, LOG_FILTERS, LOG_TYPE_COLOURS, LOG_TYPE_LABELS } from "./gameLog.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import {
    combatAlignment, combatFlags, combatFontSize, combatMovingMode, combatSettingEnabled, resetCombatAlignment, setCombatAlignment, setCombatFlag,
    setCombatFontSize, COMBAT_ALIGNMENT_LABELS, COMBAT_ALIGNMENTS, COMBAT_DISPLAY_SETTINGS, COMBAT_FONT_SIZES, COMBAT_INSPACE_SETTINGS, COMBAT_MENU_WORDS,
  } from "./combatSettings.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  let { store = null, flow = null }: { store?: ClientStore | null; flow?: AppFlow | null } = $props();
  /** On the play page the log as LoggerWindow lists it (uilog.py: its scroll's headers Time, Type, Message). */
  const retail = getContext("retailChrome") === true;

  const notices = noticeBoard.notices;
  // LoggerWindow.LoadAllMessages: the logger's lines (gameLog.ts) its filter shows, the last of the view's count,
  // newest first; Time (MessageOutput's logtime, time=medium), Type (LABEL_BY_MESSAGE_TYPE, in COLORS_BY_TYPE, a
  // type with none its own name), Message. Its actions: the filter menu (MenuButtonIcon eveicon.filter, Filters) -
  // MessageTypesToLog's checkboxes, NumMessagesInLogView's 100 / 1000.
  const LOG_WORDS = ["UI/Common/DateWords/Time", "UI/Accessories/Log/Type", "UI/Accessories/Log/Message", "UI/Generic/Filters",
    "UI/Accessories/Log/MessageTypesToLog", "UI/Accessories/Log/NumMessagesInLogView", ...LOG_FILTERS.map((f) => f.label), ...Object.values(LOG_TYPE_LABELS),
    ...COMBAT_MENU_WORDS];
  // svelte-ignore state_referenced_locally
  const logWords = store?.words ?? null;
  $effect(() => { if (retail) flow?.requestWords(LOG_WORDS); });
  const w = (label: string, own: string) => { const t = logWords ? $logWords?.templates[label] : undefined; return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, {}, { nameOf: () => "" })) : own; };
  const logLines = $derived([...$gameLog].filter((line) => { void $logFilters; return logShows(line.type); }).slice(-$logCount).reverse());
  let filterOpen = $state(false);
  // LoggerWindow._get_combat_message_menu: Combat Messages To Display, In-space Notifications (ExtraInfoHeader), Font
  // Size, Font Alignment (InspaceNotificationFontAlignment) - combatSettings.ts
  const COMBAT_SUBMENUS = [
    { id: "display", label: "UI/Accessories/Log/CombatMessagesToDisplay", own: "Combat Messages To Display" },
    { id: "inspace", label: "UI/Accessories/Log/ExtraInfoHeader", own: "In-space Notifications" },
    { id: "font", label: "UI/Accessories/Log/FontSize", own: "Font Size" },
    { id: "align", label: "UI/Accessories/Log/InspaceNotificationFontAlignment", own: "Font Alignment" },
  ] as const;
  let combatOpen = $state(false);
  let combatSub = $state<string | null>(null);

  const newestFirst = $derived([...$notices].reverse());

  /** A wall-clock time for a log line. Local, unlike the Neocom's EVE clock —
   *  this is "when did this happen to me", not a time to quote to a fleet. */
  function at(atMs: number): string {
    const date = new Date(atMs);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function kindWord(kind: string): string {
    return kind === "danger" ? "Alert" : kind === "warn" ? "Warning" : kind === "good" ? "Done" : "Note";
  }
</script>

<!--
  ⚠ `panel` IS LOAD-BEARING, NOT DECORATION. `.panel-head`'s negative inline
  margin exists to bleed to the edges of a PADDED panel, and a windowed panel
  has no padding — so the stylesheet cancels the bleed with
  `.win-body > .panel > .panel-head`. Without `panel` on this section that rule
  does not match, the head hangs 16px outside on each side, and the window
  scrolls sideways (R8). Measured live at 5px, the moment this panel became
  reachable at all.
-->
<section class="panel notice-log">
  <div class="panel-head">
    <h2 class="panel-title">Log</h2>
    <span class="controls">
      <button type="button" class="minor" disabled={$notices.length === 0} onclick={() => noticeBoard.clear()}>
        Clear
      </button>
    </span>
  </div>

  {#if retail}
    <div class="log-actions">
      <button type="button" class="log-filter" title={w("UI/Generic/Filters", "Filters")} aria-expanded={filterOpen} onclick={() => { filterOpen = !filterOpen; combatOpen = false; }}>
        <img alt="" src="/client-res/ui/texture/eveicon/system_icons/filter_16px.png" /></button>
      {#if filterOpen}
        <div class="log-menu" role="menu">
          <span class="caption">{w("UI/Accessories/Log/MessageTypesToLog", "Message Types To Log")}</span>
          {#each LOG_FILTERS as f (f.type)}
            <button type="button" role="menuitemcheckbox" aria-checked={$logFilters[f.type] !== false} onclick={() => setLogFilter(f.type, $logFilters[f.type] === false)}>{w(f.label, f.type)}</button>
          {/each}
          <span class="caption">{w("UI/Accessories/Log/NumMessagesInLogView", "Messages in Log View")}</span>
          {#each LOG_COUNTS as count (count)}
            <button type="button" role="menuitemradio" aria-checked={$logCount === count} onclick={() => setLogCount(count)}>{count}</button>
          {/each}
        </div>
      {/if}
      <!-- the combat settings (MenuButtonIcon eveicon.settings, UI/Accessories/Log/CombatSettings):
           _get_combat_message_menu's four submenus -->
      <button type="button" class="log-filter combat-settings" title={w("UI/Accessories/Log/CombatSettings", "Combat Settings")} aria-expanded={combatOpen}
        onclick={() => { combatOpen = !combatOpen; filterOpen = false; combatSub = null; }}>
        <img alt="" src="/client-res/ui/texture/eveicon/system_icons/settings_16px.png" /></button>
      {#if combatOpen}
        <div class="log-menu combat-menu" role="menu" style:left="24px">
          {#each COMBAT_SUBMENUS as sub (sub.id)}
            <div class="log-sub-wrap" role="none" onmouseenter={() => (combatSub = sub.id)}>
              <button type="button" class="has-sub" role="menuitem" aria-haspopup="menu" aria-expanded={combatSub === sub.id} onclick={() => (combatSub = sub.id)}>{w(sub.label, sub.own)}</button>
              {#if combatSub === sub.id}
                <div class="log-menu log-sub" role="menu">
                  {#if sub.id === "display"}
                    {#each COMBAT_DISPLAY_SETTINGS as s (s.key)}
                      <button type="button" role="menuitemcheckbox" aria-checked={$combatFlags[s.key] !== false} disabled={!combatSettingEnabled(s, $combatFlags)}
                        title={s.hint ? w(s.hint, "") : undefined} onclick={() => setCombatFlag(s.key, $combatFlags[s.key] === false)}>{w(s.label, s.key)}</button>
                    {/each}
                  {:else if sub.id === "inspace"}
                    {#each COMBAT_INSPACE_SETTINGS as s, i (s.key)}
                      <button type="button" role="menuitemcheckbox" aria-checked={$combatFlags[s.key] !== false} disabled={!combatSettingEnabled(s, $combatFlags)}
                        onclick={() => setCombatFlag(s.key, $combatFlags[s.key] === false)}>{w(s.label, s.key)}</button>
                      {#if i === 0}<span class="sep" role="separator"></span>{/if}
                    {/each}
                    <span class="sep" role="separator"></span>
                    <button type="button" role="menuitem" class="has-icon" onclick={() => { combatMovingMode.set(!$combatMovingMode); combatOpen = false; }}>
                      <img alt="" src="/client-res/ui/texture/eveicon/system_icons/caret_up_down_left_right_16px.png" />
                      {$combatMovingMode ? w("UI/Accessories/Log/ExitMessageMovingMode", "Exit Message Moving Mode") : w("UI/Accessories/Log/EnterMessageMovingMode", "Enter Message Moving Mode")}</button>
                  {:else if sub.id === "font"}
                    {#each COMBAT_FONT_SIZES as size (size)}
                      <button type="button" role="menuitemradio" aria-checked={$combatFontSize === size} onclick={() => setCombatFontSize(size)}>{size}</button>
                    {/each}
                  {:else}
                    {#each COMBAT_ALIGNMENTS as a (a)}
                      <button type="button" role="menuitemradio" aria-checked={$combatAlignment === a} onclick={() => setCombatAlignment(a)}>{w(COMBAT_ALIGNMENT_LABELS[a], a)}</button>
                    {/each}
                    <span class="sep" role="separator"></span>
                    <button type="button" role="menuitem" class="destructive" onclick={() => { resetCombatAlignment(); combatOpen = false; }}>{w("UI/Accessories/Log/ResetAlignment", "Reset Alignment")}</button>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <table class="log-table">
      <thead><tr><th>{w("UI/Common/DateWords/Time", "Time")}</th><th>{w("UI/Accessories/Log/Type", "Type")}</th><th>{w("UI/Accessories/Log/Message", "Message")}</th></tr></thead>
      <tbody>
        {#each logLines as line (line.n)}
          <tr><td>{at(line.atMs)}</td><td style:color={LOG_TYPE_COLOURS[line.type] ?? "#ffffff"}>{LOG_TYPE_LABELS[line.type] ? w(LOG_TYPE_LABELS[line.type]!, line.type) : line.type}</td>
            <td>{line.text}</td></tr>
        {/each}
      </tbody>
    </table>
  {:else if newestFirst.length === 0}
    <p class="empty">Nothing has happened yet.</p>
  {:else}
    <ul class="notice-list">
      {#each newestFirst as notice (notice.id)}
        <li class={`notice ${notice.kind}`}>
          <span class="notice-time">{at(notice.atMs)}</span>
          <!-- The severity as a WORD. The row's colour repeats it; it never
               carries it alone. -->
          <span class="notice-kind">{kindWord(notice.kind)}</span>
          <span class="notice-text">
            <span class="notice-title">{notice.title}</span>
            {#if notice.detail}
              <span class="notice-detail">{notice.detail}</span>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>
