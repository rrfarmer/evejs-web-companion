import { bytesFromUuid, uuidFromBytes } from "./skillPlans.ts";

const zero = "00000000-0000-0000-0000-000000000000";

export function shipSkinrListingUrl(id: string): string | null {
  const uuid = uuidFromBytes(id);
  return uuid && uuid !== zero ? `shipSkinListing:${uuid}` : null;
}

export function parseShipSkinrListingUrl(url: string): string | null {
  const uuid = /^shipSkinListing:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(url)?.[1];
  return uuid && uuid !== zero ? bytesFromUuid(uuid) : null;
}
