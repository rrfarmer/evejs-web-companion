# Loop: EVE in a web browser, on the retail client's protocol

This file is the standing brief for an unattended work loop. Start it with:

```text
/loop Read docs/goal-prompts/game-port-loop.md in evejs-web-poc and carry out the next iteration it describes. Commit as you go and push.
```

Each time the loop fires, read this file again, then the log, then do one iteration. Your context
will be summarised more than once before this is finished. The files named below are the memory,
not the conversation.

---

## What this is for

The operator wants **EVE Online in a web browser, with minimal graphics**: a client that talks to
the EveJS server the way the retail client (build 3396210) does, so that the server cannot tell the
two apart, and that does what the retail client does. They are away and have asked for this to be
worked until it is done.

The route is already planned and partly walked. Phases 0 to 2 are complete: there is a game-port
session that logs in and stays connected as the retail client does, and a measured answer to "can
the browser's decoders read what the game port sends". What remains is moving the pilot off the
web gateway and onto that session, giving it a ballpark in space, and then moving the client's
logic into the browser.

## Read these first, every iteration

| File | What it holds |
|---|---|
| `docs/game-port-loop-log.md` | **The loop's own journal. Its last entry says what to do next.** |
| `docs/game-port-transport-plan.md` | The plan, each phase's "done when", and each phase's status |
| `docs/game-port-client-reference.md` | What the retail client does on the connection, and where we match |
| `docs/game-port-parity-report.md` | Gateway against game port, read by read (generated) |

Then check the machine: `git status` in `evejs-web-poc` and in `eve.js`, and whether anything is
listening on 26000 and 26002. If a previous iteration was cut off with work uncommitted, finish it
or put it right before starting anything new.

## One iteration

1. **Pick the next unit** from the log's "Next", or failing that the earliest unfinished "done
   when" in the plan. A unit is something you can build, see working against the live server, and
   commit, in one sitting. If the next thing is bigger than that, the first unit is to split it.
2. **Find out what the retail client does** before writing anything (sources below). The standard
   is the retail client's behaviour, feature by feature: the same calls, the same arguments, the
   same order. "The server accepted it" is not the standard.
3. **Build it.**
4. **Prove it**, in this order: a test that you have watched fail; the whole suite; the real thing
   against the running server. A unit that touches what the browser shows is proven in the
   browser. Say what you saw, with the output.
5. **Commit it and push it.** Web changes in `evejs-web-poc`; server fixes are a separate matter
   (below).
6. **Write the log entry**: what was done, the evidence, the commit, any decision you took in the
   operator's place, and what is next. Update the plan's status when a phase's "done when" is met.
7. **Go straight on to the next unit.** There is nothing to wait for between units.

## Where the truth is

Consult in this order. When two disagree, a recording of the real thing settles it.

1. **The decompiled client**: `eve.js/tools/ClientCodeGrabber/Latest` (and `ClientCodeGrabberV2`).
   What the client does and when. Decompile more with those tools when a module is missing.
2. **CCP's own source, on this machine** under `C:\Users\ryanf\Documents\GitHub`:
   `destiny` (the ballpark simulation the client runs: `Ball.cpp`, `Ballpark.cpp`), `blue` (the
   marshaller, `src/Marshal.cpp`, and the Python runtime glue), `io` (socket I/O and compression),
   `core`, `fsd`, `trinity`. For anything in space, `destiny` is the specification: port it, do not
   approximate it.
3. **The client install**: `D:\EVE Online - 3396210 - Copy\tq`. Its `python27.dll` answers
   questions about Python itself (`scripts/py27-oracle.py`). Its other binaries can be decompiled
   when neither of the above answers.
4. **The EveJS server source**, `eve.js/server/src`: what the server accepts and sends.
5. **The server's logs**, `eve.js/_local/logs`: real client sessions by call name, handshake
   details, and `[PKT] ERR` lines, which are the only trace when a call answers None.
