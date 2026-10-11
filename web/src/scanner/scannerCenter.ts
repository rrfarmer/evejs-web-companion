// Scanner / Exploration Center domain model.
//
// This file deliberately owns no store, HTTP, or Svelte state. The companion
// The site read and active-probe authority are independent: either can fail
// without pretending the other is empty. Product writes re-resolve all IDs and
// geometry server-side; this model carries only the prerequisites the view may
// honestly display and keeps unavailable distinct from successful-empty.

import type {
  ScanFieldValue,
  ScanFullState,
  ScanSite,
} from "../bridge/boundSmallServices.ts";
import type { JsonValue } from "../bridge/wire.ts";
import { SITE_KIND_LABELS, siteKind } from "./siteKind.ts";

export type ScannerDataState<T> =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "ready"; readonly value: T };

/** Server-authoritative probe geometry used by the safe product actions. */
export interface ScannerProbeOperation {
  readonly probeID: number;
  readonly typeID: number;
  readonly pos: readonly [number, number, number];
  readonly destination: readonly [number, number, number];
  readonly scanRange: number;
  readonly rangeStep: number;
  readonly state: number;
  readonly expiry: string;
}

export interface ScannerLauncherOperation {
  readonly moduleID: number;
  readonly typeID: number | null;
  readonly online: boolean;
  readonly chargeTypeID: number | null;
  readonly loadedCount: number;
  readonly launchCount: number;
}

/**
 * Current held-session action authority. IDs remain internal prerequisites;
 * product POSTs accept no IDs and re-read this source server-side before use.
 */
export interface ScannerOperationsSnapshot {
  readonly inSpace: boolean;
  readonly solarSystemID: number | null;
  readonly shipID: number | null;
  readonly maxActiveProbes: number;
  readonly launcher: ScannerLauncherOperation | null;
  readonly probes: readonly ScannerProbeOperation[];
}

export interface ScannerNameCatalog {
  /** Type names already resolved by the caller; numeric ids never become labels. */
  readonly typeNames?: Readonly<Record<number, string>>;
  /** Localized dungeon/site names keyed by dungeonNameID when that catalog exists. */
  readonly dungeonNames?: Readonly<Record<number, string>>;
}
export type ScannerSiteKind = "anomaly" | "signature" | "static" | "structure";

export interface ScannerSiteView {
  /** Internal render key only; never player-facing. */
  readonly key: string;
  readonly kind: ScannerSiteKind;
  readonly kindLabel: string;
  readonly name: string;
  /** The player-visible signal label (for example QEE-288), when reported. */
  readonly signalLabel: string | null;
  /**
   * The client's own Group column — "Ore site", "Combat site" — computed from
   * the row's scan-strength attribute exactly as the bot's block computes it
   * (siteKind.ts). Null when the row is not one this reading applies to; see
   * `siteGroupLabel`.
   */
  readonly groupLabel: string | null;
  /** A resolved type name when the read carried a type and the caller supplied its name. */
  readonly typeName: string | null;
  /** Internal icon/action datum only; the panel never renders this number as text. */
  readonly typeID: number | null;
  readonly difficulty: number | null;
  readonly deviationMeters: number | null;
}

export interface ScannerSiteGroup {
  readonly kind: ScannerSiteKind;
  readonly label: string;
  readonly emptyMessage: string;
  readonly sites: readonly ScannerSiteView[];
}

export type ScannerSitesView =
  | { readonly status: "loading"; readonly groups: readonly []; readonly totalSites: 0 }
  | {
      readonly status: "unavailable";
      readonly message: string;
      readonly groups: readonly [];
      readonly totalSites: 0;
    }
  | {
      readonly status: "empty" | "ready";
      readonly groups: readonly ScannerSiteGroup[];
      readonly totalSites: number;
    };

interface GroupDefinition {
  readonly slot: keyof ScanFullState;
  readonly kind: ScannerSiteKind;
  readonly label: string;
  readonly fallbackName: string;
  readonly emptyMessage: string;
}

const GROUPS: readonly GroupDefinition[] = [
  {
    slot: "anomalies",
    kind: "anomaly",
    label: "Cosmic anomalies",
    fallbackName: "Unnamed cosmic anomaly",
    emptyMessage: "No cosmic anomalies were reported.",
  },
  {
    slot: "signatures",
    kind: "signature",
    label: "Cosmic signatures",
    fallbackName: "Unidentified cosmic signature",
    emptyMessage: "No cosmic signatures were reported.",
  },
  {
    slot: "staticSites",
    kind: "static",
    label: "Static sites",
    fallbackName: "Unnamed static site",
    emptyMessage: "No static sites were reported.",
  },
  {
    slot: "structures",
    kind: "structure",
    label: "Structures",
    fallbackName: "Unknown structure",
    emptyMessage: "No structures were reported by the scanner.",
  },
];

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text === "" ? null : text;
}

