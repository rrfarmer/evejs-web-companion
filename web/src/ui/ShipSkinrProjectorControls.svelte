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
  interface Field {
    key: keyof ShipSkinrPatternControls;
    label: string;
    min: number;
    max: number;
    unitsPerRatio: number;
    origin: number;
    digits: number;
    unit: string;
  }
  const groups = [
    { label: "OrbitalPanelButton", fallback: "Orbit", fields: [
      { key: "yaw", label: "Horizontal orbit", min: -0.999, max: 0.999, unitsPerRatio: 360 / 1.998, origin: 180, digits: 1, unit: "°" },
      { key: "pitch", label: "Vertical orbit", min: -0.999, max: 0.999, unitsPerRatio: 180 / 1.998, origin: 0, digits: 1, unit: "°" },
    ] },
    { label: "OffsetPanelButton", fallback: "Offset", fields: [
      { key: "offset_u_ratio", label: "Horizontal offset", min: -1, max: 1, unitsPerRatio: 100, origin: 0, digits: 1, unit: "%" },
      { key: "offset_v_ratio", label: "Vertical offset", min: -1, max: 1, unitsPerRatio: 100, origin: 0, digits: 1, unit: "%" },
    ] },
    { label: "RotateScalePanelButton", fallback: "Rotate and Scale", fields: [
      { key: "roll", label: "Rotation", min: -1, max: 1, unitsPerRatio: 180, origin: 0, digits: 1, unit: "°" },
      { key: "scaling", label: "Scale", min: 0, max: 1, unitsPerRatio: 2, origin: 0, digits: 2, unit: "×" },
    ] },
  ] satisfies { label: string; fallback: string; fields: Field[] }[];
  const areaLabels = [["PrimaryArea", "Primary"], ["SecondaryArea", "Secondary"],
    ["DetailingArea", "Detailing"], ["TechArea", "Tech"]] as const;
  const presets = [
    { key: "PatternProjectionTop", label: "Top", yaw: 0.999, pitch: 0.999 },
    { key: "PatternProjectionFront", label: "Front", yaw: -1, pitch: 0 },
    { key: "PatternProjectionRight", label: "Right", yaw: 0.5, pitch: 0 },
  ];
  let editing = $state<{ key: Field["key"]; text: string } | null>(null);
  const clamp = (min: number, max: number, value: number) => Math.max(min, Math.min(max, value));
  const display = (field: Field, ratio: number) => (clamp(field.min, field.max, ratio) * field.unitsPerRatio + field.origin).toFixed(field.digits);

  function change(key: keyof ShipSkinrPatternControls, value: number) {
    if (controls && Number.isFinite(value) && controls[key] !== value) onControls({ ...controls, [key]: value });
  }

  function editNumber(field: Field, input: HTMLInputElement) {
    editing = { key: field.key, text: input.value };
    if (Number.isFinite(input.valueAsNumber)) {
      const rounded = Number(input.valueAsNumber.toFixed(field.digits));
      change(field.key, clamp(field.min, field.max, (rounded - field.origin) / field.unitsPerRatio));
    }
  }

  function finishNumber(field: Field, input: HTMLInputElement) {
    if (controls) input.value = display(field, controls[field.key]);
    editing = null;
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
            <div class="projector-field">
              <label>
                {field.label}
                <input type="range" data-projector={field.key} min={field.min} max={field.max} step="0.001" value={controls[field.key]}
                oninput={event => change(field.key, event.currentTarget.valueAsNumber)} />
              </label>
              <label class="numeric">
                <input type="number" inputmode="decimal" data-projector-number={field.key} aria-label={field.label + " value"}
                  min={display(field, field.min)} max={display(field, field.max)} step={10 ** -field.digits}
                  value={editing?.key === field.key ? editing.text : display(field, controls[field.key])}
                  oninput={event => editNumber(field, event.currentTarget)}
                  onblur={event => finishNumber(field, event.currentTarget)}
                  onkeydown={event => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      finishNumber(field, event.currentTarget);
                    }
                  }} />
                <span aria-hidden="true">{field.unit}</span>
              </label>
            </div>
          {/each}
        </fieldset>
      {/each}
    </div>
    <details>
      <summary>Projector shortcuts</summary>
      <p>Hold Ctrl over the ship preview. Drag with the left button to orbit, the right button to offset, or both buttons to scale. Scroll to rotate. Add Shift for precision or Alt while scrolling to snap by 15°.</p>
    </details>
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
  .projector-field { display: grid; grid-template-columns: minmax(0, 1fr) 6.25rem; gap: 6px; align-items: end; }
  .projector-field label { display: grid; gap: 3px; }
  .projector-field .numeric { grid-template-columns: minmax(0, 1fr) 1rem; align-items: center; }
  .numeric input { min-width: 0; width: 100%; text-align: right; }
  input[type="range"] { width: 100%; }
  .presets, .targets { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .targets label { display: inline-flex; align-items: center; gap: 5px; }
  details p { margin-top: 4px; color: #b8c3cc; }
  summary { cursor: pointer; }
</style>