6. **Recordings of the retail client on Tranquility**: `D:\SSDSync\EveBadStuff\LOGS` (index in
   `LOG_MANIFEST.md`, missions under `Missions/`). The client's own log of sessions against CCP's
   server, every packet printed as a `MarshalStream` repr. This is what CCP's server really
   sends, and it settles what the decompiled client only implies: grep it for a call or a
   notification by name before calling anything EveJS does right or wrong, and before building
   from the decompiled source alone. **Search every folder of it** (`grep -rl`): most recordings
   are in subfolders, and one named for a mission may hold a fitting. On 2026-10-09 a search of
   the top folder alone missed the one recording of a module being fitted, which showed a call
   the reading of the code had missed. Reading the bytes:
   a dict entry's value is written BEFORE its key; `\x01` is None, `\x07` is -1, `/\x05`
   and five bytes is a long. An answer too large is not in a recording at all (it reads
   `LARGE PAYLOAD` and a size; a pilot's whole skill list is one): what a server sends there is
   then worked out, not read, and is written down so.

Tools already built for this: `scripts/recordings/` (read the Tranquility recordings: decode a
file's lines, list the calls made on a bound object and what answered each, tally what agents
offered, see `README.md` there), `scripts/capture-game-frames.js`
(record a conversation as a fixture), `scripts/record-game-port.js` (record any client),
`scripts/record-fleet-session.js` (two real sessions through a fleet's life, every notice and
answer each got: the pattern for a fixture that sets what a store keeps beside the server's own
later answer), `scripts/record-standings-session.js` and `scripts/record-skills-session.js` (one
session each, with a GM's changes: the same pattern for a store one pilot fills),
`scripts/record-journal-session.js` (a mission taken through its states by its agent's buttons,
the server's questions answered yes),
`scripts/login-calls-report.js` (a login read out of the server's own log, the
retail client's set beside the game port's: `docs/game-port-login-calls.md`; the logs of real
clients on this server are `eve.js/_local/logs/direct-tcp-real-client-*.stdout.log`, docked, and
`server.2026-10-06_15.log`, in space),
`scripts/parity-harness.js`,
`scripts/soak-game-session.js`, `scripts/py27-oracle.py` with `scripts/build-py27-fixture.js`,
`scripts/vendor-marshal.js`.

## What you may do

The operator has given the run of this machine for this work (2026-10-08):

- Start, stop and restart the EveJS server. Reset game data. Edit the database. Stage whatever a
  test needs. Use Docker if it helps.
- Read and decompile anything on the machine.
- Take the recommended path at a fork and carry on, recording the decision in the log.

Start the server detached so nothing waits on an approval: a PowerShell `Start-Process node` in
`eve.js/server` with `EVEJS_PROXY_LOCAL_INTERCEPT=1`, `EVEJS_LOCAL_DATABASE_ROOT` and
`EVEJS_GAMESTORE_DATA_DIR` set as `StartServer.bat` sets them. Stop it with `taskkill /PID` and
**no** `/F`, which lets it flush. Copy `gamestore.sqlite` aside before a reset you could not undo.

## When the server is wrong

A **server defect** is something the retail client would also suffer: a handler that returns what
the server cannot marshal, answers the wrong shape, or mishandles what the retail client sends.
The test is evidence that the retail client is affected (a log line, the decompiled client, CCP's
source). Something only the web gateway or the web client would want is not a defect; the web
client conforms to the server, not the other way round.

When you find one:

1. Write down the evidence and a way to reproduce it.
2. **Hand it to a sub-agent** to fix in `eve.js` and commit. Do not give the sub-agent its own
   worktree. Brief it with: the evidence, the files, how to reproduce, `eve.js/CLAUDE.md` (its
   rules bind the sub-agent: commit to `main`, stage own paths one by one, serial tests, one step
   per commit, no co-author line), and the instruction to change no more than the defect needs.
3. When it returns, read its diff yourself, restart the server, and re-run the check that failed.
4. Log the defect, the fix's commit, and the re-check.

One is already known and waiting: `corpRegistry.CanLeaveCurrentCorporation` returns a bare `{}`
the marshaller refuses, so every client gets None (plan, Phase 2).

## What you must not do

- **Push `evejs-web-poc` after each commit**: the operator started the loop with "commit as you go
  and push". **Do not push `eve.js`**: there the instruction was to commit the fix, its `main` is
  what other people pull, and its own rules say not to push unless the owner asks. List each
  server fix in the log. Know that a commit on that shared `main` does not stay local: on
  2026-10-08 something else on this machine pushed `main` with the loop's two fixes on it. So
  commit there only what you would be content to see published, and check
  `git log origin/main..main` in `eve.js` at the start of an iteration so the log says what is
  true.
- Never create a branch or a worktree, including by the way a sub-agent is launched. Never force
  a push or rewrite history. No co-author or "generated by" lines in a commit.
- **Never launch the retail client outside `Play.bat`.** Its checks keep the client from reaching
  CCP's servers. Do not take over the operator's screen to drive it.
- **One transport per character at a time.** A gateway session and a game-port session for the same
  character evict each other, and in space that is an emergency-warp logoff.
- **Other sessions share the `eve.js` checkout.** Changes there that are not yours are someone
  else's work in progress: do not stage, revert, stash or "fix" them. If they stop the server
  booting, work on what needs no server and look again next iteration.
- Do not edit `src/gameProtocol/*` by hand (`npm run vendor:marshal -- --write`), or generated
  reports and fixtures (run their scripts).
- Do not weaken a test to make it pass, or call something done that you have not seen work.

## Decisions the operator left open

Take these defaults, and list each under "For the operator" in the log so they can overrule it:

- **A BFF restart drops every game-port pilot at once.** Default: accept it, as the retail client
  closing would; make the BFF close sessions cleanly on shutdown.
- **The generic call path after the gateway's allowlist is gone.** Default: keep today's list of
  pairs as the BFF's own allowlist, and widen it only where a feature needs it.
- **Anything new.** Prefer the choice that is closest to what the retail client does and easiest to
  undo. If a choice is neither reversible nor clearly what the retail client does, do the other
  available work first and leave that one for the operator, with your recommendation.

## Things that have already cost time

- A call that answers None for no reason: look for `[PKT] ERR` in the server log.
- An integer above 32 bits must go out as a Python long (`src/gamePort/clientMarshal.js` does it).
  Passing a BigInt into a handler any other way breaks it.
- The gateway's session is not a retail session (different roles, an extra attribute). Do not
  treat the gateway's answer as the correct one when the two disagree; find out which is right.
- Large inline patches through a shell heredoc get mangled on this machine. Write the file with
  the file tools and run it.
- A file git has checked out on this machine ends its lines CRLF (`core.autocrlf` is on); one
  a tool has just written ends them LF. A patch script that looks for several lines at once
  stops matching after a `git checkout` of the file. Normalise to LF before matching and put
  the endings back; `scripts/break-and-check.js` does.
- `taskkill //PID n` works in this shell only while path conversion is on. With
  `MSYS_NO_PATHCONV=1` set (which the BFF helper scripts need for their `/api/...` arguments)
  it must be `taskkill /PID n`, and the wrong one fails quietly enough to leave the old
  process holding the port.
- A long foreground `sleep` is refused. Wait with a short loop on a condition, or in the
  background.
- **Start a check BFF with the launcher's output sent to a file, never through a pipe.** The
  launcher redirects the BFF's own output, which makes the BFF inherit the launcher's handles;
  with `powershell ... | tail`, the pipe stays open for as long as the BFF lives, the shell
  command never ends, and the harness keeps it as a running background task. On 2026-10-08 one
  such task was open when the iteration ended, and the wakeup scheduled for 09:53 had not fired
  at 10:32, when the operator asked why the loop had stopped. Use
  `powershell -File start-bff-check.ps1 ... > bffgp.start.log 2>&1 < /dev/null`. Before ending
  an iteration, make sure no command of yours is still running. The same holds for anything
  else started detached: on 2026-10-09 the recorder's launcher was piped to `tail` and the
  command sat for four minutes until its shells were stopped.
- **A constant written into the client's code can be read at run time**, where the client knows
  something from neither the server nor its data files. `python scripts/client-constants.py
  <client>\tq\bin64 <client>\tq\code.ccp <module ending .pyj> <name> ...` runs one module of the
  client's code in its own Python and prints the named values as JSON; the BFF reads a set the
  same way on first use (`src/clientData/clientConstants.js`, one entry in `CONSTANTS` each). The
  module that imports others is given those it uses while it runs (`--with
  dogma.const=dogma/const.pyj`, from the same archive, in the order they need each other) and has
  the ones it does not use stood in for (`--stub evetypes`); a name may be dotted, to reach
  through an import (`dogma.const.attributeCapacity`). Look for the table in the decompiled
  source first, then read it from the install: the numbers are not to be copied into this
  repository.
- **A set of hulls to measure against is one GM command away.** `POST /api/bridge/gm/slash` with
  `{"command": "/gmships", "confirm": true}` put 146 assembled ships of as many types in Test
  Two's hangar (2026-10-09), and reading each through both check BFFs set the client's way of
  knowing a thing beside the server's for eighty of them in two minutes. Put the store aside
  first and put it back after.
- **A route given to `scripts/bff-parity.js` on the command line is rewritten by the shell**
  (`/api/...` becomes a path under the Git folder). Put `MSYS_NO_PATHCONV=1` before the command.
  The same for a GM command given to a script (`/giveskill ...`), and then the script's own path
  has to be written `C:/...`.
- **What a BFF really puts on the wire can be read**, where the server's log says too little
  (it gives a call's service, method, argument count and `dst=node` or `dst=any`, and none of
  its keywords). Start `scripts/record-game-port.js record 26007 26000 <file outside the
  repository>` detached, start one more check BFF with `EVEJS_GAME_PORT=26007` in its
  environment, ask it what is wanted, stop both, and `describe` the file: each call with its
  address, its arguments and its keywords in the order sent. The order the client's own Python
  would give a call's keywords is asked of `scripts/py27-oracle.py`, which has builtins only
  (no `copy`, no `json`; `copy.copy` of a dict is `dict(d)`).
- **The browser pane is hidden, and a hidden page stops polling space**, so the autopilot and
  anything else that decides from the space feed does nothing there. Before selecting a pilot,
  tell the page it is visible: redefine `document.visibilityState` (to `"visible"`) and
  `document.hidden` (to `false`) in the page and dispatch a `visibilitychange` event. Do it again
  after every reload. Dispatch a click in one call and read the result in the next.
- **The server's log stamps an outgoing client call late.** `[PKT] OUT agents YesNo()
  client-call` carried the time the answer arrived, seconds after the question was on the page.
  Do not time the server by that line; time what the client saw.
- **The server's log is kept by the hour.** `server.log` has the hour now; the hours before are
  `server.<date>_<hour>.log` beside it. A check that straddles the hour is in two files, and a
  search of `server.log` alone finds a session with no login.
- **A breakage that was "not tried" proves nothing.** `scripts/break-and-check.js` says NOT TRIED
  when the text to find is not in the file, and a shell heredoc halves the backslashes in a list
  of them, so a regular expression is never found. Write breakage lists with the Write tool, and
  read the count: caught plus survived must equal the total.
- **The client's own text for a label**: `node scripts/client-words.js "<client folder>" <label>`
  says whether the client has it and which parameters it takes. Look there before wording a
  label or sending one's parameters; two guesses of mine on 2026-10-08 were wrong. The check
  BFFs get the client's folder through `EVEJS_CLIENT_ROOT`. Do not copy the client's text into
  the repository: fixtures use made-up text in the real shape. The shape includes the label's
  markup, which the tool names too (its tags and its entities): a fixture of mine with a space
  where the real label has `&nbsp;` passed every test and drew the entity on the page. The
  client's label parser is CCP's own and open (`trinity/trinity/Tr2LabelTextParser.cpp`).
- **An effect that sets something must not read it, and something forgotten must be asked for again by
  something that sees it go.** Two faults of 2026-10-09, both in a panel's `$effect`, both invisible to
  every test (a panel's tests render it once, on the server, where no effect runs): one read the state
  it had just set and stopped the panel ("effect_update_depth_exceeded"); the other asked for a thing
  once and never again after the store forgot it. Any unit that adds or changes an effect is looked at
  in the browser, through the change that makes it run again.
- **The test pilots are not alike, and a check on one says nothing of the other's case.** Test Two
  (account `test2`) is in a player's corporation (98000000); Test Pilot (account `test`, docked in
  Jita) is in an NPC one (1000044). Anything the client does by `idCheckers.IsNPC(session.corpid)`
  wants both looked at. Every pilot's corporation is in the store's `characters` table (`key`,
  `json`), which `node:sqlite` reads with `readOnly: true` while the server runs.
- **The page brings its pilots back by itself.** It keeps who was online in
  `sessionStorage['evejs-web-online-pilots:v1']` and signs them in again on a reload, so a
  `POST /api/logout` from a script does not leave the tab logged out: use the page's own "Log out"
  button, once for each pilot. Another pilot is brought on from "Pilots" (a row of the roster); the
  "Bringing pilots online" dialog stays up over the page until "Stay here" or "Go to first pilot" is
  clicked, and "in client" in it means the pilot is on. The pilot's button in the bar makes it the
  one the page shows.
- **A test that sends a pilot into space must bring it back, or the file never ends.** In
  `test/gamePortPilots.test.js` a session change that gives the pilot a solar system starts its space
  (timers and all); a test that leaves it there passes and then the file hangs, and so does the whole
  suite behind it. Move a pilot between stations to test what a move does. Run a file you have added
  to with a limit (`timeout 200 node --test --test-timeout=15000 <file>`), and check afterwards that no
  test process is left (`Get-CimInstance Win32_Process` for node with `--test`): one was, on 2026-10-09.
- **One test is slow by design, and a short limit cancels it.** `test/bridgeMining.test.js` has "a
  hull type reported for a different ship than the bound one is not trusted", which waits out a
  boarding that never settles: 45 seconds. Run with `--test-timeout=15000` it is cancelled, and
  a cancelled test is not counted as failed. Give that file `--test-timeout=60000`, and when
  reading a run's totals read `cancelled` beside `fail`.
- **A pass over an empty world proves little.** The Contracts route read "identical" on both
  transports through every parity pass while there were no contracts. With four staged
  between the two test pilots (`contracts-stage.js` in the scratchpad shows how: give items,
  `/api/bridge/contracts/create` and `accept` through the gateway BFF), a search differed and
  a server defect was behind it. Stage what a list route lists before trusting a pass of it.
- **What a pass of the parity tool reads when nothing is wrong** (since 2026-10-10, as Test Two,
  docked): 20 identical, 14 tolerated, nothing moved, nothing divergent, and the tool exits 0.
  (It was 21 and 13 until the colonies route was read as the client reads it: that row is
  tolerated now, for the time a colony is reckoned up to.)
  Anything else is news: read it. The count is that pilot's. As Test Pilot, who is in no
  alliance, two passes read 23 identical, 10 tolerated and 1 moved (2026-10-09, before that): the alliance's
  reads are refused alike on both transports, and `/api/bridge/flight/status` had a notice in
  the game port's answer both times. I took the other pilot's count for a fault and spent a
  while finding out it was not: say which pilot a pass was of.
- **What the parity tool calls moved is a reading, not a fact.** It prints a `moved?` line for
  each value it puts down to time passing between its two reads, with both values: read them.
  A clock is a clock, and the tool leaves the server's own (`serverNowMs`) and a search's own
  time (`searchTime`) out; a count of none against two is not. A read that takes what it reads
  (`skillHandler.GetSkillChangesForISIS`) reads "moved" for whichever transport asks second:
  run the pass again. And the first route of a pass, `/api/bridge/flight/status`, now and then
  reads "moved" with a count of notices: a notice that reached the game port's session at login
  (`OnModuleAttributeChanges`, seen 2026-10-09) goes out with the first answer.
- **Print the whole of a pass, and make the first pass after a restart one of the two.** A pass
  read "1 moved" straight after the game-port BFF was restarted, and I had printed its last
  line only. It was `searchTime`, which the tool was meant to leave out and did not: the
  server's answer keeps it as a dict's entry (`{type: "dict", entries: [...]}`), and the test
  that said it was left out had it as an object's own field, a shape no answer has. Send the
  tool's output to a file and `grep -vE "^(identical|tolerated) "` it. And take a fixture's
  shape from an answer printed off the running BFF, not from the path the tool prints.
- **The market.** Orders are kept by a daemon of its own (`externalservices/market-server`, ports
  40110 and 40111), not in the store: `store.sh` does not put them back, so take down what you
  placed. Its running binary knows the stations of its seed only. Test Two's station, 60000004,
  is not one ("station 60000004 does not exist in market database", told to the pilot as "Market
  is currently offline"); Test Pilot's, 60003760 at Jita, is. So a market check is as Test
  Pilot. In the page: MARKET, type in "Search for an item to trade", Search, the item's button,
  "Offer to buy…", the two number inputs and the select in `section.bulk`, "Check this order…",
  "Yes, place this buy order"; then "Your orders", "Take it down…", "Yes, take this order
  down". The pilot's "GO TO FIRST PILOT" dialog has to be answered first.
- **A plain object in a call's arguments cannot be put on the wire.** The gateway hands one on
  as it is, and the server's handlers read it. On the game port the call is refused before it
  is sent: "was given an argument that cannot be sent: Cannot marshal value". A sale and a
  saved fitting were both so, and nothing had tried either. `plain-args.js` in the scratchpad
  finds the calls that write one out; the routes that take one from the page's request are
  found with `grep -n 'typeof body\.[a-zA-Z]* === "object"' src/server.js`. Each needs the
  client's own form in the registry, and a try on the game port.
- **What the gateway shows may be what the game port cannot be sent.** The gateway prints a
  handler's answer without marshalling it. An answer the server cannot marshal (a number too
  big for its column, a bare object) reaches a game-port client as nothing at all, with a
  `[PKT] ERR` line in the server's log and no error to the caller. A pilot's launches were so
  from the first launch on. After any walk, look for those lines over the walk's minutes:
  `awk '/^\[<date>T<hh:m>/' server.log | grep -aE "\[PKT\] ERR|Cannot marshal|out of range"`.
- **A feature the page has is proven by using it in the page.** Three routes were mended and
  tried by script, with "not in the browser" written each time. The first of them used in the
  page, the Planetary Industry window's Haul, found a server fault and a call that was not the
  client's, neither of which any script of mine had reached. The steps, with the pane hidden:
  the window's Pilots tab, `#pi-add-choice` set to the pilot and Add; its Colonies tab,
  Refresh, the box `input.pi-haul-tick`, and "Haul 1 colony". The run is the BFF's own bot:
  its log is `bot-logs/<characterID>.jsonl` in the BFF's data folder (`botlog.js` in the
  scratchpad prints it), `/api/bots/active` says whether it still runs, and it must have
  ended before the store is put back. `haul-stage.sh` stages a colony's two pins with the
  server stopped, and `gm-run.js` gives the pilot the hauler (`/giveskill me 3340 1`,
  `/giveitem 655 1`).
- **Before writing that the client cannot do a thing, find every caller of what does it.** I
  wrote that the client makes a customs transfer "at the office". The one recording has the
  pilot there. The client's window has three callers, two of them from the planet's windows,
  and wants only that the office be in the ballpark. `grep -rn "<function>"` over the
  decompiled client, and read each caller, before a recording's one case becomes a rule.
- **The gateway answers before the game port does, after a restart.** `store.sh` and the
  staging scripts wait for the gateway. A select through the game-port BFF fifteen seconds
  after one answered 502, "the game server is unreachable"; eight seconds later it went
  through. Wait a little longer, or try again, before taking it for a fault.
- **A byte in a recording's marshal is an opcode before it is a number.** `` is the integer
  nought, `	` one, `` minus one, `` None, `$` an empty tuple, `,` a tuple of two,
  `/` a long with its length after it, `
` a float of eight bytes, `` a dict with its
  count after it (each entry its value first), `` a name out of the string table. A note
  beside one recording had `GetInventoryFromId(officeID, 8)` where the wire has nought. Read
  the bytes, not the note.
- **A pair added to the BFF's write list changes a generated file.** `node
  scripts/build-bridge-contract.js --write` rewrites `contracts/evejs-web-bridge-contract.json`,
  and a test holds the two together. Read the diff: it should be the pair and nothing else. A pair put on the page's own writes
  (`PAGE_WRITE_PAIR_KEYS`) changes it too: the manifest names those (`genericBridgeWrites`).
- **eve.js's tests run through its own runner**, from that repository's root:
  `npm run test:isolated -- server/tests/<file>.test.js`. A bare `node --test` of one refuses
  to open the store and reads as one failed test.
- **A pilot with no skills cannot show that a module fits.** Test Pilot has none: the server
  answers that the module failed to load, through either transport. Test Two has the skills
  for an afterburner and a mining laser.
- **The check BFFs since the default changed (2026-10-10):** `restart-bffgp.sh` starts the
  game-port one with nothing said (the bare default, every account on the game port), and
  `restart-bffgw.sh` starts the other with `-Transport gateway`. `start-bff-check.ps1` takes
  `-Transport` and `-Overrides`; each BFF's `<name>.out.log` has the "Pilot transport:" line
  it started with. Read that line before trusting which transport a check ran on.
- **`.env` and `.env.example` cannot be read or changed from here** (the permission is
  withheld, and that is deliberate). A setting that wants documenting goes in the README.
- **The Docker combination can be checked on this machine.** `docker build -t
  evejs-web-poc-check:e .`, then run it as `compose.yaml` does but under its own name and
  port (26512), with `--add-host host.docker.internal:host-gateway`, `EVEJS_GATEWAY_URL` at
  `host.docker.internal:26002` and the eve.js checkout mounted read-only at `/srv/evejs`;
  `docker exec <name> node scripts/doctor.js` is the first thing to read. Remove the
  container (`docker rm -f -v`) and the image after. The operator's own image
  (`evejs-web-poc-local`) and volume (`evejs-web-poc-data`) are not to be touched.
- **A fleet with a second pilot handed to the host as a companion:** `companion-walk.mjs <repo>
  <bff> <commander account> <id> <companion account> <id> <out.json>` (the page's own setup
  and grant; Test Pilot and Test Three are both docked at Jita). As of 2026-10-10 the start
  is refused on both transports ("Join a fleet first"), so it gets no further than that.
- **Read the tally after every live run, whatever the run was for.** The companion's run
  failed at its start and still showed a read of an online pilot that no earlier walk had
  made: a start asked by the session that holds the pilot. `ledger-show.js
  <bff>-data/gateway-ledger.json` takes a second.
- **A read made of the account is measured twice: with nobody flying the pilot, and with the
  pilot flown in another web session of the same BFF.** Only the second shows a read of an
  online pilot in the tally. `training-walk.js <scratch> <bff> <account> <id> <out.json>` does
  both for Pilot Training's reads and prints a digest of each answer; `roster-flown.js` reads
  the hangar's roster rows with one pilot flown.
- **A site for a check:** `sites-scan.js <eve.js root> <first systemID> <count>` asks the
  server's own generator which systems have an ice site (run it from `eve.js/server`);
  `/solar <system name>` through the GM route moves an undocked pilot there; and
  `ice-walk.js <scratch> <bff> <account> <id> <out.json> <system>` reads the scanner's sites
  (`/api/bridge/bound-small-services`, `GetFullState`), warps to the ice one and then an ore
  one by label (`/api/bridge/flight/warp-scan`), and prints each grid's rows by shape.
  Halaima (30002781) has an ice site.
- **What the server's code calls a thing is not what a row calls it.** The site service
  makes an ice chunk with the kind "iceChunk"; the gateway's row for it says "asteroid". Read
  the row.
- **Two ways of asking one thing are set side by side for every case before one replaces the
  other.** `owner-compare.js <repo> <account>...` did it for whose a character is (the
  snapshot's row against the account's list, for each character of the server's), and it
  also showed the one place they differ: what is said of a character that is not the
  account's. `owner-live.js` asks the routes that check it, with the pilot flown elsewhere.
- **The brief's whole run, by the page's own buttons** (it passed twice on 2026-10-10; the
  log's entry has the steps). What made it quick the second time: one call that reads the
  docked windows by title (`.win-body`, the title in its parent; the inventory is not a
  window but `section.stn-view`); one that presses "Start Conversation with …", "Accept",
  "Load package into ship" and "Set autopilot to dropoff" in turn (the last undocks and
  starts the route by itself); a poll of the Travel window's STATE until the header says
  DOCKED; "Complete Mission"; then undock, the module by pointer events, a sentry gun's row
  and LOCK (`.target-card` loses `acquiring` when it has locked, some twenty seconds),
  the station's row and DOCK, and "Log out". `ab-stage.js` fits the afterburner Test Two's
  Badger needs for it.
- **A test that waits on a socket bounds its wait.** A `node --test` that never ends is moved
  to the background and stays there; mine did, twice. Give every wait a deadline, run a new
  socket test under `--test-timeout` the first time, and if one is left running stop it by
  its own command line (`Get-CimInstance Win32_Process` filtered on the test file's name),
  never by killing every `node`: the server and both BFFs are `node` too.
- **A request made in process** (`dispatchInProcess`, `src/pilotSocket.js`) wants a real
  stream where its connection would be, one that says it is readable, and `complete` set:
  the body parser skips a request it takes for finished, and Node takes an incomplete one
  for cut off. `socket-walk.js <repo> <bff> <account> <id>` asks a running BFF over a real
  socket and sets each read beside the same over HTTP.
- **The page is on the socket unless told otherwise** (since 2026-10-10). For a check over
  HTTP: in the page, `localStorage.setItem("evejs-web-transport:v1", "http")` and reload
  (take it off again after, and say so; a browser left on `http` is not the default). To
  see what goes which way from a script in the page: wrap `WebSocket.prototype.send` to count
  frames before choosing a pilot, and read `performance.getEntriesByType("resource")` for
  what went over HTTP. The first run of a thing in the browser is where its faults are: the
  socket's tests all passed while ten sockets stood open on the page.
- **A route moved into the page (Phase 6b), as the wallet was:** find what the client's own
  service asks and keeps (the recordings, then its code); write that asking once under
  `web/src/bridge/`, each call by `api.bridgeAsk(callOptions)`; have the flow use it and
  leave the route standing; answer the flow's tests call by call from the same things
  described; and set the route beside the page's own asking, live, on both transports, for
  pilots of more than one corporation (`wallet-compare.mjs <repo> <scratch> <bff> <account>
  <characterID>` is the pattern: it imports the page's TypeScript and asks through
  `/api/bridge/call`). Reading the client for a route is where the route's own faults show:
  the wallet's divisions had the hangar's names.
- **Size a route before it is named next.** A handler's length is not its size: the skills'
  is eleven lines, and its answer is made by 155 more from kept reads, static data and the
  server's clock. Read what the answer is made from, then ask each read by name through
  `POST /api/bridge/call` as a pilot (`skills-probe.js <scratch> <bff> <account>
  <characterID>` is the pattern): a call no list carries answers 403 `CALL_NOT_ALLOWED`, and
  then the game port's own list (`GAME_PORT_ONLY_CALLS`) is where it goes, the gateway's
  being `eve.js`'s. What a unit needs of the BFF first is a unit of its own.
  `routes-survey.js <repo> [list]` counts the routes the page still names.
- **The page's clock** is `serverNowMs` on a pilot's answer of the generic call: on the game
  port the server's clock as the pilot's session has it, through the gateway the BFF's
  own. A route that put a time beside its answer is moved by reading the clock the
  call's own answer has just said (`serverNow()` in `web/src/app/flow.ts`).
- **Run the whole suite before calling a unit's tests done.** A test elsewhere may list what
  a flow asks at some moment (`web/src/app/flow.test.ts` lists every generic call made at
  the choosing of a pilot), and a read moved to the page's own call is one more in it.
- **Something the BFF makes, made again in the page's TypeScript, is proved by making both
  from one kept state** at every point of a recorded session
  (`test/gamePortSkillSheet.test.js`): the BFF's given the state as it came off the wire,
  the page's given each read through `wireToBridgeJson`. What cannot come off the wire as
  such cannot be written there, and is tested in the page's own test, where its form can.
  Then live, leaf by leaf: `skills-compare.mjs <repo> <scratch> <bff> <account> <characterID>
  [typeID toLevel]`. The clock's leaf differs, being read at two moments.
- **The page's writes by kind are in `writes-survey.js <repo> all`.** Of 89, seven are a
  confirmation and one call by name; most of the rest are calls on an object the BFF binds.
  Size a write there before naming it next.
- **A write the pilot's transport does not carry answers false, and the flow asks the route**,
  as a read not carried answers null (`saveQueue`, `readSkillSheet`). A refusal by
  `CALL_NOT_ALLOWED` means nothing was made, so asking the route after it is safe; no other
  failure is taken so.
- **A flag that says "for the corporation" is read in the server before the write is moved.**
  `AcceptContract`'s `forCorp` was taken from any member (fixed in eve.js `378ef753f`). Look
  for the role's check on the path the flag takes, not only for a check of the ID; the
  client's own gate (a button shown by `session.corprole`) says which role.
- **A handler that hands a store the session's character is read for what the store does with
  nought.** Nothing between a socket and a service asks whether a character is chosen: an
  account at its selection screen has none, and a store that reads nought as "no filter"
  serves it everyone's (`DeleteLaunch`, fixed in eve.js `ccf788b7b`). The BFF lets no such
  call through; a raw session for seeing one live is `nochar-launch.js`.
- **A server defect goes to a sub-agent with the reading, the client's file and line, the
  test wanted first, and the checkout's rules** (no branch, no worktree, no push, the other
  sessions' files by name). Then read its diff, run its test file through that repository's
  runner, and see the fix live: `store.sh save` restarts EveJS on the new code. Do not stage
  the live store while its tests run. Continue the same sub-agent (`SendMessage`) for what it
  reports beside.
- **The store keeps each child of a map in a row of its own**, keyed by the map's name, the
  unit separator (U+001F) and the child's key (`launchesByID\u001f910000001`). A printed key
  does not show the separator, and a row staged without it is not read by the server
  (`launch-store.js`, `colony-store.js`).
- **A write only a bot makes is tested through the flow first**: a one-block bot started over
  a stand-in BFF, and what it asks read in order (`web/src/app/launchCollectorFlow.test.ts`).
  Live, the thing the bot acts on is made real (`colony-store.js` puts goods in a command
  centre in a copy of the store; `launch-real.js` launches them and saves the one-block bot),
  and the bot is started from the Bot Manager's Pilots tab, the pilot in space.
- **"Run here" asks through the browser's `confirm`**, which the hidden pane answers "no" with
  nothing shown: the row stays at "Nothing is running". Set `window.confirm` in the page to
  keep its text and answer true before pressing, and write down what it asked.
- **A fleet for a check is made by script through the gateway BFF**: `fleet/create`, then
  `fleet/advert/add` with `{ fleetName, inviteScope: 16, joinNeedsApproval }` (a plain object
  goes through the gateway and not the game port). Test Pilot and Test Three are docked
  together at Jita on two accounts. `fleet-writes-live.js <boss bff> <member bff> ...` sets the
  two writes side by side.
- **A boss is kept in one script while the browser is driven** (`scram-boss.js`): it does a
  step, then waits for a word left as a file in the scratch folder. Run it in the background
  with its output in a file, and see it ended before the iteration is. `/ewar` by `gm/slash`
  gives the caller a ship with a scrambler, a disruptor, a web and a painter fitted; a ship
  that has attacked cannot dock for a while.
- **A companion is started from the Companions window**: type the fleet's name, add the
  pilot. It applies, accepts, undocks and follows a member who is no companion, by itself.
  Afterwards: Stop all, Remove, and empty the name.
- **What the page is answered on its socket can be read**: in the wrapper of
  `WebSocket.prototype.send`, add a `message` listener to each socket once. A pilot's ship is
  in the answers to `flight/status`; a pushed notice is found by its method's name.
- **The named routes are counted with `routes-exact.js`**, by the whole path.
  `routes-survey.js` took a path's beginning for a path and missed a parameter inside one.
- **A test that starts a companion or a bot stops it in a `finally`.** One left flying after a
  failed assertion keeps its file's process from ending, and the run waits on it for ever.
- **A scratch name is checked by itself** (a count over three names says nothing of which
  one is there), **and a script is written with the Write tool**: a heredoc or `node -e` in
  the shell loses backslashes and quotes.
- **A write the BFF made on an object it bound for itself is asked by the service's name.**
  Where the client asks the service on a moniker (`MONIKER_SERVICES`), the game port makes a
  call asked by name on the moniker it keeps, and counts it `reshaped` whatever its arguments.
  The gateway makes it as it is asked. The entry's judge is handed what godma knows through
  the transport's context (`contextFor` in `pilots.js`), and `needing(entry, "dogma")` has
  godma primed first.
- **What the client knows from its static data, the page asks of the BFF's**, once, and
  keeps: a route under `/api/types/`, no call of the server's (`overload-effects`,
  `cycle-times`). A helper for it goes in `staticData.js` with a fixture of the table for
  its test (`test/typeOverloadEffects.test.js`).
- **A pilot ready to use its modules**: `/ewar` and `/giveskill me <typeID> <level>` by
  `gm/slash` (`overload-stage.js`). A module on the rack is held by a `pointerdown`, a wait
  past 600 ms, and a `pointerup`.
- **What the client does by itself after a call belongs to the call's unit.** Read past the
  call for the threads it starts and for its session-change hooks (`RepairModule_thread`,
  `ProcessSessionChange`), and read the server for when the thing asked for is done: it may
  wait on a second call the client makes unasked, as a repair's mending waits on
  `StopModuleRepair`.
- **A hull a slash command boards is not what the BFF's "hold" means** until the pilot is
  chosen afresh: the BFF holds the ship it last boarded by its own route. Give the ship in one
  web session, log out, and go on in another (`repair-live.js`).
- **Damaged modules for a check**: overload the drive and run it, and within two minutes
  several modules of its rack read 16% damaged. Paste is `/giveitem 28668 200` into the
  hangar and the transfer route into the hold. `repair-live.js <bff> <account> <characterID>
  compare|stage`: `stage` leaves the pilot in space for the browser.
- **After a drive's run the pilot is far from its station.** Dock from the header then takes
  minutes; where the BFF is restarted and the store put back next, do not wait on it to log
  the page out by its button, and say that it was left.
- **What the client does with a call's answer is the transport's to do on every path the
  call can take.** The game port set its banks after a grouping asked on a handle (the
  routes' way) and not after one asked by name (the page's): the first live run of the page's
  write showed the ship's old banks. When a call moves from a route to the page's asking, find
  what the game port does after the route's call (`afterGroupingCall` and its fellows at the
  end of `callBoundMethod`) and see that the by-name path does it too, with a test.
- **A handler that takes whose thing to act on from its caller is a defect of the server**, to
  be fixed there before the page names the thing, and seen live after. A route of the BFF's
  that names the thing itself hides it (the weapon banks, and `docs/arg-injection-leak-handoff.md`
  for the ones written down earlier: read it for the pair in hand).
- **A ship with weapons to group**: `/probe2` by `gm/slash` gives a hull with three guns of
  one kind, and no ammunition. `banks-live.js <bff> <account> <characterID> <other bff>
  <other account> <other characterID>` flies two of them and names one's ship from the other.
- **While a sub-agent mends the server the live store is not staged**, and it may be forty
  minutes. Do what needs no live store in that time, in the turn: the page's tests, the
  breakage pass, the whole suite, the live script, a flow test for each asker of the call
  that has none, and the reading and sizing of the units after. Look at `eve.js` (`git
  status`, `git log origin/main..main`) for how far it has got; do not ask it.
- **Count before writing a count.** `loadammo-shapes.js <recordings>` reads every recorded
  call of one name off the bytes the transport logged, however it was sent (riding a bind,
  or on the bound object), and says how many are of the shape expected.
- **Ammunition for a check**: `/giveitem 230 2000` gives a medium hybrid charge, which
  `/probe2`'s guns take, to the hangar; the transfer route moves a stack into the hold;
  given again, there is a stack in each. `ammo-live.js <bff> <account> <characterID>
  <other bff> <other account> <other characterID> [stage]`: `stage` leaves the pilot docked
  in the ship with its charges, for the browser.
- **In the browser**: the fitting window's slots are `button.fit-socket` (their
  `aria-label` names the slot and the module) and a chosen slot's ammunition is `.fit-ammo`.
  The rack's menu opens on a `contextmenu` event on a `.module-slot.filled` and is
  `.rack-menu`; "Reload all" is a button of `.rack-ammo`. Two windows can be `.win.focused`
  at once: find a window by its heading.
- **A boss for a companion's run goes on the gateway's BFF** (`scram-boss.js`): its advert is
  a plain object, which the game port cannot send. The companion's pilot must be online in
  the tab before the Companions window can add it; the fleet's name is typed into
  `#companion-op-fleet`; the pilot's row reads Running once it has joined. A plain `fetch`
  from the tab is refused (401): the page's own reads go by its socket.
- **When a loop of the page's does nothing, read its own readout first.** A companion's is
  in the page (`FleetCompanion.svelte`): its phase in a `<strong>` and its reason in a
  `p.note` that begins "Why:". Then take the reads it makes off the socket (a `message`
  listener on the socket, each answer matched to its request by the `id`), and then look at
  what it works out once at its start. A companion's module lists are read off the hull at
  the start with the dogma loaded (`resolveDefenseModuleIDs`).
- **A flow test that leaves a read unanswered proves nothing of what is worked out from
  it.** A check with a "not known" answer keeps what it cannot judge, so the test passes
  whatever the rule is. Give the test the answer the live read gives: for a module's dogma,
  the attributes a module of that kind has (`effect-durations.js <repo> [typeID...]` says
  which attribute an effect names as its duration, and what a type carries).
- **A call in the tab is given up after 45 seconds**, and the script goes on. Wait on a dock
  in calls of half a minute, and read the page again before pressing anything.
- **Before a test is made to fail, see that it ends.** A test that starts a companion or a
  bot and stops it after its assertions leaves it flying when an assertion fails, and the
  run never ends. Look at every test the change will fail on the old code, put each stop in
  a `finally`, and run old-code checks with `--test-timeout=60000`. A run that hangs all the
  same is stopped by the one child's own command line.
- **A call the client makes on its ballpark** (`bp = michelle.GetRemotePark()`), asked by
  name: add its name to `ON_THE_PARK` (`src/gamePort/retailCalls.js`), and the transport
  makes it on the park's own object (`parkCall`) and refuses it for a pilot with no park.
  Look at what the handle's path does after such a call (`afterMovementCall`) and whether
  it belongs to this one.
- **A fleet for a check without an advert**: the boss forms it, invites the other by
  `fleet/invite` (`inviteeCharID`), and the other accepts by `fleet/invite/accept` with the
  fleet's ID from the boss's `bound-fleet` read (`tag-live.js`). What a fleet's tags are is in
  the last `OnFleetStateChange` among the notices that come with a pilot's answers.
- **A companion that is to tag**: `tag-boss.js` on the gateway's BFF (words `boss.lead` with
  the companion pilot's character ID, `boss.undock`, `boss.go` with the companion's ship,
  `boss.end`). It sets a tag, hands the fleet to the companion's pilot, undocks and
  scrambles it; the tab then tags the scrambler's ship.
- **A service the client asks on a Moniker it makes for each call** (`eveMoniker.GetEntityAccess`
  for the drones, as crimewatch's): it goes in `MONIKER_SERVICES`, `madeAfresh` and, where
  the session may lack what the Moniker is for, `MONIKER_NEEDS` (`src/gamePort/retailCalls.js`);
  what it is bound by is `monikerParams` (`pilots.js`). The recordings say which a service
  is: count the binds that carry a call (`service::MachoBindObject args=(..., ('Method', ...`)
  against the same method sent on an object (the transport's `Write:` lines).
- **Look for a name in `retailCalls.js` before adding it.** A constant named twice is no
  program, and every test file that loads the ledger then fails to load.
- **Drones for a check**: `salvage-live.js <bff> <account> <characterID>` gives the prepared
  ship, the skills (3436 to 5, 24241 and 3440 to 1), two light drones (2454) and two salvage
  drones (32787), and moves them to the bay (`to: { kind: "shipBay", bay: "drone" }`).
  `/probe2`'s bay already holds five light and five medium drones, and five go out at once:
  launch the stack wanted by itself, as the drones window does. The window's rows have a
  Launch each; "Bring them all home" is the recall.
- **Wrecks for a check are made, not fought for**: `/wreck <n>` in space makes n wrecks of
  the pilot's own within 20 km (`dsalv-live.js <bff> <account> <characterID> [stage]` does the
  whole of a salvage). `/npc 1` draws any hull: one draw was a frigate, the next a battleship
  five light drones did not kill in four minutes. A hostile in the snapshot is `kind: "ship"`
  with `npcEntityType: "npc"`.
- **A warp is over when the place is near and the ship is slow**, not when the sentry guns are
  gone from the snapshot: eight are in it at Jita VI's warp-in, the nearest 2,699 km off
  (`warp-probe.js <bff> <account> <characterID> [planetID]` prints the lot).
- **When a window says what the server does not, record the page's own reads with their
  answers before naming a cause** (in the tab: keep each request's ID as it is sent, and the
  answer that comes with that ID). Twice in one unit a true measurement was called the cause
  too soon: the notice the page did not hear was real, and the answer it then read was wrong
  as well. And give a recorder ONE listener per socket: the page's sends come on more than
  one, and a listener added at each change of socket counts every line many times.
- **One item's move is `OnItemChange`, several are `OnItemsChanged`**: the item as it now is
  (`fields`), and what it was by column (3 where, 4 which flag). A listing of a bay is itself
  answered with one for each stack, nothing changed, the first time after a change.
- **A call the client makes on an object for a thing it names** (`eveMoniker.GetPlanet(planetID)`,
  an agent's, a character's): the page's call says which with `of` (the fifth argument of
  `Ask`), and the BFF makes it on the object bound for that, by the bind the call's route
  used. To move another: one line in `PAGE_OBJECT_CALLS` (`src/bridgeCallPolicy.js`), and,
  for a kind of thing that is no planet, its check and its bind in the generic call's
  handler (`src/server.js`, `objectKind`). A read is listed only with its handler read
  first: the planet's reads once took an owner from the caller.
- **A name found in the recordings' folders is not yet a recording of it.** `grep -rla` counts
  the notes kept beside the recordings (`.md`) with them. `LeaveShip` was "in one recording"
  for two entries of the Next list: the file was a note saying the recorded flow ejects.
  Open what is found.
- **What a route keeps of the BFF's own goes with its call.** Leaving the ship's route set the
  BFF's word for the pilot's ship and held the next swap back; the generic call does the same
  for a pair listed in `PAGE_SHIP_SWAP_CALLS` (`src/bridgeCallPolicy.js`), by the route's own
  function. Read a route for such a thing before calling its write short.
  `ls-live.js <bff> <account> <characterID>` leaves a docked pilot's ship and boards it again.
- **A stand-in BFF's bare `{ ok: true }` is no answer to the page's own call.** A flow's test
  whose write moves to the generic call needs its stand-in to answer `/api/bridge/call` with
  the call's service and method, or the page takes the call for failed (as it should) and
  the test fails for a reason that is not its subject. The whole suite finds these: the
  unit's own files do not.
- **What a panel goes by after a write is seen in the tab.** The corvette's button goes by
  the flight in the page's store. Its test put a flight there and rendered, and passed; in
  the tab nothing put a new one there after the swap, and the button stayed in use. While
  docked nothing reads the pilot's flight again but a swap of the ship
  (`refreshActiveShipViews`). Before calling a panel's state done, find what writes the part
  of the store it reads, and press the button in the tab twice.
- **The page words the server's refusals from a table** (`web/src/bridge/refusals.ts`, its
  keys pinned by a test). A write whose handler refuses by a bare key wants that key there,
  or the pilot reads that it was turned down without a reason. Read the handler's refusals
  when reading what it trusts.
