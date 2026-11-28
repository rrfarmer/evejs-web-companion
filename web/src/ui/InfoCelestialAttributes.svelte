<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, statistics, kind, itemID }: {
    store: ClientStore; flow: AppFlow; statistics: Readonly<Record<string, number>>; kind: "moon" | "planet"; itemID: number;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const root = "UI/Generic/FormatPlanetAttributes/";
  const sovRoot = "UI/Sovereignty/";
  const attributes = "UI/InfoWindow/TabNames/Attributes";
  const showInfoLabel = "UI/Commands/ShowInfo";
  const copyLabel = "UI/Common/Copy";
  const sovLabels = ["ReagentType", "HarvestingAmount", "AmountPerMinute", "Power", "PowerFmt", "Workforce", "WorkforceFmt"];
  const menu = new ContextMenu();
  onDestroy(() => menu.close());
  let sovereignty = $state.raw<Awaited<ReturnType<AppFlow["planetSovereigntyAttributes"]>>>(null);
  $effect(() => {
    const id = itemID;
    sovereignty = null;
    if (kind !== "planet") return;
    let active = true;
    void flow.planetSovereigntyAttributes(id).then(read => {
      if (!active) return;
      sovereignty = read;
      if (!read) return;
      flow.requestWords([showInfoLabel, copyLabel, ...sovLabels.map(key => sovRoot + key)]);
      if (read.reagentType !== null) flow.requestNames([{ kind: "type", id: read.reagentType }]);
    }).catch(() => {});
    return () => { active = false; menu.close(); };
  });
  const AU = 149_597_870_700;
  const number = (value: number, decimals = 2) => value.toLocaleString(undefined, { maximumFractionDigits: decimals });
  function text(key: string, fallback: string, value?: string | number): string {
    return plainText(formatTemplate($words.templates[root + key] ?? fallback, value === undefined ? {} : { value }, { nameOf: () => "" }));
  }
  function sovText(key: string, fallback: string, args: Record<string, string | number> = {}): string {
    return plainText(formatTemplate($words.templates[sovRoot + key] ?? fallback, args, { nameOf: () => "" }));
  }
  function openSovMenu(row: Element, x: number, y: number): boolean {
    const cell = row.matches("dt[data-sov-attribute]") ? row.nextElementSibling
      : row.previousElementSibling?.matches("dt[data-sov-attribute]") ? row : null;
    const value = cell?.querySelector("span")?.textContent?.trim();
    if (!value) return false;
    const typeID = cell?.previousElementSibling?.getAttribute("data-sov-attribute") === "reagentType" ? sovereignty?.reagentType : null;
    const entries: (ContextEntry | null)[] = [{
      path: copyLabel, label: $words.templates[copyLabel] ?? "Copy",
      run: () => void navigator.clipboard.writeText(value).catch(() => {}),
    }];
    if (typeID) entries.unshift({
      path: showInfoLabel, label: $words.templates[showInfoLabel] ?? "Show Info", info: true,
      run: () => showInfo({ kind: "type", typeID }),
    }, null);
    menu.open(x, y, entries);
    return true;
  }
  const definitions = [
    ["density", "attributeDensity", "Density", (v: number) => text("formatDensity", `${number(v)} kg/m³`, v)],
    ["eccentricity", "attributeEccentricity", "Eccentricity", (v: number) => text("formatEccentricity", number(v), v)],
    ["escapeVelocity", "attributeEscapeVelocity", "Escape Velocity", (v: number) => text("formatEscapeVelocity", `${number(v / 1000)} km/s`, v / 1000)],
    ["massDust", "attributeMassDust", "Mass", (v: number) => text("formatMassInKG", `${v.toExponential(1)} kg`, v.toExponential(1))],
    ["orbitPeriod", "attributeOrbitPeriod", "Orbit Period", (v: number) => {
      const days = v / 864_000;
      return days > 1 ? text("formatOrbitalPeriodInt", `${Math.trunc(days)} days`, Math.trunc(days))
        : text("formatOrbitalPeriodFloat", `${number(days)} days`, days);
    }],
    ["orbitRadius", "attributeOrbitRadius", "Orbit Radius", (v: number) => v / AU > 0.1
      ? text("formatOrbitalRadiusInAU", `${number(v / AU)} AU`, v / AU)
      : text("formatOrbitalRadiusInKM", `${number(Math.trunc(v), 0)} km`, number(Math.trunc(v), 0))],
    ["pressure", "attributePressure", "Surface Pressure", (v: number) => v < 1000
      ? text("formatSurfacePresureVeryLow", "Very low") : text("formatSurfacePresure", `${number(v / 100_000)} bar`, v / 100_000)],
    ["radius", "attributeRadius", "Radius", (v: number) => text("formatOrbitalRadiusInKM", `${number(Math.trunc(v / 1000), 0)} km`, number(Math.trunc(v / 1000), 0))],
    ["surfaceGravity", "attributeSurfaceGravity", "Surface Gravity", (v: number) => text("formatSurfaceGravity", `${number(v)} m/s²`, v)],
    ["temperature", "attributeTemperature", "Temperature", (v: number) => text("formatTempatureKelvin", `${Math.trunc(v)} K`, String(Math.trunc(v)))],
  ] as const;
  const rows = $derived(definitions.filter(([key]) => statistics[key] !== undefined && (key !== "eccentricity" || kind === "planet")));
  $effect(() => flow.requestWords([attributes, ...definitions.map(([, key]) => root + key),
    ...["formatDensity", "formatEccentricity", "formatEscapeVelocity", "formatMassInKG", "formatOrbitalPeriodInt", "formatOrbitalPeriodFloat",
      "formatOrbitalRadiusInAU", "formatOrbitalRadiusInKM", "formatSurfacePresureVeryLow", "formatSurfacePresure",
      "formatSurfaceGravity", "formatTempatureKelvin"].map(key => root + key)]));
</script>

{#if rows.length || sovereignty}
  <h3>{$words.templates[attributes] ?? "Attributes"}</h3>
  <dl class="kv" aria-label={$words.templates[attributes] ?? "Attributes"} oncontextmenu={event => {
    const row = (event.target as Element).closest("dt, dd");
    if (row && openSovMenu(row, event.clientX, event.clientY)) event.preventDefault();
  }}>
    {#each rows as [key, path, fallback, display] (key)}
      {@const value = statistics[key]}
      {#if value !== undefined}<dt>{text(path, fallback)}</dt><dd>{display(value)}</dd>{/if}
    {/each}
    {#if sovereignty}
      {#if sovereignty.reagentType !== null}
        {@const typeID = sovereignty.reagentType}
        <dt data-sov-attribute="reagentType">{sovText("ReagentType", "Reagent")}</dt>
        <dd>
          <span>{resolvedName($names.resolved, "type", typeID, "")}</span>
          <button type="button" class="type-info" title={$words.templates[showInfoLabel] ?? "Show Info"}
            aria-label={$words.templates[showInfoLabel] ?? "Show Info"} onclick={() => showInfo({ kind: "type", typeID })}
            onkeydown={event => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const row = event.currentTarget.closest("dd");
              if (row && openSovMenu(row, rect.left, rect.bottom)) event.preventDefault();
            }}>ⓘ</button>
        </dd>
      {/if}
      {#if sovereignty.reagentAmountPerMinute !== null}
        {@const value = sovereignty.reagentAmountPerMinute.toFixed(1)}
        <dt data-sov-attribute="reagentAmountPerMinute">{sovText("HarvestingAmount", "Reagent harvesting amount")}</dt>
        <dd><span>{sovText("AmountPerMinute", "{value}/min", { value })}</span></dd>
      {/if}
      {#if sovereignty.power !== null}
        <dt data-sov-attribute="power">{sovText("Power", "Power")}</dt>
        <dd><span>{sovText("PowerFmt", "{power} TW", { power: sovereignty.power })}</span></dd>
      {/if}
      {#if sovereignty.workforce !== null}
        <dt data-sov-attribute="workforce">{sovText("Workforce", "Workforce")}</dt>
        <dd><span>{sovText("WorkforceFmt", "{workforce} Wf", { workforce: sovereignty.workforce })}</span></dd>
      {/if}
    {/if}
  </dl>
{/if}

<style>
  .type-info { border: 0; background: transparent; margin-inline-start: 4px; }
</style>
