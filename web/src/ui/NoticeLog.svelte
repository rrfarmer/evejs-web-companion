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
  /** On the play page the log as LoggerWindow lists it (uilog.py: its scroll's headers Time, Type, Message). */
  const retail = getContext("retailChrome") === true;

  const notices = noticeBoard.notices;

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

  {#if newestFirst.length === 0}
    <p class="empty">Nothing has happened yet.</p>
  {:else if retail}
    <table class="log-table">
      <thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead>
      <tbody>
        {#each newestFirst as notice (notice.id)}
          <tr class={`notice ${notice.kind}`}><td>{at(notice.atMs)}</td><td>{kindWord(notice.kind)}</td>
            <td>{notice.title}{#if notice.detail}: {notice.detail}{/if}</td></tr>
        {/each}
      </tbody>
    </table>
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
