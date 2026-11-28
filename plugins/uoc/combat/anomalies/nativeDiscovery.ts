import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import { decodeFlightStatus, getFlightStatus } from "../../../../web/src/plugin-api/flying.ts";
import { decodeCombatSites, type CombatCatalogEntry } from "./discovery.ts";
/** Ordinary held-session scanner only; instance authority comes from the keeper after warp. */
export function createCombatDiscovery(
  run: Pick<PluginRunContext, "characterID" | "baseUrl" | "fetch">,
  session: PilotSession,
  config: {
    shipID: number;
    systemID: number;
    current: () => void;
    catalog: readonly CombatCatalogEntry[];
    now?: () => number;
  },
) {
  const now = config.now ?? Date.now,
    guard = () => {
      config.current();
      if (session.store.station.get().online?.characterID !== run.characterID)
        throw Error("Held combat pilot changed.");
    };
  async function flight() {
    guard();
    const response = await getFlightStatus({
      ...session.flow.requestOptions(),
      baseUrl: run.baseUrl,
      fetch: run.fetch,
    });
    guard();
    const f = decodeFlightStatus(response.flight);
    if (f.shipID !== config.shipID || f.solarSystemID !== config.systemID)
      throw Error("Combat scanner pilot ship or system changed.");
    return f;
  }
  return async () => {
    await flight();
    guard();
    const scan = await session.flow.flying.bridgeAsk("scanMgr", "GetFullState", []);
    guard();
    await flight();
    guard();
    return decodeCombatSites(scan, config.systemID, now(), config.catalog);
  };
}
