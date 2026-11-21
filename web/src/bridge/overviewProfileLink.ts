// An overview profile's link, as the 3698585 client makes and follows it:
//
//   the drag       the Settings window's Share handle (DraggableShareContainer) gives overviewPresetSvc.GetShareData:
//                  a fakeentry.OverviewProfile with the overview's name for its label and GetOverviewDataForSave's
//                  dict for its data
//   the drop       eveEditPlainText.OnDropData: overviewPresetMgr.StoreLinkAndGetID(data), answering a KeyVal of
//                  hashvalue and sqID (None: OverviewProfileLoadingError), then overview_preset_link(presetKey, label)
//   the url        overviewPresets/client/preset_link.py format_overview_preset_url: "overviewPreset:{hash}//{sqID}"
//   followed       handle_link: the rest after "overviewPreset:" split on "//", two parts (the second int()), then
//                  LoadSharedOverviewProfile(presetKey, linkText): the LoadOverviewProfile question (default No),
//                  GetStoredPreset(presetKey) (None: OverviewProfileLoadingError), the YAML's pairs read
//                  (GetDictFromList) and loaded under the link's text, kept in the History
import type { JsonValue } from "./wire.ts";
import { readKeyVal } from "./wire.ts";

type Ask = (service: string, method: string, args: readonly JsonValue[]) => Promise<unknown>;

export const OVERVIEW_PRESET_SCHEME = "overviewPreset";
/** The drag data's type the Share handle puts the profile in: {text, data} as JSON. */
export const OVERVIEW_PROFILE_DRAG_TYPE = "application/x-evejs-overview-profile";

export type OverviewPresetKey = readonly [hashvalue: string, sqID: number];

/** handle_link's parse: null where it would do nothing (not two parts) or raise (a second part int() refuses). */
export function parseOverviewPresetUrl(url: string): OverviewPresetKey | null {
  if (url.slice(0, OVERVIEW_PRESET_SCHEME.length).toLowerCase() !== OVERVIEW_PRESET_SCHEME.toLowerCase()) return null;
  const parts = url.slice(OVERVIEW_PRESET_SCHEME.length + 1).split("//");
  if (parts.length !== 2 || !/^\s*[+-]?\d+\s*$/.test(parts[1]!)) return null;
  return [parts[0]!, Number(parts[1]!.trim())];
}

/** format_overview_preset_url */
export function overviewPresetUrl(key: OverviewPresetKey): string {
  return `${OVERVIEW_PRESET_SCHEME}:${key[0]}//${key[1]}`;
}

/** StoreLinkAndGetID(data): the stored profile's key, null where the server kept none. */
export async function storeOverviewProfile(act: Ask, data: Readonly<Record<string, unknown>>): Promise<OverviewPresetKey | null> {
  const entries = Object.keys(data).sort().map((k) => [k, data[k]] as [string, unknown]);
  const keyVal = await act("overviewPresetMgr", "StoreLinkAndGetID", [{ type: "dict", entries } as unknown as JsonValue]);
  const hash = readKeyVal(keyVal as JsonValue, "hashvalue"), sqID = readKeyVal(keyVal as JsonValue, "sqID");
  return typeof hash === "string" && hash !== "" && typeof sqID === "number" && sqID > 0 ? [hash, sqID] : null;
}

/** GetStoredPreset(presetKey): the profile's YAML, null where none is stored. */
export async function readStoredOverviewProfile(ask: Ask, key: OverviewPresetKey): Promise<string | null> {
  const answer = await ask("overviewPresetMgr", "GetStoredPreset", [[key[0], key[1]]]);
  return typeof answer === "string" && answer !== "" ? answer : null;
}
