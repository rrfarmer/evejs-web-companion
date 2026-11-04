"use strict";

// The web client's flight recorder (data/bot-logs/<characterID>.jsonl): one line per thing a bot
// decided, did or heard back. Lines of one run share `run`.

function newestRun(lines) {
  const last = [...lines].reverse().find((line) => line.run);
  return last ? last.run : null;
}

// A run is over when it ended, or when it paused: a paused hosted bot doesn't carry on by itself.
function runFinished(lines, run) {
  return lines.some((line) => line.run === run && (line.kind === "end" || (line.kind === "decide" && line.status === "paused")));
}

// One run's lines as timeline events: what it issued, what came back, each new phase, how it ended.
function botEvents(lines, run, characterID) {
  const events = [];
  let phase = null;
  for (const line of lines) {
    if (line.run !== run) continue;
    const base = { kind: "BOT", atMs: Date.parse(line.t) || undefined, characterID, run };
    if (line.kind === "issue") events.push({ ...base, what: "issue", says: line.says, phase: line.phase });
    else if (line.kind === "result") events.push({ ...base, what: "result", says: line.says, ok: line.ok !== false, reason: line.reason || line.error || undefined });
    else if (line.kind === "end") events.push({ ...base, what: "end", status: line.status, reason: line.reason });
    else if (line.kind === "decide" && line.status === "paused") events.push({ ...base, what: "end", status: "paused", reason: line.reason || line.why });
    else if (line.kind === "decide" && line.phase && line.phase !== phase && !/^Waiting between actions/.test(line.phase)) {
      phase = line.phase;
      events.push({ ...base, what: "phase", phase, status: line.status });
    }
  }
  return events;
}

module.exports = { botEvents, newestRun, runFinished };
