<script lang="ts">
  import type {GlobalWindowProps} from "../../../web/src/plugin-api/index.ts";
  let {sessions=[]}:GlobalWindowProps=$props();
</script>
<section aria-label="Unified Operations Center">
  <header><h1>Unified Operations Center</h1><a href="/">Pilot workspace</a></header>
  <p>Choose an operations module.</p>
  <nav class="modules" aria-label="Operations modules">
    <a href="/uoc/mining-command-center/"><strong>Mining Command Center</strong><span>Mining operations and civilian missions</span></a>
    <div role="link" aria-disabled="true"><strong>Combat Operations Center</strong><span>In development</span></div>
    <a href="/uoc/pilot-training/"><strong>Pilot Training Center</strong><span>Choose a fitting and train its skills</span></a>
    <a href="/uoc/ship-provisioning/"><strong>Ship Provisioning Center</strong><span>Review equipment and provision a ship</span></a>
  </nav>
</section>
<style>.modules{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem}.modules :is(a,[aria-disabled="true"]){display:grid;gap:.5rem;padding:1rem;border:1px solid #496070;border-radius:.5rem;color:inherit;text-decoration:none}.modules a:hover{border-color:#94c6db}.modules [aria-disabled="true"]{cursor:not-allowed}.modules span{opacity:.8}</style>
