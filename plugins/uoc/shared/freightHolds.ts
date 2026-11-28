// Web Companion names these bays in /ship/:shipID/bays. EveJS checks the type on Add.
export const freightHoldFlags: Readonly<Record<string, number>> = {
  cargo: 5,
  ore: 134,
  gas: 135,
  ice: 181,
  asteroid: 182,
  fleet: 155,
};
export const haulerInventoryFlags = Object.values(freightHoldFlags);
export const generalFreightBays = ["fleet", "cargo"] as const;

export function resourceBays(family: "ore" | "ice" | "gas") {
  return [family === "ore" ? "asteroid" : family, "ore"];
}

export function acceptsMinedFreight(flag: number | undefined, family?: "ore" | "ice" | null) {
  return (
    flag === 5 ||
    flag === 155 ||
    flag === 134 ||
    (flag === 181 && family === "ice") ||
    (flag === 182 && family === "ore")
  );
}

export function haulerBaysPath(shipID: number) {
  return `/api/bridge/ship/${shipID}/bays?keys=${Object.keys(freightHoldFlags).join(",")}`;
}
