import { nextLocalID } from "../app/localID.ts";
import { fittingNames } from "./fittingNames.ts";
import type { ApiOptions, JsonValue } from "../../../../web/src/plugin-api/index.ts";
import { trainingAdapterContext } from "./training.ts";
import { cockpitRequestOptions, cockpitSession } from "../app/context.ts";
import {
  type Roster,
  type CenterReview,
  type ApplyOutcome,
  type Contract,
} from "../provisioning/centerTypes.ts";
import { previousShipStorageProof } from "../../provisioning/previousShip.ts";
const positive = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const options = (token: string): ApiOptions => cockpitRequestOptions(token) ?? { token };
const unknownStatus = { equipment: "UNKNOWN" as const, supplies: "UNKNOWN" as const, targets: [] };
const unknownMatch = { state: "UNKNOWN", alternatives: [] };
const accounts = new Map<string, { username: string; accountID: number; worldID?: string }>(),
  rosters = new Map<string, Roster>();
const catalogs = new Map<string, { corporationID: number; choices: any[] }>();
const reviews = new Map<
  string,
  {
    token: string;
    characterID: number;
    setup: Record<string, unknown> & { oldShipDivision?: number };
    fingerprint: string;
    canApply: boolean;
    replacedShipID: number | null;
    existingHullID: number | null;
    originalShipID: number;
  }
