<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { TemplateArguments } from "../bridge/clientWords.ts";
  import { MILITIA_FACTIONS, WARZONE_FACTION_COLORS, type MilitiaFactionID, type MilitiaSystem } from "../bridge/militiaEnlistment.ts";
  import { clientTexture } from "../play/window.ts";
  import { openAgencyGroup } from "./agencyRequests.ts";

  let { flow, faction, opponent, occupations, enlisted, rank, word, factionName, militiaName, openEnlistment }: {
    flow: AppFlow; faction: MilitiaFactionID; opponent: MilitiaFactionID; occupations: readonly MilitiaSystem[]; enlisted: boolean;
    rank: number | null; word: (label: string, fallback: string, values?: TemplateArguments) => string;
    factionName: (id: MilitiaFactionID) => string; militiaName: string; openEnlistment: () => void;
  } = $props();
  const FW = "UI/FactionWarfare/", DASHBOARD = `${FW}frontlinesDashboard/`, PIRATES = "UI/PirateInsurgencies/";
  const portrait = $derived(clientTexture(`res:/UI/Texture/classes/frontlines/portraits/${MILITIA_FACTIONS[faction].logo}Prop.png`));
  const friendly = $derived(occupations.filter(system => system.occupierID === faction).length);
  const opposing = $derived(occupations.filter(system => system.occupierID === opponent).length);
  const share = $derived(friendly + opposing ? opposing / (friendly + opposing) : 0);
  const rankLabel = $derived(`${FW}Ranks/Rank${MILITIA_FACTIONS[faction].banner}${rank ?? 1}`);
  const cta = $derived(DASHBOARD + "CTA" + MILITIA_FACTIONS[faction].banner);

  function countLabel(id: MilitiaFactionID, systems: number) {
    return word(DASHBOARD + "nSystemsOccupiedBy", `${systems} systems occupied by ${factionName(id)}`, { systems, factionName: factionName(id) });
  }

  $effect(() => flow.requestWords([cta, rankLabel, FW + "Retire", DASHBOARD + "atWarWith", DASHBOARD + "nSystemsOccupiedBy",
    ...["FWExplainer", "FWConcordNote", "FactionTitleLabel", "MilitiaTitleLabel", "RankTitleLabel"].map(id => DASHBOARD + id),
    PIRATES + "openFactionSelection", PIRATES + "learnMore"]));
</script>

<aside aria-label={factionName(faction)}>
  <div class="poster" style:background-image={`url("${portrait}")`}>
    <div class="occupation">
      <span style:color={WARZONE_FACTION_COLORS[opponent]} title={countLabel(opponent, opposing)}>{opposing}</span>
      <span class="gauge" role="img" aria-label={`${countLabel(opponent, opposing)}. ${countLabel(faction, friendly)}`}
        style:background={friendly + opposing ? `conic-gradient(${WARZONE_FACTION_COLORS[opponent]} ${share}turn, ${WARZONE_FACTION_COLORS[faction]} 0turn)` : undefined}>
        <img alt="" src={clientTexture(`res:/UI/Texture/Classes/SkillPlan/factionButtons/icon${MILITIA_FACTIONS[faction].banner}.png`)} />
      </span>
      <span style:color={WARZONE_FACTION_COLORS[faction]} title={countLabel(faction, friendly)}>{friendly}</span>
    </div>
  </div>
  <div class="summary">
    <h3>{enlisted ? factionName(faction) : word(cta, factionName(faction))}</h3>
    <p class="enemy">{word(DASHBOARD + "atWarWith", "At war with")}
      <img src={clientTexture(`res:/UI/Texture/Classes/SkillPlan/factionButtons/icon${MILITIA_FACTIONS[opponent].banner}.png`)} alt={factionName(opponent)} title={factionName(opponent)} />
    </p>
    {#if enlisted}
      <dl>
        <dt>{word(DASHBOARD + "FactionTitleLabel", "Faction")}</dt><dd>{factionName(faction)}</dd>
        <dt>{word(DASHBOARD + "MilitiaTitleLabel", "Militia")}</dt><dd>{militiaName}</dd>
        <dt>{word(DASHBOARD + "RankTitleLabel", "Rank")}</dt><dd>{word(rankLabel, "–")}</dd>
      </dl>
      <button type="button" onclick={openEnlistment}>{word(FW + "Retire", "Retire")}</button>
    {:else}
      <p>{word(DASHBOARD + "FWExplainer", "")}</p>
      <p>{word(DASHBOARD + "FWConcordNote", "")}</p>
      <button type="button" class="primary" onclick={openEnlistment}>{word(PIRATES + "openFactionSelection", "Open Faction Selection")}</button>
      <button type="button" onclick={() => openAgencyGroup(35)}>{word(PIRATES + "learnMore", "Learn More")}</button>
    {/if}
  </div>
</aside>

<style>
  aside { min-width: 0; background: #101419; border: 1px solid #ffffff1b; overflow-y: auto; }
  .poster { aspect-ratio: 1; position: relative; background-size: cover; background-position: center; }
  .poster::before { content: ""; position: absolute; inset: 40% 0 0; background: linear-gradient(transparent, #101419); }
  .occupation { position: absolute; inset: auto 6px 7px; display: flex; gap: 10px; align-items: center; justify-content: center; font-size: 22px; }
  .gauge { display: grid; place-items: center; width: clamp(52px, 6vw, 84px); aspect-ratio: 1; background: #3e484b; border-radius: 50%; }
  .gauge img { border-radius: 50%; width: 89%; height: 89%; padding: 20%; box-sizing: border-box; background: #090c10; }
  .summary { padding: 5px 13px 14px; }
  h3 { margin: 7px 0 10px; font-size: 16px; text-align: center; }
  p { line-height: 1.4; }
  .enemy { display: flex; align-items: center; justify-content: center; gap: 5px; color: #c2c6ca; }
  .enemy img { width: 22px; height: 22px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 5px 8px; }
  dd { margin: 0; }
  dt { color: #b7bdc1; }
  button { width: 100%; margin-top: 6px; padding: 6px 8px; color: inherit; font: inherit; cursor: pointer; background: #141a20; border: 1px solid #ffffff36; }
  button:hover, .primary { border-color: #a5cbd4; background: #26424a; }
</style>