- **In the tab a wrapped `fetch` sees nothing once a pilot is chosen**: the page's requests
  go over the pilot's socket, and `read_network_requests` does not list them either. To read
  what a press sent, wrap `JSON.stringify` and keep what has the call's `service` and
  `method` (the answer passes through it too), or wrap `WebSocket.prototype.send`. Put
  `JSON.stringify` back after. The BFF's ledger counts the calls whatever the recorder saw.
- **A pilot is opened in the tab with one click of its row after a fresh load**, then "Go to
  first pilot". Two clicks in quick succession left no pilot in the client.
  `bc-live.js <bff> <account> <characterID>` boards a corvette, asks for a second from
  aboard it, and boards the first ship again.
- **A handler is read for where it acts, as well as for what it takes.** The office's rent
  took nothing of the caller's, and acted wherever the session was: asked by name from
  space, that was the solar system, and the server rented an office there. Its route's
  check that the pilot was docked was all that kept the page from it. Before a write goes
  on the page's list, measure it from where a client cannot make it (in space for a docked
  call, docked for one in space, by name for one on an object): `rof-live.js <bff> <account>
  <characterID> space` does for the office. What it shows is the server's to mend, by a
  sub-agent, and is measured again on the mended server.
- **A panel says a refused call by its reason only since `45ad44d`.** The panels word a
  caught error with `panelErrorWords`, which worded its code; a server's refusal comes in
  the envelope `CALL_REFUSED`, whose reason is its message. A flow's test that reads the
  error's message, or the store's `actionError`, does not go that way: test what the panel
  itself says (`panelErrorWords(caught)`), with the refusal as the BFF was measured to
  hand it on, and see it in the tab.
