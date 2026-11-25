<!-- WC74 web/src/ui/UnifiedOperations.svelte @ 213da333; plugin routing adapted. -->
<svelte:head><title>Unified Operations Center · EveJS Web Companion</title></svelte:head>

<main class="uoc-center">
  <header class="center-title-row"><h1>Unified Operations Center</h1>
    <a href="/">Pilot workspace</a></header>
  <nav aria-label="Operations centers">
    <a class="module" href="/uoc/mining-command-center/"><span class="tag">Industry</span><h2>Mining Command Center</h2>
      <p>Mining fleets on belts, ore anomalies and ice. Solo Mining and Distribution Missions.</p><span>Open MCC →</span></a>
    <div class="module" role="link" aria-disabled="true"><span class="tag">Combat</span><h2>Combat Operations Center</h2>
      <p>Coordinated Belt and Gate Patrols, Security Missions and Combat Anomalies.</p><span>In development</span></div>
    <a class="module" href="/uoc/pilot-training/"><span class="tag">Pilots</span><h2>Pilot Training Center</h2>
      <p>Role and accepted fitting requirements, skill progression, corporation onboarding and duty readiness.</p><span>Open Training →</span></a>
    <a class="module" href="/uoc/ship-provisioning/"><span class="tag">Equipment</span><h2>Ship Provisioning Center</h2>
      <p>Review equipment sources and shortages, then provision a physically verified ship.</p><span>Open Provisioning →</span></a>
    <a class="module" href="/uoc/distribution-center/"><span class="tag">Logistics</span><h2>Distribution Center</h2>
      <p>Run deliveries between corporate hangars with a shared fleet of haulers.</p><span>Open Distribution →</span></a>
  </nav>
</main>

<style>
  header {
    margin: 0.75rem 0 1.25rem;
  }
  h1 {
    margin: 0;
  }
  h2 {
    font-size: 1.3rem;
  }
  p {
    color: var(--center-muted);
  }
  .tag {
    color: var(--center-accent);
    font-size: 0.85rem;
  }
  nav {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 25rem), 1fr));
    gap: 0.85rem;
  }
  .module {
    display: flex;
    flex-direction: column;
    padding: 1rem;
    border: 1px solid var(--center-border);
    border-radius: 0.7rem;
    background: var(--center-panel);
    text-decoration: none;
    color: inherit;
  }
  a.module:hover,
  a.module:focus-visible {
    border-color: var(--center-accent);
    background: #18313c;
  }
  .module p {
    flex: 1;
  }
  .module > span:last-child {
    color: var(--center-accent);
  }
  .module[aria-disabled="true"] {
    color: var(--center-muted);
    cursor: not-allowed;
  }
  .module[aria-disabled="true"] span {
    color: inherit;
  }
</style>
