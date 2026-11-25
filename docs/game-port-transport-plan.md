# Plan: pilots on the game port (retire REST for game calls)

Written 2026-10-07 against web `1874327` and eve.js `7603a2966`. Nothing in this plan has been
built or run live; every "verified" below means "read in the source at those commits".

**Decision this plan implements (option B):** the BFF becomes the retail-protocol client. Each
logged-in pilot is one TCP connection to the eve.js game port (26000) speaking machoNet with
marshal frames, exactly as the client in `D:\EVE Online - 3396210 - Copy` does. The browser talks
to the BFF over one WebSocket. HTTP remains only for things the retail protocol cannot do.

```
browser ── one WebSocket (calls + pushed notifications) ──> BFF ── TCP 26000 machoNet ──> eve.js
                                                             ├── XMPP 5222 (chat, already built)
                                                             └── HTTP :26002 gateway, ACCOUNT-LEVEL routes only
```

⚠ **This needs no eve.js feature.** It moves Web Companion further onto "the published stock EveJS
interfaces and original game protocol" (`docs/stock-evejs-integration-policy.md`). The web client
conforms to the server; nothing is added to the server for the web client's sake.

A **server defect** is different, and since 2026-10-08 it gets fixed: something the retail client
would suffer too is handed to a sub-agent to fix and commit in `eve.js`. The procedure, and the
unattended loop that now works this plan, are in
[`goal-prompts/game-port-loop.md`](goal-prompts/game-port-loop.md); its journal is
[`game-port-loop-log.md`](game-port-loop-log.md).

---

## 0. Goal and standard (operator, 2026-10-07)

**The ultimate goal is EVE in a web browser, with minimal graphics.** This plan is the transport
half of that. Option B is a step toward it, not the end state: Phase 6b moves the client's logic
into the browser.

**The standard is "identical to the retail client", not "frames the server accepts".** The game
port must not be able to tell our session from build 3396210: same handshake, same calls in the
same order at login and character select, same handling of what the server pushes. Where the
existing `GameClient` takes a shortcut the retail client does not, the shortcut is a defect.

Sources of truth, in the order to consult them:

1. **The decompiled client**, `eve.js/tools/ClientCodeGrabber/Latest` — what the client does.
   Decompile further with `eve.js/tools/ClientCodeGrabber` (and its V2) when a module is missing.
2. **CCP's own source**, in `C:\Users\ryanf\Documents\GitHub`: `destiny` (the ballpark
   simulation the client runs), `blue` (the marshaller and the Python runtime glue), `io`, `core`,
   `fsd`, `trinity`. Where one of these covers the question it outranks decompiling a binary.
3. **The legacy client install**, `D:\EVE Online - 3396210 - Copy` — the binaries the Python
   calls into (`blue.dll`, `_destiny.dll`, `code.ccp`). Decompile them when neither of the above
   answers the question. Its `python27.dll` answers questions about Python itself.
4. **The eve.js server source** — what the server accepts and sends.
5. **A recorded real-client session** settles any disagreement between the others. One exists:
   `eve.js/_local/logs/direct-tcp-real-client-20260809-163920.stdout.log` (login, character
   select, in station). Record more when a phase needs them.

**This is a dev machine.** Staging data in the game database (accounts, items, colonies) is
allowed and expected. "The data does not exist" is never a reason to leave a live check undone;
stage it, run the check, and say what was staged.

---

## 1. What is true today (verified)

### 1.1 The two REST hops

| Hop | What it is | Size |
|---|---|---|
| Browser → BFF | Express routes in `src/server.js` | 574 routes; 460 under `/api/bridge`; one SSE stream |
| BFF → eve.js | HTTP JSON gateway `/_evejs-web/v1/*` on :26002 | ~25 routes; allowlist of 717 pairs; WebSocket `/session-events` |

### 1.2 The seam the swap happens behind

The BFF does not call the gateway from 460 places. It calls a handful of helpers:

| Helper in `src/server.js` | Call sites | Game-port equivalent |
|---|---|---|
| `heldTopLevelCall` | 332 | `CallReq` to a service |
| bound bind / bound call (`gateway.bindObject`, `callBoundMethod`) | few, shared | `MachoBindObject`, `CallReq` with the `N=...` object id |
| `readHeldFlight` (`/session/flight-status`) | 69 | **none** — derive from session changes + ballpark |
| `gateway.readSpaceSnapshot` (`/space/snapshot`) | 9 | **none** — derive from `DoDestinyUpdate` |
| `gateway.readScannerState` | 1 | **none** — derive from scan notifications |
| `gateway.selectCharacter` / `releaseBridgeSession` | 3 / 5 | `SelectCharacterID` / close the socket |
| `gateway.openSessionEventStream` | 1 | notifications arrive on the same socket |

The three "none" rows are web-only projections. They are the real work.

### 1.3 What already speaks the real protocol

- `src/gameClient.js` — handshake, login, `call`, `bind`, `callBound` over TCP 26000. Short-lived
  and calls-only: it drops every packet that is not a `CallRsp` (7) or `ErrorResponse` (15). Used
  only by `src/piCustomsExport.js`.
- `src/gameProtocol/marshal.js` — the codec, vendored from eve.js. **Stale:** it predates eve.js
  `4544f5747` (pickle framing), `972e70c96` (negative longs) and `65f759873` (NULL bool flag).
- `src/evejsXmppChat.js` — Local and Corp chat over XMPP 5222.

### 1.4 Constraints

1. **One character, one session.** A game-port select evicts the gateway session for that
   character and vice versa (`loginTakeoverEnabled: true`). In space, eviction is an emergency-warp
   logoff. A pilot is on one transport for its whole session; there is no per-call mixing.
2. **A game-port session has no snapshot to poll.** The gateway session deliberately discards
   `DoDestinyUpdate` (`evejsWebGatewayRuntime.js`, "Candidate F") and serves `/space/snapshot`
   from the server's own ballpark. The retail client simulates the ballpark itself (`_destiny.dll`).
3. **The game port accepts any password** (`devSkipPasswordValidation: true`). Web auth in the BFF
   is the only thing tying a browser to an account, so the BFF must do the login itself and never
   relay a browser-chosen `user_name`.
4. **Session lifetime becomes socket lifetime.** `socketIdleTimeoutMs` is 0 in stock config, so an
   idle connection is not reaped; but a closed socket is an immediate logoff. Today a gateway
   session outlives a BFF restart until its 30-minute TTL.
5. **Hosted bots share the seam.** `src/botHost.js` runs the browser stack in Node and calls the
   BFF's own HTTP routes through `botFetch`.
6. **BFF write routes carry behaviour.** `/api/bridge/call` refuses writes; dedicated routes do
   read-before, call, re-read, and static-data lookups (e.g. `modules/activate`). That logic is
   transport-independent and stays where it is until Phase 6.

### 1.5 Not yet verified — each is answered by a named phase

| Unknown | Answered in |
|---|---|
| ~~Does eve.js compress outbound packets?~~ **No.** Nothing it sent in any recording was compressed. It does inflate what the client compresses. | answered, Phase 1 |
| ~~Does the retail client send "placebo" or a real AES session key?~~ **Placebo, no key, nothing encrypted.** The eve.js client setup sets `cryptoPack = Placebo`, and the server's constant `challenge_responsehash` only verifies under Placebo. | answered, Phase 1 |
| Do wire-decoded values match the gateway's JSON closely enough for the 142 browser decoders? | Phase 2 |
| How much of a ballpark simulation do overview, targeting and autopilot actually need? | Phase 4 spike |
| BFF CPU cost of decoding 10 Hz destiny updates for N pilots | Phase 4 |
| Does `piCustomsExport` work live on the refreshed codec? | Phase 0 |

---

## 2. Target design

### 2.1 `PilotSession` — the one interface

Everything that today goes through the helpers in 1.2 goes through one interface with two
implementations. The gateway one is today's behaviour; the game-port one is the goal.

```
PilotSession
  call(service, method, args, kwargs)            -> result
  bind(service, bindParams)                      -> handle
  callBound(handle, method, args, kwargs)        -> result
  onNotification(fn)   onSessionChange(fn)   onClosed(fn)
  location()     -> what flight-status returns today
  ballpark()     -> what space/snapshot returns today
  scanner()      -> what scanner-state returns today
  close()
```

**As built (2026-10-08): the interface is the gateway client's own nine pilot functions**, not a
new set of names. The BFF reaches a selected pilot through `selectCharacter`, `callMethod`,
`bindObject`, `callBoundMethod`, `releaseBridgeSession`, `readFlightStatus`,
`readSpaceSnapshot`, `readScannerState` and `openSessionEventStream`, each naming the session
by an opaque handle. `src/pilotTransport.js` stands where the gateway client stood and sends each
of the nine to the transport that holds the handle; a game-port handle starts `gp:`, which a
gateway handle (base64url) cannot. The sketch above maps onto them one for one (`location` is
`readFlightStatus`, `ballpark` is `readSpaceSnapshot`, `scanner` is `readScannerState`,
`close` is `releaseBridgeSession`, the three `on...` are `openSessionEventStream`).

Why this and not a `PilotSession` object threaded through the BFF: `src/server.js` has some 360
places that reach a pilot, other modules have more, and every test injects a fake gateway client
of this shape. Keeping the shape means none of them change, the suite keeps proving the gateway
path, and a pilot's transport is still one decision made at select. When the gateway's pilot
routes are deleted (Phase 5) the nine functions are simply the game port's.

**The protocol core takes a byte transport; it never imports `node:net`.** The session, the
packet handling and the ballpark are written against "something that sends and receives frames",
so the same code can later run in a browser over a relay (option C) without a rewrite.

**The contract of `location()`, `ballpark()` and `scanner()` is the JSON the browser already
consumes.** That is what keeps the browser, the bots and 584 call sites unchanged while the
transport underneath is replaced.

### 2.2 Transport is chosen per pilot, and is reversible

A setting (`EVEJS_PILOT_TRANSPORT=gateway|gameport`, with single accounts overridden by
`EVEJS_PILOT_TRANSPORT_OVERRIDES="test=gameport,other=gateway"`) picks the
implementation at select time. The default was `gateway` until Phase 5 and is `gameport` since
2026-10-10 (`1dacbb6`). Any pilot can be moved back by flipping it and re-selecting.

### 2.3 What stays on HTTP, permanently

The retail protocol only sees the logged-in character. Management needs more:

- **eve.js gateway, account-level only:** `health`, `status`, `accounts`, `account`,
  `account/create`, `characters`, `character-status`, `skills` and `skill-queue` for offline
  pilots, `character-control/*`. And `snapshot` for a pilot who is not online (added
  2026-10-10, each call site read: the roster's planetary boards and the customs haul's plan;
  one character's colonies and goods out of the store, which no other route has. The check
  that an account owns a character was a third reader until `18e4db3`, and asks the account's
  `characters` now).
- **BFF app API (~115 routes):** web login, bot host, mining/PI/industry plans, pilot training,
  provisioning, and static data (map graph, types, names, icons, market reference).
