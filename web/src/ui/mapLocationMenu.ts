import type { AppFlow } from "../app/flow.ts";
import { formatTemplate, plainText } from "../bridge/clientWords.ts";
import type { BookmarkPlace } from "../bridge/locationsList.ts";
import { avoidanceItems, isAvoidablePlace } from "../nav/autopilotSettings.ts";
import { celestialRouteEntries, isWaypointPlace } from "../nav/waypoints.ts";
import type { ContextEntry } from "../play/contextMenu.ts";
import type { ClientStore } from "../store/clientStore.ts";
import { notify } from "./notices.ts";
import { showInfo } from "./showInfo.ts";

const labels = {
  region: ["UI/Common/LocationTypes/Region", "Region"],
  constellation: ["UI/Common/LocationTypes/Constellation", "Constellation"],
  system: ["UI/Common/SolarSystem", "Solar System"],
  info: ["UI/Commands/ShowInfo", "Show Info"],
  destination: ["UI/Inflight/SetDestination", "Set Destination"],
  addWaypoint: ["UI/Inflight/AddWaypoint", "Add Waypoint"],
  removeWaypoint: ["UI/Inflight/RemoveWaypoint", "Remove Waypoint"],
  travelTo: ["UI/Fleet/FleetBroadcast/Commands/BroadcastTravelTo", "Broadcast: Travel To"],
  saveLocation: ["UI/Inflight/BookmarkLocation", "Save Location…"],
  bookmarkLabel: ["UI/PeopleAndPlaces/NewBookmarkLocationLabel", "{loc} ({group})"],
  map: ["UI/Commands/ShowLocationOnMap", "Show on Map"],
  mapBrowser: ["UI/Inflight/ShowInMapBrowser", "Show in Mapbrowser ({locationType})"],
  avoid: ["UI/Inflight/AvoidLocation", "Avoid {theLocation} ({locationType})"],
  stopAvoiding: ["UI/Inflight/StopAvoidingLocation", "Do Not Avoid {theLocation} ({locationType})"],
} as const;

export const mapLocationMenuWords = Object.values(labels).map(([path]) => path);

export function mapLocationMenu(
  store: ClientStore, flow: AppFlow, id: number, locationName: () => string,
  onBookmark: ((place: BookmarkPlace) => void) | null, onShowSystem?: (id: number) => void,
  onShowMapBrowser?: (id: number) => void, typeID: 3 | 4 | 5 = 5,
): (ContextEntry | null)[] {
  const templates = store.words.get().templates;
  const word = (key: keyof typeof labels, args: Record<string, string | number> = {}) => {
    const [path, fallback] = labels[key];
    return plainText(formatTemplate(templates[path] ?? fallback, args, { nameOf: locationName }));
  };
  const entry = (key: keyof typeof labels, run: () => void, args?: Record<string, string | number>): ContextEntry =>
    ({ path: labels[key][0], label: word(key, args), run });
  const here = store.flight.get().status?.solarSystemID ?? store.station.get().online?.solarSystemID ?? null;
  const waypoint = isWaypointPlace(id);
  const route = celestialRouteEntries(id, waypoint, here, flow.waypoints.get());
  const locationType = word(typeID === 3 ? "region" : typeID === 4 ? "constellation" : "system");
  const entries: (ContextEntry | null)[] = [
    { ...entry("info", () => showInfo({ kind: "mapLocation", typeID, itemID: id })), info: true },
  ];
  if (route.setDestination) entries.push(entry("destination", () => flow.setDestination(id)));
  if (route.addWaypoint) entries.push(entry("addWaypoint", () => flow.addWaypoint(id)));
  if (route.removeWaypoint) entries.push(entry("removeWaypoint", () => flow.clearWaypoints(id)));
  if (onBookmark) entries.push(null, entry("saveLocation", () => onBookmark({
    itemID: id, askIfKnown: true, typeName: () => locationType,
    name: () => word("bookmarkLabel", { loc: id, group: locationType }),
  })));
  const travel = store.fleet.get().availability === "ready" && waypoint ? {
    ...entry("travelTo", () => {
      void flow.broadcastTravelToSystem(id).catch(cause => {
        if (cause?.code !== "SESSION_REQUEST_RETIRED") notify({ kind: "danger", title: word("travelTo"), detail: String(cause) });
      });
    }),
    icon: "res:/UI/Texture/classes/Fleet/Broadcast/16/travelTo.png",
  } : null;
  if (!onBookmark && travel) entries.push(null, travel);
  if (typeID !== 3 && isAvoidablePlace(id)) {
    entries.push(null);
    if (onShowSystem) entries.push(entry("map", () => onShowSystem(id)));
    if (onShowMapBrowser) entries.push(entry("mapBrowser", () => onShowMapBrowser(id), { locationType }));
    const avoiding = avoidanceItems(flow.autopilotSettings()).includes(id);
    entries.push(entry(avoiding ? "stopAvoiding" : "avoid", () => {
      if (avoiding) flow.stopAvoidingLocation(id);
      else flow.avoidLocation(id);
    }, { locationType, theLocation: id }));
  }
  if (onBookmark && travel) entries.push(null, travel);
  return entries;
}
