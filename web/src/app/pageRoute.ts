export function isGoblinFactoryPath(pathname: string): boolean {
  return /^\/goblin-factory\/?$/.test(pathname);
}

export function isPilotTrainingPath(pathname: string): boolean { return /^\/pilot-training\/?$/.test(pathname); }
export function isShipProvisioningPath(pathname: string): boolean { return /^\/ship-provisioning\/?$/.test(pathname); }

export function isMiningCommandCenterPath(pathname: string): boolean {
  return /^\/mining-command-center\/?$/.test(pathname);
}
