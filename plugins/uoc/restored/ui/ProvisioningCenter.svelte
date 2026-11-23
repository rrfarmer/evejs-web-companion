<script lang="ts">
  import {cockpitSession,cockpitRequestOptions,cockpitShortcutsAvailable,reviewCockpitFitting,openCockpitInventory,UocRequestError} from "../app/context.ts";
  import {openRegisteredFarmerAccount} from "../app/api.ts";
  import OperationPilotPicker from "./OperationPilotPicker.svelte";
  import CenterHeading from "./CenterHeading.svelte";
  import CenterStatus from "./CenterStatus.svelte";
  import { filterFittings, fittingGroups, fittingHulls } from "../provisioning/fittingPicker.ts";
  import { centerRoster, centerReview, centerInspect, centerApply } from "../adapters/provisioning.ts";
  import {groupEquipment, type Roster, type CenterReview, type ApplyOutcome} from "../provisioning/centerTypes.ts";

  let token = $state<string | null>(null);
  let roster = $state<Roster | null>(null), preflight = $state<CenterReview | null>(null);
  let detail = $state<CenterReview | null>(null), outcome = $state<ApplyOutcome | null>(null);
  let pilotID = $state(0), provider = $state(0), fittingID = $state(0);
  let groupFilter = $state<number | null>(null), hullFilter = $state<number | null>(null), fitSearch = $state("");
  const contracts = $derived(preflight?.definitions.contracts ?? []);
  const groups = $derived(fittingGroups(contracts));
  const hulls = $derived(fittingHulls(contracts, groupFilter));
  const visibleFits = $derived(filterFittings(contracts, groupFilter, hullFilter, fitSearch));
  let sourceKind = $state("hangar"), division = $state(1), savedFittingSupplies = $state(false);
  let hullItemID = $state(0), oldShipDivision = $state(0);
  let busy = $state(""), error = $state(""), applying = $state(false), used = $state(false);
  const pilot = $derived(roster?.pilots.find(p => p.characterID === pilotID));
  const fit = $derived(preflight?.definitions.contracts.find(c => c.definition.fittingID === fittingID));
  const onlineCockpit = $derived(pilot?.control.owner === "BROWSER" && !!cockpitSession(pilotID));
  const canCheck = $derived(pilot?.control.owner === "OFF" && pilot.control.online === false || onlineCockpit || pilot?.serviceAccess === "READ_ONLY_ACTIVE_UOC");
  const offline = $derived(pilot?.control.owner === "OFF" && pilot.control.online === false);
  const plan = $derived(detail?.applyReview.plan);

  const messages: Record<string, string> = {
    PILOT_BUSY: "The pilot has another owner. Its session is preserved; a compatible public owner-service contract is required.",
    ACCOUNT_PILOT_BUSY: "Another pilot on this account is in use. Its ownership is preserved; Apply is unavailable.",
    REVIEW_REQUIRED: "Check the ship again before confirming equipment changes.",
    REVIEW_STALE: "The fitting or ship changed after inspection. Check it again.",
    SOURCE_CHANGED: "The stock or its location changed after inspection. Check it again.",
    SOURCE_AUTHORITY_CHANGED: "Inventory permissions changed after inspection. Check them again.",
    CORPORATION_QUERY_DENIED: "The pilot does not have Query rights for this corporate division.",
    CORPORATION_ACCESS_UNKNOWN: "The pilot's corporate division rights could not be verified.",
    SOURCE_TAKE_DENIED: "The pilot does not have Take rights for this corporate division.",
    STRUCTURE_SERVICE_UNAVAILABLE: "The fitting service is unavailable to this pilot at this structure.",
    STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE: "Selected Upwell fitting-service inspection requires a public native service contract that is not currently exposed.",
    PROVISIONING_CONTEXT_UNAVAILABLE: "Dock the pilot and wait for the ship session to settle before checking.",
    OBSERVATION_INCOMPLETE: "The server could not verify the full ship or stock snapshot. The required native owner-service and inventory evidence must be available; existing sessions are preserved.",
    NO_LIVE_SESSION: "The Cockpit session ended during inspection. Refresh the roster and check again.",
    PROVISIONING_GENERATION_CHANGED: "Pilot control changed while the ship was being checked. Check again.",
    CONTROL_RELEASE_UNPROVEN: "Apply could not verify that its session was released. Check control before trying again.",
    PROVISIONING_RECOVERY_REQUIRED: "WC reports an unfinished equipment operation for this pilot.",
    OUTCOME_AMBIGUOUS: "WC could not verify the equipment change. Inspect the ship and equipment before making another change.",
    CHARGE_LOAD_REFUSED: "The charge load was refused. Native readback showed no change from that load. Earlier verified changes are listed in the receipt.",
    CannotLoadNotEnoughCharges: "The native weapon bank refused the load because there were too few charges for its members. Review the original receipt.",
    SKILLS_NOT_READY: "The fitting's skill requirements are not verified. Check the ship again.",
  };
  const fittingNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  function capacity(value: number | null | undefined, missing = "Unknown"): string {
    return typeof value === "number" && Number.isFinite(value) ? fittingNumber.format(value) : missing;
  }
  const words = (value: string) => messages[value] || value;
  const fitWords = (status: CenterReview["status"]) =>
    status.equipmentMatch === "REQUIRED_WITH_RETAINED_RIGS" ? "Required fitting satisfied; additional equipment retained"
    : status.equipment === "VERIFIED" ? "Exact equipment match"
    : status.equipment === "MODIFIED" ? "Differs from the selected fitting" : "Equipment check incomplete";
  const supplyWords = (value: string) => value === "FULL" ? "Targets met" : value === "LOW" ? "Below target"
    : value === "MISSING" ? "Supplies missing" : "Supplies could not be checked";
  const controlWords = (owner: string) => owner === "OFF" ? "Offline" : owner === "BROWSER" ? "Open in Web Companion"
    : owner === "BOT" ? "Controlled by a bot" : owner === "OTHER_SESSION" ? "In use by another session"
      : owner === "RECOVERY_OR_OPERATION" ? "Operation or recovery in progress" : "Control could not be checked";

  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    busy = label;
    error = "";
    try { await action(); }
    catch (cause) {
      if (cause instanceof UocRequestError && cause.status === 401 && token && !cockpitRequestOptions(token)) clearSelection();
      error = words(cause instanceof Error ? cause.message : String(cause));
    }
    finally { busy = ""; }
  }

  async function connect(name: string, characterID: number) {
    const value = await openRegisteredFarmerAccount(name);
    const current = await centerRoster(value.options.token);
    if (!current.pilots.some(p => p.characterID === characterID)) throw new Error("This pilot is missing from its current roster.");
    clearSelection();
    roster = current;
    token = value.options.token;
    pilotID = characterID;
    await choosePilot();
  }

  async function refresh() {
    if (!token) return;
    try { roster = await centerRoster(token); }
    catch (cause) { roster = null; throw cause; }
    if (pilotID && !roster.pilots.some(p => p.characterID === pilotID)) {
      pilotID = 0;
      preflight = null;
      invalidate();
    }
  }

  function invalidate() {
    hullItemID = 0;
    clearReview();
  }

  function clearReview() {
    detail = null;
    used = false;
    error = "";
  }

  async function choosePilot() {
    provider = pilotID;
    sourceKind = "hangar";
    division = 1;
    oldShipDivision = 0;
    outcome = null;
    await loadFittings();
  }

  async function loadFittings() {
    preflight = null;
    fittingID = 0;
    groupFilter = null;
    hullFilter = null;
    fitSearch = "";
    invalidate();
    if (!token || !pilotID || !provider) return;
    preflight = await centerReview(token, { characterID: pilotID, providerCharacterID: provider, fittingID: 0,
      sourceKind: "hangar", corporationID: pilot?.corporationID || 0, division: 1 });
  }

  async function check() {
    if (!token || !fit || !canCheck) return;
    const definitionFingerprint = fit.definitionFingerprint;
    clearReview();
    outcome = null;
    detail = await centerInspect(token, { characterID: pilotID, providerCharacterID: provider,
      fittingID, sourceKind, division, definitionFingerprint, savedFittingSupplies, hullItemID, oldShipDivision });
  }

  function clearSelection() {
    token = null;
    roster = null;
    preflight = null;
    pilotID = 0;
    outcome = null;
    invalidate();
  }

  async function apply() {
    const accepted = detail?.applyReview;
    if (!token || used || detail?.hullReview?.ready || !accepted?.canApply || !accepted.reviewHash) return;
    if (accepted.expiresAt !== null && Date.now() > accepted.expiresAt) throw new Error("The review expired. Check the ship again before confirming.");
    const credential = token;
    applying = true;
    used = true;
    outcome = null;
    try { outcome = (await centerApply(credential, accepted.reviewID, accepted.reviewHash, oldShipDivision)).outcome; }
    finally { applying = false; }
    await refresh();
  }
