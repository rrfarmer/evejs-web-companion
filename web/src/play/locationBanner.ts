// The location banner the HUD shows on arriving out of warp (mining/client/location_arrival_indication_service.py,
// drawn by hud/client/action_indication/indication_message_location.py), and an asteroid belt's depletion status
// (mining/client/mining_util.py) that a belt's banner carries.
//
//   on_warp_finished(warpToItemID)   the thing warped to (else the nearest asteroid belt within 100 km of its surface):
//     an asteroid belt               its name, and UI/Mining/DepletionStatusFormatted of how mined it is
//     a planet                       its name, and its planet type's name (PLANETTYPE_NAMES)
//     a station, a solar system      its name
//   The name split at its last " - ": the part before it the title (TextBody, SECONDARY), the part after the caption
//   (DISPLAY 40, uppercase, letterspace 3, HIGHLIGHT); a name with no " - " is all caption. Shown 6 s
//   (set_temporary_indication(duration=6.0)) over the ship's own action indication.
//   anim_appear: location_banner_play; the banner fades in over 0.3 s, the caption 0 -> 0.9 over 1 s with its glow
//   2.0 -> 0 on a wave over 2 s, the title 0 -> 0.5 over 1 s after 1 s; after 2 s the text (TextHeader, SECONDARY)
//   typed a character every 0.05 s, location_banner_data_clicks_play with each, its container fading in over 0.6 s.
//   disappear: a 0.3 s fade.
// (A resource-harvesting site's own banner - the system's name over the site's, from the sensor suite's anomaly - is
// not here: the page does not track the dungeon it is in.)
import { playUiEvent } from "./uiAudio.ts";

/** mining_util.DepletionStatus. */
export const enum DepletionStatus { FullyDepleted = 0, NearlyDepleted = 1, ModeratelyMined = 2, LargelyUntouched = 3 }

/** mining_util.get_depletion_status: the belt's asteroids now against its original counts by type. */
export function depletionStatus(countByType: ReadonlyMap<number, number>, originalCountByType: ReadonlyMap<number, number>): DepletionStatus {
  const typeRatios: number[] = [];
  for (const [typeID, original] of originalCountByType) typeRatios.push((countByType.get(typeID) ?? 0) / original);
  let now = 0, then = 0;
  for (const n of countByType.values()) now += n;
  for (const n of originalCountByType.values()) then += n;
  const ratio = now / then;
  const anyDepleted = typeRatios.some((r) => r === 0);
  if (ratio >= 0.9 && !anyDepleted) return DepletionStatus.LargelyUntouched;
  if (ratio >= 0.3) return DepletionStatus.ModeratelyMined;
  if (ratio > 0) return DepletionStatus.NearlyDepleted;
  return DepletionStatus.FullyDepleted;
}

/** get_depletion_status_text's labels. */
export const DEPLETION_LABELS: Readonly<Record<DepletionStatus, readonly [string, string]>> = {
  [DepletionStatus.LargelyUntouched]: ["UI/Mining/DepletionStatusLargelyUntouched", "Largely Untouched"],
  [DepletionStatus.ModeratelyMined]: ["UI/Mining/DepletionStatusPartiallyMined", "Partially Mined"],
  [DepletionStatus.NearlyDepleted]: ["UI/Mining/DepletionStatusHeavilyMined", "Heavily Mined"],
  [DepletionStatus.FullyDepleted]: ["UI/Mining/DepletionStatusFullyDepleted", "Fully Depleted"],
};

/** get_depletion_status_color: SUCCESS_GREEN, WHITE, WARNING_ORANGE, DANGER_RED. */
export const DEPLETION_COLORS: Readonly<Record<DepletionStatus, string>> = {
  [DepletionStatus.LargelyUntouched]: "rgb(141, 193, 105)",
  [DepletionStatus.ModeratelyMined]: "#fff",
  [DepletionStatus.NearlyDepleted]: "rgb(243, 144, 88)",
  [DepletionStatus.FullyDepleted]: "rgb(255, 69, 75)",
};

export const DEPLETION_FORMATTED_LABEL = "UI/Mining/DepletionStatusFormatted";

/** planetConst.PLANETTYPE_NAMES by the planet's typeID. */
export const PLANET_TYPE_LABELS: Readonly<Record<number, string>> = {
  2016: "UI/PI/PlanetType/Barren", 2017: "UI/PI/PlanetType/Storm", 11: "UI/PI/PlanetType/Temperate", 12: "UI/PI/PlanetType/Ice",
  13: "UI/PI/PlanetType/Gas", 2063: "UI/PI/PlanetType/Plasma", 2014: "UI/PI/PlanetType/Oceanic", 2015: "UI/PI/PlanetType/Lava",
  30889: "UI/PI/PlanetType/Shattered", 73911: "UI/PI/PlanetType/Scorched",
};

export const LOCATION_BANNER_WORDS: readonly string[] = [
  DEPLETION_FORMATTED_LABEL, ...Object.values(DEPLETION_LABELS).map(([label]) => label), ...Object.values(PLANET_TYPE_LABELS),
];

