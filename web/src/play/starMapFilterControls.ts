import type { Session } from "../app/sessions.ts";
import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
import { sessionPlace } from "../bridge/sessionPlace.ts";
import { MAP_COLOR_MODES, type StarMapColorMode } from "../bridge/starMapFilters.ts";
import { openAgencyGroup } from "../ui/agencyRequests.ts";
import type { StarMap } from "./starMap.ts";

const LABEL = "UI/Map/ColorMapBy";
const MINING = "UI/Map/MapPallet/categoryMining";
const NPC = "UI/Map/MapPallet/categoryNpcActivity";
const PROJECTED = "UI/Map/MapPallet/legendLabelOreAnomaliesImprecise";
const PRECISE = "UI/Map/MapPallet/legendLabelOreAnomaliesPrecise";
const ORE_HINT = "UI/Map/MapPallet/filterOreAnomalyHintImprecise";
const ORE_CLUSTER_HINT = "UI/Map/MapPallet/filterOreAnomalyHintImprecisePlural";
const FILTER_CLUSTER_HINT = "UI/Map/Markers/ClusterHint_Filter";
const PHASED_HINT = "UI/Map/PhasedFieldPinTooltip";
const CONVOY_HINT = "UI/Map/StarModeHandler/Hints/VanguardNemesisConvoysTooltip";
const NO_DATA = "UI/Common/NoDataAvailable";
const AGENCY = "UI/Agency/TheAgency";
const HERE = "UI/Map/StarMap/lblYouAreHere";

export function mountStarMapFilterControls(map: StarMap, session: Session): () => void {
  const controls = document.createElement("div");
  controls.className = "star-map-filters";
  const label = document.createElement("label"), caption = document.createElement("span");
  const select = document.createElement("select");
  label.append(caption, select);
  const mining = document.createElement("optgroup"), npc = document.createElement("optgroup");
  const options = Object.entries(MAP_COLOR_MODES).map(([mode, definition]) => {
    const option = document.createElement("option");
    option.value = mode;
    (definition.group === "mining" ? mining : definition.group === "npc" ? npc : select).append(option);
    return { option, definition };
  });
  select.append(mining, npc);
  const legend = document.createElement("div");
  legend.className = "star-map-filter-legend";
  const projected = document.createElement("span"), precise = document.createElement("span");
  projected.className = "projected";
  precise.className = "precise";
  legend.append(projected, precise);
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  const agency = document.createElement("button");
  // agencyNew.contentGroups.contentGroupConst.contentGroupSeasons
  agency.onclick = () => openAgencyGroup(34);
  controls.append(label, legend, status, agency);
  map.root.appendChild(controls);

  let mode: StarMapColorMode = "empire";
  let request = 0;
  let refreshAfterJump: ReturnType<typeof setTimeout> | undefined;
  let state: "idle" | "loading" | "empty" | "error" = "idle";
  let error = "";
  const word = (key: string, fallback: string, args: TemplateArguments = {}) => {
    const template = session.store.words.get().templates[key];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf: () => "" })) : fallback;
  };
  function render(): void {
    caption.textContent = word(LABEL, "Color Map By");
    mining.label = word(MINING, "Mining");
    npc.label = word(NPC, "NPC Activity");
    for (const { option, definition } of options) option.textContent = word(definition.label, definition.fallback);
    legend.hidden = mode !== "ore" || state === "loading" || state === "error";
    projected.textContent = word(PROJECTED, "Projected ore anomalies");
    precise.textContent = word(PRECISE, "Known ore anomalies");
    agency.hidden = mode !== "convoys";
    agency.textContent = word(AGENCY, "The Agency");
    status.textContent = state === "loading" ? "Loading…" : state === "empty" ? "No matching systems"
      : state === "error" ? word(NO_DATA, "No data available") : "";
    status.title = state === "error" ? error : "";
    map.setLocationHint(word(HERE, "You are here"));
    map.setActivityHints(row => {
      if (mode === "phased") return word(PHASED_HINT, "Phased Field");
      if (mode === "convoys") return word(CONVOY_HINT, `${row.count} active Vanguard Nemesis convoys`, { amount: row.count });
      if (row.dungeonNameIDs?.length) return row.dungeonNameIDs.map(id => word(`#${id}`, `#${id}`)).join("\n");
      return word(ORE_HINT, `${row.count} ore anomalies`, { num: row.count });
    }, count => mode === "ore" ? word(ORE_CLUSTER_HINT, `${count} sites detected`, { num: count })
      : word(FILTER_CLUSTER_HINT, word(MAP_COLOR_MODES.phased.label, MAP_COLOR_MODES.phased.fallback), { num: count }));
  }
  async function refresh(resetMarkers = true): Promise<void> {
    clearTimeout(refreshAfterJump);
    const selected = mode;
    const serial = ++request;
    error = "";
    if (resetMarkers) map.setColorMode(selected);
    state = selected === "empire" ? "idle" : "loading";
    render();
    if (selected === "empire") return;
    try {
      const { systems, homeSystemID } = await session.flow.starMapActivity(selected);
      if (serial !== request) return;
      map.setColorMode(selected, systems, homeSystemID);
      state = systems.length ? "idle" : "empty";
    } catch (cause) {
      if (serial !== request) return;
      state = "error";
      error = cause instanceof Error ? cause.message : String(cause);
    }
    render();
  }
  select.onchange = () => {
    mode = select.value as StarMapColorMode;
    void refresh();
  };
  const pilotSystem = () => sessionPlace(session.store.flight.get().status, session.store.station.get().online).solarSystemID;
  let current = pilotSystem();
  map.setPilotSystem(current);
  const onLocation = () => {
    const next = pilotSystem();
    if (current === next) return;
    current = next;
    map.setPilotSystem(current);
    ++request;
    clearTimeout(refreshAfterJump);
    // MapViewFiltered.OnSessionChanged waits a half second before reading the destination's filters.
    if (mode !== "empire") refreshAfterJump = setTimeout(() => void refresh(false), 500);
  };
  const stopFlight = session.store.flight.subscribe(onLocation);
  const stopStation = session.store.station.subscribe(onLocation);
  const stopWords = session.store.words.subscribe(render);
  session.flow.requestWords([LABEL, MINING, NPC, PROJECTED, PRECISE, ORE_HINT, ORE_CLUSTER_HINT, FILTER_CLUSTER_HINT, PHASED_HINT, CONVOY_HINT, NO_DATA, AGENCY, HERE,
    ...options.map(({ definition }) => definition.label)]);
  return () => {
    ++request;
    clearTimeout(refreshAfterJump);
    stopFlight();
    stopWords();
    stopStation();
    controls.remove();
  };
}