</script>

<main class="uoc-center center">
  <CenterHeading title="Ship Provisioning Center" />
  <section class="center-panel">
    <h2>1. Choose pilot</h2>
    <OperationPilotPicker selectedID={pilotID} disabled={!!busy}
      canChoose={row => row.availability === "AVAILABLE" || row.availability === "WC_SESSION" || row.availability === "HOSTED" || row.availability === "IN_GAME" || row.availability === "OTHER_SESSION" || row.availability === "ACCOUNT_BUSY"}
      onChoose={row => void run("Loading saved fittings…", () => connect(row.accountName, row.characterID))} />
    {#if token}<button disabled={!!busy} onclick={clearSelection}>Clear selected pilot</button>{/if}
  </section>
  {#if token}
    {#if roster}
      {#if pilot}
        <section class="center-panel">
          <h2>2. Choose ship and fitting</h2>
          <p><strong>{pilot.name}</strong>{pilot.corporationName ? ` · ${pilot.corporationName}` : ""}</p>
          <div class="selectors">
            <label>Ship group
              <select value={groupFilter === null ? "" : String(groupFilter)} disabled={!!busy || !contracts.length}
                onchange={e => { groupFilter = e.currentTarget.value === "" ? null : Number(e.currentTarget.value); hullFilter = null; fittingID = 0; invalidate(); }}>
                <option value="">All ship groups</option>
                {#each groups as group (group.id)}<option value={String(group.id)}>{group.name}</option>{/each}
              </select>
            </label>
            <label>Ship type
              <select value={hullFilter === null ? "" : String(hullFilter)} disabled={!!busy || !contracts.length}
                onchange={e => { hullFilter = e.currentTarget.value === "" ? null : Number(e.currentTarget.value); fittingID = 0; invalidate(); }}>
                <option value="">All ship types</option>
                {#each hulls as hull (hull.id)}<option value={String(hull.id)}>{hull.name}</option>{/each}
              </select>
            </label>
            <label>Find a saved fitting
              <input type="search" bind:value={fitSearch} disabled={!!busy || !contracts.length}
                placeholder="Fitting name" oninput={() => { groupFilter = null; hullFilter = null; fittingID = 0; invalidate(); }} />
            </label>
            <label>Saved fitting
              <select bind:value={fittingID} onchange={invalidate} disabled={!!busy || !visibleFits.length}>
                <option value={0}>Choose a fitting</option>
                {#each visibleFits as row (row.definition.fittingID)}
                  <option value={row.definition.fittingID}>{row.name} · {row.hullName}</option>
                {/each}
              </select>
            </label>
          </div>
          {#if contracts.length && !visibleFits.length}<p>No saved fitting matches these filters.</p>{/if}
          <details><summary>Advanced fitting library</summary>
            <label>Corporate fitting library
              <select value={provider} disabled={!!busy} onchange={e => { provider = Number(e.currentTarget.value); void run("Loading saved fittings…", loadFittings); }}>
                {#each roster.providers as row (row.characterID)}
                  <option value={row.characterID}>{row.name}{row.corporationName ? ` · ${row.corporationName}` : ""}</option>
                {/each}
              </select>
            </label>
          </details>
          {#if preflight && !preflight.definitions.contracts.length}
            <p>{preflight.definitions.status === "READY" ? "No supported corporate fittings are saved." : "This pilot's corporate fitting library could not be read."}</p>
          {/if}
          {#if preflight?.definitions.invalid.length}<p>Some saved fitting definitions could not be qualified.</p><details><summary>Unavailable fitting definitions</summary><ul>{#each preflight.definitions.invalid as row}<li>Fitting {row.fittingID}: {row.reason}</li>{/each}</ul></details>{/if}
        </section>
        <section class="center-panel">
          <h2>3. Inspect equipment</h2>
          {#if fit && !detail}
            <p>Current hull: <strong>{pilot.hullName ?? "Awaiting ship read"}</strong> · Required hull: <strong>{fit.hullName ?? "Unknown"}</strong>
              {#if pilot.shipTypeID} · {pilot.shipTypeID===fit.shipTypeID?"Same hull type on the account roster":"Different hull type on the account roster"}{/if}</p>
          {/if}
          <div class="selectors">
            <label>Equipment source
              <select bind:value={sourceKind} onchange={invalidate} disabled={!!busy}>
                <option value="hangar">Pilot's personal hangar</option>
                <option value="corp" disabled={!pilot.corporationID}>Pilot's corporate hangar</option>
              </select>
            </label>
            {#if sourceKind === "corp"}
              <label>Division
                <select bind:value={division} onchange={invalidate} disabled={!!busy}>
                  {#each [1, 2, 3, 4, 5, 6, 7] as n}<option value={n}>Division {n}</option>{/each}
                </select>
              </label>
            {/if}
            <label>Previous ship
              <select bind:value={oldShipDivision} onchange={clearReview} disabled={!!busy}>
                <option value={0}>Keep in personal hangar</option>
                {#if pilot.corporationID}
                  {#each [1,2,3,4,5,6,7] as n}<option value={n}>Store in corporation division {n}</option>{/each}
                {/if}
              </select>
            </label>
            <label><input type="checkbox" bind:checked={savedFittingSupplies} onchange={invalidate} disabled={!!busy} /> Load saved charges and supplies on the new ship</label>
            {#if cockpitShortcutsAvailable() && cockpitSession(pilotID)}{#if fit}<button disabled={!!busy} onclick={()=>void run("Opening the existing Cockpit fitting…",()=>reviewCockpitFitting(pilotID,fittingID))}>Review fitting in Cockpit</button>{/if}<button disabled={!!busy} onclick={()=>void run("Reading existing Cockpit inventory…",()=>openCockpitInventory(pilotID))}>Inspect Cockpit inventory</button>{/if}
            <button class="primary" disabled={!!busy || !fit || !canCheck} onclick={() => void run("Checking ship and available equipment…", check)}>
              Check ship and available equipment
            </button>
          </div>
          {#if !fit}<p>Choose a saved fitting to check its requirements.</p>
          {:else if !canCheck}<p>{controlWords(pilot.control.owner)}. The existing owner is preserved. A compatible public owner-service contract is required for inspection.</p>
          {:else if !detail}<p>Inspect reads the current ship, skill requirements and source stock. The pilot’s native fitting context verifies available CPU and Powergrid before Apply.</p>{/if}
        </section>
      {/if}
    {/if}

    {#if detail}
      <section class="center-panel">
        <div class="center-actions"><h2>4. Review plan</h2>
          {#if detail.applyReview.canApply}<CenterStatus state="READY" label="Ready to apply" />{/if}
        </div>
        {#if detail.hullReview}
          <dl>
            <dt>Current ship</dt><dd>{detail.hullReview.current}</dd>
            <dt>Required ship</dt><dd>{detail.hullReview.required} · {detail.hullReview.matches ? "Same hull type" : "Different hull type"}</dd>
            <dt>Packaged hulls at selected source</dt><dd>{detail.hullReview.packagedQuantity ?? "Stock could not be verified"}</dd>
          </dl>
          {#if plan?.hullCandidates?.length}
            <label>Replacement hull
              <select value={hullItemID} disabled={!!busy} onchange={event => {
                hullItemID = Number(event.currentTarget.value);
                void run("Inspecting selected hull…", check);
              }}>
                <option value={0}>Automatic (ready, partially fitted, empty assembled, then packaged)</option>
                {#each plan.hullCandidates as hull (hull.itemID)}
                  <option value={hull.itemID}>{hull.name} · assembled · #{hull.itemID}</option>
                {/each}
              </select>
            </label>
            {#if (plan.hullCandidateCount ?? 0) > plan.hullCandidates.length}
              <form onsubmit={event => {
                event.preventDefault();
                const itemID = Number(new FormData(event.currentTarget).get("hullID"));
                if (!Number.isSafeInteger(itemID) || itemID <= 0) return;
                hullItemID = itemID;
                void run("Inspecting selected hull…", check);
              }}>
                <label>Other assembled hull ID <input name="hullID" type="number" min="1" step="1" required /></label>
                <button disabled={!!busy}>Inspect by item ID</button>
              </form>
            {/if}
          {/if}
          {#if detail.hullReview.ready}
            <p role="status"><strong>Ready ship · current ship #{detail.pilot.shipID}. No equipment changes required.</strong></p>
          {:else if plan?.hullSelection}
            {@const choice = plan.hullSelection}
            <p><strong>{choice.kind === "READY" ? "Ready ship" : choice.kind === "PARTIAL" ? "Complete the existing fit" : "Fit an empty assembled ship"} · #{plan.targetHullID}</strong>
              · {choice.origin === "active" ? "current ship" : choice.origin === "corp" ? `corporation Division ${choice.division}` : "personal hangar"}.</p>
          {:else if detail.hullReview.newHullRequired}
            <p><strong>New assembly · {detail.hullReview.required} from packaged stock.</strong></p>
          {/if}
          {#if detail.hullReview.preserveCurrentShip}
            <p>Previous ship {detail.hullReview.current} · {oldShipDivision
              ? `requested storage in corporation Division ${oldShipDivision}`
              : "keep in the personal hangar"}.</p>
          {/if}
        {/if}
        <p>{detail.pilot.dockState === "DOCKED" ? detail.pilot.locationName || "Docked" : detail.pilot.dockState === "IN_SPACE" ? "In space" : "Location not verified"} · {fitWords(detail.status)}</p>
        <p>{detail.fittingService === "AVAILABLE" ? "Fitting service available." : detail.fittingService === "UNAVAILABLE" ? "Fitting service unavailable at this dock." : "The WC review did not include fitting service status."}</p>
        <p>{detail.skills?.state === "READY" ? "Skill requirements met." : detail.skills?.state === "NOT_READY" ? "Some required skills need training." : "Skill requirements could not be checked."}</p>
        {#if detail.skills?.missing.length}
          <ul>{#each detail.skills.missing as skill}<li>{skill.name} · level {skill.trainedLevel} of {skill.level}</li>{/each}</ul>
        {/if}
        <h3>Fitting capacity</h3>
        <dl class="physical">
          <dt>CPU</dt><dd>{capacity(detail.fittingResources?.cpu?.used, "Required unknown")} / {capacity(detail.fittingResources?.cpu?.total, "Available unknown")} tf</dd>
          <dt>Powergrid</dt><dd>{capacity(detail.fittingResources?.powergrid?.used, "Required unknown")} / {capacity(detail.fittingResources?.powergrid?.total, "Available unknown")} MW</dd>
          {#if detail.droneBay}
            <dt>Drone bay storage{detail.droneBay.simulated ? " (simulated hull)" : ""}</dt><dd>{capacity(detail.droneBay.required, "Required unknown")} / {capacity(detail.droneBay.capacity, "Capacity unknown")} m³</dd>
          {/if}
        </dl>
        {#if detail.fittingResources?.cpu && detail.fittingResources?.powergrid}
          {@const cpuRemaining = detail.fittingResources.cpu.total - detail.fittingResources.cpu.used}
          {@const pgRemaining = detail.fittingResources.powergrid.total - detail.fittingResources.powergrid.used}
          <p>CPU {cpuRemaining < 0 ? 'deficit' : 'headroom'}: {capacity(Math.abs(cpuRemaining))} tf · Powergrid {pgRemaining < 0 ? 'deficit' : 'headroom'}: {capacity(Math.abs(pgRemaining))} MW.</p>
          {#if cpuRemaining < 0 || pgRemaining < 0}<p role="alert">The exact candidate exceeds this pilot’s available fitting capacity.</p>{/if}
        {/if}
        {#if detail.fittingResources?.reasons.length}
          <ul>{#each detail.fittingResources.reasons as reason}<li>{reason}</li>{/each}</ul>
        {:else if detail.fittingResources?.status === "READY"}
          <p>Simulated using this pilot’s current Dogma state.</p>
        {:else}
          <p>Candidate capacity requires the selected pilot’s Dogma state.</p>
        {/if}
        {#if detail.nativeResources?.state === "NATIVE"}
          <h3>Assembled ship · native readback</h3>
          <p>CPU {capacity(detail.nativeResources.cpu.used)} / {capacity(detail.nativeResources.cpu.total)} tf · Powergrid {capacity(detail.nativeResources.powergrid.used)} / {capacity(detail.nativeResources.powergrid.total)} MW</p>
          <p>{detail.nativeResources.allModulesOnline === true ? "All required modules are online." : "Required module online state is not verified."}</p>
        {:else if detail.nativeResources}<p>Native CPU and Powergrid: {detail.nativeResources.reason ?? "unverified"}.</p>{/if}
        {#if plan?.retainedRigs?.length}
          {#if detail.status.equipmentMatch !== "REQUIRED_WITH_RETAINED_RIGS"}
            <p>{plan.unsupported.length || detail.requirements.some(row => row.missing !== 0)
              ? "Additional rigs will be retained"
              : "Required fitting satisfied; additional equipment retained"}.</p>
          {/if}
          <ul>{#each plan.retainedRigs as rig}<li>{rig.name} · Slot {rig.flagID}</li>{/each}</ul>
        {/if}
        <h3>Equipment to add</h3>
        {#if detail.requirements.some(row => (row.missing ?? 0) > 0)}
          <ul>{#each groupEquipment(detail.requirements).filter(row => (row.missing ?? 0) > 0) as row}
            <li>{row.name} ×{row.missing} · {row.kind}</li>
          {/each}</ul>
        {:else if detail.requirements.some(row => row.missing == null)}<p>Current per-slot equipment quantities could not be verified.</p>{:else}<p>No missing equipment was observed.</p>{/if}
        {#if detail.status.supplies === "UNKNOWN"}<p>Supply targets are not included in this inspection.</p>{/if}
        {#if detail.status.charges?.length}
          <h3>Charges to load into fitted modules</h3>
          <ul>{#each detail.status.charges as charge}
            <li>{charge.name} ×{charge.target} · fitting slot {charge.flagID}</li>
          {/each}</ul>
        {/if}
        {#if detail.status.targets.length}
          <h3>Supplies</h3>
          <ul>{#each detail.status.targets as supply}
            <li>{supply.name} · {supply.current ?? "not checked"} / {supply.target} · {supplyWords(supply.state)}</li>
          {/each}</ul>
        {/if}
        <h3>{detail.candidateSource.kind === "corp" ? "Corporate hangar, division " + detail.candidateSource.division : "Personal hangar"}</h3>
        {#if detail.candidateSource.query === "ALLOWED"}
          <p>{detail.candidateSource.take === "ALLOWED" ? "Source accessible for viewing and taking." :
            detail.candidateSource.take === "DENIED" ? "Source visible. Take access is denied." : "Take access could not be checked."}</p>
        {:else if detail.candidateSource.query === "DENIED"}
          <p>Viewing this source is denied.</p>
        {:else}
          <p>Source access and stock could not be checked.</p>
        {/if}
        {#each detail.candidateSource.reasons as reason}<p>{reason}</p>{/each}
        {#if detail.relevantStock}
          <h3>{detail.stockAuthority==="OFFLINE_PERSONAL_SNAPSHOT"?"Packaged stock recorded in the offline personal snapshot":"Packaged stock at selected source"}</h3>
          {#if detail.stockAuthority==="OFFLINE_PERSONAL_SNAPSHOT"}<p>Verify Upwell access in the docked pilot’s Cockpit before using this stock.</p>{/if}
          <ul>{#each detail.relevantStock as row (row.typeID)}<li>{row.name} · {row.quantity>0?`×${row.quantity}`:detail.stockAuthority==="OFFLINE_PERSONAL_SNAPSHOT"?"None recorded in snapshot":"Confirmed missing at this source"}</li>{/each}</ul>
        {/if}
        {#if plan}
          {#if plan.mode === "ALREADY_SATISFIED"}
            <p>The current ship already matches. Apply will verify it without fitting or replenishing supplies.</p>
          {:else}
            <details><summary>Steps in the reviewed plan</summary><ol>{#each plan.steps as step}<li>{step}</li>{/each}</ol></details>
          {/if}
        {/if}
        <details>
          <summary>Advanced inspection details and inventory</summary>
          <h3>On the ship</h3>
          {#if detail.equipment.length}
            <table><thead><tr><th>Item</th><th>Location</th><th>Qty</th></tr></thead><tbody>
              {#each groupEquipment(detail.equipment) as row}<tr><td>{row.name}</td><td>{row.kind}</td><td>{row.quantity}</td></tr>{/each}
            </tbody></table>
          {:else}<p>The complete onboard item list was not returned by this inspection.</p>{/if}
          <h3>All required equipment</h3>
          <table><thead><tr><th>Item</th><th>In place</th><th>Required</th><th>Missing</th></tr></thead><tbody>
            {#each groupEquipment(detail.requirements) as row}<tr><td>{row.name} · {row.kind}</td><td>{row.current ?? "Unknown"}</td><td>{row.quantity}</td><td>{row.missing ?? "Unknown"}</td></tr>{/each}
          </tbody></table>
          {#if detail.candidateSource.rows}
            <h3>Available stock</h3>
            <ul>{#each detail.candidateSource.rows as row}<li>{row.name} × {row.quantity}</li>{/each}</ul>
          {/if}
          <pre>{JSON.stringify({ ship: detail.pilot.shipID, location: detail.pilot.locationID, fitting: detail.selected?.definition,
            equipment: detail.equipment, source: detail.candidateSource, evidence: detail.evidence, plan, rawReview: detail.rawReview }, null, 2)}</pre>
        </details>
      </section>
      {#if !detail.hullReview?.ready}
      <section class="center-panel">
        <h2>5. Confirm equipment changes</h2>
        {#if used}<p>This Apply request was submitted. Check the outcome below or inspect again for a new plan.</p>
        {:else if !detail.applyReview.canApply}
          {#if detail.applyReview.reasons.length}
            <ul class="blocked" aria-label="Apply blockers">{#each detail.applyReview.reasons as reason}<li>{reason}</li>{/each}</ul>
          {:else}
            <p>Inspect the selected fitting and equipment source before applying.</p>
          {/if}
        {:else if onlineCockpit}<p>Apply uses this pilot's existing idle, docked Cockpit session, rechecks the exact native plan, preserves the old ship, and verifies the resulting equipment. This existing session remains open.</p>
        {:else if !offline}<p>The active owner is preserved. Finish its operation before applying equipment changes.</p>
        {:else}<p>Apply acquires a temporary session only for this independently offline pilot, rechecks the plan, verifies the result, and releases that acquired session. The physical plan will be checked again immediately before Apply.</p>{/if}
        <button class="primary" disabled={!!busy || used || !(offline || onlineCockpit) || !detail.applyReview.canApply} onclick={() => void run("Applying reviewed plan…", apply)}>
          Confirm Apply
        </button>
      </section>
      {/if}
    {/if}
  {/if}

  {#if outcome}
    <section class="center-panel" aria-label="Apply outcome">
      <h2>{outcome.state === "COMPLETE" || outcome.state === "ALREADY_SATISFIED" ? "Finished ship verified"
        : outcome.state === "PARTIAL" ? "Fitted ship verified · previous ship storage incomplete"
        : applying ? "Applying plan" : "Apply needs review"}</h2>
      {#if outcome.reason}<p>{words(outcome.reason)}</p>{/if}
      {#if outcome.state === "REFUSED" && outcome.provisioning?.manifest?.targetHullID}
        <p>The original receipt records hull #{outcome.provisioning.manifest.targetHullID}. Review its fitting and charges before requesting further changes.</p>
      {/if}
      {#if outcome.provisioning?.manifest?.previousShipStorage}
        {@const storage = outcome.provisioning.manifest.previousShipStorage}
        <p>Previous ship #{storage.itemID} stored in corporation Division {storage.division}. Verified {storage.contentsCount} fitted items.</p>
      {/if}
      {#if outcome.finalReview}
        <p>Active ship #{outcome.finalReview.context.shipID} · {fitWords(outcome.finalReview.status)}. Supplies: {supplyWords(outcome.finalReview.status.supplies)}.</p>
        {#if outcome.finalReview.status.charges?.length || outcome.finalReview.status.targets.length}
          <ul>
            {#each outcome.finalReview.status.charges ?? [] as charge}
              <li>{charge.name} in fitting slot {charge.flagID} · {charge.current ?? "not verified"} / {charge.target}</li>
            {/each}
            {#each outcome.finalReview.status.targets as supply}
              <li>{supply.name} carried · {supply.current ?? "not verified"} / {supply.target}</li>
            {/each}
          </ul>
        {/if}
      {/if}
      <p>{outcome.release.state === "VERIFIED_OFFLINE" ? "Pilot released and confirmed offline."
        : outcome.release.state === "RETAINED_EXISTING" ? "Existing Cockpit session retained; no logout or replacement login."
        : outcome.release.state === "NOT_ACQUIRED" ? "No maintenance session was acquired."
        : outcome.release.state === "STILL_ONLINE" ? "The pilot is still online." : "Offline release has not been confirmed."}</p>
      {#if outcome.release.state === "STILL_ONLINE"}
        <p>Retry Stop for the original hosted task in Pilot Hangar.</p>
      {/if}
      {#if outcome.state === "UNCERTAIN"}
        <p>Check the current ship and equipment before making another change.</p>
      {/if}
      {#if outcome.nativeResources?.state === "NATIVE"}<p>Native CPU {capacity(outcome.nativeResources.cpu.used)} / {capacity(outcome.nativeResources.cpu.total)} tf · Powergrid {capacity(outcome.nativeResources.powergrid.used)} / {capacity(outcome.nativeResources.powergrid.total)} MW. {outcome.nativeResources.allModulesOnline === true ? "All required modules are online." : "Module online state is unverified."}</p>{/if}
      <details><summary>Apply details</summary><pre>{JSON.stringify(outcome, null, 2)}</pre></details>
    </section>
  {/if}
  {#if busy}<p role="status">{busy}</p>{/if}
  {#if error}<p class="center-message" role="alert">{error}</p>{/if}
</main>

<style>
  .center { max-width: 76rem; }
  form, .selectors { display: flex; gap: .8rem; flex-wrap: wrap; align-items: end; }
  h2 { font-size: 1.25rem; }
  h3 { margin: 1rem 0 .4rem; }
  p, details, ul, ol { margin: .6rem 0; }
  ul, ol { padding-left: 1.3rem; }
  section { margin-top: 1rem; }
  label { display: flex; flex-direction: column; gap: .3rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: .4rem; border-bottom: 1px solid #394351; text-align: left; }
  pre { max-height: 22rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .8rem; }
  .blocked { color: #ffc3a3; }
</style>
