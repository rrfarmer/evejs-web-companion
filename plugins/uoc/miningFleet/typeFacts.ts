import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { fleetReadFailed, FleetObservationUnavailable } from "./stopSignal.ts";

type Run = Pick<PluginRunContext, "baseUrl" | "fetch">;
type Family = "ore" | "ice";
type TypeFact = {
  readonly categoryID: number;
  readonly freightKind: "RAW" | "COMPRESSED" | null;
  readonly unitVolumeM3: number;
  readonly resourceFamily: Family | null;
};

/** Category and volume are static for the lifetime of this native reader. */
export function createRawTypeFacts(run: Run, current: () => void) {
  async function get(path: string) {
    current();
    const response = await run.fetch(new URL(path, run.baseUrl)).catch(fleetReadFailed);
    const body = await response
      .json()
      .catch((error) => (response.ok ? fleetReadFailed(error) : null));
    current();
    if (!response.ok || body?.ok !== true)
      return fleetReadFailed(
        Object.assign(Error(body?.message ?? "Native type facts are unavailable."), {
          code: body?.error,
          status: response.status,
        }),
      );
    return body;
  }

  const known = new Map<number, TypeFact>();
  let raw: Map<number, Family> | null = null,
    compressed: Map<number, Family> | null = null;
  async function compressedFamilies(resources: Map<number, Family>) {
    if (compressed) return compressed;
    const result = new Map<number, Family>(),
      ids = [...resources.keys()];
    try {
      for (let i = 0; i < ids.length; i += 50) {
        const group = ids.slice(i, i + 50),
          body = await get(`/api/types/compressed?typeIDs=${encodeURIComponent(group.join(","))}`);
        if (
          body.capped === true ||
          !body.compressedTypeIDs ||
          typeof body.compressedTypeIDs !== "object" ||
          Array.isArray(body.compressedTypeIDs)
        )
          return null;
        for (const id of group) {
          const output = body.compressedTypeIDs[String(id)];
          if (output === undefined || output === null) continue;
          if (
            !Number.isSafeInteger(output) ||
            output <= 0 ||
            output === id ||
            resources.has(output)
          )
            return null;
          const family = resources.get(id)!;
          if (result.has(output) && result.get(output) !== family) return null;
          result.set(output, family);
        }
      }
      return (compressed = result);
    } catch (error) {
      current();
      if (error instanceof FleetObservationUnavailable) throw error;
      return null;
    }
  }

  return async (typeIDs: readonly number[]): Promise<Readonly<Record<number, TypeFact>>> => {
    current();
    const ids = [...new Set(typeIDs)];
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
      throw Error("Invalid type identity.");
    const missing = ids.filter((id) => !known.has(id));
    if (!missing.length) return Object.fromEntries(ids.map((id) => [id, known.get(id)!]));
    if (!raw) {
      const body = await get("/api/mining-operations/resources");
      if (
        !Array.isArray(body.resources) ||
        !body.resources.length ||
        body.resources.some(
          (r: any) =>
            !Number.isSafeInteger(r?.typeID) ||
            r.typeID <= 0 ||
            typeof r.name !== "string" ||
            !r.name ||
            !["ore", "ice"].includes(r.family),
        ) ||
        new Set(body.resources.map((r: any) => r.typeID)).size !== body.resources.length
      )
        throw Error("Raw resource catalogue is unreadable.");
      raw = new Map(body.resources.map((r: any) => [r.typeID, r.family]));
    }
    const resources = raw,
      observed = new Map<number, TypeFact>();
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50),
        q = encodeURIComponent(chunk.join(","));
      const [dogma, volumes] = await Promise.all([
        get(`/api/client-data/dogma-types?typeIDs=${q}`),
        get(`/api/types/volumes?typeIDs=${q}`),
      ]);
      if (dogma.available !== true || !dogma.types || !volumes.volumes || volumes.capped === true)
        throw Error("Type category or volume is unreadable.");
      const recipes = chunk.some(
        (id) => dogma.types[String(id)]?.categoryID === 25 && !resources.has(id),
      )
        ? await compressedFamilies(resources)
        : null;
      for (const id of chunk) {
        const category = dogma.types[String(id)]?.categoryID,
          volume = volumes.volumes[String(id)];
        if (
          !Number.isSafeInteger(category) ||
          category <= 0 ||
          typeof volume !== "number" ||
          !Number.isFinite(volume) ||
          volume < 0
        )
          throw Error(`Type ${id} has unknown category or volume.`);
        const fact: TypeFact = {
          categoryID: category,
          freightKind:
            category === 25
              ? resources.has(id)
                ? "RAW"
                : recipes?.has(id)
                  ? "COMPRESSED"
                  : null
              : null,
          unitVolumeM3: volume,
          resourceFamily: resources.get(id) ?? recipes?.get(id) ?? null,
        };
        observed.set(id, fact);
        if (category !== 25 || resources.has(id) || recipes) known.set(id, fact);
      }
    }
    return Object.fromEntries(ids.map((id) => [id, observed.get(id) ?? known.get(id)!]));
  };
}