/** asteroids.AsteroidCount.get_asteroid_count_by_type_id_for_belt (tools/client-extract/asteroidCounts.mjs's shards). */
const shards = new Map<number, Promise<Record<string, number[]> | null>>();
export async function beltOriginalCounts(beltID: number): Promise<Map<number, number> | null> {
  const shard = Math.floor(beltID / 10000);
  let load = shards.get(shard);
  if (!load) {
    load = fetch(`/client-assets/asteroidCounts/${shard}.json`).then((r) => (r.ok ? r.json() as Promise<Record<string, number[]>> : null)).catch(() => null);
    shards.set(shard, load);
  }
  const pairs = (await load)?.[String(beltID)];
  if (!pairs || pairs.length === 0) return null;
  const counts = new Map<number, number>();
  for (let i = 0; i + 1 < pairs.length; i += 2) counts.set(pairs[i]!, pairs[i + 1]!);
  return counts;
}

let dungeonLoad: Promise<Record<string, Record<string, number[]>> | null> | null = null;

/**
 * AsteroidCount.get_asteroid_count_by_type_id_for_dungeon: the FSD asteroidCountByTypeIDRoomIDDungeonID counts of the
 * dungeon's room where a room is named (and has any), else all its rooms' (each room's counts laid over the last's,
 * as dict.update does); null where the dungeon has none.
 */
export async function dungeonOriginalCounts(dungeonID: number, roomID: number | null): Promise<Map<number, number> | null> {
  dungeonLoad ??= fetch("/client-assets/asteroidCounts/dungeons.json").then((r) => (r.ok ? r.json() as Promise<Record<string, Record<string, number[]>>> : null)).catch(() => null);
  const rooms = (await dungeonLoad)?.[String(dungeonID)];
  if (!rooms) return null;
  const counts = new Map<number, number>();
  const add = (pairs: readonly number[]) => { for (let i = 0; i + 1 < pairs.length; i += 2) counts.set(pairs[i]!, pairs[i + 1]!); };
  if (roomID) add(rooms[String(roomID)] ?? []);
  else for (const pairs of Object.values(rooms)) add(pairs);
  return counts.size ? counts : null;
}

/** appConst.dungeon_archetypes_resource_harvesting: ore anomaly, ice belt, gas clouds, resource wars. */
export const RESOURCE_HARVESTING_ARCHETYPES: ReadonlySet<number> = new Set([27, 28, 30, 47]);

/** _get_location_name_parts: [title, caption]. */
export function locationNameParts(name: string): [string | null, string] {
  const at = name.lastIndexOf(" - ");
  return at < 0 ? [null, name] : [name.slice(0, at), name.slice(at + 3)];
}

export interface BannerText { readonly text: string; readonly colored?: { readonly from: number; readonly to: number; readonly color: string } }

export class LocationBanner {
  readonly el = document.createElement("div");
  private readonly title = document.createElement("div");
  private readonly caption = document.createElement("div");
  private readonly textCont = document.createElement("div");
  private timers: ReturnType<typeof setTimeout>[] = [];
  private shownUntil = 0;

  constructor() {
    this.el.className = "location-banner";
    this.title.className = "lb-title";
    this.caption.className = "lb-caption";
    this.textCont.className = "lb-text";
    this.el.append(this.title, this.caption, this.textCont);
    this.el.hidden = true;
  }

  /** Whether the banner holds the indication now (the temporary indication over the ship's own). */
  get active(): boolean { return performance.now() < this.shownUntil; }

  show(title: string | null, caption: string, text: BannerText | null, duration = 6000): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.shownUntil = performance.now() + duration;
    this.title.textContent = title ?? "";
    this.caption.textContent = caption;
    this.textCont.replaceChildren();
    this.textCont.style.opacity = "0";
    this.el.hidden = false;
    void playUiEvent("location_banner_play");
    this.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: "forwards" });
    this.caption.animate([{ opacity: 0 }, { opacity: 0.9 }], { duration: 1000, fill: "forwards" });
    this.caption.animate([{ textShadow: "0 0 0 transparent" }, { textShadow: "0 0 12px rgba(255,255,255,0.9)" }, { textShadow: "0 0 0 transparent" }], { duration: 2000 });
    this.title.animate([{ opacity: 0 }, { opacity: 0.5 }], { duration: 1000, delay: 1000, fill: "both" });
    if (text && text.text) {
      this.timers.push(setTimeout(() => {
        this.textCont.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, fill: "forwards" });
        const plain = document.createTextNode("");
        const span = document.createElement("span");
        if (text.colored) span.style.color = text.colored.color;
        const tail = document.createTextNode("");
        this.textCont.append(plain, span, tail);
        [...text.text].forEach((ch, i) => this.timers.push(setTimeout(() => {
          if (text.colored && i >= text.colored.from && i < text.colored.to) span.textContent += ch;
          else if (text.colored && i >= text.colored.to) tail.textContent += ch;
          else plain.textContent += ch;
          void playUiEvent("location_banner_data_clicks_play");
        }, i * 50)));
      }, 2000));
    }
    this.timers.push(setTimeout(() => {
      this.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }).finished.then(() => {
        if (!this.active) this.el.hidden = true;
      }).catch(() => {});
    }, duration));
  }

  clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.shownUntil = 0;
    this.el.hidden = true;
  }
}
