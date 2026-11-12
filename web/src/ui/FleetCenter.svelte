<script lang="ts">
  import { getContext, onMount } from "svelte";
  import { isSessionLost } from "../app/flow.ts";
  import { nameKey, resolvedName } from "../store/names.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { memberWhereabouts } from "../bridge/fleetCenter.ts";
  import FleetHistory from "./FleetHistory.svelte";
  import PlaceRouteMenu from "./PlaceRouteMenu.svelte";
  import type { FleetMember, FleetSquad, FleetWing } from "../bridge/boundFleet.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const fleet = store.fleet;
  const words = store.words;
  /**
   * fleetwindow.FleetWindow on the play page (500 x 400, the tabs in the header - TabNavigationWindowHeader): in a
   * fleet Fleet, Broadcasts, Respawn, Formations, Advert, Find Fleets (UI/Fleet/Fleet, UI/Fleet/FleetWindow/Broadcasts,
   * UI/Fleet/Respawn/Respawn, UI/Fleet/FleetFormations/Formations, UI/Fleet/FleetRegistry/Advert,
   * UI/Fleet/FleetRegistry/FindFleets); out of one Fleet (Tooltips/Neocom/Fleet: PanelFormFleet - FormFleetHeader,
   * FormFleetDescription, then Form Fleet and the setup combo, Default Setup, at the bottom) and Fleet Finder.
   */
  const retail = getContext("retailChrome") === true;
  type FleetTab = "fleet" | "broadcasts" | "respawn" | "formations" | "advert" | "find" | "form" | "finder";
  let chosenFleetTab = $state<FleetTab | null>(null);
  const inFleet = $derived($fleet.loaded && $fleet.availability !== "not-in-fleet" && $fleet.availability !== "unavailable" && $fleet.fleet !== null);
  const fleetTabs = $derived<readonly { id: FleetTab; label: string; own: string }[]>(inFleet
    ? [{ id: "fleet", label: "UI/Fleet/Fleet", own: "Fleet" }, { id: "broadcasts", label: "UI/Fleet/FleetWindow/Broadcasts", own: "Broadcasts" },
       { id: "respawn", label: "UI/Fleet/Respawn/Respawn", own: "Respawn" }, { id: "formations", label: "UI/Fleet/FleetFormations/Formations", own: "Formations" },
       { id: "advert", label: "UI/Fleet/FleetRegistry/Advert", own: "Advert" }, { id: "find", label: "UI/Fleet/FleetRegistry/FindFleets", own: "Find Fleets" }]
    : [{ id: "form", label: "Tooltips/Neocom/Fleet", own: "Fleet" }, { id: "finder", label: "UI/Fleet/FleetWindow/FleetFinder", own: "Fleet Finder" }]);
  const fleetTab = $derived<FleetTab>(chosenFleetTab !== null && fleetTabs.some((t) => t.id === chosenFleetTab) ? chosenFleetTab : fleetTabs[0]?.id ?? "form");
  function fleetWord(label: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? template : "";
  }
  onMount(() => {
    if (retail) flow.requestWords(["UI/Fleet/Fleet", "UI/Fleet/FleetWindow/Broadcasts", "UI/Fleet/Respawn/Respawn", "UI/Fleet/FleetFormations/Formations",
      "UI/Fleet/FleetRegistry/Advert", "UI/Fleet/FleetRegistry/FindFleets", "Tooltips/Neocom/Fleet", "UI/Fleet/FleetWindow/FleetFinder",
      "UI/Fleet/FleetWindow/FormFleetHeader", "UI/Fleet/FleetWindow/FormFleetDescription", "UI/Fleet/FleetWindow/FormFleet", "UI/Fleet/FleetWindow/DefaultSetup"]);
  });
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;

  let refreshError = $state("");
  let inviteeText = $state("");

  const roster = $derived($fleet.fleet?.initState.value.members ?? []);
  // Shared by the strip's stat-line and the fleet-summary count below so the
  // two can never drift into naming the same roster two different ways.
  const rosterCountWords = $derived(`${roster.length} ${roster.length === 1 ? "member" : "members"}`);
  const wings = $derived($fleet.fleet?.initState.value.wings ?? []);
  const joinRequests = $derived($fleet.fleet?.joinRequests.value ?? []);
  // What each member flies and where: the composition's word, as the client's own window for these has it.
  const composition = $derived($fleet.fleet?.composition.value ?? []);
  const inviteeID = $derived(parseCharacterID(inviteeText));
  const inviteeName = $derived(
    inviteeID === null ? null : ($names.resolved[nameKey("character", inviteeID)] ?? null),
  );
  const busy = $derived($fleet.activeAction !== null);

  function positiveID(value: number | string | null): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : null;
  }

  function parseCharacterID(value: string): number | null {
    if (!/^\d+$/.test(value.trim())) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function memberName(member: FleetMember): string {
    const characterID = positiveID(member.charID);
    if (characterID !== null && characterID === $station.online?.characterID) {
      return $station.online.characterName || "You";
    }
    return resolvedName($names.resolved, "character", characterID, "Fleet member");
  }

  function memberRole(member: FleetMember): string {
    switch (member.role) {
      case 1:
        return "Fleet commander";
      case 2:
        return "Wing commander";
      case 3:
        return "Squad commander";
      default:
        return "Member";
    }
  }

  function memberShip(member: FleetMember): string {
    return resolvedName($names.resolved, "type", positiveID(memberWhereabouts(member, composition).shipTypeID), "Ship unavailable");
  }

  function memberLocation(member: FleetMember): string {
    const where = memberWhereabouts(member, composition);
    const stationID = positiveID(where.stationID);
    if (stationID !== null) {
      return resolvedName($names.resolved, "station", stationID, "Docked location unavailable");
    }
    return resolvedName(
      $names.resolved,
      "system",
      positiveID(where.solarSystemID),
      "Location unavailable",
    );
  }

  /** The heading the composition window's row menu gives a member's system (fleetCompositionWnd.py 163 and 164). */
  const SYSTEM_HEADING = { label: "UI/Common/SolarSystem", own: "System" } as const;
  function memberSystemID(member: FleetMember): number | null {
    return positiveID(memberWhereabouts(member, composition).solarSystemID);
  }

  function memberInSquad(member: FleetMember, squad: FleetSquad): boolean {
    const squadID = positiveID(squad.squadID);
    return squadID !== null && positiveID(member.squadID) === squadID;
  }

  function wingStaff(member: FleetMember, wing: FleetWing): boolean {
    const wingID = positiveID(wing.wingID);
    return (
      member.role !== 1 &&
      wingID !== null &&
      positiveID(member.wingID) === wingID &&
      positiveID(member.squadID) === null
    );
  }

  function fleetCommand(): readonly FleetMember[] {
    return roster.filter(
      (member) =>
        member.role === 1 ||
        (positiveID(member.wingID) === null && positiveID(member.squadID) === null),
    );
  }

  function placedMembers(): Set<FleetMember> {
    const placed = new Set<FleetMember>(fleetCommand());
    for (const wing of wings) {
      for (const member of roster) {
        if (wingStaff(member, wing)) placed.add(member);
      }
      for (const squad of wing.squads) {
        for (const member of roster) {
          if (memberInSquad(member, squad)) placed.add(member);
        }
      }
    }
    return placed;
  }

  function unplacedMembers(): readonly FleetMember[] {
    const placed = placedMembers();
    return roster.filter((member) => !placed.has(member));
  }

  function inviteSender(): string {
    return resolvedName(
      $names.resolved,
      "character",
      $fleet.pendingInvite?.inviterID ?? null,
      "another pilot",
    );
  }

  function resolveInvitee(): void {
    if (inviteeID !== null) {
      flow.requestNames([{ kind: "character", id: inviteeID }]);
    }
  }

  async function refresh(): Promise<void> {
    refreshError = "";
    try {
      await flow.loadFleet();
    } catch (cause) {
      if (!isSessionLost(cause)) refreshError = "Fleet membership could not be refreshed just now.";
    }
  }

  // The client asks nothing before any of these (fleetSvc.CreateFleet, 331 to 342; Invite, 351 to 363; LeaveFleet,
  // 365 to 371); an invitation is answered in its own dialog, of which the Accept and Decline here are the two
  // answers (OnFleetInvite, 1193). So the page asks nothing either.
  async function formFleet(): Promise<void> {
    await flow.formFleet();
  }

  async function acceptInvite(): Promise<void> {
    await flow.acceptFleetInvite();
  }

  async function declineInvite(): Promise<void> {
    await flow.declineFleetInvite();
  }

  async function inviteMember(): Promise<void> {
    if (inviteeID === null) return;
    await flow.inviteFleetMember(inviteeID);
  }

  async function leaveFleet(): Promise<void> {
    await flow.leaveFleet();
  }

  onMount(() => {
    const release = flow.retainFleetDetails();
    void refresh();
    return release;
  });
</script>

{#snippet memberRow(member: FleetMember)}
  <li class="member-row">
    <div class="member-main">
      <strong>{memberName(member)}</strong>
      <span class="meta">
        {memberShip(member)} · {memberLocation(member)}
        {#if memberSystemID(member) !== null}
          <PlaceRouteMenu {store} {flow} placeID={memberSystemID(member)!} heading={SYSTEM_HEADING} />
        {/if}
      </span>
    </div>
    <span class="badge">{memberRole(member)}</span>
  </li>
{/snippet}

<section class="panel" class:fl-retail={retail} data-fleet-tab={retail ? fleetTab : undefined} aria-busy={$fleet.loading || busy}>
  <header class="panel-head">
    <h2 class="panel-title">Fleet Center</h2>
    <!-- ⚠ THE SUBTITLE WENT, THE FOUR-WAY STATUS DID NOT. "Your live fleet
         roster, command structure, and invitations" only restated what the
         title bar and the sections below already say - the panel-never-
         describes-itself rule. What belongs on the strip instead is the one
         thing here that actually changes.
         ⚠ FOUR BRANCHES, NOT THREE, AND NOT COLLAPSED. `!$fleet.loaded` is its
         own state because before the first read completes we know nothing -
         saying "not in a fleet" here would be a guess dressed as an answer.
         Once loaded, `$fleet.availability` gives the real three-way split
         from bridge/fleetCenter.ts: "not-in-fleet" is an explicit FleetNotFound
         from every read, "unavailable" is a failed or partial one. Collapsing
         those two into a single "no fleet" would tell a player who is still IN
         a fleet, but whose read just failed, that they have left it - see the
         `availability` doc comment on FleetCenterState for why the store keeps
         them apart. -->
    <p class="stat-line">
      {#if !$fleet.loaded}
        Reading your fleet membership…
      {:else if $fleet.availability === "unavailable"}
        Could not tell
      {:else if $fleet.availability === "not-in-fleet"}
        Not in a fleet
      {:else}
        {rosterCountWords}
      {/if}
    </p>
    <span class="controls">
      <button type="button" class="primary" disabled={$fleet.loading || busy} onclick={() => void refresh()}>
        {$fleet.loading ? "Refreshing…" : "Refresh"}
      </button>
    </span>
  </header>

  {#if retail && $fleet.loaded}
    <nav class="tabs fl-tabs">
      {#each fleetTabs as t (t.id)}
        <button type="button" class:active={fleetTab === t.id} onclick={() => (chosenFleetTab = t.id)}>{fleetWord(t.label) || t.own}</button>
      {/each}
    </nav>
    {#if !["fleet", "broadcasts", "form"].includes(fleetTab)}<p class="note fl-unbuilt">This panel is not on the play page yet.</p>{/if}
  {/if}
  {#if refreshError}<p class="error">{refreshError}</p>{/if}
  {#if $fleet.readError}<p class="error">{$fleet.readError}</p>{/if}
  <!-- (A refusal the client's own dialog said is not said again here: ClientDialogs.svelte.) -->
  {#if $fleet.actionError && !$fleet.actionErrorSaid}<p class="error">{$fleet.actionError}</p>{/if}
  {#if $fleet.activeAction !== null}
    <p class="note">Updating the fleet and checking the authoritative roster…</p>
  {/if}

  {#if !$fleet.loaded}
    <!-- ⚠ THE WORDS MOVED UP, THEY WERE NOT DUPLICATED. "Reading your fleet
         membership…" now lives in the strip, which is where this window's one
         changing line belongs; leaving the same sentence here too printed it
         twice, once under the other, which reads as two separate reads in
         flight. The body stays empty until the read answers - the strip is
         already saying what is happening. -->
  {:else if $fleet.availability === "unavailable"}
    <section class="state-card">
      <h3>Fleet status unavailable</h3>
      <p>The companion could not tell whether you are in a fleet. No fleet action is offered until a clean read succeeds.</p>
    </section>
  {:else if $fleet.availability === "not-in-fleet" && retail}
    {#if fleetTab === "form"}
      <div class="fl-form">
        <div class="fl-form-text">
          <h3>{fleetWord("UI/Fleet/FleetWindow/FormFleetHeader") || "Form a fleet"}</h3>
          <p>{fleetWord("UI/Fleet/FleetWindow/FormFleetDescription")}</p>
        </div>
        {#if $fleet.pendingInvite !== null}
          <p><strong>{inviteSender()}</strong> invited you to join a fleet.
            <button type="button" disabled={busy} onclick={() => void acceptInvite()}>Accept invitation</button>
            <button type="button" disabled={busy} onclick={() => void declineInvite()}>Decline</button></p>
        {/if}
        <div class="fl-form-row">
          <button type="button" disabled={busy} onclick={() => void formFleet()}>{fleetWord("UI/Fleet/FleetWindow/FormFleet") || "Form Fleet"}</button>
          <select><option>{fleetWord("UI/Fleet/FleetWindow/DefaultSetup") || "Default Setup"}</option></select>
        </div>
      </div>
    {/if}
  {:else if $fleet.availability === "not-in-fleet"}
    <section class="state-card empty-state">
      <h3>You are not in a fleet</h3>
      <p>The server reports no fleet membership for this character.</p>
      <div class="action-row">
        <button type="button" class="primary" disabled={busy} onclick={() => void formFleet()}>
          Form fleet
        </button>
      </div>
    </section>

    <section class="state-card invite-card">
      <h3>Fleet invitation</h3>
      {#if $fleet.pendingInvite === null}
        <p class="empty">No pending invitation has arrived in this live session.</p>
      {:else}
        <p><strong>{inviteSender()}</strong> invited you to join a fleet.</p>
        <div class="action-row">
          <button type="button" class="primary" disabled={busy} onclick={() => void acceptInvite()}>
            Accept invitation
          </button>
          <button type="button" disabled={busy} onclick={() => void declineInvite()}>
            Decline
          </button>
        </div>
      {/if}
    </section>
  {:else if $fleet.fleet !== null}
    <section class="fleet-summary">
      <div>
        <span class="eyebrow">Current fleet</span>
        <strong class="count">{rosterCountWords}</strong>
      </div>
      <button type="button" class="danger" disabled={busy} onclick={() => void leaveFleet()}>
        Leave fleet
      </button>
    </section>

    {#if $fleet.fleet.initState.value.motd || $fleet.fleet.motd.value}
      <section class="state-card motd">
        <h3>Message of the day</h3>
        <p>{$fleet.fleet.motd.value || $fleet.fleet.initState.value.motd}</p>
      </section>
    {/if}

    <section class="state-card invite-card">
      <h3>Invite a pilot</h3>
      <form onsubmit={(event) => { event.preventDefault(); void inviteMember(); }}>
        <label for="fleet-character-id">Character ID</label>
        <div class="invite-controls">
          <input
            id="fleet-character-id"
            inputmode="numeric"
            autocomplete="off"
            placeholder="Enter a character ID"
            bind:value={inviteeText}
            oninput={resolveInvitee}
          />
          <button type="submit" class="primary" disabled={busy || inviteeID === null}>
            Send invitation
          </button>
        </div>
        {#if inviteeID !== null}
          <p class="resolution">
            {inviteeName ? `Resolved pilot: ${inviteeName}` : "Pilot name is not available yet."}
          </p>
        {/if}
      </form>
    </section>

    <div class="fl-broadcasts"><FleetHistory {store} {flow} /></div>

    <section class="hierarchy" aria-label="Fleet hierarchy">
      <h3>Fleet hierarchy</h3>
      {#if roster.length === 0}
        <p class="empty">The fleet roster is empty.</p>
      {:else}
        {@const command = fleetCommand()}
        {#if command.length > 0}
          <section class="command-group">
            <h4>Fleet command</h4>
            <ul>{#each command as member, index (positiveID(member.charID) ?? `command-${index}`)}{@render memberRow(member)}{/each}</ul>
          </section>
        {/if}

        {#each wings as wing, wingIndex (positiveID(wing.wingID) ?? `wing-${wingIndex}`)}
          {@const staff = roster.filter((member) => wingStaff(member, wing))}
          <section class="wing-group">
            <h4>{wing.name || "Wing"}</h4>
            {#if staff.length > 0}
              <ul>{#each staff as member, index (positiveID(member.charID) ?? `staff-${index}`)}{@render memberRow(member)}{/each}</ul>
            {/if}
            <div class="squad-grid">
              {#each wing.squads as squad, squadIndex (positiveID(squad.squadID) ?? `squad-${squadIndex}`)}
                {@const members = roster.filter((member) => memberInSquad(member, squad))}
                <section class="squad-group">
                  <h5>{squad.name || "Squad"}</h5>
                  {#if members.length === 0}
                    <p class="empty">No members assigned.</p>
                  {:else}
                    <ul>{#each members as member, index (positiveID(member.charID) ?? `member-${index}`)}{@render memberRow(member)}{/each}</ul>
                  {/if}
                </section>
              {/each}
            </div>
          </section>
        {/each}

        {@const unplaced = unplacedMembers()}
        {#if unplaced.length > 0}
          <section class="command-group">
            <h4>Unassigned</h4>
            <ul>{#each unplaced as member, index (positiveID(member.charID) ?? `unplaced-${index}`)}{@render memberRow(member)}{/each}</ul>
          </section>
        {/if}
      {/if}
    </section>

    {#if joinRequests.length > 0}
      <section class="state-card">
        <h3>Join requests</h3>
        <ul class="request-list">
          {#each joinRequests as request, index (positiveID(request.charID) ?? index)}
            <li>{resolvedName($names.resolved, "character", positiveID(request.charID), "Applicant")}</li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</section>

<style>
  /* ⚠ `.panel-head > div` and `.subtitle` used to style the title+blurb
     wrapper this strip no longer has (see the panel-head comment above) -
     removed rather than left to style nothing. Do not add them back for a
     future subtitle; the rule they'd support is the one that just got
     deleted. */
  .state-card,
  .hierarchy,
  .fleet-summary { margin: 0 0 0.75rem; }
  .state-card,
  .hierarchy { border: 1px solid var(--color-row-line); border-radius: 8px; padding: 0.8rem; }
  .state-card h3,
  .hierarchy > h3 { margin-top: 0; }
  .fleet-summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .fleet-summary > div { display: flex; flex-direction: column; }
  .eyebrow { color: var(--color-muted); font-size: 12px; text-transform: uppercase; }
  .count { color: var(--color-text-bright); font-size: 1.3rem; }
  .action-row,
  .invite-controls { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
  .invite-controls input { flex: 1 1 15rem; min-width: 0; }
  .resolution { color: var(--color-muted); font-size: 12px; margin-bottom: 0; }
  .motd p { white-space: pre-wrap; overflow-wrap: anywhere; }
  .command-group,
  .wing-group { border-top: 1px solid var(--color-row-line); padding-top: 0.65rem; margin-top: 0.65rem; }
  .command-group h4,
  .wing-group h4,
  .squad-group h5 { margin: 0 0 0.4rem; }
  .squad-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: 0.55rem; }
  .squad-group { background: var(--color-row); border-radius: 6px; padding: 0.55rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  .member-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.6rem; padding: 0.45rem 0; border-bottom: 1px solid var(--color-row-line); }
  .member-row:last-child { border-bottom: 0; }
  .member-main { display: flex; flex-direction: column; min-width: 0; }
  .member-main strong,
  .meta { overflow-wrap: anywhere; }
  .meta { color: var(--color-muted); font-size: 12px; }
  .request-list li { padding: 0.35rem 0; }
  .danger { border-color: var(--color-danger, #b94b55); color: var(--color-danger, #ff8790); }
  @media (max-width: 640px) {
    .fleet-summary,
    .member-row { align-items: stretch; flex-direction: column; }
  }
</style>
