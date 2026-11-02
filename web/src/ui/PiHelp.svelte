<script lang="ts">
  // HOW PLANETARY INDUSTRY WORKS: the window's one help, opened from the "?"
  // beside Refresh. One section per view, in the menu's order; it opens on
  // the view the player is looking at.
  //
  // ⚠ GENERAL, NEVER A PILOT'S PARTICULARS. What a click will do for THIS
  // pilot (where the haul delivers, how many extractors a restart takes) stays
  // on the pilot's own line, before its button. This says how things work.
  //
  // ⚠ EVERY CLAIM IS THE CODE'S. Thresholds are the modules' own constants
  // (bridge/piCoverage.ts, bridge/piBoard.ts, app/piDispatch.ts); change one
  // there and this text is wrong until it is changed here too.
  import { tick } from "svelte";

  type Section = "colonies" | "stock" | "coverage" | "planner" | "pilots";

  interface Props {
    open: boolean;
    /** The section to open on: the view the window shows. */
    section: Section;
    onClose: () => void;
  }

  let { open, section, onClose }: Props = $props();
  let dialog = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      void tick().then(() => dialog?.querySelector(`#pi-help-${section}`)?.scrollIntoView({ block: "start" }));
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });
</script>

<dialog
  bind:this={dialog}
  class="pi-help"
  aria-labelledby="pi-help-title"
  onclose={onClose}
  onclick={(event) => {
    // A click on the backdrop lands on the dialog itself.
    if (event.target === dialog) onClose();
  }}
