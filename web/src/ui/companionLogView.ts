// The fleet companion's flight log, as lines a person can read.
//
// FleetCompanions.svelte only renders; everything that decides what a line SAYS
// lives here, so it can be tested without a browser:
//   - `parseLogLines`  the BFF returns raw JSON values; keep the ones that are lines.
//   - `traceSummary`   a decide line's trace (nav/companionTrace.ts) in one sentence.
//   - `buildLogView`   filter, group by `seq`, order newest first, cap.
//
// ⚠ READ-ONLY, AND IT TRUSTS NOTHING. The log is a file on the operator's BFF
// written by older and newer builds alike, so every optional field may be absent
// and a trace may be missing any rung. Nothing here throws on a short line.
//
// ⚠ TIMES ARE UTC, SLICED FROM THE ISO STRING. Local time would make the same
// log read differently on two machines (and the tests depend on the machine).

import type { BotLogEntry, BotLogKind } from "../nav/botLog.ts";
import type { CompanionTrace } from "../nav/companionTrace.ts";

const KINDS: ReadonlySet<string> = new Set<BotLogKind>(["start", "decide", "issue", "result", "end"]);

/** Most rows the panel draws; older ones are counted, not drawn. */
export const LOG_ROW_LIMIT = 400;

/** Keep only the values that are log lines, in the order given. */
export function parseLogLines(raw: readonly unknown[]): BotLogEntry[] {
  const lines: BotLogEntry[] = [];
  for (const value of raw) {
    if (typeof value !== "object" || value === null) continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.t !== "string" || typeof candidate.kind !== "string") continue;
    if (!KINDS.has(candidate.kind)) continue;
    lines.push(value as BotLogEntry);
  }
  return lines;
}

/** HH:MM:SS (UTC) from an ISO-8601 string; the raw string when it is not one. */
export function clockOf(iso: string): string {
  const match = /^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2}:\d{2})/.exec(iso);
  return match?.[1] ?? iso;
}

