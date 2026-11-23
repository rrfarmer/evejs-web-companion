export function isGoblinFactoryPath(pathname: string): boolean {
  return /^\/goblin-factory\/?$/.test(pathname);
}

export function isPilotTrainingPath(pathname: string): boolean { return /^\/pilot-training\/?$/.test(pathname); }
export function isShipProvisioningPath(pathname: string): boolean { return /^\/ship-provisioning\/?$/.test(pathname); }

export function isMiningCommandCenterPath(pathname: string): boolean {
  return /^\/mining-command-center\/?$/.test(pathname);
}

/** Page ownership follows the same predicates as main.ts; the other roots serve BFF resources. */
export function reservedPluginPage(id: string): boolean {
  const path = "/" + id;
  return ["api", "assets", "client-res", "dist", "icon-cache"].includes(id) ||
    isGoblinFactoryPath(path) || isPilotTrainingPath(path) || isShipProvisioningPath(path) || isMiningCommandCenterPath(path);
}
