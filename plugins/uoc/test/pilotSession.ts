import { createAppFlow } from "../../../web/src/app/flow.ts";
import { createClientStore } from "../../../web/src/store/clientStore.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";

/** A real pilot flow over the test run's in-memory BFF. */
export function testPilotSession(
  characterID: number,
  run: Pick<PluginRunContext, "baseUrl" | "fetch">,
): PilotSession {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID,
      characterName: `Pilot ${characterID}`,
      stationID: null,
      structureID: null,
      solarSystemID: 300,
      corporationID: 77,
    },
    station: null,
  });
  const flow = createAppFlow(store, {
    baseUrl: run.baseUrl,
    fetch: run.fetch,
    livePush: false,
    perSessionToken: true,
    initialSessionToken: `test-pilot-${characterID}`,
  });
  return { store, flow };
}
