import {classifyMiningSite} from "./siteClassification.ts";
import type {NativeSite} from "./siteDiscovery.ts";

/** Old retained targets have no classification claim. New selections carry both
 * native fields and must reproduce the inspected classification, never a name. */
export function validSavedSiteClassification(site:NativeSite):boolean {
 if(site.siteFamily===undefined&&site.sourceDungeonID===undefined)return true;
 if(site.siteFamily===undefined||site.siteFamily==="UNKNOWN"||site.sourceDungeonID===undefined)return false;
 return classifyMiningSite({systemID:site.target.systemID,scannerKey:site.scannerKey,instanceID:site.instanceID,archetypeID:site.archetypeID,scanStrengthAttribute:211,dungeonID:site.sourceDungeonID,dungeonNameID:site.sourceDungeonNameID})===site.siteFamily;
}

/** A classified choice is rechecked on the held pilot's fresh native scan.
 * Legacy records remain readable without acquiring a retroactive type claim. */
export function sameSiteClassification(expected:NativeSite,fresh:NativeSite):boolean {
 if(!validSavedSiteClassification(expected))return false;
 if(expected.siteFamily===undefined)return true;
 if(!validSavedSiteClassification(fresh)||fresh.siteFamily!==expected.siteFamily)return false;
 // Moon's signed dungeonID is a process-random display alias, not site identity.
 // Both aliases must qualify, while the exact native target remains unchanged.
 if(expected.siteFamily==="MOON")return expected.scannerKey===fresh.scannerKey&&expected.instanceID===fresh.instanceID&&JSON.stringify(expected.target)===JSON.stringify(fresh.target);
 return fresh.sourceDungeonID===expected.sourceDungeonID&&fresh.sourceDungeonNameID===expected.sourceDungeonNameID;
}
