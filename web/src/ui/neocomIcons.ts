// THE NEOCOM'S GLYPHS (goal R74) — one icon per panel, as SVG path data.
//
// WHY ICONS AT ALL. The launcher rail was a column of text buttons, which is
// legible but costs ~11rem of permanent width and reads as a navigation menu.
// EVE's Neocom is a narrow strip of glyphs: it gives the desktop back its width,
// and — the part that actually matters in play — a shape is recognised faster
// than a word once it has been learnt, which is what a rail you hit hundreds of
// times a session needs.
//
// ⚠ AN ICON IS NEVER THE ONLY LABEL. Every button keeps the panel's real name as
// its accessible name and its tooltip, and the rail can be widened to show the
// names inline. A glyph is an accelerator for someone who already knows the app;
// it must never be the only way to find out what a button does.
//
// WHY HAND-AUTHORED RATHER THAN AN ICON PACK. A pack is a dependency, a build
// step and a licence for ~26 glyphs that each need to read at 20px against a
// dark panel. These are deliberately crude — two or three primitives each, all
// stroked, no fills — because at this size detail turns to mud, and because a
// set drawn to one rule looks like a set.
//
// Every path is authored in a 24x24 box and stroked by the component (round caps
// and joins), so a one-point "path" like `M12 12h.01` renders as a DOT. That
// trick is used for eyes, studs and indicator lights throughout.

import type { TabID } from "./tabs.ts";

/** One glyph: the primitives to stroke, in a 24x24 box. */
export type NeocomGlyph = readonly string[];

/**
 * The glyph for every tab.
 *
 * ⚠ KEYED BY TabID AND EXHAUSTIVE BY CONSTRUCTION. `Record<TabID, …>` makes a
 * new tab a TYPE ERROR here rather than a button that silently renders an empty
 * box in the rail — which is exactly the failure a hand-maintained icon map
 * invites, and it is caught at compile time rather than by someone noticing a
 * gap in the strip.
 */
export const NEOCOM_GLYPHS: Readonly<Record<TabID, NeocomGlyph>> = {
  provisioning: ["M12 3 4 18l8-3 8 3-8-15Z", "M8 21h8"],
  // --- in space ---
  flight: ["M12 3l7 17-7-4-7 4z"],
  mining: ["M3 3l7 7", "M11 12l4-3 6 2-1 7-7 1z"],
  // Drones: three small craft flying out from a hull, in a wedge.
  drones: ["M12 4l3 4-3 2-3-2z", "M5 13l2.5 3.5L5 19", "M19 13l-2.5 3.5L19 19"],
  // Shots fired: a burst leaving a muzzle. Not a target and not a weapon — the
  // combat LOG is about hits landing, which is what the impact marks are.
  shots: ["M3 12h7", "M13 7l3 5-3 5", "M18 5l2 2", "M18 19l2-2", "M20 12h1"],
  // Equipment: three fitted slots with a power line running through them. Not
  // the Fitting glyph — this window reads and powers gear, it never refits.
  equipment: ["M4 7h16", "M4 12h16", "M4 17h16", "M8 4v16", "M16 4v16"],
  scanner: ["M21 12a9 9 0 1 1-9-9", "M12 12l7-3", "M12 12h.01"],

  // --- docked ---
  fitting: ["M12 3l6 6v9H6V9z", "M9 12h.01M15 12h.01M12 16h.01"],
  travel: ["M4 20l6-7 3 3 7-9", "M20 7h-4M20 7v4"],

  // --- automation ---
  bots: ["M7 8h10v9H7z", "M12 5v3", "M10 12h.01M14 12h.01"],
  botBuilder: ["M4 5h7v5H4z", "M13 5h7v5h-7z", "M8 14h8v5H8z"],
  // A shelf of saved bots: the frame is the library, the two ragged lines are
  // rows in it. Deliberately NOT a bot head — that is `bots`, the built-in
  // launchers; this panel is the catalogue and the roster.
  botManager: ["M4 5h16v14H4z", "M8 10h8M8 14h5"],
  miningOperations: ["M4 19l5-9 4 5 3-7 4 11z", "M5 5h4M12 5h7"],
  // Two ships in formation: a leader and a wingman holding station behind it.
  // Not a bot head and not the library shelf — this one is about flying WITH
  // somebody, which is the whole of what a companion does. It is drawn for the
  // character bar's button rather than the rail, which never offers this tab.
  companion: ["M13 3l5 10-5-2.5L8 13z", "M6 13l3 7-3-1.5L3 20z"],

  // --- goods and money ---
  inventory: ["M4 8l8-4 8 4v8l-8 4-8-4z", "M4 8l8 4 8-4M12 12v8"],
  market: ["M12 4v16", "M6 8h12", "M6 8l-2 5h4zM18 8l-2 5h4z"],
  industry: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8", "M12 2v3M12 19v3M2 12h3M19 12h3"],
  contracts: ["M6 3h8l4 4v14H6z", "M14 3v4h4", "M9 13h6M9 17h6"],
  assets: ["M4 14h7v6H4z", "M13 14h7v6h-7z", "M8.5 7h7v6h-7z"],
  wallet: ["M4 7h16v11H4z", "M4 7l12-3v3", "M17 13h.01"],
  corpWallet: ["M6 9h12v3H6z", "M6 14h12v4H6z", "M8 6h8"],

  // --- career ---
  agents: ["M11 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6", "M6 21a5 5 0 0 1 10 0", "M16 3h5v4h-5z"],
  finder: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14", "M16.5 16.5L21 21"],
  skills: ["M5 20v-4M10 20v-8M15 20v-12M20 20v-16"],
  planets: ["M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12", "M3 14c6 3.5 12 3.5 18 0"],
  // Planetary Industry: a small world over a row of three, the whole roster's
  // colonies rather than one planet.
  piManager: ["M12 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10", "M4 20h.01M12 20h.01M20 20h.01", "M4 17h16"],
  // Industry Manager: one box over three, a build tree.
  industryManager: ["M9 3h6v5H9z", "M12 8v4M5 12h14M5 12v3M12 12v3M19 12v3", "M3 15h4v5H3zM10 15h4v5h-4zM17 15h4v5h-4z"],
  characterSheet: ["M5 3h14v18H5z", "M12 8a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5", "M8 18a4 4 0 0 1 8 0"],
  standings: ["M4 9h10M4 9l3-3M4 9l3 3", "M20 15H10M20 15l-3-3M20 15l-3 3"],

  // --- people ---
  fleet: ["M12 3l4 8-4-2-4 2z", "M6 13l3 7-3-1.5-3 1.5z", "M18 13l3 7-3-1.5-3 1.5z"],
  mail: ["M4 6h16v12H4z", "M4 7.5l8 6 8-6"],
  chat: ["M4 5h16v10H9l-5 4z"],
  activity: ["M6 17h12l-1.5-2v-4a4.5 4.5 0 0 0-9 0v4z", "M10 20h4"],

  // --- the app itself ---
  settings: ["M5 7h14M5 12h14M5 17h14", "M9 7h.01M15 12h.01M11 17h.01"],
  // Show Info never appears in the rail (it is contextual — see `launchable` in
  // tabs.ts), but it still needs a glyph: `Record<TabID, …>` is exhaustive by
  // construction, and that exhaustiveness is what makes a new tab a compile
  // error here instead of an empty box. It is also drawn on the window's own
  // title row and by the openers that raise it.
  showInfo: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18", "M12 8h.01", "M12 11v6"],
  log: ["M5 4h14v16H5z", "M8 9h8M8 13h8M8 17h5"],
};

