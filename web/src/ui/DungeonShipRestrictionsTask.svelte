<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { canEnterDungeonInShip, type ShipRestrictions } from "../bridge/dungeonTracking.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { flow, dungeonID, gateID, shipTypeID, label }: {
    flow: AppFlow;
    dungeonID: number;
    gateID: number;
    shipTypeID: number | null;
    label: string;
  } = $props();
  const icon = clientTexture("res:/UI/Texture/eveicon/system_icons/block_ban_16px.png");
  let restrictions = $state.raw<ShipRestrictions | null>(null);

  $effect(() => {
    restrictions = null;
    let active = true;
    void flow.readDungeonShipRestrictions(dungeonID, gateID).then((answer) => {
      if (active) restrictions = answer;
    }).catch(() => {});
    return () => { active = false; };
  });

  function open(): void {
    flow.openShipRestrictions(dungeonID, gateID);
  }
</script>

{#if label && shipTypeID !== null && !canEnterDungeonInShip(restrictions, shipTypeID)}
  <button type="button" onclick={(event) => { if (event.detail === 0) open(); }} ondblclick={open}>
    <span aria-hidden="true" style:--restriction-icon={`url(${icon})`}></span>
    {label}
  </button>
{/if}

<style>
  button { display: flex; align-items: center; gap: 4px; padding: 2px 0; border: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }
  button:hover, button:focus-visible { background: rgb(255 255 255 / 0.12); }
  span { width: 16px; height: 16px; background: var(--color-danger, #e08a8a); mask: var(--restriction-icon) center / contain no-repeat; }
</style>
