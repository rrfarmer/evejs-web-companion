// Type copied from WC74 web/src/bridge/provisioning.ts @ 213da333.
export interface SupplyResult {
  typeID: number;
  name: string;
  target: number;
  mode: string;
  current: number | null;
  deficit: number | null;
  state: "FULL" | "LOW" | "MISSING" | "UNKNOWN";
}
