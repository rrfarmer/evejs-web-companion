import type {BackendRoute, BackendRequest} from "../../../web/src/plugin-api/backend.ts";
import {worldForRequest} from "../shared/backendScope.ts";
import {readCivilianProfile} from "./profile.ts";

type ProfileDocument = {read(): unknown; write(value: unknown): void};

export function createCivilianProfileRoutes(
 open: (world: string) => {doc: ProfileDocument; close(): void},
 workerAccounts: (world: string) => string[] = () => [],
): Record<string, BackendRoute> {
 const route = (mode: "list" | "save" | "remove"): BackendRoute => (request: BackendRequest) => {
  const world = worldForRequest(request);
  if (!world || !request.account?.username) return {status:503, body:{ok:false, message:"Civilian profile scope is unavailable."}};
  const storage = open(world);
  try {
   const current = storage.doc.read();
   if (current !== null && !Array.isArray(current)) throw Error("Saved Civilian profiles are unreadable.");
   let profiles = (current ?? []).map(readCivilianProfile);
   if (mode === "save") {
    const profile = readCivilianProfile(request.body);
    profiles = [...profiles.filter(row => row.pilot.characterID !== profile.pilot.characterID), profile];
    storage.doc.write(profiles);
   } else if (mode === "remove") {
    const id = Number(request.params.characterID);
    if (!Number.isSafeInteger(id) || id < 1) throw Error("Choose a saved Civilian pilot.");
    profiles = profiles.filter(row => row.pilot.characterID !== id);
    storage.doc.write(profiles);
   }
   return {body:{ok:true, profiles, ...(mode === "list" ? {workerAccounts:workerAccounts(world)} : {})}};
  } catch (error) {
   return {status:409, body:{ok:false, message:error instanceof Error ? error.message : String(error)}};
  } finally { storage.close(); }
 };
 return {
  "GET /civilian/profiles": route("list"),
  "POST /civilian/profiles": route("save"),
  "POST /civilian/profiles/:characterID/remove": route("remove"),
 };
}
