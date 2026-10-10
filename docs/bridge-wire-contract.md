# Bridge wire contract (v1) — whitelisted `callMethod` path

**Status:** Active, established by goal R1 (2026-07-18); extended by goal R2 (persistent browser-backed sessions, same date), goal R3 (2026-07-19, the bound-object bridge — see "Bound-object bridge (R3)"), goal R4 (agents/missions + deferred call responses), goal R5a (2026-07-19, the space bridge — see "Space bridge & session-into-space (R5a)"), goal R5b (2026-07-19, the client-side route solver + browser autopilot decide-loop — see "Client-side route solver & browser autopilot (R5b)"), goal R6 (2026-07-19, courier completion + the Step-12 reward readout — see "Courier completion & reward readout (R6)"), goal R6a (2026-07-19, the Agent Finder — a static agent-list route + client-side jump-distance sort; see "Agent Finder static route (R6a)"), and goal R7 (2026-07-19, Local + Corp chat — presence/read/send for the browser session; see "Local + Corp chat (R7)"), and goal R35 (2026-07-21, the distribution-mission rail measured on the live server — the refused-`DoAction` shape, why the journal cannot report success, and the courier package load re-pointed from `/inventory/move` to the verifying `/inventory/transfer`; see "The distribution-mission rail, as measured live (R35)"). Later goals build on this contract; change it deliberately and update this file with the change.

This is the transport seam that lets the browser drive real EveJS `Handle_*` calls. The unit it mirrors is the retail call tuple **(service, method, args, kwargs)**; the gateway dispatches it through the same seam a retail client hits: `serviceManager.lookup(service).callMethod(method, args, session, kwargs)`.

```
browser --POST /api/bridge/call--> web BFF --POST /_evejs-web/v1/call--> EveJS gateway --callMethod--> Handle_<method>
```

## Gateway route (eve.js)

`POST http://<evejs-host>:26002/_evejs-web/v1/call`

Authorization is the existing gateway rule: tokenless requests are accepted from loopback only; otherwise the `x-evejs-web-token` header (or `Authorization: Bearer`) must match `EVEJS_WEB_GATEWAY_TOKEN`.

### Request body (JSON)