- **A value the server handed over goes back as it came.** The rent goes with the price the
  station quoted, a long as a long (Tranquility's was one), not with the number shown.
- **Test Three is its corporation's chief executive** (98000000, an office in Jita 4-4,
  nothing in its wallet). `give-cash.js <scratch> <bff> test2 140000003 98000000 30000`
  gives it three rents; `rof-look.js` reads its offices and the price and writes nothing;
  `rof-live.js` gives the office up and rents it. Each between `store.sh save` and
  `restore`.
- **While a sub-agent works in `eve.js`, the turn is kept and the live store left alone.**
  Put the store back before it starts (its tests copy it). Then do what touches neither:
  commit, the old-sources check, the log. Look for its commit with a wait in the same
  command (`node -e "setTimeout(()=>{}, 240000)"; git log --oneline -1`), read its diff
  when it is in, restart EveJS on it, and measure again.
- **What a route says beside its answer goes with the call too, or the page finds it for
  itself.** The scanner's route said the BFF's word for the pilot's system with the sites,
  and the page went by it. The page's own call has only the answer; the client pairs it
  with its own session's system, read before it asks, and so does the page now. Read a
  route's whole answer, and every use the flow makes of each part, before calling it one
  call.
- **A call on an object the session has one of names none** (`PAGE_OBJECT_CALLS`, a kind
  that is not in `OBJECTS_THE_PAGE_NAMES`): the BFF asks the object it keeps for the pilot.
  The system's scan manager is the first. `sfs-look.js <bff> <account> <characterID>` asks
  the sites so and writes nothing. GM Elysian's system, Maurasi, has six anomalies and
  seven signatures; Jita has none.
- **The Bot Manager's "Run here" asks with the browser's own box**, as the Station panel's
  corvette does. In the tab, put `window.confirm = () => true` first, or nothing starts and
  nothing says why. A bot's own log is in `bffgp-data/bot-logs/<characterID>.jsonl`. A bot
  flies no script for a pilot in a capsule: it looks once and stops.
- **A patch that rewrites a whole test file counts first**, the tests and a name that is in
  every one, and stops where the count is not what was read. It did this time.
- **"One call by name" is read off the route, not off its length.** `routes-calls.js` showed
  `fleet/leave` as 28 lines and one call. It is two calls, chosen by what the transport
  says the pilot holds, and a state of the BFF's dropped after. Read the route's body
  before naming it short.
- **A stand-in whose usual answer is a default argument cannot be told to answer nothing.**
  `harness(undefined)` answers as usual. A row for an answer of nothing answers it in the
  row. The test failed on the code, which is how it was found.
