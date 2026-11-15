<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { shortWrittenInterval, SHORT_INTERVAL_WORD_LABELS } from "../bridge/timeInterval.ts";
  import { ATTRIBUTE_VALUE_LABELS, formatAttributeValue, type AttributeWords } from "../bridge/typeComparison.ts";
  import { BASE_WARP_SPEED, WARP_SPEED_MULTIPLIER, SHIP_INFO_GROUPS, shipInfoValues } from "../bridge/shipInfoAttributes.ts";
  import { attributeChanged } from "../bridge/dogma/affectedBy.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { showInfo } from "./showInfo.ts";
  import InfoAttributeHint from "./InfoAttributeHint.svelte";

  let { typeID, itemID, store, flow }: { typeID: number; itemID: number | null; store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const { fitting, words, names } = store;
  const WARP = "UI/Fitting/FittingWindow/WarpSpeed";
  const ALIGN = "Tooltips/FittingWindow/AlignTime";
  const damage = [
    { title: "EM", icon: 12, color: "#276c99" },
    { title: "Thermal", icon: 10, color: "#9b3636" },
    { title: "Kinetic", icon: 9, color: "#777" },
    { title: "Explosive", icon: 11, color: "#aa611d" },
  ];
  let read = $state.raw<Awaited<ReturnType<AppFlow["comparisonTypes"]>>>(null);
  let loading = $state(true);
  $effect(() => {
    const id = typeID;
    let current = true;
    read = null;
    loading = true;
    flow.requestWords([...ATTRIBUTE_VALUE_LABELS, ...SHORT_INTERVAL_WORD_LABELS, WARP, ALIGN, ...SHIP_INFO_GROUPS.map(group => group.label)]);
    void flow.comparisonTypes([id]).then(value => {
      if (current) read = value;
    }).catch(() => {}).finally(() => { if (current) loading = false; });
    return () => { current = false; };
  });
  const rows = $derived(read?.types.get(typeID)?.attributes ?? []);
  const live = $derived(itemID === null ? undefined : $fitting.dogma?.ships.find(row =>
    row.sublocation == null && Number(row.itemID) === itemID && row.typeID === typeID)?.attributes);
  const base = $derived(shipInfoValues(rows));
  const values = $derived(shipInfoValues(rows, live));
  const modifiers = $derived.by(() => {
    // fitting/reckoned publishes after the location and its source attributes are ready.
    const fit = $fitting;
    if (itemID === null || fit.activeShipID !== itemID) return null;
    const changed = [...values].flatMap(([id, value]) => {
      const original = base.get(id);
      return original !== undefined && attributeChanged(original, value) ? [id] : [];
    });
    if (changed.includes(BASE_WARP_SPEED)) changed.push(WARP_SPEED_MULTIPLIER);
    return flow.fittingAttributeModifiers(itemID, typeID, changed);
  });
  const align = $derived.by(() => {
    const mass = values.get(4), agility = values.get(70);
    return mass && mass > 0 && agility && agility > 0 ? Math.log(4) * mass * agility / 1_000_000 : null;
  });
  function text(path: string, fallback = "", args: Readonly<Record<string, string>> = {}): string {
    return plainText(formatTemplate($words.templates[path] || fallback, args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  }
  function message(id: number | null | undefined): string {
    return id ? plainText($words.templates[`#${id}`] ?? "") : "";
  }
  const units: AttributeWords = {
    label: (path, args) => text(path, path === "UI/InfoWindow/ValueAndUnit" ? "{value} {unit}" : "", args),
    message,
    unitName: id => message(read?.unitNameIDs.get(id)),
    typeName: id => resolvedName($names.resolved, "type", id, ""),
    groupName: id => resolvedName($names.resolved, "group", id, ""),
    attribute: id => read?.attributes.get(id) ?? null,
    shortInterval: ticks => shortWrittenInterval(ticks, $words.templates, "year", "millisecond"),
  };
  const groups = $derived(SHIP_INFO_GROUPS.map(group => ({
    ...group,
    items: group.attributes.flatMap(id => {
      const value = values.get(id), record = read?.attributes.get(id);
      if (value === undefined || !record?.published || (value === 0 && !record.displayWhenZero)) return [];
      const label = message(record.displayNameID);
      if (!label) return [];
      const format = (amount: number) => id === BASE_WARP_SPEED
        ? text(WARP, "{distText}/s", { distText: amount.toLocaleString("en-US", { maximumFractionDigits: 2 }) + " AU" })
        : formatAttributeValue(id, record, amount, units);
      const unmodified = base.get(id);
      return [{ id, value, label, formatted: format(value), compared: unmodified === undefined || !attributeChanged(unmodified, value) ? "" : format(unmodified),
        tooltip: message(record.tooltipDescriptionID), typeID: record.unitID === 116 ? Math.trunc(value) : null }];
    }),
    protections: (group.resistance ?? []).flatMap((id, index) => {
      const value = values.get(id);
      const original = base.get(id);
      return value === undefined ? [] : [{ id, damage: damage[index]!, percent: (1 - value) * 100, hint: message(read?.attributes.get(id)?.displayNameID),
        compared: original === undefined || !attributeChanged(original, value) ? "" : resistancePercent((1 - original) * 100) }];
    }),
  })).filter(group => group.items.length > 0 || group.protections.length > 0));
  const resistancePercent = (percent: number) => percent.toLocaleString("en-US", { maximumFractionDigits: 1 }) + "%";
</script>

{#if loading}
  <p role="status">Reading ship attributes…</p>
{:else if read?.types.get(typeID) == null}
  <p role="status">Ship attributes are unavailable.</p>
{:else}
  <div class="ship-attributes">
    {#each groups as group (group.label)}
      <details open>
        <summary>
          <img src={clientTexture(`res:/UI/Texture/eveicon/${group.icon}_16px.png`)} width="16" height="16" alt="" />
          <strong>{text(group.label, group.title)}</strong>
          {#if group.title === "Navigation" && align !== null}<span class="align">{text(ALIGN, "Align Time")} {align.toFixed(2)} s</span>{/if}
        </summary>
        {#if group.protections.length}
          <div class="resistances">
            {#each group.protections as row (row.id)}
              <span class="resistance" title={row.hint || row.damage.title} style:--damage={row.damage.color} style:--fill={`${Math.max(0, Math.min(100, row.percent))}%`}>
                <img src={clientTexture(`res:/UI/Texture/Icons/22_32_${row.damage.icon}.png`)} width="16" height="16" alt={row.damage.title + " "} />
                {#if row.compared}
                  <InfoAttributeHint {store} {flow} label={row.hint || row.damage.title} value={resistancePercent(row.percent)}
                    base={row.compared} sources={modifiers?.get(row.id)?.sources} />
                {:else}{resistancePercent(row.percent)}{/if}
              </span>
            {/each}
          </div>
        {/if}
        <dl>
          {#each group.items as row (row.id)}
            <dt title={row.tooltip || undefined}>{row.label}</dt>
            <dd>
              {#if row.typeID !== null && row.formatted}
                {@const related = row.typeID}<button type="button" class="evelink" onclick={() => showInfo({ kind: "type", typeID: related })}>{row.formatted}</button>
              {:else if row.compared}
                {@const extra = row.id === BASE_WARP_SPEED ? modifiers?.get(WARP_SPEED_MULTIPLIER)?.sources ?? [] : []}
                <InfoAttributeHint {store} {flow} label={row.label} value={row.formatted} base={row.compared}
                  sources={[...(modifiers?.get(row.id)?.sources ?? []), ...extra]} />
              {:else}{row.formatted}{/if}
            </dd>
          {/each}
        </dl>
      </details>
    {/each}
  </div>
{/if}

<style>
  details { margin-bottom: 8px; background: #ffffff09; }
  summary { padding: 7px 8px; cursor: pointer; background: #ffffff10; }
  summary img { display: inline-block; vertical-align: middle; margin: 0 5px; }
  .align { float: right; color: #cdd2d7; font-variant-numeric: tabular-nums; }
  dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; margin: 0; }
  dt, dd { margin: 0; padding: 4px 8px; border-top: 1px solid #ffffff0d; }
  dd { text-align: right; font-variant-numeric: tabular-nums; }
  .resistances { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; padding: 5px 8px; }
  .resistance { display: flex; align-items: center; gap: 2px; padding: 2px; font-size: 11px; background: linear-gradient(to right, var(--damage) var(--fill), #ffffff0d var(--fill)); }
  .evelink { padding: 0; border: 0; background: transparent; }
</style>
