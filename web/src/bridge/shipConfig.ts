// The ship's sharing flags (shipConfigSvc): who may use the ship maintenance bay and the fleet hangar.
//
// READ: ship.GetShipConfiguration([shipID]) answers {type: "dict", entries: [[key, bool], ...]} with allowFleetSMBUsage,
// SMB_AllowFleetAccess, allowCorpSMBUsage, SMB_AllowCorpAccess, FleetHangar_AllowFleetAccess and
// FleetHangar_AllowCorpAccess (EveJS services/ship/shipService.js).
//
// WRITE: ship.ConfigureShip({key: value}) - shipConfigSvc.SetShipConfig, one key at a time, on the session's own ship
// (the server takes the ship from the session, never from the caller).

import { readDictPairs, type JsonValue } from "./wire.ts";
import type { Ask } from "./ask.ts";

export type ShipConfigKey = "FleetHangar_AllowFleetAccess" | "FleetHangar_AllowCorpAccess" | "SMB_AllowFleetAccess" | "SMB_AllowCorpAccess";
export type ShipConfig = Readonly<Partial<Record<ShipConfigKey, boolean>>>;

const KEYS: readonly ShipConfigKey[] = ["FleetHangar_AllowFleetAccess", "FleetHangar_AllowCorpAccess", "SMB_AllowFleetAccess", "SMB_AllowCorpAccess"];

/** shipConfigSvc.GetShipConfig: the ship's flags, null where the answer is not a dict. */
export async function readShipConfig(ask: Ask, shipID: number): Promise<ShipConfig | null> {
  const answer = await ask("ship", "GetShipConfiguration", [shipID]);
  const pairs = readDictPairs(answer);
  if (!pairs.length) return null;
  const out: Partial<Record<ShipConfigKey, boolean>> = {};
  for (const [key, value] of pairs) {
    const name = String(key) as ShipConfigKey;
    if (KEYS.includes(name)) out[name] = value === true || value === 1;
  }
  return out;
}

/** shipConfigSvc.SetShipConfig: ConfigureShip({key: value}) on the session's ship. */
export async function configureShip(act: Ask, key: ShipConfigKey, value: boolean): Promise<JsonValue> {
  if (!KEYS.includes(key)) throw new Error("That ship setting is not known.");
  return act("ship", "ConfigureShip", [{ type: "dict", entries: [[key, value]] }]);
}