- **A proof that changes nothing needs no copy of the store.** `/help` and the bare stroke
  proved the console's call on both transports and in the tab. `gms-live.js <bff> <account>
  <characterID>` runs them; `gms-help.js <bff> <bff> <account> <characterID>` says how the
  two transports' replies differ.
- **A route's call is not the client's until the client's caller is read.** The repair's
  route sent `repairSvc.RepairItems(itemIDs, None)` by name. The client reaches that
  service only on a Moniker it makes for each call, and sends `RepairItemsInStation` with
  a payment. Search the decompiled client for how it reaches the SERVICE
  (`RemoteSvc('<service>')`, `Moniker('<service>'`, a function of `eveMoniker.py`) before
  reading the route. A service reached only by Moniker wants a line in `MONIKER_SERVICES`,
  its parameters in `monikerParams` (`pilots.js`), and `madeAfresh` where the client
  keeps none.
- **The gateway's list may have a write under another name, or not at all.** Ask what the
  way back does with the client's name before moving a write to it
  (`evejsWebGatewayRuntime.js`, the allowlist). `gatewaysNameFor` (`bridgeCallPolicy.js`)
  names the one the gateway has for the same thing; the answer is still the call that
  was asked.
- **`/dmg medium`, sent from the page's console or by `slash.SlashCmd`, damages the active
  ship and one fitted module where it is docked**; `/heal` mends it. `rps-live.js <bff>
  <account> <characterID> [space] [<other account> <other characterID>]` damages, quotes,
  repairs and reads the wallet; with `space` it then asks from space; with another pilot
  it asks a quote for that pilot's ship. Test Pilot's Reaper costs 615.41 ISK after it.
- **A stand-in that says only the names of what was asked cannot say what a call went
  with.** The fleet's test helper logged `service.method`; a forced leaving sent with the
  page's arguments passed it. Where a breakage of what a call carries is not caught, look
  at what the stand-in keeps before adding a row.
- **A choice the route made by what the pilot's connection holds stays the BFF's.** The
  page asks the client's first call; the BFF makes it, or the one the client makes in
  its place, by the route's own function, and answers as the call that was asked
  (`leaveFleetCall`). `flv-live.js <bff> <account> <characterID>` forms a fleet and
  leaves it; the Fleet window's "Form fleet" and "Leave fleet" each ask with the
  browser's own box.
- **A command centre launches once a minute.** A launch inside the minute after another is
  refused (`CannotLaunchCommandPinNotReady`), whatever else is wrong with it: a check on two
  transports waits the minute out between them (`node -e "setTimeout(()=>{}, 25000)"` in
  the same command; a bare `sleep` is not for this). `cc-goods.sh '<launchpad JSON>'
  '<command centre JSON>'` puts goods on Test Two's colony with EveJS stopped, and
  `la-live.js <bff> <account> <characterID> <planetID>` launches ten and tries the refusals.
  A bot's block with settings is saved with them: `bot-save.js <bff> <account>
  launch-commodities <name> '{"anyAmount":{"kind":"toggle","enabled":true}}'`.
- **A check in a patch script is as narrow as what it checks.** One that looked for the word
  "export" to tell code from comment stopped on a comment about export tax. It stopped
  before writing, which is what the check is for; look for the line that begins so.
- **A script that writes is not run to look.** `rs-live.js`, `ecu-live.js` and `ecu-stage.js`
  change the colony whatever is done with their output; `net-live.js <bff> <account>
  <characterID> <planetID> look` and `colony-read.js <repo> <store> <planetID> <ownerID>`
  only read. Cutting a writer's output to one line does not stop it.
- **Python rounds a half away from nought; JavaScript rounds it up.** They differ below
  nought (-0.5 is -1 there and -0 here), and a sum the client carries its rounding through
  comes out in another order (two equal shares of five: 2 and 3 there). Where the client's
  arithmetic is copied, its rounding is copied too (`extractorRestart.ts`, `rounded`).
- **A read on an object for a thing the page names** is listed in `PAGE_OBJECT_CALLS` like a
  write, and asked with `bridgeAsk` and `of`: a pilot's, no `confirm`. The planet's yield
  read is the first (`rs-live.js` asks it and makes the one change of a restart).
- **An extractor for a check**: `ecu-stage.js <bff> <account> <characterID> <planetID>` builds
  one on Test Two's colony by the page's own write (the centre to level 2, a control unit, a
  link, a head and a programme of Base Metals, a route to the launchpad), and stops where a
  step is refused. A programme that is running cannot be installed again
  (`CantInstallProgramNeedsCooldown`): run it out with `ecu-expire.sh <planetID> <ownerID>
  <hours>`, which stops EveJS, moves the unit's times back in the store and starts it again
  (both BFFs want starting again after). `ecu-live.js` sends the page's two forms and reads
  the colony round them.
- **A bot run from the tab**: save one of a single block with `bot-save.js <bff> <account>
  <macro> <name>` (the BFF's own route), choose the pilot and "Go to first pilot", then in
  the Bot Manager's Pilots list pick it in the pilot's row ("Choose a bot") and press "Run
  here". Its own words are in the BFF's data folder, `bot-logs/<characterID>.jsonl`: the
  Bot Manager's "Recent runs" does not list a run made in the tab.
- **A colony for a check**: Test Two's (`test2`, 140000002) on Muvolailen I, planet 40176368,
  where the pilot is docked: a command centre and a launchpad, one link, no routes, level 0.
  `net-live.js <bff> <account> <characterID> <planetID> [look]` reads it and changes it. It
  takes none of a route made, a route removed or a programme installed: the one change it
  takes is its command centre raised a level (`[[9, [commandPinID, level]]]`), which costs
  ISK and is undone by the store put back.
- **A breakage not caught is one of two things.** A guard that does nothing (the answer is
  the same without it): take the guard out. Or a case no test has: write the case, see it
  pass, and try the breakage again, and then the next way of writing the same breakage.
- **A bound call moved to the page leaves behind what its handle left.** The handle's path
  in `pilots.js` does things once a call is answered (the pilot's last order, the banks, a
  fleet's state, the listings forgotten). Read those lines before moving a call, and give the
  by-name path the same: a ship sent to a point by name was not the pilot's last order
  until it was, and the next keep-at-range would have been held back.
- **A float on the wire is `{ type: "real", value }`.** A whole JS number goes as an int (or a
  long beyond 32 bits). Where the client's argument is a float (a position, a fraction), the
  ledger's shape makes it one (`goingToPoint`, `retailCalls.js`).
- **A pair added to the page's own writes changes the contract's manifest**: run `node
  scripts/build-bridge-contract.js --write` before the whole suite, or its pin fails.
- **A ship flown for a check**: `goto-live.js <bff> <account> <characterID> [ledger.json]`
  undocks, tries the write's refusals, the last order and a flight to a point, and docks.
  The server's own word for what it received is in `eve.js/_local/logs/server.log`
  (`[Beyonce] CmdGotoPoint char=... point=(...)`).
- **A staging script stops where its staging failed.** One that went on asked the server six
  times with no contract's ID. And a contract is made through the gateway's BFF: its route
  cannot be sent on the game port (`accept-live.js <bff> <stage bff> [corp]`,
  `accept-offer.js <gateway bff>`).
- **Run a new test before the breakage pass.** A test that fails as written makes every
  breakage of its file "not tried".
- **What a route checked of its arguments, the generic call does not.** Read the route for
  every check besides the confirmation (`safety/set-level` refused a level that was none of
  three), then read the server's handler for what it makes of what the route would have
  refused, and the transport for what it KEEPS of the call's arguments: it kept whatever
  level a set named. Judge the pair in `retailCalls.js`, and have the transport keep nothing
  of a call that differs.
- **Look for a scratch file's name before writing it** (`ls <scratch> | grep -c "^name$"`).
  Two older ones were written over in two units.
- **A write that either transport carries needs no route behind it.** Look for the pair in the
  manifest's gateway list first (`contracts/evejs-web-bridge-contract.json`): where it is
  there, the page's module only makes the call (`applyFreePoints`), and the route's name goes
  out of `api.ts`. Where it is not, the module answers false and the flow asks the route
  (`saveQueue`).
- **Look for the pair's entry against the client's line before moving a write.**
  `skillHandler.ApplyFreeSkillPoints` had none, and was counted unchecked on the game port by
  its route too. `grep` the pair in `src/gamePort/retailCalls.js`; where there is none, write
  it with the move, from the client's line and the recording's bytes.
- **A store is staged in a copy, and a reading probe confirms the restore before the copy is
  deleted.** `free-store.js <repo> <a COPY of the store> <characterID> [points]` reads or sets
  a character's free skill points; `sheet-read.js <bff> <account> <characterID> [typeID...]`
  reads a sheet and saves nothing; `free-live.js <bff> <account> <characterID> <points>` sets
  the route's way beside the page's.
- **Read every caller of a call before saying what the client sends with it.** The panel's own
  two saves of a queue say whether a skill is in training, and that was written down as what a
  change of the queue does (`cea56d7`). Every adding, removing and moving goes through the
  service's `OnClientQueueModified`, which says otherwise (`bcf13d5`). `grep` the method
  across the whole client, list the callers in the log, and say which the page's button is
  the counterpart of. A claim about the client is held to this as a build is.
- **A test whose stand-in holds an answer back says how long it will wait**
  (`test(name, { timeout: 5000 }, …)`). One that did not hung a run for 400 seconds, and
  would hang the breakage tool, which is not to be time-limited from outside. Run a new test
  file once by itself with `--test-timeout` before it joins a longer command.
- **A script that stages is not a read.** After a restore, confirm with a probe that only
  reads (`write-start.js <bff> <account> <characterID> read`), and keep the store's copy
  until that is done.
- **An account's extra training slots are in the store's `accounts` rows.**
  `slots-store.js <repo> <a COPY of the store> clear <accountID>` clears them in a copy,
  which `store.sh restore <label>` puts in; `slots-live.js <bff> <account> <characterID>
  stage <otherCharacterID>` then sets another character training and saves a queue each way.
- **A patch script of several files stops at the first find that is wrong, with the files
  before it written.** Take each find from the file as it is (grep it), not from memory, and
  finish from the file it stopped at in a second script. Better, have the script look for
  every find of every file before it writes any (`slots1.js` in the scratchpad is the form).
- **A write is moved by the generic call's three sayings, and only after its handler is read.**
  The page says `pilot` and `confirm`, and the pair goes on `PAGE_WRITE_PAIR_KEYS`
  (`src/bridgeCallPolicy.js`); the page's side is `api.bridgeDo` and a module beside the
  reads' (`web/src/bridge/skillWrites.ts`). The generic call hands the page's arguments on
  as they come, so read the server's handler first for what it trusts, and correct
  `docs/bridge-wire-contract.md` where it lists the pairs. Prove a write as the pause was:
  what is refused (each saying left out, another write with all said, no pilot chosen), the
  route's way and the page's one after the other with the sheets after compared
  (`write-live.js <bff> <account> <characterID>`), then the button in the browser on both
  pages.
- **A survivor of the breakage pass is read, not waved through.** Two `typeof` checks that
  no test caught led to a way round the write check: what was not text was no write to the
  check, and was made into text further on. Where a check asks "is this text", ask what
  becomes further on of what is not.
- **A read may be no read of its window's at all.** Find every caller of the call in the
  client before moving it: `beyonce.GetFormations` has one, the ballpark's making, and the
  page's scanner was asking it for a readout the client's scanner has not got. Then the
  right move is to take the read out, and what showed it, and to say so in the log as a
  thing removed.
- **What a window shows is asked as that window asks it, which is not always the service a
  route was written against.** The Character Sheet's route read the home station by
  `charMgr.GetHomeStationRow`, which is the client's map's and market's call; the client's
  sheet asks another service altogether. Find every caller of a call in the client, and
  then find what the window itself reads: the two can differ.
- **A call of a service the client asks by its name, kept by that service**, is carried and
  kept in three places: the game port's own list and its entry (`src/gamePort/retailCalls.js`),
  a `createKeptReads()` on the pilot's entry read in `callMethod`, and its forgetting where
  the notices are fed and where a session change is worked (`home_station.get_home_station`
  is the pattern, in `src/gamePort/pilots.js`). A test of the answer reads a field's name as
  JSON has it, not by a lookup that bytes and text both satisfy, and asks for the
  notifications that came with it: both were survivors.
- **A read every transport carries needs no way back**, and its route comes off the page's
  list whole. Ask each of a route's reads by name on the gateway BFF too
  (`charsheet-probe.js` is the pattern) before writing a fallback.
- **A pilot staged with implants**: `implant-stage.js <scratch> <bff> <account> <characterID>
  <typeID...>` (9899 and 9941 are two, of slots 1 and 2). Save the store first. No test
  pilot has one otherwise.
- **A flow's test that chooses no pilot tests the route's way.** With nobody chosen the flow
  reads a route where it has one (the skills' sheet does); the page's own asking is reached
  only after `flow.selectCharacter`, with the stand-in answering `/api/bridge/select` and
  each read by `/api/bridge/call`. Hold the browser's clock still for anything worked from
  the server's (`atBrowserNow` in `web/src/app/skillsFlow.test.ts`).
- **A read no test reaches is not moved.** Find who calls it and write the test first. The
  drone range's read of the skill levels was moved, found untested, and put back. A bot's
  reading can be reached: start the bot through the flow over a faked BFF and watch what
  its first reading asks (`web/src/app/missionBotJournalFlow.test.ts`).
- **When a route's read becomes a call, its tests name the read by the call**, not by the old
  path: a stand-in that turns the generic call for it into a name of its own
  (`JOURNAL_READ` and `asRead` in `web/src/app/agentsFlow.test.ts`), and that leaves a request
  of the old route with its own path, which nothing answers. A stand-in that answered the
  call under the route's name would pass a flow that had gone back to the route.
- **The gateway BFF's page** (`http://127.0.0.1:26511/`) has the account `test2` signed in since
  2026-10-10 and opens with no windows: open one by its button. One pilot, one transport:
  log it out of the other page first.
- **A countdown is seen to tick** by reading it until it changes; a minute's display wants up
  to a minute. The bar beside it moves at every reading.
- **A number that came as JSON is finite.** A check for it in the page's TypeScript guards
  nothing; two breakages have survived such checks.
- **After `store.sh`, the game port.** It opens a little after the web gateway answers, and a
  pilot chosen in between is refused as unreachable. `store.sh` waits for both now.
- **After a route is moved, read the game port's ledger for its calls** (`call-ledger.json` in the
  check BFF's data folder). A call the route made unchecked is still unchecked when the page
  makes it: the standings' two details were. Set it against the client's spelling in
  `src/gamePort/retailCalls.js` in the same unit, with every caller in the client found.
  And read what the transport already keeps of the feature before writing any keeping in
  the page: the standings' two lists were the transport's, and the page's asking is
  answered from them.
- **A read made of several calls fails as a whole for what is nobody's own failure**
  (`failsTheReading` in `web/src/bridge/ask.ts`): the pilot gone, the BFF holding none, the
  BFF not reached, the flow moved on, the web session not known. Anything the server
  answered one call with is that read's own. A flow test that has "the read fails" answer
  with a status is testing the second; one that throws from its fetch is testing the first.
- **A side-by-side that differs says at which leaves** (`standings-compare.mjs <repo> <scratch>
  <bff> <account> <characterID>` counts them): one leaf of a cached call's answer is the
  clock.
- **Something done to a pilot from outside, with its page open:** the page holds the pilot,
  so a script cannot be it too. Have a pilot of another account do it, through its own
  session on the same BFF (`give-cash.js <scratch> <bff> <account> <characterID> <toID>
  <amount>` gives ISK). Count what the page then asks with a probe set before the pilot
  was chosen; what the server pushed is in the same probe.
- **What a service of the client's keeps, the page keeps the same way** (`keptOnce` in
  `web/src/bridge/walletReads.ts`): asked once, those that want it together waiting for the
  one asking, an asking that fails not kept, and the server's notice either putting the
  new thing in or letting the old go. Where the client works a change in and that is more
  than the unit, let it go and ask again: sooner than the client, never behind it.
