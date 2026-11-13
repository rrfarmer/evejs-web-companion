<script lang="ts">
  // The client's job board's tracker (InfoPanelJobBoard, "Opportunities"; jobboard agent_missions info_panel_entry.py,
  // AgentMissionInfoPanelEntry): each accepted mission it tracks, which is every one while the pilot has chosen none
  // (AgentMissionsJobProvider._track_all_accepted_missions), by its name; under it its objectives up to the one it is on
  // now (bridge/missionTracker.ts), one done by its header struck through (only where it has one), the one now by its
  // header, its words with its place's system's security, and its one button (StatefulButton): Undock, Set
  // Destination, Destination Set, Warp to Location, Approach, Dock, Start Conversation or Read Details, by where the
  // pilot is (_GetButtonState).
  //
  // Read as the client's tracker reads (flow.refreshMissionTracker): as the window opens, at each change of the pilot's
  // place and each warp's end. The space feed is claimed while it is open, for the distance to a mission's place.
  //
  // Not done: the objective's icon; untracking a mission (the job board's own window); Open Container
  // (DropItemInMissionContainer); Preparing to warp; Docking.
  //
  // The tracked freelance jobs (jobTracking.ts; FreelanceProjectJob.INFO_PANEL_ENTRY_CLASS FreelanceProjectInfoPanelEntry,
  // ui/info_panel_entry.JobInfoPanelEntry's header): the feature's icon button opening the job (ViewOpportunity -
  // the job board's page of it), the title, the progress text on the right ("n%" where the target is 100 or more, else
  // "current/target") over a fill of the progress (the job's current / target - FreelanceProjectInfoPanelEntry has no
  // participation_limit to read - THEME_FOCUS, SUCCESS_GREEN once full, at 0.15), the state line's colour where the job
  // has a state (get_state_info). Its menu: ViewOpportunity and Untrack. Read as the tracker opens and as the tracked
  // jobs change. Not here: the expanded objective chain (the freelance objective chains), the menu's other entries.
  import { onMount } from "svelte";
  import { formatTemplate, plainText, templateNameRefs } from "../bridge/clientWords.ts";
  import { questionText } from "../bridge/questions.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import {
    BUTTON_DISABLED, BUTTON_LABELS, objectiveButton, objectiveHeader, talkToAgentHint, trackedObjective, trackedObjectiveInfos,
    type ButtonState, type ObjectiveArg, type ObjectiveWords, type TrackedObjective,
  } from "../bridge/missionTracker.ts";
  import { resolvedName, type NameKind, type NameRef } from "../store/names.ts";
  import { approachedBallID } from "../space/actionIndication.ts";
  import type { JsonValue } from "../bridge/wire.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { JournalMission, MissionSpot } from "../store/types.ts";
  import type { FreelanceJob } from "../app/flow.ts";
  import { trackedFreelanceJobs, trackedJobsChanged, untrackFreelanceJob } from "./jobTracking.ts";
  import { openJobBoard } from "./jobBoardRequests.ts";

  let { store, flow, showAgents }: { store: ClientStore; flow: AppFlow; showAgents?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const warpDistance = flow.warpDistance;
  // svelte-ignore state_referenced_locally
  const tracker = flow.missionTracker;
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;
  // svelte-ignore state_referenced_locally
  const agents = store.agents;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const space = store.space;

  onMount(() => {
    flow.refreshMissionTracker();
    flow.startSpacePolling();
    return () => flow.stopSpacePolling();
  });

  // Where the pilot is (session.stationid, structureid, solarsystemid2, locationid).
  const status = $derived($flight.status);
  const stationID = $derived(status?.docked ? status.stationID ?? null : null);
  const structureID = $derived(status?.docked ? status.structureID ?? null : null);
  const solarSystemID = $derived(status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const locationID = $derived(stationID ?? structureID ?? solarSystemID);
  const inSpace = $derived(status?.inSpace === true);
  const warping = $derived(/warp/i.test(status?.shipMode ?? ""));

  // The tracked freelance jobs, newest tracked last (get_tracked_jobs keeps the setting's order).
  const me = $derived($station.online?.characterID ?? null);
  let freelance = $state<readonly FreelanceJob[]>([]), jobMenu = $state<string | null>(null);
  $effect(() => {
    void $trackedJobsChanged;
    const ids = Object.entries(trackedFreelanceJobs(me)).sort((a, b) => a[1] - b[1]).map(([id]) => id);
    void Promise.all(ids.map((id) => flow.freelanceJob(id).catch(() => null))).then((jobs) => { freelance = jobs.filter((j): j is FreelanceJob => j !== null); });
  });
  const jobProgress = (j: FreelanceJob) => (j.project.target ? j.project.current / j.project.target : 0);
  const jobProgressText = (j: FreelanceJob) => (!j.project.target ? "" : j.project.target >= 100 ? `${Math.floor(jobProgress(j) * 100)}%`
    : `${j.project.current.toLocaleString("en-US")}/${j.project.target.toLocaleString("en-US")}`);
  // FreelanceProjectJob.get_state_info's colour (DANGER_RED, WARNING_ORANGE, SUCCESS_GREEN); null for none.
  function jobStateColor(j: FreelanceJob): string | null {
    if (j.participation === 3) return "#e0913a";
    if (j.participation === 2) return "#d4534f";
    const p = j.project, left = Math.max(0, p.target - p.current), mine = p.contributionLimit ? Math.min(left, Math.max(0, p.contributionLimit - p.myProgress)) : left;
    if (p.myProgress && mine === 0) return "#5fb85f";
    if (p.state === 2) return "#e0913a";
    return null;
  }

  // Read again at each change of the pilot's place and each warp's end (OnSessionChanged, OnClientEvent_WarpFinished).
  let placeSeen: string | null = null;
  let wasWarping = false;
  $effect(() => {
    const place = `${stationID}:${structureID}:${solarSystemID}`;
    const nowWarping = warping;
    if ((placeSeen !== null && place !== placeSeen) || (wasWarping && !nowWarping)) flow.refreshMissionTracker(true);
    placeSeen = place;
    wasWarping = nowWarping;
  });

  // The route's last waypoint's system (ConvertStationIDToSolarSystemIDIfNecessary), for Destination Set.
  let lastWaypointSystemID = $state<number | null>(null);
  $effect(() => {
    const last = $waypoints.at(-1);
    let live = true;
    if (last === undefined) {
      lastWaypointSystemID = null;
      return;
    }
    void flow.waypointSystem(last).then((system) => {
      if (live) lastWaypointSystemID = system;
    });
    return () => {
      live = false;
    };
  });

  /** GetAgentMissions: the journal's missions accepted and not expired, by when they expire. */
  const missions = $derived.by((): readonly JournalMission[] => {
    const read = $tracker;
    const active = ($agents.journal?.active ?? []).filter((mission) => mission.agentID !== null && read.has(mission.agentID));
    const expires = (mission: JournalMission): bigint => (mission.expirationTime === null ? 0n : BigInt(mission.expirationTime));
    return [...active].sort((a, b) => (expires(a) < expires(b) ? -1 : expires(a) > expires(b) ? 1 : 0));
  });

  /** BookmarkChecker.getDistanceToActiveShip: the thing's surface where it is on the grid, else the place's point; null where not to be told. */
  function distanceTo(bookmark: MissionSpot | null): number | null {
    const snapshot = $space.snapshot;
    const ship = snapshot?.ship ?? null;
    if (bookmark === null || ship === null || snapshot === null || bookmark.solarSystemID !== snapshot.solarSystemID) return null;
    const thing = bookmark.itemID === null || bookmark.itemID === undefined ? undefined : snapshot.entities.find((entity) => entity.itemID === bookmark.itemID);
    const at = thing?.position ?? (bookmark.x !== null && bookmark.x !== undefined ? { x: bookmark.x, y: bookmark.y ?? 0, z: bookmark.z ?? 0 } : null);
    if (at === null) return null;
    const centre = Math.hypot(at.x - ship.position.x, at.y - ship.position.y, at.z - ship.position.z);
    return thing === undefined ? centre : Math.max(0, centre - thing.radius - ship.radius);
  }

  interface ObjectiveShown {
    readonly objective: TrackedObjective;
    readonly active: boolean;
    readonly header: string;
    readonly hint: string;
    readonly security: number | null;
    readonly button: ButtonState;
  }

  function shownObjectives(mission: JournalMission): ObjectiveShown[] {
    const agentID = mission.agentID!;
    const read = $tracker.get(agentID);
    if (read === undefined) return [];
    const infos = trackedObjectiveInfos(read.all, read.current);
    const bookmarks = mission.bookmarks ?? [];
    return infos.map((info, i): ObjectiveShown => {
      const objective = trackedObjective(info, agentID, bookmarks, solarSystemID, read.inActiveDungeon);
      const active = i === infos.length - 1;
      const header = objectiveHeader(objective, locationID, mission.remoteCompletable === true, (system) => resolvedName($names.resolved, "system", system, ""), bookmarkHint);
      const hint = talkToAgentHint(objective, locationID);
      const button = objectiveButton(objective, {
        stationID,
        structureID,
        solarSystemID,
        inSpace,
        warping,
        approachingID: approachedBallID($space.snapshot),
        waypoints: $waypoints,
        lastWaypointSystemID,
        distanceToBookmark: distanceTo(objective.bookmark),
        inActiveDungeon: read.inActiveDungeon,
        remoteCompletable: mission.remoteCompletable === true,
      });
      const securityPlace = (header !== null && "label" in header ? header.securityOf : undefined) ?? hint?.securityOf;
      return {
        objective,
        active,
        header: header === null ? "" : "text" in header ? header.text : said(header),
        hint: hint === null ? "" : said(hint),
        security: securityPlace === undefined ? null : securityOfPlace(securityPlace, objective.bookmark),
        button,
      };
    // An objective done is shown only where it has a header (AgentMissionInfoPanelEntry._construct_body).
    }).filter((shown) => shown.active || shown.header !== "");
  }

  /** GetSolarSystemFromObjectiveLocation: a system itself, a station's system (the place's bookmark's here). */
  function securityOfPlace(placeID: number, bookmark: MissionSpot | null): number | null {
    const system = placeID >= 30_000_000 && placeID < 40_000_000 ? placeID : bookmark?.solarSystemID ?? null;
    if (system === null) return null;
    const level = $names.systemSecurity[system];
    return typeof level === "number" ? level : null;
  }

  const nameOf = (kind: NameKind, id: number): string => resolvedName($names.resolved, kind, id, "—");
  /**
   * A mission bookmark's hint as text. The server sends the label it is worded by ("UI/Agents/Bookmarks/Objective/Pickup"),
   * and the client's journal service words each as it reads the journal (journal.py _UpdateMissionDataFull, 311 to 317:
   * GetByLabel(hint, location=locationID, index=locationNumber + 1); "Agent Home Base - Oiniken" in the recordings is
   * that wording), as the Locations window words it here.
   */
  const hintArgs = (spot: MissionSpot): Record<string, JsonValue> => ({ location: spot.locationID ?? spot.solarSystemID ?? 0, index: spot.locationNumber + 1 });
  function bookmarkHint(spot: MissionSpot): string {
    const hint = spot.hint ?? "";
    const template = /^UI\//.test(hint) ? $words.templates[hint] : undefined;
    return typeof template === "string" ? plainText(formatTemplate(template, hintArgs(spot), { nameOf })) : hint;
  }
  function argValue(arg: ObjectiveArg): JsonValue {
    if (typeof arg === "number" || typeof arg === "string") return arg;
    if ("name" in arg) return nameOf(arg.name.kind, arg.name.id);
    const text = $words.templates[`#${arg.message}`];
    return typeof text === "string" ? plainText(text) : "";
  }
  /** An objective's words: the client's, filled, as plain text; the page's own where they are not to hand. */
  function said(objectiveWords: ObjectiveWords): string {
    const args = Object.fromEntries(Object.entries(objectiveWords.args).map(([key, value]) => [key, argValue(value)]));
    const template = $words.templates[objectiveWords.label];
    if (typeof template === "string") return plainText(formatTemplate(template, args, { nameOf, playerID: $station.online?.characterID ?? null }));
    return objectiveWords.own.replace(/\{(\w+)\}/g, (_, key: string) => String(args[key] ?? ""));
  }
  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" && template !== "" ? plainText(template) : own;
  }
  /** The mission's name: its message, or the text the server sent. */
  function missionName(mission: JournalMission): string {
    if (mission.missionTitle) return mission.missionTitle;
    const id = mission.missionTitleID;
    if (id === null || id <= 0 || !(`#${id}` in $words.templates)) return "";
    return questionText({ label: null, parameters: null, text: null, messageID: id }, nameOf, { templates: $words.templates, playerID: $station.online?.characterID ?? null });
  }

  // The words, names, messages and securities the missions' objectives want.
  $effect(() => {
    const labels = new Set<string>(["UI/Opportunities/WindowTitle", "UI/Opportunities/ViewOpportunity", "UI/Common/Untrack", ...Object.values(BUTTON_LABELS).map((one) => one.label)]);
    const refs: NameRef[] = [];
    const systems = new Set<number>();
    for (const mission of missions) {
      if (mission.missionTitleID !== null && mission.missionTitleID > 0) labels.add(`#${mission.missionTitleID}`);
      const read = $tracker.get(mission.agentID!);
      if (read === undefined) continue;
      for (const info of trackedObjectiveInfos(read.all, read.current)) {
        const objective = trackedObjective(info, mission.agentID!, mission.bookmarks ?? [], solarSystemID, read.inActiveDungeon);
        const wordsOf = [objective.hint, objective.ownHeader, talkToAgentHint(objective, locationID),
          objectiveHeader(objective, locationID, mission.remoteCompletable === true, () => null)];
        for (const one of wordsOf) {
          if (one === null || !("label" in one)) continue;
          labels.add(one.label);
          for (const arg of Object.values(one.args)) {
            if (typeof arg === "object" && "name" in arg) refs.push(arg.name);
            else if (typeof arg === "object" && "message" in arg) labels.add(`#${arg.message}`);
            else if (typeof arg === "number" && one.label === "UI/Agents/MissionTracker/ReportToAgent") refs.push({ kind: "agent", id: arg });
          }
          if (one.securityOf !== undefined) {
            const system = one.securityOf >= 30_000_000 && one.securityOf < 40_000_000 ? one.securityOf : objective.bookmark?.solarSystemID ?? null;
            if (system !== null) systems.add(system);
          }
        }
        if (objective.bookmark?.solarSystemID) refs.push({ kind: "system", id: objective.bookmark.solarSystemID });
        const spot = objective.bookmark;
        if (spot?.hint && /^UI\//.test(spot.hint)) {
          labels.add(spot.hint);
          const template = $words.templates[spot.hint];
          if (typeof template === "string") refs.push(...templateNameRefs(template, hintArgs(spot)));
        }
      }
    }
    flow.requestWords([...labels]);
    if (refs.length > 0) flow.requestNames(refs);
    if (systems.size > 0) flow.requestSystemSecurity([...systems]);
  });

  let error = $state("");
  let busy = $state(false);
  async function press(state: ButtonState, objective: TrackedObjective, agentID: number): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    const bookmark = objective.bookmark;
    try {
      switch (state) {
        case "undock":
          await flow.undock();
          break;
        case "dock":
          if (bookmark?.itemID) await flow.dockAt(bookmark.itemID);
          break;
        case "warpTo":
          if (bookmark !== null) await flow.warpToMissionBookmark(bookmark, $warpDistance);
          break;
        case "setDestination":
          if (bookmark?.itemID) flow.setDestination(bookmark.itemID);
          break;
        case "approach":
          if (bookmark !== null) await flow.approachMissionBookmark(bookmark);
          break;
        case "startConversation":
          showAgents?.();
          await flow.openConversation(agentID);
          break;
        case "completeReferral":
          showAgents?.();
          if (objective.targetAgentID !== null) await flow.openConversation(objective.targetAgentID);
          break;
        case "readDetails":
          showAgents?.();
          await flow.openMissionDetails(agentID);
          break;
        default:
          break;
      }
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section class="panel mission-tracker">
  <h2 class="panel-title">{word("UI/Opportunities/WindowTitle", "Tracked")}</h2>
  {#if missions.length === 0 && freelance.length === 0}
    <p class="empty">{$agents.journal === null ? "Reading the journal…" : "No mission is accepted."}</p>
  {/if}
  {#each missions as mission (mission.agentID)}
    <article class="tracked-mission">
      <h3>{missionName(mission) || "Mission"}</h3>
      {#each shownObjectives(mission) as shown, i (i)}
        <div class="tracked-objective" class:done={!shown.active}>
          {#if shown.header !== ""}<strong class="objective-header">{shown.header}</strong>{/if}
          {#if shown.active}
            {#if shown.hint !== "" || shown.security !== null}
              <p class="objective-hint">
                {shown.hint}{#if shown.security !== null}{" "}<span style:color={securityStatusColor(shown.security)}>{shownSecurity(shown.security).toFixed(1)}</span>{/if}
              </p>
            {/if}
            {#if shown.button !== "none"}
              <p class="controls">
                <button
                  type="button"
                  disabled={busy || BUTTON_DISABLED.has(shown.button) || shown.button === "dropItemInMissionContainer"}
                  onclick={() => void press(shown.button, shown.objective, mission.agentID!)}
                >{word(BUTTON_LABELS[shown.button].label, BUTTON_LABELS[shown.button].own)}</button>
              </p>
            {/if}
          {/if}
        </div>
      {/each}
    </article>
  {/each}
  {#each freelance as j (j.project.projectID)}
    {@const pct = Math.min(1, jobProgress(j))}
    {@const stateColor = jobStateColor(j)}
    <article class="tracked-job" style:border-left-color={stateColor ?? "transparent"}
      oncontextmenu={(e) => { e.preventDefault(); jobMenu = jobMenu === j.project.projectID ? null : j.project.projectID; }}>
      <span class="job-fill" style:width={`${pct * 100}%`} style:background={pct < 1 ? "var(--theme-focus, #58a6dc)" : "#5fb85f"}></span>
      <button type="button" class="job-open" title={word("UI/Opportunities/ViewOpportunity", "View Opportunity")} onclick={() => openJobBoard(j.project.projectID, j.corporationID)}>⚒</button>
      <strong class="job-title">{j.project.name}</strong>
      <span class="job-progress">{jobProgressText(j)}</span>
      {#if jobMenu === j.project.projectID}
        <div class="job-menu" role="menu" tabindex="-1" onmouseleave={() => { jobMenu = null; }}>
          <button type="button" onclick={() => { jobMenu = null; openJobBoard(j.project.projectID, j.corporationID); }}>{word("UI/Opportunities/ViewOpportunity", "View Opportunity")}</button>
          <button type="button" onclick={() => { jobMenu = null; untrackFreelanceJob(me, j.project.projectID); }}>{word("UI/Common/Untrack", "Untrack")}</button>
        </div>
      {/if}
    </article>
  {/each}
  {#if error}<p class="error">{error}</p>{/if}
</section>

<style>
  .mission-tracker .tracked-mission { margin-bottom: 0.75rem; }
  .mission-tracker .tracked-mission h3 { margin: 0.25rem 0; }
  .mission-tracker .tracked-objective { padding: 0.4rem 0.5rem; background: rgb(0 0 0 / 0.25); margin-bottom: 2px; }
  .mission-tracker .tracked-objective.done .objective-header { text-decoration: line-through; opacity: 0.7; }
  .mission-tracker .objective-hint { margin: 0.25rem 0; white-space: pre-line; }
  .mission-tracker .tracked-job { position: relative; display: flex; align-items: center; gap: 8px; padding: 8px; margin-bottom: 2px; background: rgb(0 0 0 / 0.25); border-left: 2px solid transparent; overflow: visible; }
  .mission-tracker .job-fill { position: absolute; left: 0; top: 0; bottom: 0; opacity: 0.15; pointer-events: none; }
  .mission-tracker .job-open { all: unset; cursor: pointer; width: 16px; text-align: center; }
  .mission-tracker .job-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mission-tracker .job-menu { position: absolute; right: 0; top: 100%; z-index: 5; display: flex; flex-direction: column; background: rgb(20 22 26 / 0.97); border: 1px solid rgb(255 255 255 / 0.15); }
  .mission-tracker .job-menu button { all: unset; cursor: pointer; padding: 4px 10px; }
  .mission-tracker .job-menu button:hover { background: rgb(255 255 255 / 0.08); }
</style>