>
  {#if open}
  <header class="pi-help-head">
    <h2 id="pi-help-title">How Planetary Industry works</h2>
    <button type="button" class="pi-help-close" aria-label="Close" onclick={onClose}>Close</button>
  </header>
  <div class="pi-help-body">
    <section id="pi-help-colonies">
      <h3>Colonies</h3>
      <p>
        Every colony of every pilot on your list, one line per pilot. A pilot's line says how many colonies need you,
        how full the fullest one is, and what a run for that pilot is doing. Open a line to see its colonies, worst first.
        Lines that need you open by themselves. Normal shows planet icons and two bars per colony; Compact puts each
        colony on one line.
      </p>
      <p>
        Red means it needs you now: an extractor has ended or storage is full. Amber means soon: a program ends within a
        day or storage is 80% full.
      </p>
      <h4>Haul</h4>
      <ol>
        <li>What the ticked colonies' launchpads hold goes up into their customs offices first, before any bot starts.</li>
        <li>
          A server run then launches what the command centres hold (the launch is taxed) and boards a ship with a planetary
          hold parked where the pilot is docked.
        </li>
        <li>It flies to each colony's system, empties those customs offices and collects the launches.</li>
        <li>
          It flies to the pilot's Deliver to station, unloads into the picked division, flies back and gets back into the
          ship it started in.
        </li>
      </ol>
      <p>
        A haul runs for two hours at most. Goods put in a corporation hangar belong to the corporation; if the office or
        your role is gone when the ship docks, they go into the pilot's own hangar. "Change" on a pilot's haul line picks
        where it delivers and which division it unloads into. "Tick colonies 70%+ full" ticks that pilot's colonies whose storage is
        at least 70% full.
      </p>
      <h4>Before you haul</h4>
      <ul>
        <li>A ship with a planetary hold (an Epithal) parked at the pilot's station.</li>
        <li>ISK in the pilot's wallet for the customs tax.</li>
        <li>For a corporation division: an office at the Deliver to station and the role to use it.</li>
        <li>The pilot must not be flown by another bot or logged in elsewhere. The server refuses, and the pilot's line says why.</li>
      </ul>
      <h4>Restart extractors</h4>
      <p>
        Restarts every ended extractor on all of the pilot's colonies, and re-sizes the storage routes of any extractor
        that yields more than they carry. It changes nothing else and runs for an hour at most. It cannot be aimed at one
        planet. The button says how many extractors it will restart.
      </p>
      <h4>While a run flies</h4>
      <p>
        The pilot's line shows the route and what the bot is doing, and each colony in a haul says whether it is queued,
        being collected or collected. A paused or stopped run is also shown at the top of the view; Stop ends a paused run.
        When a run ends, that pilot's colonies are read again. Its full log is in the Bot Manager.
      </p>
      <p>
        Reading colonies brings nobody online. Acting does, and only through the server, which will not take a pilot
        already flown from this site or by another bot.
      </p>
    </section>

    <section id="pi-help-stock">
      <h3>Stock</h3>
      <p>
        Every planetary commodity the pilots on your list hold, one row per commodity, by tier. "In colonies" counts colony
        storage, launchpads and factory inputs; "In hangars" counts personal hangars, ships and containers; "Corp" counts
        corporation hangars. Open a row to see each place the goods sit, whose they are and how long ago they were read.
        Narrow the list with the tier buttons or "Find a commodity".
      </p>
      <p>
        A corporation's hangars are read only through a pilot of that corporation who is online in this tab or flown by a
        server bot. When there is none, that corporation is left out and "Where this came from" says so.
      </p>
    </section>

    <section id="pi-help-coverage">
      <h3>Coverage</h3>
      <p>
        What the colonies you have read make, tier by tier. "Per hour" is an up-to figure: what the installed extractor
        programs can pull and what running factories can make. An ended program counts as zero. Open a row to see each
        colony behind it, its richness and when its program ends.
      </p>
      <p>
        "Balanced" is shown for basics (P1) only: each basic's share of your current basic output, split the way the
        recipes use them to make every P4 once. A basic is short when it is under 85% of its balanced figure. A weak colony
        makes under three quarters of the typical colony on the same resource.
      </p>
    </section>

    <section id="pi-help-planner">
      <h3>Planner</h3>
      <p>
        "+ New" starts a plan: "Make a commodity" or "Expand colonies". A commodity plan is saved on the server as soon as
        it is created. The stock you hold is taken off before inputs are worked out (stock sitting in factory inputs is
        not counted), and each step says what is missing and where the goods are. Plans do not share stock, so two plans
        can count the same units. Open "Full chain" for the whole tree.
      </p>
      <p>
        An expansion plan looks around a system you already work, within the jumps you give, and "Propose colonies" fills
        your pilots' free colony slots with the richest planets it knows. Unknown richness ranks last. Nothing is saved
        until "Keep this plan". "Mark done" files a plan under Done, where it can be deleted.
      </p>
    </section>

    <section id="pi-help-pilots">
      <h3>Pilots</h3>
      <p>
        The characters this window reads. Add one pilot, or everyone in a squad; a squad is copied once and is not linked
        afterwards. Pilots are grouped by account.
      </p>
      <p>
        Refresh signs each account in briefly, reads its pilots' colonies and signs out. Nothing is selected, undocked or
        brought online. Each pilot's line says when it was read, or why it was not. The last colonies read are kept and
        shown with their age. Removing a pilot takes it off this list only. The list is kept in this browser.
      </p>
    </section>
  </div>
  {/if}
</dialog>

<style>
  .pi-help {
    width: min(42rem, calc(100vw - 2rem));
    max-height: calc(100vh - 4rem);
    padding: 0;
    border: 1px solid var(--color-line-strong);
    background: var(--color-panel);
    color: var(--color-text);
  }
  .pi-help::backdrop {
    background: rgb(0 0 0 / 0.6);
  }
  .pi-help-head {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-panel);
  }
  .pi-help-head h2 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--color-text-bright);
  }
  .pi-help-body {
    padding: 0.25rem 1rem 1rem;
    line-height: 1.5;
  }
  .pi-help-body section + section {
    border-top: 1px solid var(--color-line);
    margin-top: 0.75rem;
  }
  .pi-help-body h3 {
    margin: 0.75rem 0 0.35rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-text-bright);
  }
  .pi-help-body h4 {
    margin: 0.75rem 0 0.25rem;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--color-text-bright);
  }
  .pi-help-body p {
    margin: 0.35rem 0;
  }
  .pi-help-body ol,
  .pi-help-body ul {
    margin: 0.25rem 0;
    padding-left: 1.25rem;
  }
</style>
