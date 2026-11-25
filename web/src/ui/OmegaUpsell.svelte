<script lang="ts">
  import type { ClientStore } from "../store/clientStore.ts";
  import { CLONE_GRADE_ALPHA, CLONE_GRADE_OMEGA } from "../bridge/cloneGrade.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, onShowOmegaOffers }: { store: ClientStore; onShowOmegaOffers?: () => void } = $props();
  const station = $derived(store.station);
  const grade = $derived($station.cloneGrade === CLONE_GRADE_OMEGA ? "Omega"
    : $station.cloneGrade === CLONE_GRADE_ALPHA ? "Alpha" : null);
  const icon = clientTexture("res:/UI/Texture/WindowIcons/upsell.png");
</script>

<section class="omega-upsell">
  <header>
    <img src={icon} alt="" />
    <div>
      <h2>{grade === "Omega" ? "Omega benefits" : "Upgrade to Omega"}</h2>
      {#if grade}<p class="clone-grade">Current clone state <strong>{grade}</strong></p>{/if}
    </div>
  </header>
  <ul>
    <li>Train skills faster.</li>
    <li>Access more ships, modules, and skills.</li>
  </ul>
  {#if onShowOmegaOffers}<button type="button" onclick={onShowOmegaOffers}>View game time offers</button>{/if}
</section>

<style>
  .omega-upsell { padding: 24px; max-width: 720px; }
  header { display: flex; align-items: center; gap: 15px; border-bottom: 1px solid var(--line, #39444b); padding-bottom: 16px; }
  img { width: 64px; height: 64px; }
  h2, p { margin: 0; }
  .clone-grade { margin-top: 6px; }
  .clone-grade strong { margin-left: 6px; }
  ul { padding-left: 20px; line-height: 1.7; margin: 16px 0; }
</style>