```json
{
  "service": "charUnboundMgr",
  "method": "GetCharacterSelectionData",
  "args": [],
  "kwargs": null,
  "session": { "userid": 4 }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `service` | string, required | Retail service name (`sm.RemoteSvc('<service>')`). |
| `method` | string, required | Retail method name; dispatches to `Handle_<method>`. |
| `args` | array, optional (default `[]`) | Positional args, retail-shaped. |
| `kwargs` | object or null, optional (default `null`) | Keyword args, retail-shaped. |
| `session` | object, required in practice | JSON **scalars only** (string/number/boolean/null). `userid` (positive integer) is required. |
| `bridgeSessionID` | string, optional (R2) | Opaque persistent-session handle from `session/select`. When present the call runs on the **stored live session** (the `session.userid` must match the session's owner, else `SESSION_NOT_FOUND`); when absent the call runs on a per-call materialized session exactly as in R1. |

**A live session object never crosses HTTP.** The gateway materializes the duck-typed browser-backed session server-side around the supplied scalars — the same plain-object session shape the parity tests hand to `Handle_*` — and attaches a `sendServiceNotification` capture hook.

### The allowlist (deny by default)

Only explicit **(service, method) pairs** dispatch; everything else — including other methods on an allowlisted service, and unknown services — is refused with `CALL_NOT_ALLOWED` **before any service lookup**. Never allowlist a whole service (that would expose destructive siblings like `charUnboundMgr.DeleteCharacter`). The allowlist is scope control, not a security measure (roadmap section 6).

Current pairs (defined in `eve.js` `server/src/_secondary/express/evejsWebGatewayRuntime.js`, `WEB_CALL_ALLOWLIST`):

| service | method | since |
| --- | --- | --- |
| `charUnboundMgr` | `GetCharacterSelectionData` | R1 |
| `charUnboundMgr` | `SelectCharacterID` | R2 (dispatched by `session/select`) |
| `map` | `GetStationInfo` | R1 |
| `station` | `GetGuests` | R2 |
| `stationSvc` | `GetStationItemBits` | R2 |
| `invbroker` | `MachoBindObject` | R3 (bind) |
| `invbroker` | `GetInventory` | R3 (bind) |
| `invbroker` | `GetInventoryFromId` | R3 (bind) |
| `invbroker` | `List` | R3 (bound method) |
| `invbroker` | `Add` | R3 (bound method) |
| `invbroker` | `MultiMerge` | R3 (bound method) |
| `invbroker` | `StackAll` | R3 (bound method) |
| `invbroker` | `GetCapacity` | R3 (bound method) |
| `ship` | `MachoBindObject` | R3 (bind) |
| `ship` | `Board` | R3 (bound method) |
| `agentMgr` | `GetAgents` | R4 (top-level station roster) |
| `agentMgr` | `MachoBindObject` | R4 (bind the agent moniker) |
| `agentMgr` | `DoAction` | R4 (bound: open convo / accept / decline) |
| `agentMgr` | `GetMissionBriefingInfo` | R4 (bound briefing read) |
| `agentMgr` | `GetMissionObjectiveInfo` | R4 (bound courier cargo/pickup/dropoff) |
| `agentMgr` | `GetMissionKeywords` | R4 (bound keyword substitution) |
| `agentMgr` | `GetAgentLocationWrap` | R4 (bound agent-location header) |
| `agentMgr` | `GetStandingGainsForMission` | R4 (bound standing preview) |
| `agentMgr` | `GetMyJournalDetails` | R4 (top-level or bound journal) |
| `ship` | `Undock` | R5a (undock — top-level docked call) |
| `beyonce` | `MachoBindObject` | R5a (bind the remote park) |
| `beyonce` | `CmdWarpToStuffAutopilot` | R5a (bound: warp to a gate/celestial) |
| `beyonce` | `CmdWarpToStuff` | R5a (bound: manual "warp to" with minRange) |
| `beyonce` | `CmdSetSpeedFraction` | R5a (bound: approach speed) |
| `beyonce` | `CmdFollowBall` | R5a (bound: approach/follow) |
| `beyonce` | `CmdStargateJump` | R5a (bound: jump — changes system) |
| `beyonce` | `CmdDock` | R5a (bound: dock — returns to a station) |
| `beyonce` | `CmdOrbit` | R13 (bound: orbit a target at a range) |
| `beyonce` | `CmdAlignTo` | R13 (bound: align — **kwargs only**) |
| `beyonce` | `CmdStop` | R13 (bound: stop — no arguments) |
| `structureJumpBridgeMgr` | `CmdJumpThroughStructureStargate` | R5a (server-tier Upwell jump-gate parity) |
| `account` | `GetCashBalance` | R6 (Step-12 wallet read — personal `GetCashBalance(0)`) |
| `LPSvc` | `GetAllMyCharacterWalletLPBalances` | R6 (Step-12 loyalty-point read) |
| `standingMgr` | `GetCharStandings` | R6 (Step-12 character standings read) |
| `invbroker` | `ListByFlags` | R12 (bound: read what is fitted, per slot flag) |
| `invbroker` | `DestroyFitting` | R12 (bound: **destroy** a rig — irreversible) |
| `dogmaIM` | `ShipGetInfo` | R12 (top-level: the ship's dogma attributes) |
| `dogmaIM` | `ShipOnlineModules` | R12 (top-level: which fitted modules are online) |
| `dogmaIM` | `SetModuleOnline` | R12 (top-level: bring a module online) |
| `dogmaIM` | `TakeModuleOffline` | R12 (top-level: take a module offline) |
| `skillMgr` | `SaveNewQueue` | R28 (top-level: save the WHOLE training queue — the only skill write) |
| `dogmaIM` | `LoadAmmo` | R29 (top-level: load a charge STACK into one module) |
| `dogmaIM` | `UnloadAmmo` | R29 (top-level: take a charge back out) |

R29 adds **no firing pair**: a turret, a launcher, a mining laser and a salvager
are all `dogmaIM.Activate` with an **empty effect name**, already listed for R23,
and the server resolves each module's own default effect from its typeID. This
was verified live rather than read — a turret and a launcher were both fired at
a locked rat through that one pair.

Ammo is the one place the "combat needs no new pairs" claim failed, and both
halves were measured:

- Loading a charge into an **empty** module *does* work through `invbroker.Add`
  with the module's slot flag — but it moves **one unit per call**, which is not
  a usable weapon.
- **Swapping** a charge type through that same `Add` is a **silent decline**:
  200, a null body, no reason, the old charge still loaded and the source stack
  untouched. `liveFittingState.js` raises `CHARGES_USE_LOAD_AMMO`, a string
  produced in exactly one place and mapped nowhere, so nothing reaches a caller.

`LoadAmmo(shipID, moduleIDs[], chargeItemIDs[], ammoLocationID)` is the only call
that fills a module in one go and the only one that can replace a loaded charge.
It sources from the ship's cargo hold when `ammoLocationID` is the ship and from
the station hangar otherwise; both were exercised live. `UnloadAmmo` is listed
**with** it deliberately — a rack that can only ever fill a module would strand
the charge, leaving unfitting the weapon as the player's only way back.
`LoadAmmo` may expand a weapon-bank master to its linked modules server-side;
the older “one module at a time” blast-radius claim was incorrect. The dedicated
BFF route is therefore explicitly confirmed and names that consequence.
`dogmaIM.LoadAmmoToBank` remains refused because the supported `LoadAmmo` path
already owns the linked-bank behavior.

The browser never sends the raw ship or inventory-location arguments:

- `POST /api/bridge/dogma/ammo/load`
  `{ moduleIDs, chargeItemIDs, source: "cargo" | "hangar", confirm: true }`
- `POST /api/bridge/dogma/ammo/unload`
  `{ moduleIDs, destination: "cargo" | "hangar", quantity?, confirm: true }`

Both routes pin the active ship from held + live session state and derive the
concrete cargo/station/structure location server-side. Invalid IDs, a stale hull,
or a hangar request while undocked fail before dispatch.

R12 adds **no** fit/unfit pair: fitting and unfitting are `invbroker.Add` with a
slot flag, already listed for R3. `dogmaIM.GetAllInfo` is deliberately **not**
listed even though it would serve the same read — it is the session bootstrap
call and fires post-response side effects (`afterCallResponse` → post-GetAllInfo
charge refresh, post-undock dogma multi-event, character dogma state sync), and
a panel refresh must not replay a session bootstrap.

Deny-by-default governs **bound-object methods too**: a method invoked on a bound handle whose `(service, method)` is not on this list is refused with `CALL_NOT_ALLOWED` before the handle's OID is resolved. See "Bound-object bridge (R3)" below.

### Success response (200)

```json
{
  "ok": true,
  "source": "evejs-web-gateway",
  "apiVersion": 1,
  "service": "charUnboundMgr",
  "method": "GetCharacterSelectionData",
  "result": [ "...retail-shaped handler result..." ],
  "notifications": []
}
```

- `result` is the handler's return value, JSON-encoded (see value encoding below). A handler that returns nothing yields `null`.
- `notifications` is the array of notification calls handlers made against the browser-backed session, in order, each as `{ "service", "method", "args", "kwargs" }` (mirroring `ClientSession.sendServiceNotification(serviceName, methodName, payloadTuple, kwargs)`). Returned in the response **for now**; event-channel forwarding is a later goal (G6) — do not build on delivery timing.
- **Persistent sessions (R2)** capture all three ClientSession notification surfaces, tagged by an added `kind` field (entries keep the R1 fields, so R1 consumers are unaffected):
  - `kind: "service"` — `sendServiceNotification(serviceName, methodName, payloadTuple, kwargs)` (fields as above);
  - `kind: "client"` — `sendNotification(notifyType, idType, payloadTuple)` as `{ "service": null, "method": <notifyType>, "idType", "args": <payloadTuple>, "kwargs": null }` (e.g. `OnCharNowInStation` guest-join broadcasts from other sessions);
  - `kind: "sessionchange"` — `sendSessionChange(changes)` as `{ "service": null, "method": "OnSessionChanged", "args": [<changes>], "kwargs": null }`.

  Notifications captured on a persistent session **accumulate between calls** and are **drained on read**: each `/call` (or `session/select`) response returns the whole backlog and clears it.

### Value encoding

Retail-shaped results can contain values plain JSON cannot carry:

- **BigInt** (e.g. `{type:"long", value:<bigint>}` FILETIMEs in cached-call versions) → encoded as a **decimal string** (`"value": "133742..."`). Handlers that used plain numbers still emit numbers; clients must accept both in `long` wrappers.
- **Buffer** (e.g. cached-object pickles) → Node's default JSON form `{"type":"Buffer","data":[...]}`.
- Anything JSON cannot represent after that (circular structures) → the call fails with `CALL_FAILED`.

### Error responses

Standard gateway error envelope:

```json
{ "ok": false, "source": "evejs-web-gateway", "apiVersion": 1, "error": "<CODE>", "message": "<human text>" }
```

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `CALL_INVALID` | Malformed request: missing/empty service or method, non-array `args`, non-object `kwargs`, non-scalar session field, missing/invalid `userid`, or a non-string/empty `bridgeSessionID`. |
| 403 | `CALL_NOT_ALLOWED` | The (service, method) pair is not on the allowlist. Deny by default; also covers unknown services/methods. |
| 503 | `CALL_SERVICE_UNAVAILABLE` | Pair is allowlisted but the service is not registered in this process (or the runtime predates the bridge). |
| 502 | `CALL_FAILED` | The handler threw a non-refusal error (message carries a truncated detail), or the result was not JSON-serializable. |
| 409 | `CALL_REFUSED` | **R2.** The handler itself refused with a retail user-facing error (a macho-wrapped `UserError`, e.g. "X is already online.", "not available on this account", the browser-pilot control refusal). The `message` is the handler's own text — the gateway never pre-empts or reimplements the check. |
| 404 | `SESSION_NOT_FOUND` | **R2.** The `bridgeSessionID` is unknown, expired (idle TTL already ran the disconnect), released, evicted by a retail takeover, or owned by a different `userid` (deliberately opaque). |
| 404 | `BOUND_HANDLE_NOT_FOUND` | **R3.** The `boundHandle` is unknown on this session, belongs to a different service than requested, or its OID was released/evicted. Handles are confined to the session that minted them (a handle from another session is unknown here). |
| 502 | `BOUND_NO_OBJECT` | **R3.** A bind method dispatched but returned no bound object (no OID substruct). |
| 501 | `CALL_DEFERRED_UNSUPPORTED` | **R4.** A handler returned a deferred call response (`buildDeferredCallResponse`) whose completion genuinely needs a client round-trip the synchronous bridge cannot service (e.g. a still-pending `OnAgentProvisionalResponse` confirmation). Refused as a typed error rather than emitting the broken deferred wrapper as a result. See "Deferred call responses (R4)" below. |
| 502 | `SESSION_SELECT_FAILED` | **R2.** `SelectCharacterID` completed without binding a character to the session (e.g. unknown characterID — the handler logs and returns null on apply-failure). The minted session is discarded. |
| 401 | `UNAUTHORIZED` | Gateway authorization failed (shared with all gateway routes). |
| 503 | `GATEWAY_RUNTIME_NOT_READY` | Gateway runtime not ready (shared with all gateway routes). |

## Persistent browser-backed sessions (R2)

A browser session **is** a client session: `session/select` mints a live session object (the parity-test duck-typed shape), **registers it in EveJS's live session registry**, and dispatches the retail tuple `charUnboundMgr.SelectCharacterID(charID, secondChoiceID, skipTutorial)` on it through the same allowlisted `callMethod` seam. From that point EveJS's own duplicate-login and character-control rules arbitrate it exactly like a retail session (a retail login for the same character is refused "already online", or evicts the browser session when login takeover is enabled — both faithful).

**Design choice (R2):** select is a dedicated route (not a `/call` special case) because minting/releasing a session is bridge-transport lifecycle, not a retail call; the dispatch itself still goes through the allowlist and `callMethod`.

### `POST /_evejs-web/v1/session/select`

Request: `{ "args": [charID, secondChoiceID, skipTutorial], "kwargs": null, "session": { "userid": <accountID>, "userName"?: <string> } }` — the service/method are pinned server-side to `charUnboundMgr.SelectCharacterID` (which must be, and is, on the allowlist).

Success (200): the `/call` envelope plus:

```json
{
  "bridgeSessionID": "<opaque token>",
  "session": {
    "userid": 2, "characterID": 140000003, "characterName": "Test Three",
    "stationID": 60003760, "structureID": null,
    "solarSystemID": 30000142, "corporationID": 98000000, "shipID": 9988400022009
  }
}
```

`shipID` (**R3**) is the docked character's active ship (`session.shipid`, set by `applyCharacterToSession`); the BFF uses it to bind the active ship's cargo with `invbroker.GetInventoryFromId`.

- `bridgeSessionID` is an opaque gateway-minted handle for the stored live session. **It exists only between the gateway and the BFF: the BFF keeps it server-side keyed by its web login session (the `sessionID` inside the signed token, whichever carrier brought it — see "Session carriers (R42)"), and it must never reach browser JS** (same rule as the gateway token).
- `session` echoes the scalar docked-entry state `applyCharacterToSession` put on the live session (where the character is), so the BFF/page need not re-derive it.
- Failures: the handler's own refusals → `CALL_REFUSED` (409); apply-failure → `SESSION_SELECT_FAILED`; in both cases the minted session is discarded and unregistered (nothing leaks).

### Using the session: `POST /call` with `bridgeSessionID`

Subsequent calls carry the handle (plus the normal `session.userid`, which must match). The call dispatches on the stored live session — handlers see the real docked session fields (`stationid`, `charid`, ...) — and the response drains the accumulated notification backlog.

### Ending the session: release, idle TTL, takeover

- `POST /_evejs-web/v1/session/release` with `{ "bridgeSessionID", "session"?: { "userid" } }` → `{ "ok": true, "released": true, "characterID": <id|null> }`. Runs the **same disconnect path a retail socket close runs** (`services/_shared/sessionDisconnect.js`: logoff persistence, guest-list departure, space/trade/chat cleanup, control release) — the character goes offline. Releasing an already-gone session is 404 `SESSION_NOT_FOUND` (the TTL got there first; treat as already released).
- **Idle TTL:** 30 minutes without a call (gateway default, `browserSessionIdleTtlMs`); an unref'd sweep (60s interval) reaps idle sessions through the same disconnect path. Any later use of the handle is `SESSION_NOT_FOUND`. **A live `/session-events` subscriber counts as activity** (since 2026-08-22): the sweep refreshes an attached session instead of reaping it, and the idle window restarts when the last subscriber detaches — a docked player who is only receiving events is not idle.
- **Retail takeover:** if EveJS's own mechanics evict the browser session (login takeover), the store notices the defunct session on next use and reports `SESSION_NOT_FOUND`.
- Gateway shutdown releases all persistent sessions through the same path.

## Bound-object bridge (R3)

Retail drives inventory and ship operations with a **two-step bound-object
(moniker/`MachoBindObject`) call**: a first call returns a *bound object* (a
moniker/OID), and subsequent methods dispatch on that bound object rather than
on the service by name. R3 mirrors this on the persistent session, and R4
(agents are `Moniker('agentMgr', agentID)`) and R5 (travel is
`Moniker('beyonce', solarsystemID)`) reuse the same two routes.

**Handle confinement.** A bind returns an opaque `boundHandle` that the gateway
holds on the persistent session (alongside the bound OID, which is registered
in the shared service manager exactly as `network/packetDispatcher`'s
`_scanAndRegisterOIDs` does after a real `MachoBindObject`). Like the
`bridgeSessionID`, **the bound OID and the boundHandle are gateway↔BFF only —
neither ever reaches browser JS.** The browser refers to inventories and ships
by their game IDs (inventoryID / shipID / itemID); the BFF maps those to the
handles it holds. A handle is confined to the session that minted it: presented
to another session, it is `BOUND_HANDLE_NOT_FOUND`. When the session ends, its
OIDs are released from the service manager.

### `POST /_evejs-web/v1/bound/bind`

Request: `{ "service", "method", "args"?, "kwargs"?, "session": { "userid" }, "bridgeSessionID" }`
— dispatches an **allowlisted bind method** (`invbroker.GetInventory` /
`GetInventoryFromId` / `MachoBindObject`, `ship.MachoBindObject`) on the stored
live session, registers the returned bound OID(s), and mints a handle for the
primary OID.

Success (200): `{ "ok": true, "boundHandle": "<opaque>", "service", "method", "notifications": [...] }`.
The bind's raw result is **not** returned (it carries the OID); only the opaque
handle and the drained notification backlog cross back. Deny-by-default applies
to the bind pair before any service lookup.

### `POST /_evejs-web/v1/bound/call`

Request: `{ "service", "method", "args"?, "kwargs"?, "session": { "userid" }, "bridgeSessionID", "boundHandle" }`
— resolves the handle on **this session only**, enforces the deny-by-default
`(service, method)` allowlist on the **bound method BEFORE resolving the OID**
(a non-allowlisted bound method is refused before any dispatch), sets the
session's `currentBoundObjectID` to the OID so the handler resolves its bound
context exactly as on a socket, and dispatches through the same `callMethod`
seam. The `service` must match the handle's service (else `BOUND_HANDLE_NOT_FOUND`).

Success (200): the `/call` envelope (`result` is the bound method's
retail-shaped return; `notifications` drains the backlog).

### BFF bound-object routes (this repo)

The browser never calls `/bound/*` directly; it hits semantic BFF routes keyed
by game IDs, and the BFF holds the handles (cached per web session by a semantic
key — `hangar:<stationID>`, `cargo:<shipID>`, `ship:<stationID>` — re-binding on
`BOUND_HANDLE_NOT_FOUND`). All require the signed web login session.

- `GET /api/bridge/inventory` → the full Inventory & Ship panel:
  `{ ok, stationID, activeShipID, hangar: { list, capacity, error }, cargo: { shipID, list, capacity, error } }`.
  Binds the station hangar (`invbroker.GetInventory`) and the active-ship cargo
  (`invbroker.GetInventoryFromId`), then `List(flag)` + `GetCapacity(flag)` on
  each. The four reads are independent (`Promise.allSettled`) so one failed read
  never blanks the rest; each container carries its own `error` code. `list` and
  `capacity` are the raw retail-shaped results, decoded browser-side
  (`web/src/bridge/inventoryShip.ts`).
- `POST /api/bridge/inventory/move` `{ itemID, direction: "toCargo"|"toHangar", qty? }`
  → `invbroker.Add(itemID, sourceLocationID, {qty?, flag})` on the **destination**
  binding (retail `Add` carries the source location and destination flag; a
  partial `qty` folds the split into the move — no separate `SplitStack`, gap
  G4). ⚠ **Returns `{ok:true}` without re-reading, so it cannot tell a move from
  a silent decline.** Prefer `POST /api/bridge/inventory/transfer`, which
  re-reads and reports what actually happened; the courier package load was
  re-pointed at it in R35.
- `POST /api/bridge/inventory/stack` `{ target: "hangar"|"cargo" }` → `invbroker.StackAll(flag)`.
- `POST /api/bridge/ship/board` `{ shipID }` → `ship.MachoBindObject` then
  `Board(shipID, oldShipID)`; on success the boarded ship becomes the active
  ship the BFF binds cargo against.

Errors pass through with the gateway's status (`CALL_NOT_ALLOWED` → 403,
`BOUND_HANDLE_NOT_FOUND` → 404, `CALL_REFUSED` → 409); a `SESSION_NOT_FOUND`
drops the held bridge session (the page returns to character select). With no
character online the routes answer 409 `NO_LIVE_SESSION`.

## Deferred call responses (R4)

Some retail handlers do not return a value; they return a **deferred call
response** (`buildDeferredCallResponse(startFn)`, `network/callResponseControl.js`)
and let the packet dispatcher drive completion — the handler sends its own
call/error response(s) later, often only after a **client round-trip** (e.g. the
`OnAgentProvisionalResponse` YesNo confirmation `agentMgr.Handle_DoAction` uses
on a **decline**). The gateway previously JSON-serialized that wrapper as a
broken object.

Both dispatch seams (`callServiceMethod` and `callBoundMethod`) now detect
`isDeferredCallResponse(result)` and drive it with a **gateway-side adapter**:
the adapter supplies a fake dispatcher + packet, captures the response(s) the
handler emits, and returns the last non-provisional response as the real result
(with the session's drained notifications). The browser-backed session has no
`sendClientCallRequest`, so a decline degrades to the handler's own
no-client-available fallback and completes synchronously (a direct decline). If
a deferred flow emits only an interim provisional placeholder and no final
response — genuinely still waiting on a client round-trip the synchronous bridge
cannot service — it is refused with `CALL_DEFERRED_UNSUPPORTED` (501) rather than
returned broken. **The in-person courier accept (`DoAction(<accept>)`) is a
synchronous outcome and never takes this path.**

Faithful to retail, the gateway now also invokes `service.afterCallResponse(method,
session, {args, kwargs, result})` after a successful **non-deferred** dispatch (in
a try/catch, mirroring `network/packetDispatcher.js`) so post-response side
effects run — invbroker's docked-fitting bootstrap and deferred session-change
flush, ship's safe-logoff completion. It is skipped for deferred dispatches (as
retail returns before it) and is a no-op for services that do not define it.

## Agent conversation, briefing, and journal (R4)

The agent flow is the retail bound-object two-step reused for `agentMgr`:

- **Roster:** `agentMgr.GetAgents()` (top-level) returns a Rowset of every agent
  (~11k). The retail client filters by station client-side; the BFF does the same
  server-side and returns only the docked station's agents as plain rows
  (`agentID, agentTypeID, divisionID, level, stationID, corporationID,
  missionKind, missionTypeLabel`).
- **Bind:** `agentMgr.MachoBindObject([agentID])` — the agent moniker
  `Moniker('agentMgr', agentID)` — mints a bound handle (held BFF-side).
- **Conversation:** bound `DoAction(actionID)`. `actionID` `null` opens the
  conversation; the result is the marshaled tuple
  `( ( agentSays, availableActions ), lastActionInfo )` where each available
  action is a `(actionID token, buttonType)` tuple. The UI renders a button per
  action (labelled from `buttonType`: 2=Request, 3=Accept, 6=Complete, 9=Decline,
  11=Quit, …) and sends the **token** back as the next `DoAction(actionID)`
  (retail sends the first action-tuple value; the handler normalizes token→button).
- **Accept (in person):** `DoAction(<accept token>)` on a courier the agent
  offers → the mission moves to accepted (synchronous). Decline is the deferred
  outcome above.
- **Briefing reads (bound):** `GetMissionObjectiveInfo` carries the courier
  transport objective — pickup/dropoff location dicts and a cargo dict
  (`typeID`, `quantity`, `volume`), `normalRewards` (ISK, `typeID` 29),
  `bonusRewards` (time bonus), and `loyaltyPoints`; `GetMissionBriefingInfo`
  carries the title, a `Mission Keywords` summary, and the `AcceptTimestamp` /
  `Expiration Time` FILETIME longs. `GetAgentLocationWrap` is the agent-location
  header.
- **Journal:** `agentMgr.GetMyJournalDetails()` (top-level) returns
  `(activeMissions, offeredMissions)`; each mission row is
  `[missionState, _, missionTypeLabel, missionTitleID, agentID, expiry(long),
  bookmarks, _, _, missionID]`.

**Decoder rule:** mission rows carry long-encoded IDs and ISK/LP amounts. The
browser decoders (`web/src/bridge/agents.ts`) decode every numeric with
`unwrapLong` — never `typeof === "number" ? … : 0`. ISK amounts and FILETIMEs
(which can exceed 2^53) are kept as **decimal strings**, not lossy `Number`.

## Space bridge & session-into-space (R5a)

R5a bridges the atomic space-movement calls the retail client's **client-side**
autopilot issues (`autopilot.py`), driven **manually** (one button per move):
undock → warp to a gate → jump → dock. EveJS's existing space handlers stay
authoritative for each move; **no server-side travel job is added** (roadmap
§7). The automated decide-loop + route solver + multi-jump travel panel are
R5b, out of scope here.

**The persistent browser-backed session participates in space across undock,
exactly like a retail socket session — and this needs no new session-carry
code.** `ship.Undock` is a **top-level** call on the docked session:
`Handle_Undock` resolves the ship from the session and runs
`undockSession(session)`, which moves the ship to space, applies the character
to the session (`applyCharacterToSession`), and attaches the session to a space
scene via `spaceRuntime.attachSession` — setting `session._space`. The
persistent session (`materializePersistentBrowserSession`) already carries the
duck-typed fields and all three notification surfaces
(`sendServiceNotification` / `sendNotification` / `sendSessionChange`) plus a
duck `socket`, which is the **same shape the space parity tests hand to
`undockSession`/`dockSession`**. Destiny (graphics) traffic is gated on
`isReadyForDestiny` (a live socket **and** `initialStateSent`), so a
browser-backed session — `initialStateSent:false`, no real destiny socket —
simply receives no destiny frames (graphics are out of scope); the location and
movement state still transition authoritatively.

- **Undock:** `ship.Undock(shipID, ignoreContraband, onlineModules=[])` —
  `onlineModules` is a **kwarg** (never positional). Emits an `OnSessionChanged`
  (drained into the response) the browser can read.
- **Remote park (bound two-step, reuses R3):** the park is the moniker
  `Moniker('beyonce', solarSystemID)` (retail `michelle.GetRemotePark()`), bound
  with `beyonce.MachoBindObject([[solarSystemID, groupStation=5]])`. Its `Cmd*`
  methods dispatch on the in-space session (they read `session._space`, not the
  bound OID): `CmdWarpToStuffAutopilot(destinationID)` (warp to a gate/celestial),
  `CmdStargateJump(fromGateID, toGateID, shipID)` (jump — changes the system
  after a short handoff delay), `CmdDock(stationID, shipID)` (dock — accepts a
  pending dock the sim completes, returning the session to the station).
- **Movement refusals are faithful:** the handler's own refusal (scrambled,
  invalid target, docking-approach, lost control, ship destroyed) surfaces as a
  `CALL_REFUSED` (409) with the handler's user-facing text — never a silent
  no-op or a fake success.

### `POST /_evejs-web/v1/session/flight-status`

Request: `{ "bridgeSessionID", "session"?: { "userid" } }` — a **read-only**
snapshot of the held session's current location and (in space) ship movement
state, drained together with the accumulated notification backlog. Full push
streaming is still G6, so the browser polls this manually between movement
steps ("Refresh flight status").

Success (200): `{ "ok": true, "flight": { inSpace, docked, solarSystemID,
stationID, structureID, shipID, shipMode, shipSpeedFraction },
"notifications": [...] }`. `shipMode`/`shipSpeedFraction` are a best-effort read
of the scene entity (null when docked or the scene is gone). The read touches
only the live session scalars the gateway already holds plus a best-effort
`spaceRuntime.getEntity` (lazy-required, mirroring `teardownBrowserSession`), so
it stays within the `_secondary/express` footprint.

## Ship fitting (R12)

**Fitting is not a dedicated service.** It is the SAME `invbroker` bound-object
two-step the R3 inventory bridge drives, with a **slot flag** instead of the
hangar (4) / cargo (5) flag — so it reuses the bind + handle cache verbatim and
adds no new bind machinery. (`fittingMgr` is saved fitting *templates*, not live
fitting, and is out of scope.)

| action | call |
| --- | --- |
| read the fit | ship binding → `invbroker.ListByFlags([<every slot flag>])` |
| read resources | `dogmaIM.ShipGetInfo()` — **top level**, no bind |
| read online state | `dogmaIM.ShipOnlineModules()` — **top level**, no bind |
| fit a module | ship binding → `invbroker.Add(moduleID, sourceLocationID, {qty:1, flag:<slot>})` |
| unfit a module | hangar/ship binding → `invbroker.Add(moduleID, shipID, {qty:1, flag:4\|5})` |
| online / offline | `dogmaIM.SetModuleOnline([shipID, moduleID])` / `TakeModuleOffline` |
| remove a rig | ship binding → `invbroker.DestroyFitting(rigID)` — **destroys it** |

`sourceLocationID` is the station when fitting from the hangar and the ship when
fitting from its own cargo; the destination is the bound object and is never
repeated in the args. The three `dogmaIM` reads/actions are top-level because
each handler resolves the character's active ship from the **session** itself.

### Slot flags and how the browser addresses a slot

Slot flagIDs (`inventorycommon/const.py`; mirrored by
`server/src/services/fitting/liveFittingState.js` `SLOT_FAMILY_FLAGS`):

| family | flags |
| --- | --- |
| low | 11–18 |
| mid | 19–26 |
| high | 27–34 |
| rig | 92–99 |
| subsystem | 125–132 |
| hangar / cargo / auto-fit | 4 / 5 / **0** |

These are the **server's** ranges. The retail client's own rig and subsystem
lists are narrower (92–94 and 125–128); the server clamps each family to the
ship's real slot count anyway (`getSlotFlagsForFamily("rig", 597, …)` → `[92,93,94]`
for a Punisher), so reading the wider range never invents a slot and never
misses one this server considers legal.

**The browser never sends a flagID.** It addresses a slot by **family + index**
("the third high slot"), and the BFF is the only place that maps that to a flag
— which is what keeps raw flagIDs out of browser JS entirely (R7d). `family:
"auto"` maps to flag 0 (`flagAutoFit`) and lets the **server** pick the slot.

### Dogma attributes the panel reads

From `dogmaIM.ShipGetInfo()`, whose result is
`{type:"dict", entries:[[shipID, util.KeyVal{itemID, invItem, attributes:{attributeID: value}, …}]]}`.
IDs cross-checked against this build's `TYPE_DOGMA.attributeTypesByID` names, not
assumed:

| reading | attribute IDs |
| --- | --- |
| CPU | **48** output / **49** load |
| Powergrid | **11** output / **15** load |
| Capacitor | **482** capacity, **18** charge, **55** recharge time |
| Calibration | **1132** capacity / **1152** used (`upgradeLoad`) |
| Slot counts | **12** low / **13** mid / **14** high / **1137** rig / **1366** subsystem |

⚠ **A docked ship reports 482 and 55 as `null`** and carries its effective
capacitor in **18** (`charge`). The panel therefore reads capacity-**or**-charge;
this is pinned by the gateway suite's `ShipGetInfo` test, and it is the
difference between a working capacitor bar and a blank one in station.

### ⚠ A refusal can be SILENT — never trust a 200

`invbroker`'s fit validation raises a `UserError` for most refusals, but several
branches (notably `SKILL_REQUIRED`) return `null` **without raising**:
`_throwFittingMoveUserError` has no case for them, so `Add` simply does nothing
and the bridge answers 200 with `result: null`. **A successful response is not
proof a fit happened.** Every mutating BFF route below therefore RE-READS the
slots afterwards and reports `applied` — what actually changed, not what was
asked for. A silent decline surfaces to the player as *"The server did not apply
that change, and gave no reason"*: honest, where naming a cause would be a guess.

A thrown refusal is different and better: it carries the **handler's own** reason
(`"You do not have enough CPU to online that module."`,
`NotEnoughCapacitorForOnline`, `CannotOnlineReachedMaxGroupOnline`, …) through as
a typed `CALL_REFUSED` (409), passed to the browser verbatim.

### BFF fitting routes (this repo)

Handles stay server-side; the slot read reuses the **same** `cargo:<shipID>`
bind as the R3 cargo read (one cached handle, not two).

- `GET /api/bridge/fitting` → `{ ok, activeShipID, stationID, slots, shipInfo,
  online, errors: { slots, shipInfo, online } }`. The three reads are independent
  (`Promise.allSettled`), so a failed resource read still shows the fit and vice
  versa. Raw retail-shaped results, decoded browser-side
  (`web/src/bridge/fitting.ts`).
- `POST /api/bridge/fitting/fit` `{ itemID, source: "hangar"|"cargo", family, index? }`
  → `Add` with the resolved slot flag; answers `{ ok, applied }`.
- `POST /api/bridge/fitting/unfit` `{ itemID, destination: "hangar"|"cargo" }`
  → the same `Add` reversed; answers `{ ok, applied }`.
- `POST /api/bridge/fitting/state` `{ itemID, online }` →
  `dogmaIM.SetModuleOnline` / `TakeModuleOffline`.
- `POST /api/bridge/fitting/destroy-rig` `{ itemID, confirm: true }` →
  `invbroker.DestroyFitting`. **Refuses with 400 `CONFIRMATION_REQUIRED` unless
  `confirm === true`**, and with 400 `NOT_A_RIG` for anything not sitting in a
  rig slot on the active ship. This is the second gate behind the UI's own
  two-step confirmation: a rig is destroyed, never returned to the hangar, so
  neither a stray click nor a stray POST can lose one.

#### Ship statistics (R21) — no new read

The fitting window's statistics add **no call to this contract**. Resistances,
EHP, align time, speed, warp speed, signature, targeting and bay figures are all
derived browser-side from the **`shipInfo` attribute map `GET
/api/bridge/fitting` already returns** (`web/src/bridge/shipStats.ts`).

Two things make that sound, and both are properties of the server, not of us:

1. **`ShipGetInfo` returns the whole attribute map**, not a promoted subset.
   There is no allowlist anywhere on that path — `buildShipResourceState` seeds
   from the full base + type-dogma map, `buildFittingSnapshot` copies it
   wholesale, and `_buildAttributeValueDict` marshals every entry. Resonances
   (267–274, 109/110/111/113) and layer HP (263, 265, 9) are all present.
2. **It applies ACTIVE module effects.** The path is `Handle_ShipGetInfo` →
   `_buildShipAttributeDict` → `getShipFittingSnapshot` → `buildFittingSnapshot`
   → `buildSnapshotResourceState`, and that last step re-solves with
   `collectAssumedActiveFittingEffects` through
   `additionalAttributeModifierEntries`, with `assumeActiveShipModules`
   defaulting to `true`. So hardeners are already in the numbers we receive.
   (R20's warning about `buildShipResourceState()` applying only passive/online
   effects is real, but it describes a caller *inside* eve.js — this route is
   not one. `web/src/bridge/shipStats.test.ts` pins the distinction with the
   real Drake values.)

The browser does the arithmetic promotions only: `1 − resonance` for a
resistance, `HP ÷ Σ(profileᵢ × resonanceᵢ)` for EHP, and the server's own
`ln(4) × mass × inertia ÷ 1e6` for align time. It never simulates dogma.

**What this contract cannot supply.** The gateway allowlist
(`evejsWebGatewayRuntime.js`) exposes exactly two fitting reads — `ShipGetInfo`
(the **ship's** attributes) and `ShipOnlineModules` (which modules are on).
**Nothing returns per-module effective attributes.** So DPS, volley, drone
damage, mining yield, repair rates and capacitor usage/delta cannot be computed
from this contract at all, and the window shows them as *unavailable* rather
than as zero. Supplying them needs a new allowlisted read (a per-module
attribute call), which is a separate goal — exporting
`buildEffectiveFittedModuleAttributeMap` in eve.js (done under R21) is a
necessary step but **not sufficient on its own**, because the browser still has
no wire route to reach it. Capacitor stability is a further gap again: neither
EveJS nor R20's oracle has a solver.

Decoded browser side into slots (`FittingSlot` = family + index + the module or
`null`) and resource readings (`FittingResource` = used / total / `known`), with
`known: false` rendering as an unknown bar rather than a misleading `0 / 0`.

## Inventory depth + corporation hangars (R14)

R14 adds no new inventory *surface*. Splitting, multi-select moves, re-merging,
opening containers and reading a corporation hangar are all the **same R3
`invbroker` two-step**, called with arguments R3 hardcoded away:

| Operation | Retail call | New pair? |
| --- | --- | --- |
| Split a stack | `Add(itemID, sourceLocationID, qty=<partial>)` on the destination binding | no — R3's `Add` |
| Multi-select move | `MultiAdd(itemIDs, sourceLocationID, {flag})` on the destination binding | **`invbroker.MultiAdd`** |
| Re-merge | `MultiMerge([[src, dst, qty]], sourceContainerID)` | no — already listed |
| Open a container | `GetInventoryFromId(containerItemID)` then `List()` | no — R3's cargo bind |
| Trash | `TrashItems(itemIDs, locationID)` on the inventory-**manager** moniker | **`invbroker.TrashItems`** |
| Corp hangar read | `GetInventoryFromId(<office>)` then `List(<division flag>)` | no |
| Which office | `officeManager.GetMyCorporationsOffices()` | **`officeManager.GetMyCorporationsOffices`** |
| Division names | `corpRegistry.GetCorporation()` → `division1..division7` | **`corpRegistry.GetCorporation`** |

Four new deny-by-default pairs in total; every other `invbroker`,
`officeManager` and `corpRegistry` sibling stays refused before dispatch.

### ⚠ A container is listed with NO flag

Container contents carry **`flagID` 0** — not 4 (hangar) or 5 (cargo). So a
container binding is listed with **no flag argument at all**; passing the hangar
or cargo flag answers **EMPTY**, and a caller that reused the hangar `List` call
would report a full container as empty.

The reverse also bites: filing an item **into** a container needs
`flag: 0` given **explicitly**. A container binding carries a *null* flag
context, and a null flag falls back to the hangar flag — so omitting `flag`
files the item inside the container but stamps it `flagID` 4. It still lists
(the no-flag `List` ignores flags), which is exactly how that bug hides.

Container-ness itself is a **purely client-side static-data test** (`groupID` in
{12, 340, 448, 649} and `singleton`) — the protocol has no notion of it, and the
bind is byte-for-byte the ship-cargo bind.

### Corporation hangar flag map

Division *N* (1-7) is flag **114 + N**, i.e. `flagCorpSAG1..7` = 115-121 (plus
184 `flagCorpGoalDeliveries`, not surfaced). **The browser never sees these
numbers**: it addresses a division by its ordinal and renders its *name*
(`division1..division7` off the corporation row, falling back to "Division N" —
never `flagCorpSAG3`, never 117). R7d applies to division flags too.

Access is a role-mask test against `session.corprole` — a *query* role to see a
division, a *take* role to move things out — and **eve.js enforces it
independently**. A division the character cannot query simply reads **empty**;
a take they lack the role for is refused with the handler's own
`CrpAccessDenied`, surfaced verbatim. The client's own greying-out is cosmetic.

### ⚠ Office identity — the trap

An office record carries **three separately allocated identifiers**:

| Field | What it is |
| --- | --- |
| `office.officeID` | where the hangar **contents actually sit** (`item.locationID`) |
| `office.officeFolderID` | the folder id |
| `office.itemID` | what `GetMyCorporationsOffices` **publishes as `officeID`** |

`GetInventoryFromId` accepts **any** of the three and normalizes the bound
context to `office.officeID`, so **binding with the published value is correct**
— and it is the only value a client can see. But the published value is **not**
the items' `locationID`. Quoting it as the **source location** of a move-out is
declined **silently**: a 200 with nothing moved. The bridge therefore takes the
source location from each **listed row's own `locationID`**, never from the
office identifier. `server/tests/webGatewayCorpHangar.test.js` seeds an office
whose three identifiers deliberately differ and pins all of this.

### ⚠ Silent declines, again (the R12 lesson)

`invbroker` returns `null` **without raising** in several move branches
(source-location mismatch, no room, a rig, a corp division the character cannot
take from). Every mutating route below **re-reads** afterwards and reports what
actually applied. `declinedSilently: true` means the server refused and gave no
reason — reported as exactly that, because naming a cause would be a guess.

A split is judged differently: it mints a **new** stack at the destination and
leaves the source itemID in place, so `applied` comes from the **source stack
shrinking**, not from the requested id appearing at the destination.

### BFF routes (this repo)

Handles stay server-side, cached under the same semantic keys as R3 plus
`container:<itemID>`, `corpOffice:<officeID>` and `invManager:<stationID>`. The
browser names a **place**, never a flag:

```
{ kind: "hangar" } | { kind: "cargo" }
{ kind: "container", itemID } | { kind: "corp", division: 1..7 }
```

- `GET /api/bridge/inventory/container/:itemID` → `{ ok, containerID, list, capacity }`.
  Binds `GetInventoryFromId(containerItemID)` and lists with **no flag**.
- `POST /api/bridge/inventory/transfer` `{ itemIDs, from, to, qty? }` → one
  `Add` (single item, optionally partial-`qty` = a split) or one `MultiAdd`
  (several). Answers
  `{ ok, applied, moved, reminted, declined, declinedSilently, notFound }`.
  A `qty` with more than one item is 400 `INVALID_SPLIT`.

  **`applied` is judged by the SOURCE, not the destination (R29).** Three server
  paths mint a **new itemID** at the destination, so the id the caller named can
  never appear there and `moved` is legitimately empty on a completed move:
  looting a wreck (the wreck row is destroyed and a fresh row minted), splitting
  a stack, and peeling one unit off a stack to fit or load it. What all three
  share is that the source **gave something up** — the row vanished, or its
  quantity fell — and that is what `applied` now asks. `moved` still names the
  items that kept their identity; **`reminted`** names those that left the source
  and arrived under a new id.

  **A throw is not proof of failure either.** Looting raises *after* the item has
  already moved (eve.js `nativeNpcWreckService.js` calls a scene method that does
  not exist, but only once the transfer is done). Measured: five consecutive loot
  calls each answered `CALL_FAILED` and all five items were in the cargo hold
  afterwards. The route therefore **remembers** a dispatch error, re-reads, and
  re-raises it **only** if the source gave up nothing — so a genuine failure is
  still a failure, and a completed move is never reported as a loss.

  **Loot range is not enforced server-side.** A wreck 10 km away looted fine;
  retail requires 2,500 m. Any UI must not assume the server will refuse.
- `POST /api/bridge/inventory/merge` `{ sourceItemID, destinationItemID, place, qty? }`
  → `MultiMerge`; answers `{ ok, applied, merged, declinedSilently }`.
- `POST /api/bridge/inventory/trash` `{ itemIDs, place, confirm: true }` →
  `TrashItems` on the inventory-**manager** moniker. **Refuses with 400
  `CONFIRMATION_REQUIRED` unless `confirm === true`** — the second gate behind
  the UI's two-step confirm, exactly as `destroy-rig` is fenced. Answers
  `{ ok, applied, destroyed, survived, declinedSilently }`.
- `GET /api/bridge/inventory/corp` → `{ ok, available, reason?, divisions: [{ division, name, list, error }] }`.
  Reads the office and the division names, then lists all seven divisions
  independently (`Promise.allSettled`) so a division the character cannot query
  never blanks the rest. **No office here is `available: false` with
  `reason: "NO_CORP_OFFICE"` — an ordinary state, not an error.** A division
  descriptor exposes an **ordinal and a name, never a flag**.
- `GET /api/bridge/corp-offices` → `{ ok, stationIDs, divisions: [{ division, name }], error }`.
  The **planning** read next to the docked-station one above: `officeManager.
  GetMyCorporationsOffices` answers from the session's corporation alone, so this
  says **where the corporation has offices at all** — every station at once,
  readable in space and from the far side of the map — plus what the seven
  divisions are called (`corpRegistry.GetCorporation`). No office ids and no
  contents leave the BFF. An empty `stationIDs` with `error: null` is the
  ordinary "rents none anywhere"; a failed read says so in `error` instead, so a
  caller never reads a timeout as "there is no office".

  **No role check.** Divisions are listed whether or not the character holds the
  query role for them, because the role is only enforceable where it is enforced
  — at the office, at the deposit — and hiding a division a pilot does hold
  would cost more than offering one they do not.

## Industry — blueprints, jobs, facilities (R15)

Industry is the first panel that needs **no bound-object machinery at all**.
The entire retail industry surface is `sm.RemoteSvc(...)` — top-level calls with
no `MachoBindObject` step anywhere — so `POST /api/bridge/call` on the held
session carries every one of them, and R15's only gateway change is the
allowlist pairs themselves.

### The call table

| What the panel needs | Retail call | Answers |
| --- | --- | --- |
| The player's blueprints | `blueprintManager.GetBlueprintDataByOwner(ownerID, facilityID\|None)` | `[list<blueprintInstance>, dict<facilityID → count>]` |
| One blueprint (post-mutation re-read) | `blueprintManager.GetBlueprintData(itemID)` | one `blueprintInstance` |
| The player's jobs | `industryManager.GetJobsByOwner(ownerID, includeCompleted)` | `list<job>` |
| One job (post-mutation re-read) | `industryManager.GetJob(jobID)` | one `job` |
| Job slots in use | `industryManager.GetJobCounts(charID)` | `dict<activityID → usedSlots>` |
| Facilities in range | `facilityManager.GetFacilities()` | `list<facility>`, region-scoped off the **session** |
| Activity modifier ceiling | `facilityManager.GetMaxActivityModifiers()` | `dict<activityID → modifier>` |
| Input/output hangar choices | `facilityManager.GetFacilityLocations(facilityID, ownerID)` | `list<industry.Location>` |

Eight new deny-by-default pairs. **`facilityManager.SetFacilityTaxes` is
deliberately NOT listed** — it is a corp-admin mutator that rewrites what every
member of a corporation pays to use a structure, and it sits on the same service
as three of the reads above, so a service-granular allowlist would have exposed
it. It stays refused before dispatch, as do `GetFacility`, `GetFacilitiesByID`,
`GetFacilityTaxes`, `blueprintManager.GetLimits`, and every `industryMonitor`
method.

`ownerID` is `session.charid` for personal industry or `session.corpid` for
corporation industry. **The BFF only ever passes the held session's own
`characterID`** — the browser never supplies an owner, so it cannot read another
character's industry. `GetFacilities` takes no arguments at all and scopes
itself off `session.regionid`, so it cannot be pointed at another region either.

### ⚠ Shape traps

**The blueprint read is a 2-TUPLE, not a list.** `GetBlueprintDataByOwner`
answers a plain JSON array `[list<instance>, dict<facilityID → count>]`. A
decoder that treats the result as a `{type:"list"}` finds nothing.

**Efficiencies are two distinct fields.** Each instance carries
`materialEfficiency` *and* `timeEfficiency` (plus `runs`, `original`,
`locationID`, `jobID`) directly, so the panel needs no per-blueprint follow-up
read — but a transposition of the two looks plausible and is wrong.

**`industry.Location` hides its fields in `header[2]`.** These arrive as
`buildObjectEx1("industry.Location", [], [...])`, whose state entries land in
`header[2]` as `{type:"dict", entries:[...]}`. The top-level `dict` array is
**empty** and `header[1]` is the (empty) args list. A decoder that reads
`value.dict` silently leaves the player with nowhere to draw materials from.

**Job status is COMPUTED at read time, not stored.** `getJobStatus()` promotes
an `INSTALLED` job whose `endDate` has passed to `READY` on every read. The
browser therefore never compares an end date against the clock to decide
whether a job is done — it shows the status the server returned. (It does use
`endDate` for a cosmetic countdown, which is not the same thing.)

### Live calls vs static data

The live calls answer what is true of **this player**; static data answers what
is true of **the game**. Neither is derived from the other.

| Live (gateway) | Static (`src/staticData.js`) |
| --- | --- |
| Which blueprints the player holds, at what efficiencies, with how many runs left, and whether one is locked into a job | What a blueprint and its product are **called** |
| Which jobs are running, their status, cost, and end date | Which activities a blueprint supports, what each consumes, how long it takes |
| Which facilities the region offers, their tax, online state, and supported activities | What a facility (an NPC facility's id **is** its station id) and its system are called |
| How many job slots each activity is using | — |

Names ride the existing `/api/names` cache (`type` / `station` / `system`).
Recipes need their own route because `/api/names` cannot answer them.

### BFF routes (this repo)

- `GET /api/bridge/industry` → `{ ok, ownerID, stationID, solarSystemID,
  blueprints: {result,error}, jobs: {result,error}, jobCounts: {result,error},
  facilities: {result,error}, activityModifiers: {result,error} }`.
  Five **independent** calls (`Promise.allSettled`): each read carries its own
  error, so a player whose region answers no facilities still sees their
  blueprints and jobs. Jobs are read with `includeCompleted=true` and filtered
  client-side by the status the server computed.
- `POST /api/industry/blueprints` `{ blueprintTypeIDs }` →
  `{ ok, source:"static-data", count, capped, limit, definitions }`. Pure static
  reference data (like `/api/map/graph`): **no gateway call, no live session
  needed**. An unknown type is echoed as an explicit `null` so the client can
  cache the miss.

### Mutations (R15 Slice B)

Five more pairs: `industryManager.InstallJob` / `CompleteJob` / `CancelJob` and
`industryMonitor.ConnectJob` / `DisconnectJob`.
**`industryManager.CompleteManyJobs` is deliberately NOT listed** — a batch
delivery across a whole job list is not something a stray click should fire, and
the panel delivers one job at a time.

#### The `InstallJob` payload — ONE POSITIONAL DICT

`InstallJob` takes a **single positional dict** (`args.length === 1`, `kwargs:
null`), the shape `industry.Job.dump()` produces and `parseIndustryRequest`
reads. A **plain JSON object** is that dict — `marshalObjectToObject` accepts it
directly, so no marshal wrapper is involved.

```jsonc
{
  "blueprintID": 7100000001,   // the blueprint ITEM id
  "blueprintTypeID": 681,
  "activityID": 1,             // the BFF maps the browser's activity NAME
  "facilityID": 60003760,
  "solarSystemID": 30000142,
  "characterID": 140000003,    // the HELD session's own character
  "corporationID": 0,
  "account": null,             // (ownerID, walletKey) for corp installs only
  "runs": 3,
  "licensedRuns": 1,           // copying
  "cost": 0, "tax": 0, "time": 0, "materials": {},   // ADVISORY — see below
  "inputLocation": { "itemID": …, "flagID": 4, "ownerID": …, "canTake": true },
  "outputLocation": { … },
  "productTypeID": 165,        // invention
  "optionalTypeID": null, "optionalTypeID2": null
}
```

⚠ **`cost` / `tax` / `time` / `materials` are advisory.** The server recomputes
all four from the blueprint definition plus the facility's modifiers, so sending
them wrong does not change what is charged and sending them right does not make
them authoritative. The fields that genuinely decide the outcome are
`blueprintID`, `activityID`, `facilityID`, `runs` (plus `licensedRuns` for
copying, `productTypeID` for invention, and the two locations). A **null**
location means "the server picks the default hangar".

`CompleteJob(jobID, solarSystemID)` **is** delivery. `CancelJob(jobID,
solarSystemID)` stops a job and returns the blueprint but **refunds neither the
materials nor the installation fee**.

#### ⚠ Refusals carry their reasons — two shapes

The gateway's `readWrappedUserErrorRefusal` was discarding both of the shapes
industry refuses with, leaving a bare code. R15 fixed each:

| Shape | Raised as | Now surfaces as |
| --- | --- | --- |
| Prose | `throwWrappedUserError("CustomNotify", { notify: "<sentence>" })` — **132 call sites across the services** | the handler's own sentence |
| Structured | `throwIndustryValidationError` → code `IndustryValidationError` + an `errors` list of `(KeyVal{value,name}, args)` tuples | `IndustryValidationError: MISSING_MATERIAL, ACCOUNT_FUNDS` |

The gateway appends the server's **own** error names, unreworded (capped at 8).
Turning a name into a player-facing sentence is the client's presentation job
(`industryRefusalMessage` in `bridge/industry.ts`); an unmapped name falls back
to a generic sentence rather than leaking the code.

#### BFF mutation routes

- `POST /api/bridge/industry/preview` `{ blueprintItemID, blueprintTypeID,
  activity, facilityID, runs, licensedRuns? }` → `{ ok, available, inputLocation,
  outputLocation }`. `ConnectJob` then **always** `DisconnectJob` — the preview
  is not a pure read, so the monitor it opens is always released. Needs no
  confirmation: it spends nothing.
- `POST /api/bridge/industry/install` `{ …, confirm: true }` → `{ ok, applied,
  declinedSilently, jobID, job, blueprint }`. **Refuses with 400
  `CONFIRMATION_REQUIRED` unless `confirm === true`** — installing consumes
  materials and charges the wallet, so it is fenced exactly as `destroy-rig`
  (R12) and `trash` (R14) are. Re-reads **both** the job (which carries the cost
  actually charged) and the blueprint (now locked into that job).
- `POST /api/bridge/industry/deliver` `{ jobID }` → `CompleteJob`, then re-read.
  Not gated: delivery only ever gives.
- `POST /api/bridge/industry/cancel` `{ jobID, confirm: true }` → **400
  `CONFIRMATION_REQUIRED`** without it, because nothing is refunded.

⚠ **A 200 is not proof** (the R12/R14 lesson). `applied` always comes from the
**re-read**, never from the response: `InstallJob` answering a null jobID, or a
`CompleteJob` that leaves the status unmoved, are both silent declines and are
reported as `declinedSilently: true`. The browser then says the server declined
**without naming a cause it was not given**.

**The browser names an ACTIVITY, never an activityID.** The
name → id map lives only on the BFF, like R14's inventory places and R12's slot
families.

## Space snapshot — overview + ship HUD (R11)

The retail client's overview is a **client-side view over one server structure**:
the server enumerates the destiny Ballpark balls paired with their slimItems, and
the client dead-reckons positions locally and re-renders every 0.5–1.0 s.
Distance math, sorting, filtering and naming are all client-side. **So polling
here is faithful, not a compromise** — a ~1 s snapshot poll matches retail's own
re-render cadence, and this feature does **not** depend on the R10 push channel
(the channel carries events, not continuous positions).

The ship HUD is a **different source** from the overview: shield/armor/hull/
capacitor for the **active ship** come from the ship item's dogma-backed state
(retail: `godma.GetItem(shipID)`), not the ballpark. Other entities carry only
their `damageState`-equivalent fractions, which is what each overview row gets.

### `POST /_evejs-web/v1/space/snapshot`

Request: `{ "bridgeSessionID", "session"?: { "userid" } }` — a **read-only**
projection of what the held session can currently see, drained together with the
accumulated notification backlog. Ownership is checked before any space read: an
unknown handle or a foreign `userid` is `SESSION_NOT_FOUND` (404), never another
character's surroundings.

The gateway calls the space runtime and never modifies it:
`getSceneForSession(session)` → `scene.getVisibleEntitiesForSession(session)`
(statics + dynamics, already cloak-filtered) and
`scene.getShipEntityForSession(session)` for the ego ball, with the presentation
fields refreshed before projecting (the same refresh `ensureInitialBallpark` runs
before it builds a slim payload). Ship capacities come from
`space/combat/damage.js` `getEntityMaxHealthLayers(entity)`. Positions are
integrated server-side every tick (`RUNTIME_TICK_INTERVAL_MS = 100`), so each
poll sees a freshly integrated scene without the gateway stepping it. A
proxy-only process or a vanished scene degrades to an empty overview rather than
failing the read.

Success (200): `{ "ok": true, "space": { … }, "notifications": [...] }` where
`space` is:

- `inSpace`, `solarSystemID`, `shipID`, `sampledAtMs` (scene sim time — tells two
  polls apart).
- `entities[]` — one row per visible object: `kind`, `itemID`, `typeID`,
  `groupID`, `categoryID`, `name`, `ownerID`, `radius`, `position {x,y,z}`,
  `velocity {x,y,z}`, `isSelf`, and the remaining-health fractions
  `shieldRatio` / `armorRatio` / `hullRatio` (null for an object with no
  damageable health). Ship/structure rows add `characterID`, `corporationID`,
  `allianceID`, `securityStatus`, `maxVelocity`, `mode`, `targetEntityID`,
  `capacitorRatio`.
- `ship` — the active ship's HUD: `itemID`, `typeID`, `name`, `mode`,
  `maxVelocity`, `position`, `velocity`, the remaining fractions
  `shieldRatio` / `armorRatio` / `hullRatio` / `capacitorRatio`, and the
  capacities behind them (`shieldCapacity`, `armorCapacity`, `hullCapacity`).
  Null when docked or the scene is gone.

**The server never precomputes distance.** It reports positions; the browser
measures from the ship's own position, sorts, filters and caps —
`web/src/space/overview.ts`, exactly the division the retail client uses.

A docked session answers cleanly with `inSpace: false`, `entities: []`,
`ship: null` rather than an error.

## Client-side route solver & browser autopilot (R5b)

R5b automates the R5a atomic moves. It is **web-only — no eve.js/gateway change**:
R5a already allowlisted every atomic call (undock/warp/jump/dock) and added
`flight-status`, which is the whole authoritative surface the loop needs.

**The route solver is client-side (roadmap §7 / G2).** Retail solves routes
locally from its static map DB (`clientPathfinderService`) — there is **no wire
call to the game server for a route**. We mirror that: the browser holds a
system-adjacency graph and runs a pure BFS solver over it
(`web/src/nav/routeSolver.ts`). The graph is **read-only static reference data**
(like station names staying client-local, roadmap §4), served by `src/staticData.js`:

- `GET /api/map/graph` (requires the web login session; **no bridge session**) →
  `{ ok, source:"static-data", systemCount, edgeCount, systems, edges }`. Built by
  `staticData.getSolarSystemGraph()` from the gameStore **`stargates`** table:
  each stargate record is **one directed edge** — `edges` is a flat array of
  `[fromSystemID, toSystemID, fromGateID, toGateID]` where `fromGateID` is the
  source stargate's `itemID` (the autopilot warps to it and jumps **through** it)
  and `toGateID` is its `destinationID` (the gate on the far side). That is
  exactly the pair `beyonce.CmdStargateJump(fromGateID, toGateID, shipID)` (R5a)
  wants, and the same shape `autopilot.py` derives from
  `cfg.mapSolarSystemContentCache[sys].stargates` (`sg.destination`). `systems`
  maps each gate-connected system ID → name (panel readout only). Current data:
  5268 systems / 13978 edges.
- `GET /api/map/resolve/:id` (same auth) → resolves a picked destination (a
  courier destination is a station; the solver routes **systems**) to its solar
  system from static reference data: `{ ok, id, kind:"station"|"system"|"unknown",
  solarSystemID, systemName, stationID, stationName }`. The same client-local
  resolution `select` does for station identity — **not** a route or gateway call.
  R7a also uses this to resolve the **Flight readout's** current system / station
  ID → name (the browser caches resolved names client-side, so the flight-status
  poll doesn't refetch; a definitive `kind:"unknown"` — e.g. a player structure —
  is cached too, a transient failure is not).
- `GET /api/map/find?q=<text>[&kind=system|station][&limit=N]` (same auth; **R7a**)
  → searches the static **solar-system + station** tables by name so a player can
  set a destination by name instead of a raw EVE ID:
  `{ ok, source:"static-data", q, kind, total, capped, limit, count, matches }`,
  each match `{ id, name, kind:"system"|"station", solarSystemID, solarSystemName }`.
  `id` is the ID the client hands to `startRoute`. Matches are ranked by name
  match quality (exact → prefix → substring, then shorter/alphabetical) so a
  search for "Jita" surfaces the **Jita system** ahead of "Jita IV - ..." stations;
  `q` under 2 chars returns nothing (no whole-table dump); capped server-side
  (default 50 / max 200). Read-only static reference data mirroring
  `/api/agents/find` — **NOT a gateway/bridge call**. The client annotates each
  match with jumps-away from the current system using the already-loaded route
  graph (`distancesFrom`, a single BFS), like the Agent Finder.
- `POST /api/names` (same auth; **no bridge session**; **R7c**) → batch-resolves a
  set of `{ kind, id }` refs to display names so a list of many IDs (an inventory
  of typeIDs, a station's guest corps, an agent roster, ...) resolves in **one
  round-trip**. Body `{ items: [{ kind, id }, ...] }` with
  `kind ∈ type | typeGroup | typeCategory | category | corporation | alliance |
  faction | character | agent | station | system | region | owner`; response
  `{ ok, source:"static-data", count, capped, limit, names }` where `names` is
  keyed by `"kind:id"` and each value is the resolved **name string** or **null**
  for a definitive "unknown" (an NPC / type not in the static tables). Every
  requested item is echoed (so the client can cache the outcome for every key,
  including the nulls, and never refetch); duplicate `(kind,id)` pairs resolve
  once; the batch is **capped server-side** (`limit` 500) so an oversized request
  never scans the whole item table. `owner` resolves an ID whose entity type is
  unknown at the call site (a station owner, a standings `fromID`) by trying
  corp → faction → character → alliance in turn. Read-only static reference data
  over `src/staticData.js` `resolveNames` (which layers on the existing
  `getTypeName` / `getStationName` / `getCorporationName` / new `getFactionName` /
  `getCharacterName` / `getAgentName` getters) — mirrors `/api/map/find` and
  `/api/agents/find`, **NOT a gateway/bridge call**. The client name cache lives
  in `app/flow.ts` (`requestNames`): components ask for names by `(kind,id)`; the
  cache batches all unresolved refs raised in one microtask into a single POST,
  caches each result (name or definitive null), pushes them into the store's
  `names` slice for pure-reader components, never refetches a cached key, and
  does **not** cache a transient failure (so it can retry). Fire-and-forget — it
  never throws and never blocks a UI interaction; a component shows the raw ID
  until the name lands.

None of these routes touch a live bridge session or the gateway; they are not a
server-side travel job (the roadmap forbids reintroducing one).

**The decide-loop runs in the BROWSER** (`web/src/nav/autopilotLoop.ts`), a port
of `autopilot.py`'s `AutoPilot.Update`. Each ~2 s tick it reads `flight-status`
and issues **one** atomic call (undock / `CmdWarpToStuffAutopilot` /
`CmdStargateJump` / `CmdDock`) through the R5a BFF flight routes — it never
simulates or predicts position; each move's truth comes from the next
`flight-status`. Loop contract:

- **Truth model — measure, don't guess (R13).** The loop reads the R11 space
  snapshot each tick and computes the **surface distance** to its current target
  the way the server does:

  ```
  surfaceDistance = max(0, distance(a.position, b.position) - a.radius - b.radius)
  ```

  (identical to `services/drone/droneRuntime.js`; the snapshot's `ship` block
  carries the ego `radius` for exactly this). It then runs retail's ladder
  (`autopilot.py:274-404`) **in retail's evaluation order**, on one measurement
  per tick:

  | Measured surface distance | Target | Action |
  |---|---|---|
  | `< 2500 m` (`maxStargateJumpingDistance`) | stargate | **jump** |
  | `< 50000 m` (`maxDockingDistance`) | station/structure | **dock** |
  | `< 150000 m` (`minWarpDistance`) | either | **approach** |
  | otherwise | either | **warp** |

  The close-range rule is per target **kind** — a gate is never docked at and a
  station is never jumped to. Thresholds are strict `<`, so 2500 m exactly
  approaches. Warp/approach retain their short debounce. A successful
  undock/jump/dock already returns authoritative post-transition state, so the
  next normal decision tick consumes that truth without another guessed delay.
- **Measurement is primary; refusals are the backstop.** When the snapshot
  cannot be read, or cannot see the target (off grid, a scene mid-load), the tick
  falls back to the original R5b path — ship **mode** plus the server's own
  **refusals** — so the loop never stalls for want of a measurement. The snapshot
  read is a READ: it starts nothing, it cannot fail a tick, and a rejection just
  costs that cycle its measurement.
- **Never re-issue a running approach.** Retail skips its approach when the ship
  is already `DSTBALL_FOLLOW` on that same target. The loop does the same: it
  remembers what it told the ship to approach and, while the snapshot agrees the
  ship is following that target, it **waits** instead of restarting the move. The
  wait is bounded, so a ship that never closes stops rather than waiting forever.
- **Never act mid-warp.** `DSTBALL_WARP` returns immediately — before any
  measurement is consulted, so even a target measured inside jump range issues
  nothing while the ship is in warp.
- **Approach-then-redock (verified live).** `CmdDock` out of range refuses
  `DockingApproach` and the ship enters a FOLLOW approach; the loop **re-issues
  `CmdDock`** each cycle until `flight-status` shows docked — it does not assume
  one dock call docks.
- **Pause, don't guess.** Any unsafe/blocked refusal that is not the normal
  docking-approach (warp scrambled, gate restricted, invalid target, lost
  control) **pauses** the loop with the handler's own reason. A jump
  "not-close-enough" re-warps to the gate; a lost session unwinds to character
  select.
- **Tab close = client close.** The loop lives in browser JS; closing the tab
  kills it and it simply **stops issuing — no "stop" is sent**. The ship
  completes whatever server-side command was last issued and then sits. After
  **abort/pause the loop never calls the bridge again**. The BFF is a relay +
  session holder and **never advances travel with no client connected**.

## Courier completion & reward readout (R6)

R6 is the courier-milestone capstone. **Complete needs no new call:** completing
a courier is the already-allowlisted synchronous `agentMgr(bound).DoAction(<complete
actionID>)` — the same bound two-step accept uses (R4). The retail `DoAction`
result's `lastActionInfo.missionCompleted` flips to `true` and the mission clears
from the runtime. A courier Complete is a synchronous outcome and never takes the
deferred path; if any completion action were deferred, R4's deferred adapter
already drives it (or refuses `CALL_DEFERRED_UNSUPPORTED`).

**Delivery has no distinct RPC** (inventory Step 10): the courier package is
ordinary inventory (staged in the pickup hangar on accept, loaded into the ship
with the R3 invbroker move — Step 5 — and flown to the dropoff by the R5b browser
autopilot). `DoAction(Complete)` validates delivery server-side (the character is
at the dropoff with the package in the ship hold or the dropoff hangar) and pays
out.

**Step-12 reward reads** are the pull-refreshes a wallet/LP/standings/journal
panel issues after payout. Three are new top-level (non-bound) server-tier reads
(added to the allowlist above); the fourth (the mission journal) was already
allowlisted in R4:

- `account.GetCashBalance(0)` → the personal ISK balance, which eve.js sends as a
  `{type:"real"}` (a plain number or a `{type:"long"}` also decodes). Decoded to a
  bigint-safe decimal string.
- `LPSvc.GetAllMyCharacterWalletLPBalances()` → a CRowset (`objectex2`) of packed
  rows `[issuerCorpID, loyaltyPoints]`. LP kept as decimal strings.
- `standingMgr.GetCharStandings()` → a header/lines Rowset of `[fromID, standing]`
  (standings are small floats).
- `agentMgr.GetMyJournalDetails()` (R4) → after completion the mission is no longer
  in the journal (cleared). ⚠ **This is NOT a "mission done" signal — see R35.**
  Quit, decline and expire clear the row identically, so a missing row means only
  "the row is gone". The truthful signal is `lastActionInfo.missionCompleted`.

**Decoder rule:** amounts decode long-aware (`unwrapLong`, never
`typeof === "number" ? … : 0`); ISK/LP are decimal strings, standings numbers
(`web/src/bridge/rewards.ts`). eve.js also sends ISK money as a marshalled real,
`{type:"real", value}` (character selection's `balance`, `GetCharacterInfo`'s
`balance`/`bounty`/`aurBalance`), so decoders read it real-aware too:
`unwrapReal` for a number, `toAmountString` for a decimal string.

Proven in-process end to end by `eve.js server/tests/webGatewayCourierComplete.test.js`:
in-person accept → deliver the package to the dropoff → `DoAction(Complete)` actually
completes the mission (runtime record cleared, package consumed) and the Step-12
reads reflect the payout (wallet grows, an LP balance for the agent corp appears,
standing toward the corp grows, the mission leaves the journal). Deny-by-default is
re-proven for non-allowlisted `account`/`LPSvc`/`standingMgr` siblings.

## The distribution-mission rail, as measured live (R35)

R6 proved the courier capstone **in process**. R35 ran it on the **live server**,
twice, end to end. Nothing below is inferred: every claim is a captured byte.

**The run.** Agent **Antaken Kamola** (3008416, L1, CBD Corporation 1000002) at
Muvolailen 60000004 → dropoff Elonaya 60000256, **6 jumps**. Cargo **Reports x1,
0.1 m³**. Payout **+140,250 ISK**, **+213 LP**, **standing 0 → 0.18**; second run
**+140,250 ISK**, LP → 426, standing → 0.357. Mission title *"Tidings of Conflict
(1 of 2)"* — the pool is full of **chain fragments**, and the next request handed
out the chain's next mission (58607 → 58608).

### `DoAction` answers 200 on every branch — judge by `lastActionInfo`

A **refused** Complete (pressed docked at the **pickup** station), captured whole:

```
HTTP 200  { ok: true }
result = tuple(
  tuple( tuple(127958, 1382), list[] ),        # <- EMPTY actions list
  dict{ missionCompleted: null,                # <- null, NOT false
        missionQuit: null, missionCantReplay: null,
        loyaltyPoints: 0, missionDeclined: null } )
```

Three things follow, and two of them contradict what was previously assumed:

1. **`missionCompleted` is `null` on a refusal, not `false`.** The only safe test
   is `=== true`. `!== false` would report a refusal as a success.
2. **An empty `actions` list is NOT exclusively the standing gate.** It was
   documented as "`canUseAgent` false → zero actions → do not retry". A refused
   Complete produces the same emptiness, and **re-opening the conversation at the
   wrong station still returns zero actions**. Emptiness alone must never be read
   as "this agent is closed to you".
3. **The state recovers, and action tokens are re-minted.** At the dropoff the
   same agent offered Complete + Quit again with **new** tokens (815/816 →
   819/820 → 821/822). **Never cache an actionID across a move or a re-open.**

### The refusal is not silent — it names the unmet objective

The refused call carried a notification, on a channel not previously known to
carry a reason:

```
OnMissionsUpdated  info: ["TransportItemsPresent", "3814", "60000256", "1"]
                   agentID: 3008416
```

That is objective / typeID / place / quantity. The BFF already forwards
`notifications` on `POST /api/bridge/agents/:agentID/action`, so this is
available today without any new surface.

### The journal cannot tell you what happened

Captured immediately before and after Complete:

```
before: tuple( list[ [2, 0, "UI/Agents/MissionTypes/Courier", 58607, 3008416, …] ],
               list[] )
after:  tuple( list[], list[] )
```

The row is **deleted**, never moved to `COMPLETED = 4`. Quit, decline and expire
delete identically, so **complete / quit / decline / expire are indistinguishable
from the journal alone**. Never infer success from a missing row.

Also measured: **`lastActionInfo.loyaltyPoints` read `0` on the very completion
that paid 213 LP.** It is not the payout; the payout is read from
`LPSvc.GetAllMyCharacterWalletLPBalances`.

### Accepting: in person, and check the hold first

Remote accept is silently refused for couriers (`missionGrantsItemsOnAccept` is
true for every transport mission), so **accept in person**. Cargo runs from
0.1 m³ to **4,000 m³**, so read the hold's capacity **before** accepting — the
live run flew a Badger at **4,095 m³**.

### The package load goes through `/transfer`, not `/move`

**Changed in R35.** The courier package load previously used
`POST /api/bridge/inventory/move`, which answers `{ok:true}` with **no re-read**
and so cannot distinguish a move from a silent decline. It now uses
`POST /api/bridge/inventory/transfer` (see "Inventory depth"), which re-reads and
judges by the **source giving something up**. Measured live with the exact payload
the client now sends:

```
POST /api/bridge/inventory/transfer
  { itemIDs: [9988400091902], from: {kind:"hangar"}, to: {kind:"cargo"}, qty: 1 }
→ { ok: true, applied: true, moved: [9988400091902],
    reminted: [], declined: [], declinedSilently: false, notFound: [] }
```

**Selecting the package needs the quantity, not just the type.** Courier cargo is
ordinary tradeable stock — this mission hauled **Reports**, a market commodity —
so the first hangar stack of the cargo type may well be the player's own goods.
The client selects the stack whose quantity equals the mission quantity, and
otherwise splits exactly that quantity off a larger one. ⚠ **Residual ambiguity,
stated rather than hidden:** the server names the package's itemID **nowhere the
client can read** — not in `GetMissionObjectiveInfo`, not in the journal row, not
in the `OnMissionsUpdated` refusal — so a player stack of identical type *and*
quantity cannot be told apart from the package by any browser-side means.

### Server-side defect — recorded, not fixed

`getCourierProgress` (`eve.js agentMissionRuntime.js:2524-2588`) judges delivery
by **typeID, not itemID**. Pre-existing stock of the cargo type at the dropoff can
therefore satisfy the objective without anything being hauled. Because courier
cargo is ordinary market goods, this is reachable in normal play. **Server-side
and deliberately out of scope for the client/bridge work; recorded here so the
next reader does not rediscover it as a client bug.**

## Market — order books, your orders, placing and managing (R16)

**This is the first feature that spends the player's ISK.** EveJS's market is
real: `marketProxyService.js` does daemon-backed order books, order placement,
cancel and modify, backed by `debitCharacterWallet` / `creditCharacterWallet`,
escrow records, broker fees, an SCC surcharge and skill-gated order limits.

Like industry, the market needs **no bound-object machinery**: the whole retail
surface is top-level (`sm.ProxySvc('marketProxy')`), so `POST /api/bridge/call`
on the held session carries all of it.

### ⚠ Three traps, before the call table

**1. The service is `marketProxy`, NOT `market`.** EveJS registers two market
services. `marketService.js` registers as **`market`** and is a **dead stub** —
every method answers an empty rowset. The live implementation is
`marketProxyService.js`, registered as **`marketProxy`**. Allowlisting or calling
the stub produces a market page that renders perfectly and is **permanently
empty**, which reads as a bridge bug and is very hard to trace. No pair on the
allowlist names `market`, and a test asserts that by name.

**2. `marketQuote` has no server handler, and is not missing.** In retail it is a
**client-local** service: order caching, sorting, jump-distance filtering,
skill-gated order limits and best-bid matching are implemented in the client.
There is nothing to allowlist. The browser implements that logic itself in
`web/src/bridge/market.ts` — which is also why re-sorting an order book costs no
round-trip.

**3. An external daemon backs all of it.** `marketProxy` talks to an
out-of-process market daemon over **TCP `127.0.0.1:40111`** (`marketDaemonClient`).
When it is down, daemon-backed reads **throw** rather than answering empty. The
BFF detects that and reports an **outage**, because *"nobody is trading this
item"* and *"the market is not answering"* are different facts, and telling a
player the first when the second is true is a lie about their own position. If
market reads come back empty or erroring, **check the daemon before suspecting
the bridge.**

### The read call table

| What the panel needs | Retail call | Answers |
| --- | --- | --- |
| Daemon liveness | `marketProxy.StartupCheck()` | `None`, or throws |
| An item's order book | `marketProxy.GetOrders(typeID)` | `[sellsRowset, buysRowset]`, region from the **session** |
| The player's open orders | `marketProxy.GetCharOrders()` | owner-order rowset, open only |
| The player's finished orders | `marketProxy.GetMarketOrderHistory()` | the same rowset, closed only |
| The player's trades | `marketProxy.CharGetTransactions(fromDate)` | `list<util.KeyVal>` |
| What is locked up | `marketProxy.GetCharEscrow()` | `util.KeyVal{iskEscrow, itemsEscrow}` |
| Price history | `marketProxy.GetNewPriceHistory(typeID)` / `GetOldPriceHistory(typeID)` | history rowsets |
| Many types at once | `marketProxy.GetHistoryForManyTypeIDs(typeIDs)` | `dict<typeID → [old,new]>` |
| Cheapest nearby | `marketProxy.GetStationAsks()` / `GetSystemAsks()` / `GetRegionBest()` | summary dicts, all session-scoped |
| The wallet | `account.GetCashBalance(0)` | already allowlisted since R6 |

Twelve new deny-by-default read pairs.

**`marketProxy.GetCorporationOrders` is deliberately NOT listed** — it is the
corp-scoped sibling of `GetCharOrders` sitting on the **same service** as eleven
listed reads, so a service-granular allowlist would have handed the browser a
corporation's whole market position. `CorpGetTransactions` is absent for the same
reason. **The entire PLEX surface is deliberately absent** (`GetPlexOrders` /
`GetPlexBest` / `GetPlexHistory` / `GetPlexOldPriceHistory` /
`GetPlexNewPriceHistory` / `PlacePlexSellOrder` / `ModifyPlexCharOrder`): PLEX
trades on a special **global** market path, not the regional order book this
models.

**Scope.** Not one read takes an owner or a location argument. `GetOrders` scopes
to `session.regionid`; `GetCharOrders` / `GetMarketOrderHistory` /
`CharGetTransactions` / `GetCharEscrow` to `session.charid`; `GetStationAsks` to
`session.stationid`; `GetSystemAsks` to `session.solarsystemid2`; `GetRegionBest`
to `session.regionid`. The only argument any of them takes is a **typeID** (or a
`fromDate`) — *what* to look at, never *whose*.

### ⚠ Shape traps

**The order book rides a cached envelope.** `GetOrders` / `GetCharOrders` /
`GetMarketOrderHistory` answer a retail `CachedMethodCallResult`, not the rowset.
Unlike `map.GetStationInfo` (R2), whose payload is a cached-**object** reference
the browser genuinely cannot decode, these use the **inline** form: the real
payload rides `args[1]` as `{type:"substream", value:…}`. A decoder that reads
the envelope as a rowset finds nothing. A decoder that meets the *reference* form
answers `null` rather than fabricating an empty book.

**`GetOrders` answers a 2-TUPLE whose halves are not interchangeable.** `[0]` is
**sells** (what you can buy from), `[1]` is **buys** (what you can sell to).
Transposing them shows a player the wrong prices for the direction they are
trading in. Every row also carries its own `bid` flag, so the browser treats that
flag as authoritative and **drops** a row that disagrees with its half.

**The two rowsets use different row classes.** The order book is `blue.DBRow` —
each `line` is a **bare JSON array**. The owner-order rowset is `util.Row` — each
`line` is a `{type:"list"}` **wrapper**. A decoder that assumes one shape reads
zero rows of the other.

**Order-book columns** (15): `price`, `volRemaining`, `typeID`, `range`,
`orderID`, `volEntered`, `minVolume`, `bid`, `issueDate`, `duration`,
`stationID`, `regionID`, `solarSystemID`, `constellationID`, `jumps`.
**Owner-order columns** (21): `orderID`, `typeID`, `charID`, `regionID`,
`stationID`, `range`, `bid`, `price`, `volEntered`, `volRemaining`, `issueDate`,
`minVolume`, `contraband`, `duration`, `isCorp`, `solarSystemID`, `escrow`,
`constellationID`, `keyID`, `orderState`, `lastStateChange`.

`range` is how far an order **reaches** (`-1` this station, `0` this system,
`32767` the whole region — decoded to words, never printed as a number);
`jumps` is how far **away** it is, computed **server-side** from the session's
own position, so the browser never works out a distance itself. `orderState`:
`0` open, `1` filled, `2` expired, `3` cancelled.

**Money is a decimal string end to end.** ISK exceeds 2^53 in ordinary play, so
no price, escrow figure or balance becomes a JS number on its way to the screen
(R7d). Comparison, formatting and the before/after difference all work on decimal
strings (the last via BigInt hundredths).

### The write call table — exact positional signatures

Four new pairs. Every one reads its arguments **by index**; there are no kwargs
anywhere in the market surface, so a mis-ordered list is a *silently different
order*, not an error.

| Write | Signature |
| --- | --- |
| Place a buy | `PlaceBuyOrder([stationID, typeID, price, quantity, orderRange, minVolume, duration, useCorp, expectedBrokersFee])` |
| Place a sell | `PlaceMultiSellOrder([itemList, useCorp, duration, expectedBrokersFee])` |
| Cancel | `CancelCharOrder([orderID, regionID])` |
| Reprice | `ModifyCharOrder([orderID, newPrice, bid, stationID, solarSystemID, oldPrice, range, volRemaining, issueDate])` |

⚠ **`CancelCharOrder` ignores `regionID`** — the server reads only `args[0]` and
re-derives the region from the order it loads.
⚠ **`ModifyCharOrder` reads only `args[0]` and `args[1]`** and re-derives the
other seven. Both trailing sets are sent anyway because the shape is the retail
one; both facts are pinned by tests that pass **deliberately wrong** trailing
arguments and prove the outcome is unaffected — a client that got one wrong would
not be corrected by an error.

⚠ **Selling is ITEM-based, not type-based.** Each `itemList` entry must carry
`{itemID, typeID, stationID, price, quantity}`: the handler moves that specific
**stack** out of the hangar into escrow, so "10 of Tritanium" is not something
the market can act on. There is no single-sell method in the whole retail
surface; `PlaceMultiSellOrder` with a one-entry list is it.

**`marketProxy.BuyMultipleItems` is deliberately NOT listed** — a batch
immediate-buy across a whole shopping list, charging the wallet once per entry,
is not something a stray click should fire, and anything it can do one
`PlaceBuyOrder` can do deliberately.

### ⚠ `expectedBrokersFee` is a RATE and a CHECK, not a payment

`validateExpectedBrokerFeePercentage` compares it against the character's real
`brokerCommissionRate` and **refuses the whole order** with
`MktBrokersFeeUnexpected2` on a mismatch. Its purpose is to stop a player being
charged a rate other than the one they were shown.

The browser **cannot compute that rate**. It is `3% − (Broker Relations level ×
0.3%) − (faction standing × 0.03%) − (corp standing × 0.02%)`, floored at 100
ISK, and at a player-owned structure it is whatever that structure's owner set.
**No allowlisted read answers any of those inputs.** Sending a guess would refuse
legitimate orders from any trained trader, so the bridge sends **`null`** — the
documented "do not check" value — and the honesty is delivered the other way
round:

- the confirm step labels its 3% figure an **estimate**, says plainly that skills
  and standings change it and that this app cannot see either, and
- after the order lands the BFF **re-reads the wallet** and reports the amount
  actually charged.

A gateway test places an order with a deliberately wrong 99% rate, proves it is
refused, and proves the wallet was not touched.

### Client-side guards, applied BEFORE dispatch

- **Price rounded to 2dp** (`Math.round(v*100)/100`, the server's own `roundIsk`).
  The server rounds whatever it is sent, so an unrounded price is not rejected —
  it is silently **changed**. Rounding client-side means the number in the confirm
  dialog is the number that gets used.
- **`price > MARKET_MAX_ORDER_PRICE` (9 223 372 036 854) rejected**, so a typo is a
  clear message rather than an opaque server refusal.
- **Duration restricted to 0 / 1 / 3 / 7 / 14 / 30 / 90**, the set the server
  accepts.
- **Order range fixed to station-only (`-1`)**: a wider range is skill-gated and
  the server refuses one the character has not trained for.

### BFF routes (this repo)

- `GET /api/bridge/market?typeID=` → `{ ok, typeID, characterID, stationID,
  solarSystemID, book:{result,error}, ownOrders:{result,error},
  orderHistory:{result,error}, transactions:{result,error}, escrow:{result,error},
  cashBalance:{result,error}, priceHistory:{result,error}, marketUnavailable }`.
  Seven **independent** calls (`Promise.allSettled`): a player whose order book
  fails still sees their own orders, their trades and their ISK. `typeID` is
  optional — the own-market half answers before an item is chosen.
- `GET /api/market/find?q=` → `{ ok, source:"static-data", matches:[{typeID, name,
  groupName}] }`. Pure static reference data: **no gateway call, no live session**,
  so it answers even when the market is down. It is the only way the panel ever
  obtains a typeID, because a player must never be asked for one (R7d). Only
  **published** types carrying a `marketGroupID` are offered.
- `GET /api/ore/families` → `{ ok, source:"static-data", count, families:[{groupID,
  name}] }`, sorted by `name`. Pure static reference data, like `/api/market/find`
  — no gateway call, no live session. A "family" is a type GROUP within the
  Asteroid category (25): every grade of one ore and its compressed variant sit
  in the same group, so the distinct group set is the family set. Only
  **published** types are considered. Feeds the bot editor's ore picker.
- `GET /api/bots/belt-memory?system=` → `{ ok, system, belts:[{beltName, all,
  families:[groupID]}] }`. `system` (a solar-system NAME) is required — a
  missing/blank one is 400 `INVALID_SYSTEM`. Reads the BFF's SHARED, in-process
  belt memory (src/beltMemory.js): every mining bot on this BFF reports into it,
  keyed by solar-system name then belt name (belt entity ids are grid-local, so
  names are the only stable handle). No gateway call. Not persisted — lost on a
  BFF restart, and entries expire on their own after an hour. An unknown system
  answers `belts: []`, never an error.
- `POST /api/bots/belt-memory` `{system, beltName, groupID}` → `{ ok: true }`.
  Marks a belt dry: entirely (`groupID: null`) or of one ore family
  (`groupID` = that family's type group, a positive integer). Missing/blank
  `system` or `beltName` is 400 `INVALID_BELT`; a `groupID` that is neither
  `null` nor a positive integer is 400 `INVALID_GROUP`. No gateway call.
- `POST /api/bridge/market/buy` `{typeID, price, quantity, durationDays, confirm}`
- `POST /api/bridge/market/sell` `{itemID, typeID, price, quantity, durationDays, confirm}`
- `POST /api/bridge/market/cancel` `{orderID, confirm}`
- `POST /api/bridge/market/modify` `{orderID, price, confirm}`

**Every write refuses with 400 `CONFIRMATION_REQUIRED` unless `confirm === true`,
and the refusal happens before anything reaches the gateway** — the second gate
behind the UI's two-step confirm, exactly as R12's `destroy-rig`, R14's `trash`
and R15's `install` are fenced.

### ⚠ A 200 is not proof — reporting the ACTUAL charge

Each write route reads the **wallet before and after** and answers:

```jsonc
{ "ok": true, "applied": true, "declinedSilently": false,
  "charged": "1137.50",          // before − after, EXACT (BigInt hundredths)
  "balanceBefore": "1000000.00", "balanceAfter": "998862.50",
  "ownOrders": <re-read rowset> }
```

`charged` is the **only authoritative statement about what an order cost**. The
client's estimated fee never appears in a response and is never compared against
it. A refund (a cancel) reads as a **negative** charge.

`applied` comes from the re-read, never from the response, because the handlers
cannot be told apart by their return values:

| Write | Returns | How `applied` is judged |
| --- | --- | --- |
| `PlaceBuyOrder` | `None` whether it created an order, filled one, or did nothing | the wallet moved |
| `PlaceMultiSellOrder` | `True`/`False` — a real signal | the boolean, plus the wallet delta reported alongside |
| `CancelCharOrder` | `None` even when the order was already closed | the open-order count fell |
| `ModifyCharOrder` | `None` even when nothing changed | the order now carries the new price |

A write that answers success while nothing moved is reported as
`declinedSilently: true`, which reaches the player as *"The server did not apply
that change, and gave no reason."* — **no cause is ever invented.** A *thrown*
refusal keeps the handler's own sentence verbatim; a named market error
(`MktBrokersFeeUnexpected2`, `MktNotEnoughMoney`, …) becomes a plain sentence,
which is presentation, not diagnosis.

## Mail — your inbox, reading a message, writing one (R17 Slice A)

The whole retail mail surface is **top-level** (`sm.RemoteSvc('mailMgr')`), so
`POST /api/bridge/call` on the held session carries all of it — **no
bound-object machinery**.

### ⚠ Three traps, before the call table

**1. The inbox is a DELTA SYNC, not a list call.** There is no "give me my mail"
method anywhere on `mailMgr`. `SyncMail(firstID, lastID)` takes the **min and
max messageID the CALLER already holds** and answers only what falls *outside*
that window. A caller that invents a window gets a **partial mailbox and no
error at all**. The browser caches nothing across a page load, so it is
permanently cold and the BFF always sends the cold-start pair **`[null, 0]`** —
"I hold nothing, send everything". Both shapes are pinned in
`server/tests/webGatewayMail.test.js`.

**2. `GetBody` returns a zlib-DEFLATED buffer, not text.**
`mailState.getCompressedBody` answers `zlib.deflateSync(body)`, which crosses the
JSON bridge as `{type:"Buffer", data:[…]}`. **The BFF inflates it**
(`src/server.js`, `mailBodyText` → `zlib.inflateSync(Buffer.from(...))`) and
hands the browser plain text. **Never decompress in the browser** — that would
mean shipping an inflate implementation to every page load to undo something the
server did for a wire format the browser never speaks. A body that will not
inflate is reported `unreadable: true` rather than rendered as byte values.
`test/bridgeMail.test.js` builds a **real** deflated buffer and asserts no
`{"type":"Buffer"}` survives into the response.

**3. `toCharacterIDs` is asymmetric.** A header row reads it back as a
**comma-joined STRING** (`"140000003,140000004"`, or `null` for none), while
`SendMail`'s `args[0]` wants a **real list**. A decoder that assumes an array
turns two recipients into one character whose id is the whole string.
`bridge/mail.ts` `splitRecipientIDs` is the only place that string is
interpreted.

### The call table

| Call | Args | Answers |
|---|---|---|
| `mailMgr.SyncMail` | `[firstID, lastID]` — **`[null, 0]` cold** | `{newMail, oldMail, mailStatus}` |
| `mailMgr.GetMailHeaders` | `[[messageID, …]]` — **list NESTED in args[0]** | list of header rows |
| `mailMgr.GetBody` | `[messageID, shouldMarkAsRead]` (1/0) | **zlib-DEFLATED buffer**, or `null` |
| `mailMgr.SendMail` | `[toCharacterIDs, toListID, toCorpOrAllianceID, title, body, isReplyTo, isForwardedFrom]` | new `messageID`, or a bare `null` |

`GetMailHeaders` with a **flat** argument list silently answers nothing — the
list must be nested. `GetBody` with `shouldMarkAsRead=1` is a **write**: it
clears the unread bit and pushes `OnMailUpdatedByExternal` to the character's
other sessions.

### ⚠ An empty recipient list is NOT refused by the server

`mailState.sendMail`'s `NO_RECIPIENTS` guard reads
`recipients.length === 0 && !saveSenderCopy`, and `Handle_SendMail` **hardcodes
`saveSenderCopy: true`** — so the guard **can never fire through the gateway**.
Mail addressed to nobody allocates a real `messageID`, is written, is filed into
the *sender's own* mailbox, and **looks sent**. `POST /api/bridge/mail/send`
refuses an empty recipient list itself, because nothing downstream will.

### Security property

Not one of the four calls takes an **owner** argument.
`resolveSessionCharacterID` derives the mailbox from the session the gateway
materialized, so no argument a browser can send reaches another character's
mail — proven by a third character being blind to a message's header, its body
and its presence in a sync. `SendMail`'s sender is likewise the session.

### BFF routes (this repo)

| Route | Does |
|---|---|
| `GET /api/bridge/mail` | cold `SyncMail [null,0]`, + `GetMailHeaders` backfill only when a status row has no header; answers the raw arms plus a computed `unreadCount` |
| `GET /api/bridge/mail/body?messageID=&markRead=` | `GetBody`, **inflated to text**; re-reads to report `markedRead` |
| `POST /api/bridge/mail/send` | `SendMail` with the exact 7-arg positional shape; guards recipients/subject/length |
| `GET /api/characters/find?q=` | static reference data — **the one place the names rule runs backwards** (see below) |

### ⚠ A 200 is not proof

`markedRead` comes from a **fresh `SyncMail`**, not from the call succeeding;
when that re-read fails it is `null` and **no claim is made**. A send is
confirmed by finding the **sender's own copy** in a re-read. And `SendMail`'s
bare `null` — a decline carrying **no reason at all** — is reported as exactly
that (*"The server did not send that message, and did not say why."*); **no
cause is ever invented.**

### ⚠ Where R7d runs backwards

Everything renders by **name** (senders, recipients, a corp-wide message as
"everyone at ⟨corp⟩"). But composing needs the *reverse* direction, since
`SendMail` wants a `characterID` — and asking the player for one is exactly what
R7d forbids. So `GET /api/characters/find` searches the characters table **by
name** (mirroring `/api/map/find` and `/api/market/find`) and the id rides along
invisibly. The caller's own character is excluded: the server treats a
self-addressed message as a sender copy with no recipient.

**Out of slice:** the whole `mailingListsMgr` service (a separate
join/leave/moderate/broadcast surface), and `mailMgr`'s own label and
bulk-delete surface (`MarkAsRead` / `MoveToTrash` / `DeleteMail` / `EmptyTrash` /
`ReplaceLabels` …) — opening a message already marks it read via `GetBody`, and a
destructive bulk mail operation is not something a stray click should fire. Both
are refused before dispatch and named in a test.

## Contracts — the job board, your contracts, one in full (R17 Slice B)

**Reads only.** The whole surface is **top-level**
(`sm.ProxySvc('contractProxy')`) — no bound-object machinery.

### ⚠ Four traps, before the call table

**1. The service is `contractProxy`, NOT `contractMgr`** — the same shape as
R16's market trap. `contractMgrService.js` is **86 lines of dead stubs**:
`GetLoginInfo` answers three empty rowsets, `SearchContracts` an empty list,
`NumOutstandingContracts` `0` — every method hardcoded empty, and the retail
client never calls it. The live implementation is `contractProxyService.js`.
Naming the stub produces a contracts page that renders perfectly and is
permanently empty — **indistinguishable from trap 2**, which is what makes it
expensive. No pair names `contractMgr`, and a test refuses it **by name** with
the dead service deliberately registered, so the refusal proves the *allowlist*
rather than its absence.

**2. ⚠ A public browse is LEGITIMATELY EMPTY, and that is not a bug.** There is
**no NPC/seed contract generator anywhere in EveJS** — `createContract` exists
only in `contractRuntimeState.js` and its own handler, and nothing calls it at
startup. `SearchContracts` answers nothing until a **player** creates a contract.
The panel says so plainly: *"There are no public delivery jobs in this world yet.
Jobs appear here once a player creates one — nothing posts them automatically."*
**The BFF sets `worldHasNoContracts` ONLY when the browse SUCCEEDED and returned
nothing** — a *failed* browse must never set it, because "there is nothing to
find" and "we could not look" are different facts and the panel words them
differently.

**3. `SearchContracts` is KWARGS-ONLY.** `Handle_SearchContracts` ignores `args`
entirely and reads every filter off `kwargs`. Filters sent positionally are
**silently dropped** — a browse meant to show couriers quietly answers every
contract type, with no error.

**4. ⚠ `maxResults` is NOT the page size.** The envelope reports
`MAX_CONTRACTS_PER_SEARCH` (**1000**, `contractProxyService.js:29`) while
`searchContracts` actually slices by `CONTRACTS_PER_PAGE` (**100**,
`contractRuntimeState.js:48`). **The two constants disagree**, so a client that
pages by `maxResults` — the obvious reading — advances `startNum` by 1000 and
**skips 900 contracts per page**, silently. The BFF pages by 100 and never reads
that field.

### The call table

| Call | Args | Answers |
|---|---|---|
| `contractProxy.SearchContracts` | **`[]`** + kwargs `{contractType, availability, startNum}` | `{contracts:[{contract, items, bids}], numFound, searchTime, maxResults}` |
| `contractProxy.GetMyCurrentContractList` | `[isAccepted, forCorp]` | `{contracts, items}` |
| `contractProxy.GetMyExpiredContractList` | `[forCorp]` | `{contracts, items}` |
| `contractProxy.GetContractListForOwner` | `[ownerID, filtStatus, contractType, issuedBy]` — **only args[0..2] are read** | `{contracts, items}` |
| `contractProxy.GetLoginInfo` | `[]` | `{needsAttention, inProgress, assignedToMe}` — **rowsets** |
| `contractProxy.CollectMyPageInfo` | `[]` | the counts KeyVal |
| `contractProxy.GetContract` | `[contractID]` | the detail bundle, or `null` |

⚠ **A search entry WRAPS the contract** (`entry.contract`), while a list bundle
carries contract rows **directly**. Reading a search entry as a row finds no
`contractID` and drops every result — an empty browse indistinguishable from
trap 2. ⚠ `GetContractListForOwner` ignores its 4th argument **and both
documented kwargs** (`num`, `startContractID`), so a caller that thinks it is
paging gets the first page every time.

### Security property

Every contract **mutator** sits on the **same service** as the seven reads —
`AcceptContract`, `CompleteContract`, `CreateContract`, `DeleteContract`,
`DeleteMultipleContracts`, `SplitStack`, `SetContractExpired` — so a
service-granular allowlist would have handed the browser the power to move a
player's items and ISK. Each has its own **confirm-gated POST route** (R91) and
none is reachable from a read route, which is named in a test.
`GetContractListForOwner` is the only read that *could* name another owner; the
BFF only ever passes the session's own characterID, and the browser never
chooses that argument. Auctions and bids are **stubbed server-side**
(`PlaceBid` → `null`, `GetMyBids` → empty), so there is no bidding to build.

**Accepting a contract is wired to the panel; nothing else is.** `AcceptContract`
takes `[contractID, forCorp]` positionally, **transfers items and ISK** and
cannot be undone — so the BFF route refuses outright without `confirm: true`,
the panel asks on a screen that lists what changes hands, and the browser always
sends `forCorp: false` (accepting for a corporation needs a role the panel
cannot see). The game server guards it again: `canAcceptContract` refuses a
contract you may not take, and your own **unassigned** contract is refused
outright. A 200 is **not** proof — the handler answers the accepted contract
row, and `null` when the settlement did not go through, so an ack with no
contract in it is a decline. The other ten writes have routes and no caller.

### ⚠ The trap: a count with no list behind it

`GetLoginInfo.assignedToMe` counts the contracts **assigned to you**, and not
one of the other four reads can return them:

- `GetMyCurrentContractList` keys off **issuerID** (what you issued) and
  **acceptorID** (what you took on) — an assignee is neither;
- `GetMyExpiredContractList` keys off `contractNeedsAttention`;
- `SearchContracts` with `availability: PUBLIC` cannot match a contract
  **reserved for you**, which is by definition not public.

So the panel reported "1 waiting for you" above four empty lists, with no way to
see or take the contract. The fix reads the ids out of the count's **own**
rowset (`assignedToMe` carries `[contractID, issuerID]` per line) and fetches
each with `GetContract`. Deriving the list any other way drifts from the number
on screen: an unfiltered `SearchContracts` pages at 100 and drops assignments
past it, and `GetContractListForOwner` against your characterID misses every
contract assigned to your **corp or alliance**, which the count includes.

⚠ **A rowset line is a bare array**, not a marshalled row — `buildRowset` wraps
the lines in a `list`, but each line is the plain positional array the handler
pushed, and JSON carries it through as an array.

### BFF routes (this repo)

| Route | Does |
|---|---|
| `GET /api/bridge/contracts?page=` | five independent reads under `Promise.allSettled` (browse + outstanding + accepted + expired + summary), pages by **100**; then a second phase fanning `GetContract` out over the ids in `assignedToMe`, capped at **50** |
| `GET /api/bridge/contracts/detail?contractID=` | `GetContract`; its `null` becomes a **404**, not an empty detail pane |
| `POST /api/bridge/contracts/accept` | `AcceptContract [contractID, forCorp]`; **400 `CONFIRMATION_REQUIRED`** without `confirm: true` |

Each read keeps its **own error**, so a failed public browse never hides the
player's own contracts, and one assigned contract that could not be fetched
leaves the others in place with the shortfall reported as its own fact
(`assigned.numAssigned` above `assigned.results.length`). ISK (`price` /
`reward` / `collateral`) stays a **decimal string** the whole way — it exceeds
2^53 — and the four dates stay **bigints** (retail FILETIMEs) until they are
rendered.

## Agent Finder static route (R6a)

The per-station `agentMgr.GetAgents` roster is unreliable for *finding* an agent
to travel to (it returns 0 for a character re-selected directly into a docked
station, and only ever lists the current station). The Agent Finder instead
lists agents from the **static `agentAuthority` reference table**, sorted by
jumps from the player's current system, and sets the R5b browser autopilot to a
chosen agent's station. This is **read-only static reference data served by
`src/staticData.js`** — exactly the pattern of `GET /api/map/graph` (R5b):
**NOT a gateway/bridge call, NOT gameplay SQLite, NOT a server-side travel job.**
Web-only; no eve.js change.

- `GET /api/agents/find` (requires the web login session; **no bridge session**)
  → `{ ok, source:"static-data", kind, level, total, capped, limit, count, agents }`.
  Query params: `kind` (default `courier`; `all`/`any` disables the kind filter),
  `level` (optional, 1..5), `limit` (server result cap, default **500**, clamped
  to `[1, 5000]`). The BFF filters server-side by kind + level, sorts the pre-cap
  match set deterministically by `(level, agentID)`, and returns the first `limit`
  as compact summaries — so the ~11k-agent dataset never crosses the wire whole.
  `total` is the full match count before the cap; `capped` is `total > limit`.
  Each agent summary is `{ agentID, name (ownerName), level, divisionID,
  agentTypeID, missionKind, missionTypeLabel, corporationID, factionID,
  stationID, stationName, solarSystemID, solarSystemName }` — station/system
  **names resolved server-side** via `staticData.getStationName` /
  `getSolarSystemName`. Backed by `staticData.findAgents({ kind, level, limit })`
  reading `_local/gameStore/data/agentAuthority/data.json` (`agentsByID`).

**Kind is classified by `(divisionID, agentTypeID)`, not the raw `missionKind`
(R6b).** The static export stamps `missionKind:"courier"` on special agents too
— Paragon (e.g. "IRIS - Jita" agentID 3020034: `divisionID 37`, `agentTypeID
13`), off-division epic (division 25, type 12), plus career/storyline/event
placeholders in division 22 — none of which are ordinary courier agents. So the
finder classifies each exposed kind by its retail agent division + standard
agent type, and every other `(division, type)` is excluded:

  | kind | division | agentType | real agents (of 10,941) |
  | --- | --- | --- | --- |
  | `courier` | 22 Distribution | 2 basic | 3,725 (was 4,421 by raw missionKind) |
  | `encounter` | 24 Security | 2 basic | 3,655 |
  | `mining` | 23 Mining | 2 basic | 1,371 |
  | `research` | 18 R&D | 4 research | 244 |

  `all`/`any` returns the union of these real mission agents (still excluding the
  specials); a `kind` the finder does not classify matches nothing (an empty
  finder beats a mislabeled Paragon). Every export row is a
  `conversationMetadata.placeholder:true` with empty `missionTemplateIDs` — the
  runnable mission *content* lives in the mission runtime — so the finder filters
  to the right *kind* only, not to guaranteed content.

**Distance is computed client-side.** The route solver gains `distancesFrom(graph,
originSystemID)` (`web/src/nav/routeSolver.ts`): a **single BFS** over the
already-loaded gate graph returning the jump distance to every reachable system
at once (origin → 0; unreachable systems absent from the map → the finder flags
and sorts them last; invalid origin → empty map, never a throw). The finder runs
one BFS from the docked system and looks each returned agent's system up — never
a `solveRoute` per agent. "Set destination" reuses the R5b `startRoute(agent.
stationID)` (route solver + browser autopilot) — no new movement code.

**The finder requests `limit=2000`** (not the server default 500): 2000 fully
covers any single courier level (the largest, L1, is ~1531) so choosing a level
yields the complete, correctly-nearest-sorted set, while staying bounded well
under the 11k dataset; for all-courier (no level) the client renders a capped
page and the UI surfaces `total`/`capped` to prompt for a narrower filter.

## Docked-station-change refresh (R6b)

When the character's **docked station changes on the same live session**
(autopilot arrival, a manual dock, or select), the station-scoped panels — the
Station panel, the Agents & Missions agent list, and the Inventory & Ship panel
— must reflect the new station **without a page reload**. This is a web-side
reactivity concern: the flow already learns the new location from every
flight-status snapshot (manual step, autopilot tick, route-origin read), which
all funnel through one `observeFlightStatus(status)` choke point in
`web/src/app/flow.ts`. That pushes the snapshot to the `flight` slice and then
reconciles the docked station:

- It tracks the station the panels are synced to (`syncedStationID`, anchored on
  select). When a snapshot shows the character **docked at a different station**,
  it relocates once (guarded against re-entry and redundant same-station
  refetches; a lost session still unwinds to character select).
- Relocating applies a `station/relocated` store event — re-pointing the online
  location (`stationID` + `solarSystemID`, so the finder's distance origin and
  the panel header track the new station) and the static station identity — then
  re-runs the docked reads: `refreshStationPanel` always, and `loadAgents` /
  `loadInventory` only if their tab has already loaded (an unopened tab
  re-fetches on open via its own `onMount`). The autopilot tick voids the
  reconcile (the loop must not block on a panel refresh); a manual movement step
  awaits it (its busy state covers the refresh).

- `GET /api/map/station/:id` (requires the web login session; **no bridge
  session**) → `{ ok, source:"static-data", station: <StationStatic> }`. The
  same client-local static identity the select route returns (name / system /
  region / type / operation / security), keyed by station ID, so the flow can
  refresh the Station panel identity after the docked station changes. An unknown
  ID is a `404 STATION_NOT_FOUND`. Read-only static reference data like
  `/api/map/graph` and `/api/map/resolve` — NOT a gateway/bridge call.

## Local + Corp chat (R7)

Retail chat runs over XMPP, and its delivery **deliberately bypasses** the
`sendServiceNotification`/`sendNotification`/`sendSessionChange` surfaces the
bridge drains — so polling the notification drain yields **zero** chat.

> ### ⚠ The transport changed at EveJS v0.12.8 (2026-09-12)
>
> Everything below the next heading describes how this worked until that drop,
> and is kept because it explains what the routes used to promise. **None of it
> is live.** v0.12.8 deleted `POST /_evejs-web/v1/chat/read`, `/chat/send`,
> `runtime.readChat`, `runtime.sendChat` and
> `gatewayServices/webChatGatewayService.js` outright, and in the same drop added
> one line to `evejsWebGatewayRuntime.js` immediately after character selection:
>
> ```js
> // Browser-backed sessions still participate in ordinary online, station,
> // and space authority, but the companion no longer participates in Local
> // or Corp chat.
> session._localChatDeparted = true;
> ```
>
> `chatRuntime.js` filters departed sessions out of Local membership, so the
> decision was deliberate and complete: no route to read chat, and no membership
> to read it from. The BFF's reads answered `GATEWAY_ROUTE_NOT_FOUND` on every
> companion tick, `flow.ts` swallowed it (`.catch(() => null)`), and every
> chat-ordered companion behaviour — `follow`, `stop`, `target`, `salvage`,
> `loot`, `destination` — was silently dead while the readout still said the
> pilot was flying.
>
> **The chat itself never moved.** `chatHub.js` states where it lives: "Local/
> corp/fleet chat runs over XMPP MUC (member roster + messages) and the protobuf
> local-chat gateway". So the BFF now speaks XMPP to `xmppStubServer` — the same
> door the retail client comes through — instead of asking the gateway. See
> **Local + Corp chat over XMPP (R7, revised)** below for the live contract.
>
> The R10 push path lost its chat frames in the same drop (`event.kind: "chat"`
> is documented below and is no longer emitted); chat is a poll again.

### How it worked until v0.12.8 (historical)

Chat **READ** came from the **backlog store** every channel writes to
(`chatRuntime.getChannelBacklog(roomName)`); there was no RPC that returned
messages. The browser **polled** the read route on a modest interval (~4s) while
the Chat panel was open and stopped when it closed.

That goal had an operator-authorized broader eve.js footprint: the gateway
runtime/routes **and** a chat-gateway helper
(`gatewayServices/webChatGatewayService.js`) for the corp session-derived path.
Core chat mechanics (`chatRuntime`/`chatHub`/`xmppStubServer`/`channelRules`
delivery internals) were **not** modified — the helper only *called* them.

**Presence (a gateway side-effect).** The browser session's `sendSessionChange`
is a capture stub, so retail's auto chat-sync never fires; the gateway syncs
presence explicitly on select and on each read/send:

- **Local** membership is derived live from the session registry
  (`chatRuntime.getVisibleLocalSessions(roomName)`) — the browser session appears
  once it is registered (it is, from select) and docked in the room's system. The
  gateway calls `chatHub.joinLocalChannel(session)` on first sync (emits the
  retail join to other occupants) and `chatHub.moveLocalSession(session,
  prevSystemID)` when the session's solar system changes (a jump/dock). Local room
  = `getLocalChatRoomNameForSolarSystemID(solarSystemID)`.
- **Corp** has no session-derived membership in retail (it is XMPP-only, keyed by
  real XMPP sockets). R7 adds a session-derived corp path mirroring Local: the
  roster is enumerated from `sessionRegistry.getSessions()` filtered by
  `corporationID` (per-character deduped like Local), and `ensureCorpChannel`
  ensures the `corp_<id>` record.

**Retail visibility — the XMPP presence bridge (R7b).** In R7 the web player saw
everyone but *retail could not see the web player*: retail clients render their
Local/Corp roster from **XMPP MUC presence**, generated only for a character
holding a live XMPP socket (`xmppStubServer` `connectedClients`), and the
socketless browser session emits none. R7b closes that gap **server-side, in
`eve.js`** (operator-authorized core-chat change; no web-repo code beyond this
note and the corp emitter reconciliation in the gateway helper):

- `xmppStubServer` subscribes to `chatRuntime.runtimeEmitter` `local-join` /
  `local-leave` / `local-message` and, for a **socketless** author/member (one
  with no `connectedClient`), injects the corresponding synthetic MUC stanza —
  `available` / `unavailable` (+ the Local admin-leave notice) presence, or a
  `groupchat` message — to the room's XMPP occupants, reusing
  `buildRoomPresenceXml` / `deliverRoomMessage`. A `moveLocalSession` therefore
  produces a leave in the old room and a join in the new for XMPP occupants.
- A **retail-join roster seam** in `handleJoinPresence` additionally seeds a
  joining retail client's opening roster with `getVisibleLocalSessions` (Local) /
  session-registry-by-corp (Corp) members that hold no `connectedClient`, so the
  web player is present from the first render.
- **Corp** rides the gateway helper's private `corpChatEmitter`: `syncPresence`
  emits `corp-join`/`corp-leave` on a corp-membership transition and
  `broadcastCorpMessage` emits `corp-message`; `xmppStubServer.subscribeCorpChat-
  Bridge(corpChatEmitter)` (registered by the helper — cycle-free, since
  `xmppStubServer` never requires the helper) injects the matching corp MUC
  stanzas to `corp_<id>` occupants.
- **Guardrails:** every bridge handler dedups by `characterID` and returns before
  any side effect for a character that already holds a live XMPP `connectedClient`
  (retail's own machinery covers those), so **retail↔retail rooms are byte-for-
  byte unchanged**; delayed-local rooms (wormhole/Pochven/nolocal) stay
  hidden-until-you-speak because the runtime only emits a presence-bearing local
  event for them once a member speaks.

Delivery to the browser itself is unchanged (backlog poll); the bridge only makes
the socketless member **visible and audible to retail XMPP clients**.

### `POST /_evejs-web/v1/chat/read`

Request: `{ "bridgeSessionID", "session"?: { "userid" }, "channel": "local"|"corp", "limit"? }`.
Re-syncs presence, then returns the channel's current member roster + recent
backlog for the held session, plus the drained notification backlog.

Success (200): `{ "ok": true, "chat": { "channel", "roomName", "solarSystemID",
"corporationID", "roster": [ { "characterID", "name", "corporationID",
"allianceID", "solarSystemID", ... } ], "messages": [ { "characterID",
"characterName", "message", "createdAtMs", ... } ] }, "notifications": [...] }`.
`roster` rows are `chatRuntime.buildCharacterSummary` shapes; `messages` are the
backlog entries. For Corp with no corporation, `corporationID` is null and the
roster/messages are empty (no throw).

### `POST /_evejs-web/v1/chat/send`

Request: `{ "bridgeSessionID", "session"?: { "userid" }, "channel": "local"|"corp", "message" }`.
Re-syncs presence, then broadcasts: **Local** via
`chatRuntime.broadcastLocalMessage(session, message)`; **Corp** via the
session-derived corp broadcast — `chatRuntime.sendChannelMessage(session,
corp_<id>, message)`, which writes to the `corp_<id>` backlog (the same core
append Local uses) and emits a `corp-message` runtime event — **NOT** an XMPP
send. A channel access failure or mute surfaces as the core handler's own
`CALL_REFUSED` (409); an empty message or unknown channel is `CALL_INVALID`
(400); a corp send with no corporation is `CALL_REFUSED`.

Success (200): `{ "ok": true, "chat": { "channel", "roomName", "sent": true,
"entry": { "characterID", "characterName", "message", "createdAtMs" } },
"notifications": [...] }`.

## Local + Corp chat over XMPP (R7, revised 2026-09-12)

The BFF joins the game's own chat server as the held character. No gateway route
is involved, which is the point: the two that existed were deleted by a vendor
drop, and the protocol the retail client speaks cannot be.

```
browser --GET /api/bridge/chat/local--> web BFF --XMPP MUC--> xmppStubServer:5222
```

**Connection.** One TCP connection per held bridge session, opened lazily by the
first chat read or send and closed when the character is released — so a session
that never looks at chat never joins a room and never appears in anyone's Local.
Implementation: `src/evejsXmppChat.js`; wiring: the two routes below.

`EVEJS_XMPP_HOST` (default: the host in `EVEJS_GATEWAY_URL` — they are the same
process), `EVEJS_XMPP_PORT` (5222), `EVEJS_XMPP_DOMAIN` (`localhost`),
`EVEJS_XMPP_CONFERENCE_DOMAIN` (`conference.<domain>`). The defaults are the
server's own `config/server.json` defaults, so a stock server needs no
configuration.

**The listener is TLS, not STARTTLS.** `edge/chat/chatEdgeProcess.worker.js`
builds it with `tls.createServer({...readXmppTlsCredentials(), minVersion:
"TLSv1"})` and logs it as `tls://<host>:<port>`, so the first byte on the wire is
a ClientHello. A plaintext stream header is dropped with **nothing** sent back
and **nothing** written to `logs/xmpp-stub.log` — the edge never hands the socket
to the stub. The certificate is the server's own locally generated credential and
is not verified by default (`EVEJS_XMPP_TLS_REJECT_UNAUTHORIZED=1` turns
verification on); `EVEJS_XMPP_TLS=0` drops to plain TCP for a pre-TLS server or a
test.

**Identity.** SASL PLAIN, where the JID's local part **is** the identity:
`findSessionForClient` parses it as a character id and looks up that character's
live session. The secret is **not checked** (`parsePlainAuth` ignores it).

> ⚠ Therefore the character id must come from the **held session** and from
> nothing a browser sent. There is no credential to get wrong here, which is
> exactly why the identity must be got right. `heldChatSession(held)` reads
> `held.characterID`; no route accepts one.

**Rooms are resolved by the server, never named by the client.** The stub accepts
`local@conference.<domain>`, `corp@conference.<domain>` and
`fleet@conference.<domain>` as aliases and resolves each from the session
(`normalizeRoomJid`). The BFF joins the alias and learns the real room
(`local_30000142`, `wormhole_31000005`, `corp_98000000`, …) from the
self-presence it gets back — which is what keeps wormhole, Triglavian and
no-local systems correct without copying `channelRules.js` into this repo.
`fleet` is reachable by the same mechanism and is **not** wired up yet.

**A join un-does the v0.12.8 departure.** `handleJoinPresence` calls
`chatRuntime.joinLocalLsc(session)`, whose first act is
`markSessionLocalDeparted(session, false)`. The companion is in Local because it
joined Local — nothing is patched server-side.

> ⚠ **This is visible in the world.** A joined companion appears in other
> players' Local member list and its presence is broadcast to the room, like any
> other pilot in the system. The ship really is there, but this is a change other
> people can see.

**Moving between systems.** Retail's auto-move (`chatHub.moveLocalSession`) rides
on `sendSessionChange`, which is a capture stub for a browser-backed session and
never fires. The BFF therefore watches the held session's `solarSystemID` — kept
current by every flight-status read — and when it changes, leaves the old room
and re-joins the `local` alias, letting the server name the new room. The system
id is a **change detector only**; it never becomes a room name.

**Attribution.** A MUC nick **is** the speaker's character id, filled in
server-side from their session (`handleGroupMessage`), so a chat order's sender
is as unspoofable over this transport as it was over the backlog store — which is
what the fleet companion's `isChatCommandSenderAllowed` gate keys on. The room's
own voice (MOTD, notices, refusals) arrives as nick `admin` carrying a JSON
`{cmd:"speak", charid, messageText}` and is surfaced as a message from that
`charid`; other admin commands are ignored.

**Timestamps are arrival times, and honest.** The stub sends no `<delay>`, so
there is no server clock on the wire. Live delivery is immediate, so arrival time
is accurate for every line said while the session was listening. Local has **no
join history** (`handleJoinPresence` skips backlog for local rooms, matching
retail), so the channel the chat orders live on has no older-than-we-know case;
Corp does replay its backlog on join and those lines land stamped with the join
instant.

### `GET /api/bridge/chat/:channel` (`local` | `corp`)

Query: `limit?`. Ensures the connection and the room, then answers with the
roster and the message tail.

Success (200): `{ "ok": true, "chat": { "channel", "roomName", "solarSystemID",
"corporationID", "roster": [ { "characterID", "name", "corporationID",
"allianceID", "solarSystemID" } ], "messages": [ { "characterID",
"characterName", "message", "createdAtMs" } ] }, "notifications": [] }`.

Two honest differences from the backlog-store era, both deliberate:

- **`notifications` is always empty.** The old route drained the gateway's
  capture buffer as a side effect of asking it for chat; this transport never
  touches the gateway, and every other bridge call still drains.
- **A read returns what was said while this session was listening** (plus, for
  Corp, the join-time backlog the room replays), not the store's history.

**A chat server that is not reachable FAILS the read** — `502` with a
`CHAT_TRANSPORT_*` code — rather than answering with an empty message list. That
distinction is the whole lesson of the silent 404s: "deaf" and "nobody said
anything" must never look the same. A failed chat read never drops the held
session; an unreachable chat server says nothing about whether the character is
online.

### `POST /api/bridge/chat/:channel/send`

Body: `{ "message" }`. Speaks in the room as the held character
(`<message type='groupchat'>`, which the server routes through
`chatRuntime.broadcastLocalMessage` for Local).

Success (200): `{ "ok": true, "chat": { "channel", "roomName", "sent": true,
"entry": { "characterID", "characterName", "message", "createdAtMs" } },
"notifications": [] }`. The `entry` is **provisional** — an acknowledgement that
the write went out. The server echoes the real line back to every occupant
including us, and that echo is what a later read returns.

Empty message → `400 EMPTY_MESSAGE`; unknown channel → `400 INVALID_CHANNEL`; no
character online → `409 NO_LIVE_SESSION`.

## Live event channel — the push path (R10 / roadmap G6)

Everything above is **pull**: handler notifications are captured into a
per-session array and drained onto the next call response, and chat is a backlog
poll. R10 adds a real **push** channel alongside them. It is strictly
**additive** — the `notifications` drain on every response is unchanged, so a
browser with no channel behaves exactly as it did before, and a reconnect gap
can never lose data the next response would have carried anyway.

The chain is **gateway WebSocket → BFF → browser SSE**. The `bridgeSessionID`
never leaves the server, exactly as on the request routes.

### `GET /_evejs-web/v1/session-events` (WebSocket upgrade)

Query: `userid`, `bridgeSessionID`, and optionally the resume cursor
`epoch` + `sequence` (both or neither — a half cursor is `INVALID_EVENT_CURSOR`
400, not a fresh subscribe).

Rides the **same** `server.on("upgrade")` seam, `WebSocketServer`, 2 MB frame /
4 MB buffer guards, ping/pong heartbeat, and graceful shutdown as the existing
character-event path (`/events`, keyed by `characterID`). Inbound client
messages are rejected — the channel is strictly server→client.

**Authorization** is resolved *before* the handshake completes, so a refusal is a
readable HTTP status rather than an opened-then-closed socket: the
`bridgeSessionID` must resolve to a live session owned by `userid`. An unknown
**or foreign** handle is opaquely `SESSION_NOT_FOUND` (404); a malformed request
is 400; a not-ready runtime is 503.

> **Upgrade auth matches request auth.** `authorizeGatewayUpgrade` previously
> returned `false` whenever no `EVEJS_WEB_GATEWAY_TOKEN` was configured, while
> `authorizeGatewayRequest` fell back to loopback-allow. That divergence made the
> push channel unreachable in the ordinary token-less local setup even though
> every request route on the same origin worked. Both now use one rule: with a
> token configured, present it; without one, **loopback only**.

**Frames.** Every frame carries `source: "evejs-web-gateway"`, `apiVersion`,
`streamVersion`, and `cursor: { epoch, sequence }`.

- `type: "event"` with `event.kind: "notification"` — one capture from the
  session's `sendServiceNotification` / `sendNotification` / `sendSessionChange`
  stub, in the same shape the drain carries (`kind` is `service` / `client` /
  `sessionchange`).
- `type: "event"` with `event.kind: "chat"` — `{ channel: "local"|"corp",
  roomName, entry }`, sourced by subscribing to `chatRuntime`'s existing
  module-level `channel-message` emitter and routing by room name to each live
  browser session's Local and Corp rooms. `entry` is the **same backlog-entry
  shape the chat READ returns**, so a pushed message and a polled one decode
  identically. Chat mechanics are subscribed to, never modified.
- `type: "snapshot"` — the replay fallback (below).

### Replay or snapshot

Copied from `characterEventRuntime`: a per-process `epoch`, a per-session
monotonic `sequence`, and a bounded history (256 frames). On subscribe:

- **Replayable cursor** (same epoch, within the retained horizon): exactly the
  frames after `cursor.sequence` are delivered, then live delivery continues.
  The subscriber is registered *before* the replay batch drains, so the handoff
  from replay to live is atomic with no gap.
- **Otherwise**: a single `snapshot` frame carrying the current high-water cursor
  and a `reason` — `"no_cursor"` (a fresh subscribe, nothing was missed) or
  `"cursor_not_replayable"` (a gateway restart or a cursor past the horizon).
  A session stream has no separately readable authoritative state to snapshot, so
  the frame's honest content is "resynchronize by reading" — the browser answers
  `cursor_not_replayable` with a chat re-read rather than assuming continuity.

Frames are retained even with no subscriber attached, which is what makes a
reconnect during a brief drop lossless. A consumer whose `onFrame` returns
`false` (the socket overflowed its buffer) is dropped as `consumer_rejected`.
Ending the bridge session (release, idle TTL, retail takeover, shutdown) drops
its stream and closes attached sockets.

### BFF: `GET /api/bridge/events` (SSE)

Same-origin, routed to the web session's own held bridge session; 409
`NO_LIVE_SESSION` without one, 401 without a login.

**This is the one route that takes the session token in the query string**
(`?access_token=<token>`), because `EventSource` cannot set request headers —
see "Session carriers (R42)" below for why that is bounded to this route and
what it costs. The cookie still works here too.

The BFF holds **at most one** gateway WebSocket per held bridge session,
regardless of how many browsers attach. It is opened lazily on first attach and
closed when the last browser detaches, so a held session nobody is watching costs
nothing. The BFF remembers the last cursor it saw, so a reconnect resumes from it
and the gateway replays the gap.

Gateway frames are forwarded verbatim. The BFF adds its own status frames —
`{ source: "evejs-web-bff", type: "stream-status", state, detail }` with `state`
one of `connecting` / `live` / `degraded` / `ended` — so the browser knows when
to lean on its polls. A dropped gateway socket is announced as `degraded` and
retried with the cursor; a gateway 404 (the session is gone) is announced as
`ended` and **not** retried, since retrying cannot fix it.

### What stays polled

- **Chat roster** — the channel carries messages, not membership changes.
- **Flight status**, inventory, agents, journal, rewards — all still explicit
  reads. The channel is a liveness signal, not a state replacement.
- **The space snapshot (R11)** — and deliberately so: the retail client
  re-renders its own overview every 0.5-1.0 s, so a ~1 s poll IS the faithful
  cadence, not a fallback the channel replaces.
- **The chat backlog poll itself**, as a safety net: it drops from 4s to 30s
  while the channel is live and snaps back to 4s the moment it is not. (It
  also used to be the only thing keeping the held bridge session warm against
  its idle TTL; since 2026-08-22 the attached channel itself counts as
  activity, so the poll is purely a data safety net.)

The browser side feeds pushed messages into the chat slice (deduplicated against
what a poll already delivered, by author + text + timestamp) and pushed
notifications into a bounded `live` slice — which is where the drained
`notifications` the page used to discard now actually land.

## BFF routes (this repo)

`POST /api/bridge/call` — requires the signed web login session (else 401 `AUTH_REQUIRED`).

Request body: `{ "service", "method", "args"?, "kwargs"?, "session"?, "pilot"?, "confirm"? }` — same tuple shapes as the gateway route. `service` and `method` are each non-empty text: anything else (a list of one name, a number, nothing) is refused with 400 `INVALID_REQUEST` before anything is asked. `pilot: true` says the call is a pilot's: with no bridge session held it is refused with 409 `NO_LIVE_SESSION` and is not taken for the account's. This generic seam is **read-only but for the page's own writes** (2026-10-10, the transport plan's Phase 6b): a classified write is made only when the body says `pilot: true` and `confirm: true` (each the JSON value, not text) **and** the pair is on `PAGE_WRITE_PAIR_KEYS` in `src/bridgeCallPolicy.js` (six so far: `contractProxy.AcceptContract`, with the contract's ID and whether it is for the corporation as its two arguments, answering the contract's row, or none where nothing was settled; `crimewatch.SetSafetyLevel`, with the level as its one argument, which the BFF does not check here as its route did: the server holds any number to one of the three; `planetMgr.DeleteLaunch`, with the launch's ID as its one argument, answering false for a launch that is another character's and true otherwise, which removes the record and leaves the container in space; `skillHandler.AbortTraining`; `skillHandler.ApplyFreeSkillPoints`, with the skill's type and the points as its two arguments, answering the free points left; and `skillHandler.SaveNewQueue`, which the game port alone carries: through the web gateway it answers 403 `CALL_NOT_ALLOWED` with nothing saved, and `POST /api/bridge/skills/queue` saves; the manifest in `contracts/` names them as `boundary.genericBridgeWrites`); it is then made as a write's own route makes it, under the same checks of the held session. Every other classified write returns 403 `BRIDGE_WRITE_REQUIRES_DEDICATED_ROUTE`, whatever the body says, and must use its operation-specific confirmation route. The page's arguments are handed on as they come, so a pair goes on that list only once the server's handler is read for what it trusts. Identity is server-pinned: **`session.userid` always comes from the logged-in account's `accountID`**. Browser session input is projected onto the explicit presentation-only allowlist `languageID`, `languageId`, `languageid`, and `language`; supplied identity, character, corporation, role, ship, and location fields are ignored. **R2:** when this web session holds a persistent bridge session, the BFF attaches its server-held `bridgeSessionID` automatically (one web login is one client session, like retail); a browser-supplied `bridgeSessionID` is ignored. A `SESSION_NOT_FOUND` from the gateway drops the held handle (the page should return to character select) and passes through as 404.

Success response: `{ "ok": true, "service", "method", "result", "notifications", "serverNowMs"? }` (the gateway envelope minus `source`/`apiVersion`; `serverNowMs` only where a pilot is held: on the game port the pilot's session clock, through the gateway the BFF's own). Gateway errors pass through with their status and `error` code (`CALL_NOT_ALLOWED` → 403, `CALL_REFUSED` → 409, etc.); transport failures surface as `EVE_GATEWAY_UNREACHABLE`/`EVE_GATEWAY_TIMEOUT` (502).

### Persistent-session routes (R2)

- `POST /api/bridge/select` with `{ "characterID" }`: validates ownership against the logged-in account, releases any previously held bridge session (character switch), then forwards the retail tuple `[characterID, null, true]` to the gateway's `session/select` with the pinned `userid`. The returned `bridgeSessionID` is stored **server-side only** (keyed by the signed web session); the browser gets `{ "ok": true, "character": {characterID, characterName, stationID, structureID, solarSystemID, corporationID}, "station": <client-local static identity or null>, "notifications": [...] }`. `station` is read-only static reference data (name/system/region/type/operation/security) — the same client-local resolution retail does from its static DB. Handler refusals pass through as `CALL_REFUSED` with the handler's message.
- `POST /api/bridge/release` with `{}`: releases the held bridge session (if any) → `{ "ok": true, "released": <bool> }`. `POST /api/logout` also best-effort releases it.

### Agent routes (R4)

All require the signed web login session and a held bridge session (else 409
`NO_LIVE_SESSION`). The browser addresses agents/missions by game ID; the BFF
holds the bound agent handle (cached per web session under `agent:<agentID>`,
re-binding on `BOUND_HANDLE_NOT_FOUND`).

- `GET /api/bridge/agents` → `{ ok, stationID, agents: [...] }`. Dispatches
  `agentMgr.GetAgents` on the held session and returns the plain agent rows at
  the docked station (decoded + filtered server-side).
- `POST /api/bridge/agents/:agentID/action` `{ actionID?: number|null }` →
  `{ ok, result, notifications }`. Binds the agent and dispatches
  `DoAction([actionID])` on it (the deferred decline is driven to completion by
  the gateway). `result` is the raw retail-shaped DoAction tuple.
- `GET /api/bridge/agents/:agentID/briefing` →
  `{ ok, agentID, briefing, objective, location, errors: {...} }`. Binds the
  agent and reads `GetMissionBriefingInfo` / `GetMissionObjectiveInfo` /
  `GetAgentLocationWrap` (independent `Promise.allSettled`; each carries its own
  error code). Raw results are decoded browser-side.
- `GET /api/bridge/journal` → `{ ok, result }`. Dispatches
  `agentMgr.GetMyJournalDetails` on the held session; raw result decoded
  browser-side.

Errors pass through with the gateway's status; a `SESSION_NOT_FOUND` drops the
held bridge session (the page returns to character select).

### Reward-readout route (R6)

Requires the signed web login session and a held bridge session (else 409
`NO_LIVE_SESSION`). The browser drives Complete through the existing
`/api/bridge/agents/:agentID/action` route (bound `DoAction(<complete actionID>)`)
and refreshes the journal via `/api/bridge/journal`; this route covers the other
three Step-12 reads.

- `GET /api/bridge/rewards` → `{ ok, cash, lp, standings, errors: {...} }`.
  Dispatches `account.GetCashBalance(0)`, `LPSvc.GetAllMyCharacterWalletLPBalances`,
  and `standingMgr.GetCharStandings` as top-level calls on the held session. The
  three reads are independent (`Promise.allSettled`) so one failed read never
  blanks the rest; each carries its own error code. Raw retail-shaped results are
  decoded browser-side (`web/src/bridge/rewards.ts`). A `SESSION_NOT_FOUND` drops
  the held bridge session (the page returns to character select).

### Flight routes (R5a)

All require the signed web login session and a held bridge session (else 409
`NO_LIVE_SESSION`). `ship.Undock` is a top-level call on the held session;
warp/jump/dock go through the beyonce remote-park bound-object two-step — the
BFF holds the bound park handle server-side, cached under `park:<solarSystemID>`
so a jump (which changes the system) rebinds the park for the new system. Each
movement route reads the current flight status first (to resolve the live
system + ship and guard `NOT_IN_SPACE`). Session-changing routes issue their
command **once**, then wait for authoritative location plus scene/ego/ship
postconditions before answering. Their response includes `transition` metadata
(`epoch`, `kind`, `phase`, readiness flags and `cooldownUntilMs`). A 504
`TRANSITION_TIMEOUT` is an uncertain outcome and remains latched: no retry can
repeat the write until the character is reselected.

While a transition is requested/accepted/session-changing (or has failed with
an uncertain outcome), the BFF refuses every other bridge POST action with
`SESSION_CHANGE_IN_PROGRESS`. GET reads, the policy-read-only generic call,
release, and character reselection remain available. This is a conservative
route-wide guard, including ordinary warp/module/inventory endpoints that do
not themselves create a session change.

Retail's advertised **10-second session timer is not readiness**. It is the
next legal session-mutation window. Ordinary movement and reads may continue as
soon as the observed postconditions are ready; if another dock/undock/jump/
board/clone request arrives before the timer ends, the BFF reserves it and
waits only the remaining cooldown before dispatching. Concurrent session writes
are refused with `SESSION_CHANGE_IN_PROGRESS`.

- `GET /api/bridge/flight/status` → `{ ok, flight, notifications }`. The
  read-only flight snapshot includes the current transition/cooldown state plus
  authoritative `shipTypeID` and `shipIsCapsule` fields (unknown is `null`).
- `POST /api/bridge/flight/undock` `{}` → `{ ok, flight, transition,
  notifications }`.
  Dispatches `ship.Undock(shipID, false, onlineModules=[])`; refuses
  `ALREADY_IN_SPACE` if not docked.
- `POST /api/bridge/flight/warp` `{ destinationID, minRange? }` → `{ ok, result,
  flight, notifications }`. Binds the park and dispatches **one of two** warps:
  without `minRange`, `beyonce.CmdWarpToStuffAutopilot([destinationID])` (the
  autopilot's warp); with it, `beyonce.CmdWarpToStuff(["item", destinationID],
  {minRange})` — the right-click "warp to within N" form, where the **subject
  string is positional and the range is a kwarg**. `minRange` must be one of
  retail's offered distances `[0, 10000, 20000, 30000, 50000, 70000, 100000]`
  metres (anything else is `400 INVALID_RANGE`). Retail's own default for that
  menu is **0**, not 10 km.
- `POST /api/bridge/flight/warp-member` `{ characterID, minRange? }` → `{ ok,
  result, flight, notifications }`. Binds the park and dispatches
  `beyonce.CmdWarpToStuff(["char", characterID], {minRange}?)` — the retail
  "warp to" on a fleet-window row. **The only warp whose destination need not be
  on this grid**, which is the whole reason it exists: the server resolves where
  the member is (`resolveFleetMemberWarpTarget`, `beyonceService.js`) and
  enforces the rules this route does not restate — both characters in the SAME
  FLEET, the target online, an Abyssal runner refused. Those come back as the
  handler's own `CALL_REFUSED`, so a wrong or stale character id fails loudly
  rather than flying the ship somewhere nobody named. Used by the fleet
  companion's `warp <character link>` chat order (rung e2).
- `POST /api/bridge/flight/jump` `{ fromGateID, toGateID }` →
  `beyonce.CmdStargateJump([fromGateID, toGateID, shipID])`. The system
  response waits until the destination system, scene and ego are ready.
- `POST /api/bridge/flight/jump-through-structure`
  `{ structureID, confirm: true }` first resolves
  `structureJumpBridgeMgr.GetJbStructureDestination([structureID])` on the held
  session, then issues `CmdJumpThroughStructureStargate([structureID])` exactly
  once. The browser cannot supply the destination readiness postcondition; the
  route waits for the server-resolved system, scene, ego, and ship. EveJS remains
  authoritative for link/access/range/fuel/toll checks.
- `POST /api/bridge/flight/dock` `{ stationID }` →
  `beyonce.CmdDock([stationID, shipID])`. Out-of-range docking refuses with a
  docking-approach reason; success waits for the requested docked location.
- `POST /api/bridge/clones/jump` is docked-only and mirrors retail's two-stage
  sequence. When the active hull is not a capsule, it issues
  `ship.LeaveShip([shipID])` once, waits for the authoritative capsule ship, then
  waits out the remaining session-change cooldown before issuing
  `jumpCloneSvc.CloneJump` once. EveJS independently refuses direct CloneJump
  calls unless the active ship is a capsule, so a malformed client cannot move a
  normal hull with the clone.

#### Flight verbs (R13)

The rest of retail's in-space right-click menu. **Four of the six verbs needed no
new server method** — R5a was already calling them, just with the interesting
argument hardcoded away:

| Verb | Route | Bound dispatch |
|---|---|---|
| Approach | `POST /api/bridge/flight/approach` `{ destinationID, range? }` | `CmdSetSpeedFraction([1.0])` then `CmdFollowBall([destinationID, range])`. **Default 50 m** — retail's *menu* range. The autopilot passes **0**. |
| Keep at range | `POST /api/bridge/flight/keep-at-range` `{ targetID, range? }` | The **same** `CmdFollowBall([targetID, range])` with a non-zero range. Default **1000 m**, floored at **50 m**. |
| Orbit | `POST /api/bridge/flight/orbit` `{ targetID, range? }` | `CmdOrbit([targetID, range])`, default **1000 m**. The range is coerced as the retail client coerces it: **float below 10, int at or above**. |
| Align to | `POST /api/bridge/flight/align` `{ targetID }` | `CmdAlignTo([], {dstID: targetID, bookmarkID: null})` — **kwargs only, never positional**, exactly one non-null. |
| Stop | `POST /api/bridge/flight/stop` `{}` | `CmdStop([], null)` — **no arguments**. In retail this also kills the autopilot; ours is client-side, so the browser aborts its decide-loop *before* issuing the call. |
| Warp at range | `POST /api/bridge/flight/warp` `{ destinationID, minRange }` | See above. |

All of them bind the park for the **current** system, guard `NOT_IN_SPACE`, reject
a missing target with `400 INVALID_TARGET` before dispatching anything, and never
let the bound handle reach the browser.

Errors pass through with the gateway's status; a movement `CALL_REFUSED` (409)
carries the handler's own reason, which the page shows as the last failure. A
`SESSION_NOT_FOUND` drops the held bridge session (the page returns to character
select).

### Space overview route (R11)

- `GET /api/bridge/space/snapshot` → `{ ok, space, notifications }`. Requires the
  signed web login session and a held bridge session (else 409
  `NO_LIVE_SESSION`). A read-only relay of the gateway's projection — the BFF
  interprets nothing; the browser's `web/src/bridge/space.ts` decoder owns that.
  A `SESSION_NOT_FOUND` drops the held bridge session (the page returns to
  character select).

  One exception: the BFF stamps two STATIC-DATA fields onto each ROCK row (a row
  carrying `beltID`/`miningYieldTypeID`, or `kind: "asteroid"`) before relaying —
  the gateway's own row carries neither. Both are `null` on non-rock rows and
  whenever the static data cannot answer, and a `null` is never a `0`.

  - `oreGrade` — the rock's ore type's dogma attribute 2699 (asteroid meta
    level): 0-Grade=0, plain=1, II-Grade=2, III=3, IV=4.
  - `oreValuePerM3` — ISK per m³ for that ore: its reprocessed material value
    (`typeMaterials` × each material's average price × 0.66, ÷ the ore's portion
    size) ÷ the ore's unit volume. This is the number behind the retail client's
    Mining Surveyor "Ore Value" gradient, and the client computes it the same way
    in its own UI (`mining_util.get_volume_est_price`) rather than reading it from
    the server — so this is one arithmetic done once here, not a new fact about
    the world. The prices are the server's own average prices: its config service
    builds that table from each type's static `basePrice`. Per m³ and not per
    unit because a hold is a volume. A missing volume, portion size or material
    price makes the whole value `null` — a partial sum would rank an ore below
    ore it might well beat.

  See `SpaceEntity` in `web/src/store/types.ts` for both.

**Polling cadence:** the Overview panel polls this every **1 s** while the ship
is in space and the panel is open. It stops when the panel closes, and the very
next beat after the ship docks stops it too. A read still in flight when the next
beat arrives is **skipped, never queued**, so a slow snapshot cannot pile work up
behind the autopilot's own flight-status reads. The poller issues no movement
call of any kind.

**Row actions reuse the existing atomic moves.** Every row offers *Warp to*,
*Approach*, *Orbit*, *Keep at range* and *Align to*, each posting to the
`/api/bridge/flight/*` verb route above with that row's `itemID` as the target,
plus a panel-level *Stop the ship*. So a player can fly at anything they can see,
through the same server-authoritative handlers the manual Flight tab and the
autopilot already use.

**Ranges are picked once, at panel level** (R13), not per row: a busy grid holds
hundreds of rows, and hanging three range pickers off each of them would be
unusable. The panel carries *Warp to within* (retail's ladder, defaulting to
"as close as it can" = `minRange` 0), *Orbit at* and *Hold at* (defaulting to
1 km), and each row button applies the current choice. Every range renders as a
**distance a player reads** — `500 m`, `2.5 km`, `100 km` — never a raw metre
count and never an identifier (R7d).

### Targeting + module activation — the generic action layer (R23 slice A)

Until R23 the browser could **move** a ship but not **act** with it: there was no
way to lock a ball or switch a module on, so space was inert. Slice A opens that
layer **once, as a primitive** — it is deliberately NOT a mining feature.

Locking a target and running a module are the two verbs behind *every* in-space
action in this game. A mining laser, a turret, a launcher, a salvager, a remote
repper and an ewar module are the **same two calls** with a different module
`itemID` and a different effect name. So a later combat goal adds **no new
gateway pairs, no new BFF routes, no new store slice and no new UI** — it reuses
all of this unchanged.

**Gateway pairs added (6, all top-level `dogmaIM` on the live in-space session):**

| Tuple | Answers |
|---|---|
| `dogmaIM.AddTarget(targetID)` | `[pendingFlag, targetIDList]` |
| `dogmaIM.CancelAddTarget(targetID)` | `null` — abandon a lock still being acquired |
| `dogmaIM.RemoveTarget(targetID)` | `null` — drop one landed lock |
| `dogmaIM.GetTargets()` | the locked `itemID` list — **the only authority** |
| `dogmaIM.Activate(moduleItemID, effectName, targetID, repeat)` | starts a cycle |
| `dogmaIM.Deactivate(moduleItemID, effectName)` | stops it |

⚠ **`RemoveTargets`, `ClearTargets` and `GetTargeters` are deliberately absent**
and sit on the *same* service — a service-granular allowlist would have handed
the browser a one-call "drop every lock" and a read of who is locking *you*. The
page releases one lock at a time, by name, so a stray click can only ever cost
one lock. A test names all three.

**`effectName` is optional, and that is what makes the layer generic.** An empty
effect name makes the *server* resolve the module's own default activation effect
from its `typeID`, so the browser never has to know — or guess — what kind of
module it is holding. `repeat` is retail's cycle flag: `-1` keeps cycling (the
default), `0` runs a single cycle.

**BFF routes** (all require the web login session and a held bridge session;
every mutating one requires the ship to be in space, else 409 `NOT_IN_SPACE`):

- `GET  /api/bridge/targets` → `{ ok, targetIDs, notifications }`
- `POST /api/bridge/targets/lock` `{ targetID }` → `{ ok, targetID, locked, acquiring, targetIDs }`
- `POST /api/bridge/targets/unlock` `{ targetID }` → `{ ok, targetID, released, targetIDs }`
- `POST /api/bridge/modules/activate` `{ itemID, effect?, targetID?, repeat? }` → `{ ok, itemID, active, activeModuleIDs }`
- `POST /api/bridge/modules/deactivate` `{ itemID, effect? }` → `{ ok, itemID, stopped, activeModuleIDs }`

**⚠ A 200 is not proof, three times over.** `AddTarget` answers 200 while the
lock is still being *acquired*; `RemoveTarget` returns `null` whether or not it
dropped anything; `Activate` can be accepted and then quietly not run. So:

- every mutation **re-reads** the authority (`GetTargets` for locks, the space
  snapshot's `activeModuleIDs` for modules) and reports what that read says;
- `locked` vs `acquiring` are reported **separately** — a lock mid-acquisition is
  progress, not a failure, and the page shows "Locking…" rather than claiming
  either outcome;
- `unlock` issues `CancelAddTarget` **then** `RemoveTarget`, so one button is
  correct whether the lock landed or is still being acquired;
- when the call succeeds, the re-read shows nothing changed and the server gave
  **no reason**, that is surfaced as a **silent decline** — a different store
  field and a different message from a refusal. The page says exactly that and
  **never invents a cause**.

**Module state is server state.** The space snapshot's ship projection gained
`activeModuleIDs`, read off the ship entity's own active-effect map. The browser
never substitutes its memory of what it clicked — otherwise the page would keep
claiming a module is running after the server short-cycled it (target lost, hold
full, out of range). An **absent** `activeModuleIDs` decodes to `null` =
**unknown**, never `[]` = "nothing running": a wrong "Idle" invites a double
activation.

**`active` / `stopped` are judged as a set DELTA, not by id equality (R29).**
`dogmaService.js Handle_Activate` silently redirects a **banked** weapon to its
bank **master**, and the snapshot then reports only the master's itemID — so a
weapon can start cycling without its own id ever appearing, and
`activeModuleIDs.includes(itemID)` would call a successful shot a failure. The
routes therefore read the running set **before** as well as after and ask "is
this id running, **or did the running set grow?**".

Measured live: banking is **not reachable from this browser today**. Banks are
built solely by `dogmaIM.LinkWeapons`, which is **not allowlisted**; two
same-type turrets fired together each reported **their own itemID**, and every
`OnDamageMessage` carried `isBanked:false`. The delta is a guard against a future
widening, not a fix for a bug firing today.

It also has an honest limit. A weapon joining a bank whose master was **already
cycling** leaves the running set unchanged, which from outside — with no bank
map — is **indistinguishable** from the server ignoring the call. That case
answers **`null` (unknown)**, never a confident `false`: this bridge does not get
to guess between "your gun is firing" and "your gun is not". A set that is empty
both before and after is unambiguous and still answers `false`.

**UI (`Overview.svelte`, generic).** Every overview row carries *Lock* /
*Locking… stop* / *Release lock*. A **Locked targets** table lists each target by
**name** (resolved from the snapshot; a target no longer in view reads "No longer
in view", never its `itemID` — R7d). A **Your equipment** table lists every
*online* module by **name**, with the server's Running / Idle / *Not known* state
and *Switch on* / *Switch off*, plus one panel-level "Use it on" picker naming the
locked target — the same pattern as R13's ranges, because hanging a target picker
off every module row would be unusable.

### The mining loop (R23 slice B)

**mine → haul → refine → sell.** The striking thing about slice B is how little
it needed, and that is the payoff of building slice A as a primitive rather than
as a mining feature:

| Step | What it actually is |
|---|---|
| Warp to the belt | R5a `beyonce.CmdWarpToStuff` (belt beacons are ordinary statics) |
| Orbit the rock | R13 `beyonce.CmdOrbit` |
| **Lock the rock** | **slice A `dogmaIM.AddTarget`** — no mining pair |
| **Run the laser** | **slice A `dogmaIM.Activate`** — no mining pair |
| Read the ore hold | R12 `invbroker.ListByFlags` with a different flag |
| Unload it | R3 `invbroker.Add`, hangar-bound |
| Sell the minerals | the R16 market routes |

**Gateway pairs added (4):** `miningScanMgr.perform_scan`,
`reprocessingSvc.MachoBindObject` / `GetQuotes` / `Reprocess`. `GetQuote`
(singular), `GetOptionsForItemTypes` and `GetReprocessingInfo` stay closed on the
same service, and a test names them.

**Snapshot fields added.** Asteroid rows gain `miningYieldTypeID`, `beltID` and
`remainingQuantity`. `name`/`typeID` already resolved to the ORE, because the
server stamps a rock's display name and slim type from the ore it holds.
`remainingQuantity` lives in the scene's mining state rather than on the ball, so
the gateway reads it through the mining runtime's OWN state reader — the same one
the survey scanner uses. **When that read cannot answer, the field is `null`
(unknown), never `0`:** a fabricated zero reads as a mined-out rock and would send
a player straight past a full belt. Only asteroid rows grow the fields.

**BFF routes:**

- `GET  /api/bridge/ship/ore-hold` → `{ ok, activeShipID, stationID, holds }`
- `POST /api/bridge/ship/ore-hold/unload` `{ itemIDs, division? }` →
  `{ ok, requested, moved, remaining, corpDivision, movedToCorp, fellBack }`
- `GET  /api/bridge/mining/scan` → `{ ok, results }` (in space only)
- `GET  /api/bridge/reprocessing/quote?itemIDs=…` → `{ ok, stationID, taxRate, quotes }` (docked only)
- `POST /api/bridge/reprocessing/reprocess` `{ itemIDs, confirm }` → `{ ok, requested, processed, remaining }` (docked only)

**`division` delivers into a CORPORATION hangar instead — and falls back.** The
same `invbroker.Add`, with the corporation's office at the docked station as the
bound object and the division's flag (`114 + N`, never sent by the browser) as
the destination. It is a **request, not a destination**: no office here any more,
no role for that division, an impounded office — each ends with the load in the
**pilot's own hangar**, at the station they already flew to, and `fellBack`
carrying the server's own untranslated word (`CrpAccessDenied` for a missing
role, `NO_CORP_OFFICE` when the corporation rents none here, `CORP_REFUSED` when
it declined silently). A bot that stalled with a full hold because a director
changed a role overnight would be worse than one that lands the ore somewhere
the pilot can still reach — and the fallback only ever runs **towards** the
pilot, never towards the corporation, because ore in a division belongs to the
corporation and needs a take role to get back.

**The fallback is judged by the RE-READ, never by the absence of a throw** — the
same rule as `/inventory/transfer`: what is retried into the hangar is whatever
the holds still say is aboard. `corpDivision` names the division that actually
took something (null when none did), `movedToCorp` which stacks it took. A
`division` outside 1-7 is **refused with 400 `INVALID_DIVISION`**, never clamped:
a division is an address, and there is no nearest right answer to a wrong one.

**⚠ The ore-hold flag ladder never leaves the BFF.** The holds are read in order
— **134** ore, **135** gas, **181** ice, **182** asteroid, falling back to **5**
cargo (which is what the mining runtime itself falls back to on a hull with no
specialised bay) — and each is handed to the browser as a **NAME**: "Ore hold",
"Ice hold", "Cargo hold". A test asserts the string `flag` and each flagID appear
nowhere in the response body. R9a: *"ore hold", not "flag 134"*. Each rung is read
independently, so one unreadable hold never blanks the rest; `items: null` means
**"we could not look"**, which is deliberately not the same as `items: []`
(**"we looked, and it is empty"**). A hold the hull does not have answers
`present: false` and is not drawn, rather than showing a meaningless 0 / 0 bar.

**The survey scanner** is merged into the overview client-side by `itemID`. The
scan wins over the snapshot's own reading when both exist — the player asked for
it and it is the fresher read. A scanned rock with a real `0` shows **"Mined
out"**; an unknown amount shows a dash. Those two must never render the same way.

**⚠ Reprocessing charges ISK and consumes the ore**, so it sits behind the same
two-step gate as R12's destroy-rig, with the server's own numbers in between:

1. `GetQuotes` — a **pure read**. It reports the station's **tax rate** and, per
   stack, what it would yield and what it costs. A test asserts a quote never
   reaches `Reprocess`.
2. Only then does the page offer *Refine it…*, and only that click reveals
   *Yes, refine it*. The arming is keyed to the **exact stacks it was armed for**,
   so changing the selection disarms it — confirming against numbers computed for
   a different set of stacks is the mistake this gate exists to stop.
3. The BFF refuses `Reprocess` outright without `confirm: true`.

**⚠ `recoverables` is a LIST of `util.KeyVal`s, not a dict of typeID → amount**,
and the player's share is the **`client`** field (`unrecoverable` is the
station's). Reading the wrong field would put a confidently wrong mineral count in
front of the player. The decoder follows the handler's own
`buildRecoverableEntry` shape.

**⚠ The tax rate is `null` when unknown, never `0`.** Reprocessing debits it from
the wallet, so a confident zero would tell the player the refinery is free. The
panel renders `stat-unavailable` "its cut is not known" instead.

**A 200 is not proof, again.** Unload re-reads the whole hold ladder and reports
which stacks really moved; reprocess re-reads the hangar and reports which stacks
are really gone. A partial result says exactly how many moved. When the
verification read itself fails, the answer is **`null` = "could not check"** —
reported as unknown, never as success and never as a decline.

**UI (`Mining.svelte`, a new panel).** Holds by name with a fill meter, a pick
list, *Unload to the hangar*, and the refinery flow above. The panel **computes
nothing about mining** — no yield prediction, no cycle simulation, no pricing; a
test sweeps its source for exactly that. The other half of the loop — flying to a
belt, locking a rock, running the laser — is deliberately **not** here: it is
slice A's generic layer on the Around Your Ship tab, which a mining laser and a
turret use identically.

### The in-space cockpit (R24)

**The warp DEAD BAND — a live bug, and the shape of a whole class of them.**
R13's autopilot warped whenever the measured SURFACE distance reached 150 km.
That is not the gate the server applies, and the server never says so:

| Link | What it does |
|---|---|
| `warpState.js:236` | refuses when the distance to the **warp-in point** is under `MIN_WARP_DISTANCE_METERS` |
| `warpCommands.js:250-255` | returns `WARP_DISTANCE_TOO_CLOSE` |
| `beyonceService.js:1693` | `_throwWarpFailureUserError` translates ONLY criminal / bubble / scramble / immobile |
| `beyonceService.js:1713` | everything else hits `default: break` and **throws nothing** |

So the browser received `ok:true, result:null` with the ship exactly where it
was, re-measured the same distance, decided "warp" again — and span forever,
because the warp branch had no attempt bound. Three corrections were all needed:

1. **Stop paying the autopilot call's built-in 10 km.**
   `Handle_CmdWarpToStuffAutopilot` (`beyonceService.js:2983`) hardcodes
   `minimumRange: 10000`, which is added to the warp's stop distance. The loop
   now sends retail's own `WarpToItem(warpRange=0)` shape —
   `Handle_CmdWarpToStuff("item", id, minRange=0)` (`:2654-2684`) — which
   reaches the identical `warpToEntity` without that term.
2. **Measure against the gate the server really applies.** The two target kinds
   differ, and one of them is *random*:

   | Kind | Accepted when |
   |---|---|
   | station | `surfaceDist >= 150000 + minRange + shipRadius` (`getWarpStopDistanceForTarget`, `warpState.js:632`) |
   | stargate | `surfaceDist >= 150000 + minRange - shipRadius ± 2500` (`resolveStargateWarpTarget`, `runtime.js:2928`, jittering the warp-in point inside `WARP_EXIT_VARIANCE_RADIUS_METERS`, `runtime.js:701`) |

   No client can reproduce the stargate case exactly. `warpFloorMeters` therefore
   takes the **worst case of both kinds** and never asks for a warp the server
   might refuse. In the residual band the ladder APPROACHES — which is what
   retail does under `minWarpDistance` anyway, and which actually closes the gap.
3. **Bound the branch.** `MAX_WARP_ATTEMPTS` counts consecutive warp decisions
   for the same destination and resets on any other move, so a normal route
   never accumulates and only a warp that changes nothing does.

**The rule this generalises to: a decision that cannot make progress must pause
with a reason, never repeat.** Applying it to Dock found the same hole twice
more.

**Smart Dock.** Retail sequences docking client-side with exactly one server
call: `menusvc.py:2981 Dock` to `DockStation` to
`GetCloseAndTryCommand(itemID, RealDock, interactionRange=2500)` to
`autopilot.py:503 __NavigateSystemTo`, re-armed every 2000 ms. That IS this
app's decide-loop, so Dock is a **zero-hop plan handed to the same controller**
rather than a second autopilot. Two corrections:

* **The gate is 2,500 m SURFACE, not 50,000.** 50,000 is `maxDockingDistance`,
  retail's outer hand-off trigger. `DEFAULT_STATION_DOCKING_RADIUS`
  (`runtime.js:700`) is what a station actually takes you at, tested by
  `canShipDockAtStation` (`:7563`) against
  `distance - shipRadius - getStationInteractionRadius(station)`; and
  `getStationInteractionRadius` (`:7453`) returns the station's own radius
  whenever it has one, so that expression is exactly the surface distance the
  loop already measures. Firing Dock from 50 km is not free: `Handle_CmdDock`
  (`beyonceService.js:2994`) both starts an approach AND refuses with
  `DockingApproach` (`:3013-3025`), and nothing auto-docks on arrival.
* **`CmdDock` can return 200/null WITHOUT docking** (`:3031-3042`) —
  `WARP_LANDING_PENDING`, `STATION_NOT_FOUND`, `SHIP_IMMOBILE` and
  `DOCKING_APPROACH_REQUIRED` all reach the browser as `ok:true`. Nothing reads
  the Dock response to decide it worked: arrival is `isAtDestination`, which is
  `docked === true` AND the station id matching, both read back from
  `flight-status`. Writing that test exposed that `MAX_DOCK_ATTEMPTS` only ever
  counted **refusals**, so a Dock answering 200 and seating nobody looped
  forever too — now bounded by `MAX_SILENT_DOCK_ATTEMPTS`, and explicitly reset
  when the server DOES refuse with a reason so the two failure modes stay apart.

**The push channel already carried everything.** R10 kept only a notification's
metadata, because liveness was all it needed then; the gateway has always pushed
the whole notification (`encodeJsonSafeCallValue`,
`evejsWebGatewayRuntime.js:2672`). Two notifications on that channel carry things
the browser cannot obtain any other way, and both are verified end to end in
`server/tests/webGatewaySessionEvents.test.js` ("R24:"):

| Notification | Emitted by | What it carries | How the page uses it |
|---|---|---|---|
| `OnGodmaShipEffect` | `notifyGenericModuleEffectState`, `runtime.js:13012` | module id, isStart, and the server's **effective** cycle duration | **for its payload** — it is the only source of an effective duration |
| `OnItemsChanged` | `syncMinedOreChangesToSession`, `miningRuntime.js:994-999` | the changed stacks | **as a trigger only** — the hold is RE-READ from the ship |
| `OnDamageMessage` | `notifyWeaponDamageMessages`, `runtime.js` (`:17021`, `:17785`, `:17977`) | one shot: `attackType`, `source`, `target`, `weapon`, `damage`, `hitQuality`, `isBanked` | **both** — its payload is the log, and it also triggers a health RE-READ |

The asymmetry is deliberate. A hold derived from a stream of deltas drifts the
first time a frame is missed, and this channel is explicitly allowed to drop and
resynchronise. **The authority on what is in the hold is the hold.**

**`OnDamageMessage` arrives for shots in BOTH directions (R29), and a survey
saying otherwise was wrong.** That survey concluded no NPC emits damage and that
an "under attack" indicator was therefore impossible. Settled empirically:
sitting in an asteroid belt with a rat shooting and **nothing of ours firing**,
**16 frames** arrived naming `source` = the rat and `target` = our ship (14
landed, 253.8 damage). Killing it produced the mirror image. `notifyWeaponDamage
Messages` notifies the **target's** session as well as the attacker's, which is
why an NPC firing through `activateGenericModule` reaches its victim's browser.

The payload is a **bare marshaled dict** — `{type:"dict", entries:[[k,v],…]}` —
**not** a `util.KeyVal` wrapper, so it needs its own reader. Direction comes from
the payload's own **`attackType`**: `"me"` for a shot we fired (with a **null
`attackerID`**), anything else for one fired at us (`"otherPlayerWeapons"`, with
`attackerID` populated). It is **read, never inferred** from which id looks like
a ship. `damage: 0` is a real value — a clean miss — and is kept, because "it
shot and missed" is information; `hitQuality` is passed through **unnamed**,
since this server does not publish the wording and inventing one would be
fabricated detail.

**The log is a bounded tail, and nothing sums it.** The page keeps 40 entries and
never derives a running damage total from them: the channel trims and blanks its
buffer on resynchronise, so a total would go quietly wrong forever after one
dropped frame. `healthIsDropping` — two consecutive health readings — was
**deliberately not rebuilt** on this log for the same reason: a lossy log going
quiet is not evidence of a quiet fight, while the ship's own readings cannot lie.
The log names the attacker; the readings prove the damage. Both are kept.

**Cycle times — two sources, never conflated.** Where a cycle event has arrived,
its duration is the pilot's real one. Where none has, attribute **73**
(`duration`) off static data answers instead, through
`staticData.getTypeDogmaAttribute` — exported since it was written, with **no
caller until now** — behind a new **zero-bridge-call** `GET /api/types/cycle-times`.
The base figure is labelled "before skills" on screen and **never displaces** a
server one; a `-1` duration (a passive or instant effect) yields **no** cycle
rather than a 0 ms one. There is still no allowlisted call returning effective
per-module attributes — the same wall that blocks DPS — so nothing was invented.

**Specialty holds are DATA.** A ship has a hold iff its capacity attribute is
populated (`services/inventory/specialShipHoldRegistry.js`: 134/1556 ore,
135/1557 gas, 181/3136 ice, 182/3227 asteroid, plus cargo 5/38). The BFF reports
`present` from the reading, so a Venture and a Mammoth differ by data and neither
is special-cased, and a hold that could not be measured reads "not known" rather
than 0 / 0.

**What is NOT observable to a client.** A full hold stopping the cycle:
`stopReason: "cargo"` is a return value INSIDE the server
(`miningRuntime.js:990`), not a notification. The client sees a stop event and a
full hold, and must not claim one caused the other. Depletion is likewise
observable only as an **absence** — the rock stops appearing in the snapshot and
in `GetTargets`; there is no "your rock is gone" event.

R24 page pieces: `web/src/nav/autopilotLoop.ts` (`warpFloorMeters`,
`WARP_EXIT_VARIANCE_M`, `AUTOPILOT_WARP_MIN_RANGE_M`, `MAX_WARP_ATTEMPTS`,
`STATION_DOCKING_RADIUS_M`, `MAX_SILENT_DOCK_ATTEMPTS`), `app/flow.ts` `dockAt`
plus `applyPushedNotification` / `applyCycleNotification` / `scheduleHoldRefresh`
and `seedBaseCycleTimes`, `app/api.ts` `loadBaseCycleTimes`, the `moduleCycles`
map on the targeting slice with `targeting/base-cycles` + `targeting/cycle` feed
events, `LiveNotification.args`, the Dock row action + Cycle column + live hold
strip in `Overview.svelte`, and "Take me there and dock" in `Flight.svelte`.
Tested by `web/src/nav/autopilotLoop.test.ts` (the dead-band regressions and the
Dock ladder), `web/src/app/cockpitFlow.test.ts` (slices C/D/E through the real
SSE path), `web/src/app/travelFlow.test.ts` (`dockAt`),
`web/src/ui/overviewActions.test.ts` (how it renders + the invariants), and
eve.js `server/tests/webGatewaySessionEvents.test.js`.


### Drones + hostile awareness (R25)

**The design-changing finding: launching IS the defence.** An idle combat drone
AUTO-ENGAGES whatever shoots the ship it was launched from — `droneRuntime.js`
`noteIncomingAggression`, driven from the space runtime's damage path, gated on
the drone's own `behaviorSettings.aggressive`, **which defaults true**. So a
miner who launches is defended with no further clicks. `CmdEngage` is for
*choosing* a victim; it is not what makes a player defended, and neither the BFF
nor the panel implies otherwise.

**⚠ THE SERVICE SPLIT.** Launch and scoop are `ship`; every in-space drone order
is `entity`. One feature, two services — a reader who assumes drones live on one
service wires half of it to the wrong place.

**⚠ EVERY DRONE CALL ANSWERS 200 WHEN IT REFUSES.** This is not a theory; it was
observed live. `ship.LaunchDrones` for three bay stacks answered **200** with:

```
{ 9988400023314: [9988400023314],                                    // launched
  9988400023316: [["CustomNotify", {notify: "Not enough drone bandwidth to launch that drone."}]],
  9988400037367: [["CustomNotify", {notify: "Not enough drone bandwidth to launch that drone."}]] }
```

and `entity.CmdMineRepeatedly` putting an *Ice Harvesting Drone II* on a Veldspar
rock answered **200** with `"That drone cannot mine the selected resource."` — while
the three order verbs answer an **empty dict on SUCCESS**. So the return value is
never the answer: every route re-reads the **space snapshot** and reports what is
actually out there.

Allowlist delta — five pairs, split across two services:

| Pair | Purpose |
|---|---|
| `ship.LaunchDrones([[itemID, qty], …], whoseBehalfID, ignoreWarning)` | launch from the bay (flag 87) |
| `ship.ScoopDrone([droneIDs])` | manual scoop (the fallback; `CmdReturnBay` scoops itself) |
| `entity.CmdEngage([droneIDs], targetID)` | attack |
| `entity.CmdReturnBay([droneIDs])` | recall — the runtime flies them home and scoops inside **2500 m** |
| `entity.CmdMineRepeatedly([droneIDs], targetID)` | mining drones on a rock (and salvage drones on a wreck) |

**⚠ `CmdAssist`, `CmdGuard` and `CmdUnanchor` have NO server handler at all.**
They are real verbs in the retail *client* and read as obvious siblings of the
three listed `entity` pairs. `BaseService.callMethod` answers **null** for an
unknown method rather than raising, so allowlisting one would not fail loudly —
the browser would get a cheerful 200 for an order that was never given, and a
player would believe drones were guarding them while nothing was. Deny-by-default
is what keeps that from being buildable, and a test refuses all three BY NAME.
`CmdAbandonDrone` (PERMANENTLY DISOWNS a player's drones), `CmdReturnHome`,
`CmdSalvage` and `CmdReconnectToDrones` were deliberately absent for the same
reason a service-granular allowlist is. **R102 allowlisted all four as BOUND
entity writes**, every one confirm-gated; only `CmdReconnectToDrones` has a panel
behind it (drone recovery), and it is the one that answers with the snapshot.

**The limits add NO pair.** `maxActiveDrones` (attr **352**) and `droneBandwidth`
(attr **1271**) are ordinary ship dogma and ride back in `dogmaIM.ShipGetInfo`,
allowlisted since R6 for the fitting panel. The BFF passes that result through
raw and `web/src/bridge/drones.ts` decodes it with the fitting panel's own
`decodeShipAttributes`. **Live, the Procurer reports `droneBandwidth = 50` and NO
`maxActiveDrones` attribute at all** — so the client shows "Drones at once: not
known" rather than a confident 0, which would read as "this ship may carry none".
The client never pre-refuses a launch: the server owns both limits and refuses
per drone with its own reason.

The drone bay needs no new pair either — the `invbroker` `GetInventoryFromId` /
`ListByFlags([87])` two-step is already allowlisted (R3/R21). Flag 87 lives only
in `src/server.js`; the browser is handed drones by NAME (R7d).

BFF routes (all require the web login session + a held bridge session, and all
mutations refuse while docked with 409):

- `GET /api/bridge/drones` → `{ ok, activeShipID, bay, inSpace, shipInfo, errors }`.
  Three INDEPENDENT reads (`allSettled`): the bay, `ShipGetInfo`, and the
  snapshot. **`bay` / `inSpace` are `null` when a read failed — never `[]`.**
- `POST /api/bridge/drones/launch` `{ drones: [{itemID, quantity}] }` →
  `{ ok, requested, inSpace, launched, notifications }`. `launched` is the honest
  claim: the drones in space now that were not in space before. `null` when
  either snapshot read failed.
- `POST /api/bridge/drones/engage` `{ droneIDs, targetID }`
- `POST /api/bridge/drones/mine` `{ droneIDs, targetID }`
- `POST /api/bridge/drones/recall` `{ droneIDs }` (no target)
- `POST /api/bridge/drones/scoop` `{ droneIDs, confirm: true }` manually scoops
  reachable abandoned/uncontrolled drones. The acting hull is pinned from the
  held live session and EveJS validates that each target is a local,
  uncontrolled drone within scoop range.
- `POST /api/bridge/entity/drones/reconnect` `{ droneIDs, confirm: true }` takes
  control of an orphaned drone this character owns. It rides the entity bind
  (R102) rather than the top-level seam, but it answers like a drone route, not
  like its three bound siblings — see below.

the three orders → `{ ok, droneIDs, targetID, inSpace, result, notifications }`;
scoop → `{ ok, applied, droneIDs, inSpace, result, notifications }`; reconnect →
`{ ok, applied, inSpace, result, notifications }`.

**⚠ EVERY DRONE VERB THE PANEL DRIVES MUST CARRY `inSpace`, INCLUDING THE TWO
RECOVERY ONES.** `ScoopDrone` and `CmdReconnectToDrones` answer the same
empty-on-success dict the three orders do, so the page judges them by the
snapshot and by nothing else: a scoop by the drone LEAVING space, a reconnect by
it becoming `controlled`. Both routes were written to the generic write shape
(`{ ok, applied, result, notifications }`) and therefore shipped without
`inSpace` at all — which the page reads as `null`, i.e. "we could not look", so
**every** scoop and **every** reconnect reported "the … was accepted, but space
could not be re-read", the ones that worked included. `answerWithDronesInSpace`
is the shared tail; a drone route that does not call it is the bug.

The other three bound entity writes (`return-home`, `salvage`, `abandon`) are
plumbing with no panel behind them and keep the bare
`{ ok, applied, result, notifications }` ack — they re-read nothing.

**⚠ `null` vs `[]` is load-bearing here in a way it is nowhere else in this
client.** "You have no drones in space" and "we could not look" are the same
pixels and opposite facts: the first invites a player to launch, the second
invites them to launch a SECOND flight on top of the one already flying. The
gateway, the BFF, the decoders, the store slice and the panel all keep them apart.

**Slice B — how a pirate is told from a person.**

⚠ **A belt rat is `kind: "ship"`.** It is built through the same
`buildShipEntityCore` path as the player parked next to you and carries the same
name, position, health and velocity fields. Nothing the snapshot projected before
R25 separated them. Observed live, on the same grid, in the same snapshot:

| Row | kind | isNpc | npcEntityType | characterID |
|---|---|---|---|---|
| `"Guristas Plunderer"` | `ship` | `true` | `"npc"` | `null` |
| `"Procurer"` (the player) | `ship` | `false` | `null` | `140000005` |

So R25 projects exactly **two** new ship-row fields, gateway-side, and nothing
else: `isNpc` (the runtime's own `nativeNpc` flag, stamped by
`nativeNpcService.applyNativeRuntimeNpcPresentation`) and `npcEntityType`
(verbatim: `"npc"` pirates, `"concord"` police, `"drifter"`).

⚠ **`characterID === 0` is the trap that almost works.** Structures and
corp-owned balls also carry no characterID, so a panel built on it flags harmless
furniture as a threat — and a warning that cries wolf gets ignored, which is worse
than having none. A test names this case.

Player-facing wording is decided once, in the browser (R9a): `"Pirate"`,
`"Police"`, `"Drifter"`. `"concord"` is deliberately **not** hostile — law
enforcement does not shoot a miner. An NPC of an unreadable kind IS treated as
hostile: for a warning whose job is to keep a miner alive, unknown is the case to
be wrong about in the loud direction.

Threats are read from the **whole snapshot**, never from the overview rows: the
overview is searchable, filterable and capped at 200, so a miner who searched for
"Veldspar" would have filtered away the thing shooting them. Only NEW arrivals are
announced ("A pirate has arrived — …"), with the seen-set primed from the first
snapshot so landing in an occupied belt does not announce every rat in it.

**"You are under attack", the honest version.** There is no damage-log read on
this server and this client does not invent one. `healthIsDropping` claims only
what two consecutive HUD readings showed: a shield/armour/hull layer went down. A
`null` on either side is unknown and is never reported as damage.

R25 drone-row projection (drone rows only): `controllerID` (which HULL is flying
it — the question that matters after a ship swap), `controllerOwnerID`,
`droneActivity` (a WORD — `idle`/`fighting`/`mining`/`approaching`/`returning`/
`chasing`/`salvaging` — derived from `droneRuntime`'s OWN exported `STATE_*`
constants, `null` for "we could not tell", **never** the raw enum) and
`targetEntityID`.

R25 page pieces: gateway `evejsWebGatewayRuntime.js` (the five allowlist pairs,
`droneActivityWord`, and the `isNpc`/`npcEntityType`/drone fields in
`projectSpaceEntity`), BFF `src/server.js` (`ITEM_FLAG_DRONE_BAY`,
`readDronesInSpace`, `answerWithDronesInSpace`, `droneOrderRoute` and the five
routes), `web/src/bridge/drones.ts` (`decodeDroneBay`/`decodeDronesInSpace`/
`decodeDroneLimits`/`droneActivityLabel`/`droneIsBusy`), the `drones` store slice
+ `drones/loaded`/`drones/in-space`/`drones/action`/`drones/action-error`/
`drones/silent-decline`/`drones/cleared` feed events, `app/flow.ts`
`loadDrones`/`launchDrones`/`engageDrones`/`mineWithDrones`/`recallDrones`,
`web/src/space/overview.ts` (`isHostile`/`hostileLabel`/`hostileRows`/
`newlyArrivedHostiles`/`isMyDrone`/`healthIsDropping`), and the Drones section +
threat block in `Overview.svelte`. Tested by
`web/src/bridge/drones.test.ts`, `web/src/space/overview.test.ts`,
`web/src/ui/dronePanel.test.ts`, `test/bridgeDrones.test.js`, and eve.js
`server/tests/webGatewayDronesAndHostiles.test.js`.


### Chat routes (R7)

All require the signed web login session and a held bridge session (else 409
`NO_LIVE_SESSION`). The browser addresses channels by **name** (`local`/`corp`);
the BFF holds the bridgeSessionID server-side. READ is a backlog poll — the Chat
panel polls the open channel every ~4s and stops when closed.

- `GET /api/bridge/chat/:channel` → `{ ok, chat, notifications }`. Reads the
  channel's roster + recent backlog on the held session (gateway `/chat/read`).
  An unknown `:channel` is `400 INVALID_CHANNEL`.
- `POST /api/bridge/chat/:channel/send` `{ message }` → `{ ok, chat, notifications }`.
  Broadcasts to the channel (gateway `/chat/send`). An empty/whitespace message
  is `400 EMPTY_MESSAGE`; a channel access failure / mute / no-corporation is the
  gateway's `CALL_REFUSED` (409).

A `SESSION_NOT_FOUND` from either drops the held bridge session (the page returns
to character select).

The server-side client is `src/eveGatewayClient.js` — since R9b it is the bridge surface plus four v1 reads (`getAccount`, `listCharacters`, `getSnapshot`, `getStatus`/`getGatewayHealth`) and nothing else: `callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID?)`, `selectCharacter(args, kwargs, sessionFields)`, `releaseBridgeSession(bridgeSessionID, sessionFields?)`, `readFlightStatus(bridgeSessionID, sessionFields)` (R5a), `readSpaceSnapshot(bridgeSessionID, sessionFields)` (R11), `readChat(bridgeSessionID, channel, sessionFields, options?)` / `sendChat(bridgeSessionID, channel, message, sessionFields)` (R7), and the R3 bound-object pair `bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID)` / `callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle)`. The TS browser client consumes the BFF routes only and never sees the bridgeSessionID or any boundHandle.

## Login semantics (who-cares, R1)

`POST /api/login` with `{ "username", "password"? }`:

- An **existing** EveJS account username signs in with **any password, including empty or absent** — the password is not checked at all (roadmap section 6). The scrypt web-password store (`src/webAuth.js`, `data/web-users.json`, `npm run webpass`) is bypassed, not deleted.
- Unknown username → **401** `{ "ok": false, "error": "UNKNOWN_EVEJS_ACCOUNT", "message": "Unknown EveJS account." }`.
- Banned account → 403 `ACCOUNT_BANNED`.
- Account auto-create is deferred to R2 (alongside `SelectCharacterID`).
- **Since R42 the success body also carries `sessionToken`** — the same signed
  token the `Set-Cookie` header carries, handed to the browser so a tab can keep
  its own. See "Session carriers (R42)" below.

## Session carriers (R42)

The signed login token is unchanged — same `webAuth.createSessionToken`, same
`verifySessionToken`, same `req.webSessionID`. What R42 changed is **how it
travels**, because a cookie belongs to the browser profile rather than to the
tab: a second tab logging in as another account overwrote the first tab's
session and every open tab collapsed onto the last account to sign in. The
operator wants ten tabs running ten accounts.

Three carriers, decided in one place (`readSessionToken` in `src/server.js`):

| Carrier | Accepted by | Notes |
| --- | --- | --- |
| `Authorization: Bearer <token>` | every route | The per-tab path. Read from the tab's `sessionStorage`, which is per-tab by specification. **Wins over the cookie** when both are present, so a stale profile-wide cookie cannot override a tab's own identity. |
| `Cookie: evejs_web_poc=<token>` | every route | The pre-R42 carrier, kept so nothing regresses mid-migration. Still `httpOnly`. |
| `?access_token=<token>` | **`GET /api/bridge/events` only** | The SSE stream. `EventSource` cannot set headers, so the token rides the URL. |

**The credential-in-a-URL trade, stated plainly.** URLs reach browser history,
`Referer` headers and any access log in front of the app. Two things bound it:
the BFF writes no access log (nothing logs `req.url`; the error handler logs the
`Error` alone — keep it that way, and redact `access_token` if request logging is
ever added), and **the query carrier is accepted by the stream route and no
other**, so a leaked stream URL can be used to *watch* a session, never to drive
one. Every mutating route goes through `requireAuth`, which ignores the query
string entirely.

**The XSS trade, also stated plainly.** A token in `sessionStorage` is a token
the page's own JavaScript — and therefore an XSS bug — can read; `httpOnly`
existed to prevent exactly that. Acceptable **here and only here**: this BFF is a
companion to a local dev emulator whose login accepts any password for any
existing username (Login semantics above, goal R1), so there is no secret left
for `httpOnly` to protect. **Do not copy this into anything a network can
reach.** The note lives in the code as well, above `setSessionCookie`
(`src/server.js`) and at the top of `web/src/app/sessionToken.ts`.

`POST /api/logout` reads the same carriers, so a tab signing out releases **its
own** held bridge session and leaves every other tab live; it also expires the
cookie, and the client clears its stored token.

## Reference call

`charUnboundMgr.GetCharacterSelectionData()` (`Handle_GetCharacterSelectionData`, `eve.js` `server/src/services/character/charService.js`) reads `session.userid` and returns the retail 4-tuple `(userDetails, trainingDetails, characterDetails, wars)`; `characterDetails` is a `{type:"list"}` of `util.KeyVal` rows. Proven end to end in-process by `eve.js` `server/tests/webGatewayServiceCall.test.js` and consumed live by the Svelte client's typed reference call (`web/src/bridge/characterSelection.ts`), which parses that 4-tuple and feeds `web/src/ui/CharacterSelect.svelte`. (Before R45 this was the deleted vanilla `public/app.js` `loadBridgePanel`.)

## Consuming the bridge from TypeScript (R1b)

The browser-side TS client (goal R1b) lives under `web/src/` and consumes `POST /api/bridge/call` exactly as specified above:

- `web/src/bridge/wire.ts` — this contract as types: the call tuple, success/error envelopes, error codes, and the marshaled value encodings (`{type:"long"}` with number **or** decimal-string value, `{type:"list"}`, `{type:"dict"}`, `util.KeyVal`) plus decoding helpers (`readKeyVal`, `unwrapLong`).
- `web/src/bridge/callMethod.ts` — `callMethod(service, method, args, kwargs, options)`; rejects with `BridgeCallError` carrying the wire `error` code and HTTP status (client-side failures use `BRIDGE_NETWORK_ERROR` / `BRIDGE_BAD_RESPONSE`).
- `web/src/bridge/characterSelection.ts` — the reference call typed end to end: the 4-tuple type, `decodeCharacterSelectionData`, and `getCharacterSelectionData()` producing `CharacterSummary` rows (`web/src/store/types.ts`).
- `web/src/store/` — the framework-agnostic client-state store (plain signals): typed `session`/`character`/`feed` slices, `get`/`subscribe` plus per-slice signals for pure readers, `apply(event)` reducers, and the `FeedAdapter`/`FeedSink` seam (`feed.ts`) that hides whether events come from the legacy WS stream or bridge-forwarded notifications.

Build/dev: `npm run build:web` typechecks (`tsc`) and builds `web/` into `public/dist/` (git-ignored), which the existing Express static setup serves at `/dist/` alongside the untouched vanilla app; `npm run dev:web` runs the Vite dev server with `/api` proxied to the BFF (`vite.config.ts`, override target with `EVEJS_WEB_BFF_URL`). TS unit tests are `web/**/*.test.ts`, run natively by the same `npm test` (`node --test`, Node >= 22.18).

### View library (locked by the R2 spike): Svelte 5

R2 replaced the R1b smoke page with the first migrated page — login → character select → docked station panel — and locked **Svelte 5** (`svelte` + `@sveltejs/vite-plugin-svelte` in `vite.config.ts`; no blocker surfaced, plugin v7 supports Vite 8). How it stays thin:

- The signal store's `subscribe` deliberately implements the **Svelte store contract**, so components read slices with plain `$slice` auto-subscription — the store stays framework-agnostic and the view lib is not load-bearing (roadmap section 5).
- Components (`web/src/ui/*.svelte`) are pure readers plus event handlers; all fetch/decode/store logic lives in plain TS (`web/src/app/flow.ts` + `web/src/app/api.ts`), unit-tested under `node --test` without Svelte.
- `web/src/svelte-files.d.ts` shims `.svelte` imports for `tsc` (the Svelte compiler handles `lang="ts"` scripts itself).

R2 page pieces, per the recipe below: `web/src/bridge/stationPanel.ts` (decoders for `GetStationItemBits`, `GetGuests`, and the `GetStationInfo` cached envelope), the `station` slice + `character/online`/`character/offline`/`station/*` feed events, and the flow controller driving login (who-cares) → typed `GetCharacterSelectionData` list → `/api/bridge/select` → docked reads.

R3 page pieces (bound-object bridge): `web/src/bridge/inventoryShip.ts` (decoders for the invbroker `List` packed-row list / empty python set and the `GetCapacity` KeyVal), the `inventory` slice + `inventory/loaded`/`inventory/action-error`/`inventory/cleared` feed events, `app/flow.ts` `loadInventory`/`moveItem`/`stackContainer`/`boardShip`, and `web/src/ui/InventoryShip.svelte`. The browser addresses items/ships by game ID only; the BFF's `/api/bridge/inventory*` and `/api/bridge/ship/board` routes hold the bound-object handles (see "Bound-object bridge (R3)" above).

R4 page pieces (Agents & Missions): `web/src/bridge/agents.ts` (decoders for the `DoAction` conversation tuple, the `GetMissionBriefingInfo`/`GetMissionObjectiveInfo` courier briefing, and the `GetMyJournalDetails` journal — all `unwrapLong`, ISK/FILETIME kept as decimal strings), the `agents` slice + `agents/list`/`agents/conversation`/`agents/briefing`/`agents/journal`/`agents/action-error`/`agents/cleared` feed events, `app/flow.ts` `loadAgents`/`openConversation`/`chooseAction`/`loadBriefing`/`loadJournal`, and `web/src/ui/AgentsMissions.svelte`. The browser addresses agents by game ID; the BFF's `/api/bridge/agents*` and `/api/bridge/journal` routes hold the bound agent handles (see "Agent conversation, briefing, and journal (R4)" above).

R5a page pieces (Flight): `web/src/bridge/flight.ts` (the flight-status decoder — `unwrapLong`-aware IDs, docked/in-space derivation), the `flight` slice + `flight/status`/`flight/action`/`flight/action-error`/`flight/cleared` feed events, `app/flow.ts` `loadFlightStatus`/`undock`/`warpTo`/`jump`/`dock` (each surfaces a movement refusal as a visible reason and re-reads the true state — never a silent no-op), and `web/src/ui/Flight.svelte` (status readout + explicit undock/warp/jump/dock buttons, manual only). The browser picks each gate/destination by game ID (the route solver is R5b); the BFF's `/api/bridge/flight/*` routes hold the beyonce bound park handle (see "Space bridge & session-into-space (R5a)" above). Proven browser-side by `web/src/bridge/flight.test.ts` + `web/src/app/flightFlow.test.ts` and BFF-side by `test/bridgeFlight.test.js`.

R6 page pieces (courier completion + reward readout): the Agents & Missions page
(`web/src/ui/AgentsMissions.svelte`) gains a **courier/level/text agent filter with
a capped render** (default courier-only, first 60 shown with a match count — the
usability fix for Jita 4-4's ~1,700 agents, a pure store/view change), the mission
briefing gains **Load package into ship** (`app/flow.ts` `loadPackageIntoShip` — the
R3 inventory move) and **Set autopilot to dropoff** (`setAutopilotToDropoff` → the
R5b `startRoute(dropoffStationID)`) controls, and Complete (already a conversation
action via `chooseAction`) now also pulls the reward readout. The Step-12 wallet/LP/
standings reads have their own decoder (`web/src/bridge/rewards.ts` — `decodeCashBalance`
/ `decodeLpBalances` / `decodeCharStandings`, all long-aware, ISK/LP as decimal
strings), the `rewards` slice + `rewards/loaded`/`rewards/cleared` feed events,
`app/flow.ts` `loadRewards`, and `app/api.ts` `loadRewards` against the BFF's
`/api/bridge/rewards`. The journal (the fourth Step-12 read) reuses R4's
`loadJournal`. Unit-tested by `web/src/bridge/rewards.test.ts`,
`web/src/app/agentsFlow.test.ts` (Complete → reward pull, load-package-into-ship),
and BFF-side by `test/bridgeRewards.test.js`. See "Courier completion & reward
readout (R6)" above.

R6a page pieces (Agent Finder): the new `finder` store slice + `finder/results`/
`finder/target`/`finder/error`/`finder/cleared` feed events (`AgentFinderRow`/
`AgentFinderTarget`/`AgentFinderState` in `web/src/store/types.ts`), `app/api.ts`
`findAgents` (against `GET /api/agents/find`), `app/flow.ts` `findAgents` (fetch →
annotate each row with jumps from the docked system via `distancesFrom` → sort
nearest-first) and `setDestinationToAgent` (records the target, then reuses R5b
`startRoute(agent.stationID)`), the `distancesFrom` single-BFS helper in
`web/src/nav/routeSolver.ts`, and `web/src/ui/AgentFinder.svelte` (kind/level
server-side filters, client-side text search + nearest-sort + capped render, a
"Set destination" per row, and the current-target readout; a new **Agent Finder**
tab in `App.svelte`). Kind + level re-run the find (server-side); the browser
addresses agents by game ID. Unit-tested by `web/src/nav/routeSolver.test.ts`
(`distancesFrom`), `web/src/app/finderFlow.test.ts` (the finder flow + sort), and
BFF/staticData-side by `test/agentFinder.test.js`. See "Agent Finder static route
(R6a)" above.

R5b page pieces (Travel — browser autopilot): `web/src/nav/routeSolver.ts` (pure client-side BFS route solver over the system-adjacency graph), `web/src/nav/autopilotLoop.ts` (the framework-agnostic decide-loop controller — `createAutopilot(deps)` with `start`/`pause`/`resume`/`abort`/`tick`/`run`; the pure `decideAutopilotAction` maps flight-status → next atomic move), `app/api.ts` `loadSystemGraph`/`resolveDestination`, `app/flow.ts` `startRoute`/`pauseRoute`/`resumeRoute`/`abortRoute` (owns the graph cache + the single controller, wires its deps to the R5a flight routes and the store), the `travel` slice + `travel/planned`/`travel/progress`/`travel/plan-error`/`travel/cleared` feed events, and `web/src/ui/Travel.svelte` (Start/Pause/Resume/Abort + live readout, no map). The route solver + loop are unit-tested (`web/src/nav/routeSolver.test.ts`, `web/src/nav/autopilotLoop.test.ts` — a simulated docked→undock→warp→jump→approach→dock timeline proving each atomic call, approach-then-redock, pause-on-refusal, and no bridge call after abort), the flow by `web/src/app/travelFlow.test.ts`, and the BFF map routes by `test/bridgeMapGraph.test.js`. See "Client-side route solver & browser autopilot (R5b)" above.

R7 page pieces (Chat — Local + Corp): the `chat` store slice (`ChatState`
holding the active tab + per-channel `ChatChannelState`: roster + messages) +
`chat/loaded`/`chat/active`/`chat/error`/`chat/cleared` feed events (cleared on
character offline / logout), the decoder `web/src/bridge/chat.ts` (tolerant,
`unwrapLong`-aware `decodeChatChannel`/`decodeChatChannelName`/`decodeSentMessage`),
`app/api.ts` `readChat`/`sendChat` (against `GET /api/bridge/chat/:channel` +
`POST /api/bridge/chat/:channel/send`), `app/flow.ts` `loadChat`/`sendChatMessage`/
`setChatChannel` (a lost session unwinds to offline; other failures surface
through the chat slice), and `web/src/ui/Chat.svelte` (Local/Corp sub-channel
tabs, roster, message list, send box; polls the open channel every 4s via
`onMount`/`onDestroy` and stops on close). Unit-tested by
`web/src/bridge/chat.test.ts` (decoder), `web/src/app/chatFlow.test.ts` (flow),
and BFF-side by `test/bridgeChat.test.js`. See "Local + Corp chat (R7)" above.

### The mining bot — automated play (R26)

**No contract change. That is the headline, and it was the goal's constraint:
R26 is COMPOSITION, not new surface.** The bot adds **zero** gateway pairs, zero
BFF routes, and zero snapshot fields. Every call it makes was already allowlisted
and already had a route:

| The bot needs to… | It uses (all pre-existing) |
| --- | --- |
| know where the ship is | `GET /api/bridge/flight/status` (R5a) |
| measure the belt, the station, the rocks, the pirates, its own drones and **which modules are cycling** | `GET /api/bridge/space/snapshot` (R11 + R23 slice B's asteroid fields + R25's `isNpc`/drone fields) |
| know what is locked | `GET /api/bridge/targets` (R23 slice A) |
| lock a rock | `POST /api/bridge/targets/lock` (R23 slice A) |
| run the lasers | `POST /api/bridge/modules/activate` (R23 slice A) — **no `effect`**, so the server resolves the module's own default |
| see the ore | `GET /api/bridge/ship/ore-hold` (R23 slice B) |
| put the ore in the hangar | `POST /api/bridge/ship/ore-hold/unload` (R23 slice B) |
| put the ore in a **corporation** hangar | the same route with `division: 1..7` — see the fallback rule above |
| defend itself | `GET /api/bridge/drones` + `POST /api/bridge/drones/launch` (R25 slice A) |
| fly | `POST /api/bridge/flight/undock` / `warp` / `approach` / `dock` (R5a, with R24 slice A's `minRange: 0`) |

**Browser pieces:** `web/src/nav/miningBotLoop.ts` (the framework-agnostic
decide-loop — `createMiningBot(deps)` with `start`/`pause`/`resume`/`stop`/
`tick`/`run`, and the pure `decideMiningAction` mapping one reading of the world
to one atomic action plus the plain-language reason for it);
`app/flow.ts` `startMiningBot`/`pauseMiningBot`/`resumeMiningBot`/
`stopMiningBot` (owns the single controller and wires its deps straight to
`app/api.ts`, **not** through the flow's own refusal-swallowing wrappers — the
loop has to SEE a refusal to decide on it); the `bot` store slice with
`bot/started`/`bot/progress`/`bot/start-error`/`bot/cleared` feed events; and
`web/src/ui/MiningBot.svelte` (belt/station pickers off the live snapshot,
equipment ticked by the player, Start / Pause / Stop, and the live "what it is
doing / **why**" readout). Unit-tested by
`web/src/nav/miningBotLoop.test.ts` (the ladder, every bound, and a full
undock→belt→lock→mine→dock→unload→back-out cycle against a synthetic world) and
`web/src/app/botFlow.test.ts` (the flow wiring, over a faked BFF).

**One shared piece was extracted, not copied.** `decideCloseIn` in
`web/src/nav/autopilotLoop.ts` is now exported: the arrive / closing / approach /
warp rungs — including R24 slice A's warp dead band and the
never-restart-a-running-approach rule — are stated **once** and used by both the
autopilot's gate/station ladder and the bot's belt/station ladder. A correction
to the server's warp gate now corrects both callers at the same time.

**Two loops must never steer one ship.** `startMiningBot` aborts the travel
autopilot before it starts, exactly as R13's `stopShip` switches the autopilot
off: a ship being flown by two decide-loops is a bug neither of them can see.

**The one number the bot owns that is not the server's** is
`BELT_ARRIVAL_RADIUS_M` (20 km surface). A belt has no interaction radius to
borrow — you do not dock with a belt — so the bot needs its own answer to "have I
arrived", and it is used for exactly one decision: whether "no rocks in the
snapshot" means *still flying* or *this belt is finished*. It is never a mining
range, a lock range or a yield rule; the server owns all three and the bot finds
them out by being refused.

## Skills — the character sheet and the training queue (R28)

### ⚠ Why the write is a retail call and NOT the gateway's own `/skill-queue`

The gateway has had `POST /_evejs-web/v1/skill-queue` since long before R28. It
is **unreachable from a logged-in browser client**, and that is by design rather
than by accident:

- it runs `CHARACTER_COMMAND_TYPES.SAVE_SKILL_QUEUE` under
  `AUTHORIZATION_POLICIES.OFFLINE_COMPANION`;
- `characterCommandRuntime.authorizeInsideLane` admits that policy **only** when
  `controlState === "offline" && online === false`;
- selecting a character mints a held bridge session, `charService` calls
  `characterControlRuntime.recordRetailSessionStarted`, and
  `GET /character-status` then reports **`retail_client` / `online: true`**.

So `/skill-queue` is a **companion-app** surface for a character who is not
playing. A player reading their own skill sheet in this client *is* playing, so
the write has to be the retail one on the live session — like every other panel.
Both paths land in the same `skillQueueRuntime.saveQueue`, so they refuse
identically; only the envelope differs.

### `GET /_evejs-web/v1/skills?accountID&characterID`

A v1 read, **not** a bridge call: no `bridgeSessionID`, no session at all.
Reading what a character knows is not an act of piloting. Ownership is checked
exactly as `/snapshot` checks it.

```json
{ "ok": true, "source": "evejs-web-gateway", "apiVersion": 1,
  "skills": {
    "characterID": 140000005, "characterName": "Farmer",
    "totalSkillPoints": 641792000, "freeSkillPoints": 0,
    "serverNowMs": 1784617151473,
    "skills": [ { "typeID": 3300, "name": "Gunnery", "groupName": "Gunnery",
                  "level": 4, "rank": 1, "skillPoints": 45255,
                  "levelSkillPoints": [250, 1414, 8000, 45255, 256000],
                  "inTraining": false } ],
    "queue": { "active": true, "maxEntries": 150, "endTimeMs": 1784619665666,
               "entries": [ { "queuePosition": 0, "typeID": 3315, "toLevel": 1,
                              "startSP": 0, "destinationSP": 1000,
                              "startTimeMs": 1784617165666,
                              "endTimeMs": 1784619165666,
                              "skillPointsPerMinute": 30 } ] },
    "queueWarning": null } }
```

Three properties matter, and each removes a game mechanic from the browser:

- **`levelSkillPoints` is the server's SP curve, evaluated.** The gateway calls
  `skillTrainingMath.getSkillPointsForLevel(rank, level)` for all five levels.
  The client places current SP between two of those numbers and does no other
  arithmetic. Nothing anywhere in this repo defines the curve.
- **`skillPoints` is LIVE.** It comes from `getQueueSnapshot`'s
  `projectedSkills`, which already overlays the progress of whatever is
  training, so the training skill reports the SP it has *this instant*.
- **Every instant is epoch milliseconds, converted from the server's own Win32
  FILETIME, next to `serverNowMs` sampled in the same read.** The client
  measures its clock offset once per read and interpolates between reads; it
  never converts a FILETIME and never assumes the two machines agree.

`skillPointsPerMinute` is non-zero **only on the head entry** — a later entry's
attributes-at-the-time are not knowable now, and borrowing the head's rate would
be a client-side simulation.

`queue: null` means the queue could not be read (`queueWarning` says why). It is
**not** an empty queue; an empty queue is `entries: []` with `active: false`,
which is an ordinary state.

### `skillMgr.SaveNewQueue` — the only skill write

```
service: "skillMgr", method: "SaveNewQueue"
args:    [ [[typeID, toLevel], …] ]      // position order IS queue order
kwargs:  { "activate": true }            // false (with []) pauses training
```

**Add, remove and reorder are all this one call.** The server models a queue as
a list you replace; three client verbs on top of one server behaviour would only
create three ways to disagree with it. An empty list with `activate: false`
pauses training, which is why `skillMgr.AbortTraining` is **not** allowlisted.

**⚠ It returns `null` on success.** Its return value is not evidence of
anything. The BFF re-reads `GET /skills` after every save and answers with that
sheet; the client lands the re-read **before** it records the action.

**⚠ Everything else on `skillMgr` is deliberately absent.** `InjectSkillpoints`,
`InjectSkillIntoBrain`, `ExtractSkills`, `PurchaseSkills`,
`ApplyFreeSkillPoints*`, `SplitSkillInjector` and `CombineSkillInjector` each
spend something the player cannot get back — ISK, an injector, an extractor, or
unallocated SP that can only be applied once. A service-granular allowlist would
have handed the browser all of them.

### Refusals — the eleven public codes

`saveQueue` refuses the **whole** list and changes nothing. Its
`throwWrappedUserError` sites carry no `info`/`notify` prose, so
`readWrappedUserErrorRefusal` falls through to the bare code and the browser
receives **409 `CALL_REFUSED`** with the code *as the message*:

`QueueTooManySkills` · `QueueTooLong` · `QueueSkillNotUploaded` ·
`QueueCannotTrainPastMaximumLevel` · `QueueCannotTrainOmegaRestrictedSkill` ·
`QueueCannotTrainPreviouslyTrainedSkills` ·
`QueueCannotPlaceSkillLevelsOutOfOrder` ·
`QueueCannotPlaceSkillBeforeRequirements` · `UserAlreadyHasSkillInTraining` ·
`SkillInQueueRequiresOmegaCloneState` · `SkillInQueueOverAlphaSpTrainingSize`

The BFF passes them through **untranslated**; the wording lives in
`web/src/bridge/skills.ts` (`skillQueueRefusal`), where it is testable. A test
asserts that table is exactly the gateway's `PUBLIC_SKILL_QUEUE_ERROR_CODES`
allowlist — a code the gateway can send and the client cannot explain would
reach a player as jargon (R9a).

### BFF routes (this repo)

| Route | What it does |
| --- | --- |
| `GET /api/bridge/skills` | The held session's character sheet + queue, straight from `GET /_evejs-web/v1/skills`. Nothing decoded, nothing computed. |
| `POST /api/bridge/skills/queue` | `{ entries: [{typeID, toLevel}] }` → `skillMgr.SaveNewQueue`, then **re-reads the sheet** and returns it. `activate` is `entries.length > 0`. |

The BFF shape-checks entries (`typeID > 0`, `1 ≤ toLevel ≤ 5`) and nothing else.
What is *trainable* is the server's judgement — a client-side guess about
prerequisites or clone state is exactly the duplicated mechanic that drifts.

### Client modules

`web/src/bridge/skills.ts` (pure: decode, group, place SP between thresholds,
the five squares, the interpolated readout, and the refusal wording);
`app/api.ts` `getSkills`/`saveSkillQueue`; `app/flow.ts`
`loadSkills`/`saveSkillQueue`; the `skills` store slice with
`skills/loaded`/`skills/error`/`skills/action`/`skills/action-error`/
`skills/cleared`; and `web/src/ui/Skills.svelte`.

**The countdown is bounded on both sides.** SP is clamped to the server's own
`destinationSP`, the remaining time is clamped at zero, and when the head
entry's finish instant passes the panel **re-reads** instead of promoting the
level itself. A read always wins: the module keeps no memory between reads.

## Personal Assets — where your stuff is (R37)

"Where is my stuff, across the whole cluster", plus a course set to any of it.
**Reads only** — the bound global-assets object implements no write at all.

### ⚠ Not a top-level service: this is the bound two-step

Unlike mail / market / contracts, `charMgr`'s asset surface is reached through
`MachoBindObject`. The retail moniker is `Moniker('charMgr', (charID, 10002))`
— **10002 is the global-assets container id**, and
`charMgrGlobalAssets._parseBindContext` **refuses any other containerID**, so
this bind cannot be steered at another part of `charMgr`.

`charMgrService` delegates the whole surface to
`server/src/services/character/charMgrGlobalAssets.js`.

### Gateway pairs (R37 — `charMgr` had ZERO before this goal)

| Pair | Why |
| --- | --- |
| `charMgr.MachoBindObject` | The bind. Everything below dispatches on the bound object. |
| `charMgr.ListStations` | Every station holding the character's items, with an item count each. **This one call is the feature.** Scopes off the session; there is no way to ask about someone else's assets. |
| `charMgr.ListStationItems` | What is at ONE station. Called only when the player expands one, so first paint does not fan out per-station reads. |

**Deliberately absent, on the same bound object:** `List` and
`ListIncludingContainers` (each a strictly wider read — every item the character
owns anywhere, the latter walking into every container) and `GetAssetWorth`
(prices the lot). Nothing on screen needs a cluster-wide item dump or a
net-worth figure. `charMgr`'s own writes are absent too — a service-granular
allowlist would have handed them to the browser.

**Setting a destination adds no pair.** The route is solved in the browser from
the static map graph and flown with the `beyonce` pairs R5a already listed.

### ⚠ The two reads send DIFFERENT packedrow variants

This is the R32 contract-detail trap in a new place, and both shapes were
confirmed against bytes captured from the live handlers:

| Read | Envelope | Row shape |
| --- | --- | --- |
| `ListStations` | `{type:"objectex2", header, list, dict}` — a **CRowset**. ⚠ Rows are on **`list`**, not `items`. | **POSITIONAL** packedrow: `columns:[["stationID",20],…]` + parallel `values:[60003760,30000142,52678,9,null]`, **no `fields`**. |
| `ListStationItems` | `{type:"list", items}` | **NAME-KEYED** packedrow: `fields:{itemID,typeID,…}`, **no `values`**. |

`buildDbRowset` produces the positional variant because it feeds
`buildPackedRowFromRowsetLine` an *array* per row. A decoder that commits to
either variant returns `undefined` for every field of the other — silently.
Both are read through `readRowField` (`web/src/bridge/wire.ts:219`).

Column descriptors:

- stations: `stationID`(20) `solarSystemID`(20) `typeID`(3) `itemCount`(3) `upkeepState`(17)
- items: `itemID`(20) `typeID`(3) `ownerID`(3) `locationID`(20) `flagID`(2) `quantity`(3) `groupID`(3) `categoryID`(3) `customInfo`(129) `singleton`(2) `stacksize`(3)

### ⚠ Value encoding — measured, not assumed

`stationID` / `solarSystemID` / `itemID` / `locationID` are declared **int64**
(type code `0x14` = 20), so R32's bare-string-bigint trap was the expected
hazard. **It does not bite here:** `charMgrGlobalAssets` builds every one of
them with `toInteger()`, so they cross the wire as **plain JS numbers** — no
`{type:"long"}` wrapper and no decimal string. Measured live: `stationID`
`60003760`, `itemID` `9988400022007` (> 2³², still well under 2⁵³).

The decoder still accepts the wrapper *and* the bare string, because the gateway
renders any genuine `BigInt` as a bare decimal string
(`encodeJsonSafeCallValue`) and a future handler change must not silently zero
the panel.

### ⚠ `quantity` is `-1` for an assembled item, not a count

Every singleton row measured live carried `quantity:-1, singleton:1,
stacksize:1` — the retail convention for a unique assembled thing (a ship, a
fitted module). Rendering that field raw puts "-1 Badger" on screen. The decoder
exposes `units`, which is the **server's own rule**
(`charMgrGlobalAssets._calculateItemUnits`): a singleton is 1, everything else
is its `stacksize`.

### BFF routes (this repo)

| Route | What it does |
| --- | --- |
| `GET /api/bridge/assets` | Syncs the held session's live position, then one bound `ListStations`. Returns `{stations, ownsNothing, error}`. |
| `GET /api/bridge/assets/station?stationID=` | One bound `ListStationItems`. Returns `{items, volumes, hasNoItems, error}`. |

**`ownsNothing` / `hasNoItems` are FACTS, not guesses** — true only when the
read *succeeded and was empty*, exactly like `worldHasNoContracts`
(`src/server.js`). A failed read leaves them `false` and sets `error`, so "you
own nothing anywhere" and "that read failed" can never render alike. The flow
does not decode a payload that reported an error at all, so a partial answer is
never shown as if it were the whole truth.

**The position sync is deliberate.** The asset snapshot is built *against the
session*: `charMgrGlobalAssets` keys its cache on the session's
station/system/constellation/region, `isHiddenPersonalAssetLocation` hides the
character's own id, and an unknown location inherits the session's system. This
is the same class of dependency that made `GetAgents` answer 0 for a docked
station until the sync was added.

**`volumes` costs no bridge call.** Volume is a property of the *type*, not of
the stack, and the row descriptor has no such column — so the BFF attaches it
from `staticData.getType(...).volume`, the same class of read as `/api/names`. A
type the static tables do not know is *absent* from the map, and renders as "—"
rather than as a measured zero.

### Client modules

`web/src/bridge/personalAssets.ts` (pure: decode both row variants, the
singleton `units` rule, volume totals, refusal wording); `app/api.ts`
`loadAssetStations`/`loadAssetStationItems`; `app/flow.ts`
`loadPersonalAssets`/`openAssetStation`/`setDestinationToAssetStation`; the
`assets` store slice with
`assets/loaded`/`assets/station-items`/`assets/expanded`/`assets/cleared`; and
`web/src/ui/PersonalAssets.svelte`.

**Set-destination builds no navigation.** `setDestinationToAssetStation` is a
one-line wrapper over `startRoute(stationID)` — the same call Travel, the
cockpit, the agent finder and the mission bot all make. `startRoute` reports
plan failures through `travel.failureReason` rather than by throwing, so the
panel renders that field; without it an unreachable destination would look like
a button that did nothing.

## Player-structure names — the one runtime name read (R38)

R37 left an honest gap: a player-owned Astrahus rendered as **"an unnamed
place."** Every other name in this app comes from the static SDE, which is why
`/api/names` and `/api/map/resolve` could both be "read-only static reference
data, NOT a gateway call". A player-owned Upwell structure breaks that
assumption — it is created at runtime, lives only in the game store, and appears
in **no** static table (`structureProfiles/data.json` has 0 rows). Both static
paths therefore answered "unknown" for a structure that has a perfectly good
name.

### The read

| Pair | Why |
| --- | --- |
| `structureDirectory.GetStructureInfo` | `GetStructureInfo(structureID)` → `util.KeyVal`. The **only** `structureDirectory` pair the browser can reach, and the entire R38 allowlist delta. |

**Deliberately absent — and this one is not the usual "wider read" story.**
`structureDirectory.GetStructures` is the natural **batch** form (a list of IDs
in, a dict out, one round trip instead of N) and was the obvious pair to list.
It is refused because of a real asymmetry in eve.js:

- `Handle_GetStructureInfo` **branches on ownership** — non-owners get
  `buildBasicStructureInfoPayload`, the public eight-key payload.
- `Handle_GetStructures` calls `buildStructureInfoPayload` for **every**
  requested ID with **no ownership check at all** — fuel expiry, reinforcement
  timers, vulnerability schedule and quantum-core state for structures the
  caller has nothing to do with.

Allowlisting the batch form would put a defender's operational calendar behind a
browser read. The BFF pays the per-structure round trip instead, bounded by a
cap and a short TTL cache. *(Reported as a server defect; not fixed — game
mechanics are out of scope for this client.)*

`SetStructureDescription`, `structureDeployment.RenameStructure`,
`structureControl.BoardStructure`/`EjectFromStructure` and the rest of the
structure tree are absent too, and are named in the refusal sweep in
`server/tests/webGatewayServiceCall.test.js`.

### ⚠ Two payload shapes, both carrying the name

Captured live from structure `1030000000001` ("Perimeter - asdf", an Astrahus,
typeID 35832, in Perimeter 30000144):

| Caller | Shape | Keys |
| --- | --- | --- |
| **Owner** (Farmer, corp 98000001) | `util.KeyVal` | 28 keys — the full directory record, including `services`, `fuelExpires`, `reinforce_*`, `state`. |
| **Non-owner** (Test Pilot, corp 1000044, not docked there) | `util.KeyVal` | exactly 8 — `typeID`, `structureID`, `upkeepState`, `wars`, `ownerID`, `solarSystemID`, `itemName`, `inSpace`. |

Both carry **`itemName`**, and that is the only field the BFF reads — so the
lookup works for any structure, owned or not, docked at or not. The eight-key
shape is pinned against the golden log by eve.js's own
`structureDirectoryParity.test.js`.

**`null` is a real answer, not a failure.** `GetStructureInfo` returns `null`
for a structure that does not exist — verified live for an unknown ID, for an
NPC station ID, and for `0`. That is a definitive "not a player structure",
safe to cache.

### One resolver, two routes

`resolveRuntimeStructureNames` (`src/server.js`) is **the only place a structure
name is fetched.** Both name paths call it; nothing else may.

| Route | Change |
| --- | --- |
| `POST /api/names` | Static resolution runs first. Only the `station`/`structure` misses whose ID is **≥ 1e12** (retail's structure floor) fall through to the runtime read, so a batch with no structures still makes **zero** gateway calls. Adds `unresolved: string[]`. `source` becomes `static-data+runtime-structures` when a live read was involved. |
| `GET /api/map/resolve/:id` | Answers `kind:"structure"` with `structureName` + the structure's system (read from the **same** KeyVal — no second call). The name and ID are echoed into `stationName`/`stationID` so existing station-shaped consumers work unchanged. Adds `lookupFailed: boolean`. |

Every consumer of those two routes benefits with no per-panel change: Assets,
Travel, the flight readout, dock/station displays, the overview, contracts and
the map.

### ⚠ "No name" is not "the lookup failed"

The `worldHasNoContracts` rule (`src/server.js`), applied to names. A `null` in
`names` means the server looked and found nothing bearing that ID — cacheable
forever. A key listed in `unresolved` (or `lookupFailed:true` on the map route)
means the question was **never answered**: no character online, a gateway error,
or past the per-request cap.

The client must not cache the second kind. `flushNameQueue` releases those
pending marks and stores nothing, exactly as it already did for a transient
network failure; `cachedLocationName` skips the cache when `lookupFailed` is
set. Without this, one failed lookup would pin a real place to "an unnamed
place" for the rest of the session.

**Unknown stays honest either way** — `resolvedName(..., "an unnamed place")`,
never the numeric ID (R7d), never a fabricated label.

### Caching

Process-wide, 60 s TTL, definitive outcomes only. Shared across sessions
deliberately: `Handle_GetStructureInfo` applies no access check, so a structure's
name is public to any session that asks, and one account's cached name reveals
nothing another could not fetch itself. Only `name`, `solarSystemID` and
`typeID` are kept — never the owner-only fields the owner branch also returns.

## Planetary Interaction — the colonies you own (R41)

### ⚠ THE READ ALREADY EXISTED, AND IT IS NOT A BRIDGE CALL

`GET /snapshot` has always carried the character's colonies.
`buildPlanetRuntimeForCharacter` (`evejsWebGatewayRuntime.js:2129`) reads the
`planetRuntimeState` root table and filters `coloniesByKey` down to rows whose
`ownerID` is the requested character *before* the snapshot is serialized. The
ownership check is the gateway's own `validateOwnedCharacter`, the same one
`/skills` uses, and — like `/skills` — **no held bridge session is required**:
reading what you have built on a planet is not an act of piloting.

**So R41 added ZERO gateway allowlist pairs.** R37 added three, R38 added one,
R40 added none, and this adds none.

### ⚠ Why the obvious `planetMgr` reads were DECLINED (the R38 shape, again)

`planetMgr` does expose reads, and every one of them is deliberately
**owner-agnostic**, because in the retail client they back the *in-space* planet
view where you can see that somebody else has a colony:

| Handler | Why it is not allowlisted |
| --- | --- |
| `Handle_GetFullNetworkForOwner` | Takes `ownerID` from **`args[1]`**. Allowlisting it would let any logged-in browser read **any** character's pin layout on any planet by passing someone else's id. |
| `Handle_GetCommandPinsForPlanet` | Iterates `listColoniesForPlanet` across **all** owners and returns a command-pin summary per owner. |
| `Handle_GetExtractorsForPlanet` | Same: every owner's extractors on that planet. |
| `Handle_GetPlanetsForChar` | Session-scoped and safe, but answers only the planet *list* — the contents still need one of the three above. |

A service-granular allowlist would have handed all four to the browser. The
snapshot answers the same question with the ownership filter already applied.

**Proved live, not asserted:** with the panel fully working, a sweep of eleven
`planetMgr` methods through `POST /api/bridge/call` returns `CALL_NOT_ALLOWED`
for every one, and four other characters read `colonies: 0` while `Farmer`'s
colony sits in the same table.

### `GET /api/bridge/planets` (this repo)

Requires the web login **and** a held bridge session (the session is what names
the character; it is not used to *call* anything). Answers:

```jsonc
{
  "ok": true,
  "characterID": 140000005,
  "serverNowMs": 1784660311765,   // sampled in THIS read; the browser's clock offset
  "coloniesReadable": true,        // see below — NOT the same as colonies.length
  "colonies": [
    {
      "planetID": 40009077,
      "planetName": "Jita I",      // null when the static map cannot name it — NEVER the id
      "solarSystemID": 30000142,
      "solarSystemName": "Jita",
      "planetTypeID": 2016,        // for the icon only (R7d)
      "planetTypeName": "Planet (Barren)",
      "commandCenterLevel": 5,
      "lastSimulatedAtMs": 1784233384726,
      "linkCount": 3,
      "links": [                   // endpoints are pin ids, for matching, not display
        { "endpoint1": 1, "endpoint2": 4, "level": 1 }
      ],
      "pins": [
        {
          "pinID": 1054656331522,
          "typeID": 2544,
          "typeName": "Barren Launchpad",
          "kind": "launchpad",     // command | extractor-control | extractor | factory | storage | launchpad | other
          "contents": [ { "typeID": 2396, "typeName": "Biofuels", "quantity": 40 } ],
          "usedM3": 7.6,           // null when ANY content type has no volume — see below
          "capacityM3": 10000,     // null when the static table cannot say — NEVER 0
          "schematicID": null,     // a factory's recipe; the id is for the name beside it
          "schematicName": null,   // "Superconductors"
          "hasReceivedInputs": null,        // three-state; null on every non-factory pin
          "receivedInputsLastCycle": null,  // false = starved last cycle, a real alarm
          "lastRunAtMs": 1784659559723,
          "lastLaunchAtMs": null,  // "0" on the wire is "never", not 1601
          "program": null          // only ever set on an extractor control unit
        }
      ],
      "routes": [
        { "routeID": 1, "path": [2, 4], "commodityTypeID": 2268,
          "commodityTypeName": "Aqueous Liquids", "commodityQuantity": 2841 }
      ]
    }
  ]
}
```

### ⚠ `coloniesReadable` — the `worldHasNoContracts` rule

`colonies: []` alone is ambiguous. `coloniesReadable` splits it:

- `true` + empty — the snapshot carried a colony table and **none of it is
  yours**. This is the only state that justifies telling a player they have
  built nothing.
- `false` — the gateway reported **no colony table at all**. That says nothing
  about the character, and the panel words it separately: *"This server did not
  report any colony information… That is not the same as having no colonies."*
- A read that throws never reaches either; it becomes a `planets/error`, and the
  store leaves `colonies: null` rather than `[]`.

### ⚠ A DURATION IS IN FILETIME TICKS TOO — this cost a live round trip

Instants (`expiryTime`, `installTime`, `currentSimTime`, `lastLaunchTime`) are
Windows FILETIME **strings**, because they overflow a double. That much is
expected. What is easy to miss is that **`cycleTime` is a duration in the same
100ns ticks**, not seconds — `planetRuntimeStore` divides it by `SECOND_TICKS`
(10,000,000) everywhere it uses it.

The live colony on Jita I carries `cycleTime: 9000000000` = **900 s**, a
15-minute extractor cycle, exactly what retail PI uses. The first version of
this route copied it across as `cycleTimeSeconds` unconverted, which would have
rendered a cycle **285 years** long — and the unit tests passed, because the
fixture had been written with the same wrong assumption. Only the live read
caught it. The BFF now converts, and a test drives that exact live value.

`"0"` is EveJS's **"never"** (a launchpad that has never launched), not the year
1601: every instant leaves the BFF as epoch ms **or null**, never 0.

### ⚠ A FILL IS A VOLUME, AND UNKNOWN IS NULL BECAUSE THE BROWSER DIVIDES

`usedM3 / capacityM3` is the only arithmetic the panel does with these, so both
follow the same rule as the instants: **absent is null, never 0.**

- `capacityM3` comes from the gameStore's `itemTypes.capacity` — the same field
  `planetRuntimeStore.getPinCapacity` reads, which treats a non-finite one as no
  limit at all. A storage facility is 12,000, a launchpad 10,000, a command
  centre 500. An **extractor control unit and an industry facility really carry
  0**: they are not holds, and the BFF answers `null` for them so nothing
  divides by zero and reports every one of them as full.
- `usedM3` is all-or-nothing. One commodity the static table has no volume for
  makes the **whole pin's** used volume `null`, because a partial sum is not a
  smaller number — it is a wrong one, and it would be shown as a percentage.
- `0` itself survives: an empty command centre really holds 0 m³.

Unit counts cannot answer "nearly full". 12,000 Aqueous Liquids at 0.005 m³ is
60 m³ of a 12,000 m³ facility — the largest unit count on the planet, and 0.5%
of the hold.

### ⚠ THE TWO PROCESSOR FLAGS ARE THREE-STATE

`normalizePin` writes `hasReceivedInputs` / `receivedInputsLastCycle` onto
**process pins only**. So `false` means the emulator fed this factory nothing
last cycle — a real alarm worth showing — while `null` means the pin has no such
state, which every extractor, launchpad and storage facility answers.
Collapsing the two starves every colony on screen.

### `GET /api/roster/planets?characterIDs=a,b,…` (this repo) — R108 slice 3

The PI Manager's read: several pilots' colonies with **none of them selected**.
Web login only — **no held bridge session**. The held session on
`/api/bridge/planets` above is that route's own shape, not the gateway's:
`GET /snapshot` is gated by `validateOwnedCharacter` alone and its colony table
is filtered by `ownerID` out of persisted state. Proved live on 2026-09-23
against a logged-out pilot that owned colonies — they came back, owner-filtered,
while a pilot on the same account with none came back with a table that was
present and empty.

Shaped exactly like `/api/roster/training`: every id is asked with the
**caller's** accountID, at most 12 per ask (`TOO_MANY_CHARACTERS`), and a pilot
the gateway refused or failed on is **left out**, never answered empty.

```jsonc
{
  "ok": true,
  "serverNowMs": 1790239800000,   // ONE clock sample, taken as the answer leaves
  "pilots": [
    {
      "characterID": 90000001,
      "readAtMs": 1790239799100,   // when THIS pilot was read — per pilot, never shared
      "coloniesReadable": true,    // the same rule as /api/bridge/planets
      "colonies": [ /* exactly the /api/bridge/planets colony shape */ ]
    }
  ]
}
```

- **`readAtMs` is per pilot on purpose.** Several pilots read in parallel are
  several moments; a board that merged them under one stamp would present them
  as a snapshot they never were. `serverNowMs` is a different instant — the one
  the browser corrects its clock against — and folding the two together would
  skew that correction by the slowest read.
- **Left out means "could not be read", not "has not built".** The client knows
  what it asked for; `unansweredPilots` names the difference so the board can say
  so for that pilot and keep the reading it had.
- **Reading only.** Acting on a colony needs a selected character; that goes
  through the bot host, never through a select from here.

### Client modules

| File | What it holds |
| --- | --- |
| `web/src/bridge/planets.ts` | Decoder + pure arranging: `decodeColonyReport`, `summarizeColony`, `programProgress`, `programHasExpired`, `pooledContents`, `colonyPlaceWords`, `formatDuration`. Nothing simulates a colony. |
| `web/src/bridge/piRoster.ts` | `decodeRosterColonies` for `/api/roster/planets` — each pilot through `decodeColonyReport`, its own `readAtMs` kept, the clock offset from the envelope — and `unansweredPilots`. |
| `web/src/bridge/piBoard.ts` | `buildPiBoard`: the PI Manager's board — four outcomes per pilot, every colony worst first across pilots with its own read age, and the "read at different times" line. |
| `web/src/app/piRosterPrefs.ts` / `piRosterRead.ts` | The PI roster (members + each pilot's last entry, decoded on the way out of storage) and its read: one throwaway sign-in per account, never a select. |
| `web/src/app/piDispatch.ts` | Slice 4: "Restart extractors" for one pilot, as a SERVER run through `POST /api/bots/start` on a throwaway sign-in — never a select. The board keeps one ordinary saved bot, "Planetary: restart extractors", found by name or saved once; a copy someone changed is refused, not overwritten. The grant is derived by the same policy analysis the bot host runs, and the host's refusal (`CHARACTER_IN_USE`, `BOT_ALREADY_RUNNING`) is shown in its own words. |
| `web/src/bridge/colonySupply.ts` | Whether an unfed factory has anything feeding it, walked along the colony's routes. A factory that went unfed last cycle is only a finding when an input has no live source (no route, or every route leads back to nothing); slower than it could use says nothing, and a chain that dies at a stopped extractor is left to that extractor's own finding. |
| `web/src/bridge/colonyAttention.ts` | The monitor's judgement: `colonyFindings`, `attentionByColony`, `colonyAttentionWords`, `attentionSummaryWords`, `pinFill`. Raises a finding only from a fact the server stated — a null raises nothing, so a quiet colony is genuinely quiet. |
| `web/src/store/types.ts` | `Colony`, `ColonyPin`, `ColonyLink`, `ColonyExtractionProgram`, `ColonyRoute`, `ColonyStoredItem`, `PlanetsState`. |
| `web/src/store/clientStore.ts` | `planets` slice; `hasNoColonies` is set **only** from `coloniesReadable && colonies.length === 0`. |
| `web/src/app/flow.ts` | `loadPlanets()`, `selectColony()`. One GET, no write. |
| `web/src/ui/Planets.svelte` | The panel. Four outcomes, four sentences. |

### Not built (deliberately)

The emulator has a **write**: `submitPiRestartExtractorsCommand`
(`POST /_evejs-web/v1/pi/restart-extractors`), with four already-player-safe
refusal codes (`CannotManagePlanetWithoutCommandCenter`, `PinDoesNotExist`,
`PinDoesNotHaveHeads`, `CannotPlaceHeadTooFarAway`). R41 ships **looking**
before it ships **acting**; the restart is a natural next slice and the refusal
seam (`web/src/bridge/refusals.ts`) is already there for it.

### How to add a page on the new stack (R2+)

1. Mine the page's retail calls (`docs/retail-call-inventory.md`) and get each (service, method) pair allowlisted in eve.js (bridge-goal work, not web-side).
2. Add the wire result type + a decoder next to `web/src/bridge/characterSelection.ts` (copy its pattern: type the tuple/rowset, decode to a plain row type in `web/src/store/types.ts`, tolerate malformed rows, unit-test against a handler-shaped fixture).
3. Add the page's state as a new typed slice in `web/src/store/clientStore.ts` with `FeedEvent` variants in `feed.ts`; pages and the future autopilot loop read via signals/`subscribe`, never write slices directly.
4. Build the view against the store only (view library per the R2 spike), add an entry in `web/index.html` or a new Vite input, and run `npm run typecheck` + `npm test`.
5. There is no legacy path left to delete: goal **R9b** retired the `eveStore` dashboards, the `/api/characters/*` family, the lease/command/event machinery, and their modules. `src/eveStore.js` is now only the account/character lookup the auth path needs (`getAccount`, `listCharactersForAccount`, `getCharacterForAccount`, `getStatus`). Build the page on the bridge; no new features on the v1 gateway.