>();
const evidence = () => ({
  boundary: "PLUGIN_READOUT",
  digest: "",
  startedAt: 0,
  completedAt: 0,
  stable: false,
  unsupported: ["The compact plugin readout does not expose the WC74 evidence envelope."],
});
function catalogKey(token: string, id: number) {
  return `${token}:${id}`;
}
async function reviewedHullName(
  token: string,
  typeID: number,
  nativeName: unknown,
  catalogueName: unknown,
): Promise<string> {
  const fallback = `Ship ${typeID}`;
  for (const name of [nativeName, catalogueName]) {
    if (typeof name === "string" && name.trim() && name.trim() !== fallback) return name.trim();
  }
  try {
    const result = await trainingAdapterContext().authenticatedJson("/api/names", options(token), {
      items: [{ kind: "type", id: typeID }],
    });
    const name = result?.names?.[`type:${typeID}`];
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    /* The type label is optional display data. */
  }
  return fallback;
}
export async function centerRoster(
  token: string,
  _provider: number | null = null,
): Promise<Roster> {
  const c = trainingAdapterContext(),
    verified = await c.authenticatedJson("/api/plugins/uoc/center/account", options(token));
  if (
    !positive(verified.account?.accountID) ||
    typeof verified.account.username !== "string" ||
    !verified.worldID
  )
    throw Error("Current account/world authority is unavailable.");
  const previous = accounts.get(token);
  if (
    previous &&
    (previous.accountID !== verified.account.accountID ||
      previous.username !== verified.account.username)
  )
    throw Error("The authenticated account changed.");
  if (previous?.worldID && previous.worldID !== verified.worldID) {
    for (const [id, review] of reviews) if (review.token === token) reviews.delete(id);
    for (const k of catalogs.keys()) if (k.startsWith(token + ":")) catalogs.delete(k);
  }
  const account = {
    username: verified.account.username,
    accountID: verified.account.accountID,
    worldID: verified.worldID,
  };
  accounts.set(token, account);
  const r = await c.authenticatedJson("/api/pilot-training/characters", options(token));
  if (r?.account !== account.username || !Array.isArray(r.characters))
    throw Error("Account roster is unavailable.");
  const pilots = await Promise.all(
    r.characters.map(async (p: any) => {
      if (!positive(p.characterID) || typeof p.name !== "string")
        throw Error("Pilot roster is malformed.");
      let owner = "UNKNOWN",
        online: boolean | null = null;
      try {
        const v = await c.authenticatedJson(
          `/api/pilot-training/ownership?characterID=${p.characterID}`,
          options(token),
        );
        if (
          v?.ownership?.characterID === p.characterID &&
          typeof v.ownership.owner === "string" &&
          typeof v.ownership.online === "boolean"
        ) {
          owner = v.ownership.owner;
          online = v.ownership.online;
        }
      } catch {
        /* Unknown is not offline. */
      }
      let serviceAccess: string | null = null;
      try {
        const service = await c.authenticatedJson(
          `/api/plugins/uoc/provisioning/${p.characterID}/service`,
          options(token),
        );
        if (service.available === true && service.access === "READ_ONLY_ACTIVE_UOC")
          serviceAccess = service.access;
      } catch {
        /* Missing owner contract remains unavailable. */
      }
      return {
        serviceAccess,
        characterID: p.characterID,
        name: p.name,
        corporationID: positive(p.corporationID) ? p.corporationID : null,
        corporationName: typeof p.corporationName === "string" ? p.corporationName : null,
        locationID: null,
        stationID: null,
        dockState: "UNKNOWN",
        shipID: null,
        shipTypeID: null,
        shipName: null,
        hullName: null,
        quality: "UNKNOWN",
        reasons: ["Pilot ship and dock require inspection."],
        control: { state: "UNKNOWN", owner, online },
        status: unknownStatus,
        matches: unknownMatch,
      };
    }),
  );
  const result: Roster = {
    quality: "UNKNOWN",
    completeRoster: true,
    reasons: [],
    evidence: evidence(),
    pilots,
    providers: pilots.map((p) => ({
      characterID: p.characterID,
      name: p.name,
      corporationID: p.corporationID,
      corporationName: p.corporationName,
    })),
  };
  rosters.set(token, result);
  return result;
}
function contract(token: string, id: number, corporationID: number, x: any): Contract {
  const account = accounts.get(token);
  if (
    !account ||
    !positive(x.fittingID) ||
    !positive(x.goalTypeID) ||
    typeof x.name !== "string" ||
    typeof x.fingerprint !== "string" ||
    x.corporationID !== corporationID
  )
    throw Error("Fitting identity is unreadable.");
  return {
    name: x.name,
    hullName: x.hullName,
    hullGroupID: x.hullGroupID,
    hullGroupName: x.hullGroupName,
    shipTypeID: x.goalTypeID,
    equipmentFingerprint: x.fingerprint,
    supplyPolicyFingerprint: "",
    definitionFingerprint: x.fingerprint,
    definition: {
      accountID: account.accountID,
      characterID: id,
      corporationID,
      fittingID: x.fittingID,
      savedDate: "",
      fullFingerprint: x.fingerprint,
    },
  };
}
const emptyReview = (
  pilot: Roster["pilots"][number],
  provider: number,
  corporationID: number,
  contracts: Contract[],
): CenterReview => ({
  pilot,
  matches: unknownMatch,
  status: unknownStatus,
  selected: null,
  equipment: [],
  requirements: [],
  applyReview: {
    reviewID: "",
    reviewHash: null,
    expiresAt: null,
    canApply: false,
    reasons: ["Inspect an exact fitting and source."],
    suppliesPolicy: "UNKNOWN",
    plan: null,
  },
  definitions: {
    status: "READY",
    corporationID,
    providerCharacterID: provider,
    contracts,
    invalid: [],
  },
  candidateSource: {
    kind: "UNKNOWN",
    quality: "UNKNOWN",
    query: "UNKNOWN",
    take: "UNKNOWN",
    rows: null,
    corporationID: null,
    division: null,
    officeID: null,
    contentsLocationID: null,
    flag: 0,
    reasons: ["Source has not been inspected."],
    revalidateOnApply: true,
  },
  evidence: evidence(),
});
export async function centerReview(
  token: string,
  input: {
    characterID: number;
    providerCharacterID: number;
    fittingID: number;
    sourceKind: string;
    corporationID: number;
    division: number;
  },
): Promise<CenterReview> {
  const roster = rosters.get(token),
    pilot = roster?.pilots.find((p) => p.characterID === input.characterID),
    provider = roster?.providers.find((p) => p.characterID === input.providerCharacterID);
  if (!pilot || !provider)
    throw Error("Refresh the verified same-account pilot and provider roster.");
  let cat: { corporationID: number; choices: any[] };
  let invalid: { fittingID: number; reason: string }[] = [];
  {
    const query = new URLSearchParams({
        characterID: String(input.characterID),
        providerCharacterID: String(input.providerCharacterID),
        fittingID: "0",
        sourceKind: "hangar",
        division: "1",
      }),
      data = await trainingAdapterContext().authenticatedJson(
        `/api/ship-provisioning/review?${query}`,
        options(token),
      ),
      defs = data?.definitions;
    if (
      defs?.status !== "READY" ||
      defs.providerCharacterID !== input.providerCharacterID ||
      !positive(defs.corporationID) ||
      !Array.isArray(defs.contracts) ||
      defs.contracts.some(
        (c: any) =>
          !positive(c?.definition?.fittingID) ||
          c.definition.characterID !== input.providerCharacterID ||
          c.definition.corporationID !== defs.corporationID ||
          !positive(c.shipTypeID) ||
          typeof c.name !== "string" ||
          typeof c.definition.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(c.definition.fingerprint),
      )
    )
      throw Error("The selected provider fitting library is unavailable.");
    invalid = Array.isArray(defs.invalid)
      ? defs.invalid.filter(
          (x: any) => Number.isSafeInteger(x?.fittingID) && typeof x.reason === "string",
        )
      : [];
    cat = {
      corporationID: defs.corporationID,
      choices: await fittingNames(
        defs.contracts.map((c: any) => ({
          fittingID: c.definition.fittingID,
          goalTypeID: c.shipTypeID,
          name: c.name,
          fingerprint: c.definition.fingerprint,
          corporationID: defs.corporationID,
        })),
        options(token),
        trainingAdapterContext().authenticatedJson,
      ),
    };
  }
  catalogs.set(catalogKey(token, input.characterID), {
    ...cat,
    providerCharacterID: input.providerCharacterID,
  } as any);
  const result = emptyReview(
    pilot,
    input.providerCharacterID,
    cat.corporationID,
    cat.choices.map((x: any) => contract(token, input.providerCharacterID, cat.corporationID, x)),
  );
  result.definitions.invalid = invalid;
  return result;
}

