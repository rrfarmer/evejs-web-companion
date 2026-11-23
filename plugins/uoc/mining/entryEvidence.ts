import { dungeonEntered } from "../shared/helpers.ts";

import type { DungeonEntryScope, DungeonEntryReceipt } from "../shared/missionTypes.ts";
export type { DungeonEntryScope, DungeonEntryReceipt } from "../shared/missionTypes.ts";
const positive=(n:number)=>Number.isSafeInteger(n)&&n>0;
export function nativeDungeonEntry(args:readonly unknown[],scope:DungeonEntryScope,sequence:number,
  receivedAtMs:number):DungeonEntryReceipt|null {
  const dungeon=dungeonEntered(args);
  if(!dungeon || dungeon.instanceID===null || !positive(scope.characterID) || !positive(scope.shipID) ||
      !Number.isSafeInteger(scope.flowGeneration) || scope.flowGeneration<0 || !positive(sequence) ||
      !Number.isFinite(receivedAtMs))return null;
  return {source:"NATIVE_PUSH",scope:{...scope},sequence,receivedAtMs,dungeon:{...dungeon,instanceID:dungeon.instanceID}};
}
/** Entry is only one leg of arrival proof. Consumers must also establish the
 * exact authorized trip, physical landing and fresh matching native context. */
export function entryAfter(receipt:DungeonEntryReceipt|null,expected:{scope:DungeonEntryScope;afterSequence:number;
  issuedAtMs:number;dungeonID:number;instanceID?:number|null},nowMs:number):boolean {
  return receipt!==null && receipt.scope.characterID===expected.scope.characterID && receipt.scope.shipID===expected.scope.shipID &&
    receipt.scope.flowGeneration===expected.scope.flowGeneration && receipt.sequence>expected.afterSequence &&
    receipt.receivedAtMs>=expected.issuedAtMs && nowMs>=receipt.receivedAtMs && nowMs-receipt.receivedAtMs<=15_000 &&
    receipt.dungeon.dungeonID===expected.dungeonID &&
    (expected.instanceID==null || receipt.dungeon.instanceID===expected.instanceID);
}
