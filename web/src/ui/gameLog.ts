// The client's logger (shared/uilog.py Logger) for the play page: the lines the Log window (LoggerWindow) lists. A
// message is added with its type (AddText: msgtype or the message's own, NOTIFY where it has none), let in only where
// that type is shown (ShowMessage: the filter's setting for the type, kept per user - showinfologmessages and the
// rest, true by default; a type with no setting always), kept to twice the log view's count (logmessageamount, 100 or
// 1000). The dialogs the client shows feed it (dialog_handler.handle_player_fsd_dialog: hint, notify, warning,
// question, infomodal and info are logged - ClientDialogs.svelte).
import { get, writable } from "svelte/store";
import { sortScrollRows } from "../bridge/scrollSort.ts";

export interface GameLogLine { readonly n: number; readonly atMs: number; readonly type: string; readonly text: string }

/** uilog.MessageType's filtered types and their settings (MESSAGE_FILTER_SETTING_BY_MESSAGE_TYPE), in the filter
 * menu's order (LABEL_BY_MESSAGE_FILTER_SETTING). */
export const LOG_FILTERS: readonly { readonly type: string; readonly key: string; readonly label: string }[] = [
  { type: "info", key: "showinfologmessages", label: "UI/Accessories/Log/ShowInfo" },
  { type: "warning", key: "showwarninglogmessages", label: "UI/Accessories/Log/ShowWarn" },
  { type: "error", key: "showerrorlogmessages", label: "UI/Accessories/Log/ShowError" },
  { type: "combat", key: "showcombatlogmessages", label: "UI/Accessories/Log/ShowCombat" },
  { type: "notify", key: "shownotifylogmessages", label: "UI/Accessories/Log/ShowNotify" },
  { type: "question", key: "showquestionlogmessages", label: "UI/Accessories/Log/ShowQuestion" },
  { type: "mining", key: "showmininglogmessages", label: "UI/Accessories/Log/ShowMining" },
  { type: "bounty", key: "showbountylogmessages", label: "UI/Accessories/Log/ShowBounty" },
];
/** LABEL_BY_MESSAGE_TYPE. */
export const LOG_TYPE_LABELS: Readonly<Record<string, string>> = {
  error: "UI/Accessories/Log/LogError", warning: "UI/Accessories/Log/LogWarn", slash: "UI/Accessories/Log/LogSlash",
  combat: "UI/Accessories/Log/LogCombat", notify: "UI/Accessories/Log/LogNotify", question: "UI/Accessories/Log/LogQuestion",
  info: "UI/Accessories/Log/LogInfo", hint: "UI/Accessories/Log/LogHint", mining: "UI/Accessories/Log/LogMining", bounty: "UI/Accessories/Log/LogBounty",
};
/** COLORS_BY_TYPE (ARGB); the rest white. Mining's is MiningQuantityColor.YIELD. */
export const LOG_TYPE_COLOURS: Readonly<Record<string, string>> = {
  error: "#eb3700", warning: "#ffd800", slash: "#ff5500", combat: "#ff0000", bounty: "#00aa00",
};
/** log_message_count_setting's options. */
export const LOG_COUNTS: readonly number[] = [100, 1000];

const key = (name: string) => `evejs.play.${name}`;
const readBool = (name: string): boolean => { try { const v = localStorage.getItem(key(name)); return v === null ? true : v === "1"; } catch { return true; } };

export const logFilters = writable<Readonly<Record<string, boolean>>>(Object.fromEntries(LOG_FILTERS.map((f) => [f.type, readBool(f.key)])));
export const logCount = writable<number>((() => { try { const v = Number(localStorage.getItem(key("logmessageamount"))); return LOG_COUNTS.includes(v) ? v : 100; } catch { return 100; } })());
export const gameLog = writable<readonly GameLogLine[]>([]);
let next = 1;
let pilot: { id: number; name: string } | null = null;
let startedAt = Date.now();
const captureLines: GameLogLine[] = [];