function numberField(fields: Readonly<Record<string, ScanFieldValue>>, key: string): number | null {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveIntField(
  fields: Readonly<Record<string, ScanFieldValue>>,
  key: string,
): number | null {
  const value = numberField(fields, key);
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function textField(
  fields: Readonly<Record<string, ScanFieldValue>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const text = cleanText(fields[key]);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

function catalogName(
  catalog: Readonly<Record<number, string>> | undefined,
  id: number | null,
): string | null {
  if (id === null || !catalog) {
    return null;
  }
  return cleanText(catalog[id]);
}

/**
 * ⚠ AN ANOMALY ALWAYS SHOWS A GROUP, INCLUDING "Unknown site". That is not
 * noise — it is the one fact a player needs when a mining bot refuses to fly
 * to a rock field they can see: the ore/combat blocks skip a site whose kind
 * the server did not report, so a column full of "Unknown site" is the answer
 * to "why is my bot saying there is nothing here", and hiding it would hide
 * exactly the case worth seeing.
 *
 * The other three slots do not carry a scan-strength attribute at all (only
 * anomaly rows do — bridge/boundSmallServices.ts), so an unreadable one there
 * means "this row was never going to say", not "the server dropped a field".
 * Those show nothing rather than labelling every signature Unknown.
 */
function siteGroupLabel(
  fields: Readonly<Record<string, ScanFieldValue>>,
  kind: ScannerSiteKind,
): string | null {
  const group = siteKind(fields["scanStrengthAttribute"], fields["archetypeID"]);
  if (group === "unknown" && kind !== "anomaly") {
    return null;
  }
  return SITE_KIND_LABELS[group];
}

function siteView(
  site: ScanSite,
  definition: GroupDefinition,
  names: ScannerNameCatalog,
  index: number,
): ScannerSiteView {
  const fields = site.fields;
  const reportedTypeID = positiveIntField(fields, "typeID");
  const entryObjectTypeID = positiveIntField(fields, "entryObjectTypeID");
  const typeID = reportedTypeID ?? entryObjectTypeID;
  const typeName = catalogName(names.typeNames, typeID);
  const dungeonNameID = positiveIntField(fields, "dungeonNameID");
  const dungeonName = catalogName(names.dungeonNames, dungeonNameID);
  const explicitName = textField(fields, ["name", "siteName", "dungeonName", "label"]);

  // A structure's reported type is its useful name. For anomaly rows,
  // entryObjectTypeID is often merely an acceleration gate, so it is metadata,
  // never a substitute for the site's dungeon name.
  const name = explicitName
    ?? dungeonName
    ?? (definition.kind === "structure" ? typeName : null)
    ?? definition.fallbackName;

  return {
    key: `${definition.kind}:${String(site.siteID ?? index)}`,
    kind: definition.kind,
    kindLabel: definition.label,
    name,
    signalLabel: cleanText(site.targetID),
    groupLabel: siteGroupLabel(fields, definition.kind),
    typeName,
    typeID,
    difficulty: numberField(fields, "difficulty"),
    deviationMeters: numberField(fields, "deviation"),
  };
}

function sortSites(sites: readonly ScannerSiteView[]): readonly ScannerSiteView[] {
  return [...sites].sort((left, right) => {
    const leftSignal = left.signalLabel ?? "";
    const rightSignal = right.signalLabel ?? "";
    return leftSignal.localeCompare(rightSignal) || left.name.localeCompare(right.name);
  });
}

/** The sites as the panel has them: what was read, or, for a read that failed (null), that they are not known. */
export function scannerStateFromRead(
  read: ScanFullState | null,
): ScannerDataState<ScanFullState> {
  if (read === null) {
    return {
      status: "unavailable",
      // Do not surface raw gateway codes/resource strings as player copy.
      reason: "Scanner data could not be read from the live session.",
    };
  }
  return { status: "ready", value: read };
}

/** Build the named, grouped site view without inventing missing scanner facts. */
export function buildScannerSitesView(
  state: ScannerDataState<ScanFullState>,
  names: ScannerNameCatalog = {},
): ScannerSitesView {
  if (state.status === "loading") {
    return { status: "loading", groups: [], totalSites: 0 };
  }
  if (state.status === "unavailable") {
    return {
      status: "unavailable",
      message: state.reason,
      groups: [],
      totalSites: 0,
    };
  }

  const groups = GROUPS.map((definition) => ({
    kind: definition.kind,
    label: definition.label,
    emptyMessage: definition.emptyMessage,
    sites: sortSites(
      state.value[definition.slot].map((site, index) =>
        siteView(site, definition, names, index)),
    ),
  }));
  const totalSites = groups.reduce((total, group) => total + group.sites.length, 0);
  return {
    status: totalSites === 0 ? "empty" : "ready",
    groups,
    totalSites,
  };
}

export type ScannerActionID = "launch" | "recover" | "analyze" | "reconnect";
export type ScannerActionResult = void | Promise<void>;
export type ProbeScanMap = Readonly<Record<string, JsonValue>>;

export interface ScannerActionBindings {
  readonly launch?: {
    readonly moduleID: number;
    readonly count: number;
    readonly launcherName?: string | null;
    run(moduleID: number, count: number): ScannerActionResult;
  };
  readonly recover?: {
    readonly probeIDs: readonly number[];
    run(probeIDs: readonly number[]): ScannerActionResult;
  };
  readonly analyze?: {
    /** Exact geometry keyed by owned probe id; the panel never fabricates it. */
    readonly probeMap: ProbeScanMap;
    run(probeMap: ProbeScanMap): ScannerActionResult;
  };
  readonly reconnect?: {
    run(): ScannerActionResult;
  };
}

export interface ScannerConfirmation {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
}

export interface ScannerActionAvailability {
  readonly id: ScannerActionID;
  readonly label: string;
  readonly enabled: boolean;
  readonly detail: string;
  readonly confirmation: ScannerConfirmation | null;
}

/** The intentionally small, high-value action surface. Destroy/move/range are omitted. */
export const SCANNER_ACTION_IDS: readonly ScannerActionID[] = [
  "launch",
  "recover",
  "analyze",
  "reconnect",
];

const ACTION_LABELS: Readonly<Record<ScannerActionID, string>> = {
  launch: "Launch probes",
  recover: "Recover probes",
  analyze: "Analyze signatures",
  reconnect: "Reconnect to probes",
};

const LAUNCH_CONFIRMATION: ScannerConfirmation = {
  title: "Launch scanner probes?",
  message:
    "Launching moves probe charges out of the ship and into space. They must be recovered before leaving them behind.",
  confirmLabel: "Confirm launch",
};

function validProbeIDs(ids: readonly number[]): readonly number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
}

/** Pure action policy used by the panel and tests. */
export function scannerActionAvailability(
  id: ScannerActionID,
  actions: ScannerActionBindings = {},
): ScannerActionAvailability {
  const label = ACTION_LABELS[id];
  switch (id) {
    case "launch": {
      const binding = actions.launch;
      const enabled = Boolean(
        binding
          && Number.isSafeInteger(binding.moduleID)
          && binding.moduleID > 0
          && Number.isSafeInteger(binding.count)
          && binding.count > 0,
      );
      return {
        id,
        label,
        enabled,
        detail: enabled
          ? `${binding!.count} probe${binding!.count === 1 ? "" : "s"} ready in ${cleanText(binding!.launcherName) ?? "the fitted launcher"}.`
          : "A fitted probe launcher and its launch count are not available to this panel.",
        confirmation: LAUNCH_CONFIRMATION,
      };
    }
    case "recover": {
      const count = actions.recover ? validProbeIDs(actions.recover.probeIDs).length : 0;
      return {
        id,
        label,
        enabled: count > 0,
        detail: actions.recover === undefined
          ? "Active probe IDs are not available to this panel, so recovery cannot be targeted safely."
          : count > 0
            ? `${count} launched probe${count === 1 ? " is" : "s are"} available to recover.`
            : "No launched probes are available to recover.",
        confirmation: null,
      };
    }
    case "analyze": {
      const count = actions.analyze ? Object.keys(actions.analyze.probeMap).length : 0;
      return {
        id,
        label,
        enabled: count > 0,
        detail: actions.analyze === undefined
          ? "Probe geometry is not available to this panel, so it will not invent a scan map."
          : count > 0
            ? `${count} probe position${count === 1 ? " is" : "s are"} ready for analysis.`
            : "The supplied probe map is empty, so there is nothing safe to analyze.",
        confirmation: null,
      };
    }
    case "reconnect":
      return {
        id,
        label,
        enabled: actions.reconnect !== undefined,
        detail: actions.reconnect
          ? "Ask the current-system scan manager to reconnect your lost probes."
          : "The reconnect route exists, but its callback has not been wired into this panel.",
        confirmation: null,
      };
  }
}
