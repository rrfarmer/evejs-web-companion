<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";

  let { store, flow, statistics, kind }: {
    store: ClientStore; flow: AppFlow; statistics: Readonly<Record<string, number>>; kind: "moon" | "planet";
  } = $props();
  const words = $derived(store.words);
  const root = "UI/Generic/FormatPlanetAttributes/";
  const attributes = "UI/InfoWindow/TabNames/Attributes";
  const AU = 149_597_870_700;
  const number = (value: number, decimals = 2) => value.toLocaleString(undefined, { maximumFractionDigits: decimals });
  function text(key: string, fallback: string, value?: string | number): string {
    return plainText(formatTemplate($words.templates[root + key] ?? fallback, value === undefined ? {} : { value }, { nameOf: () => "" }));
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

{#if rows.length}
  <h3>{$words.templates[attributes] ?? "Attributes"}</h3>
  <dl class="kv" aria-label={$words.templates[attributes] ?? "Attributes"}>
    {#each rows as [key, path, fallback, display] (key)}
      {@const value = statistics[key]}
      {#if value !== undefined}<dt>{text(path, fallback)}</dt><dd>{display(value)}</dd>{/if}
    {/each}
  </dl>
{/if}
