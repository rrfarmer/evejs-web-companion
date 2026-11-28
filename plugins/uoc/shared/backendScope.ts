import { createHash } from "node:crypto";
import type { BackendRequest, BackendRoute } from "../../../web/src/plugin-api/backend.ts";

export interface BackendPilotObservation {
  readonly accountName: string;
  readonly characterID: number;
  readonly owner: string;
  readonly online: boolean;
  readonly observedAt: number;
  readonly dock: {
    readonly shipID: number | null;
    readonly systemID: number | null;
    readonly stationID: number | null;
    readonly structureID: number | null;
  } | null;
}

/** Optional fields carried only by hosts that verify them before forwarding a request. */
export interface UocBackendRequest extends BackendRequest {
  readonly worldID?: string | null;
  readonly pilotObservations?: readonly BackendPilotObservation[];
}

export function worldForRequest(request: UocBackendRequest): string | null {
  if (Object.hasOwn(request, "worldID")) return request.worldID ?? null;
  // Farmer has one configured game connection per installation and exposes no world ID.
  // Keep fresh WC76 records scoped to the host-assigned UOC data directory.
  const directory = process.env.EVEJS_PLUGIN_DATA_DIR;
  return directory
    ? "wc-install:" +
        createHash("sha256")
          .update(process.platform === "win32" ? directory.toLowerCase() : directory)
          .digest("hex")
    : null;
}

export const worldRoute: BackendRoute = (request) => {
  const worldID = worldForRequest(request);
  return worldID
    ? { body: { ok: true, worldID } }
    : { status: 503, body: { ok: false, error: "UOC_SCOPE_UNAVAILABLE" } };
};
