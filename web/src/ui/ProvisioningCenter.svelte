<script lang="ts">
  import { onMount } from "svelte";
  import { centerLogin, centerRoster, centerReview, centerApply, centerOperation, centerRecover, matchLabel, type Roster, type CenterReview, type ApplyOutcome } from "../provisioning/centerClient.ts";
  let username = $state(""), password = $state(""), token = $state<string | null>(null), account = $state("");
  let roster = $state<Roster | null>(null), detail = $state<CenterReview | null>(null), pilotID = $state(0), provider = $state(0), fittingID = $state(0);
  let sourceKind = $state("hangar"), division = $state(1), busy = $state(false), error = $state("");
  let ticket = 0;
  let outcome = $state<ApplyOutcome | null>(null), applying = $state(false);
  onMount(() => { const saved = sessionStorage.getItem("ship-provisioning:account"); if (saved) {
    try { const value = JSON.parse(saved); token = value.token; account = value.account; void run(refresh); } catch { sessionStorage.removeItem("ship-provisioning:account"); }
  } });
  async function run(action: () => Promise<void>) { if (busy) return; busy = true; error = ""; try { await action(); } catch (e) { error = String(e); } finally { busy = false; } }
  async function login() { const value = await centerLogin(username,password); password = ""; token = value.sessionToken; account = value.account.username;
    sessionStorage.setItem("ship-provisioning:account",JSON.stringify({ token,account })); await refresh(); }
  async function refresh() { if (!token) return; detail = null; roster = null; const version=++ticket; const value=await centerRoster(token); if (version===ticket) roster=value; }
  async function inspect(id: number) { pilotID=id; provider=id; fittingID=0; sourceKind="hangar"; division=1; await review(); }
  async function review() { if (!token || !pilotID) return; const version=++ticket; detail=null;
    const pilot=roster?.pilots.find(p=>p.characterID===pilotID);
    const value=await centerReview(token,{ characterID:pilotID,providerCharacterID:provider,fittingID,sourceKind,corporationID:pilot?.corporationID || 0,division });
    if(version===ticket) detail=value;
  }
  function invalidate() { ticket++; detail=null; }
  function logout() { ticket++; token=null; roster=null; detail=null; outcome=null; sessionStorage.removeItem("ship-provisioning:account"); }
  async function apply() {
    const accepted=detail?.applyReview;
    if(!token || !accepted?.canApply || !accepted.reviewHash) return;
    const credential=token; applying=true; outcome=null;
    const pending=centerApply(credential,accepted.reviewID,accepted.reviewHash);
    const monitor=(async()=>{ while(applying) { await new Promise(r=>setTimeout(r,1000)); if(!applying) break;
      try { const polled=(await centerOperation(credential,accepted.reviewID)).outcome; if(applying) outcome=polled; } catch { /* POST may not have reached the durable boundary yet. */ }
    } })();
    try { outcome=(await pending).outcome; } finally { applying=false; await monitor; }
    await review();
    roster=await centerRoster(credential); // Replace the pre-Apply hull/control roster with fresh observations.
  }
  async function recover(id: string) { if(!token) return; outcome=(await centerRecover(token,id)).outcome; await review(); roster=await centerRoster(token); }
</script>