/** The glyph for a tab. */
export function neocomGlyph(id: TabID): NeocomGlyph {
  return NEOCOM_GLYPHS[id];
}

/**
 * The initials shown on the portrait tile when there is no picture to show —
 * and there never is: nothing in this client, the BFF or the gateway serves a
 * character portrait, so the tile is the ONLY state, not a fallback for a
 * missing one. It is styled as a deliberate plate for that reason.
 *
 * Up to two initials from the character's name, so "Rada Farmer" reads "RF" and
 * a single-word name reads its first letter. Empty for an empty name rather
 * than a placeholder glyph that would imply a pilot we do not have.
 */
export function portraitInitials(name: string | null | undefined): string {
  if (typeof name !== "string") {
    return "";
  }
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return "";
  }
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * EVE time — UTC, `HH:MM`, the clock every player in the game reads to agree on
 * when something happens.
 *
 * ⚠ UTC, NOT LOCAL, AND THAT IS THE ENTIRE POINT. A local clock in this corner
 * would be worse than no clock: it looks exactly like the one thing a player
 * expects (EVE time) while quietly reporting something else, and fleet times are
 * always quoted in EVE time. The offset is taken from the Date itself rather
 * than by subtracting a guess.
 */
export function eveClock(now: Date): string {
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * A wallet balance shortened to fit a rail about three characters wide.
 *
 * ⚠ IT ROUNDS, SO IT MUST NEVER READ AS EXACT. The Wallet panel is where the
 * real figure lives (grouped in full, via `formatIsk`, and bigint-exact); this
 * is a glance. It keeps one decimal and a magnitude suffix, and the button's
 * accessible name carries the full amount so nothing is lost to someone who
 * needs it.
 *
 * Works on the DECIMAL STRING, never through Number: an ISK balance routinely
 * exceeds 2^53, and a wallet that silently rounded at the top end would be
 * wrong precisely for the players who care most.
 */
export function shortIsk(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "—";
  }
  const match = /^(-?)(\d+)(?:\.\d+)?$/.exec(value.trim());
  if (!match) {
    return "—";
  }
  const sign = match[1] ?? "";
  const digits = match[2] ?? "0";
  const units = [
    { power: 12, suffix: "T" },
    { power: 9, suffix: "B" },
    { power: 6, suffix: "M" },
    { power: 3, suffix: "K" },
  ];
  for (const { power, suffix } of units) {
    if (digits.length > power) {
      const whole = digits.slice(0, digits.length - power);
      const tenth = digits[digits.length - power] ?? "0";
      return `${sign}${whole}${tenth === "0" ? "" : `.${tenth}`}${suffix}`;
    }
  }
  return `${sign}${digits}`;
}