export async function centerInspect(
  token: string,
  input: {
    characterID: number;
    providerCharacterID: number;
    fittingID: number;
    sourceKind: string;
    division: number;
    definitionFingerprint: string;
    savedFittingSupplies?: boolean;
    hullItemID?: number;
    oldShipDivision?: number;
  },
): Promise<CenterReview> {
  if (input.sourceKind !== "corp" && input.sourceKind !== "hangar")
    throw Error("Choose a supported personal or corporation source.");
  const pilot = rosters.get(token)?.pilots.find((p) => p.characterID === input.characterID),
    cat = catalogs.get(catalogKey(token, input.characterID));
  if (!pilot || !cat || (cat as any).providerCharacterID !== input.providerCharacterID)
    throw Error("Refresh the exact pilot and provider fittings.");
  const fit = cat.choices.find(
    (x) => x.fittingID === input.fittingID && x.fingerprint === input.definitionFingerprint,
  );
  if (!fit) throw Error("The selected fitting changed.");
  const setup = {
    ...(input.hullItemID ? { hullItemID: input.hullItemID } : {}),
    ...(input.oldShipDivision ? { oldShipDivision: input.oldShipDivision } : {}),
    corporationID: cat.corporationID,
    fittingID: fit.fittingID,
    goalTypeID: fit.goalTypeID,
    fingerprint: fit.fingerprint,
    division: input.division,
    ...(input.savedFittingSupplies === true ? { savedFittingSupplies: true } : {}),
    ...(input.sourceKind === "hangar" ? { sourceKind: "hangar" } : {}),
    ...(input.providerCharacterID !== input.characterID
      ? { providerCharacterID: input.providerCharacterID, sourceCorporationID: pilot.corporationID }
      : {}),
  };
  const hosted = await trainingAdapterContext().runHosted(
      input.characterID,
      "provision-inspect",
      setup as JsonValue,
      options(token),
    ),
    r = hosted.readout as any;
  if (
    hosted.phase !== "Provisioning inspected" ||
    r?.characterID !== input.characterID ||
    r.corporationID !== cat.corporationID ||
    r.fittingID !== fit.fittingID ||
    r.fingerprint !== fit.fingerprint ||
    !positive(r.shipID) ||
    !positive(r.stationID) ||
    typeof r.reviewedPlanFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.reviewedPlanFingerprint) ||
    !r.plan ||
    !Array.isArray(r.plan.requirements)
  )
    throw Error(hosted.why ?? "Provisioning inspection is unverified.");
  const reviewID = nextLocalID(),
    fingerprint = r.reviewedPlanFingerprint;
  const d = emptyReview(
      pilot,
      input.providerCharacterID,
      cat.corporationID,
      cat.choices.map((x: any) => contract(token, input.providerCharacterID, cat.corporationID, x)),
    ),
    resources = r.resources;
  d.droneBay = resources?.droneBay;
  const src = r.sourceRead,
    validSource =
      src &&
      src.pin &&
      src.access &&
      Array.isArray(src.rows) &&
      typeof src.access.query === "boolean" &&
      typeof src.access.take === "boolean" &&
      src.pin.descriptor?.kind === input.sourceKind &&
      src.rows.every(
        (x: any) =>
          positive(x.itemID) &&
          positive(x.typeID) &&
          positive(x.quantity) &&
          positive(x.ownerID) &&
          positive(x.locationID) &&
          typeof x.singleton === "boolean" &&
          Number.isSafeInteger(x.flagID),
      );
  const nativeStatus =
    r.status &&
    ["VERIFIED", "MODIFIED", "UNKNOWN"].includes(r.status.equipment) &&
    ["FULL", "LOW", "MISSING", "UNKNOWN"].includes(r.status.supplies) &&
    Array.isArray(r.status.targets)
      ? r.status
      : unknownStatus;
  const requirements = r.plan.requirements.map((x: any) => ({
    typeID: x.typeID,
    name: x.name,
    kind: x.kind ?? "unknown",
    flagID: x.flagID ?? x.flag ?? 0,
    quantity: x.quantity,
    current:
      x.current === null
        ? undefined
        : typeof x.current === "number"
          ? x.current
          : r.plan.mode === "ALREADY_SATISFIED"
            ? x.quantity
            : r.plan.mode === "NEW_HULL"
              ? 0
              : undefined,
    missing:
      x.missing === null
        ? undefined
        : typeof x.missing === "number"
          ? x.missing
          : r.plan.mode === "ALREADY_SATISFIED"
            ? 0
            : r.plan.mode === "NEW_HULL"
              ? x.quantity
              : undefined,
  }));
  if (
    resources?.state === "SIMULATED" &&
    (resources.characterID !== input.characterID ||
      resources.shipTypeID !== fit.goalTypeID ||
      resources.source !== "PILOT_BRAIN_CLIENT_SIMULATION" ||
      typeof resources.fits !== "boolean" ||
      ![
        resources.cpu?.used,
        resources.cpu?.total,
        resources.powergrid?.used,
        resources.powergrid?.total,
      ].every((x: unknown) => typeof x === "number" && Number.isFinite(x)))
  )
    throw Error("Pilot resource simulation is malformed.");
  const fittingResources =
    resources?.state === "SIMULATED"
      ? {
          status: resources.fits ? ("READY" as const) : ("BLOCKED" as const),
          cpu: resources.cpu,
          powergrid: resources.powergrid,
          reasons: [],
        }
      : {
          status: "UNKNOWN" as const,
          cpu: null,
          powergrid: null,
          reasons: [resources?.reason ?? "Pilot-specific simulation is unavailable."],
        };
  const needed = [
      ...new Set<number>(
        [r.plan.targetHullTypeID, ...requirements.map((x: any) => x.typeID)].filter(positive),
      ),
    ],
    relevantStock =
      validSource && src.access.query
        ? needed.map((typeID) => ({
            typeID,
            name:
              requirements.find((x: any) => x.typeID === typeID)?.name ??
              (typeID === fit.goalTypeID ? fit.hullName : null) ??
              `Type ${typeID}`,
            quantity: src.quantities
              ? (src.quantities[typeID] ?? 0)
              : src.rows
                  .filter((x: any) => x.typeID === typeID)
                  .reduce((n: number, x: any) => n + x.quantity, 0),
          }))
        : null;
  const capacityReady =
    (resources?.state === "SIMULATED" && resources.fits === true) ||
    (r.plan.mode === "ALREADY_SATISFIED" &&
      r.nativeResources?.state === "NATIVE" &&
      r.nativeResources.characterID === input.characterID &&
      r.nativeResources.shipTypeID === fit.goalTypeID &&
      r.nativeResources.fits === true &&
      r.nativeResources.allModulesOnline === true);
  const sourceReady =
    validSource &&
    src.access.query === true &&
    (r.plan.requiresStockTake === false || src.access.take === true);
  const canApply =
    r.canApply === true &&
    capacityReady &&
    sourceReady &&
    ((pilot.control.owner === "OFF" && pilot.control.online === false) ||
      (r.onlineCockpit === true &&
        pilot.control.owner === "BROWSER" &&
        !!cockpitSession(input.characterID)));
  const knownHull = positive(r.currentShipTypeID);
  const currentHullName = knownHull
    ? await reviewedHullName(
        token,
        r.currentShipTypeID,
        r.plan.currentShipTypeName,
        cat.choices.find((x) => x.goalTypeID === r.currentShipTypeID)?.hullName,
      )
    : null;
  const existingHullID =
    r.plan.mode === "EXISTING_HULL" && positive(r.plan.targetHullID) ? r.plan.targetHullID : null;
  const replacesShip =
    r.plan.mode === "NEW_HULL" || (existingHullID !== null && existingHullID !== r.shipID);
  const hullReview = currentHullName
    ? {
        current: currentHullName,
        required: fit.hullName ?? `Ship ${fit.goalTypeID}`,
        matches: r.currentShipTypeID === fit.goalTypeID,
        newHullRequired: r.plan.mode === "NEW_HULL",
        packagedQuantity:
          validSource && src.access.query
            ? (src.packagedQuantity ??
              src.rows
                .filter((x: any) => x.typeID === fit.goalTypeID && x.singleton === false)
                .reduce((n: number, x: any) => n + x.quantity, 0))
            : null,
        preserveCurrentShip: replacesShip,
        ready: r.plan.mode === "ALREADY_SATISFIED" && nativeStatus.equipment === "VERIFIED",
      }
    : undefined;
  reviews.set(reviewID, {
    token,
    characterID: input.characterID,
    setup,
    fingerprint,
    canApply,
    replacedShipID: replacesShip ? r.shipID : null,
    existingHullID,
    originalShipID: r.shipID,
  });
  return {
    ...d,
    hullReview,
    rawReview: r.rawReview ?? null,
    fittingService:
      r.fittingService === "AVAILABLE"
        ? ("AVAILABLE" as const)
        : r.fittingService === "UNAVAILABLE"
          ? ("UNAVAILABLE" as const)
          : ("UNKNOWN" as const),
    status: nativeStatus,
    stockAuthority: validSource && src.access.query ? "VERIFIED_SOURCE" : null,
    relevantStock,
    pilot: {
      ...pilot,
      shipID: r.shipID,
      shipTypeID: knownHull ? r.currentShipTypeID : null,
      hullName: currentHullName,
      locationID: r.stationID,
      stationID: r.stationID,
      dockState: "DOCKED",
    },
    selected: contract(token, input.providerCharacterID, cat.corporationID, fit),
    requirements,
    fittingResources,
    nativeResources: r.nativeResources,
    skills: {
      state: Array.isArray(r.skills?.missing)
        ? r.skills.missing.length
          ? "NOT_READY"
          : "READY"
        : "UNAVAILABLE",
      missing: (r.skills?.missing ?? []).map((s: any) => ({
        name: `Skill ${s.typeID}`,
        level: s.toLevel,
        trainedLevel: null,
      })),
    },
    applyReview: {
      reviewID,
      reviewHash: fingerprint,
      expiresAt: r.expiresAt ?? null,
      canApply,
      reasons: [
        ...(!capacityReady ? ["Exact pilot-specific CPU/PG is unavailable or insufficient."] : []),
        ...(!sourceReady ? ["Exact source Query/Take authority is unavailable or denied."] : []),
        ...(Array.isArray(r.applyBlockers) ? r.applyBlockers : []),
        ...(!(pilot.control.owner === "OFF" && pilot.control.online === false) &&
        r.onlineCockpit !== true
          ? [
              "Equipment changes require the actual idle, docked Cockpit or an offline temporary session.",
            ]
          : []),
      ],
      suppliesPolicy: "UNKNOWN",
      plan: {
        ...r.plan,
        steps: Array.isArray(r.plan.steps) ? r.plan.steps : [],
        unsupported: r.plan.unsupported ?? [],
        shortages: r.plan.shortages ?? [],
        destructiveActions: r.plan.destructiveActions ?? [],
      },
    },
    candidateSource: {
      ...d.candidateSource,
      kind: input.sourceKind,
      corporationID: input.sourceKind === "corp" ? pilot.corporationID : null,
      division: input.sourceKind === "corp" ? input.division : null,
      ...(validSource
        ? {
            quality: "NATIVE_READ",
            query: src.access.query ? "ALLOWED" : "DENIED",
            take: src.access.take ? "ALLOWED" : "DENIED",
            flag: src.pin.flag,
            contentsLocationID: src.pin.locationID,
            rows: src.rows.map((x: any) => ({
              itemID: x.itemID,
              typeID: x.typeID,
              name: `Type ${x.typeID}`,
              kind: "STOCK",
              flagID: x.flagID,
              quantity: x.quantity,
              loaded: false,
            })),
            reasons:
              src.rowCount > src.rows.length
                ? [
                    `Showing ${src.rows.length} of ${src.rowCount} stock stacks. The stock totals use all stacks.`,
                  ]
                : [],
          }
        : {}),
    },
    evidence: {
      ...d.evidence,
      unsupported: validSource ? [] : ["Stock access and exact source details are unavailable."],
    },
  };
}
function verifiedFinalStatus(value: any) {
  const s = value?.finalStatus;
  return s &&
    s.equipment === "VERIFIED" &&
    ["FULL", "LOW", "MISSING", "UNKNOWN"].includes(s.supplies) &&
    Array.isArray(s.targets)
    ? s
    : { equipment: "VERIFIED" as const, supplies: "UNKNOWN" as const, targets: [] };
}
async function releaseState(token: string, characterID: number): Promise<{ state: string }> {
  try {
    const r = await trainingAdapterContext().authenticatedJson(
      `/api/pilot-training/ownership?characterID=${characterID}`,
      options(token),
    );
    if (r?.ownership?.characterID === characterID) {
      if (r.ownership.owner === "OFF" && r.ownership.online === false)
        return { state: "VERIFIED_OFFLINE" };
      if (r.ownership.online === true) return { state: "STILL_ONLINE" };
    }
  } catch {
    /* Unknown control is not a verified release. */
  }
  return { state: "UNKNOWN" };
}
export async function centerApply(
  token: string,
  reviewID: string,
  reviewHash: string,
  oldShipDivision = 0,
): Promise<{ outcome: ApplyOutcome }> {
  const r = reviews.get(reviewID);
  if (!r || r.token !== token || !r.canApply || r.fingerprint !== reviewHash)
    throw Error("The reviewed Apply is unavailable or already dispatched.");
  if ((r.setup.oldShipDivision ?? 0) !== oldShipDivision)
    throw Error("Previous ship destination changed. Inspect the ship again before Apply.");
  reviews.delete(reviewID);
  const base = {
    operationID: reviewID,
    control: null,
    revalidation: null,
    provisioning: null,
    release: { state: "UNKNOWN" },
    finalReview: null,
  };
  let result: ApplyOutcome;
  try {
    const hosted = await trainingAdapterContext().runHosted(
      r.characterID,
      "provision-apply",
      { ...r.setup, reviewedPlanFingerprint: r.fingerprint } as JsonValue,
      options(token),
    );
    const value = hosted.readout as any;
    const exact =
      value?.characterID === r.characterID &&
      typeof value.operationID === "string" &&
      value.operationID;
    const existingVerified =
      r.existingHullID !== null &&
      value?.existingHull === true &&
      value.shipID === r.existingHullID &&
      value.originalShipID === r.originalShipID;
    const receipt = value?.nativeReceipt;
    const nativeVerified =
      receipt?.operationID === value?.operationID && receipt?.state === "COMPLETE";
    if (
      exact &&
      value.equipment === "VERIFIED" &&
      positive(value.shipID) &&
      (r.existingHullID === null || existingVerified) &&
      (hosted.phase === "Provisioning verified" ||
        hosted.phase === "Previous ship storage incomplete" ||
        (hosted.phase === "Session release blocked" && (existingVerified || nativeVerified)))
    ) {
      const stored =
        r.replacedShipID !== null &&
        (existingVerified ||
          (nativeVerified && receipt.manifest?.originalShipID === r.replacedShipID))
          ? previousShipStorageProof(
              value.previousShipStorage,
              r.replacedShipID,
              r.setup.oldShipDivision,
            )
          : null;
      const storageReason =
        r.replacedShipID !== null && r.setup.oldShipDivision !== undefined && !stored
          ? (value.previousShipStorageReason ??
            `Storage of previous ship #${r.replacedShipID} in corporation Division ${r.setup.oldShipDivision} could not be verified.`)
          : (value.previousShipStorageReason ?? null);
      result = {
        ...base,
        operationID: value.operationID,
        state: storageReason ? "PARTIAL" : "COMPLETE",
        reason: storageReason ?? (hosted.phase === "Session release blocked" ? hosted.why : null),
        provisioning: {
          operationID: value.operationID,
          state: "COMPLETE",
          manifest: {
            targetHullID: value.shipID,
            ...(stored ? { previousShipStorage: stored } : {}),
          },
        },
        release: value.onlineCockpit
          ? { state: "RETAINED_EXISTING" }
          : await releaseState(token, r.characterID),
        nativeResources: value.nativeResources,
        rawReadout: value,
        finalReview: { status: verifiedFinalStatus(value), context: { shipID: value.shipID } },
      };
    } else if (
      exact &&
      hosted.phase === "Existing ship Apply incomplete" &&
      value.targetHullID === r.existingHullID &&
      value.originalShipID === r.originalShipID
    ) {
      result = {
        ...base,
        operationID: value.operationID,
        state: "BLOCKED",
        reason: hosted.why,
        rawReadout: value,
        release: value.onlineCockpit
          ? { state: "RETAINED_EXISTING" }
          : await releaseState(token, r.characterID),
        provisioning: {
          operationID: value.operationID,
          state: "BLOCKED",
          manifest: { targetHullID: value.targetHullID },
        },
      };
    } else if (exact && typeof value.nativeState === "string") {
      result = {
        ...base,
        operationID: value.operationID,
        state: value.nativeState === "REFUSED" ? "REFUSED" : "BLOCKED",
        reason: value.nativeReason ?? hosted.why,
        release: await releaseState(token, r.characterID),
        rawReadout: value,
        provisioning: {
          operationID: value.operationID,
          state: value.nativeState,
          manifest: { targetHullID: value.targetHullID ?? null },
        },
      };
    } else throw Error(hosted.why ?? "Could not verify the native Apply result.");
  } catch (cause) {
    result = {
      ...base,
      state: "UNCERTAIN",
      reason: cause instanceof Error ? cause.message : String(cause),
      release: await releaseState(token, r.characterID),
    };
  }
  return { outcome: result };
}
