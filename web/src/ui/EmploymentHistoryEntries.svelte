<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { EMPLOYMENT_WORD_LABELS as LABEL, type EmploymentHistory, type EmploymentLine } from "../bridge/employmentHistory.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";

  let { history, store, flow }: { history: EmploymentHistory; store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const { words, names } = store;
  $effect(() => flow.requestWords([...Object.values(LABEL), DATE_LABELS.ls!, "UI/Common/NothingFound"]));

  function text(label: string, fallback: string, args: Record<string, number | string> = {}): string {
    return plainText(formatTemplate($words.templates[label] || fallback, args, { nameOf: () => "" }));
  }
  const date = (ticks: string) => text(DATE_LABELS.ls!, "{[datetime]datetime}", { datetime: ticks });
  const CORP = "{corporation}";
  function period(line: EmploymentLine): readonly [string, string] {
    const fromDate = date(line.fromDate);
    const range = line.toDate === null
      ? text(LABEL.toThisDay, "{corpName} {fromDate} to this day", { corpName: CORP, fromDate })
      : text(LABEL.fromTo, "{corpName} {fromDate} to {toDate}", { corpName: CORP, fromDate, toDate: date(line.toDate) });
    const [before, after] = range.split(CORP, 2);
    const days = text(LABEL.days, "{numDays} days", { numDays: line.days }).trim();
    return after === undefined ? ["", ` ${range} (${days})`] : [before ?? "", `${after} (${days})`];
  }
  function corporation(line: EmploymentLine): string {
    const corpName = resolvedName($names.resolved, "corporation", line.corporationID, "Unknown corporation");
    return line.deleted ? text(LABEL.closed, "{corpName} (Closed)", { corpName }) : corpName;
  }
</script>

{#if history.lines.length}
  <ul>
    {#each history.lines as line, index (index)}
      {@const [before, after] = period(line)}
      <li>{before}<button type="button" class="evelink showInfo" onclick={() => showInfo({ kind: "corporation", corporationID: line.corporationID })}>{corporation(line)}</button>{after}</li>
    {/each}
  </ul>
{/if}
{#if history.transfers.length}
  <h4>{text(LABEL.transfers, "Character Transfers")}</h4>
  <ul>
    {#each history.transfers as transferDate, index (index)}
      <li>{text(LABEL.transferredOn, "Transferred {[datetime]transferDate}", { transferDate })}</li>
    {/each}
  </ul>
{/if}
{#if !history.lines.length && !history.transfers.length}
  <p>{text("UI/Common/NothingFound", "Nothing found")}</p>
{/if}

<style>
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding: 6px 4px; border-bottom: 1px solid #ffffff1a; }
  .evelink { padding: 0; border: 0; background: none; }
</style>
