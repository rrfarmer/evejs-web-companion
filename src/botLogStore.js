"use strict";

// The bot flight recorder's storage: one log per CHARACTER, rotated when a run
// starts, so the current run and the two before it are always on disk.
//
// WHY PER CHARACTER. A character is what flies. The question an operator
// actually asks is "what did this pilot do", across whatever script happened to
// be running — not "what did script X do", which could be three pilots at once.
//
// WHY THREE. The question is nearly always "what happened in the run that just
// ended", and occasionally "the one before, which was fine". The companion's
// auto-restart begins a NEW run, so with only two files one restart erased the
// run that preceded it; a third keeps the run before the restart readable. More
// than that earns nothing and a directory that grows forever earns less than
// nothing. A run's `start` line is the rotation signal: current becomes
// previous, previous becomes previous2, previous2 is deleted, and the new run
// writes from an empty file.
//
// ⚠ THE RECORDER IS NEVER LOAD-BEARING. Every failure here — a full disk, a
// path that cannot be created, a file that will not open — is swallowed and
// counted. A ship must never stop because its diary could not be written. That
// is the same promise the runner makes on the other side of the wire
// (web/src/nav/botLog.ts, rule 4), and both halves have to keep it for it to
// mean anything.
//
// BOUNDED AT THE OLD END, NEVER THE NEW ONE.
//
// ⚠ THIS USED TO CAP THE RUN AND STOP WRITING, AND THAT COST A DIAGNOSIS.
// A five-pilot mining run filled its 5000 lines about four and a half hours in,
// wrote one "truncated" line, and recorded nothing for the SEVEN HOURS after —
// including the stop everyone later wanted to read about. The end of a run is
// the part an operator asks for; it was the one part the cap threw away.
//
// So the window rolls: lines always land, and once the file has drifted past
// its ceiling the OLDEST are dropped and a single head line says how many. The
// newest `maxLines` lines are what a reader gets, which is what "what just
// happened to this pilot" needs. A log that silently stops recording is worse
// than one that says it stopped — and a log that keeps the beginning of a
// twelve-hour run instead of its end is worse than both.
//
// THE REWRITE IS AMORTISED, not per line: the file is allowed to grow to twice
// the ceiling and is then compacted in one pass, so a bot mining all day pays
// for one read-and-rewrite every `maxLines` lines instead of one per tick.
// `read` caps what it hands back either way, so the slack is never visible.
//
// NOT A GAME ARTIFACT. These lines name ids on purpose (see botLog.ts): they
// are the operator's own diagnostic file, written under the BFF's data dir,
// never served into the game UI's player-facing copy and never committed.

const fs = require("fs");
const path = require("path");

/** How many of a run's newest lines are kept once it outgrows the file. */
const DEFAULT_MAX_LINES = 20000;

/** The head line that says how much of a run's beginning is gone. */
const TRIM_KIND = "trimmed";

function safeName(characterID) {
  const numeric = Number(characterID);
  return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : "";
}

function trimNotice(dropped, maxLines) {
  return { t: new Date().toISOString(), kind: TRIM_KIND, dropped, maxLines };
}

