<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ShipDefaultSkin } from "../bridge/shipSkinrCollection.ts";
  import { clientTexture } from "../play/window.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { flow, store, typeID, skin, isDefault }: {
    flow: AppFlow;
    store: ClientStore;
    typeID: number;
    skin: ShipDefaultSkin;
    isDefault: boolean;
  } = $props();
  const words = $derived(store.words);
  const set = "UI/Skins/SetDefault";
  const remove = "UI/Skins/RemoveDefault";
  $effect(() => { flow.requestWords([set, remove]); });
  const label = $derived(plainText($words.templates[isDefault ? remove : set] ?? (isDefault ? "Remove as default SKIN" : "Set as default SKIN")));
  const star = $derived(clientTexture(`res:/UI/Texture/eveicon/system_icons/${isDefault ? "star" : "star_hollow"}_16px.png`));
</script>

<button type="button" aria-label={label} title={label} aria-pressed={isDefault}
  data-default-skin={skin} onclick={() => flow.setShipDefaultSkin(typeID, isDefault ? null : skin)}>
  <img src={star} width="16" height="16" alt="" />
</button>

<style>
  button { padding: 4px; display: grid; place-items: center; }
</style>
