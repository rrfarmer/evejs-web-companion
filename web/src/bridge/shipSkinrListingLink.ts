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

export function shipSkinrDesignUrl(ownerID: number, id: string): string | null {
  const uuid = uuidFromBytes(id);
  return uuid && uuid !== zero && Number.isSafeInteger(ownerID) && ownerID > 0
    ? `shipSkinDesign:${ownerID}/${uuid}` : null;
}

export function parseShipSkinrDesignUrl(url: string): { ownerID: number; id: string } | null {
  const match = /^shipSkinDesign:([1-9]\d*)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(url);
  const ownerID = Number(match?.[1]);
  const uuid = match?.[2];
  return uuid && uuid !== zero && Number.isSafeInteger(ownerID) ? { ownerID, id: bytesFromUuid(uuid) } : null;
}
