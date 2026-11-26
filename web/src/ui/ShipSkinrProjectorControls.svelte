<script lang="ts">
  import { plainText } from "../bridge/clientWords.ts";
  import { DEFAULT_PATTERN_CONTROLS, type ShipSkinrPatternControls } from "../bridge/shipSkinrPatterns.ts";

  let { labels, controls, areas, mirrored, onControls, onAreas, onMirror }: {
    labels: Readonly<Record<string, string | null>>;
    controls: ShipSkinrPatternControls | null;
    areas: readonly boolean[];
    mirrored: boolean;
    onControls: (controls: ShipSkinrPatternControls) => void;
    onAreas: (areas: boolean[]) => void;
    onMirror: (mirrored: boolean) => void;
  } = $props();
  const path = "UI/Personalization/ShipSkins/SKINR/Studio/";
  const word = (key: string, fallback: string) => plainText(labels[path + key] ?? fallback);
  const groups = [
    { label: "OrbitalPanelButton", fallback: "Orbit", fields: [
      { key: "yaw", label: "Horizontal orbit", min: -0.999, max: 0.999, converted: (value: number) => `${((value / 1.998 + 0.5) * 360).toFixed(1)}°` },
      { key: "pitch", label: "Vertical orbit", min: -0.999, max: 0.999, converted: (value: number) => `${(value / 1.998 * 180).toFixed(1)}°` },
    ] },
    { label: "OffsetPanelButton", fallback: "Offset", fields: [
      { key: "offset_u_ratio", label: "Horizontal offset", min: -1, max: 1, converted: (value: number) => `${(value * 100).toFixed(1)}%` },
      { key: "offset_v_ratio", label: "Vertical offset", min: -1, max: 1, converted: (value: number) => `${(value * 100).toFixed(1)}%` },
    ] },
    { label: "RotateScalePanelButton", fallback: "Rotate and Scale", fields: [
      { key: "roll", label: "Rotation", min: -1, max: 1, converted: (value: number) => `${(value * 180).toFixed(1)}°` },
      { key: "scaling", label: "Scale", min: 0, max: 1, converted: (value: number) => `${(value * 2).toFixed(2)}×` },
    ] },
  ] as const;
  const areaLabels = [["PrimaryArea", "Primary"], ["SecondaryArea", "Secondary"],
    ["DetailingArea", "Detailing"], ["TechArea", "Tech"]] as const;
  const presets = [
    { key: "PatternProjectionTop", label: "Top", yaw: 0.999, pitch: 0.999 },
    { key: "PatternProjectionFront", label: "Front", yaw: -1, pitch: 0 },
    { key: "PatternProjectionRight", label: "Right", yaw: 0.5, pitch: 0 },
  ];

  function change(key: keyof ShipSkinrPatternControls, value: number) {
    if (controls) onControls({ ...controls, [key]: value });
  }
</script>

<section class="projector-controls" aria-label="Pattern projector">
  {#if controls}
    <div class="presets" aria-label={word("Gizmo/ProjectionPresets", "Projection Presets")}>
      {#each presets as preset (preset.key)}
        <button type="button" onclick={() => controls && onControls({ ...controls, yaw: preset.yaw, pitch: preset.pitch })}>
          {word("Gizmo/" + preset.key, preset.label)}
        </button>
      {/each}
      <button type="button" onclick={() => onControls({ ...DEFAULT_PATTERN_CONTROLS })}>
        {word("ResetPatternProjection", "Reset Pattern Projection")}
      </button>
    </div>
    <div class="transform">
      {#each groups as group (group.label)}
        <fieldset>
          <legend>{word("Gizmo/" + group.label, group.fallback)}</legend>
          {#each group.fields as field (field.key)}
            <label>
              <span>{field.label} <output>{field.converted(controls[field.key])}</output></span>
              <input type="range" data-projector={field.key} min={field.min} max={field.max} step="0.001" value={controls[field.key]}
                oninput={event => change(field.key, event.currentTarget.valueAsNumber)} />
            </label>
          {/each}
        </fieldset>
      {/each}
    </div>
  {/if}
  <fieldset class="targets">
    <legend>Projection Areas</legend>
    {#each areaLabels as [key, fallback], index (key)}
      <label><input type="checkbox" data-pattern-area={index + 1} checked={areas[index]}
        onchange={event => onAreas(areas.map((value, at) => index === at ? event.currentTarget.checked : value))} />{word(key, fallback)}</label>
    {/each}
    <label><input type="checkbox" data-pattern-mirror checked={mirrored} onchange={event => onMirror(event.currentTarget.checked)} />
      {word("Gizmo/MirrorToggle", "Mirror Pattern")}</label>
  </fieldset>
</section>

<style>
  .projector-controls, .transform { display: grid; gap: 8px; }
  .transform { grid-template-columns: repeat(auto-fit, minmax(min(100%, 175px), 1fr)); }
  fieldset { display: grid; gap: 5px; min-width: 0; border: 1px solid #ffffff24; padding: 7px; }
  fieldset label span { display: flex; justify-content: space-between; gap: 6px; }
  input[type="range"] { width: 100%; }
  output { color: #b8c3cc; white-space: nowrap; }
  .presets, .targets { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .targets label { display: inline-flex; align-items: center; gap: 5px; }
</style>
