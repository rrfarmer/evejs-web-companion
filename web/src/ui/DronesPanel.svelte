<script lang="ts">
  // Drones, as their own window — lifted whole out of `Overview.svelte`'s
  // drones section. Two lists, because they are two different things: what is
  // sitting in the bay (launchable) and what is already flying (orderable).
  //
  // ⚠ LAUNCHING IS THE DEFENCE. The server auto-engages idle combat drones
  // against whatever shoots your ship, so a miner who launches is defended
  // without touching Attack at all. The note below says that plainly, because a
  // player who does not know it will sit there clicking.
  //
  // The two limits are SHOWN and never enforced here: the server owns both, and
  // a browser that pre-guessed them would either block a legal launch or
  // promise an illegal one.
  //
  // ⚠ WHAT CHANGED IN THE LIFT, AND WHAT DID NOT. Every R33/R34 rule below, and
  // every word of the refusal wording, is the original. Two things are new:
  //
  //   • It is a WINDOW, so the `<details>` wrapper went with the move. A window
  //     you have to unfold after opening it is one click too many.
  //   • The target is the first LOCKED target — see `autoTargetID`.
  import {
    DRONE_NOT_UNDER_YOUR_CONTROL,
    NO_DRONE_UNDER_YOUR_CONTROL,
    panelErrorWords,
  } from "../bridge/refusals.ts";
  import { droneActivityLabel, droneIsBusy } from "../bridge/drones.ts";
  import { canMyShipOrderDrone } from "../space/overview.ts";
  import { orderableDroneIDs, salvageDroneIDs } from "./droneFlight.ts";
  import { resolvedName } from "../store/names.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { NameRef, SpaceEntity } from "../store/types.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const drones = store.drones;
  // svelte-ignore state_referenced_locally
  const targeting = store.targeting;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  const snapshot = $derived($space.snapshot);
  const ship = $derived(snapshot?.ship ?? null);
  const droneBay = $derived($drones.bay);
  const dronesInSpace = $derived($drones.inSpace);
  const droneLimits = $derived($drones.limits);

  /**
   * The target a group order acts on: the first LOCKED target, or 0 for none.
   *
   * ⚠ THE EXPLICIT PICKER DID NOT COME WITH THE LIFT, AND THAT IS DELIBERATE.
   * `Overview.svelte` had a "Use it on" select — but it belonged to the
   * EQUIPMENT table, and drones merely read whatever it was set to. A drones
   * window carrying its own copy would be a second control over one setting,
   * in a window that may not even be open. Locking is how a pilot picks what
   * their gear acts on, here and in retail; the overview panel is where locking
   * happens and it is on screen beside this window.
   */
  const autoTargetID = $derived($targeting.lockedTargetIDs[0] ?? 0);

  /** What to call something on the grid. Never an id (R7d). */
  function displayLabel(entity: SpaceEntity): string {
    if (entity.name && entity.name.length > 0) {
      return entity.name;
    }
    const type = resolvedName($names.resolved, "type", entity.typeID, "");
    return type.length > 0 ? type : "Unknown object";
  }

  /** The bay's stacks, by NAME. The bay's flagID never reaches this file. */
  const bayRows = $derived.by(() =>
    (droneBay ?? []).map((stack) => ({
      itemID: stack.itemID,
      label: resolvedName($names.resolved, "type", stack.typeID, "Unknown drone"),
      quantity: stack.quantity,
    })),
  );

  /** Drones in space, the ones with a job first so a busy flight reads at a glance. */
  const spaceRows = $derived.by(() => {
    const byID = new Map<number, SpaceEntity>();
    for (const entity of snapshot?.entities ?? []) {
      byID.set(entity.itemID, entity);
    }
    return (dronesInSpace ?? [])
      .map((drone) => {
        const target = drone.targetID === null ? null : (byID.get(drone.targetID) ?? null);
        // R33 — can this ship actually ORDER it? The panel lists a drone when it
        // is owned by me OR flown by my hull; the server only obeys the second.
        // `null` is "we cannot tell", and it is NOT the same as false.
        const orderable = canMyShipOrderDrone(byID.get(drone.itemID) ?? null, ship?.itemID ?? null);
        return {
          itemID: drone.itemID,
          label:
            drone.name && drone.name.length > 0
              ? drone.name
              : resolvedName($names.resolved, "type", drone.typeID, "Drone"),
          activity: droneActivityLabel(drone.activity),
          busy: droneIsBusy(drone.activity),
          // The ball it is busy with, by NAME. A target the snapshot no longer
          // carries simply has no name to show, so it shows none (R7d).
          targetLabel: target === null ? "" : displayLabel(target),
          // The R30 shape: a reason, or null. Only a HARD false earns one — a
          // `null` orderable leaves the control live to get a real answer.
          //
          // TWO SOURCES, THE HARDER ONE FIRST. `controlled` is the BFF's own
          // answer and is always present; `canMyShipOrderDrone` reads the
          // SNAPSHOT, which may simply not carry the drone's row and then
          // honestly answers "cannot tell". Preferring the flag also keeps the
          // panel self-consistent: a drone offered Reconnect must never sit
          // beside a live Bring home, which is what a null snapshot answer
          // would have produced.
          unavailable:
            drone.controlled === false || orderable === false
              ? DRONE_NOT_UNDER_YOUR_CONTROL
              : null,
          // ⚠ NOT ORDERABLE USED TO BE A DEAD END. A drone this character owns
          // that this hull does not fly could be seen and nothing else — no
          // recall, no engage, and no way back. Recovery is offered on the BFF's
          // definite answer only: a drone we merely could not check is left
          // alone, exactly as R33 left its order buttons alone.
          recoverable: drone.controlled === false,
        };
      })
      .sort((left, right) => Number(right.busy) - Number(left.busy));
  });

  /**
   * Every drone the group buttons may act on (goal R33).
   *
   * ⚠ THIS INCLUDES THE ONES WE CANNOT JUDGE, and that is the point. Only a
   * drone we have POSITIVELY established is not ours to fly is dropped; a drone
   * the snapshot does not carry stays in, because "we could not check" must
   * never quietly narrow what a group order does.
   *
   * ⚠ AND IT NEVER EMPTIES THE GROUP FOR THE REST. One un-orderable drone
   * removes itself from the list and nothing else — the other drones are still
   * recalled, still attack, still mine. Capability is only ever removed from the
   * drone that provably does not have it.
   */
  const allDroneIDs = $derived(
    orderableDroneIDs(dronesInSpace, snapshot?.entities ?? null, ship?.itemID ?? null),
  );

  /**
   * The salvage drones among those, which are the ones a salvage order is for.
   *
   * The client offers Salvage for a salvage drone its ship controls and for no
   * other (droneCheckers.OfferSalvage), and its primary action sends the order
   * to the salvage drones among those chosen. A drone whose kind has not been
   * read yet is not one: "cannot tell" offers nothing.
   */
  const salvageIDs = $derived(
    salvageDroneIDs(allDroneIDs, dronesInSpace, (typeID) => resolvedName($names.resolved, "typeGroup", typeID, "")),
  );

  /**
   * The reason a GROUP order cannot run, or null.
   *
   * It is only ever set when there are drones out and NOT ONE of them is ours to
   * fly — the whole-flight version of the per-row sentence. With a mixed flight
   * the button stays live and quietly acts on the ones it can.
   */
  const groupOrderUnavailable = $derived(
    spaceRows.length > 0 && allDroneIDs.length === 0 ? NO_DRONE_UNDER_YOUR_CONTROL : null,
  );

  /**
   * Why an order that needs a TARGET cannot run, or null.
   *
   * ⚠ THIS IS A REASON, NOT AN EXPLANATION, and the difference is where it
   * goes. It used to be a paragraph under the buttons saying "Lock something
   * first to give your drones a target" — a line a player reads once and then
   * reads past forever, sitting below a control that was greyed out in silence.
   * R30's rule puts it ON the control: the button says what is stopping it.
   *
   * The flight gate comes first: if none of these drones are ours to fly, that
   * is true whatever is locked.
   */
  const targetOrderUnavailable = $derived(
    groupOrderUnavailable ?? (autoTargetID <= 0 ? "Lock something first" : null),
  );

  /**
   * How many drones are OUT, in three words.
   *
   * ⚠ IT CAME WITH THE LIFT, AND IT IS NOT REDUNDANT WITH THE LIST BELOW.
   * In the cockpit this was the collapsed section's summary — the one fact a
   * folded panel was never allowed to hide. A window can be MINIMIZED, which is
   * the same problem wearing different chrome, and it is the same fact: drones
   * are out, they are defending you, and they do not come home on their own.
   *
   * It is also the only place the count survives when the server did not tell
   * us the limit — `droneLimitText` reads "not known" then, and a count folded
   * into a limit that is unknown is a count that disappears.
   *
   * `null` stays "we could not look", never "none out".
   */
  const droneSummary = $derived.by(() => {
    if (dronesInSpace === null) {
      return $drones.loaded ? "Could not be read" : "Looking…";
    }
    if (spaceRows.length === 0) {
      return (droneBay ?? []).length > 0 ? "None out" : "None";
    }
    return spaceRows.length === 1 ? "1 out" : `${spaceRows.length} out`;
  });

  const droneLimitText = $derived.by(() => {
    const parts: string[] = [];
    // null is "not known", never 0 — a hull with no drone bay and a read that
    // failed look identical from here, and neither may be shown as a hard zero.
    parts.push(
      droneLimits.maxActiveDrones === null
        ? "Drones at once: not known"
        : `Drones at once: ${spaceRows.length} of ${droneLimits.maxActiveDrones}`,
    );
    parts.push(
      droneLimits.droneBandwidth === null
        ? "Bandwidth: not known"
        : `Bandwidth: ${droneLimits.droneBandwidth} Mbit/sec`,
    );
    return parts.join(" · ");
  });

  // Which bay stacks the player has picked to launch.
  let launchPicks = $state<Record<number, boolean>>({});
  const pickedForLaunch = $derived(
    bayRows.filter((row) => launchPicks[row.itemID] === true).map((row) => row.itemID),
  );
  function toggleLaunchPick(itemID: number): void {
    launchPicks = { ...launchPicks, [itemID]: launchPicks[itemID] !== true };
  }

  // Drone names come from the same cache as everything else (R7d), and this
  // panel asks for its own rather than relying on another component's mount —
  // the lesson the module rack learned when the overview became a window.
  $effect(() => {
    const refs: NameRef[] = [];
    for (const stack of droneBay ?? []) {
      refs.push({ kind: "type", id: stack.typeID });
    }
    for (const drone of dronesInSpace ?? []) {
      if (drone.typeID !== null) {
        refs.push({ kind: "type", id: drone.typeID });
        // What KIND of drone it is, which is what says it may be sent to salvage.
        refs.push({ kind: "typeGroup", id: drone.typeID });
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // And it asks for the drone slice itself, once, for the same reason: opening
  // this window on a session where nothing else asked must not show an empty
  // bay that looks like "you have no drones".
  $effect(() => {
    if (!$drones.loaded) {
      void flow.loadDrones().catch(() => {});
    }
  });

  let busy = $state(false);
  let error = $state("");

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "The live session ended (idle timeout or another client took over)."
        : panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section class="panel drones-panel">
  <div class="panel-head">
    <h2 class="panel-title">Drones</h2>
    <!-- The one fact a put-away window may never hide: how many are out. -->
    <span class="drone-summary">{droneSummary}</span>
  </div>

  <!--
    ⚠ NO PARAGRAPH EXPLAINING HOW DRONES WORK. There was one, and it is gone at
    the operator's call: "UI is not a place to explain how drones work". The
    rule it stated — that launched drones defend you on their own — is true and
    is still worth a player knowing; a panel is not where they learn it.

    What stays is STATE (the server's limits) and REASONS on the controls that
    cannot run. Neither is explanation: one is what your ship reports, the other
    is why a button will not do anything, and R30 puts that on the button.
  -->
  <p class="note">{droneLimitText}</p>
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  {#if $drones.error}
    <p class="error">{$drones.error}</p>
  {/if}
  {#if $drones.actionError}
    <p class="error">{$drones.actionError}</p>
  {/if}
  {#if $drones.silentDecline}
    <p class="error">{$drones.silentDecline}</p>
  {/if}
  <!--
    R34 — WHAT THE SERVER ITSELF SAID, ONE LINE PER DRONE.

    ⚠ THESE ARE NOT OUR WORDS. `droneRuntime.js` refuses a drone order one drone
    at a time and writes a plain-language sentence for each — thirteen of them
    across engage, mine, salvage, scoop and recall. The BFF used to forward only
    the notifications, so every one of those sentences was thrown away and a
    refused order looked, to the player, exactly like a successful one. This is
    the recovered text, unedited.

    ⚠ AND IT IS A LIST FOR R30'S REASON. An order fans out over the whole flight
    and each drone answers separately; the error paragraphs above are single
    slots, and R30 measured what a single slot does to a fan-out — with two Strip
    Miner Is, a later success cleared the slot and the earlier refusal vanished.
    One drone, one line, no merging, no deduplication.

    ⚠ NAMES ONLY (R7d). The server keys these by droneID; `flow.ts` spends that
    key on a name lookup and the report type has no id field at all, so there is
    nothing here for this markup to leak. A drone we cannot name reads "One of
    your drones" — never the number.
  -->
  {#if $drones.orderReports.length > 0}
    <ul class="drone-reports">
      {#each $drones.orderReports as report}
        <li class="error">
          <span class="drone-name">{report.label ?? "One of your drones"}</span>
          <span class="drone-outcome">{report.text}</span>
        </li>
      {/each}
    </ul>
  {/if}

  <h3>In space</h3>
  {#if dronesInSpace === null}
    <!-- null is "we could not look", which must never read as "none out". -->
    <p class="note">
      {$drones.loaded ? "Your drones in space could not be read." : "Looking…"}
    </p>
  {:else if spaceRows.length === 0}
    <p class="empty">No drones out.</p>
  {:else}
    <ul class="drone-list">
      {#each spaceRows as drone (drone.itemID)}
        <li>
          <span class="drone-name">{drone.label}</span>
          <span class="drone-activity">
            {drone.activity}{drone.targetLabel ? ` — ${drone.targetLabel}` : ""}
          </span>
          <span class="row-actions">
            <!--
              R33 — the control says what it can do, or why it cannot.

              ⚠ THE REASON IS THE LABEL, exactly as R30's haul verb does it. A
              greyed "Bring home" with the explanation hidden in a tooltip is the
              silent decline again, one layer up: a player on a touch screen
              never sees a `title`, and a player who does see it has already
              pressed. This is the ninth confirmed silent decline on this server,
              and every one of them looked like a live button.
            -->
            <button
              type="button"
              disabled={busy || drone.unavailable !== null}
              title={drone.unavailable ?? ""}
              onclick={() => run(() => flow.recallDrones([drone.itemID]))}
            >
              {drone.unavailable ?? "Bring home"}
            </button>
            {#if drone.recoverable}
              <!--
                The way back for a drone this hull cannot fly. Two verbs because
                they fail for different reasons and one covers the other:
                Reconnect needs the drone to answer, Scoop needs only range. Both
                are live whenever the drone is out of control, and the SERVER
                decides which one works — the panel would have to guess at
                distance to pre-refuse either.
              -->
              <button
                type="button"
                disabled={busy}
                title="Take control of this drone again"
                onclick={() => run(() => flow.reconnectDrones([drone.itemID]))}
              >
                Reconnect
              </button>
              <button
                type="button"
                disabled={busy}
                title="Pull this drone straight into your bay"
                onclick={() => run(() => flow.scoopDrones([drone.itemID]))}
              >
                Scoop
              </button>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
    <p class="controls">
      <!--
        Acting on the LOCKED target, reusing R23's auto-target default: locking
        something makes it what your equipment acts on, and drones are no
        different. (The server does not actually require a lock for CmdEngage —
        this is a UI choice, so a player only ever sends drones at something they
        deliberately picked.)

        R33 — all three group orders carry the SAME server gate. eve.js refuses
        recall, engage and mine alike unless the drone's controllerID is this
        hull, so all three act on `allDroneIDs`, which has already dropped the
        drones we know are not ours to fly — and kept every drone we could not
        check.
      -->
      <button
        type="button"
        disabled={busy || targetOrderUnavailable !== null}
        title={targetOrderUnavailable ?? ""}
        onclick={() => run(() => flow.engageDrones(allDroneIDs, autoTargetID))}
      >
        {targetOrderUnavailable ?? "Attack what I have locked"}
      </button>
      <button
        type="button"
        disabled={busy || targetOrderUnavailable !== null}
        title={targetOrderUnavailable ?? ""}
        onclick={() => run(() => flow.mineWithDrones(allDroneIDs, autoTargetID))}
      >
        {targetOrderUnavailable ?? "Mine what I have locked"}
      </button>
      {#if salvageIDs.length > 0}
        <!--
          A salvage drone's own order, and only where one is out. With nothing
          locked it is sent with no target, as the client sends it with nothing
          targeted (droneFunctions.py 157), and the server finds each drone a
          wreck of the pilot's or its fleet's.
        -->
        <button
          type="button"
          disabled={busy}
          onclick={() => run(() => flow.salvageDrones(salvageIDs, autoTargetID > 0 ? autoTargetID : null))}
        >
          {autoTargetID > 0 ? "Salvage what I have locked" : "Salvage any wreck"}
        </button>
      {/if}
      <button
        type="button"
        disabled={busy || groupOrderUnavailable !== null}
        title={groupOrderUnavailable ?? ""}
        onclick={() => run(() => flow.recallDrones(allDroneIDs))}
      >
        {groupOrderUnavailable ?? "Bring them all home"}
      </button>
    </p>
  {/if}

  <h3>In the bay</h3>
  {#if droneBay === null}
    <p class="note">
      {$drones.loaded ? "Your drone bay could not be read." : "Looking…"}
    </p>
  {:else if bayRows.length === 0}
    <p class="empty">Nothing in the drone bay.</p>
  {:else}
    <ul class="drone-list">
      {#each bayRows as stack (stack.itemID)}
        <li>
          <label class="drone-pick">
            <input
              type="checkbox"
              checked={launchPicks[stack.itemID] === true}
              onchange={() => toggleLaunchPick(stack.itemID)}
            />
            <span class="drone-name">{stack.label}</span>
          </label>
          <span class="drone-activity">In the bay</span>
          <span class="row-actions">
            <button
              type="button"
              disabled={busy}
              onclick={() => run(() => flow.launchDrones([stack.itemID]))}
            >
              Launch
            </button>
          </span>
        </li>
      {/each}
    </ul>
    <p class="controls">
      <button
        type="button"
        disabled={busy || pickedForLaunch.length === 0}
        onclick={() => run(() => flow.launchDrones(pickedForLaunch))}
      >
        Launch the ones I picked
      </button>
    </p>
  {/if}
</section>
