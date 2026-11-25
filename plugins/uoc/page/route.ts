export type UocPage =
  | "home"
  | "mining-operations"
  | "civilian"
  | "combat-in-development"
  | "training"
  | "provisioning"
  | "distribution";
/** Page URLs work independently when directly opened or bookmarked. */
export function resolveUocPage(pathname: string, search: string): UocPage | null {
  const path = pathname.replace(/\/+$/, "") || "/",
    section = new URLSearchParams(search).get("section");
  if (path === "/uoc") return "home";
  if (path === "/uoc/mining-command-center")
    return section === "civilian" ? "civilian" : "mining-operations";
  if (path === "/uoc/combat-operations-center") return "combat-in-development";
  if (path === "/uoc/pilot-training") return "training";
  if (path === "/uoc/ship-provisioning") return "provisioning";
  if (path === "/uoc/distribution-center") return "distribution";
  return null;
}
