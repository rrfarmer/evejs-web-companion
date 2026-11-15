<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { AttributeModifierSource } from "../bridge/dogma/affectedBy.ts";
  import { resolvedName } from "../store/names.ts";

  let { store, flow, label, value, base, sources = [] }: {
    store: ClientStore;
    flow: AppFlow;
    label: string;
    value: string;
    base: string;
    sources?: readonly AttributeModifierSource[];
  } = $props();
  // svelte-ignore state_referenced_locally
  const { words, names } = store;
  const tooltipID = $props.id();
  const MODIFIED = "UI/InfoWindow/AttributeModifiedWithBaseValue";
  const AFFECTED_BY = "UI/InfoWindow/AttributeModifiedByWithBaseValue";
  const EXTERNAL = "UI/InfoWindow/ExternalFactors";
  const OVERLOADED = "UI/InfoWindow/OverloadedModule";
  $effect(() => {
    flow.requestWords([MODIFIED, AFFECTED_BY, EXTERNAL, OVERLOADED]);
    const ids = new Set(sources.flatMap(source => source.typeID === null ? [] : [source.typeID]));
    flow.requestNames([...ids].flatMap(id => [{ kind: "type" as const, id }, { kind: "typeCategory" as const, id }]));
  });
  function sourceText(source: AttributeModifierSource): string {
    const arrow = source.direction === "up" ? "↑" : "↓";
    if (source.typeID === null) return `${arrow} ${$words.templates[EXTERNAL] || "External Factors"}`;
    const name = resolvedName($names.resolved, "type", source.typeID, "");
    if (!name) return "";
    const category = source.overloaded ? $words.templates[OVERLOADED] || "Overloaded Module"
      : resolvedName($names.resolved, "typeCategory", source.typeID, "");
    const count = source.count > 1 ? `${source.count}x ` : "";
    return `${arrow} ${category ? `${category}: ` : ""}${count}${name}`;
  }
  const hint = $derived.by(() => {
    const rows = sources.map(sourceText).filter(Boolean);
    const template = rows.length > 0
      ? $words.templates[AFFECTED_BY] || "Base value: {baseAttributeValue}<br>Affected by:<br>{affectedByText}"
      : $words.templates[MODIFIED] || "Base value: {baseAttributeValue}";
    return plainText(formatTemplate(template, { baseAttributeValue: base, affectedByText: rows.join("<br>") }, { nameOf: () => "" }));
  });
  let open = $state(false);
</script>

<span class="attribute-hint">
  <button type="button" aria-label={`${label} ${value}`} aria-describedby={tooltipID}
    onclick={() => (open = !open)} onblur={() => (open = false)}>{value}</button>
  <span role="tooltip" id={tooltipID} class:open>{hint}</span>
</span>

<style>
  .attribute-hint { position: relative; display: inline-block; }
  button { padding: 0; border: 0; background: none; color: #8bcfe8; font: inherit; cursor: help; }
  [role="tooltip"] {
    position: absolute; z-index: 10; right: 0; bottom: calc(100% + 3px);
    width: max-content; max-width: min(17rem, 65vw); padding: 6px 8px;
    border: 1px solid #53636f; background: #14191f; color: #ebeff2;
    font-size: 12px; text-align: left; white-space: pre-line; pointer-events: none;
    visibility: hidden;
  }
  .attribute-hint:hover [role="tooltip"], button:focus-visible + [role="tooltip"], [role="tooltip"].open { visibility: visible; }
</style>