export function beginGameLog(id: number, name: string): void {
  pilot = { id, name };
  clearGameLog();
}

export function clearGameLog(): void {
  startedAt = Date.now();
  captureLines.length = 0;
  gameLog.set([]);
}

const twoDigits = (n: number) => String(n).padStart(2, "0");

export function formatLogTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(twoDigits).join(":");
}

function logDate(atMs: number): { date: string; time: string } {
  const date = new Date(atMs);
  return {
    date: [date.getFullYear(), twoDigits(date.getMonth() + 1), twoDigits(date.getDate())].join("."),
    time: formatLogTime(date),
  };
}

export function captureGameLog(labels: { title: string; listener: string; started: string }): { filename: string; text: string } {
  const { date, time } = logDate(startedAt);
  const divider = "-".repeat(60);
  const header = [divider, `  ${labels.title}`];
  if (pilot?.name) header.push(`  ${labels.listener}: ${pilot.name}`);
  header.push(`  ${labels.started}: ${date} ${time}`, divider);
  const lines = captureLines.map((line) => {
    const entry = logDate(line.atMs);
    return `[ ${entry.date} ${entry.time} ] (${line.type}) ${line.text}`;
  });
  return {
    filename: `${date.replaceAll(".", "")}_${time.replaceAll(":", "")}${pilot ? `_${pilot.id}` : ""}.txt`,
    text: `${header.join("\n")}\n\n${lines.join("\n")}${lines.length ? "\n" : ""}`,
  };
}

/** ShowMessage: the type's filter setting, or true where it has none. */
export function logShows(type: string): boolean {
  const filters = get(logFilters);
  return type in filters ? filters[type]! : true;
}

/** AddText writes to the session capture before applying the window's filter and retention limit. */
export function addGameLogLine(text: string, type: string | null): void {
  const msgtype = type || "notify";
  const line = { n: next++, atMs: Date.now(), type: msgtype, text };
  captureLines.push(line);
  if (!logShows(msgtype)) return;
  const max = get(logCount);
  gameLog.update((lines) => {
    const all = [...lines, line];
    return all.length > max * 2 ? all.slice(-max) : all;
  });
}

export function setLogFilter(type: string, on: boolean): void {
  const filter = LOG_FILTERS.find((f) => f.type === type);
  if (!filter) return;
  logFilters.update((filters) => ({ ...filters, [type]: on }));
  try { localStorage.setItem(key(filter.key), on ? "1" : "0"); } catch { /* not kept */ }
}

export function setLogCount(count: number): void {
  if (!LOG_COUNTS.includes(count)) return;
  logCount.set(count);
  try { localStorage.setItem(key("logmessageamount"), String(count)); } catch { /* not kept */ }
}

export function sortGameLogLines(
  lines: readonly GameLogLine[], column: number, reversed: boolean, labelOf: (type: string) => string,
): readonly GameLogLine[] {
  // Time has an explicit timestamp key in the native Scroll. Type and Message
  // use the same column and fallback comparisons as other Scroll entries.
  return sortScrollRows(lines, (line) => [line.atMs, labelOf(line.type), line.text].join("<t>"), column, reversed);
}

export function gameLogClipboard(
  lines: readonly GameLogLine[], selected: ReadonlySet<number>, labelOf: (type: string) => string,
): { text: string; count: number } {
  const selection = lines.filter((line) => selected.has(line.n));
  const copied = selection.length ? selection : lines;
  return {
    text: copied.map((line) => [formatLogTime(new Date(line.atMs)), labelOf(line.type), line.text].join("\t")).join("\n"),
    count: copied.length,
  };
}

/** dialog_handler: the dialog types the client logs. */
export const LOGGED_DIALOG_TYPES: ReadonlySet<string> = new Set(["hint", "notify", "warning", "question", "infomodal", "info"]);