- **Through the gateway a cached call's answer carries the time it was made.** Two askings of
  `account.GetEntryTypes` differ in one leaf, call against call. A side-by-side that finds
  one such difference has found the clock.
- **The hangar's row for a pilot is where it was last seen**, and a store put back under it
  does not tell it. Log the pilot in to see where it is, or ask its flight status.
- **A thing kept "once" is to be tried with several asking at once.** A mark set when the
  answer is in lets everyone through who comes while the asking is out. The page asks
  thirty things together at a login now; a test of a once-only asking makes three or five
  of them in one `Promise.all` and counts what was sent. `keptReads.js` is the transport's
  own means for a thing asked once and kept, and takes its askers one at a time.
- **A page loaded twice asks the selection screen's data twice.** A pass that is to be set
  beside another is given the same number of page loads: set the browser's storage on one
  page and start the pass's count at the next load, for every pass alike.
- **Keep a run's ledgers, not their totals.** After each pass of a run that is to be set
  beside another, copy `bffgp-data/call-ledger.json`, `gateway-ledger.json` and both logs
  aside under the pass's name before anything is restarted. Two ledgers are compared call
  by call in a line of Node (each row has `pair`, `calls`, `statuses`); totals said "nine
  more" and could not say of what.
- **The whole run in fewer calls:** one that logs in and reads the windows; one that presses
  the four mission buttons; a poll of nine three-second looks at the header, called until
  it says DOCKED (some seven calls); "Complete Mission" and the wallet's Refresh; undock,
  the module and LOCK; the lock awaited and the module off; the station's row, DOCK, and
  "Log out". A probe set before the pilot is chosen counts frames, HTTP requests,
  `EventSource`s, and what was refused, by path.
- **Two sides of a closing are not done at once.** A tab that has seen its socket close may
  be a moment ahead of the BFF's own end of it: a test that acts on "it is closed" waits
  for the BFF's count of sockets to fall.
- **Whether the BFF is talking to itself:** rows of `netstat -ano` whose foreign address is
  the BFF's own port and whose owning process is the BFF's (`awk -v p=<pid> '$1=="TCP" &&
  $3=="127.0.0.1:26510" && $5==p'`). With hosted bots in process there are none; over
  loopback (`EVEJS_HOSTED_BOT_REACH=loopback`; `restart-bffgp-loopback.sh` in the
  scratchpad) there were five or six for one bot.
- **A hosted bot run for a check:** `fit-stage.js <bff> test2 140000002` (a Venture with two
  miners, through the BFF's routes; save the store first and again after staging, so that
  a second run starts from the same place), then `bot-run.mjs <repo> <bff> test2 140000002
  starter-mine-haul-cycle 15 150`.
- **A restart writes over the BFF's logs.** Copy `bffgp.out.log` and `bffgp.err.log` aside
  before restarting if a run's are to be set beside another's; their size is not what is in
  them.
- **Ask it both ways of the same app.** The test that set an answer over HTTP beside the
  same answer in process found the one that differs (a path no route has); tests of the new
  way alone had passed.
- **What a page is pushed, and which way:** `push-probe.js` in the scratchpad, pasted into
  the page after a reload and before a pilot is chosen; `window.__push` then holds the
  event stream's frames by kind as they come on a socket and by an `EventSource`, each
  `EventSource` made, and what the page sent about the stream. A request that goes on a
  socket is not a `fetch`, so a probe that wraps `fetch` does not count it (the health
  poll, with the setting on). To take the socket from under the page, keep the socket the
  `events` frame was sent on and call its `close()`.
- **A patch is a script written to a file, every time**, however small. A heredoc halves a
  doubled backslash: a `\\n` meant for a string in the file being patched went in as a line
  break, and the test file no longer loaded.
