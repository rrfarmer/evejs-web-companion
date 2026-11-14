<script lang="ts">
  // agencyNew/ui/contentPages/contentPagePirateStrongholds (SingleColumnContentPage): the systems' cards
  // (PirateStrongholdContentCard: the system and its security, its jumps, "UI/Agency/PirateStronghold" with the
  // amount and the enemy faction's name under it), and the chosen one's PirateStrongholdInfoContainer
  // (PirateStrongholdsInSystem: the enemy faction's icon (60) and PirateStrongholdFactionText, the system's
  // strongholds each its name - its subtitle message -, PirateStrongholdNote in WARNING_ORANGE 10 below); the
  // information line PirateStrongholdMechanics, its tooltip the mechanics and FleetActivity (iconGroupActivity 32).
  // PirateStrongholdSystemContentPiece.GetIconTexturePath: the Blood Raiders' and the Guristas' site icons, else the
  // combat site's. The filters are the site pages' (distance and security).
  // Not here: the info container's per-stronghold actions (CustomContentPiece's warp to content), which no server the
  // page knows answers with a stronghold (Tranquility's recorded get_content_data was []; EveJS's provider is empty).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity } from "../bridge/systemSecurity.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import type { AgencySiteFilters } from "../bridge/agencySites.ts";

  let { store, flow, filters }: { store: ClientStore; flow: AppFlow; filters: AgencySiteFilters } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const A = "UI/Agency/";
  const nameOf = (kind: "owner" | "type" | "system", id: number) => resolvedName($names.resolved, kind as never, id, "");
  const word = (label: string, args: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", args as never, { nameOf: nameOf as never }));
  type Data = NonNullable<Awaited<ReturnType<AppFlow["agencyPirateStrongholds"]>>>;
  let data = $state<Data | null | undefined>(undefined), chosen = $state<number | null>(null);
  $effect(() => { const f = filters; void flow.agencyPirateStrongholds(f).then((d) => { data = d; }); });
  $effect(() => {
    flow.requestWords([`${A}PirateStrongholdsInSystem`, `${A}PirateStrongholdFactionText`, `${A}PirateStrongholdNote`, `${A}PirateStronghold`, `${A}PirateStrongholdMechanics`,
      `${A}Tooltips/Encounters/PirateStrongholds/PirateStrongholdMechanics`, `${A}Tooltips/FleetActivity`, "UI/Common/NothingFound", "UI/Common/numberOfJumps",
      ...(data?.systems ?? []).flatMap((s) => s.strongholds.flatMap((h) => [h.subtitleTextID, h.titleTextID])).filter((x): x is number => !!x).map((x) => `#${x}`)]);
  });
  $effect(() => { if (data) flow.requestNames(data.systems.flatMap((s) => [{ kind: "system" as const, id: s.solarSystemID }, ...s.strongholds.filter((h) => h.enemyFactionID).map((h) => ({ kind: "owner" as const, id: h.enemyFactionID! }))])); });
  const system = $derived(data?.systems.find((s) => s.solarSystemID === chosen) ?? data?.systems[0] ?? null);
  const icon = (faction: number | null) => `res:/UI/Texture/Classes/Agency/Icons/ContentTypes/${faction === 500012 ? "bloodRaiderSite" : faction === 500010 ? "guristasSite" : "CombatSite"}.png`;
  const message = (id: number | null) => (id ? word(`#${id}`) : "");
</script>

<div class="aps">
  <p class="aps-info" title={`${word(`${A}Tooltips/Encounters/PirateStrongholds/PirateStrongholdMechanics`)}\n\n${word(`${A}Tooltips/FleetActivity`)}`}>ⓘ {word(`${A}PirateStrongholdMechanics`)}</p>
  <div class="aps-body">
    <div class="aps-cards">
      {#each data?.systems ?? [] as s (s.solarSystemID)}
        {@const faction = s.strongholds[0]?.enemyFactionID ?? null}
        <button type="button" class="aps-card" class:on={system?.solarSystemID === s.solarSystemID} onclick={() => (chosen = s.solarSystemID)}>
          <img alt="" src={clientTexture(icon(faction))} />
          <span><b>{nameOf("system", s.solarSystemID)} {s.security === null ? "" : shownSecurity(s.security).toFixed(1)}</b>
            <small>{s.jumps === null ? "" : word("UI/Common/numberOfJumps", { numJumps: s.jumps })}</small>
            <small>{word(`${A}PirateStronghold`, { amount: s.strongholds.length })}<br />{faction ? nameOf("owner", faction) : ""}</small></span>
        </button>
      {:else}
        {#if data !== undefined}<p class="aps-none">{word("UI/Common/NothingFound")}</p>{/if}
      {/each}
    </div>
    {#if system}
      {@const faction = system.strongholds[0]?.enemyFactionID ?? null}
      <section class="aps-sec">
        <h4>{word(`${A}PirateStrongholdsInSystem`)}</h4>
        <div class="aps-faction"><span class="aps-icon">{faction ? nameOf("owner", faction).slice(0, 1) : ""}</span><span>{word(`${A}PirateStrongholdFactionText`, { factionID: faction })}</span></div>
        {#each system.strongholds as h (h.agencyContentID)}<p class="aps-entry">{message(h.subtitleTextID) || message(h.titleTextID)}</p>{/each}
        <p class="aps-note">⚠ {word(`${A}PirateStrongholdNote`)}</p>
      </section>
    {/if}
  </div>
</div>

<style>
  .aps { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; }
  .aps-info { margin: 0 0 10px; cursor: help; opacity: 0.85; }
  .aps-body { flex: 1; min-height: 0; display: flex; gap: 10px; }
  .aps-cards { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
  .aps-card { all: unset; cursor: pointer; display: flex; gap: 10px; padding: 8px; background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.1); }
  .aps-card.on { border-color: rgb(106 195 236 / 0.7); }
  .aps-card img { width: 32px; height: 32px; }
  .aps-card span { display: flex; flex-direction: column; gap: 2px; }
  .aps-none { opacity: 0.6; text-align: center; margin-top: 30px; }
  .aps-sec { width: 340px; flex: none; padding: 0 10px; background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); }
  .aps-sec h4 { font-size: 13px; font-weight: 600; text-transform: uppercase; opacity: 0.8; }
  .aps-faction { display: flex; gap: 4px; align-items: center; margin-bottom: 10px; }
  .aps-icon { width: 60px; height: 60px; display: grid; place-items: center; background: rgb(255 255 255 / 0.08); font-size: 24px; }
  .aps-entry { margin: 4px 0; }
  .aps-note { margin-top: 10px; color: #f0a030; }
</style>