/** How many lines an already-trimmed log says it has lost, 0 when it has not. */
function droppedBefore(first) {
  if (!first || typeof first !== "object" || first.kind !== TRIM_KIND) {
    return 0;
  }
  const count = Number(first.dropped);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * @param {object} options
 * @param {string} options.dir        Where the logs live (created on demand).
 * @param {number} [options.maxLines] How many newest lines a run keeps.
 */
function createBotLogStore(options = {}) {
  const dir = String(options.dir || "");
  const maxLines = Number.isFinite(options.maxLines) && options.maxLines > 0
    ? Math.floor(options.maxLines)
    : DEFAULT_MAX_LINES;
  // Compact at twice the ceiling. See "amortised" in the header: the cost is
  // one rewrite per `maxLines` lines, and `read` hides the slack.
  const compactAt = maxLines * 2;

  // characterID -> lines in the CURRENT file, so the ceiling costs no read per
  // append. Seeded once per character from the file itself (`adoptCount`),
  // because a BFF restart mid-run must not lose count and let the file grow
  // without end.
  const written = new Map();
  // Failures are counted rather than thrown, and reported by `stats()` so a
  // recorder that has quietly stopped working is still discoverable.
  let dropped = 0;

  function currentPath(name) {
    return path.join(dir, `${name}.jsonl`);
  }

  function previousPath(name) {
    return path.join(dir, `${name}.prev.jsonl`);
  }

  function previous2Path(name) {
    return path.join(dir, `${name}.prev2.jsonl`);
  }

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** The file's lines, empties dropped. A file that will not read is empty. */
  function readLines(file) {
    try {
      if (!fs.existsSync(file)) {
        return [];
      }
      return fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
    } catch {
      return [];
    }
  }

  /** current -> previous -> previous2 (oldest deleted); the new run starts from nothing. */
  function rotate(name) {
    const current = currentPath(name);
    const previous = previousPath(name);
    const previous2 = previous2Path(name);
    try {
      if (fs.existsSync(current)) {
        // Only shift the older runs when there is a current run to take the
        // slot: a start with nothing on disk must not age the history.
        if (fs.existsSync(previous)) {
          fs.rmSync(previous2, { force: true });
          fs.renameSync(previous, previous2);
        }
        fs.rmSync(previous, { force: true });
        fs.renameSync(current, previous);
      }
    } catch {
      // A rotation that fails costs an OLD run's log, never the new one:
      // the append below truncates the current file either way.
    }
    written.set(name, 0);
  }

  /**
   * First append of this process for a character: count what is already there.
   * One read per character per process — the alternative is a restart resetting
   * the count to zero and the ceiling never being reached again.
   */
  function adoptCount(name) {
    if (!written.has(name)) {
      written.set(name, readLines(currentPath(name)).length);
    }
  }

  /**
   * Drop the oldest lines and leave a head line saying how many are gone.
   * Never throws and never reports failure: the lines it is trimming are
   * already safely appended, and a compaction that could not run just means the
   * file is over its ceiling until the next batch tries again.
   */
  function compact(name) {
    const current = currentPath(name);
    try {
      const lines = readLines(current);
      // A file that came back empty is a file that could not be READ, not a run
      // with nothing in it — this is only ever called with lines on disk.
      // Rewriting on that reading would destroy the log it is here to bound.
      if (lines.length <= maxLines) {
        written.set(name, lines.length);
        return;
      }
      let already = 0;
      let body = lines;
      try {
        already = droppedBefore(JSON.parse(lines[0]));
      } catch {
        already = 0;
      }
      if (already > 0) {
        body = lines.slice(1);
      }
      // One line of the budget belongs to the notice itself.
      const keep = body.slice(Math.max(0, body.length - (maxLines - 1)));
      const notice = JSON.stringify(trimNotice(already + (body.length - keep.length), maxLines));
      const staging = `${current}.compacting`;
      fs.writeFileSync(staging, [notice, ...keep].join("\n") + "\n", "utf8");
      fs.renameSync(staging, current);
      written.set(name, keep.length + 1);
    } catch {
      // Swallowed by the promise above. The count stays as it was, so the next
      // batch tries again rather than giving up on the ceiling for good.
    }
  }

  /**
   * Append lines for one character. A `start` line rotates first — that is the
   * whole rotation rule, and it lives here rather than in a route so a server
   * bot and a tab bot cannot disagree about when a run began.
   *
   * Answers how many lines were written; never throws.
   */
  function append(characterID, entries) {
    const name = safeName(characterID);
    if (!name || !Array.isArray(entries) || entries.length === 0) {
      return 0;
    }
    let text = "";
    let count = 0;
    try {
      ensureDir();
      adoptCount(name);
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object") {
          continue;
        }
        if (entry.kind === "start") {
          // Flush what this batch has so far into the OLD file before rotating,
          // or a batch that spans a restart would lose the end of the last run.
          if (text.length > 0) {
            fs.appendFileSync(currentPath(name), text, "utf8");
            text = "";
          }
          rotate(name);
        }
        text += `${JSON.stringify({ ...entry, characterID: Number(name) })}\n`;
        written.set(name, (written.get(name) ?? 0) + 1);
        count += 1;
      }
      if (text.length > 0) {
        fs.appendFileSync(currentPath(name), text, "utf8");
      }
    } catch {
      dropped += entries.length;
      return 0;
    }
    // AFTER the append, and outside its try: these lines are on disk, and a
    // compaction that fails must not be reported as lines lost.
    if ((written.get(name) ?? 0) >= compactAt) {
      compact(name);
    }
    return count;
  }

  /** The newest `maxLines` lines, with the head line saying what is missing. */
  function capped(lines) {
    if (lines.length <= maxLines) {
      return lines;
    }
    const already = droppedBefore(lines[0]);
    const body = already > 0 ? lines.slice(1) : lines;
    const keep = body.slice(Math.max(0, body.length - (maxLines - 1)));
    return [trimNotice(already + (body.length - keep.length), maxLines), ...keep];
  }

  /**
   * The lines of one character's current, previous or previous2 run — the newest
   * `maxLines` of them, oldest first, however far past that the file has drifted
   * since its last compaction. A missing file is an empty list — "this pilot has
   * not run a bot" is a real answer, not a failure.
   */
  function read(characterID, which = "current") {
    const name = safeName(characterID);
    if (!name) {
      return [];
    }
    const file =
      which === "previous"
        ? previousPath(name)
        : which === "previous2"
          ? previous2Path(name)
          : currentPath(name);
    return capped(
      readLines(file).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          // A half-written last line (a kill mid-append) is data too — say so
          // rather than dropping it silently.
          return { kind: "unreadable", raw: line.slice(0, 200) };
        }
      }),
    );
  }

  /** How many lines this process has failed to write. Zero on a healthy BFF. */
  function stats() {
    return { dropped };
  }

  return { append, read, stats };
}

module.exports = { createBotLogStore, DEFAULT_MAX_LINES, TRIM_KIND };
