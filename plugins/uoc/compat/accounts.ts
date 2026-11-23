import type { createPilotReach } from "../../../web/src/plugin-api/index.ts";

// Use the public pilot-reach contract. The standalone page supplies UOC's existing account-only pass.
export type AccountPass = NonNullable<Parameters<typeof createPilotReach>[0]["pass"]>;
