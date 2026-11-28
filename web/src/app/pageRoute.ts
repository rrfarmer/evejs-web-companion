/** Web Companion resource roots and retired pages stay reserved for Core. */
export function reservedPluginPage(id: string): boolean {
  return ["api", "assets", "client-res", "dist", "icon-cache",
    "mining-command-center", "goblin-factory", "pilot-training", "ship-provisioning"].includes(id);
}
