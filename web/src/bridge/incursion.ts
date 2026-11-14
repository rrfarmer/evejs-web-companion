// The incursion the pilot's system is in, as the client's incursion service keeps it (eve/client/script/ui/shared/
// incursionSvc.py): OnTaleData(solarSystemID, {taleID: tale}) sets each tale whose templateClassID is an incursion's
// (talecommon INCURSION_TEMPLATE_CLASSES: incursion 2, spreadingIncursion 5) as the incursion data; OnTaleRemove(taleID,
// templateClassID, templateID) of an incursion's class clears it; OnInfluenceUpdate(taleID, influenceData) takes the
// new influence and lastUpdated (infoPanelIncursions.OnInfluenceUpdate).
//
// talecommon/influence.CalculateDecayedInfluenceWithTime: past the grace time (minutes) the influence falls by the
// decay rate an hour; below 0.0001 it is 0.

import type { JsonValue } from "./wire.ts";

export const INCURSION_TEMPLATE_CLASSES: readonly number[] = [2, 5];

export interface IncursionInfluence { readonly influence: number; readonly lastUpdatedMs: number; readonly graceTime: number; readonly decayRate: number }
export interface IncursionEffect { readonly name: string; readonly texturePath: string; readonly hint: string; readonly isScalable: boolean }
export interface IncursionData {
  readonly taleID: number; readonly templateClassID: number; readonly severity: number; readonly hasFinalEncounter: boolean;
  readonly influence: IncursionInfluence; readonly effects: readonly IncursionEffect[];
}

type Entry = readonly [JsonValue, JsonValue];
function entries(value: JsonValue | undefined): readonly Entry[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { type?: unknown; name?: unknown; entries?: unknown; args?: unknown };
    if (v.type === "dict" && Array.isArray(v.entries)) return v.entries as Entry[];
    if (v.type === "object" && v.name === "util.KeyVal") return entries(v.args as JsonValue);
  }
  return [];
}
const field = (value: JsonValue | undefined, key: string) => entries(value).find((e) => e[0] === key)?.[1];
function num(value: JsonValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) return Number((value as { value: unknown }).value);
  return null;
}
const items = (value: JsonValue | undefined): readonly JsonValue[] => (Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items) ? (value as { items: JsonValue[] }).items : []);
const FILETIME_EPOCH = 116_444_736_000_000_000n;
function filetimeMs(value: JsonValue | undefined): number {
  const raw = value && typeof value === "object" && !Array.isArray(value) && "value" in value ? String((value as { value: unknown }).value) : typeof value === "number" ? String(value) : "";
  return /^\d+$/.test(raw) ? Number((BigInt(raw) - FILETIME_EPOCH) / 10_000n) : 0;
}

/** An influenceData KeyVal. */
export function decodeInfluence(value: JsonValue | undefined): IncursionInfluence {
  return { influence: num(field(value, "influence")) ?? 0, lastUpdatedMs: filetimeMs(field(value, "lastUpdated")), graceTime: num(field(value, "graceTime")) ?? 0, decayRate: num(field(value, "decayRate")) ?? 0 };
}

/** OnTaleData's tales that are incursions, in the dict's order (the client sets each in turn: the last stays). */
export function incursionsOfTaleData(args: readonly unknown[]): IncursionData[] {
  const out: IncursionData[] = [];
  for (const [, tale] of entries(args[1] as JsonValue)) {
    const templateClassID = num(field(tale, "templateClassID")) ?? 0;
    if (!INCURSION_TEMPLATE_CLASSES.includes(templateClassID)) continue;
    out.push({
      taleID: num(field(tale, "taleID")) ?? 0, templateClassID, severity: num(field(tale, "severity")) ?? 0,
      hasFinalEncounter: field(tale, "hasFinalEncounter") === true, influence: decodeInfluence(field(tale, "influenceData")),
      effects: items(field(tale, "effects")).map((e) => ({ name: String(field(e, "name") ?? ""), texturePath: String(field(e, "texturePath") ?? ""), hint: String(field(e, "hint") ?? ""), isScalable: field(e, "isScalable") === true })),
    });
  }
  return out;
}

/** CalculateDecayedInfluenceWithTime. */
export function decayedInfluence(info: IncursionInfluence, nowMs: number): number {
  let influence = info.influence;
  const minutesPast = (nowMs - info.lastUpdatedMs) / 60_000;
  if (info.decayRate > 0 && minutesPast > info.graceTime) influence -= info.decayRate * Math.max((minutesPast - info.graceTime) / 60, 0);
  return influence < 0.0001 ? 0 : influence;
}

/** incursionConst.SCENETYPE_DATA by severity (talecommon sceneTypesByID): the icon, its hint, the subtitle. */
export const SCENETYPE_DATA: Readonly<Record<number, { readonly severityIcon: string; readonly hint: string; readonly subTitle: string }>> = {
  4: { severityIcon: "res:/UI/Texture/classes/Incursions/incursionStaging.png", hint: "UI/Incursion/HUD/StagingClassHint", subTitle: "UI/Incursion/HUD/SubtitleStaging" },
  3: { severityIcon: "res:/UI/Texture/classes/Incursions/incursionLight.png", hint: "UI/Incursion/HUD/VanguardClassHint", subTitle: "UI/Incursion/HUD/SubtitleVanguard" },
  2: { severityIcon: "res:/UI/Texture/classes/Incursions/IncursionMedium.png", hint: "UI/Incursion/HUD/AssaultClassHint", subTitle: "UI/Incursion/HUD/SubtitleAssault" },
  1: { severityIcon: "res:/UI/Texture/classes/Incursions/incursionHeavy.png", hint: "UI/Incursion/HUD/HeadquarterClassHint", subTitle: "UI/Incursion/HUD/SubtitleHeadquarters" },
  8: { severityIcon: "", hint: "UI/Incursion/HUD/IncursionStagingClassHint", subTitle: "UI/Incursion/HUD/SubtitleIncursionStaging" },
  9: { severityIcon: "res:/UI/Texture/classes/InfoPanels/taleIncursionLightInfestation.png", hint: "UI/Incursion/HUD/IncursionLightInfestationClassHint", subTitle: "UI/Incursion/HUD/SubtitleIncursionLightInfestation" },
  10: { severityIcon: "res:/UI/Texture/classes/InfoPanels/taleIncursionMediumInfestation.png", hint: "UI/Incursion/HUD/IncursionMediumInfestationClassHint", subTitle: "UI/Incursion/HUD/SubtitleIncursionMediumInfestation" },
  11: { severityIcon: "res:/UI/Texture/classes/InfoPanels/taleIncursionHeavyInfestation.png", hint: "UI/Incursion/HUD/IncursionHeavyInfestationClassHint", subTitle: "UI/Incursion/HUD/SubtitleIncursionHeavyInfestation" },
  12: { severityIcon: "res:/UI/Texture/classes/InfoPanels/taleIncursionHeavyInfestation.png", hint: "UI/Incursion/HUD/IncursionHeavyInfestationClassHint", subTitle: "UI/Incursion/HUD/SubtitleIncursionHeavyInfestation" },
};
