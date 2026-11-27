<script lang="ts">
  import { getShipTreeCatalogue } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { SKINR_HULL_RULES } from "../bridge/shipSkinrHullRules.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, typeID, open }: { store: ClientStore; flow: AppFlow; typeID: number; open: (typeID: number) => void } = $props();
  const words = $derived(store.words);
  const title = "UI/Personalization/ShipSkins/SKINR/Store/Title";
  const description = "UI/Personalization/ShipSkins/SKINR/Store/ShortDescription";
  const button = "UI/Personalization/ShipSkins/SKINR/Store/ViewStoreButton";
  let hulls = $state.raw<ReadonlySet<number> | null>(null);
  const skinnable = $derived(hulls?.has(typeID) && !SKINR_HULL_RULES.excluded.includes(typeID));

  $effect(() => {
    let current = true;
    flow.requestWords([title, description, button]);
    void getShipTreeCatalogue(flow.requestOptions()).then(data => {
      if (current && data) hulls = new Set(data.ships.filter(ship => ship.shipGroupID > 0).map(ship => ship.typeID));
    }).catch(() => {});
    return () => { current = false; };
  });
</script>

{#if skinnable}
  <section class="paragon" data-paragon-hull={typeID}>
    <div>
      <img src={clientTexture("res:/UI/texture/classes/paintTool/paragon_logo.png")} alt="" width="34" height="32" />
      <div>
        <strong>{plainText($words.templates[title] || "Paragon Hub")}</strong>
        {#if $words.templates[description]}<p>{plainText($words.templates[description])}</p>{/if}
      </div>
    </div>
    <button type="button" onclick={() => open(typeID)}>{plainText($words.templates[button] || "View Sequenced SKINs")}</button>
  </section>
{/if}

<style>
  .paragon { border-top: 1px solid #5c9da8; background: #5c9da81a; margin-bottom: 8px; }
  .paragon > div { display: flex; align-items: center; gap: 12px; padding: 12px 8px; }
  .paragon img { flex: none; }
  .paragon p { margin: 4px 0 0; }
  .paragon button { width: 100%; text-align: center; }
</style>
