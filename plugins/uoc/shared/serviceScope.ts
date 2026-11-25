import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { runOwner } from "../runControl.ts";
export type PilotServiceScope = { worldID: string; owner: string; characterID: number };
export async function heldServiceScope(run: PluginRunContext): Promise<PilotServiceScope> {
  const [owner, response] = await Promise.all([
      runOwner(run),
      run.fetch(new URL("/api/plugins/uoc/world", run.baseUrl)),
    ]),
    world = await response.json();
  if (
    !response.ok ||
    world?.ok !== true ||
    typeof world.worldID !== "string" ||
    !world.worldID ||
    run.held.characterID !== run.characterID
  )
    throw Error("The exact held service world/account/pilot is unavailable.");
  return { worldID: world.worldID, owner: owner.toLowerCase(), characterID: run.characterID };
}