- **The breakage tool runs the tests unbroken first** and refuses if they fail ("NOT TRIED
  any of N"). Before it did, a test file that did not load "caught" every breakage.
- **A login timed in the page:** `login-probe.js` in the scratchpad, pasted into the page
  after a reload and before a pilot is chosen; `await window.__measure()` clicks the pilot's
  hangar row and says the requests over HTTP, the frames, the most outstanding at once and
  the time from the click to the last answer. It wraps `window.fetch` and
  `WebSocket.prototype.send`, so it counts whichever way the page is set. Run it more than
  once each way before saying one way is quicker: one run over HTTP took 797 ms and the
  next 525.
- **The breakage tool matches on LF** whatever line endings the source has: write the text
  to find with `\n`. And do not take `file`, `sed` or `od` in Git Bash at their word
  about a file's line endings; count `\r\n` in Node.
- **A test that stands a page up in Node** (`web/src/app/pageCarried.test.ts`): a
  `location`, a `localStorage`, a `WebSocket` and a `fetch` defined on `globalThis` in
  a file of its own, since they are the process's. It is how the page's own fetch sites are
  tested with the setting on.
- **Every pilot of every account, chosen in turn:** `every-pilot.js <scratch> <bff>
  <store.sqlite> [accounts]` (save the store first; a login brings a pilot online).
- **Both BFFs run the code they were started on.** A change to a route's answer shows through
  the game-port BFF once that is restarted, and through the gateway BFF only when that is
  restarted too: a field I had added read as nothing through it, where the new code says
  none. `restart-bffgp.sh` and `restart-bffgw.sh` in the scratchpad restart each. And the
  page is served from its build: run `npm run build:web` before a browser check of a change
  to `web/src`.
- **A script's own game-port session keeps cached answers and has nothing to name them.** The
  naming on a notice is the transport's (`pilots.js`), not the session's. A script that writes
  and reads again through a bare `GamePortSession` gets the answer from before the write: mine
  read no orders while the one it had just placed stood open, and left it open. Name the call
  by hand first, `session.invalidateCachedMethodCalls([[service, method, args]])`
  (`orders-direct.js` in the scratchpad does).
- **The gateway BFF hands on the server's cached-answer envelope; the game-port BFF hands on
  what was in it.** A script that reads a route's answer on both has to open the envelope for
  the one (`orders-of.js` in the scratchpad does, for the pilot's orders): mine read "no orders"
  through the gateway while an order stood open.
- **A test that puts a pilot in space must use the park that moves by hand.** In
  `test/gamePortPilots.test.js`, `selected({ inSpace: true })` makes a real park with a real
  timer, and the test process then never ends: a run sat until its own time limit killed it
  (2026-10-09). Build with `handTicked().options` (`selectedInSpace` does it), and give every
  `node --test` a `timeout` in front of it.
- **Do not run this repository's whole suite while a sub-agent runs eve.js's tests.** On
  2026-10-09 a full run beside one had two tests cancelled (the two HTTP provisioning tests,
  each over five seconds); both passed alone and in the next full run. The cause was not
  looked for.
- **A native module of the client's can be run and asked.** What a script hands to a module with no
  source among the scripts (`pyEvePathfinder` is `bin64/_pyevepathfinder.dll`, loaded by
  `blue.LoadExtension`) loads in the client's own Python with `imp.load_dynamic('_name', path)`
  (`scripts/py27-oracle.py`; `itertools`, `math` and `imp` are there, `random` is not). Give it
  made-up input the way the client's script gives it the real thing, and measure: the autopilot's
  route was learned this way (`scripts/build-autopilot-fixture.js`). Vary the order things are told
  to it before trusting an answer: some of its answers go by that order.
- **What the client knows without asking the server** is mostly in its built data
  (`res:/staticdata/<name>.fsdbinary`), which only the client's own loader can read
  (`bin64/<name>Loader.pyd`). `python scripts/client-built-data.py "<client>\tq\bin64" <name>Loader
  "<the file under ResFiles>"` prints a whole table as JSON; the file's place is in
  `tq/resfileindex.txt`. The BFF reads tables the same way (`src/clientData/clientBuiltData.js`,
  one line in `TABLES` for each) and serves a mission's record at
  `GET /api/client-data/missions/<contentID>`. Before asking the server for something the client
  never asks for, look for it there. The tables hold IDs and numbers; do not commit a dump.
- **Staging a pilot.** GM commands go through `POST /api/bridge/gm/slash {command, confirm:
  true}` with a pilot selected: `/tr me <stationID>` moves it, `/giveskill me <typeID> <level>`
  trains it (level 0 gives the skill untrained), `/removeskill me <typeID>` takes it away,
  `/expertsystem add|remove <typeID> me` lends and takes back a skill held by a virtual level
  (`/expertsystem list` names them), `/help` lists the rest. From the browser, send them with the page's own token
  (`sessionStorage.evejs_web_poc_session`), or a script's login takes the pilot away from the
  page. Server state the commands do not reach is in `_local/gameStore/gamestore.sqlite`, one
  table per store with `key` and `json` columns: stop the server, copy the file **and its
  `-wal` and `-shm`** aside (the server leaves the log unmerged when it stops), edit with
  `node:sqlite`, start it again.
- **A live check that stages anything is undone afterwards.** The eve.js test harness copies the
  LIVE store (`_local/gameStore`) as every test file's baseline, and its fixture pilots are the
  characters used here: Test Three (140000003) is its default pilot, Test Two (140000002) its
  second, Test Pilot (140000001) its other-account one. On 2026-10-08 a stack of Slaves, fourteen
  customs cases, three notifications and a moved character, all left by this loop's live checks,
  had 27 of its tests red, and I had logged them as the server's. So: stop the server, copy
  `gamestore.sqlite` with its `-wal` and `-shm`, start it, do the check, stop it, copy the three
  files back, start it (a restart is about twenty seconds). Run eve.js's own tests with the live
  server stopped, and before calling one "red on unchanged source", read what its failing
  assertion found and look for that in the live store.
- **When decompiled source looks odd, run the client's own compiled code.** The decompiler can
  print a block at the wrong depth, and then the source says something the client does not do
  (`agentUtil.GetMissionExpirationAndStateText`, 2026-10-08). `python scripts/client-code.py
  <client>/tq/code.ccp <module ending .pyj> <out file>` writes one module's code object to a
  file (outside the repository: it is the client's code), and a snippet for
  `scripts/py27-oracle.py` loads it with `marshal`, picks the function out of `co_consts` and
  calls it with stand-ins for what it reaches for. The script's header shows how.
- **A route written for the gateway may hand a call something the game port cannot send.** The
  gateway took JSON; the game port marshals, and a plain object is not a Python value. When a
  route's call fails with "Cannot marshal value", give the pair an entry in
  `src/gamePort/retailCalls.js` that turns the route's arguments into what the client sends.
- **Recording what the server really sends**: `scripts/record-dogma.js`, `record-probes.js` and
  `record-destiny.js` log a character in on the game port, do one thing, and keep every frame
  for a fixture. Stage the character first and undo it after (the store copy above).
- **What a class in the client is told of**: the decompiler prints `__notifyevents__` as
  numbers. `scripts/client-notify-events.py` reads the names from the compiled class.
- **The browser takes the pilot from a script.** "Bring online" in the page makes a new
  session for a pilot a script was flying on the same BFF, and the script's is gone. To stage
  from the browser's own session, catch the page's `authorization` header inside the page
  (wrap `window.fetch`, keep the value in a closure, never return it) and post with it there.
- **This server sends every free ball not massive**, the pilot's ship among them, and a station as
  a massive ball 100 km in radius that the ship undocks inside of. The client's collisions only
  run when the client makes a ball massive itself: for the step or two after it drops out of
  warp. A warp to a station at 0 is the flight that shows them.
- **The BFF's warp route is the autopilot's warp**, which lands 10 km off. For a warp to 0 send
  `minRange: 0` (`POST /api/bridge/flight/warp {destinationID, minRange: 0}`).
- **Flying the pilot through the BFF's routes from the page's own session** (see "The browser
  takes the pilot from a script") leaves the page saying "Docked" until it is reloaded. Reload,
  then read the overview.
- **The hidden browser pane is 0 pixels wide**, so the page lays itself out for a phone
  (`MobileWorkspace`: one panel at a time, the ship's line in `HudBar`). For the desktop
  layout (the floating windows over the tactical view) set a size with `resize_window`
  (1280 by 860 worked) and reload the page; put it back with the "desktop" preset after.
- **`window.confirm` answers false in the hidden pane**, so a button that asks first (Form
  fleet, Leave fleet) sends nothing when clicked. Set `window.confirm = () => true` in the
  page before the click, in the same call or one before it.
- **The page opens again whatever windows were open**, so choosing a pilot in the desktop
  layout reads every panel that was left open: one login is a read of them all, and the
  ledger of it is as wide.
- **Two pilots can be driven at once by script** (accounts `test` and `test2`, both on the
  game port with the override): that is how an invite, an acceptance and a second member's
  view were checked. Log both out before the store goes back.
- **Show-info for a thing on grid opens from the tactical view**: a right click on its
  bracket, then "Show info". The brackets are on a canvas; send `contextmenu` events across
  it a few pixels apart until the menu appears, and read which thing was picked from the
  overview's picked line.
- **A dialog by its name**: `node scripts/client-words.js "<client folder>" dialog:<Name>` says
  what kind it is and which parameters its title and body take. A dialog's parameters may be
  typed tuples, `(code, value[, value2])`, which the client turns to text first
  (`cfg.FormatConvert`). A list inside one must be sent as a list: the client reads a tuple there
  as one more typed value and raises. The bridge's JSON keeps the two apart (an array is a tuple,
  `{type: "list", items}` a list), so look at which one the server sent.
- **Copying the store aside and putting it back** is one command in the loop's scratch folder:
  `store.sh save <label>` and `store.sh restore <label>` stop EveJS, copy the three store
  files, start it and wait for the gateway. It waits on the gateway BFF (26511), so that one
  must be running. To set two transports side by side, save the staged state too, and restore
  it before each run.
- **A corporation fitting for a test pilot** (none manages its corporation's fittings):
  `corpFittingMgr.SaveManyFittings` straight to the web gateway with `corprole` in the call's
  session, which the gateway takes as given. Stock comes from `/giveitem <typeID> <amount>` on
  the BFF's GM route, into the station hangar.
- **The page's Ready Fit window keeps the pilot it was opened for.** After switching pilots,
  press "Refresh sources" before looking for a fitting in it.
- **A mission that is not a courier, for a test pilot.** A security agent offers nothing unless
  the server has a mission for its level, and it has them for levels 1 and 2 only
  (`eve.js/server/src/config/productionMissionPolicy.json`): the level 4 agent at Test Two's
  station answers a request with its greeting again. A level 1 security agent will talk from
  afar: 3011895 (in Ono, next door) offered a fighting mission to Test Two once
  `/maxagentstandings` had been run in the GM console. The loop's scratch folder has that state
  saved (`store.sh restore staged-objectives`, then put the clean one back).
- **A script that selects a pilot cannot just log out.** `POST /api/logout` answers 409
  `DRONE_RECOVERY_PENDING` until the script has said the pilot's drones are accounted for, as
  the page does: `POST /api/bridge/drone-recovery/ready {checkID}` with the
  `droneRecoveryCheckID` that select answered with (`scripts/bff-parity.js` does this). A
  script that exits without it leaves the pilot held by the BFF.
- **While a session is changing place the BFF refuses every action** (409
  `SESSION_CHANGE_IN_PROGRESS`, from the gate near the top of `src/server.js`), from the moment
  an undock, dock or jump is sent until it has settled. The server's pushes about the change
  reach the page before that. Anything the page does on such a push has to wait the refusal
  out, as the agent's window does (`whenThePilotIsFree` in `web/src/app/flow.ts`).
- **A push reaches the page on the live stream and again with the next answer** (both
  transports keep a copy for the answer as well as streaming it). On the game port the
  answer's copy carries the cursor of its stream event, and the page acts on a push once
  (`web/src/bridge/pushOnce.ts`). On the gateway the answer's copy carries none, so there
  both are still acted on: whatever acts on a push has to be harmless done twice.
- **The BFF runs one write per pilot at a time** (`CHARACTER_IN_USE`). Anything that must get
  through while a write is waiting on the server, as an answer to its question must, has to be
  let past that gate in `src/server.js`, and tested with a write in flight.
- **A call sent right behind the table of agents is answered late.** Measured 2026-10-09 in the
  server's log: the call after `agentMgr.GetAgents` was answered 50 to 80 ms after it came in
  (the registry's resolve 82 ms; the same resolve 1 ms when sent before the table, and under
  1 ms two seconds after login). Why was not looked into. What the choosing waits for is asked
  before the table.
- **A read added to the choosing on a bound object renumbers the transport tests' objects**
  (`N=1:<n>`) and lengthens their lists of binds: some thirty tests said so at once. The
  stand-in in `test/gamePortPilots.test.js` counts the corporation's registries apart
  (`N=2:<n>`) and `build()` takes the choosing's bind and calls of the registry out of the
  session's lists into `session.registryAtChoosing`. Do the same for the next service a
  choosing binds.
- **Before keeping an answer at the transport, find every reader of it in `src/`.** What the
  client keeps and corrects by notices is right for a page, and wrong for a BFF flow that
  checks one pilot's write by reading another pilot's state at once: the notice and the answer
  travel on different connections, and the kept copy can be a notice behind.
  `src/trainingOnboarding.js` reads a trainee's applications that way, so they are asked for
  each time.
- **A change to the page is in the browser only after `npm run build:web`**: the BFF serves the built
  page (`public/dist`, which git ignores). The build checks the page's types, its tests' too, and
  `npm test` does not: a test that passes can still fail the build.
- **A search's line is not the function it is in.** A listing put `if (ball.speedFraction ===
  0.0) ball.speedFraction = 1.0` sixteen lines under `followBall(`, and I wrote that a follow
  restarts a stopped ball. The line is in the function after it. Read the function before
  writing what it does.
- **A route test that fails before the change and after it is testing the stand-in.** A flight
  route answers 409 until the page's check for lost drones is acknowledged
  (`/api/bridge/drone-recovery/ready`), and that check reads the space snapshot. Print the
  answer's body before believing a failure.
- **A count is not a rate, and not a cause.** 62 `List` in a flight read as the page asking over
  and over. Set beside the server's log, nearly every one followed the server's own notice that
  an item had changed: the page asks when it is told. Before calling something polling, put
  each call beside what came just before it: `scripts/server-log-rounds.js <server log> <from>
  <to>` does that. The server's logs of earlier hours are kept beside the current one
  (`eve.js/_local/logs/server.<date>_<hour>.log`), so a "before" can be read after the fact.
- **Sort a walk's ledger by its calls.** A pair's status says its form is the client's. It does
  not say the client sends it that often: the page read the locked targets once a second, each
  reading a `GetTargets` the client sends once in a flight, and the ledger had it as "same",
  395 times. The count column is where that shows.
- **In the page's space windows:** a rack button takes a pointer going down and up, not a
  `.click()` (it tells a click from a hold); and a locked thing's row carries a mark after its
  name, so find a row with `includes`, not `startsWith`.
- **What asks a call may be the page, not the BFF.** The page's own code makes some calls through
  `/api/bridge/call`, by name (`web/src/bridge/stationPanel.ts` asks the station's three so). A
  search of `src/` alone said nothing of ours asked them, and that went into the log and had to
  be taken back. Search `web/src` too, or read the server's log of a session in the browser.
- **A fact offered in support of a decision is still a claim.** Two went into the log unchecked
  on 2026-10-08, in a paragraph arguing for a design, and both were wrong. One route call or one
  grep would have caught each.
- Tests that pass the first time have proved nothing yet. Break the code and watch them fail:
  `node scripts/break-and-check.js <source> <test> <list of [find, replacement]>` does it one
  breakage at a time and puts the file back. Commit a new source file, or at least let that
  script finish, before killing anything: a breakage that makes the tests hang once left an
  untracked file broken with its only good copy in a running process.
- In a patch script, `text.replace(find, replacement)` reads `$&`, `$1`, a dollar and a backtick,
  and a dollar and a quote inside the replacement as instructions. Pass a function:
  `text.replace(find, () => replacement)`.
- The server's character status says `retail_client` on `tcp` for a gateway session as well as
  a game-port one. To know which transport a pilot is on, read the server's log:
  `[EvejsWebGateway] Browser session started` is the gateway, `[PKT] IN` is the game port.
  `scripts/bff-parity.js` does this.
- A state asked of eve.js in flight (`UpdateStateRequest`) is not the truth to the tick. It is
  where the ships are at that moment under the stamp of the next whole second, and the server's
  one-second steps begin where the system was woken, not on the stamp's seconds. Through it a
  correct park can look a tick and a half off. `scripts/destiny-compare.js` is good for modes,
  velocities and "about a tick"; for positions to the metre use the server's own record of each
  step, `eve.js/_local/logs/space-movement-debug.log` (one file an hour, named by the hour in
  UTC), with `scripts/park-against-movement-log.js <recording> <log>`. This was read as a
  server defect once, written into a commit message, and was not one.
- The server's own ship and the stream it sends are not at the same time: in a warp its ship
  runs one to three seconds ahead of the park's, on the same path. A gap between "where the
  server has the ship" and "where the park has it" while moving is that, until shown
  otherwise; compare at rest, or read the script's `closest`.
- Time dilation is set with the server's own chat command through the GM route:
  `POST /api/bridge/gm/slash {"command": "/tidi 0.5", "confirm": true}`, and undone with
  `/tidi auto` (`/tidi` alone says the state). It is the whole system's: keep it short.
- A script of your own that opens a game-port session: `new GamePortSession({ transport })`,
  end it with `process.exit`, give it a hard exit timer, and send its output to a file. One
  that threw at its first line sat for seven minutes behind an open socket and a pipe that
  showed nothing.
- Write down what was measured. Do not write down its cause until the cause has been checked. Twice
  in this loop a cause went into a commit message and the log and had to be taken back.
- The web client in a browser tab selects its pilot again when it loses the session. Log the tab
  out before a script selects the same character, or the two take it from each other.
- Set each place of the server's answer beside the recording's, not only its form. EveJS sent
  a nought for a station guest's missing alliance and war faction where Tranquility sends None
  (fixed, eve.js `3cdc14973`). The page read both as "none", so nothing of ours showed it. Read
  through the game-port BFF, a list comes as `{type: "list"}` and a tuple as a plain array:
  that is how a tuple sent where Tranquility sends a list is seen.
- Staging for a corporation: Elysian Industries (98000000) has Test Three for its CEO and Test
  Two for a member, one office (Jita), and an empty wallet. An office in Jita costs 10,000:
  the CEO gives the corporation the ISK first (`account.GiveCash(corporationID, amount,
  reason)`). No route of the BFF rents an office or gives one up: a script's own game-port
  session sends `officeManager.RentOffice` and `UnrentOffice` by name, as the pilot docked
  there. The GM's `/tr me <stationID>` puts a pilot in a station. Save the store first.
- A pilot the page holds cannot also be a script's: the write that the page is to be seen
  answering comes from another pilot's session, so stage the two into the same station.
- A test of the transport that puts a pilot in space (`solarsystemid` on the stand-in's
  session) sets the ballpark's clock going, and the test file then never ends: every test
  passes and `node --test` hangs. To take a pilot out of a station, change `stationid` alone.
  Run a test file under `timeout 150 node --test --test-timeout=20000 ...` so that a hang
  ends by itself, and stop a run that went to the background.
- A notice told to two audiences comes twice (`OnOfficeRentalChange`: by station, and by
  corporation). Count in the recording what the client asks after it before letting the page
  ask at each telling: the lobby's offices were asked for once there, and twice by the page.
- A service becomes one whose calls go to a bound object by a line in `MONIKER_SERVICES`. Every
  other call of that service goes there too from then on, read or not: look at what the
  BFF's routes send of it first (`grep -n '"<service>"' src/server.js`).
- The contract file has two lists: what the gateway will carry (`gatewayAllowlist.pairs`) and
  what the BFF counts as a write (`bffWritePolicy.pairs`). A pair on the second alone is not
  carried by the gateway, and for the game port goes on `GAME_PORT_ONLY_CALLS`. Look in the
  file before writing which list has a pair: I wrote the wrong one of `officeManager.RentOffice`.
- A new write: `FEATURE_WRITE_METHODS` in `src/bridgeCallPolicy.js`, then `node
  scripts/build-bridge-contract.js --write`, then `test/bridgeCallPolicy.test.js`, which lists
  the feature writes and counts all of them.
- The pilot interface is the gateway client's nine functions, and a test holds it to them.
  What the BFF needs of a game-port session beside them rides the flight's status and is
  taken off in `readHeldFlight` before the page sees it (`corpRole`).
- Run the whole suite before the live check, not after it. The files I had touched were green
  and a list test elsewhere was red, unseen until the staging was undone.
- The login report is made again in two steps, both in the scratch folder: `login-only.js <bff>
  <account> <characterID> <server log> 8` prints the server log's lines for a bare login, and
  `login-report.js <repo> <eve.js logs dir> <from> <to>` writes the report from them (the
  retail log's own lines, 278 to 743, are in it). A scratch folder that has neither: the retail
  log is `direct-tcp-real-client-20260809-163920.stdout.log`, learnt from with
  `server.2026-10-06_15.log`. Do it away from the turn of the hour, when the server's log rolls.
- A call added to the choosing of a character breaks the transport's tests that count a
  choosing's calls. Two lists at the top of `test/gamePortPilots.test.js` hold most of them to
  it (`CHOSEN_ASKS`, `CHOSEN_LAST`); the rest count one service's calls and want the new one
  let through. A stand-in that holds back the first answer of something now asked at the
  choosing hangs the choosing: hold back the second.
- **Never put a time limit round the breakage tool.** `break-and-check.js` puts the source back
  when it ends, and a tool that is killed does not end: a `timeout 590` round it left one
  breakage in `pilots.js`. A breakage that hangs a choosing costs up to two minutes, so thirty
  can outlast one command: give the tool at most four of a file at a time
  (`pairs.slice(n, n + 4)`), compare `git diff --stat` before and after every part, and if they
  differ, match the source against the list (each `find` must be there once) to see which is
  left.
- A bind the choosing of a character now makes shifts every test that holds a session to its
  exact binds and objects. The transport's stand-in session lists and counts apart what every
  choosing binds (the corporation registry's objects, crimewatch's Monikers): put a new one
  there, with a line saying why, rather than telling fifty tests of it.
- **Putting a source file back to an earlier commit destroys what is not committed in it.**
  `git show HEAD:<file> > <file>` followed by `git checkout HEAD -- <file>` gives back the
  commit's file, not yours: I lost seven files' uncommitted work that way and had it back only
  because every change had been made by a script kept in the scratch folder. Check a test
  against the code as it was only after the work is committed (`HEAD~1`), or copy the files
  aside first. And keep making changes by script: it is what made the loss an hour's and not a
  day's. A lost page can be checked against the last build: `sha1sum public/dist/assets/*`
  before and after building again.
- **The page's floating windows are over everything in the workspace.** They are in a layer of
  their own (`.global-layer`, fixed, above the workspace), and the workspace is fixed too, so
  no `z-index` inside it reaches over them: a menu under the header opened underneath a
  window. What must not be covered is a popover of the browser's (`popover="auto"` and a
  button with `popovertarget`, placed from the button's rectangle as it opens:
  `web/src/ui/SafetyChooser.svelte`). Check a new menu live with
  `document.elementFromPoint` at a few of its points: the menu must be what is there.
- **Search `src/server.js` for a method's name before writing that no route sends it.** I
  wrote that `SetSafetyLevel` had no route; it had had one since the plumbing sweep.
- **A flow's request answered after its pilot has gone is thrown by the flow itself**
  (`SESSION_REQUEST_RETIRED`, the guard every request of a pilot's has). A flow function
  needs no check of its own for that, and one written is dead code that no test can reach.
- **No solar system of this server's data is at 0.95 security or above** (the highest is
  0.949794; the systems that were 1.0 are 0.949). What the client does only in the safest
  class of security cannot be seen live here.
- **`git diff --stat` does not see a new file.** After a breakage pass over one, compare it
  with its copy in the scratch folder (keep one: write a new file there and copy it in).
- **A combat timer is one GM command away, in space.** `/cwatch npc 40` (or `weapon`, `pvp`,
  `suspect`, `disapproval`; `/cwatch clear` ends them all; `/cwatch status` says them) through
  `POST /api/bridge/gm/slash`. The server tells a pilot in space of each timer and of each
  ending, and a docked pilot of nothing. The reply's own seconds are not the timer's (it said
  53 for 40): time what the notice says. `cwatch-walk.js` in the scratch folder undocks a
  pilot, runs a list of them and prints each notice and the route's answer after it.
- **A promise nobody waits for must not be able to fail.** Node ends the process at a
  rejection nobody handles, and the BFF with it. What a notice sets going at the transport is
  not awaited: `keptReads.amend` catches what its change throws, and lets the answer go.
- **The same walk on the code before and on the code after, printed and compared,** shows
  what a change of keeping did and did not alter: `diff` of the two printouts with the times
  taken out. The walk made before the change is also where the fixture comes from.
- **The server is an alpha clone's with one variable.** `EVE_CLONE_GRADE=alpha bash store.sh save
  <label>` in the scratch folder saves the store and starts EveJS answering an alpha's grade
  to every account (the start script hands on the shell's environment); `env -u EVE_CLONE_GRADE
  bash store.sh restore <label>` puts both back. `GET /api/bridge/clone-grade` through the
  game-port BFF says which it is.
- **A call the login makes before the character selection is listed apart in the transport's
  tests** (`session.gradeAsks` in the stand-in of `test/gamePortPilots.test.js`, with how many
  calls by name went before it). Some thirty tests hold `session.calls` to the selection's
  three and what follows: put the next such call apart too, with a line saying why.
- **A render on the server never opens a popover or a menu.** What a component hands to a
  child it only draws once opened is held by no render test: say so in the log, keep those
  lines to plain handing-on, and see them work in the browser.
- **"Next" is not the plan.** By 2026-10-10 the log's Next had sixty-one items, all of them a
  feature's calls, and neither of the plan's two unfinished phases (the cutover and the one
  WebSocket), though both are conditions of "done". At the start of an iteration read the
  plan's "Done when" lines and their status as well as Next, and keep the plan's next
  unfinished phase at the head of Next.
- **What the BFF asks the web gateway is tallied** (`src/gatewayLedger.js`), and is the measure
  of the cutover. A check BFF writes it to `<name>-data/gateway-ledger.json` every two seconds;
  `ledger-show.js <file>` in the scratch folder prints it by kind, and `node
  scripts/gateway-ledger-report.js <file> "<what was walked>"` writes
  `docs/game-port-gateway-ledger.md`. Restart the BFF for an empty tally. A row under `pilot`
  on the game-port BFF is a held pilot's call that went to the gateway: news.
- **A patch through a shell heredoc that has backticks in it is mangled** (again, 2026-10-10:
  the script failed to parse, and nothing was changed). Write the script with the Write tool,
  or change a scratch copy with the Edit tool and copy it in.
- **Take the store's copy before a walk that moves a pilot, even one that stages nothing.** I
  undocked and docked Test Pilot for a measure with none taken.
- **A saved bot is run on the server from a script by the page's own start.** `node
  bot-run.mjs <repo> <bff> <account> <characterID> <scriptID> [minutes] [seconds to watch]` in
  the scratch folder imports `web/src/bots/startRun.ts`, prints the approval the page would
  ask for, makes the grant, starts the bot, prints each change of its state, and stops it when
  the time is up. A start with no grant is refused (`BOT_GRANT_REQUIRED`).
  `botscripts-list.js` lists a BFF's saved bots. Save the store first: a bot moves its pilot.
- **Run the same thing through both BFFs before believing either.** "Belt empty" four times
  read as an empty system until the same bot through the gateway found a rock at the first
  belt. A difference between the transports is a fault of ours until shown otherwise.
- **Every live check in space had been at a station or a gate.** Nothing had been to a belt on
  the game port, and no test had a rock in it, so a snapshot with no rock a bot could use
  passed everything. When a feature works on things of a kind (rocks, wrecks, drones, clouds),
  go where one is.
- **A mining ship for Test Two is one script away.** `cd <scratch> && node fit-stage.js <bff>
  test2 140000002` gives a Venture, boards it and fits two Miner I and an afterburner through
  the BFF's own routes. Save the store before it, and the staged state after it under another
  label, and restore the staged one before each transport's run. `ore-read.js` reads the ore
  hold after a run; five minutes of two lasers is some 870 m³.
- **When one field of the gateway's answer is found missing from ours, read the whole of both
  makers.** The rock's was one of four gaps in the space snapshot's rows; the other three were
  found in ten minutes by setting `projectSpaceEntity` (eve.js,
  `evejsWebGatewayRuntime.js`) beside `projectEntity` (`spaceProjection.js`), not by walking.
- **On the game port, what a call changes in space is not there when the call answers.** The
  gateway reads the server's scene; a pilot on the game port reads its own park, which the
  next ballpark update changes. A route that calls and then reads the snapshot to say what
  happened (a launch, a scoop, a jettison) reads the park from before. The launch waits for
  its drones (`DRONE_ARRIVAL_WAIT_MS` in `src/server.js`); look at each route of that shape.
- **Drones for Test Two:** after `fit-stage.js`, `node drone-stage.js <scratch> <bff> test2
  140000002` gives two Hobgoblin I and puts them in the Venture's bay; `drone-walk.js`
  undocks, launches them and prints each drone's row. A pilot who logs off in space with
  drones out has none on grid when it comes back.
- **A rule read out of the client is set beside the server's own data before it is believed.**
  A live check sees what the server happens to put in front of the pilot. The NPC kinds were
  the same on both transports at two gates and wrong for 142 of the server's 5794 profiles,
  which a script that walked `listNpcProfiles()` (`eve.js/server/src/space/npc/npcData.js`)
  showed in a second. Where the server has a table of every case, walk the table.
- **An NPC put out for a check:** undock, warp to a planet (away from a station's and a gate's
  guns), then `/npc 1 <profileID>` through `/api/bridge/gm/slash`; `npc-spawn-walk.js` does
  the whole of it and prints each ship's row. The ship put out goes for the pilot, so read
  the snapshot at once, and put the store back after. `test/fixtures/destinyJump.json` has
  fifteen of the law's ships with their slim items as this server sent them.
- **The page has "Log out" only while docked.** A browser check that ends in space docks first.
  A hostile ship put out beside the pilot kept it from warping off (2026-10-10), so put one
  out last, and if the pilot cannot dock: remove `evejs-web-online-pilots:v1` from the page's
  `sessionStorage`, put the store back, restart both BFFs, load the page again and read that
  nobody is in ("In client 0").
- **A compressing ship for a check:** `compress-stage.js <scratch> <bff> <account> <charID>
  <out.json>` gives a docked pilot a Porpoise, the core, the ore compressor and heavy water
  (300: more does not fit the hold), fits, undocks, starts both and prints the own ship's
  row at each step; `compress-dock-stage.js` stops docked with 50 Scordite aboard, for the
  page. A ship with its core running cannot dock for the core's cycle.
- **A module's button on the page's rack wants the pointer, not a click.** From a script:
  dispatch `pointerdown` then `pointerup` (PointerEvent, bubbling) on
  `button.module-slot.filled`; its `title` says whether the module is active.
- **A value copied from an old note of ours is a guess until it is measured again.** The
  compressor's range in a July note was 375,000 m; the server gave 66,000 m.
- A test's "watched to fail" can be had after the fact, once the work is committed: put the source file back to the commit
  before (`git show HEAD~1:<file> > <file>`), run the test, and restore it with `git checkout
  HEAD -- <file>`. Check `git status` is clean after.

## When to stop

Stop the loop, with a summary in the log and in your last message, when either is true:

**It is done.** All of:

1. Every phase of the plan has met its "done when", and the plan says so.
2. A pilot never touches the web gateway: the only gateway calls left are the account-level ones
   the plan lists.
3. The browser reaches the BFF without `/api/bridge/*` routes or an event stream of its own.
4. Each feature the web client has makes the calls its retail counterpart makes.
5. This run passes twice in a row from a cold server start, in the browser, on the game port, with
   the evidence in the log: log in, select a character, read inventory, fitting, wallet, market,
   skills, mail and chat while docked; accept a courier mission; undock; warp, jump a gate and dock
   by autopilot with the overview drawn from our own ballpark; deliver and complete the mission;
   lock a target and cycle a module; log off.

**Or you are stopped**: every remaining unit needs something only the operator can give. Say
exactly what, and what you recommend.

Do not stop because a phase ended, because a unit was hard, or to report progress. The log is the
progress report. Stop any server you started when the loop ends.
