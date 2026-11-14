<script lang="ts">
  // jobboard features/agent_missions/card.AgentMissionCard - an agent mission's card on the job board: the agent's name
  // over the title (the mission's name message), the subtitle "<division> - Level n" (AgentMissionJob.subtitle:
  // get_division_name, UI/Agents/AgentEntry/Level), on the right the agent's round portrait (40) with the state's icon
  // at its corner (get_state_info: Expired in DANGER_RED - the left line in its colour, else THEME_FOCUS), and at the
  // bottom the time remaining (TimeRemainingIcon, has_expiration_time) and the important mission's mark
  // (ImportantStandingsWarning). Its click opens the mission's page.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { JournalMission } from "../store/types.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { questionText } from "../bridge/questions.ts";
  import { resolvedName } from "../store/names.ts";
  import { portraitUrl } from "./ownerImages.ts";
  let { store, flow, mission, onOpen }: { store: ClientStore; flow: AppFlow; mission: JournalMission; onOpen: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const agents = store.agents;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  const agentID = $derived(mission.agentID ?? 0);
  const record = $derived($agents.agentRecords[agentID] ?? null);
  $effect(() => {
    if (!agentID) return;
    flow.loadImageServer();
    flow.requestAgentRecord(agentID);
    flow.requestNames([{ kind: "agent", id: agentID }]);
    const ids = [mission.missionTitleID, record?.divisionNameID ?? null].filter((id): id is number => id !== null && id > 0);
    flow.requestWords(["UI/Agents/AgentEntry/Level", "UI/Agents/StandardMission/ImportantStandingsWarning", "UI/Generic/Expired", ...ids.map((id) => `#${id}`)]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const title = $derived.by(() => {
    if (mission.missionTitle) return mission.missionTitle;
    const id = mission.missionTitleID;
    if (id === null || id <= 0 || !(`#${id}` in $words.templates)) return "";
    return questionText({ label: null, parameters: null, text: null, messageID: id }, (k, id2) => resolvedName($names.resolved, k, id2, ""), { templates: $words.templates });
  });
  const subtitle = $derived.by(() => {
    const division = record?.divisionNameID ? word(`#${record.divisionNameID}`) : "";
    const level = record?.level ? word("UI/Agents/AgentEntry/Level", { level: record.level }) : "";
    return [division, level].filter(Boolean).join(" - ");
  });
  // The expiration as a FILETIME; the time left from now.
  const expiresMs = $derived(mission.expirationTime && /^\d+$/.test(mission.expirationTime) ? Number((BigInt(mission.expirationTime) - 116_444_736_000_000_000n) / 10_000n) : null);
  let now = $state(Date.now());
  $effect(() => { const t = setInterval(() => { now = Date.now(); }, 30_000); return () => clearInterval(t); });
  const expired = $derived(expiresMs !== null && expiresMs <= now);
  const left = $derived.by(() => {
    if (expiresMs === null) return "";
    const m = Math.max(0, Math.floor((expiresMs - now) / 60_000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return d > 0 ? `${d}d ${h}h` : `${h}h ${m % 60}m`;
  });
</script>

<div class="mj-card" role="button" tabindex="-1" style:border-left-color={expired ? "#d4534f" : "var(--theme-focus, #58a6dc)"} onclick={onOpen} onkeydown={() => {}}>
  <div class="mj-top">
    <span class="mj-dim">{resolvedName($names.resolved, "agent", agentID, "")}</span>
    <span class="mj-portrait"><img alt="" src={portraitUrl($imageServer, agentID, 64)} />
      {#if expired}<span class="mj-state" title={word("UI/Generic/Expired")}>⌛</span>{/if}</span>
  </div>
  <div class="mj-title">{title}</div>
  <div class="mj-sub">{subtitle}</div>
  <div class="mj-bottom">
    {#if mission.importantMission}<span class="mj-important" title={word("UI/Agents/StandardMission/ImportantStandingsWarning")}>!</span>{/if}
    {#if left}<span class="mj-dim">⏱ {expired ? word("UI/Generic/Expired") : left}</span>{/if}
  </div>
</div>

<style>
  .mj-card { cursor: pointer; height: 150px; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; border-left: 2px solid; background: rgba(0, 0, 0, 0.6); border-radius: 0 8px 8px 0; }
  .mj-top { display: flex; justify-content: space-between; align-items: flex-start; }
  .mj-dim { opacity: 0.65; }
  .mj-portrait { position: relative; width: 40px; height: 40px; flex: none; }
  .mj-portrait img { width: 40px; height: 40px; border-radius: 50%; }
  .mj-state { position: absolute; right: -4px; bottom: -4px; font-size: 12px; background: rgba(0, 0, 0, 0.6); border-radius: 50%; padding: 1px; color: #d4534f; }
  .mj-title { font-weight: bold; padding-top: 4px; }
  .mj-sub { flex: 1; font-size: 12px; opacity: 0.75; }
  .mj-bottom { display: flex; gap: 8px; justify-content: flex-end; align-items: center; padding: 2px 8px; border-radius: 8px; background: rgba(255, 255, 255, 0.05); }
  .mj-important { color: #e0913a; font-weight: bold; }
</style>