- **eve.js gateway, a call made as a pilot who is not logged in** (`callMethod` with no session
  handle and a session the BFF makes up: the account, and for some the character and its
  corporation). The retail protocol has no such thing, so these stay where they are. As of
  2026-10-08 they are: the structure access and docking checks for a chosen offline pilot
  (`structureDirectory.*`, in `dockableAccessCall` and `operationStructureAccessCall`), a
  structure's name looked up with no pilot held (`structureDirectory.GetStructureInfo`), a
  fleet's parking and delivery checks for each member (`structureDirectory.
  CheckMyDockingAccessToStructures`, `officeManager.GetMyCorporationsOffices`), a training
  pilot's corporation fittings (`corpFittingMgr.GetFittings`), a fitting provider's when the
  provider is not the pilot that is held, the corporation reads in training onboarding and
  settings (`corpRegistry.*`), and whatever but `charUnboundMgr` `/api/bridge/call` is asked
  while the web session holds no pilot, by an account on the gateway. (For an account on the
  game port the BFF refuses that itself since 2026-10-10, `d6d3de5`: the retail client has no
  pilot's call to make before a pilot is chosen.)

**The store-side reads, each set beside what the client asks** (listed 2026-10-16 from every
`gateway.` read in `src/server.js`; the pages for pilots who are not signed in are most of them):

| Read | Where | For | What the retail client asks |
|---|---|---|---|
| `snapshot` | `/api/roster/planets`, `/api/roster/stock`, `/api/pi/customs-export`; `/api/bridge/planets` for a pilot on the gateway only | colonies and planetary goods of pilots not signed in | Nothing: it reads only the pilot it is logged in as. Logged in, each colony on the planet's own moniker (`GetPlanetInfo`, which a game-port pilot's `/api/bridge/planets` asks) and the goods through `invCache` |
| `skills` | Pilot Training's reads and the PI boards' (`accountSkillSheet`), and the Skills window where the game port cannot make a sheet (`skillSheetFor`) | a pilot's skills and queue | Nothing for a pilot not logged in. Logged in, the skill handler's reads, which a pilot online here on the game port is answered from |
| `character-status` | `isCharacterHeld`, `/api/pi/customs-export` | whether a pilot is online now | Nothing: it knows its own session alone |
| `charUnboundMgr.GetCharacterSelectionData` as the account, on the gateway | `/api/roster/characters` | the Pilot Hangar's rows | The same call, on its selection screen after a login; asked here without one, as a launcher lists an account's characters, since a login closes the account's other client |

The hangar's training column read `skills` for each pilot until 2026-10-16 (`/api/roster/training`,
now gone): the selection tuple's training fields had been measured empty for every pilot on
2026-09-09. Measured again on 2026-10-16, after a cold start too, they carry the skill, its level
and its end, and the hangar reads them as the client's selection screen does
(`charselData.py` 185 to 191).

**What is not in that list** is what the retail client itself asks before a character is chosen.
On its selection and creation screens it is logged in as the account and asks `charUnboundMgr`.
For an account on the game port the BFF does the same (`accountCall`, the seam's tenth
function): the creation tables, the roster, the name check and the creation itself, on one
connection logged in as the account, closed five seconds after the last thing asked on it. The
hangar's roster (`GetCharacterSelectionData` through `/api/bridge/call` with no pilot held) goes
the same way.

### 2.4 Authority that does not move

`bridgeCallPolicy`, `pilotMutationFence`, custody journals, hosted claims and reservations are BFF
logic above the seam. They are untouched by Phases 0–5.

---

## 3. Phases

Each phase ends on something observable. Do not start a phase on the strength of the previous
phase's tests alone where a live check is named.

### Phase 0 — Refresh the codec (small)

- Re-copy `marshal.js` and the string table from eve.js; record the source commit in the header.
- Add `scripts/vendor-marshal.js` (`npm run vendor:marshal`): reports when the vendored copy
  differs from the eve.js source, and re-copies it with `--write`. A test runs the same check
  against `STOCK_EVEJS_ROOT` and is skipped when that is unset, like the bridge-contract test.
- **Done when:** existing `gameClient` / `piCustomsExport` tests pass, a round-trip test over
  frames captured from a real server passes, and one live PI customs export succeeds.

**Status 2026-10-08: done.**

- Codec re-copied from eve.js `65f759873`; `npm run vendor:marshal` reports no drift.
- `test/gameProtocolMarshal.test.js` pins the three fixes. All four wire tests were watched
  failing on the old copy first.
- `test/fixtures/gamePortFrames.json` is a recording of a real login and three read-only calls
  (`scripts/capture-game-frames.js`, account `test2`, eve.js `7603a2966`).
  `test/gamePortFrames.test.js` decodes it, round-trips it, and replays it through `GameClient`.
  Watched failing under three kinds of tampering.
- Run live as Test Two (docked): login → `SelectCharacterID` → `map.GetSolarsystemItems`
  (92 rows, 11 customs offices) → `GetTaxRate` → `invbroker` bind. That is the PI export's whole
  hop except `ImportExportWithPlanet`. The pilot was offline again after the socket closed.
- Run live as Test Two: the real `runCustomsExport` exported 80 Biofuels from a launchpad on
  Muvolailen I into customs office 1200040176368. The server answered `ImportExportWithPlanet`
  and pushed `OnAccountChange`, `OnMajorPlanetStateUpdate`, `OnRefreshPins` and `OnItemsChanged`;
  the pad read back empty and the pilot was offline again afterwards.
  **Staged for this:** one colony row for Test Two, `40176368:140000002` (a command center and a
  launchpad holding 80 of type 2396), plus `nextIDs.pinID` moved on by two.

> Correction: an earlier version of this status said no pilot had a colony. That was a misreading
> of the store. `planetRuntimeState` keeps one row per colony under the key
> `coloniesByKey` + U+001F + `planetID:ownerID`; the bare `coloniesByKey` row is an empty
> skeleton. Farmer has three colonies in Jita, untouched by this work.

Found along the way, for later phases:

- The server's version tuple carries build `3396210`, the same build as the retail client folder.
- The recording decodes identically on the old codec: pre-select traffic contains no pickle,
  negative long or NULL bool. The recording proves the codec reads real bytes; it does not prove
  the fixes. (Phase 1 captures of in-game traffic should be checked for those.)
- An integer above 32 bits can arrive as a JS number or a BigInt depending on which opcode the
  server used, and re-encoding a number that size turns it into the BigInt form. Phase 2's
  normaliser must treat the two as the same value.
- `GameClient` decodes with `marshalDecode`, which ignores bytes left over after a value.
  Phase 1 should decide whether a long-lived session uses `marshalDecodeExact`.
- The server's handshake reply carries Python source for the retail client to run (time-dilation
  handler, portrait upload hook). The Node client ignores it; Phase 1 should confirm nothing the
  server later expects depends on it.

### Phase 1 — A long-lived game-port session, docked (medium)

Extend `GameClient` into a session that can stay connected and behaves as the retail client
does (section 0). Spec is the decompiled client
(`eve.js/tools/ClientCodeGrabber/Latest/carbon/common/script/net/machoNet*.py`, `GPS.py`), the
server's `network/` code, and the recorded real-client session.

- Handshake exactly as the retail client sends it, including its crypto request.
- The retail client's own call sequence, feature by feature (decided 2026-10-08), read from the
  recorded session and the decompiled services that issue each call.

- Dispatch `Notification` (12), `SessionChangeNotification` (16), `SessionInitialStateNotification`
  (18), `PingReq`/`PingRsp` (20/21), `TransportClosed` (8).
- Keep a session mirror updated from session changes (`charid`, `stationid`, `solarsystemid2`, …).
- Inflate compressed inbound frames if the server sends them; match retail's outbound threshold.
- Decode cached-object replies. (Done: see the reference, "Cached answers".)
- Socket loss is session loss. No silent reconnect; report it upward like retail does.
- **Done when:** a docked pilot stays connected for 60 minutes with every pushed packet logged and
  typed (zero "unknown packet" lines), and the two handshake unknowns in 1.5 are written down.

**Status 2026-10-08: done as specified. Two fidelity items remain, both waiting on a recording.**

The exit check, run with `scripts/soak-game-session.js` as Test Two, docked:

| | |
|---|---|
| Held | 3600 s, not dropped |
| Packets the session could not name | 0 |
| Frames | 147 sent, 150 received |
| Sent | 1 `GetServiceInfo`, 1 `SelectCharacterID`, 98 `GetTime` (the first sync, then one every three minutes), 40 `pingService.Ping` |
| Received | 140 call answers, the initial session state, the character's session change, `OnServerSkillsChanged` |

Forty keep-alives in an hour is the client's own rhythm: a clock sync counts as activity, so a ping
only goes out when a full minute passes with nothing else sent.

What exists (`src/gamePort/`, checklist in
[`game-port-client-reference.md`](game-port-client-reference.md)):

- `session.js` — `GamePortSession`: the retail handshake, calls, binds, session mirror,
  notifications, ping answers, clock sync and idle keep-alive. Takes a frame transport.
- `tcp.js` — the socket binding. `packets.js`, `placebo.js`, `py27.js` — packet layout, the
  Placebo crypto pack, and CPython 2.7's dict ordering.
- `src/gameClient.js` is now a thin wrapper over the session, so the customs export logs in the
  retail way too. It was re-run live after the change and exported 80 units.
- Tools: `scripts/py27-oracle.py` (asks the client's own `python27.dll`),
  `scripts/capture-game-frames.js` (records a conversation as a fixture),
  `scripts/soak-game-session.js`, `scripts/record-game-port.js` (records any client).

How it was checked:

- The server's own probe log records what a client answers at login. For the real client it reads
  `Buffer(5), Buffer(75), null`. The old `GameClient` gave `Buffer(0), Buffer(0), null`; the
  session gives the real client's line.
- ~~The gateway reports a session's pilot as `controlState: "retail_client"`, `transport: "tcp"`.~~
  **Not evidence (corrected 2026-10-08).** The server reports exactly that for a gateway session
  too, because the gateway registers its session as a retail one. What tells the transports apart
  is the server's log: a gateway session writes `[EvejsWebGateway] Browser session started`, and
  only a call on the game port writes `[PKT] IN`. The other three points here stand on their own.
- The server log shows the real client's addressing pattern for our calls: resolve to any node,
  bind to the named node, bound calls to that node, proxy services to the proxy node.
- Tests replay a recorded real-server conversation and require the session to send its own half
  again byte for byte; nine deliberate breakages were each caught.

Remaining:

1. ~~The startup call sequence.~~ **Decided 2026-10-08: per feature.** Each browser feature makes
   the calls its retail counterpart makes, same arguments and order; the roughly ninety startup
   calls are not replayed wholesale. Phase 3 applies this as each feature moves.
2. **Six `?` rows in the reference** (call-ID encoding, journey ID, trace fields, which compression
   path is live). Same recording settles them.

Decision taken while building it: "identical" is defined at the level of decoded values, not
bytes, because the client's marshaller shares objects by Python identity. The reference explains.

### Phase 2 — Normaliser and parity harness (medium)

- `wireToBridgeJson`: turn decoded wire values into the JSON the gateway emits (longs → decimal
  strings, buffers → `{type:"Buffer",data}`, packed rows, object/dict shapes).
- Notification normaliser: wire `Notification` → `{kind, service, method, idType, args, kwargs}`.
- Parity harness: for every allowlisted read that is safe on a docked pilot, read via the gateway,
  release, read via the game port, and diff. Sequential, never concurrent (constraint 1).
- **Done when:** the harness report lists every pair as identical, normalised, or a named
  divergence with a decision. This number is the real size of the browser-side work.

**Status 2026-10-08: done for every read that can be made without a player's input.**

What exists:

- `src/gamePort/bridgeJson.js` — maps a game-port value, a notification or a session change to the
  JSON the gateway emits.
- `scripts/parity-harness.js` and `scripts/parity-compare.js` — make each read through the gateway,
  then the game port, and judge the pair. The list of reads comes from the BFF's own source.
- [`game-port-parity-report.md`](game-port-parity-report.md) — the generated result, every read
  listed. Regenerate it; do not edit it.
- Tests feed mapped values from the recorded real server to the browser's own readers
  (`web/src/bridge/wire.ts`, loaded directly), so "a decoder can read this" is checked, not argued.

The result, as the Test Pilot docked in Jita. The gateway allows 366 reads; 176 were compared (the
two inventory reads were each made on two inventories, which is why the rows sum to 368):

| | Reads |
|---|---|
| Identical JSON, or the same shape with data that moved between the two reads | 142 |
| Differ only in spellings the shared readers accept either of | 9 |
| Refused by the server on both transports, with the same reason reported | 15 |
| **Differ in a way a decoder could trip on** | **9** |
| The server cannot marshal its own answer | 1 |
| Not compared: 88 need a player's choice of argument, 104 are not top-level calls in the BFF | 192 |

The 9 that differ, by kind, and what is decided for each. None can be fixed in the mapping: in
every case the gateway prints a detail of the handler's value that marshalling erases.

| Kind | Reads | Also in | Decision |
|---|---|---|---|
| A timestamp the gateway prints as bare digits; the game port gives `{type:"long"}` | 5 | `OnGodmaShipEffect`, `OnModuleAttributeChanges`, the session change | Teach `unwrapLong` to read a string of digits, and read these fields through it. Bare digits are the minority spelling on the gateway too (5 reads against 26 with the wrapper). |
| A tuple the gateway prints as `{type:"tuple"}`; the game port gives an array | 2 | | A reader of a tuple accepts an array. `agents.ts` `seqItems` does not yet; `fittings.ts`'s does. |
| A byte string the gateway prints as `{type:"bytes"}`; the game port gives `{type:"Buffer"}` | 2 | planet data (`boundPlanets.ts`) | A reader of bytes accepts both. The wire does distinguish the two (a buffer and a string are different opcodes) but the stock decoder merges them; a decoder option upstream would remove this row. |

**All three are made (2026-10-08, `351826d`), and the harness was run again** against a server
carrying the fix below:

| | First run | After |
|---|---|---|
| Identical, or the same shape with data that moved | 142 | 143 |
| Differ only in spellings the shared readers accept | 9 | 14 |
| Refused alike on both transports | 15 | 15 |
| Differ in a spelling no shared reader takes | 9 | 4 |
| The server cannot marshal its own answer | 1 | 0 |

The four that remain are two known spellings, and each has a reader that takes both or no reader:

| Read | Kind | Its reader |
|---|---|---|
| `agentMgr.GetMyJournalDetails` | tuple with or without its wrapper | `agents.ts` `seqItems`, tested on both |
| `facilityManager.GetFacilities` | the same | `industry.ts` `tupleItems` already took both |
| `pvpFilamentMgr.GetAllEvents`, `GetMostRecentEvent` | bytes with or without their wrapper | none: the bytes are inside a date's header, which no decoder reads |

Widening `unwrapLong` also repaired something on the gateway today: the market panel's
`decodePriceHistory` read every history day as null, because the gateway prints that day as bare
digits. Twenty decoders had each grown their own guard against it.

One reader had to be held where it was. `moduleReach.ts` reads the BFF's own JSON, in which a
string where a range should be is malformed and must stay "unknown"; it relied on `unwrapLong`
refusing strings, and now refuses them itself. An existing test caught this.

Fourteen more reads come back from the gateway inside a cached-answer envelope that the browser
opens, where the game port returns the answer itself. The browser's `unwrapCachedResult` helpers
already pass a bare answer through, so these compared equal once opened. Phase 3 confirms each such
decoder goes through one.

Found along the way:

- **A client defect, fixed.** We sent integers above 32 bits as int64, which the server reads as a
  BigInt. The retail client sends a Python long, which the server reads as a number. Every read on
  a ship's inventory answered None because of it. `src/gamePort/clientMarshal.js` now encodes what
  the client sends. This also settles the reference's open row on call-ID encoding.
- **A server defect, since fixed.** `corpRegistry.CanLeaveCurrentCorporation` returned a bare `{}`
  the server's marshaller refuses, so the game port, and the retail client, got None. The gateway
  printed it happily. Fixed in eve.js `2e3101da4` (a local commit there) and re-checked live: the
  two transports now answer alike and the server logs no error. More generally the server answers
  None when a handler or the marshaller throws; the only trace is a `[PKT] ERR` line in its log.
  The loop log keeps the list of such defects.
- **The gateway's session is not a retail session.** On character select the gateway reports a role
  mask of `0x6000000000000000` where the game port reports `0x65fc2062a0e41800`, an extra `baseID`
  attribute the retail session change does not carry, and old values of null where retail has 0.
  Anything gated on roles can behave differently between the two.
- **Refusals carry the same reason.** `error.refusal.reason` on the game port is put together the
  way the gateway's `CALL_REFUSED` message is, and matched it in all 15 refused reads.
- **A capability gained.** A cached answer that is a reference into the object cache is unreadable
  through the gateway (`map.GetStationInfo`, `corporationSvc.GetAllCorpMedals`). The game port
  fetches the object.

What Phase 3 inherits:

1. ~~Three small reader changes in the browser~~ Done, above. What carries forward is the rule:
   a decoder of a tuple takes a bare array, and a decoder of bytes takes them without the wrapper.
2. The 192 reads not compared here are compared as their feature moves, with the arguments that
   feature really sends. The harness takes them as soon as they are top-level calls with arguments
   it can derive.
3. Bound-object reads beyond the inventory (agents, dogma, fleet, planets) need their retail bind
   parameters, which `eveMoniker.py` gives.

### Phase 3 — `PilotSession` in the BFF, docked features on the game port (medium–large)

- Step 1 (pure refactor): introduce the interface, implement it on the gateway, route the helpers
  in 1.2 through it. No behaviour change; the existing suite is the proof.
- Step 2: implement it on the Phase 1 session for calls, binds, notifications and select/release.
  `ballpark()` and undock **refuse deliberately** on the game port until Phase 4.
- Decide the BFF-restart behaviour (constraint 4): accept retail-equivalent drop, or host the
  sockets in a small separate process that survives BFF restarts. Write the decision here.
- **Done when:** with one account flagged `gameport` and the browser unchanged: login, select,
  inventory, fitting, market, agents, skills, mail and chat all work; one hosted maintenance flow
  (Provisioning Center Apply) completes; the gateway log shows no held session for that pilot.

**Status 2026-10-08: step 1 done.** `src/pilotTransport.js` is the seam, and `createApp` reaches
every pilot through it (2.1 says what it is and why it has the gateway client's shape). With no
game-port transport it returns the gateway client itself, so there is nothing in between and
nothing to have changed: the suite is green at 8583. Tests drive a pilot through the real BFF
routes onto a stand-in game-port transport and check the gateway never hears of it.

Step 2 is the game-port transport itself, `src/gamePort/pilots.js`: those nine functions on a
`GamePortSession`. What the gateway does for each, which the game port has to match, was read
from `evejsWebGatewayRuntime.js`:

| Function | The gateway | The game port |
|---|---|---|
| `selectCharacter` | mints a session object, runs `SelectCharacterID` on it, echoes character, station, structure, system, corporation, ship | logs in as the account (name from the BFF's signed session, never the browser), calls `SelectCharacterID`, builds the same echo from the session attributes |
| `callMethod` | hands the JSON arguments to the handler as they are; drains the session's notification backlog onto the answer | the JSON arguments are already the marshaller's own tree, so they are encoded as they are; the answer through `bridgeJson.js`; the same backlog and drain |
| `bindObject`, `callBoundMethod` | registers the bound object's ID under an opaque handle | the same, holding the object ID the server returned |
| `releaseBridgeSession` | runs the disconnect a socket close runs | closes the socket |
| `readFlightStatus` | reads the session's station, structure, system and ship; ship mode from the scene | the same from the session attributes; ship mode from our ballpark (Phase 4) |
| `readSpaceSnapshot`, `readScannerState` | projections of the server's own scene | refuse until Phase 4 |
| `openSessionEventStream` | a WebSocket of the same notifications, with a replay cursor | the session's own notifications, mapped by `bridgeJson.js` |

**Status 2026-10-08: step 2 built, and the docked half of "done when" met.**
`src/gamePort/pilots.js` is the transport; `EVEJS_PILOT_TRANSPORT` and
`EVEJS_PILOT_TRANSPORT_OVERRIDES` choose it at select. Unset, no transport is created and nothing
changes. (So it stood until Phase 5. Unset is the game port since 2026-10-10.)

What a "bind" turned out to be. The gateway's bind calls a method as though it were a service's
(`invbroker.GetInventory(stationID)`) and keeps the bound object that comes back. The retail
client binds a service's object for where the pilot is, then asks that. Each of the BFF's bind
shapes is now made the retail way:

| The BFF asks the gateway for | The game port does, as the retail client does | From |
|---|---|---|
| `invbroker.GetInventory [locationID]` | the station's manager, bound to `(stationid, groupStation)`, then `GetInventory(containerHangar, None)`; in a structure the manager for where the pilot is, and `containerStructure` | `invCache.py` |
| `invbroker.GetInventoryFromId [id] {passive}` | `GetInventoryFromId(id, passive)`, both positional, on the manager for where the pilot is | `invCache.py` |
| `ship`, `invbroker`, `dogmaIM` `.MachoBindObject` | bound to `(solarsystemid, groupSolarSystem)` or `(stationid, groupStation)`, whatever was passed | `eveMoniker.py` |
| `fleetObjectHandler.MachoBindObject [[fleetID]]` or `[]` | `fleetID` alone, or `session.fleetid` | `eveMoniker.py` |
| `agentMgr`, `planetMgr`, `charMgr`, `reprocessingSvc` | as passed, which is what the client passes | `eveMoniker.py` |
| `entity`, `beyonce` | none while docked; the solar system once in space | `eveMoniker.py` |
| `scanMgr.GetSystemScanMgr`, `fleetObjectHandler.CreateFleet` | the service call itself, keeping the bound object it answers with | `scanSvc.py`, `fleetSvc.py` |

When the pilot moves, what was bound for the old place is dropped, as the client's session checks
drop it, and the BFF binds again.

How it was checked, with the test accounts on the game port and the browser unchanged:

- **In the browser.** Logged in, selected the Test Pilot, and opened every docked panel: station
  inventory, fitting, market, skills, wallet, mail, chat, agents and missions, agent finder,
  character sheet, personal assets, standings, industry, contracts, planets, fleet, corporation
  wallet, activity, travel, ready fit, log. Each drew its content; no failed request, no script
  error, nothing in the BFF's error log, no `[PKT] ERR` on the server.
- **Against the gateway, route by route.** `scripts/bff-parity.js` asks two BFFs, one per
  transport, the 22 routes those panels fetch and compares the JSON. For the Test Pilot: 13
  identical, 5 differing only in spellings the readers take either of, 2 where a clock moved, and
  2 with the tuple spelling whose readers take both (the mission journal, industry facilities).
  For Test Two, who has more to read: 11, 6, 3 and the same 2.
- **Which transport each really used** comes from the server's log, as above: the gateway pass
  wrote one gateway session and no game-port call; the game-port pass wrote no gateway session
  and 230 game-port calls.

Since then (2026-10-08, `e3a407f`): the first writes. A courier mission requested and accepted
and its package loaded into the ship, in the browser on the game port, each call read against the
retail client's first. `src/gamePort/retailCalls.js` is now the registry of what the client sends
for each pair, and the transport tallies every call against it
([`game-port-call-ledger.md`](game-port-call-ledger.md)).

Since then (2026-10-08, `f50c742`): making a character. With no pilot online, the account's own
calls go over the retail protocol as the account (2.3).

Not done yet in this phase:

- ~~One hosted maintenance flow on the game port.~~ Done 2026-10-08 (`9c6f087`). The flow this
  plan named, Provisioning Center Apply, was unavailable on stock EveJS.
  [Ready Fit](cockpit-ready-fit.md) replenished supplies on a selected session in its place.
  It completed in the browser on the game port, and its answers were the gateway's to the byte;
  the server's log showed nothing of that pilot's on the web gateway but the account-level reads
  of 2.3.
- The BFF's writes. Every write route goes through the same two functions, but what each sends
  has not been set beside what the retail client sends for it (list or tuple, text as str or
  unicode, keyword or positional). That is per feature, and is where the remaining fidelity work is.
- ~~Undocking is refused and a pilot in space is refused at select, until Phase 4.~~ Both are
  allowed since 2026-10-08: the pilot has a ballpark.

### Phase 4 — Space: a ballpark from destiny (large; spike first)

**Spike (time-boxed, throwaway code):** record the full `DoDestinyUpdate` stream for one pilot
through undock → warp → gate jump → dock. Write a decoder for the state blob and the incremental
actions as the inverse of `eve.js/server/src/space/destiny/stream/*.js`, cross-checked against
`eve/client/script/remote/michelle.py`. Answer: which ball modes must be simulated for the numbers
the app uses (overview distance, in-range checks, arrival detection) to stay correct.

Then build, in this order:

1. Destiny decoder with recorded-stream tests.
2. Ball simulation. **CCP's own source for it is on this machine**
   (`C:\Users\ryanf\Documents\GitHub\destiny`: `Ball.cpp`, `Ballpark.cpp`), so this is a port of
   the client's simulation, not an approximation sized by the spike. The server's
   `eve.js/server/src/space/destiny/simulation/` and the client's `michelle.py` show how it is
   driven. The client's numbers win.
3. `ballpark()` producing today's `/space/snapshot` JSON; ship HUD from dogma reads and
   notifications, as retail does.
4. `location()` from the session mirror plus ballpark; `scanner()` from scan notifications.
5. Measure BFF CPU with several pilots in space; move decoding to a worker thread if needed.

- **Done when:** two pilots on the same grid, one per transport, report the same entities with
  distances within an agreed tolerance across a warp/jump/dock route; then a hosted bot flies a
  courier mission end to end on the game port.

**Status, 2026-10-08.** The "done when" above is met: the two-pilot comparison across a warp, jump
and dock route, and a hosted bot's courier mission end to end on the game port. A pilot on the
game port undocks, flies, warps, jumps and docks; its view of space is its own ballpark. What the
table marks "not started" is still to do.

| Part | State | Checked against |
|---|---|---|
| State blob reader and writer (`state.js`) | done | a real server's blobs, byte for byte |
| Integrator, STOP, GOTO, FOLLOW, ORBIT, the setters, removal (`ballpark.js`) | done | CCP's per-tick fixtures, to the last digit |
| The client's clock: update queue, when to step, rewind, snapshots (`park.js`) | done | CCP's merge and ticker cases; a recorded stream played through |
| The park beside the server's own states (`scripts/destiny-compare.js`) | measured | velocities equal; positions agree as far as such a state can show, which is about a tick (see the loop log, 2026-10-08, "the server question answered") |
| WARP: lining up, the warp proper, dropping out (`ballpark.js`) | done | CCP's one fixture (lining up) to the last digit; the source's own equations; a real warp flown live, at rest 0.17 m and 0.07 m from the server's ship after 280,000 km |
| MISSILE: the launch, the follow and the step (`ballpark.js`) | done | CCP's own cases to CCP's tolerances; nine of Tranquility's missiles, each what a launch leaves, the far point to the bit, and the same nine played through the park; live under rockets, torpedoes and heavy missiles, by script and in the tab |
| FORMATION, MUSHROOM; an unaimed launch from a launcher at rest; a defender's missile's collisions | not ported; the step or the launch refuses by name, the defender's is counted | Tranquility sends every launch aimed (720 of 720 recorded) |
| Collisions: a massive ball against other balls (`Gradient`, `Potential`) | done | CCP's own collision tests to the last digit; the recorded warp, where the ship bounces off the station for the one tick it is massive; the same trip flown live |
| Collisions: a fixed ball's own shapes (miniballs, capsules, boxes), and the partition's order | not ported; counted | no recording carries either |
| The sim clock, time dilation and the clock's rebase (`simClock.js`, `pilotClock.js`, `Park.onTick`) | done | CCP's blue, read; live at half pace: the park steps every two real seconds and every order still arrives one tick ahead of it |
| A ball as the client draws it (`Ballpark.drawn`, `between`, the times a step leaves on a ball) | done; the snapshot's places and speeds are these | the park's own next tick, to a hundredth of a metre in warp and to the last digit out of it |
| The damage clock (a shield's recharge since a damage state was filed) | by the park's tick, not the sim clock's reading | |
| A pilot's own park, kept as michelle keeps one (`pilotSpace.js`); the space snapshot and flight status from it (`spaceProjection.js`) | done | the same pilot on each transport in turn: 95 entities both ways, fixed things within 0.0001 m, five kinds of difference, each explained; two pilots at once, one per transport, see the same 96; undock, stop and dock in the browser |
| The ship's capacitor and capacities from dogma, kept as godma keeps them (`pilotDogma.js`) | done | a real flight with a module running: the client's recharge lands on each of the server's next reports to the sixth place; the gateway's numbers for the same ship |
| Which modules are running or overloaded, from godma's effects (`pilotDogma.js`) | done | a recorded flight; the activate and deactivate routes on each transport in turn give the same answers; the module's button in the browser |
| A gate jump: the park replaced, dogma asked again | done | a trip to the next system and back on each transport in turn: the same things seen after each jump; a recording played through a park per system; a 40 AU warp at rest 0.12 m and 0.06 m from the server's ship |
| Calls the server makes to the client; an answer marked provisional | done | frames built as the server builds them; a mission quit by route and declined in the browser on the game port, the server logging its question and our answer |
| A hosted bot's courier mission, end to end | done | one run: asked, accepted, loaded, three jumps out, turned in, three jumps back, docked; every call a packet on the game port by the server's log |
| The browser's own autopilot | done | one round trip in the web UI: undock, warp, jump, jump back, warp, dock; the browser's requests, the Travel window's states and the server's log agree |
| The server's questions shown to the user | done | `agents.YesNo`: shown in the browser and answered No and Yes on the game port, the press waiting meanwhile. A research agent's choice and number boxes: seen live too (research started on the field chosen, three datacores bought, research cancelled after a No and a Yes). The customs question: seen live as well (asked at the Muvolailen gate, answered Yes in the browser, the case closed as surrendered) |
| The scanner in space: the probes as the client's scan service keeps them, the launcher from godma | done | a recorded probe flight played through the list; in the browser on the game port: launch, reconnect after a new session, analyze, recover, and again from an empty launcher |
| The ship's health as its own panel reads it, each module's damage, the weapon banks (`pilotDogma.js`) | done | a recording of a damaged ship with two grouped guns; each transport in turn gives the same readings field for field; the panel and the rack in the browser |
| Rack heat, kept as the client's heat attributes keep it (`pilotDogma.js`) | done | the formula held to the client's compiled `CalculateHeat`; a real overload on the game port, the mid rack climbing by the formula between the server's words (with the server's heat notices, eve.js `10e2c22f4`) and cooling at the rack's own rate; kept through a dock in the same ship; the rack's heat bar in the browser |

One thing the spike's question got wrong: the stream is not 10 Hz. The server sends an update
when something changes and the client steps once a second on its own, so decoding load follows
events, not frames.

### Phase 5 — Cutover (small)

- Default the setting to `gameport`. Keep `gateway` selectable for one release as the way back.
- Then remove: held `bridgeSessionID` handling, the `/session-events` client, the gateway
  implementation of `PilotSession`, and the pilot pairs from the bridge contract.
- **Done when:** the only gateway routes the BFF calls are the account-level ones in 2.3.

**Status 2026-10-10: begun, with its measure.** The gateway client tallies every call made
through it (`src/gatewayLedger.js`), and each row is classed against 2.3;
`scripts/gateway-ledger-report.js` writes a walk's tally as
[`game-port-gateway-ledger.md`](game-port-gateway-ledger.md). The measure so far, on a game-port
BFF: the parity tool's 34 routes, a pilot in the browser through a login with 25 windows open,
an undock and a docking, and five reads made with no pilot chosen. Nothing of a pilot's own
went to the web gateway (the same 34 routes through the gateway were 147 calls of a held
pilot's), and no read of an online pilot. The calls made as a pilot who is not logged in were
the corporation's reads of the training settings, which 2.3 names, and one sent on purpose
through `/api/bridge/call` with no pilot held (see the second open question in section 5).

Where the two reads of one character are asked, read 2026-10-10:

| Read | Asked by | Of whom |
|---|---|---|
| `characters` | the ownership check (`eveStore.getCharacterForAccount`: a pilot's choosing, a bot's start, the structure and fleet checks, the customs haul's plan). Until `18e4db3` this was a `snapshot` of the character asked about | the account |
| `snapshot` | `/api/roster/planets`, `/api/roster/stock`, the customs haul's plan | each pilot a board lists, or the one hauled for |
| `snapshot` | `/api/bridge/planets`, the gateway's branch | the held pilot when it is the gateway's; on the game port the route reads the colonies as the client does |
| `skills` | `skillSheetFor`, the gateway's branch | the held pilot when it is the gateway's; on the game port the sheet is made from the skill handler's kept answers |
| `skills` | `/api/roster/training`, `/api/roster/planets`, mining preparation, the training queue's review and read | a pilot of the account that nobody need be flying |

Three hosted bots were then run for pilots on the game port, with the same result in the
tally. One of them, the mining cycle, found every belt empty where the same bot through the
gateway found rocks: the game port's snapshot had none of the mining fields the gateway's has
on an asteroid's row. That is mended (`428af02`: a rock says what it yields, which is its own
type), and a bot has since mined on the game port as through the gateway (8692 units of ore
against 8690 in the same time). The two transports' rows were then read side by side, and
three more gaps of the kind found: a drone's row did not say whose the drone is or what it is
doing (mended, `2fbf14f`, with a launch that answered before its drones were in the park), a
ship's did not say what kind of NPC it is (mended, `fd1f032`, with an NPC's ship of a player's
hull that was not taken for an NPC's), and none said a ship is a compression facility
(mended, `7f0546b`; ore was then compressed from the page on the game port).

**Status 2026-10-10, later: the default is `gameport`** (`1dacbb6`), with `gateway` selectable
as the way back, on the host and in a container (`compose.yaml` passes the setting on; the
doctor checks the game port). Seen: the parity tool across a BFF with nothing said and one
told `gateway`, as before; every pilot of every account the store has chosen on the default,
with nothing of a pilot's sent to the web gateway; a pilot chosen in the browser; and a
container built from the tree choosing pilots on the game port at `host.docker.internal`.
The image could not have started before: it had no `contracts/`, which the transport reads
as it loads. With no pilot held, an account on the game port is refused a pilot's call by
the BFF itself (`d6d3de5`), which closes the one case the tally showed of the second open
question in section 5.

**Status 2026-10-10, later still.** Measured on the default since: the training reads (the
same on both transports), an ice site and an ore anomaly (the same but for what is left in a
rock), and three more reads of a pilot who is online here taken off the gateway (a bot's
start, a flown pilot's skills, and whose a character is, which now asks the account's own
list). The whole run the loop's brief names for "done" passed twice from a cold server
start, in the browser, on the game port: login, the docked windows, a courier mission
accepted, a three-jump autopilot to its drop-off, the mission completed, a target locked and
a module cycled, and logging off, with nothing of a pilot's sent to the web gateway.

Not yet measured: the structure directory's reads, a fleet's parking and delivery checks, a
training pilot's corporation fittings, a fleet companion flying, the Factory's corporation
onboarding; and both in containers. One read of an online pilot is left, the roster's
planetary board and stock, and is the operator's to rule on (the loop log, 2026-10-10). The
removals wait for the operator to have run on the default. The steps are at the head of the
loop log's "Next".

### Phase 6 — Browser ↔ BFF over one WebSocket (large, mechanical; independent of 0–5)

Can run in parallel with the phases above; it touches a different hop.

- 6a: one WebSocket per pilot carrying named operations (the existing `/api/bridge` route bodies,
  unchanged) and pushed notifications. Replaces 460 routes' HTTP carriage, the SSE stream, and the
  four-request lane cap in `web/src/app/transport.ts`. Hosted bots call the same operations
  in-process instead of through loopback HTTP.
- 6b (planned; this is what "EVE in a web browser" means for the code): move route orchestration
  into shared TypeScript used by both the browser and hosted bots, leaving only generic `call` /
  `bind` / `callBound` on the socket. After it, the browser decides what to call and when, as the
  retail client does, and the BFF only relays those calls. It is also what makes option C
  (browser speaks machoNet through a relay) a relocation, not a rewrite.
- **Done when:** no `/api/bridge/*` HTTP route remains and no `EventSource` is opened.

**Status 2026-10-10: begun.** The BFF serves the socket at `/api/socket` beside its routes
(`src/pilotSocket.js`, `fa2f060`). A tab says hello with its web session's token, in a frame,
and then sends operations: a method, a path and a body, answered by id with the route's own
status and answer. An operation is its route run in this process (`dispatchInProcess`), so
all of the BFF's routes are operations at once and none was rewritten; asked over HTTP and on
the socket, a route answers the same (set side by side in the tests for each shape of route,
and live for a chosen pilot's reads). Twenty-four reads asked at once on one socket were all
answered, where the page allows itself four over HTTP.

**The page's end, 2026-10-10** (`a69d228`): a fetch of `fetch`'s own shape that sends a request
as an operation on the socket and answers with a `Response` (`web/src/app/socketFetch.ts`),
and one place that says which way the page's requests go (`web/src/app/pageFetch.ts`): HTTP
unless this browser's local storage has `evejs-web-transport:v1` set to `socket`. HTTP is
the way back for what cannot be carried, while a socket is down, and for what the BFF did
not run. A socket is for a session that stays: given at a token's third request, closed at
its logout and when idle. In the browser with the setting on, a login with 25 windows open
made 45 requests over HTTP where it makes 128, and sent 92 frames; an undock and a docking
went as frames.

**The cap lifted for what is carried, 2026-10-10** (`ab125f2`): the page's cap of four
requests at once is for the browser's connections, so a request that goes on the socket's
open line is started as it is asked and holds no lane (`web/src/app/transport.ts`). What
goes over HTTP keeps its turn, and so does a request asked while its socket is being made.
In the browser a login had 32 requests outstanding at once where it had 5; the times were
close (479 to 521 ms against 525 to 797 ms over HTTP, the BFF and the server on loopback).
There is no bound on what one socket has running at once; whether there should be is for
the slice that takes the HTTP carriage away.

**The pushed notices, 2026-10-10** (`7d85247`): where the page is set to the socket, a
pilot's live channel is its socket and no `EventSource` is opened. The BFF runs its event
stream route in this process for as long as the page listens (`streamInProcess`) and hands
each frame on, so the route is unchanged and still says who may listen. The `EventSource`
is the way back, opened if the socket is not to be had. In the browser a login, an undock,
a docking and a logout had the same frames in the same numbers both ways.

**The hosted bots, 2026-10-10** (`f6327fa`): a hosted bot asks the BFF in the BFF's own
process. The bot host is handed a fetch that runs each request through the app where it is
and answers with a `Response` made of the route's answer (`src/inProcessFetch.js`); the
event stream is read as the route writes it. `EVEJS_HOSTED_BOT_REACH=loopback` has them ask
over HTTP as they did. On the game port the starter mining bot ran the same both ways, and
in process the BFF had no connection to itself.

**The bound, and the whole run on the socket, 2026-10-10** (`c996cd6`): a socket runs 32
operations at once, has 512 more wait their turn, and says of one past that that it was
not run, which sends the page to HTTP for it. The brief's whole run passed twice from a
cold start with the page set to the socket. Set beside a pass over HTTP it made the same
93 kinds of call and nine more calls, of two kinds (`dogmaIM.GetAllInfo`,
`account.GetEntryTypes`); the socket is not made the page's default until that is found
and mended.

**The default, 2026-10-10** (`1ebaa67`, `bc9dbd3`): the two kinds of call were the
transport's own once-only askings, once only for askers that came one after another;
mended, the same run makes the same 93 kinds of call and the same 248 calls on the socket
as over HTTP, row for row. The socket is now what the page uses unless a browser is told
otherwise (`evejs-web-transport:v1` = `http` in its local storage is the way back).

Not yet: a pilot in the background has no pushes either way; the routes' HTTP carriage
goes last, and is the operator's to see first.

**6b begun, 2026-10-10** (`2764849`): the first feature's orchestration is out of its
route. The page's wallet asked `GET /api/bridge/wallet`, and the route made five calls of
the server; the page now makes those calls itself, by the generic call, from TypeScript
the hosted bots share (`web/src/bridge/walletReads.ts`), as the client's wallet and
account services make them. The route stands and nothing of the page's asks it. Set side
by side on both transports, the route and the page's own asking answer the same. One
route of the bridge's is done this way; the count of those still asked by the page is
6b's measure. The wallet is also kept as the client's services keep it (`1d27f12`): the
pilot's ISK asked for once and then what the server's `OnAccountChange` says, the
transactions until that word, the divisions five minutes. The standings are the second
(`11f1592`, `web/src/bridge/standingsReads.ts`): the page asks for the two lists and, for
a row opened, its history or its composition, as the client's standings service and panel
do; a call the page makes for a pilot says so, and is refused where the BFF holds none.
The skills' sheet is the third and is in two parts, the first done (`c8de548`): the queue's
read carried on the game port and answered by name from what the transport keeps, and
the server's clock told with each of a pilot's answers. Counted then: 140 of the BFF's 473
routes under `/api/bridge` are named by the page's code, 50 of them reads. The sheet's
making and its reads are in the page's TypeScript (`96c0a09`) and agree with the BFF's, and
the Skills window reads the sheet the page makes (`889150f`). The route is still named by
the page, for the gateway, for one read of a bot's, and behind the writes: a route is off
the page's list only when the way back through the gateway is. The Character Sheet's
route is the first off it whole (`a684b32`): its reads are carried by both transports,
and the page asks them the same way on either. 139 named now, 49 of them reads. Its home
station is asked as the client's own sheet asks it (`ba37865`): of the home station
service, which the game port carries and the transport keeps as that service keeps it.
The agents' journal is the second route off the list whole (`5c2e1f1`): one call, asked
by the page, answered on the game port from the journal the transport keeps. Crimewatch's
states and the clone's grade followed (`e21134c`), and with them the clock for a pilot
through the gateway. The scanner's read of the ballpark's formations was no read of the
client's scanner at all, and is gone with its readout (`964c083`). The first write
followed (`836fff6`): the pause of training, made by the generic call when it is said to
be a pilot's (`pilot`), said to be meant (`confirm`) and on the BFF's list of the page's
own writes; any other write is refused there as before. The queue's save
followed (`cea56d7`), by the client's own call on the skill handler, which the game port
alone carries: through the gateway the page is refused, with nothing saved, and asks the
route. The page's 89 writes were sized then: 7 are a confirmation and one call by name,
36 a call on an object the BFF binds and holds (10 of them flight commands), 4 moves
between places, 5 no writes at all, and 37 more than any of those. A change of the queue is
saved started or not as the client's queue service decides it (`bcf13d5`): unstarted
where every training slot of the account is in use by its other characters. Free points
are put into a skill by the client's own call too (`0c81ff1`), which either transport
carries, so its route is not named by the page; and so is the ship's safety level set
(`2783179`), whose check of the level is the server's now; and so is a contract taken
on (`e1fa602`), for the character alone, once the server had been made to want the
Contract Manager role of whoever accepts for a corporation (eve.js `378ef753f`, and
of whoever makes a contract for one or reads its containers: `cc27a59dd`, `4f6922a29`;
all unpushed there); and so is a planetary launch's record removed (`12885f1`), which
a bot's collecting of one does once it has read the container empty; and so are a fleet
applied to and a broadcast made to the fleet's members in the bubble (`82a21e8`), the
second with the wait the client keeps before one; and so is a module overloaded and cooled
(`431b964`), the first of the writes the BFF made on an object it bound for itself: asked
of the dogma service by its name, made by the game port on the dogma location it keeps, and
naming the module's own overload effect, which the page asks of the static data; and so is
a module's repair (`766627e`), which the page begins and, as a client does, ends itself
when the repair's time is up: the server mends a module only then, and the page's repair
had mended nothing; and so are a ship's weapons linked and unlinked (`4bd05a7`), each call
naming the ship the pilot is flying, once the server was made to hold a bank call to that
ship (`eve.js` `515ebd911`); and so is ammunition loaded and unloaded (`80741d7`), the
ship and the place named as a client names them, once the server held both calls to where
the session is (`eve.js` `e4b924e00`); and so is a fleet's target tag (`7975818`), the
first of the ballpark's calls to be made so, which the game port makes on the park's own
object. Two functions of the page's that nothing called went with it. And so are drones
sent to salvage (`961f1d1`), with every drone order asked by name now made on a Moniker of
its own, as the recordings have them. And so is a ship sent to a point (`4a2d7c8`), held
by the page's own read of the pilot's flight to the ship and the system the point was
measured in. And so is a colony's network changed (`508ac6d`), the first of the page's
calls to be made on an object for a thing the page names: the generic call says which
planet, and the BFF makes the call on the object bound for it. And an extractor is
restarted as a client restarts one (`29cdbe2`): the planet asked what the programme will
yield, then one change, where the page made two. And a colony's commodities are launched
on the planet's object too (`5b2a215`). And a docked pilot's ship is left by the page's
own call (`e56b7b9`), which the BFF makes under its own watch of the swap, as the route
made it: its word for the pilot's ship is kept there. A corvette is boarded so too
(`e91f60a`), with the client's two arguments, its refusals and its question, the game
port's flight saying the hull's group for them. An office's price, its rent and its
giving up are the page's own calls of the station's office manager (`b0bbfff`), the page
going by its listing of the offices and its flight for what their routes checked. The
scanner's sites are asked of the system's scan manager by the page's own call (`4fb2656`),
which names no object, the session having one. A GM's command goes by the page's own
call of the slash service (`169ec79`). The repair shop is asked as the client asks it
(`07b0ca1`): its quote and its two repairs on a Moniker the game port makes for each
call, where the route sent a call of the server's own. A fleet is left on the fleet's
own object (`f62b1b0`), the BFF choosing between that and the forced leaving as its route
did. A ship is aligned by beyonce's `CmdAlignTo`, the thing by name (`228b0d1`), with the
pilot's flight read before and after by the page. An approach and a keep at range are
beyonce's `CmdFollowBall`, and the autopilot's approach the throttle and then the follow
(`b458395`), the BFF holding a follow back or opening the gateway's throttle as the
routes did. An orbit is beyonce's `CmdOrbit` (`03dc5c7`), one of those follows, its range
a float under ten metres and a whole number from there. A stop is beyonce's `CmdStop`
with nothing (`1b6fd44b`), which the BFF neither holds back nor opens a throttle for.
A fleet is formed by the fleet handler's `CreateFleet` (`0d059c45`), the BFF making it and
the `Init` on what it answers, as the route did; from a session in a fleet the game port
asks nothing, as the client does. An invitation is accepted by `AcceptInvite` on the
fleet the call names (`d6fd20b6`), the second kind of object the page says with `of`.
A pilot is invited by `Invite` on the pilot's own fleet, the invitee alone
(`d551e8a6`), with an `of` that may be said: the fleet the invitation is held to.
An invitation is turned down by `RejectInvite` (`95623391`), which the page could
not do at all before: a call, a button, and the client's own turning down from within
a fleet. It took no route off, nothing of the page having asked one. The inviter is
told of it (`3a204509`): the server's notice read, and said in the page's words in the
Fleet window and on the notice board, with no call.
A place in space is bookmarked by `beyonce.BookmarkLocation` (`c27b24a2`), asked
by the service's name and made on the park's object by the game port.
A target is locked and let go by `dogmaIM.AddTarget`, `RemoveTarget` and
`CancelAddTarget` (`018ca9f7`), the read of what is locked after each made by the
flow as the two routes made it.
A drone is scooped by `ship.ScoopDrone` (`6d6aef22`), the page's own read of its
drones after it in the place of the route's. The jettison is left to its route: it
does three things by what the BFF alone knows.
A finished job is delivered and a job stopped by `industryManager.CompleteJob` and
`CancelJob` (`fa17f327`), each with the job's own solar system and judged by the job
the server answers. **The Industry window's install cannot be sent on the game port**
(found the same day): it is the next unit.
The Industry window previews and installs on the game port (`c027a911`): its two
routes' request is made the client's own dict there. No route moved by it.
Both kinds of defect found there are looked for now by an audit run with the suite
(`npm run audit:game-port`, `e62613a4`): it found nothing a window can meet, five routes
nothing of the page asks that pass on an object of the browser's, and **fourteen bridge
routes the page names that no test asks**. Next: those fourteen, the reads among them
moved to the page's own calls, `fleet-ads` first.
The fleet finder is read by the page's own two calls (`71aee531`); thirteen of those
routes are left, `pi-colonies` next.
A pilot's launches are read by the page's own call (`aed09283`): `pi-colonies` was asked
for them alone. Twelve are left, `shared-fittings` next. The saved fittings are read by the page's own
call for each owner (`6110e28a`): two routes were one reader's. Eleven are left,
`bookmarks` next. A pilot's bookmarks are read by the page's own call (`c951e615`): a
read that failed had been answered by the route as nothing, and read by the page as no
bookmarks. Ten are left, `corp-members` next. Whether a pilot is of the corporation is known by
the page's own read of its members (`1602ef9f`), as a client knows them: the route had
been asked for a member's row, a call no client makes for a stranger. Nine are left, the
two of `assets` next. Where a pilot's things are is read by the page's own call
(`83e7bbdb`), on the pilot's own container: the generic call had no way to that object,
and has a kind for it now. Eight are left, `assets/station` next. What is at a station
is read by the page's own call too (`a4320fca`), with each type's volume asked of the
BFF's static data by a new read, `GET /api/types/volumes`: what a client has in its own
files is no call of the server's. Seven are left, `agents` next. A station's agents are
listed by the page from the whole table, asked for once by its own call and kept
(`52816a60`), as the client's agents service has it: the route had carried a station's
handful, and every agent to a pilot in a structure. Six are left, `combat-utility-types`
next, which is static data and no call of the server's. It is read at
`GET /api/types/combat-utility` now (`33d8f0dc`), and the path under the bridge's is
gone: 472 routes are under it. Five are left, `character/creation-state` next. That one
stays a route (`20062548`): half of it is the BFF's own mark of a creation under way,
which a client has nothing like, and it has tests now. Four are left: two warps, whose
keywords are not a client's, and the jettison's two. The warps' keywords are made the
client's on the game port by the ledger (`e49f282b`), whatever a route gave, and the two
routes have tests: two are left, the jettison's. A scan site is warped to by its label
where a client warps to an anomaly by its site's number, as an item: next. That is the
page's own call now (`6e0a27ec`, `bridge/movementWrites.ts`): `beyonce.CmdWarpToStuff`
is one of the page's writes, and `flight/warp-scan` is asked by nothing of the page's.
The bookmark's and the launch's warps are next, then the fleet member's, the item's and
the autopilot's. The bookmark's and the launch's are the page's own calls too
(`690bc262`), and a page's warp is held by the BFF to what the client's menus make: the
server's handler would fly the ship to a point a caller gave. The item's and the
autopilot's are next, then the fleet member's; a mission's marked spot is warped to by
the ballpark's call where a client asks the agent, and comes after. Those three are the
page's own calls too (`832dcb2a`): every warp of the page's is, and the five warp routes
are asked by nothing of the page's. A mission's marked spot is next; then the page's own
autopilots, which warp by the menu's call where a client's autopilot warps by its own.
The mission's spot is warped to by asking its agent now (`77464628`), with the spots
taken from the journal: an agent is an object the page names. The page's travel
autopilot warps as the client's autopilot does now (`9350fd89`), and a warp's floor
follows the call that makes it. A pilot's own Dock and Jump fly as the client's system
navigation again (the menu's warp at nought, the menu's approach), and the autopilot's
approach to its last station is the menu's under fifty kilometres (`e659cdac`); the
page's measure of a closing ship was set beside the server's: the page's ship ran ahead
after a warp because the server had left its greatest speed a tenth too high, which is
the server's and is fixed there. The recorded warp was taken again on the fixed server
(`96c4fb20`), and the park's tests brought to it. The server's answer to a refusal waits
for nothing (measured: 10 to 20 ms by the asker's clock; its log's line is stamped late).
A pilot at rest within 100 km of a station is put 500 m off it at each login by the
server's own rule (measured on both transports; left for the operator). A bot's own
approach is the menu's now, a follow at fifty metres with no throttle (`cd6306c6`). A
thing the sensor suite has a bracket for was read to its end, with nothing to build. The
bridge's routes were counted off the app's own table, and none taken away: 483, of which the
page names 95, tests alone 217 and nothing at all 149. A write by the generic call is a
write to every gate of the BFF's that tells one by its path now (`15d2bbb9`): a hosted bot's own
fetch while its session recovers, a session's change, a hosted generation, and the flight routes'
gate while lost drones are looked for. The audit's routes are the app's own now, and
a route is the page's where any of the page's sources names it (`0f6c6137`): it names 219 routes of the
page's where it named 187, and says of 34 that no test asks them where it said 23. What the static data says of a type
is asked once and kept now (`1478046f`): three of the flow's nine askers by type kept nothing. Seven of the
page's plain reads that no test of the BFF's asked are asked now by the page's own askers of the BFF's own
routes (`d36eba9e`), and 27 routes the page names are asked by no test still. The calls the client makes on an
object were counted (`ff7e1ec4`): none of the page's own goes by a service's name where a route makes it on an
object, and the audit fails for one that does. The page's other static reads were counted: nothing is asked in a loop but
a mining support ship's compression table, and the map's graph, 745 KB an asking, is asked for twice at a
pilot's choosing. The graph is read once for a page now
(`09879964`), kept by the fetch it is asked with. The audit looks at every call the page makes by the generic route now, a
pilot's or not (`16242cd1`), and all 80 pairs the page's source names are made by a test of the page's. The
bookmarks' answer was set beside the recording (`78e11a7b`, comments alone): nothing a client meets in a row's
form or in a folder's names, and two things named for the operator that no recording settles (this server's own
"Agent Missions" folder, which a client would list among its folders that are not active, and its making of a
pilot's first folder where a client makes its own). A pilot's bookmarks are asked for as its character is chosen
and kept by the game port's transport (`1d9703f3`), as the client's bookmark service keeps them: a bot's warp to a
saved spot reached the server with one asking, where 18 had in its first 26 seconds. The fleet's answers were set beside
the recording (`e9bf2d8f`): the page reads a fleet's state in the recorded form; and the list of advertised fleets,
which handed every pilot each boss's four sets of whom it lets in and keeps out where Tranquility's has None,
answers None for them in `eve.js` (`919c28959`, a sub-agent's, not pushed by this loop). A place bookmarked on the
ballpark's object, the page's one write of a bookmark, is worked into what the transport keeps as the client works
it (`7731baf3`): nothing is asked after it. The recorded fleet's whole course was run live with two pilots on each transport, and this server tells each what Tranquility told, step for step: of the fourteen differences another hand's note has beside that recording, eleven hold no more. The install by the client's own reckoning was sized and not built (`0fcae679` for a job's product, sent as None where the page names none, and three of industry's reads judged): its cost, its tax and its time are each a unit, since each must be the server's to the whole or a working install is refused. A manufacturing job's time is reckoned as the client's own job reckons it and sent with the job (`768c2e3b`), seen accepted on both transports and in the tab, with godma holding the pilot's own character for the pilot's attribute; this server's own reckoning multiplied in another order and refused a job whose time is a half second, which a sub-agent fixed (`d6db121a0` in `eve.js`, not pushed) and which was seen taken after. The region's facilities are kept as the client's facility service keeps them (`1a1e816e`): asked for once where the same course through the gateway asks nine times, let go at the server's word of a system's activity and in another region, and a facility asked for by itself at the server's naming of it, at a job's refusal and for a job given one with rig modifiers. The price table is asked for two seconds after a pilot's login, as the client's cfg asks for it, and kept for the pilot (`39bf7255`): the login's report has 39 kinds at login and 44 never. A job's cost was sized beside it and is a unit of its own: this server charged twice what the client's reckoning makes of the one job measured. A manufacturing job's cost is reckoned as the client's own job reckons it and sent with the job on the game port (`1cc75e6b`), seen taken and seen held; "this server charged twice" was two numbers that are not the same one, and is withdrawn. This server refused an alpha clone's job at the client's cost and charged for a blueprint the client reckons free, which a sub-agent fixed (`9adca66a3` in `eve.js`, not pushed) and which were seen right after. A manufacturing job's tax is reckoned as the client's own job reckons it and sent with the job on the game port, and the preview answers the fee the client adds up (the cost, the tax, the SCC's surcharge and the security tax), which the Industry window says before the pilot agrees (`91eed6b1`): seen on both transports and in the tab, the fee said, the job's cost and the wallet's change the same. No facility of the region has a tax and no system a gate reaches has the security tax, so each is in tests only. A structure was staged for industry (`1b61ae13`): a tax other than nought was seen sent and taken; a job in a structure, which was not installed on the game port because the BFF's client marshal wrote a long inside an extended object as an int64, is installed; and a structure's tax is reckoned by the access of the service the job is done by, sent with the job and said in the fee, on the game port and in the tab. Rig modifiers, the facility asked for afresh and the facilities' notice are still in tests only. A manufacturing job's materials are reckoned as the client's own job reckons them, sent with the job and said exactly in the Industry window (`c51605fd`): the client's own Python was asked for its rounding and for the quantities the tests expect, and a job was seen to say and take the same in an engineering complex and in the tab. This server reckoned a material in another order and rounded it another way, and refused the client's job for some of the game's own blueprints, which a sub-agent put right in `eve.js` (`d925ef3d8`, not pushed), with a copy job's materials by its licensed runs, each seen right after. A structure was staged with rigs (`6c1717ac`): rig modifiers were seen in the facility's row and in a job's time and materials, said and taken to the unit; the facility was seen asked for afresh before a job there; and each job the server answers is now given its facility afresh, as the client's industry service makes its jobs, seen asked once for each job at the rigged structure at a reading of the jobs. The facilities' notice is still in tests only. On the game port the job the Industry window has is kept as the client's window and its industry service keep theirs (`ce2ff2a8`): its monitor opened once and let go at the window's close, a facility's places kept a minute, the job given its facility once, and the window's own events given a route the page sends; seen by the server's own log on the game port and in the tab. A copy job is reckoned as the client's job reckons it (`e35ce245`): its time, its most copies, its cost, its tax and its materials, each by the runs each copy is licensed for, which the page now asks; any other job goes with the blueprint's most licensed runs, as the client's does; and a blueprint is offered only the work that is for it as it is. The server took each copy job sent, on both transports and from the tab. A research job, of a blueprint's time or of its materials, is reckoned as the client's job reckons it too (`1b5740a5`): its time by the level the blueprint is at, its runs held to the levels that are left, its cost and its tax of its own base, and the SCC's surcharge halved; the server took each research sent, on both transports and from the tab. This server charged for a blueprint the client prices at nought (one whose manufacturing materials are served no price): its price of a blueprint was made the client's in `eve.js` by a sub-agent (`edc0b26ff`, not pushed), and the same job was seen charged nought. An invention is reckoned as the client's job reckons it too (`907e8d59`): its time by its runs, its cost and its tax of the price of the blueprint it is to make, its materials with the place of its decryptor chosen or not, and the blueprint to invent asked of the page where its recipe has several; the server took each invention sent, on both transports and from the tab. A reaction is the one kind of work not reckoned still. A pilot docked in a structure has its hangars on the game port (`6e822f73`): the 409 it met was the stock policy's refusal for the web gateway, which stands there; on the game port the structure's services are asked and kept as the client's service keeps them, the BFF's check of a service is the client's own rule, and the hangar is bound as the client's inventory has it. A structure's repair shop was seen there next (`b0eddeb9`): the page's own call, free on this server, with its words for a repair that costs nothing. Reprocessing's two calls were made the client's (`b7900389`): the quote asked with each item's own row and the ship, the reprocessing with its output named, and what is reprocessed taken from the server's own answer; seen in a station on both transports and in a structure on the game port. The page's refining was made reachable (`cd8ff54e`): its Mining window is offered docked as well as in space, and the reprocess route finds each item's own place (the hangar, or a hold of the ship) and makes one call for each place, as the client's reprocessor does; seen in a station on both transports, in a structure on the game port, and in the tab in both. The market in a structure was taken as far as this server goes (`59cf6b95`): an order placed in a structure names the structure's own market tax as its rate, asked of its settings as the client's market service asks it and kept two minutes; three faults of the server's that it found were mended there (`eve.js` `6016fd537`, `176e019b5`, `64c616319`). No order can stand in a structure on this server, its market daemon knowing stations alone, which is the operator's to decide. The hangar's ore is picked for refining in the Mining window (`baff6b97`), listed there while docked; a stack of too few is said to have nothing to process, and is not offered. The corporation's office in a structure is listed, rented and given up from the Station panel as in a station (`5c641fd7`): the transport carried it already, and the page's three calls, which refused a structure, go by the listing of where the flight has the pilot docked. A structure's guests are asked by the transport as its pilot docks there, kept and changed by the server's two notices as the client's structure guests service has them, and listed in the Station panel (`14f705f1`); what else a client asks as it docks in one is for things the page has not, or is asked by the BFF where a route wants it. A structure is not called a station where the page names it (`d13451e8`): the hangar is the client's "Item hangar" in a station and in a structure alike, the workspace header names the structure, and the tab over its services is "Structure services". A clone jump into a structure, which a sub-agent found telling the structure's guests of no arrival, is mended on the server by a sub-agent (`eve.js` `27fa56ce4`), on the server's own tests and not seen on the running server: no recording has a clone jump and the page makes none. A reaction's job is reckoned as the client's own job reckons it (`e75831a3`): its time, its materials, and on the game port its cost, its tax and its fee, of the formula's price by its reaction's materials; seen accepted by the server in a refinery on both transports and started from the Industry window. Every kind of work is reckoned now. The page's job is made as its blueprint is chosen (`2977f456`), as the client's industry window makes one: at the blueprint's own facility, by its first work there in the client's order, and what it will take asked at once; seen in the tab on both transports. Six of the 27 routes the page names that no test asked are asked by the page's own askers (`8592e805`): one bot of the library and its deleting, who has a pilot, and the icons' three; no wire was found broken. Seven more are asked so (`7f27ad17`): a Mining Operation's target as its hosted bots work it, and the Mining window's delete. Four more are asked so (`76b0f3ae`): a Mining Operation's support pilot, and a support anchor released. The loop was paused there on 2026-10-12, at the operator's word, and taken up again the same day. Five more are asked so (`fa5442b9`): a look at a held pilot's custody, the Ship Provisioning Center's sign-in, its poll of an Apply and its recover, and the Mining window's preparation options. Three more are asked so (`58fbaf84`): the Pilot Training page's equipment plan, the plan applied, and an Apply's control recovered. The last two are asked so (`5e8f2ba6`), a jettison's three ways and its custody's look, with the real bot host: of the 27 routes the audit named on 2026-10-12 as asked by no test, none is left. `ship.Jettison` has its entry in the table of the client's calls (`9eac3214`), and a jettison was seen live on both transports: the call is the client's, and on the game port the can is in the pilot's scene one to two seconds after the answer, where the route's branch for a Mining Operation waits 400 ms. That wait is built (`bb621a08`), proven by its tests and not yet seen live, and a dumping refused inside the server's three minutes is said so in the Mining window (`55a95114`, seen in the tab on the game port). A mining operation was run live on the game port (2026-10-12), by the page's own askers from a script and from the Mining Command Center in the tab: staged, prepared, mined, jettisoned (the can in the miner's scene 1.4 s after the call, inside the route's wait), hauled and delivered. Two things stood in its way and are mended: this server gave two connections of one account one client ID, so the pilot that came first was told nothing more of space (`eve.js` `2c8eb9a6d`: a client ID is its connection's, counted as CCP's proxy counts its clients), and the game port's scene did not say whose the pilot's own ship is, so a hosted miner's jettison was never issued (`e3b89ca5`). A missile in a pilot's park stopped the park; the MISSILE mode and the launch of one are ported from CCP's destiny (`2fd33844`), and a pilot under rockets, torpedoes and heavy missiles has a scene that goes on, seen by script and in the tab. This server takes a missile from afar away when its flight time runs out and not at its hit, as Tranquility does: found, and the server's to mend. A hosted jettison that is refused now says why in the bot's log (`4dc4ea87`), and the survey scan has its entry among the client's calls (`51d7e256`); the scan's route still asks from any ship, where the client asks only from one with a mining scanner upgrade. A charge in space has its kind on the game port (a missile, a bomb's too, or a probe, by its group as the client tells what to draw), and a missile is on no overview of the page's, as it is on none of the client's (`74164a90`). The survey scan is asked of the server only from a ship with a mining scanner upgrade, read from godma on the game port as the client reads it (`b9f50d90`); off the game port it is asked from any ship still. This server holds a missile that has 1.6 seconds or more to fly after its hit, on purpose and for the client's warhead, where Tranquility removes every missile at its hit with the damage at the same stamp: measured on 2026-10-12 and left for the operator, since the change is the server's missile moved as CCP moves it. A pilot whose ship the server changed by itself (one destroyed, and the pilot in a capsule) is followed as the client follows it: the BFF's held session takes the ship the flight status names (`464300c5`), and the ballpark's ego is made that ship as gameui makes it, with no state from the server (`44b9d4d7`). The client's clearing of its locks at that change is asked as gameui asks it (`ace96c12`). Godma's priming asks for what godma does not hold, the character at a session's first alone, and keeps what it held of the character across it (`9dc1b613`); it is still made when something wants the ship's readings, where the client makes it at the session's change. The ship's fighters are asked for at the choosing and at every change of the session's ship, as the client's fighter state asks (`9b9489ed`): of the client's 100 kinds of call at a login the game port asks 40 at login, and 43 not at all. This server's differences from Tranquility that were found and left are mended in `eve.js` before any new unit of the game port's, the game port's side after each: the first, `dogmaIM.GetAllInfo`'s later form in space, is done (`e022ff28`; `eve.js` `c2d97f14f`, `426863cff`, `a54b51e7d`), the ship's own row in a ship's state has amounts as Tranquility's has (`aa3bb03f`; `eve.js` `9a8de654e`, `f0a2456d2`), a controlled structure has its capacitor's charge among its attributes and its own row in amounts (`eve.js` `bf5a6f395`), the heat part of a ship's state is the ship's own (`eve.js` `a11aad56f`, `70bcc8230`), a ship's rack heat is the ship's, among its attributes and kept with it when it leaves space (`eve.js` `a5a493072` to `826704e38`), a ship's attribute values and a structure's go out as floats (`eve.js` `ff512ce4f`, `b21d726b3`), a module's go out so too but for the few that are integers on Tranquility (`eve.js` `506366730`, `79c589909`), the new and the old value of a changed attribute go out as floats too (`eve.js` `60e27e473`), a module lists its charge beside its shieldCharge (`eve.js` `b3097a74f`), a character's attribute values are floats but its own five where nothing is added to them, in its item, in the first answer's second dict of them and in a change's notice (`eve.js` `960e8ed55`, `607e9fad0`, `f201b5b1d`), a character's item lists the whole character (`eve.js` `27447edca`), the second dict of a character's attributes has Tranquility's form (`eve.js` `c9cd66f15`: None, or what the ship's fitting changes), of item 60's recorded differences a station guest's four go out as a list and the notice of a system's flags carries three sets (`eve.js` `d31b58021`, `49c3c99fa`), an office's three are mended too (a rent answered None, the price a long, the notice by station and by corporation; `eve.js` `f89da41c0`, `75b222d73`, `215874210`, `4f0cf3057`), a structure's two notices of a guest are addressed by `structureid` and a jettison is answered two lists (`eve.js` `ee422dd53`, `eb98396ae`): item 60's recorded differences are done, and the subscription's two notices are sent (`eve.js` `6fac42e03`, `6ad3fcf68`): `OnSubscriptionTimeUpdateServer` first at every selection, as Tranquility's recordings have it, and with `OnSubscriptionChangedServer` when Omega days are bought; a license that runs out under a client that is online is told to it, by a watch kept on the end of an account's Omega time (`eve.js` `4413af1a1`), and an outgoing packet's line in the server's log carries its own time (`13b3507ea`, `19b7f9052`); what else Tranquility sends between a selection's call and its answer is read: a session is sent the tales of the solar system it has come to (`eve.js` `9da9aa017`) and the tale manager's answers send none (`e4700d089`), and the fitting's events ahead of a docked login's session change are left, as the client drops them; the game port hands an office's price back to the station the long it came (`00cc731a`: the page is handed the price with its long kept, and the rent's argument is a Python long as the client's is); three of industry's four differences are mended (`eve.js` `6477e338c`, `9528d3c63`, `68cb679aa`: the industry security tax in a job's total, a research's base in the client's order, and a job installed whose request came with an int64); `OnIndustryMaterials` is sent to a session's monitored job when what its place has changes (`eve.js` `83c66feb6`) and the transport puts its word into the monitor's answer it keeps (`8f8621c0`); the page's Industry window shows the notice's word at once, as the client's does (`68d3eb62`), seen in the browser; the skill history is answered in Tranquility's form (item 59; `eve.js` `54125d9ff`, `a0fd2e19c`) and read so by the page (`a51216b2`), seen live on both transports; the page's Character Sheet lists it as the client's History panel does (`ff0e09f3`), seen in the browser; the missile from afar, the server's, is sized and split: a measure of each missile's touch in the client's own park is built (`18ef1998`, `scripts/missiles-in-park.js`) and this server's baseline taken by it; the server now keeps, for each missile, the ball a client's park makes of it and knows the step it touches in, to a step (`eve.js` `6117e48fe`; live, three of four the same and one early, the launching NPC being several hundred metres nearer on the server than its ball is in a client); the NPC's place is measured (`cf8f25e4`): a rat's ball in a client 1.1 to 2.2 km from the server's rat through its approach, for four reasons told apart, one pinned to a stamp (its change of top speed is given the client a stamp before the server's own rat slows); that one is mended (`eve.js` `b8c6c4834`: an NPC's change of top speed is given the stamp the server's own NPC changes at; the ball 292 m from the rat where it was 1,231 m, and five of five missiles' touching steps the client's); the stamp of an NPC's follow and orbit orders is asked for where its own movement changes (`eve.js` `3378afe85`), and kept where the delivery does not raise it (5 of 8 sends in one flight); found beside it, a moving ball a second of its own travel out in a whole state, the pilot's own ship once in four flights: mended (`eve.js` `23459f2b3`: the first whole state takes its moving balls where the scene will have them at its stamp; a rat 144 m from its ball as the pilot came in, now under 4 m); found beside that, this server's once-a-second movement cadence not on the clock's second after a quiet scene wakes, while every stamp is the clock's second: mended (`eve.js` `ba3422279`: the cadence kept on the second through a resynchronisation; a ship undocked into a quiet scene 0.0 to 0.7 m from its ball where it was up to 128 m); the delivery's raise read, measured and left as it is (a client's park stands up to three ticks ahead of this server's stamp, moved by the spread of the stamps it is sent: `scripts/park-tick-against-stamps.js`, `af77619c`); one stamp for one moment is under way: every sender's stamp sized by the entry's name, and the first mended (`eve.js` `37e38b889`: the periodic anchors of settled ships, which Tranquility never sends and which moved nothing in 29 tries, are off; 1 `Stop` in a flight where there were 13); what draws a park ahead is one lead that a damage state, a weapon's effect and a missile's launch and removal share (`MICHELLE_HELD_FUTURE_DESTINY_LEAD`, two); tried at one, on disk only and put back (`eve.js` `32756a62f`, its ledger), it gave a park at the server's stamp for 50 updates of 55 and a rat's ball 0.3 to 0.5 m from the rat where it is 168 m, and it is **the operator's to say**, since what the retail client shows of it is not known; a whole state authored in one second and sent in the next now has its balls taken for the stamp it leaves with (`eve.js` `869ee9c0f`: the pilot's own ship 0.0 to 1.0 m from its ball after two such undocks of twelve, 145.9 m before); the senders that looked to be outside the lead were read and are inside it or as Tranquility's (`eve.js` `e32f96740`, the ledger), so one stamp for one moment rests on the operator's word on the lead; found beside them and written down unsized, a ship's massive flag, which Tranquility keeps set in space and this server does not, having no collisions for ships; of (5b8), an NPC's first order no longer waits (`eve.js` `3c96302d8`: a new ball's movement was held from a session three ticks past its acquisition and is held now only until the session's stamp has passed the stamp of its `AddBalls2`; a rat's first `Orbit` sent 0.875 s after it was given where it was 2.71 s, its ball 0.7 m from it where it was 443.5 m at the worst); an NPC's way home, anchor orbit and abyssal turn now ask for the stamp its own movement changes at (`eve.js` `24a41a763`: a rat sent home while its pilot looked on has its `GotoDirection` stamped the stamp after the command's in six of seven; the note of a rat steered by `cmd.goto` with nothing sent was a rat going home after its pilot had gone); the whole state sent again in mid-session now takes its moving balls for the stamp it leaves with (`eve.js` `689de3af3`: the pilot's own ship 0.8 to 14.0 m from its ball after each of six such states where it was 28.4 to 169.9 m behind), and the second a GM's rat waits before its first order is the GM's spawn's own asking, left; (5b8) is done. Of the acting at the touch: the server's copy of a missile's client ball now launches at the stamp a client is given (`eve.js` `2f6b99e18`: the client's launch stamp and touching step for seven missiles of seven, where its touching step was a step or two early); the acting itself (the damage, the explosion's entry and the removal at the stamp the touch is done) waits on a look at missile visuals in the retail client, which the server's own ledger asks for before impact or release timing is changed. What this server answers to a first call sent to `Address::Any` was read: it answers it, where Tranquility refuses 125 of 294 such with `WrongMachoNode`; the client keeps a service's node from that refusal alone, so the retail client on this server sends every call of a service by name to `any`, and the game port does the same, service for service. Nothing was changed. Of the rest of what the client asks at a change of ship, the first is done (`40c02295`): each mission the pilot has accepted is asked after as the client's mission tracker asks, `missionTrackerMgr.GetMissionInfoItems(agentID)` at the choosing, at every change of the session and as a warp ends; the second is done too (`873de6dd`): the ship's free turret slots, which the client's achievements handler asks of the ship's own inventory at every change of the session's ship, owed from the change and asked as godma is next primed; the moment of godma's priming (at every change of station, system, ship, character or structure, in the client) was read and left as it is: the game port primes when something first wants the ship's readings, 0.22 s after a choosing with nothing opened, and moving it would mean some hundred assertions of the old pilot tests rewritten unrun for nothing a page shows. The login's own list is next, and its first is done (`501c5a84`): the pilot's jump timers, asked once at the choosing as the client's crimewatch service asks them, kept, and from then on what the server's `OnJumpTimersUpdated` says; and its second (`cee8eb78`): the wars, had as the client's war service has them, the war registry reached by its moniker for the pilot's alliance or corporation, an owner's wars asked for at the choosing, kept twelve hours and asked again then, and the server's `OnWarChanged` worked in (the asking at a change of alliance or corporation done too, `f2ce8c39`, with a server defect fixed on the way, `5b34dd917`: a corporation made after the server started could not have its runtime written, and the GM's `/corpcreate` failed on it; and the BFF's held session, which kept the login's corporation after such a change and its routes with it, goes by the session's own now, `44be60b9`); and its third (`fd0c7cda`): the occupation state of the solar system the pilot is in, asked once for a system as the client's warzone service asks it for its location panel, at the choosing and at each change of solar system; and its fourth (`77010339`): the system's bounty output, the same panel's other asking, kept ninety minutes and asked again at each change of solar system, with the server's answer to it mended (`cc6890e47`: `(0, 0)` where Tranquility answers `(1.0, False)`); and its fifth (`1c682e45`): the solar systems whose security is other than the map's, asked once as the session first has a solar system, with the server's answer to it mended to Tranquility's own (`a948b600a`); and its sixth (`168bc37b`): the character's settings, asked once as the pilot comes in and kept for the session, with the server's answer to it mended to Tranquility's form (`fc7f85ffc`); and its seventh (`c89be25f`): what the character has completed of the client's achievements, asked once as a character comes onto the session; and its eighth (`a293316f`): how many non-diminishing skill injections the character has left, asked as a character comes onto the session and counted by the server's three notices; and its ninth (`f020fef7`): the season the character may play, asked once for a character on the session, and its progress in it where a season is its own; and its tenth (`d1298c33`): the logon told to the milestone manager, which on this server starts the account's login milestone, so that a pilot on the game port earns it as a retail pilot does; and its eleventh (`73f82d5f`): whether the character may play the tutorial, asked once for the character; the tutorial's other login call, `air_npe.get_air_npe_state`, rests on the operator's word, because on this server it resumes the AIR tutorial for the session; and its twelfth (`5cd1aa7b`): the insurgency campaigns a client may see, asked as the info panels are looked over, at the choosing and at each change of solar system, and kept half a minute; and its thirteenth (`bf601703`): what the account may redeem, fetched as the neocom is set up for a pilot come in and again at the server's notice; and its fourteenth (`1b180463`): Project Discovery's two askings of itself (whether the character has done its tutorial, whether the project is enabled) and a QA session's telling of its QA wrap; and the chat's login (`3d9530a7`): a pilot on the game port asks the server the chat's hostname, its address, a secret and the channels to join, as the client's chat service does, and its chat connection is made with what answers, and (`20a843e9`) the stanzas it sends are the client's own, each as the client's XMPP handler writes it, set beside a retail client's connection in the stub's log , and (`82986a37`) its chat follows its session as the client's does, the channel of an old value left at the change and the new one taken as the server sends it , and (`3611198a`) it reconnects and checks a quiet channel as the client does , and (`5f0b9627`) it checks each line for spam as the client's chat window does, with the banned domains asked of the server as the first line comes (the chat's four steps and the reconnect, all made; the pilot's own filters are left to the page that will draw the chat); and (`8a6c3738`) what a client asks of itself before a character is chosen is asked too (the cfg's planets and old stations, whether the AIR tutorial is enabled, the raffles' ban, and where the character may be loaded, of the population cap's moniker); 14 kinds of the login's calls are asked by nothing of ours by the report's count, and none is left unread: eight before a character is chosen are the character selection screen's own or its player's (the daily rewards, the lapsed game time's warning, the portraits' paper dolls, a reward claimed and a portrait changed) and wait for a page of that kind; of the six from the choosing on, the client's own logging (two) was read and is not made (its statistics of its own machine, and its report of a ballpark that did not come), one is the inventory window's, two a drawn ship's, and one rests on the operator (the report goes by a call's name, and counts the redeeming's asking before a character is chosen as asked, which the game port makes only from the choosing on) (`docs/game-port-login-calls.md`). From 2026-10-13 no test is run in the loop, by the operator's word (the brief's section "Tests"). In `eve.js` an advert's text outside ASCII goes as
unicode (`dcd459b0d`; on its origin since 2026-10-11, pushed by another hand than this loop's), and a dock
asked from out of range of a station is finished by the server, as Tranquility finishes
it (`869b28d2b`), and a pilot's client is sent no greatest speed for its ship
when it warps, as Tranquility sends none (`c0580dd05`); both are on its origin since 2026-10-11,
pushed by another hand than this loop's.
Counted by the whole path
off the app's own table of routes, 95 of the bridge's 483 are named by the page now: 93 in its
`api.ts`, 40 by GET and 53 by POST, and the generic call and the event stream (the counts kept
before were by the source's text, `app.get("…")`, which has 472 of the routes and 82 of the 93:
eleven are registered by a list of paths, by a helper or from another file). Of the phase's "done when", "no
`EventSource` is opened" holds with the setting on and the socket up, and not otherwise.
Of 6a's four things, three are carried by the socket or in process, each with a way back
(the routes' operations, the pushes, the hosted bots), and the cap is lifted for what is
carried; what is left of 6a is the taking away. 6b is next: a feature's orchestration
moved out of its route into TypeScript the page and the hosted bots share.

---

## 4. Risks

| Risk | Effect | Handling |
|---|---|---|
| Ballpark simulation is larger than expected | Phase 4 stalls; pilots who fly stay on the gateway | Spike before committing; docked-only pilots still benefit after Phase 3 |
| Wire shapes diverge from gateway JSON | Many browser decoders need changes | Phase 2 measures this before any decoder is touched |
| BFF restart logs every pilot off at once | Pilots in space emergency-warp | Decision in Phase 3; separate socket host if unacceptable |
| Marshal decode load on the BFF's main thread | Latency for every pilot | Measure in Phase 4; worker thread |
| Gateway allowlist no longer filters the generic call path | A browser could reach any handler as its own account | Keep the current pair list as a BFF-side allowlist at cutover; widen deliberately |
| Vendored codec drifts again | Silent wire bugs | Phase 0 drift check |

## 5. Decisions needed from the operator

1. **BFF restart behaviour** (Phase 3): retail-equivalent drop, or a separate socket host.
2. **Generic call path after cutover** (Phase 5): keep an allowlist in the BFF, or accept retail
   trust (a logged-in client may call anything as itself). Taken in the operator's absence
   2026-10-10 for one case only: with no pilot held, an account on the game port is refused
   anything but the selection screen's service. With a pilot held the pair list stands as it
   did. The question is otherwise still open.
3. ~~Phase 6b: wanted, or stop at 6a.~~ Settled 2026-10-07 by the stated goal: 6b is planned.

## 6. Out of scope

- Any eve.js change made for the web client's sake. (Server defects are fixed; see the top.)
- The gRPC public gateway (`publicGatewayLocal.js`). Node can speak it if a feature needs it; none
  in this plan does.
- Option C (browser as the machoNet client). Phase 6b keeps it possible.
- Rendering the ballpark. This plan only reproduces the data the app already shows.

## 7. Evidence rules for this work

- Fixtures come from real server bytes, captured and committed, not hand-built.
- Watch each new test fail before trusting it.
- A local or patched server is not evidence of stock compatibility.
- Missing data is staged, not skipped. Record what was staged beside the result.
- Never run both transports for one character at the same time.
