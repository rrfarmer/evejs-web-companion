<script lang="ts">
  import { academyWheelSlots, type AcademyCatalogue, type AcademyOffer } from "../bridge/academyShips.ts";
  import { academySlotPlacement, CLIENT_BASE, type SlotFamily } from "./fittingGeometry.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { offer, facts, typeName, description }: {
    offer: AcademyOffer;
    facts: AcademyCatalogue["facts"];
    typeName(typeID: number): string;
    description(typeID: number): string;
  } = $props();

  const families: Readonly<Record<number, SlotFamily>> = { 27: "high", 19: "mid", 11: "low", 92: "rig" };
  const slots = $derived(academyWheelSlots(offer, facts));
  const tooltipID = $props.id();
</script>

<div class="wheel" role="group" aria-label="Fitting preview">
  <div class="background"></div>
  <div class="cosmetic"></div>
  <div class="ring-base"></div>
  {#each slots as slot (slot.flag)}
    {@const position = academySlotPlacement(families[slot.rack]!, slot.index)}
    {@const style = `--x:${position.x / CLIENT_BASE * 100}%;--y:${position.y / CLIENT_BASE * 100}%;--angle:${position.angleDegrees}deg`}
    {#if slot.typeID !== null}
      {@const name = typeName(slot.typeID)}
      {@const copy = description(slot.typeID)}
      {@const id = `${tooltipID}-${slot.flag}`}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Focus reveals the same read-only module tooltip as hover.) -->
      <div class="slot fitted" {style} tabindex="0" role="img" aria-label={name} aria-describedby={id}>
        <span class="frame"></span>
        <span class="icon" aria-hidden="true"><TypeIcon typeID={slot.typeID} {name} size="socket" /></span>
        <span class="tip" class:align-left={position.x > CLIENT_BASE / 2} id={id} role="tooltip">
          <strong>{name}</strong>
          {#if copy}<span>{copy}</span>{/if}
        </span>
      </div>
    {:else}
      <div class="slot" {style} role="img" aria-label={`${slot.label}, slot ${slot.index + 1}, empty`}>
        <span class="frame"></span>
      </div>
    {/if}
  {/each}
</div>

<style>
  .wheel { position: absolute; top: 49.35%; left: 49.35%; translate: -50% -50%; width: min(87cqh, 94cqw); aspect-ratio: 1; pointer-events: none; }
  .ring-base, .background, .cosmetic { position: absolute; inset: 0; background: center / contain no-repeat; }
  .ring-base { background-image: url('/client-res/ui/texture/classes/fitting/academyships/minimal_fitting_ring.png'); }
  .background { inset: -16%; opacity: .1; background-image: url('/client-res/ui/texture/classes/fitting/academyships/background_circle.png'); }
  .cosmetic { inset: 5.47%; opacity: .003; background-image: url('/client-res/ui/texture/classes/fitting/academyships/module_circle.png'); }
  .slot { position: absolute; left: var(--x); top: var(--y); translate: -50% -50%; width: 11.25%; aspect-ratio: 1; display: grid; place-items: center; }
  .frame { position: absolute; inset: 0; rotate: var(--angle); opacity: .3; background: url('/client-res/ui/texture/classes/fitting/moduleframe.png') center / contain no-repeat; }
  .fitted { pointer-events: auto; }
  .fitted:hover, .fitted:focus { z-index: 1; }
  .fitted:focus-visible { outline: 1px solid #a3e2ef; }
  .icon { position: relative; width: 77.78%; height: 77.78%; }
  .icon :global(.type-icon) { width: 100%; height: 100%; }
  .tip { display: none; position: absolute; top: 75%; left: 75%; width: min(260px, 50cqw); padding: 8px 10px; background: #111b21; border: 1px solid #516b76; box-shadow: 0 4px 15px #000b; color: #e6eef1; font-size: 12px; line-height: 1.4; }
  .tip.align-left { left: auto; right: 75%; }
  .tip span { display: block; margin-top: 4px; color: #c0cdd3; }
  .fitted:hover .tip, .fitted:focus .tip { display: block; }
</style>