function metres(value: number): string {
  return Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** A short list: the first few, then how many more. */
function capped(values: readonly string[], keep = 3): string {
  return values.length <= keep ? values.join(", ") : `${values.slice(0, keep).join(", ")} +${values.length - keep}`;
}

/**
 * One line for a trace, rung by rung, only the rungs that wrote a slice:
 * "combat: orbit-optimal 12.0 km, closing | guns 2/3 (1 assumed) | props: closing
 *  | ammo: persisting | util: web out-of-optimal".
 *
 * `guns A/B` is the guns allowed to start over all guns the gate looked at, where
 * allowed = measured in reach + assumed (let through because reach or distance
 * was unknown), and all = allowed + out of reach.
 */
export function traceSummary(trace: CompanionTrace | null | undefined): string {
  if (trace === null || trace === undefined) return "";
  const parts: string[] = [];

  const c = trace.combat;
  if (c !== undefined) {
    let text = `combat: ${c.outcome}`;
    if (typeof c.distanceM === "number") text += ` ${metres(c.distanceM)}`;
    if (c.far) text += ", closing";
    if (c.leashed) text += ", leashed";
    parts.push(text);
  }

  const g = trace.guns;
  if (g !== undefined) {
    const inReach = g.inReach?.length ?? 0;
    const assumed = g.assumed?.length ?? 0;
    const out = g.outOfReach?.length ?? 0;
    parts.push(`guns ${inReach + assumed}/${inReach + assumed + out}${assumed > 0 ? ` (${assumed} assumed)` : ""}`);
  }

  const p = trace.props;
  if (p !== undefined) {
    const seen = [p.mode ? `mode ${p.mode}` : null, p.hostiles === true ? "hostiles" : p.hostiles === false ? "no hostiles" : null,
      p.formation ? "formation" : null].filter((x) => x !== null).join(", ");
    parts.push(`props: ${p.because}${p.withheld ? ` (withheld: ${p.withheld})` : ""}${seen ? ` [${seen}]` : ""}`);
  }

  const a = trace.ammo;
  if (a !== undefined) {
    if (a.skipped) {
      parts.push(`ammo: skipped, ${a.skipped}`);
    } else {
      const codes = uniq((a.units ?? []).map((unit) => unit.code));
      parts.push(`ammo: ${codes.length === 0 ? "no units" : capped(codes)}`);
    }
  }

  const u = trace.util;
  if (u !== undefined) {
    const items = [
      ...(u.skipped ?? []).map((s) => `${s.family} ${s.code}`),
      ...(u.gaveUp ?? []).map((s) => `${s.family} gave up ${s.what}`),
    ];
    parts.push(`util: ${items.length === 0 ? "none" : capped(items)}`);
  }

  const x = trace.cleared;
  if (x !== undefined) {
    const which = [x.follow ? "follow" : "", x.hold ? "hold" : ""].filter((word) => word !== "").join("+");
    parts.push(`cleared: ${x.by}${which === "" ? "" : ` (${which})`}`);
  }

  const h = trace.health;
  if (h !== undefined) {
    const pct = (ratio: number | null | undefined): string => typeof ratio === "number" ? `${Math.round(ratio * 100)}%` : "?";
    parts.push(`health: ${h.code} ${h.layer ?? "tank"} ${pct(h.tank)} (floor ${pct(h.floor)}, mark ${pct(h.mark)}), repairer ${h.repairer}`);
  }

  const d = trace.drones;
  if (d !== undefined) {
    const pct = (ratio: number | null | undefined): string => typeof ratio === "number" ? `${Math.round(ratio * 100)}%` : "?";
    const rows = (d.rows ?? []).map((row) => row.state === "aboard"
      ? `${row.id} aboard ${Math.round((row.heldMs ?? 0) / 1000)}s`
      : `${row.id} ${row.state === "homeward" ? "home " : ""}${pct(row.shield)}${row.attackers.length > 0 ? ` x${row.attackers.length}` : ""}`);
    // Five: a full flight, so the drone being shot is never the one cut off.
    const cap = d.cap === undefined ? "" : `, cap ${d.cap ?? "?"}`;
    parts.push(`drones: ${d.rotation}${cap}${rows.length === 0 ? "" : ` ${capped(rows, 5)}`}`);
  }

  return parts.join(" | ");
}

/** How a row is toned: a refusal is bad, an uncertain or deferred call is a warning. */
export type LogTone = "" | "good" | "warn" | "bad";

export interface LogRow {
  /** Position in the log as read; stable for the life of one load. */
  readonly index: number;
  readonly time: string;
  readonly kind: BotLogKind;
  readonly phase: string;
  /** The line's sentence: why / says / refusal, by kind. */
  readonly text: string;
  /** A decide line's trace, in one line; null when it has none. */
  readonly summary: string | null;
  readonly trace: CompanionTrace | null;
  readonly seq: number | null;
  readonly heartbeat: boolean;
  readonly tone: LogTone;
  /** Shares its `seq` with a neighbour (decide -> issue -> result). */
  readonly inGroup: boolean;
  /** First row of its group (or a row on its own). */
  readonly groupStart: boolean;
  /** The text the filter matches against, lower-cased. */
  readonly haystack: string;
}

export interface LogView {
  readonly rows: readonly LogRow[];
  /** Lines in the log. */
  readonly total: number;
  /** Lines that matched the filter. */
  readonly matched: number;
  /** Matched lines older than the cap, not drawn. */
  readonly hidden: number;
}

function sentenceOf(entry: BotLogEntry): string {
  switch (entry.kind) {
    case "start":
      return entry.script ? `start: ${entry.script}` : "start";
    case "end": {
      const why = entry.reason ?? entry.why ?? "";
      return why === "" ? "end" : `end: ${why}`;
    }
    case "decide":
      return entry.why ?? entry.says ?? "";
    case "issue": {
      const says = entry.says ?? entry.action?.kind ?? "";
      return typeof entry.observeMs === "number" ? `${says} (read ${entry.observeMs} ms)` : says;
    }
    case "result": {
      const ms = typeof entry.callMs === "number" ? ` (${entry.callMs} ms)` : "";
      if (entry.ok === true) return `ok${ms}`;
      const words = entry.refusal ?? entry.why ?? "refused";
      return `${entry.verdict ?? "refused"}: ${words}${ms}`;
    }
  }
}

function toneOf(entry: BotLogEntry): LogTone {
  if (entry.kind !== "result") return "";
  if (entry.ok === true) return "good";
  return entry.verdict === "uncertain" || entry.verdict === "deferred" ? "warn" : "bad";
}

/** Whitespace-separated terms, all of which must appear (any order, any case). */
export function matchesFilter(haystack: string, filter: string): boolean {
  const terms = filter.toLowerCase().split(/\s+/).filter((term) => term !== "");
  return terms.every((term) => haystack.includes(term));
}

function rowFor(entry: BotLogEntry, index: number): LogRow {
  const trace = entry.trace ?? null;
  const summary = trace === null ? null : traceSummary(trace);
  const time = clockOf(entry.t);
  const phase = entry.phase ?? "";
  const text = sentenceOf(entry);
  return {
    index,
    time,
    kind: entry.kind,
    phase,
    text,
    summary,
    trace,
    seq: typeof entry.seq === "number" ? entry.seq : null,
    heartbeat: entry.heartbeat === true,
    tone: toneOf(entry),
    inGroup: false,
    groupStart: true,
    haystack: [time, entry.kind, phase, text, summary ?? "", entry.verdict ?? "", entry.heartbeat === true ? "heartbeat" : ""]
      .join(" ")
      .toLowerCase(),
  };
}

/**
 * Filter, group and order a log for display.
 *
 * Groups are runs of adjacent matched lines of ONE run that share a `seq`; a line
 * without a `seq` is a group of one. Groups are shown newest first, but the lines
 * inside a group stay in the order they happened (decide, issue, result), so a
 * tick reads top to bottom.
 */
export function buildLogView(entries: readonly BotLogEntry[], filter = "", limit = LOG_ROW_LIMIT): LogView {
  const matchedRows: { row: LogRow; run: string }[] = [];
  entries.forEach((entry, index) => {
    const row = rowFor(entry, index);
    if (matchesFilter(row.haystack, filter)) matchedRows.push({ row, run: entry.run });
  });

  const groups: { row: LogRow; run: string }[][] = [];
  for (const item of matchedRows) {
    const last = groups[groups.length - 1];
    const tail = last?.[last.length - 1];
    if (last !== undefined && tail !== undefined && item.row.seq !== null && tail.row.seq === item.row.seq && tail.run === item.run) {
      last.push(item);
    } else {
      groups.push([item]);
    }
  }

  const rows: LogRow[] = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    if (rows.length >= limit) break;
    const group = groups[g];
    if (group === undefined) continue;
    group.forEach((item, i) => {
      rows.push({ ...item.row, inGroup: group.length > 1, groupStart: i === 0 });
    });
  }

  return { rows, total: entries.length, matched: matchedRows.length, hidden: matchedRows.length - rows.length };
}