<main class="center">
  <header><h1>Ship Provisioning Center</h1><p>Account-wide Review and Provision</p><a href="/">Return to pilot workspace</a></header>
  <p>Review never selects a pilot. Apply temporarily acquires only a free pilot, revalidates the accepted plan, provisions through the shared engine, then releases control.</p>
  {#if !token}
    <form onsubmit={e=>{e.preventDefault();void run(login);}}><label>Account<input bind:value={username} autocomplete="username" /></label><label>Password<input type="password" bind:value={password} autocomplete="current-password" /></label><button disabled={busy || !username}>Sign in for read-only Review</button></form>
  {:else}
    <p>Account: {account} <button disabled={busy} onclick={()=>void run(refresh)}>Refresh observations</button> <button disabled={busy} onclick={logout}>Leave Center</button></p>
    {#if roster}
      <p>Roster observation: <strong>{roster.quality}</strong>{!roster.completeRoster ? " · incomplete roster" : ""}. {roster.reasons.join(" · ")}</p>
      <table><thead><tr><th>Pilot</th><th>Hull / ship ID</th><th>Fitting match</th><th>Location</th><th>Dock state</th><th>Equipment</th><th>Supplies</th><th>Control</th><th>Observation</th></tr></thead><tbody>
        {#each roster.pilots as p (p.characterID)}<tr><td><button disabled={busy} onclick={()=>void run(()=>inspect(p.characterID))}>{p.name}</button></td><td>{p.hullName || "Unknown ship"}<small>{p.shipID ?? "UNKNOWN"}</small></td><td>{matchLabel(p.matches)}</td><td>{p.locationName || p.locationID || "UNKNOWN"}</td><td>{p.dockState}</td><td>{p.status.equipment}</td><td>{p.status.supplies}</td><td>{p.control.state} · {p.control.owner}</td><td>{p.quality}<small>{p.reasons.join(" · ")}</small></td></tr>{/each}
      </tbody></table>
      {#if !roster.pilots.length}<p>{roster.completeRoster ? "No owned pilots." : "Pilot list unavailable; absence is not verified."}</p>{/if}
      {#if pilotID}
        <section><h2>Pilot Review · read-only</h2><div class="selectors">
          <label>Fitting definition provider<select bind:value={provider} onchange={()=>{fittingID=0;invalidate();}} disabled={busy}>{#each roster.providers as p}<option value={p.characterID}>{p.name} · corporation {p.corporationID ?? "UNKNOWN"}</option>{/each}</select></label>
          <label>Physical item source<select bind:value={sourceKind} onchange={invalidate} disabled={busy}><option value="hangar">Target pilot personal local hangar</option><option value="corp">Target pilot corporation division</option></select></label>
          {#if sourceKind==="corp"}<label>Corporation division<select bind:value={division} onchange={invalidate} disabled={busy}>{#each [1,2,3,4,5,6,7] as n}<option value={n}>Division {n}</option>{/each}</select></label>{/if}
          <button disabled={busy} onclick={()=>void run(review)}>Read pilot / definitions / source</button>
        </div></section>
      {/if}
    {/if}
    {#if detail}
      <section><h2>{detail.pilot.name} · actual loadout</h2>
        <p>Hull: {detail.pilot.hullName || "UNKNOWN"} · ship {detail.pilot.shipID ?? "UNKNOWN"} · location {detail.pilot.locationID ?? "UNKNOWN"} · {detail.pilot.dockState}</p>
        <p>Control: {detail.pilot.control.state} · {detail.pilot.control.owner}. Observation: <strong>{detail.pilot.quality}</strong> · {detail.pilot.reasons.join(" · ")}</p>
        <p>Fit: <strong>{matchLabel(detail.matches)}</strong></p>
        <label>Saved fitting<select bind:value={fittingID} disabled={busy} onchange={()=>void run(review)}><option value={0}>Unique exact match, otherwise no selection</option>{#each detail.definitions.contracts as c}<option value={c.definition.fittingID}>{c.name} · {c.definition.fittingID}</option>{/each}</select></label>
        <p>Definition provider: {detail.definitions.providerCharacterID} · corporation {detail.definitions.corporationID ?? "UNKNOWN"} · {detail.definitions.status}</p>
        {#if detail.selected}<p>Selected definition: {detail.selected.name} · ID {detail.selected.definition.fittingID} · saved {detail.selected.definition.savedDate}</p><small>Definition fingerprint: {detail.selected.definitionFingerprint}<br />Full fitting fingerprint: {detail.selected.definition.fullFingerprint}<br />Equipment: {detail.selected.equipmentFingerprint}<br />Supply policy: {detail.selected.supplyPolicyFingerprint}</small>{/if}
        <p>Equipment: <strong>{detail.status.equipment}</strong> · Supplies: <strong>{detail.status.supplies}</strong></p>
        <table><thead><tr><th>Actual fitted / carried item</th><th>Kind</th><th>Slot / bay</th><th>Quantity</th><th>Item ID</th></tr></thead><tbody>{#each detail.equipment as item}<tr><td>{item.name}</td><td>{item.kind}</td><td>{item.flagID}</td><td>{item.quantity}</td><td>{item.itemID}</td></tr>{/each}</tbody></table>
        {#if detail.selected}<h3>Selected equipment requirements</h3><table><thead><tr><th>Required item</th><th>Kind</th><th>Slot / bay</th><th>Quantity</th></tr></thead><tbody>{#each detail.requirements as item}<tr><td>{item.name}</td><td>{item.kind}</td><td>{item.flagID}</td><td>{item.quantity}</td></tr>{/each}</tbody></table>{/if}
        {#if detail.pilot.quality!=="COMPLETE"}<p>Incomplete observation: displayed rows do not prove missing equipment or supplies.</p>{/if}
        <h3>Declared supply targets</h3><table><thead><tr><th>Supply</th><th>Current / target</th><th>Deficit</th><th>State</th></tr></thead><tbody>{#each detail.status.targets as supply}<tr><td>{supply.name}</td><td>{supply.current ?? "UNKNOWN"} / {supply.target}</td><td>{supply.deficit ?? "UNKNOWN"}</td><td>{supply.state}</td></tr>{/each}</tbody></table>
        <h3>Candidate physical source</h3><p>{detail.candidateSource.kind} · corporation {detail.candidateSource.corporationID ?? "personal"} · division {detail.candidateSource.division ?? "—"} · office {detail.candidateSource.officeID ?? "—"} · actual contents location {detail.candidateSource.contentsLocationID ?? "UNKNOWN"} · flag {detail.candidateSource.flag}</p>
        <p>Stock observation: {detail.candidateSource.quality} · Query {detail.candidateSource.query} · Take {detail.candidateSource.take}. {detail.candidateSource.reasons.join(" · ")}</p>
        <table><thead><tr><th>Observed stock</th><th>Quantity</th><th>Item ID</th></tr></thead><tbody>{#each detail.candidateSource.rows as item}<tr><td>{item.name}</td><td>{item.quantity}</td><td>{item.itemID}</td></tr>{/each}</tbody></table>
        {#if detail.evidence}<h3>Observation evidence</h3><p>{detail.evidence.boundary} · stable {detail.evidence.stable ? "yes" : "no"} · {new Date(detail.evidence.completedAt).toISOString()}</p><small>{detail.evidence.digest}</small><p>{detail.evidence.unsupported.join(" · ")}</p>{/if}
        <h3>Accepted provisioning plan</h3>
        <p>Target pilot: {detail.pilot.name} · {detail.pilot.characterID}. Current hull: {detail.pilot.hullName || "UNKNOWN"}. Fitting: {detail.selected?.name || "Select a definition"}.</p>
        <p>Provider corporation: {detail.definitions.corporationID ?? "UNKNOWN"}. Physical source: {detail.candidateSource.kind} · corporation {detail.candidateSource.corporationID ?? "personal"} · division {detail.candidateSource.division ?? "—"}.</p>
        {#if detail.applyReview.plan}
          <p>Target hull: {detail.applyReview.plan.targetHullName}. Hull acquisition: <strong>{detail.applyReview.plan.hullQuantity}</strong> · {detail.applyReview.plan.mode}.</p>
          <p>{detail.applyReview.plan.steps.join(" → ") || "ALREADY SATISFIED / NO HULL ACQUISITION"}</p>
          <p>Unsupported: {detail.applyReview.plan.unsupported.join(" · ") || "none"}. Shortages: {detail.applyReview.plan.shortages.join(" · ") || "none"}. Destructive actions: {detail.applyReview.plan.destructiveActions.join(" · ") || "none"}.</p>
        {/if}
        <p>Supplies policy: NEW HULL ONLY. New hull provisioning loads declared deficits; an exact existing ship is a no-op, even when supplies remain LOW. Use the held-pilot Replenish action for a separate top-up.</p>
        <p>Apply authority: free-only acquisition required; source/Take revalidated after acquisition. Offline FREE and Query visibility do not grant mutation authority.</p>
        <p>{detail.applyReview.canApply ? "READY FOR APPLY · complete supported plan; selected-session revalidation still required" : detail.applyReview.reasons.join(" · ")}</p>
        <button disabled={busy || !detail.applyReview.canApply} onclick={()=>void run(apply)}>Apply accepted plan</button>
        {#each detail.pendingApply as operation}<p>Recovery: {operation.state} · {operation.reason || "pending ownership/custody proof"} <button disabled={busy} onclick={()=>void run(()=>recover(operation.operationID))}>Reconcile control without reacquiring</button></p>{/each}
      </section>
    {/if}
  {/if}
  {#if outcome}<section aria-label="Apply outcome"><h2>{outcome.state}</h2><p>{outcome.reason || ""}</p><p>Control: {outcome.control?.state || "not acquired"} · generation {outcome.control?.generation || "—"}</p><p>Revalidation: {outcome.revalidation?.state || "not proven"}</p><p>Provisioning: {outcome.provisioning?.state || "not dispatched"} · hull {outcome.provisioning?.manifest?.targetHullID ?? "—"}</p><p>Release: <strong>{outcome.release.state}</strong></p>{#if outcome.finalReview}<p>Final equipment: {outcome.finalReview.status.equipment} · Supplies: {outcome.finalReview.status.supplies}</p>{/if}<small>Operation {outcome.operationID}</small></section>{/if}
  {#if busy}<p role="status">{applying ? outcome?.state || "ACQUIRING CONTROL" : "Reading authoritative observation…"}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
</main>
<style>
  .center{padding:2rem;max-width:1600px;margin:auto;color:var(--text,#ddd)} header{display:flex;gap:1.5rem;align-items:center;flex-wrap:wrap} h1{font-size:1.8rem} h2{font-size:1.35rem;margin:1rem 0} h3{margin:1rem 0 .5rem} p{margin:.7rem 0} section{border:1px solid #394351;padding:1rem;margin-top:1.5rem} table{width:100%;border-collapse:collapse;margin:.8rem 0} th,td{padding:.5rem;text-align:left;border-bottom:1px solid #394351;vertical-align:top} small{display:block;font-size:.75rem;color:#aab8ca;overflow-wrap:anywhere} input,select,button{padding:.45rem;border:1px solid #526078;background:#18212e;color:#eee;border-radius:3px} button:disabled{opacity:.5} label{display:flex;flex-direction:column;gap:.3rem} form,.selectors{display:flex;gap:1rem;align-items:end;flex-wrap:wrap} a{color:#90c9ff}[role=alert]{color:#ffb4ab}
</style>
