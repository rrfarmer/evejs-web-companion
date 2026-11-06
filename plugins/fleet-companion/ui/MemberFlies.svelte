<script lang="ts">
  // The Hangar's squad menu: whether this pilot flies as a companion in this squad. A toggle and
  // nothing more: ticking it writes the shipped default setup, and the rest is read off the ship.
  import type { SquadMemberSettingProps } from "../../../web/src/plugin-api/index.ts";
  import { companionSetups, setupFor, withSetup } from "../lib/companionSettings.ts";
  import { DEFAULT_COMPANION_SETUP } from "../lib/fleetCompanionLoop.ts";

  let { squad, characterID }: SquadMemberSettingProps = $props();
  const setups = companionSetups;
  const flies = $derived(setupFor($setups, squad.id, characterID) !== null);
</script>

<label class="hangar-squadmenu-setuprow">
  <input
    type="checkbox"
    checked={flies}
    onchange={() => setups.set(withSetup(setups.get(), squad.id, characterID, flies ? null : DEFAULT_COMPANION_SETUP))}
  />
  <span>Flies as companion</span>
</label>
