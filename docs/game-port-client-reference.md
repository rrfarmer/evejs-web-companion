# Game-port client reference: what the retail client does, and where we match

Written 2026-10-08 against retail client build 3396210 and eve.js `7603a2966`. It is the checklist
`src/gamePort/` is held to. The plan it serves is
[`game-port-transport-plan.md`](game-port-transport-plan.md).

## What "identical" means here

**The server must decode the same values, in the same order, from our packets as from the retail
client's.** Field for field, dict entry for dict entry, address for address.

It does **not** mean the same bytes. The client's marshaller (`blue.marshal`) shares repeated
objects inside one stream, and which objects it shares depends on Python object identity at the
moment of the call. That cannot be reproduced from outside the client, and no receiver can tell
the difference once the stream is decoded. Compression is in the same category: whether a packet
is compressed depends on its encoded size.

## How each fact was established

| Mark | Meaning |
|---|---|
| **S** | Read in the client's own source (`eve.js/tools/ClientCodeGrabber/Latest`) |
| **O** | Answered by the client's own Python 2.7 (`python27.dll`, via `scripts/py27-oracle.py`) |
| **L** | Seen in an eve.js log of a real client session |
| **V** | Confirmed live: a real server accepted it and answered as it answers the real client |
| **?** | Not settled. Needs a recording of the real client (last section) |

## Handshake (`GPS.py` `Authenticate`)

| # | The retail client | How known | Ours |
|---|---|---|---|
| H1 | Before login, on the same connection: version reply, then `(None, 'QC')`; reads its queue position; the server restarts the handshake | S, L | matches, V |
| H2 | Version reply is `(170472, 496, 0, 24.01, 3396210, 'V24.01@ccp')`: the third field is 0, not the server's user count | S | matches, V |
| H3 | Refuses the server on a region, codename, version or protocol mismatch, or a newer build, before sending anything | S | matches |
| H4 | `(None, 'VK', CryptoHash(CaseFold(username)))` | S | matches, V |
| H5 | Crypto pack is Placebo: request is `('placebo', {})`, nothing is encrypted | S, L | matches, V |
| H6 | `CryptoHash(x)` is `str(crc_hqx(blue.marshal.Save((x,)), 0))`, a decimal string | S, O | matches |
| H7 | Client challenge is 64 NUL bytes; its hash is `55087`, which the server sends back and the client checks | S, O, L | matches, V |
| H8 | Credentials dict has eleven keys, in the order Python 2.7 iterates that dict literal | S, O | matches, V |
| H9 | `user_name` is a unicode object (it comes from an edit box); the other strings are byte strings | S | matches, V |
| H10 | `user_password_hash` is SHA-1 chained 1000 times over UTF-16LE, salted with the name lowered bytewise | S, O, L | matches, V |
| H11 | Answers the server's challenge with `(CryptoHash(serverChallenge), stdout of the server's login function, its result)`; eve.js logged this as a 5-byte string, a 75-byte string and None | S, L | matches, V |
| H12 | Runs the Python function the server sends | S | **emulated**: answered from a table of known functions; an unknown one gets an empty answer and `unknownHandshakeFunction` is set |

The stored password hashes of three accounts in the dev database equal H10's result for their
password, which is how H10 is tied to a real client login.

## After login (`machoNet.ConnectToServer`, `connectionService`)

| # | The retail client | How known | Ours |
|---|---|---|---|
| A1 | First call is `machoNet.GetServiceInfo`, addressed to the proxy node from `proxy_nodeid` | S, L | matches, V |
| A2 | `SynchronizeClock`: up to five `machoNet.GetTime`, ending early after three readings that each beat the last | S, L | matches, V |
| A3 | Re-syncs every three minutes with five `GetTime` calls | S | matches (interval and count; the client's drift smoothing is not reproduced) |
| A4 | After 60 s with nothing sent, calls `pingService.Ping` | S, L | matches, V |
| A5 | Answers a server `PingReq` with its times plus a `client::turnaround` entry | S | matches |
| A6 | Dozens of further calls as its services start (login screen, character select, station) | L | **per feature, by decision**: see "Startup call sequence" |

## Packets and addresses (`machoNetPacket.py`, `machoNetAddress.py`, `*GPCS.py`)

| # | The retail client | How known | Ours |
|---|---|---|---|
| P1 | A packet's state is 14 fields: command, source, destination, userID, body, oob, contextKey, journeyID, six trace fields | S | matches |
| P2 | Call source is `client(clientID=0, callID)`; call IDs count from 1 | S, L | matches, V |
| P3 | `sm.ProxySvc` calls go to `node(proxyNodeID, service)`; `sm.RemoteSvc` calls go to `any(service)` | S, L | matches, V |
| P3a | A service's node is kept from a `WrongMachoNode` refusal and from nothing else: the client keeps `services[service]` from it, sends that call again to `node(nodeID, service)`, and sends every later call of the service there; a service whose place in `serviceInfo` matches a kept one's goes to that one's node (`ServiceCallGPCS.py` `RemoteServiceCallWithoutTheStars`, 194 to 217 and 268 to 277). Not refused so, a service's calls all go to `any(service)` | S; Tranquility's recordings: of 294 calls sent to no node, 125 redirected ("Redirecting call to node") | this server never refuses so, and a retail client on it sends every call of a service by name to `any` (13 of `config`, 11 of `charUnboundMgr`, 8 of `charMgr` in one session); the game port does the same: each of the 26 services both logs have is addressed the same way in both, L |
| P4 | A bound object's call goes to `node(nodeID)` with no service; body is `(1, pickle((objectID, method, args, kw)))` | S, L | matches, V |
| P5 | A service call's body is `(0, pickle((1, method, args, kw)))` | S | matches, V |
| P6 | Every call's keywords carry `machoVersion`, 1 unless a cached answer supplies another | S | matches (always 1; no answer cache yet) |
| P6a | Keywords go out in the order of the client's own dict, which a service call and a bound-object call build differently (below) | S, O | matches |
| P7 | A Moniker resolves first (`MachoResolveObject(bindParams)` to any node), then binds on the node that names (`MachoBindObject(bindParams, call)`) | S, L | matches, V |
| P7a | One call at a time of any one thing (`machobase.ThrottledCall`, from `ServiceCallGPCS` 697 and `ObjectCallGPCS` 616): the same call made again while it is out (the same service or object, method, `str(args)`, `str(kwargs)`) is not sent, waits, and takes the first one's answer. A call that failed is no answer: the first of those waiting asks for itself. No client call opts out (`noCallThrottling` is passed nowhere outside the net code) | S, and a Tranquility recording ("Sharing result for call ('N=...', 'GetInitState', '()', '{}') ... for 1 waiting threads") | matches, V: three of one call at once were one packet, and two binds of one address with the same call in each were one bind |
| P8 | `oob` is None unless set; `contextKey` is never set by a client | S | matches |
| P9 | Packets over 200 bytes are compressed with zlib level 1 when that saves more than 5% | S | matches, V; **?** which of the client's two compression paths is live (below) |
| P10 | Anything received that does not start `~` or `}` is zlib | S | matches |
| P11 | `journeyID` is `str(uuid4)` for the current journey | S | a fixed UUID per session; **?** when the client changes it |
| P12 | The six trace fields | S | all None; **?** whether the client ever fills them |
| P13 | Call ID is a Python long, and so is a bound object's node ID (`long(nid)`) | S | matches, V |
| P14 | A Python long is written as opcode 0x2f (blue's `WriteLong`), and on 64-bit Windows every integer above 2^31-1 is one | S, O | matches, V: `src/gamePort/clientMarshal.js`. The server reads 0x2f as a number and an int64 as a BigInt, so this is not cosmetic: sent as int64, an item ID broke every read on a ship's inventory |
| P15 | A refused call comes back as an `ErrorResponse` carrying the exception; a game refusal is a `UserError(msg, dict)` | S, L | read into `error.refusal`, with the reason worded as the gateway words it |

## What the server pushes

| Packet | Handling |
|---|---|
| `SessionChangeNotification` | Applied to `session.attributes`; listeners told what changed |
| `SessionInitialStateNotification` | Same |
| `Notification` | Peeled as the client's three layers peel it: object-call flag and pickle, service-or-broadcast, then the broadcast's `(1, args)` |
| `PingReq` | Answered (A5) |
| `CallRsp`, `ErrorResponse`, `PingRsp` | Matched to the waiting call by the call ID in the destination address |
| `TransportClosed` | Closes the session |

## Cached answers (`objectCaching.py`, `cachedObject.py`)

Some calls answer with a `CachedMethodCallResult` instead of the answer. The caller of a remote
call in the client never sees that wrapper, and neither does a caller of `session.call`.

| # | The retail client | How known | Ours |
|---|---|---|---|
| C1 | Unwraps a `CachedMethodCallResult` before returning (`ret = ret.GetResult()`) | S | matches, V |
| C2 | Its result is either the answer as a marshal string, carried inline... | S | matches, V (`account.GetKeyMap`) |
| C3 | ...or a `util.CachedObject` reference, fetched with `objectCaching.GetCachableObject(shared, objectID, objectVersion, nodeID)` through the proxy node when shared | S, L | matches, V (`map.GetStationInfo`, `corporationSvc.GetAllCorpMedals`) |
| C4 | The fetched object's pickle is zlib when its `compressed` flag is set | S | matches, V |
| C5 | Keeps what it fetched; fetches again only when the checksum differs and its copy is older | S | matches, V (asked twice, fetched once) |

## Python 2.7 behaviour that reaches the wire

`src/gamePort/py27.js` reproduces, for 64-bit Windows, the string, int and long hashes and the dict
table of CPython 2.7. `test/fixtures/py27Oracle.json` holds what the client's own interpreter
answered for 1,303 keys and 44 dicts, built two ways each; the test requires an exact match.

It covers a dict built by a literal, by inserting into an empty dict, and by `copy()`.

**Keyword order (P6a).** A call's keywords pass through several dicts before they are sent, and two
keys that want the same slot can come out either way round depending on the route:

- A remote **service's** method is a plain function, so its keywords are collected in the order
  written. (`MachoServiceConnection.__getattr__` returns a closure.)
- A **bound object's** method is an object with `__call__`, so the interpreter collects them last
  first and then refills them. (`MachoObjectCallWrapper`.)
- Either way the dict is then copied and `machoVersion` added.

The oracle was asked 406 keyword sets by both routes. The two routes disagree in 78 of them, and
`keywordOrder` matches the interpreter in all of them. One thing the interpreter corrected: a
copied dict's table is four times its entry count, not the two that the CPython source suggests
from memory.

## Not done

**Startup call sequence (A6): per feature, decided 2026-10-08.** At login, at character select and
on entering a station the client makes roughly ninety calls as its services start. We do not replay
them wholesale. Each browser feature makes the calls its retail counterpart makes, with the same
arguments in the same order, when that feature is built on the game port. Many of the ninety serve
screens we will not have (paper dolls, login campaigns).

What this accepts: a server-side observer can tell our login from a retail one by which calls are
absent. The recorded real session
(`eve.js/_local/logs/direct-tcp-real-client-20260809-163920.stdout.log`) names the calls in order,
and the decompiled service that issues each one gives its arguments.

**Measured 2026-10-09** (`docs/game-port-login-calls.md`, from `scripts/login-calls-report.js`): that
session's client made 117 calls of 100 kinds between connecting and sitting docked with nothing
opened. A pilot chosen on the game port and left alone made 12 calls of 7 of those kinds, and none
the client did not make. Of the other 93 kinds, 24 are asked later by a feature in a form read
against the client's, 16 only by a route of the BFF's, and 53 by nothing of ours.
The report is made again as services are done; the standings' two were the first.

**The skill handler's, 2026-10-09.** The client's two skill services and its notifications ask the
handler eight things when a character is chosen: `skillMgr2.GetMySkillHandler`, the bind of the
moniker that answers (which carries the first read), `GetSkills`, `GetBoosters`,
`GetSkillQueueAndFreePoints`, `GetAllSkills`, `CheckAndSendNotifications` and
`GetSkillHistory(10)`. The transport asks them in the order a real client asked this server
(`server.2026-10-06_15.log`), keeps what the services keep (`src/gamePort/pilotSkills.js`) and
keeps it right from the server's notices. A read of the handler the BFF asks for is answered from
what is kept where the client's service would answer from what it keeps, and asked for once where
it would ask once. With those the report is 17 kinds of the client's 100 at login, 18 by a feature,
15 by a route only, 50 by nothing of ours.

**The Skills window's sheet, 2026-10-09.** On the game port the page's sheet is made from what is
kept (`src/gamePort/skillSheet.js`), each figure the way the client's windows make it: a level's
points from the rank (`characterskills/util.py`), the skill in training from the queue's first
entry, its points from the entry kept plus the time since the queue began at the pilot's rate
(`skillQueueSvc.GetEstimatedSkillPointsTrained`), the rate from the character's attributes, the
total from every skill's points and the free points. The attributes are asked for when a skill is
first found in training, as the client's reckoning asks for them. The web gateway's own sheet, a
snapshot no retail client asks for, is read on the gateway alone. That reckoning needs the skill
list to hold the points a training skill had when the queue's first entry began: see the log's
entry "the Skills window from what is kept" for what this server answered there and what
Tranquility's recordings say.

**A queue saved, 2026-10-09.** On the game port the page's save is the client's queue panel's
(`skillQueuePanelNew.ApplySkillQueue`): the attributes read where they are not kept and the queue
is not empty (the trimming reckons each entry's time), then
`SaveNewQueue({position: (typeID, toLevel)}, activate=True)` on the skill handler, then the queue
asked for again (`GetSkillQueueAndFreePoints`, the panel's new transaction), after a refusal too
but for two. Tranquility's recording has the last two one after the other. The gateway transport
saves by name on `skillMgr` with a list, as before. The page's "Stop training" saves an empty
queue; the client's Pause is `AbortTraining` and keeps the queue.

**The agents' journal, 2026-10-09.** The client's journal service asks
`agentMgr.GetMyJournalDetails()` once and keeps the answer. `OnAgentMissionChange(state, agentID)`
marks the agent (with no agent, the journal is forgotten), and the next reading asks each marked
agent's own moniker for `GetMyJournalDetails()`, takes that agent's first mission out of what is
kept and puts the answer at the end of both lists. A Tranquility recording of a mission accepted
and quit has four such readings, all on the one object the agent's talk was on. The transport
does the same (`src/gamePort/pilotJournal.js`): the journal read when a character is chosen, the
agent asked at once after each notice, and one object for an agent whoever asks on it, the BFF's
handle or the journal's own reading (`agents.GetAgentMoniker`). On the game port the Journal
route answers from what is kept.

**The agents' table, 2026-10-09.** The client's agents service asks `agentMgr.GetAgents()` once,
as its character is chosen, and keeps the whole table for as long as it runs. On Tranquility the
answer is a cached object the client fetches and writes to disk; this server answers the table
itself, some eleven thousand rows, each time it is asked. Each pilot on the game port asks as it
is chosen, without the choosing waiting on it, and one copy is kept for all pilots, in the
gateway's form: what the last to ask was answered. A read of the table through the BFF is
answered from that copy. Measured: 88 to 95 ms a read of the Agents route before, 1 to 5 after.

**The corporation's registry at login, 2026-10-09.** As its character is chosen the client binds
`Moniker('corpRegistry', session.corpid)`, with no call, and three of its services ask what it
bound, each with nothing:

- `crimewatchSvc` asks `GetAggressionSettings()` and keeps the answer. It asks again when the
  session's corporation changes, and takes the server's `OnCorpAggressionSettingsChange(settings)`
  for what it keeps. A director's own change (`RegisterNewAggressionSettings(bool)`, the button in
  the corporation window) answers that window only: what `crimewatchSvc` keeps changes by the
  notice.
- the corporation service's members ask `GetEveOwners()`, which primes the client's names and is
  kept by nothing else. Again when the corporation changes.
- its applications ask `GetMyApplications()` once and keep the list, which the client then works
  over itself at each `OnCorporationApplicationChanged(corpID, applicantID, applicationID, row)`.

On the game port the transport asks the same three as a pilot is chosen and waits for them, 6 ms
on this machine, and asks the first two again when the pilot's corporation changes. They are asked
before the table of agents: sent right behind it, the first of them was answered 82 ms after it
reached the server, and 1 ms when sent before. The settings are kept as the client keeps them, and
a read of them through the BFF is answered from what is kept. The applications are not kept: a
read asks the server each time so that a reader on another connection sees an officer's latest change.

**The address book at login, 2026-10-09.** As its character is chosen the client's address book
asks, side by side (`addressbookService.GetContacts`): `charMgr.GetContactList()` by name, for the
pilot's contacts and blocked owners; its corporation's contacts, `GetCorporateContacts()` on the
corporation's registry, unless the corporation is an NPC one; its alliance's, `GetAllianceContacts()`
on the alliance's own moniker, if it is in one; and `onlineStatus.GetInitialState()` by name
(the online status service's `Prime`), for who of its watched contacts is online. One Tranquility
login of a pilot in a player's corporation has the contact list, the corporation's and the online
state one after another in that order (calls 99, 100, 101); another has the online state asked
earlier (424) and then the contact list and the corporation's together (443, 444). In both they
come after the members' names and before the applications. The client keeps all of them and works
them over at the server's notices (`OnPersonalContactsUpdated`, `OnOrganizationContactsUpdated`,
`OnContactLoggedOn`, `OnContactLoggedOff` and others).

On the game port the transport asks the same, in that order, as a pilot is chosen, and waits for
them. It keeps none of them: no window of the page reads a contact yet, and a read of the routes
asks the server as before. `onlineStatus.Prime`, which a BFF route asks of the server, is the
client's own service's method and never a call of the client's.

**The alliance's registry, 2026-10-09.** No Tranquility recording has a pilot in an alliance, so
this is the decompiled client alone (`all_cso.py`, `eveMoniker.py`). The client's alliance service
keeps one moniker, `Moniker('allianceRegistry', (session.allianceid, 1))`, the 1 for "is master",
and binds it for its own sake when it makes it (`GetMoniker`: `Bind()`), as the corporation's
registry is bound. It makes it when something first wants it, which at login is the address book
asking `GetAllianceContacts()`, and makes and binds a new one at once when the session's alliance
changes. With no alliance it cannot make one (`eveMoniker.GetAlliance` raises) and asks nothing.
Everything of the session's own alliance is asked of the moniker. What is asked about any
alliance by its ID is asked of the service by name: `GetAlliancePublicInfo`, `GetRankedAlliances`,
`GetEmploymentRecord`, `GetAllianceMembers`, `GetDaysInAlliance`, `GetAllianceMembersOlderThan`,
and `GetAlliance(allianceID)` for an alliance that is not the session's (its own is
`GetMoniker().GetAlliance()`, with nothing).

On the game port the transport does the same. For a pilot in an alliance the address book's reads
at the choosing bind the moniker and ask its contacts, and what the BFF asks of the alliance's
registry goes to the moniker or by name as the client's would. For a pilot in none, what the BFF
asks all the same goes by name as before, and the ledger says it is the web's alone.

**The notifications, 2026-10-09.** The client's notification service (`notificationSvc.py`) keeps
three lists. All of a pilot's notifications are asked for as its character is chosen, by the
notification window (`notificationUI._NotificationProvider`): `notificationMgr.GetAllNotifications`
with the keyword `fromID`, which is the last notification the user cleared and nought in a
recorded Tranquility login. The unread ones (`GetUnprocessed()`) and those of a group
(`GetByGroupID(groupID)`) are asked for when first wanted. Each list is kept, and the client
works the server's `OnNotificationReceived`, `OnNotificationDeleted` and `OnNotificationUndeleted`
and its own marking and deleting into them itself.

On the game port the transport asks for all of them, from nought, as a pilot is chosen, and waits
for the answer. The three lists are kept as they were answered, and a read of one through the BFF
is answered from what is kept. One thing is not the client's: at any of the three notices, and
after any of the pilot's own six writes (`MarkAsProcessed`, `MarkGroupAsProcessed`,
`MarkAllAsProcessed`, `DeleteNotifications`, `DeleteGroupNotifications`, `DeleteAllNotifications`),
done or refused, all three lists are forgotten and asked for when next wanted, where the client
changes its lists in place. An answer on its way when they are forgotten is handed on and not
kept. All of them from a later notification is another list, asked each time.

**The calendar's months and the contracts' login figures, 2026-10-09.** The client's calendar
service keeps a month's events once it has asked for them (`calendarProxy.GetEventList(month,
year)`, at the proxy node), for the session. Its minute timer asks for this month and the next
soon after a character is chosen (`GetEventsNextXMonths`): a recorded Tranquility login has the
two as calls 186 and 187. It works the server's `OnNewCalendarEvent`, `OnEditCalendarEvent` and
`OnRemoveCalendarEvent` into the months it keeps, puts a personal event of its own making into
them itself (the server does not tell a pilot of its own), and forgets every month when the
session's corporation or alliance changes. Its contracts service asks
`contractProxy.GetLoginInfo()` once, when the notification window is ready, to raise its own
notices of contracts that want attention, and keeps nothing of it.

On the game port the transport asks for the contracts' figures, then the notifications, then the
two months by the server's clock, as a pilot is chosen. The months are kept, and a read of a kept
month through the BFF is answered from what is kept; another month is asked for when first
wanted and kept. As with the notifications, the months are forgotten rather than changed in
place: at any of the three notices, after any of the pilot's own makings, changings and deletings
of an event (seven writes on `calendarMgr`), done or refused, and in another corporation or
alliance. The contracts' figures are asked for and not kept: the page's Contracts window asks
for them again each time it opens, which is the page's own way.

The notifications' lists and the calendar's months are kept by one helper,
`src/gamePort/keptReads.js`: answers kept until something changes them.

**What a container lists, 2026-10-09.** The client's inventory cache (`invCache.py`) asks a
container for a flag's items once: `invCacheContainer.List(flag)` sends `List(flag=flag)` only
for a flag it has not listed, and `ListByFlags` sends only the flags not yet listed. From then
on it goes by the server's `OnItemChange` and `OnItemsChanged`, working each changed item into
what it holds (`_ProcessItemChange`), and asks again for nothing. A whole mining mission
recorded on Tranquility has twelve `List` calls, one for each container and flag, and a
recording of one mining cycle has none.

On the game port the transport now keeps each listing as the server answered it, by the handle
it was asked on and what was asked, and forgets every listing when anything may have changed
one: at either notice, in another place or ship, and at any write of the pilot's own, done or
refused (`pilots.js`, `INVENTORY_LISTINGS`). What is forgotten is asked for when next wanted.
The gateway's listings are as they were.

What that changes is small, and was measured in the server's logs of two flights, one before
and one after:

| | Before | After |
|---|---|---|
| At a login, as the page's windows open | each of two containers listed two or three times at once | each listed once |
| After each of the server's notices of an item | two `List` and one `ListByFlags` | the same |
| With no notice | nothing but at a login, and twice at the pilot's own doing | nothing but at a login |

The page was not asking over and over, as the ledger's count had seemed to say: it reads the
holds again when the server says an item changed, and a mining laser's cycle is such a change.
The client asks nothing there. To match it the notices have to be worked into what is kept, as
its cache does, and that is not done.

**The object cache, for a service's method calls, 2026-10-09.** Where the server answers a
service's method with a `CachedMethodCallResult`, the client's object cache keeps the answer
(`objectCaching.py`). The result carries what the server says of the method's answers: a
`versionCheck`, and perhaps a `sessionInfo`. The first such word for a method holds for the run
(`CacheMethodCall`). The answer is kept by the service, the method, the session's value of
`sessionInfo` if there is one, and the arguments. A later call of the same finds it
(`PerformCachedMethodCall`) and asks `__ShouldVersionCheck`:

| `versionCheck` | The kept answer is used without asking |
|---|---|
| `never` | always |
| `run` (and no word) | for the rest of the run |
| a time (`5 minutes`, `1 hour`, ...: `__versionchecktimes__`), or a number of 100 ns | until it is that old, by its own stamp |
| `utcmidnight`, `utcmidnight_or_3hours` | until it is as old as is left to the first UTC midnight after the run began, or three hours if that is less |
| `always`, or None | never |

The client's log says "returning a cached result" where the cache answered outright, and
"returning a cached result that requires version checking" where it held an answer that was due
a check with the server. Across the Tranquility recordings the cache answered outright 978
times: `agentMgr.GetMessagesForEpicArcMissions` 800,
`fwWarzoneSolarsystem.GetAllWarzonesOccupationStates` 53, `beyonce.GetFormations` 43,
`shipKillCounter.GetItemKillCountPlayer` 34, `structureDirectory.GetStructureMapData` 17, and
nine more. (This paragraph first gave 61, 55 and 42 for three of these. That counted both kinds
of line as one. The checks are counted in the paragraph after this one.)
The server tells the client when an answer has changed by calling
`objectCaching.InvalidateCachedMethodCall(service, method, *args)` or
`InvalidateCachedMethodCalls` on it.

The game-port session opened such an answer and kept nothing of it: every call was sent. It now
keeps and answers as above (`session.js` `cachedMethodCall`), for a call by a service's name or
to the proxy's node, and forgets what the server names in either of its two calls. This server
marks some three dozen methods as cached. Read twice in one session, a docked pilot's routes cost
29 calls the second time before and 26 after: `account.GetEntryTypes`,
`marketProxy.GetCharOrders` and `marketProxy.GetMarketOrderHistory` were answered by the cache.

Not as the client does it:

- A bound object's cached answers are not kept.
- Some of what the client's own code names is not named here. The paragraph after the next has
  which.

(This list had the server naming several calls by a part of their arguments. The client's
object cache has a function for that, `__ListPartialMatch`, and nothing in the client calls it.)

**The object cache's check with the server, 2026-10-09.** When an answer held is due a check,
the client sends the call all the same, with the version it holds where every other call
carries a `1`: `machoVersion=[when, checksum]`, a list (`ServiceCallGPCS.py`
`RemoteServiceCallWithoutTheStars`). The server answers with a new `CachedMethodCallResult`,
which is kept in place of the old one, or with the exception `objectCaching.CacheOK`. Then the
copy held is the answer, and it is good from that moment (`UpdateVersionCheckPeriod`).

The version is `CachedMethodCallResult.GetVersion()`. An answer held inline has a version of
its own. An answer that is a reference to a cached object has none (`version=None`), and its
version is the object's.

Across the Tranquility recordings the client made 64 such checks and the server answered 61 of
them `CacheOK`:

| Service | Checks | Answered `CacheOK` |
|---|---|---|
| `shipKillCounter` | 27 | 25 |
| `structureDirectory` | 25 | 24 |
| `standingMgr` | 7 | 7 |
| `fwWarzoneSolarsystem` | 2 | 2 |
| `agentMgr` | 2 | 2 |
| `map` | 1 | 1 |

Tranquility answers so for a reference too. `fwWarzoneSolarsystem.GetAllWarzonesOccupationStates`
came first as a reference with no version of its own, good for a minute; its object's checksum
was 42023. The check went out with the object's stamp and 42023, and `CacheOK` came back. The
standings come with a version check of three words, the client's own first
(`('always', None, None)`), and are checked at every asking.

The game-port session now makes the check (`session.js` `_serviceCall`), and keeps no answer
it has no version for. Seen live, on a session whose clock the script moves:

| Call | Good for | Inside that time | Past it |
|---|---|---|---|
| `standingMgr.GetStandingCompositions`, held inline | 5 minutes | at 4 minutes, nothing sent | at 6, sent with the version; `CacheOK`; nothing sent after |
| `corporationSvc.GetAllCorpMedals`, a reference | 1 hour | at 59 minutes, nothing sent | at 61, sent with the object's version; `CacheOK`; nothing sent after |

The second row is so since a fix to EveJS (`eve.js` `342a366a6`). Before it the server
answered that check with a whole new answer of the same checksum: it compared against the
result's own version, and a reference has none.

The first build here made the same mistake from the other side. It read the result's own
version, and for a reference sent `[0, None]` at the very next asking. Every test passed, each
on an answer I had made up with a version of its own. Recording the frames again from the real
server showed it, and there is now a test on the server's own recorded bytes.

**What the client's own code names, 2026-10-09.** Some cached answers are good for the whole
run: this server answers a pilot's own market orders so (`versionCheck: run`, kept by
`charid`). What makes the client ask again is a name: the server calling
`InvalidateCachedMethodCall` on it, or the client's own code calling the same on its own cache.
The client's code does so at 62 places. They are of three kinds.

On a notice from the server:

| Notice | Calls named | Client |
|---|---|---|
| `OnOwnOrdersChanged(orders, reason, isCorp)` | `marketProxy`: `GetCharOrders`; for each order `GetOrders(typeID)` and `GetPlexOrders`; `GetSystemAsks`, `GetStationAsks`, `GetMarketOrderHistory`, `GetPlexBest` | `marketsvc.py` 113 |
| `OnCorporationMedalAdded` | `corporationSvc.GetAllCorpMedals(corpid)`, `GetRecipientsOfMedal(medalID)` | `medals.py` 120 |
| `OnMedalIssued`, `OnMedalStatusChanged` | `corporationSvc.GetMedalsReceived(charid)` | `medals.py` 131, 139 |
| `OnAssetSafetyCreated(ownerID, system, locationID)`, the corporation's | `corpmgr.GetAssetInventoryForLocation(corpid, locationID, 'offices')`, `structureAssetSafety.GetItemsInSafetyForCorp` | `assetSafetySvc.py` 58 |
| `OnAssetSafetyDelivered(ownerID)` | `structureAssetSafety.GetItemsInSafetyForCorp`, or for the pilot's own `GetItemsInSafetyForCharacter` | `assetSafetySvc.py` 65 |
| `OnStationInformationUpdated(stationID)` | `stationSvc.GetStation(stationID)` | `station/base.py` 589 |
| `OnKillNotification` | `charMgr.GetRecentShipKillsAndLosses(25, None)` | `charactersheet.py` 90 |
| `OnKillRightCreated`, `OnKillRightUsed`, `OnKillRightForYouSold` | `bountyProxy.GetMyKillRights` | `bountySvc.py` 154, 158, 171 |
| `OnEditCalendarEvent`, where the event's time changed | `calendarMgr.GetResponsesToEvent(eventID, ownerID)` | `eveCalendarsvc.py` 352 |
| `OnEventResponseByExternal(eventID, event, response)` | `calendarMgr.GetResponsesToEvent(eventID, the event's owner)` | `eveCalendarsvc.py` 409 |
| `OnNPCStandingChange` | `facWarMgr.GetMyCharacterRankInfo`, `GetMyCharacterRankOverview` | `facWarSvc.py` 308 |
| `OnCommunityFittingsUpdated` | `corpFittingMgr.GetCommunityFittings` | `fittingSvc.py` 1269 |
| `OnBrowserLockdownChange`, `OnFlaggedListsChange` | `browserLockdownSvc`'s three | `sites.py` 335, 442 |

On a change to the session: another corporation names
`corporationSvc.GetEmploymentRecord(charid)` (`base_corporation_ui.py` 98); in or out of a
militia names the two ranks above, `facWarMgr.GetCorpFactionalWarStatus` and the employment
record (`facWarSvc.py` 57, 199).

Beside one of its own calls, once the call is done:

| Call | Calls named | Client |
|---|---|---|
| `bountyProxy.AddToBounty(ownerID, amount)` | `charMgr.GetPublicInfo3(ownerID)` | `bountyWindow.py` 447, 1007 |
| `bountyProxy.SellKillRight`, `CancelSellKillRight` | `bountyProxy.GetMyKillRights` | `bountySvc.py` 255, 262 |
| `calendarMgr.SendEventResponse(eventID, ownerID, response)` | `calendarMgr.GetResponsesToEvent(eventID, ownerID)` | `eveCalendarsvc.py` 296 |
| `calendarMgr.UpdateEventParticipants(eventID, ...)` | `calendarMgr.GetResponsesToEvent(eventID, charid)` | `eveCalendarsvc.py` 196 |
| `structureAssetSafety.MoveSafetyWrapToStructure` | `GetStructuresICanDeliverTo`, `GetItemsInSafetyForCharacter`, `GetItemsInSafetyForCorp` | `assetSafetyDeliverWindow.py` 147 |

The transport forgot every cached answer at each of the pilot's own writes. It now names what
the tables name, when they name it (`cachedCallsNamed.js`), and a write names nothing else.
A row is a no-op where nothing is kept under the name, which on this server is most rows: of
the thirty or so methods it marks as cached, the rows reach the market's, the corporation's
medals, a station, and the corporation's assets and asset safety.

Seen live on the game port, as Test Pilot at Jita, with the server's log counted between steps
(the market's three cached calls: the type's book, the pilot's orders, the order history):

| Step | Before | After |
|---|---|---|
| The market read twice | all three sent, then none | the same |
| A buy order placed; the route reads the pilot's orders at once | sent, and the order is in it | the same: the notice had named it |
| The market read again | the book and the history sent | the same, each named by the notice |
| A write the client names nothing beside (`/giveitem`), and the market read again | all three sent | none sent |
| The order taken down | refused: see below | done; the pilot's orders sent, and the order gone from them |

Not named here, each for its reason:

- **Calls the BFF cannot make**: the mailing lists' members, joining and leaving a militia, a
  character's looks, an office let go and impounded items trashed, the access groups', the
  development indices'. A row for a call nothing makes would be dead.
- **Names that need an item's owner, flag and station**: items delivered to a corporation's
  hangar or to a member, a stack split and items trashed at another station
  (`invItemFunctions.py` 287).
- **Names given on a refusal**: a kill right that was not there, a donation whose tax changed.
- **Names that hang on what a window holds**, and the two a GM has.

**An order taken down or repriced, 2026-10-09.** The client has an order's ID off the order's
own row, a number: `CancelCharOrder(orderID, regionID)` and
`ModifyCharOrder(order.orderID, newPrice, order.bid, order.stationID, order.solarSystemID,
order.price, order.range, order.volRemaining, order.issueDate)` (`marketsvc.py` 281, 285). The
BFF's routes have the ID as the text the page sent. On the wire that was a string, this server
read it as order 0, and no order could be taken down on the game port. The registry now sends
the number.

The client has both calls' other arguments off the same row: the order is one of the pilot's
own orders, `GetCharOrders`, which its object cache keeps (`quote.py` 302 passes
`order.orderID, order.regionID`). The BFF's routes have no row, and sent nought for the region, a
bool for the side, where the pilot is for the station, and nought for the date of issue. The
server reads only the order and the new price, so both worked and neither was the client's
call. The transport now reads the row out of the pilot's orders the session keeps
(`pilots.js` `ownOrderOf`) and sends what the client sends, each value as it came off the wire.
Where the session keeps no orders it asks for them first, as the client has them before it
touches one. An order in no such list goes out as it came.

Made first as the client makes them, on a session of a script's own, to see the server take
them. The order's row off the wire, and the nine sent:

| Column | Off the wire | Sent to reprice |
|---|---|---|
| `orderID` | a long | first |
| the new price | | second |
| `bid` | 1 | third |
| `stationID`, `solarSystemID` | numbers | fourth, fifth |
| `price` | 0.01 | sixth |
| `range` | -1 | seventh |
| `volRemaining` | 1 | eighth |
| `issueDate` | a long | ninth |

The server answered None to each, the order's price was the new one, and its two notices said
"Modified" and "Cancelled".

Three more of the market's calls are in the registry. A type's book, `GetOrders(typeID)`, is
the client's as it stands. Its price history was not: the client asks two halves,
`GetOldPriceHistory` and `GetNewPriceHistory`, and the BFF's route asked the new one alone
(both since the paragraph below). A buy order was not: the client's ninth argument is the
broker's fee its window showed (`buyThisTypeWindow.py` 701), and the route sent none (worked
out since the fee's paragraph).

**A type's price history, 2026-10-09.** `marketsvc.GetPriceHistory` (333) asks
`GetOldPriceHistory(typeID)` and `GetNewPriceHistory(typeID)` and joins them with
`GetHistoryRowList` (344):

1. The old half's days, in order. Where the day after the last one taken is not the next
   day of the half, a row is put in for each day between, at the average of the day before,
   with 2 for the quantity and 2 for the orders.
2. The same from the last day of the old half up to yesterday's midnight.
3. The new half as it came; or, where it is empty, one row for now at the last average with
   nothing traded.

It counts from now, not from the first day, so nothing is filled in before the old half
begins. And the new half goes last whatever its days are. This server puts every day but the
last in the old half and the last alone in the new, and its history for Tritanium ends on 8
September: the client's join of that is the old half, a month of days filled in, and then the
new half's one day, out of order.

The BFF's Market read asks both halves and hands both on, and the page joins them so
(`market.ts` `joinPriceHistory`). A history's day is named by the game's calendar, which is
UTC.

**A sale, 2026-10-09.** `PlaceMultiSellOrder(itemList, useCorp, duration, expectedBrokersFee)`
(`marketsvc.py` 276, called at `sellMulti.py` 462). The list's items are each a `util.KeyVal`
the sale window makes with eight keywords (`sellMulti.py` 501):

| Keyword | What it is |
|---|---|
| `stationID`, `typeID` | whole numbers |
| `itemID` | the stack's |
| `price` | rounded to the hundredth |
| `quantity` | a whole number |
| `officeID` | None, or the office for an item in a corporation's hangar |
| `delta` | how far the price is from the type's average, as a fraction of it |
| `rawBrokerFeePercentage` | the broker's fee rate the window worked out for the station |

The fourth argument is that same fee rate for an order that stands, and None for a sale at
once.

The BFF's route gave an item as a plain object. The wire has no such value, and nothing could
be sold on the game port. The registry now makes each item the client's KeyVal. A route has no
`delta` and no fee rate. Both are worked out now, as the two paragraphs after this have it,
and the item goes out with all eight.

**A sale item's delta, 2026-10-09.** Each entry of the client's sale window asks the market
for its type's average price when it is made (`buySellItemContainerBase.py` 28), and the item
carries `(price - averagePrice) / averagePrice` (57). `marketsvc.GetAveragePrice(typeID)`
(368) is:

1. The type's price history, its two halves asked and joined (the paragraph on the history).
2. Of the rows no older than seven days: the sum of average times quantity, over the sum of
   quantity. The days the join filled in count, each with its 2.
3. With nothing traded in the week: the type's base price over its portion size, or 1.0 where
   that is nothing.
4. Rounded to the hundredth.

`priceHistory.js` has the join, the average and the delta, held to the client's own Python
over ten histories. On the game port a sale asks for the two halves for each item that has no
delta, in the client's order and before the sale, and the registry works the delta out. This
server's history for Tritanium ends a month ago, so its week is seven filled-in days at
100.00 and the average is 100.00.

**The broker's fee rate, 2026-10-09.** The client names it with an order: a buy order's ninth
argument (`buyThisTypeWindow.py` 701), a sale's fourth for an order that stands
(`sellMulti.py` 444) and each sale item's `rawBrokerFeePercentage`. The server works the rate
out for itself and refuses an order whose named rate is not its own
(`MktBrokersFeeUnexpected2`, which says the server's rate). For an NPC station
(`marketsvc.py` 161 `GetBrokersFeeCommissionFromStationID`):

| Step | Client |
|---|---|
| The base, 3 percent, less 0.3 of a percent for each level of Broker Relations in effect | `skilllimits.py` 25 |
| A tenth off for each level a warzone system is upgraded to | `facwarCommon.py` 200 |
| Less 0.0003 for each point of standing the owner's faction has to the pilot, and 0.0002 for each point the owner has | `brokerFee.py` 67 |

The level in effect is the larger of the level trained and the level lent
(`CharacterSkillEntry.effectiveSkillLevel`). A standing is the one the client's standing
service keeps of that NPC to the character, or nought (`standingsvc.py` 154). An owner that
is no NPC has none that counts (`marketsvc.py` 745). The buy window names the station's rate
whatever the order's length; the sale names it for an order that stands, and None for a sale
at once.

`brokerFee.js` has the sums in the client's order, and is held to the client's own Python to
the last digit. The transport works the rate out from the skills and standings it keeps and
the station's owner from the game's static data (`pilots.js` `brokersFeeAt`), and the registry
names it. Asked first, this server refused a buy order naming 0.5 and said its own rate was
2.96 percent; the rate worked out for that pilot and station is 0.0295803, and orders naming
it are taken.

Not done: a structure, whose base the client asks of the server
(`structureSettings.CharacterGetService`) and where no skill applies; and the upgrade level
of a warzone system, which the client asks of the war's manager. This server lowers its own
rate for neither.

The page shows the fee at that rate. The BFF's Market read says the rate for the station the
pilot is docked at (`brokersFeeRate`: a number on the game port, none through the gateway), and
the order form works the fee out as `BrokerFeeProvider.GetBrokerFeeInfo` does for a new order:
the order's value at the rate, and the smallest fee there is where that comes to no more. An
offer to buy 1000 Tritanium at 50 ISK showed 1,479.02 ISK, and the server charged 51,479.02:
the 50,000.00 set aside and that fee.

**A saved fitting applied, 2026-10-09.** `fittingSvc.LoadFitting` (554):

```
shipInv = invCache.GetInventoryFromId(activeShip)
shipInv.FitFitting(activeShip, shipTypeID, itemsToFit, session.stationid or session.structureid,
                   fittingObjKeyVal, cargoItemsByType, fitRigs)
```

| Argument | What it is |
|---|---|
| `shipTypeID` | the type of the ship's own item |
| `itemsToFit` | a `defaultdict(set)`: for each type the fitting wants, the hangar's items of it to take from |
| `fittingObjKeyVal` | `KeyVal(chargesByType, dronesByType, fightersByTypeID, iceByType, modulesByFlag, implantsByTypeID)`, six dicts (`shipfitting/fitting.py` 119) |
| `cargoItemsByType` | a dict: the rigs to put in the cargo where they are not to be fitted |

The call is made on the ship's own inventory, which the inventory cache asks the location's
manager for once and keeps (`invCache.py` 533).

How a `defaultdict` and a `set` go to the wire is in no recording. The client's own Python
reduces a `defaultdict` to a call of `collections.defaultdict` with `set`, its items after,
and a `set` to a call of `set` with a list. This server sends a set in that form and reads
that form of both. So here: an object made by `collections.defaultdict` whose dict part is
the types, each to an object made by `__builtin__.set` with a list of the items. The KeyVal's
fields go in the order `fightersByTypeID, dronesByType, modulesByFlag, iceByType, chargesByType,
implantsByTypeID`, which is the client's Python's for those six.

The BFF's route gave plain objects for the three, which the wire has no form for, and made
the call on the manager. No saved fitting could be applied on the game port. The registry
makes the three, the ship's type is godma's, and the transport makes the call on the ship's
inventory.

**A colony's commodities launched and moved, 2026-10-09.** Both on the planet's own object
(`clientPlanet.py` 412 and 448):

| Call | Arguments |
|---|---|
| `UserLaunchCommodities(commandPinID, commoditiesToLaunch)` | the command center's pin; a dict of the quantities to launch by type |
| `UserTransferCommodities(path, commodities)` | a list of pins, from the one the commodities leave to the one they reach; a dict of the quantities to move by type |

No recording has either on the wire: one note in the recordings' archive names the second, to
say the walk it describes did not use it. Both are from the client's source. The dicts are in
the order the client's Python keeps the types, which is not the order of their numbers (for
2073, 2268 and 9848 it is 9848, 2073, 2268).

The BFF's routes gave the commodities as a plain object, which the wire has no form for.
Nothing could be launched from a colony, or moved in one, on the game port. The registry makes
the dict, and the path a list. This server answers a move with two times (the colony's, and
when the pin the commodities left may send again: five minutes on) and a launch with one (when
it was made); it refuses a second launch inside a minute.

**A pilot's colonies and launches, 2026-10-09.** Both asked of the planet manager by name, with
nothing, and both recorded on Tranquility so:

| Call | Where the client makes it | What it keeps |
|---|---|---|
| `planetMgr.GetPlanetsForChar()` | `planetSvc.py` 67 | asked once; the client changes its own copy as a colony's pins change |
| `planetMgr.GetMyLaunchesDetails()` | `planetUISvc.py` 172 | asked once; asked again after `OnPILaunchesChange`, or when its window reloads |

**A planet's colony, 2026-10-10.** The client asks the planet's own object, and nothing else:

| Call | Where the client makes it | What it keeps |
|---|---|---|
| `GetPlanetInfo()` | `clientPlanet.py` 83, as the planet is first wanted | the colony, for as long as it has the planet; it reckons what the colony makes by itself, and asks again when the server says the planet's state changed (`OnMajorPlanetStateUpdate`) |
| `GetPlanetResourceInfo()` | `clientPlanet.py` 644, where it shows what a planet carries | |

Tranquility's recordings have the first riding the planet's bind: `MachoBindObject(planetID,
('GetPlanetInfo', (), {}))`. The answer is a KeyVal: the planet's own facts, and for a pilot
with a colony there its pins, links, routes, level and `currentSimTime`, the time the server
has reckoned the colony up to. This server reckons a colony up to now as it answers.

For a pilot on the game port the BFF's read of the pilot's colonies (`/api/bridge/planets`)
asks those, and makes the answers into the row its colony projection reads
(`src/planetInfoColony.js`): a pin's `id` is the row's `pinID`, and a time is a long where
the row has its digits. It was answered from the web gateway's snapshot of the store before,
on either transport, and still is for a pilot on the gateway.

The transport keeps a colony by its planet for a minute (`pilots.js`, `planetRead`), since
nothing here reckons a colony as the client does. It forgets every colony at
`OnMajorPlanetStateUpdate` and `OnRefreshPins`, and after the pilot's own change to a colony,
launch, moving of goods between pins, or sending of goods through a customs office. What a
planet carries it keeps.

The transport keeps both lists (`pilots.js`, `KEPT_UNTIL_CHANGED`). It forgets both at
`OnPILaunchesChange`, at `OnMajorPlanetStateUpdate`, after the pilot's own `DeleteLaunch`, and
after its `UserUpdateNetwork` on a planet's object, and asks for each when it is next wanted.
That asks for the colonies more often than the client does, which changes its own copy, and
never later.

The launches come as a `CRowset` whose row descriptor Tranquility sent as `launchID` int32,
`solarSystemID` int32, `itemID` int64, `ownerID` int32, `planetID` int32, `status` uint8,
`launchTime` a file time, and `x`, `y`, `z` doubles. The recordings have empty lists only, so no
launch's own numbers are known: the column's kind says a launch's ID fits 32 bits.

This server counted launches up from 910,000,000,000, which does not fit, and could not put a
list with a launch in it on the wire: the client was answered nothing. It counts from
910,000,000 since eve.js `c30983877` (2026-10-09), and gives a stored launch a new ID when it
reads the store.

What the client's journal does with a launch in its list (`journal.py` 436 to 465). No recording
has any of the three:

| The pilot's choice | The call |
|---|---|
| Warp to it, when it is further than the least a warp goes | `CmdWarpToStuff('launch', launchID)` on the ballpark's object: the launch's ID, not its container's, and no range |
| Approach it, when it is nearer | `CmdFollowBall(itemID, 50)`: the container's item, at 50 m |
| Remove it from the list | `planetMgr.DeleteLaunch(launchID)` by name, then the launches asked for afresh |

The page's haul warps to a launch the first way, through a route of its own
(`/api/bridge/flight/warp-launch`). The page's block was written to warp to the container as an
item, counting on this server to find an item anywhere in the system by its ID. That was never
seen to work or fail here: the list came back empty first. The client's journal names the
launch, so the page does now.

**The order of a KeyVal's fields on the wire.** `utillib.KeyVal(a=1, b=2)` keeps its keywords
as the instance's own dict, so its fields go out in that dict's order. That is not the order
written, and not the order a plain function's keywords are in. A class is not a plain
function: the interpreter collects the keywords off its stack, last one first, and the
class's `__init__` is given them from that dict (`py27.js` `constructorKeywordOrder`). The
client's own Python, asked for the sale's eight:

| Made by | Order |
|---|---|
| Written | `stationID, typeID, itemID, price, quantity, officeID, delta, rawBrokerFeePercentage` |
| A plain function's keywords | `itemID, typeID, rawBrokerFeePercentage, price, delta, stationID, officeID, quantity` |
| The KeyVal | `itemID, typeID, rawBrokerFeePercentage, price, officeID, stationID, delta, quantity` |
| The KeyVal of the six a route has | `itemID, typeID, price, stationID, officeID, quantity` |

The fixture of the client's Python has this for each of its 409 keyword sets
(`constructed`), and the model agrees with every one. The other KeyVals the registry makes (a
scanner's probes) have their fields in the order the registry lists them. Those are KeyVals the
server sent and the client changed, so their order is the one they came in, and that has not
been looked at.

**The formations, asked for once, 2026-10-09.** `michelle.AddBallpark` asks
`sm.RemoteSvc('beyonce').GetFormations()` each time it makes a ballpark (`michelle.py` 324). The
answer is a cached method call's, and the client's object cache answers every asking after the
first: a Tranquility recording of a flight through several systems has "ObjectCaching beyonce ::
GetFormations ( () ) returning a cached result" at each ballpark it adds. So the server is asked
once.

On the game port each ballpark asked the server for itself, and the BFF's own route asked again
each time the page wanted them: nine askings for four ballparks in one hour of this server's
log. Now the first asking is sent, counted in the ledger as the client's own, and kept for the
pilot; a ballpark made later, and the BFF's route, are answered from it. An asking that fails is
not kept. The gateway's route is as it was.

This is one cached method call kept by hand. The client's object cache does the same for every
call the server marks as cached, and the transport has no such cache of its own.

**An attribute's value, 2026-10-09.** The client never asks the server for an attribute's
value: its own dogma location answers (`baseDogmaLocation.GetAttributeValue`), from what
`GetAllInfo` brought and each change the server has told of since. The BFF asked the server
(`dogmaIM.QueryAttributeValue(itemID, 73)`) for a module's cycle each time a module that was
still running out its cycle was switched off: one call the client never makes, each time.

On the game port the transport now answers from what godma holds of the item
(`pilots.js` `attributeHeld`), priming godma first as the client's is primed, and asks the
server only for an item, or an attribute of one, that godma holds nothing of. What godma holds
is the server's own figure: for a fitted Venture and its three modules, all 195 attributes
`GetAllInfo` gave were what the server answered for the same items when asked attribute by
attribute, the afterburner's cycle of 8,500 ms among them.

**A whole stack moved, 2026-10-09.** The client adds an item to a container with
`Add(itemID, sourceLocationID, qty=quantity, flag=self.locationFlag)` (`invControllers.py` 213),
and the quantity is the stack's size when the whole stack moves (`_AddItem`: `quantity =
item.stacksize`, from the item its inventory cache holds). Of 22 `Add` calls read from the
recordings (the first three in each file that has any), 21 carry one, 3,822 for a hold of ore
among them; one carries `qty=None`, from a path not found. The BFF's three routes that move
one item (a move between places, cargo to and from the hangar, and the ore hold unloaded) send
no quantity for a whole stack.

On the game port the transport now fills it in, from the item's row in a listing the pilot
holds (the listings kept since the entry above): the row's stack size, or its quantity, and 1
for a thing that is one of a kind, whose quantity is below nothing. A quantity the caller gave
is the caller's. An item in no listing held goes as it came, and the ledger marks the call.
The route for a move between places lists the source before it moves, so the row is there; that
one was seen live. The other two go by what the page listed to show the item, if nothing has
been said to change since.

**A follow, an orbit, and the throttle, 2026-10-09.** The client's menu sends an approach as
`bp.CmdFollowBall(targetID, const.approachRange)`, keep at range as `bp.CmdFollowBall(targetID,
range)` and an orbit as `bp.CmdOrbit(targetID, range)` (`movementFunctions.py` 302, 229, 260),
each alone. Only its autopilot opens the throttle first: `park.CmdSetSpeedFraction(1.0)`, then
`park.CmdFollowBall(destinationID, 0.0)` (`autopilot.py` 434). The Tranquility recordings have
all four so: a mission's flight with a dozen follows and orbits and no speed call beside any, and
an autopilot's flight with the speed call before each follow of a gate. On this server a stopped
ship told to follow or orbit moves off without it: seen live for each, the ship's own ballpark
reading FOLLOW or ORBIT with its speed fraction at 1 again. (CCP's ballpark library sets a
stopped ball's fraction to 1 only for a go-to-point; for a follow it would be their server's own
code, which is not on this machine.)

The BFF's three routes sent the speed call before every one. On the game port they now send it
only before an approach with no range, which is the autopilot's and is what the page's own
autopilot asks for. Through the gateway they are as they were. `CmdOrbit` and `CmdStop()`
(`eveCommands.py` 1104) were read against the client in the same walk and are the client's as
the BFF sends them.

The client's menu sends nothing when the ship is already flying the order
(`_IsAlreadyFollowingBallAtRange`, `movementFunctions.py` 192): its own ball, in its own
ballpark, is in that mode, after that ball, at that range. The two recordings read for it agree:
the same follow goes out three times within one second, and not again while the ship is flying
it. On the game port the three routes now ask the pilot's transport, which
has the ship's own ballpark, and hold such an order back (`pilots.js` `alreadyFollowing`); the
route's answer then says `alreadySo`. The autopilot's approach is always sent, as the client's
autopilot does not look. Through the gateway every order is sent, as before.

One thing is held to more than the client holds it: the pilot's last order must have been this
one, or none. The client goes by its ballpark alone, which has not yet heard of a stop sent a
moment before. By its source it would hold back an approach sent straight behind a stop, and
the ship would be left stopped; that has not been seen in a recording. Here such an approach is
sent.

**What the ship has locked, and a module's target, 2026-10-09.** The client's target service
(`targetMgr.py`) asks the server for neither list while it flies. On undocking, or on logging in
in space, godma asks the dogma location once for each (`RefreshTargets`, godma.py 2360):
`GetTargets()` and `GetTargeters()`, after its own prime. A Tranquility recording of an undock has
exactly that: the bind of the dogma location carrying `GetAllInfo`, then the two calls on the
object, once each. From then on it goes by the server's `OnTarget(what, targetID, reason)`
('add', 'lost', 'clear', and 'otheradd' and 'otherlost' for what has the ship locked) and
`OnTargets`, a list of the same. It adds a target itself when `AddTarget` answers that the lock
is made already, and drops one whose ball leaves the ballpark. Docked, or with its ballpark let
go, it has none.

The page reads the locked targets about once a second, and on the game port each reading was a
`GetTargets` to the server: 395 of them in one short flight. The transport now keeps both lists
as the client does (`src/gamePort/pilotTargets.js`) and answers the BFF's readings from them. A
list that is not known is asked for, so a reading never answers from a guess. The gateway's
reading is as it was.

The client's module button gives an effect a target only when the effect is aimed at one
(`effectCategory` 2, shipmodulebutton.py 1318); an afterburner's goes out with None. The page
sends whatever is locked with every module it switches on, and the transport sent that on. It now
sends a target for a target effect alone.

Read against the client in the same walk, and the BFF's as the client's: `CmdFollowBall(targetID,
range)` (the menu's approach, `movementFunctions.py` 302; recorded as `(itemID, 50)`),
`CmdSetSpeedFraction(1.0)` (the autopilot's, before its approach), `Board(shipID, session.shipid
or session.stationid)` on the ship's moniker (recorded in space with the bind carrying it), and
`slash.SlashCmd(command)` by name. One thing was not the client's, and is repaired above: the
BFF's routes for the menu's approach, keep at range and orbit sent `CmdSetSpeedFraction(1.0)`
first, as the autopilot does, and the client's menu sends none.

**The flight's calls and the scanner's sites, 2026-10-09.** Read against the client after a walk
in space on the game port found them unread. The menu's warp is `bp.CmdWarpToStuff('item', itemID,
minRange=...)` on the ballpark's object (`michelle.py`, from `movementFunctions.py`); the
autopilot's is `CmdWarpToStuffAutopilot(destinationID)` (`autopilot.py`); docking is
`CmdDock(itemID, session.shipid)`, sent through `sessionMgr.PerformSessionChange('dock', ...)`.
The Tranquility recordings have each in that form (30, 3 and 24 files). `michelle` asks
`beyonce.GetFormations()` by name once, as it makes its park. The BFF sent all four as the client
does.

The sensor suite asks for the sites it can see with `scanSvc.GetScanMan().GetFullState()`: on the
system's scan manager, which is the object `scanMgr.GetSystemScanMgr()` answers, and so it is
recorded on Tranquility. The BFF's scanner route asked `scanMgr.GetFullState` by the service's
name. On the game port it now asks the scan manager's object, bound once for the pilot's system,
as the scanner's other calls already did. The gateway's route is as it was. Asked by name on the
game port (one route with no window behind it still does), the ledger says the call differs.

**Training paused, 2026-10-09.** The client's queue panel pauses with one call,
`skillHandler.AbortTraining()`, made only while a skill is in training (`skillQueuePanelNew.py`
`PauseTraining`, `skillsvc.py` `AbortTrain`). The server stops the skill and says so with
`OnServerSkillsChanged`, its event `OnSkillQueuePausedServer`: the client then takes the start and
the end off every entry of the queue it keeps, and keeps the entries. It does not ask for the
queue again, so an entry's starting points stay what they were when the queue was last saved; the
skill's own row has the points it stopped at. Its start button saves the queue as it stands,
`SaveNewQueue(queue, activate=True)`. One Tranquility recording has the pause and the save after.

The page's "Stop training" used to save an empty queue, which threw the queue away. It now pauses
as the client does (the BFF's `/api/bridge/skills/abort-training`, then the sheet read again), a
paused queue is shown as paused with its skills still on it, and "Start training" saves the queue
as it stands. On the game port the pause goes to the skill handler's object and the kept queue is
stopped by the server's notice. Measured on this server: a pause with nothing in training is
answered and changes nothing. The gateway's sheet marks a paused queue's first skill as in
training; the game port's marks none.

**The names of owners, 2026-10-09.** The client names a character, a corporation, an alliance or a
faction from `cfg.eveowners`. NPCs' owners are in its own built data. For any other it asks the
server, `config.GetMultiOwnersEx(a list of IDs)` by name (`carbon/common/script/sys/cfg.py`,
`Recordset._Prime`), for every owner it does not have yet, in one call, and keeps each row it is
answered, `(ownerID, ownerName, typeID, gender, ownerNameID)`. An owner it gets no row for it does
not ask about again. The call is in 29 of the Tranquility recordings. This server answers a row
for every ID asked about, with type nought and the name "Item <ID>" for what is no owner.

The BFF's names route answered a player's corporation or alliance from its static tables, which
did not have Test Two's, so the Character Sheet read "Unknown corporation". On the game port the
route now asks the transport for a corporation, alliance or character that the static tables
cannot name and whose ID is a player owner's (90,000,000 and up), and the transport asks as the
client does and keeps the rows (`ownersNamed` in `pilots.js`). A row names an owner only as the
kind of thing its type says it is, and a row of type nought names nothing. With no pilot online
the route says it does not know, so that the page asks again. On the gateway nothing changed.
The call is the transport's own: no route of the BFF's can ask it by name.

**At a customs office, 2026-10-09.** What the client's window sends (`importExportUI.py` 383 and
549), as Tranquility's recording of an export has it on the wire:

| Step | The call | Recorded |
|---|---|---|
| The office's inventory | `GetInventoryFromId(officeID, 0)` on the inventory manager for where the pilot is | on the manager's bound object, both positional |
| What it holds | `List(flag=4)`, `GetSelfInvItem()`, `List(flag=None)`, `List(flag=0)` on the office's inventory | in that order, before the transfer |
| Its tax rate | `eveMoniker.GetPlanetOrbitalRegistry(session.solarsystemid).GetTaxRate(officeID)` | `MachoResolveObject(systemID)`, then `MachoBindObject(systemID, ('GetTaxRate', (officeID,), {}))`: a Moniker made for the call, three times in one export |
| The transfer | `ImportExportWithPlanet(spaceportPinID, importData, exportData, taxRate)` on the office's inventory | `(pinID, {}, {2398: 100.0}, 0.20000000149011612)`, all positional |

What comes down is a dict of quantities by the item in the office, what goes up a dict of
quantities by type, and the rate is the one the registry answered. Tranquility's quantity is a
float because its colony's pins hold floats. This server's pins hold whole numbers, so a client
of it sends whole numbers. A note beside that recording reads the second argument of
`GetInventoryFromId` as 8: the byte is ``, which is the marshal's code for the integer
nought.

The BFF has a route that makes the rate's call and the transfer on the pilot's own session
(`/api/bridge/planet/customs/export`), in space only, as the window is. The game port carries
the transfer and the web gateway's list has not got it, so the transport has a short list of
its own beside the gateway's (`GAME_PORT_ONLY_CALLS`). Through the gateway the route is
refused.

The page's haul uses that route for a pilot on the game port: its collecting block sends a
colony's launchpads up when the ship is at that planet's office, one launchpad at a time, and
then empties the office. Which planet an office is, the client reads off the office's slim
item (`customsOfficeItem.planetID`, `importExportUI.py` 94), and so does the page: the game
port's snapshot passes it on for an orbital. The web gateway's snapshot does not say it.

Not the client's yet:

- For a pilot on the gateway the launchpads are still sent up before the bot starts, docked,
  through `src/piCustomsExport.js`, which logs a second game-port client in for it, asks the
  rate by the service's name, and binds `invbroker` with the office's ID. This server takes
  both.
- The page reads an office as it reads any container, with one `List`, not the window's four
  reads. And the collecting block reads every office in the system on every tick, where the
  client reads an office when its window is opened and goes by the server's word of each item
  after.

**Where the client can open that window from.** Wherever the ballpark has the office's slim
item: the window wants nothing else (`importExportUI.py` 90). This server's ballpark has every
office of the system from the undock on: its own recording of one has eight. It is opened from the office's own menu in space
(`menusvc.py` 1806), from the Planets window's list of colonies (`coloniesPanel.py` 206), and
from a launchpad in the planet's view (`LaunchpadContainer.py` 29). The recording's pilot was
at the office. I wrote on 2026-10-09 that the client makes the transfer at the office: that is
what the recording has, not what the client requires. Whether Tranquility's server takes the
transfer from across the system is in no recording.

**A station's guests and its own item, 2026-10-10.** The client's station service keeps both
(`eve/client/script/ui/station/base.py`):

| Call | When the client makes it | What it keeps |
|---|---|---|
| `station.GetGuests()` | 103, while it has no list, or the list it has is another station's | the guests by character; `OnCharNowInStation` adds one who is not a guest yet (86), `OnCharNoLongerInStation` takes one out (93) |
| `stationSvc.GetStationItemBits()` | 575, while it has no item, or the item's ID is not the station the session is in | the item: owner, station, operation, the station's type |

It lets both go when the session leaves the station. Tranquility's recordings have each call
with nothing beside it. The guests come as a list of `[charID, corpID, allianceID,
warFactionID]`, with None where a pilot has no alliance or no war faction; each notice carries
one guest's four in the same form; the item comes as a tuple. (This server sent a guest's four as a
tuple, in the answer and in the notices, until 2026-10-13, `eve.js` `d31b58021`. The page on the gateway
reads either.)

The transport keeps both the same way (`src/gamePort/pilotStation.js`; `stationRead` in
`pilots.js`), for a read asked with nothing beside it. An answer that is no list is handed on
and not kept. The page reads the guests again at either notice, and is answered from what is
kept.

This server keeps, for each docked pilot, which guests it has told that pilot of
(`server/src/services/_shared/guestLists.js`): the answer to `GetGuests` sets it, and an
arrival is sent only for a pilot not in it. So a list asked for once and changed by the
notices stays the list the server holds.

**A corporation's offices, 2026-10-10.** The client's office manager keeps two lists
(`eve/client/script/ui/services/corporation/officeManager.py`):

| Call | When the client makes it | What lets it go |
|---|---|---|
| `officeManager.GetMyCorporationsOffices()`, by name | 41, while it has none | `OnOfficeRentalChange(corporationID, officeID)` where the corporation is the session's (72); the session's corporation changing (62) |
| `GetCorporationsWithOffices()`, on `Moniker('officeManager', stationID)` | 34, while it has none | any `OnOfficeRentalChange` (71); the session's station or structure changing (58, 66) |

It asks the rest on the station's object each time: `PrimeOfficeItem()` (108),
`GetPriceQuote(corpid)` (114), `RentOffice(cost)` (117), `UnrentOffice()` (122),
`GetEmptyOfficeCount()` (136), `HasCorpImpoundedItems()` (143). It lets nothing go at its own
renting: the server's notice does that.

Tranquility's recordings of an office rented and of one given up have the notice twice, once
addressed by `stationid` and once by `corpid`. After it the client asks for its corporation's
offices once, and on the station's object for `PrimeOfficeItem` (after renting) or
`HasCorpImpoundedItems` (after giving up), `GetCorporationsWithOffices` and
`GetEmptyOfficeCount`. An office's row has eleven values, the station the second and the
office the ninth.

The transport keeps the first list the same way (`pilots.js`, `KEPT_UNTIL_CHANGED`): let go at
the notice where it names the session's corporation, and in another corporation.

**The lobby's offices, 2026-10-10.** The station's object is bound as Tranquility's recordings
have it (`Receiving Corp Roles.txt`): `officeManager.MachoResolveObject(stationID)` for the
node, then `MachoBindObject(stationID, (first call))` there, the ID bare. The client keeps the
Moniker while the session is docked there. On it, as recorded:

| Call | Answer on Tranquility |
|---|---|
| `GetCorporationsWithOffices()` | a `__builtin__.set` of corporation IDs (16, then 17 with the office rented) |
| `GetEmptyOfficeCount()` | a whole number (8) |
| `HasCorpImpoundedItems()` | False |
| `PrimeOfficeItem()` | None |

The lobby's Offices tab (`dockedUI/offices.py`) asks the first two when it is shown, and again
at each `OnOfficeRentalChanged`, whoever's the office; it does not load again while it is
loading, and the recordings have the notice twice with the two reads once. In a structure it
asks for no count (`officeManager.py` 133).

The transport binds the same Moniker for where the pilot is docked, keeps the corporations
until any `OnOfficeRentalChange` or the pilot is elsewhere (`pilots.js`, `stationOffices`), and
asks for the count each time. The BFF's `GET /api/bridge/station/offices` hands both to the
page for a pilot on the game port; the gateway's list has neither read. The page lists them
when the player asks and at each notice after, one listing at a time.

**The lobby's buttons, 2026-10-10.** `dockedUI/offices.py` loads its buttons before its list
(`_load_buttons`), by three things:

| What | How the client knows | What it asks |
|---|---|---|
| may rent; may give up | `session.corprole & role == role` (`baseController.py` 50): `corpRoleCanRentOffice` (2^49) to rent, `corpRoleDirector` (1) to give up | nothing |
| the corporation has an office here | `officeManager.GetCorpOfficeAtLocation()` (99): its kept list of the corporation's offices | `PrimeOfficeItem()` once for the station's Moniker, where it has one (106) |
| items impounded | `HasCorpImpoundedItemsAtStation()` (138): no for an NPC corporation, no with an office here | else `HasCorpImpoundedItems()` |

To rent (`_rent_office`): `GetPriceQuote(session.corpid)` on the station's object, a question
with the price and thirty days (`appConst.rentalPeriodOffice`), then `RentOffice(cost)` with
the price as it was answered. To give up (`_unrent_office`): a question, with a warning where
the office's hangars hold anything, then `UnrentOffice()`, the client first naming
`corpmgr.GetAssetInventoryForLocation(corpid, stationID, 'offices')` for its object cache.
Tranquility's recordings have the price answered as a long (100113), and both `RentOffice` and
`UnrentOffice` answered None, each after the server's two notices of the office. After the
notices the lobby asks, in order: the corporation's offices, `PrimeOfficeItem` or
`HasCorpImpoundedItems`, the corporations with offices, the count free.

On the game port the BFF asks the same, in that order (`GET /api/bridge/station/offices`,
`GET .../office/quote`, `POST .../office/rent`, `POST .../office/give-up`), in a station. The
roles come to it with the transport's flight status (`corpRole`, the digits of
`session.corprole`) and go no further. Not built: an office in a structure, the headquarters
moved, impounded items released (`GetImpoundReleasePrice`, `GetItemsFromImpound`).

This server answered `RentOffice` True and its price as a plain number until 2026-10-13. It answers a rent
None (False where nothing was rented, which no recording has), and the price a long (`eve.js` `f89da41c0`,
`75b222d73`); and its notice of an office goes by `stationid` to the sessions docked where the office is and by
`corpid` to the corporation's, the office's ID a long (`215874210`, `4f0cf3057`), where both went to every
session. The client uses neither answer for anything but the price's value.

The client's own bytes of the two calls are in the recording, after each method's name: `GetPriceQuote`'s
`25 04 50 26 e4 05` (a tuple of one, the corporation an int of 32 bits) and `RentOffice`'s `25 2f 03 11 87 01`
(a tuple of one, the price a Python long: the object it was answered, handed back). The game port's rent
carries a long too since 2026-10-13 (`00cc731a`): the page is handed the price with its long kept
(`{type: "long", value}`; `pilots.js`, `HANDED_BACK_AS_ANSWERED`) and hands back what it was handed. Seen with
the recorder between the BFF and this server: `25 04 80 5c d7 05`, then `25 2f 02 10 27`. Until then a price
that a number holds went to the page a number, and came back an int.

**The lobby at a docked login, 2026-10-10.** The server's log of a retail client logging in
docked in a station, with nothing opened, has four reads that the log of one logging in in
space has none of: `officeManager.GetMyCorporationsOffices`, `stationSvc.GetStationItemBits`,
`station.GetGuests` and `map.GetStationInfo` (with the `objectCaching.GetCachableObject` behind
it), in that order among themselves. The transport asks them as a character is chosen in a
station (`pilots.js`, `lobbyRead`), and the item and the guests again as a pilot docks, where
the client's are another station's or let go; the other two the client has still. Each is
kept as its own service keeps it. Tranquility's recording of a login in a structure has the
corporation's offices asked too; the transport asks nothing there until a route does.

The same login's inventory, which the transport does not ask for by itself (Tranquility's
`Logging in then renaming ship.txt`, in order): `invbroker.MachoBindObject((stationID, 15),
('GetInventoryFromId', (shipID, 1), {}))`; on the manager, `GetInventoryFromId(charID, 1)`,
and `GetSelfInvItem()` on what it answers; on the ship's inventory,
`GetAvailableTurretSlots()` and `GetSelfInvItem()`; `invbroker.GetItemDescriptor()` by name; a
second bind carrying `GetInventory(10004, None)`; on the hangar, `List(flag=4)` and
`GetSelfInvItem()`; on the ship's inventory, `List(flag=156)`, the hidden modifiers, which the
ship's stance buttons list among others (`shipstance.py` 27). `GetAvailableTurretSlots` has
three callers, the achievements' and the tutorial's (`achievements/client/eventHandler.py`
427). Which caller asked each at the login is not in the recording.

**Crimewatch, 2026-10-10.** The client's crimewatch service
(`eve/client/script/ui/services/crimewatchSvc.py`) asks on a Moniker made for each call
(`eveMoniker.CharGetCrimewatchLocation()`, bound by where the pilot is, the call riding the
bind):

| Call | When the client makes it | What it keeps |
|---|---|---|
| `GetClientStates()` | `ProcessSessionChange` (94): the change has `locationid` or `charid` in it | the five combat timers, the engagements, who is flagged; each then changed by its own notice (222 to 288) |
| `GetClientStates()` | `OnSessionChanged` (116): the pilot is in space and the change has `solarsystemid` or `shipid` in it | the safety level; then what the pilot sets (342) |
| `GetMySecurityStatus()` | 590, while it has none | the status; then what `OnSecurityStatusUpdate` says (598) |

By those rules: once at a docked login, twice at a login in space, twice at an undock or a
jump, once at a docking, once at a change of ship in space; the status once. The server's logs
of a retail client logging in docked and in space have the first two counts, and a walk on
the game port the undock's and the docking's. Tranquility's recording has the answer: `((weapons, pvp, npc, criminal, disapproval), engagements, (criminals, suspects),
safetyLevel)`, each timer a `(state, expiry)`.

The transport asks at the same moments (`pilots.js`, `clientStatesAtAChange`,
`securityStatusRead`). It keeps the states as last answered, and works each of the eleven
notices into them as the client's service does, with nothing asked after one. The pilot's own
`SetSafetyLevel` it works in as well (both below). The security status it keeps as the client
does.

A timer's state is its kind's idle state (weapons 100, PvP 200, criminal 300, NPC 400,
disapproval 500), one above while its cause goes on, two above while it counts down to its
expiry, three and more where it is inherited (`crimewatch/const.py`); the criminal's odd
states are the criminal's and its even ones the suspect's. The safety level is 0, 1 or 2:
none, partial, full. The page reads the states through `GET /api/bridge/crimewatch`, at the
same moments, and its workspace header says the safety level in space and every running timer
anywhere, in words, counted to the server's clock (`web/src/space/crimewatch.ts`).

**The safety level set, 2026-10-10.** No recording has `SetSafetyLevel`; this is the code's.
`crimewatchSvc.SetSafetyLevel(level)` (342) sends the one level on crimewatch's Moniker, then
has it as the level and tells the HUD's button; it asks nothing after, and a refusal is raised
before the line that keeps it. The button (`shipSafetyButton.py`) opens a selector of None,
Partial and Full. A level lower than the one now gets a confirm button beside it, and no other
button answers until that is pressed or gone; any other is set at once. Two things lock
buttons. The level is held at Full (`IsSafetyLockedToFullLevel`, 148) in space in a system of
the safest class of security (0.95 and above, `eveuniverse/security.py`) and while a
structure is controlled in high security: then Full is the level whatever the server said
(`_UpdateSafetyLevel`), and the two others are locked. And None is locked for an alpha clone
in high security (`IsSafetyAlphaLocked`).

| | The client | Here |
|---|---|---|
| The call | `SetSafetyLevel(level)`, on a Moniker made for it | the same (`POST /api/bridge/safety/set-level`; what is not 0, 1 or 2 is refused) |
| After it | the level set is the level; nothing asked | the same: the transport puts it in the fourth place of the states it keeps, and the page into what it last read |
| A lower level | a second press, on a confirm button | the same, with a Cancel beside it |
| Held at Full in the safest class | Full shown, the others locked | the same, by the map's security for the system |
| Held at Full controlling a structure | yes | not done: the page controls none |
| None locked for an alpha clone | yes | the same, by the clone's grade asked at login (below); a gateway pilot has no grade here and is locked out of nothing by it |

No system of this server's data is at 0.95 or above (the highest is 0.949794), so the level
held at Full has been seen in tests only. Whether the client's own table of systems
(`res:/staticdata/systems.static`, which is where its `cfg.mapSystemCache` is from) has any
was not read.

**The clone's grade, 2026-10-10.** `gameui.OnSessionChanged` (449), with `userid` in the
change, primes the client's clone grade service: `sm.RemoteSvc('subscriptionMgr')
.GetCloneGrade()`, by the service's name and with nothing (`omega/client/clone_grade_svc.py`
125). The answer is 0, an alpha clone's, or 1, an omega's (`clonegrade/const.py`). It is
kept and asked again only where there is none (113); `OnSubscriptionChangedServer(new_state)`
is the grade from then on (243). No recording has the call (they begin after the login); this
server's log of a retail client's login has it as the call before
`charUnboundMgr.GetCharacterSelectionData`.

The transport asks it there, on each pilot's own connection, keeps it, and takes the notice's
word (`pilots.js`, `cloneGradeRead`). The web gateway's list has no call of the subscription
manager's: the pair is on the game port's own list, and a gateway pilot has no grade. The page
reads `GET /api/bridge/clone-grade` once as a pilot comes online and keeps it
(`store.station.cloneGrade`). What goes by it so far is the safety selector's None button.
This server sent no `OnSubscriptionChangedServer` until 2026-10-13. It sends it now, by
`clientID`, to each of an account's sessions when Omega days bought in the store change the
account's grade (`eve.js` `6ad3fcf68`). The notice is in no recording: its address is its
recorded sibling's. The sibling is `OnSubscriptionTimeUpdateServer(omegaTime)`, which
Tranquility sends by `clientID` as the first thing of every
`charUnboundMgr.SelectCharacterID`, ahead of the session change and ahead of the error of a
selection its node turns away (seven in four recorded logins). It carries the end of the
account's Omega time, a long, and the character sheet's PLEX panel reads it
(`charsheet/plexPanel.py` 160). This server sends it there too (`eve.js` `6fac42e03`), None
for an Alpha, and again when days are bought. Both are sent, too, when an account's Omega
time runs out under a client that is online: the end time as None, then an Alpha's grade
(`eve.js` `4413af1a1`: a watch is kept on the end from every telling of a subscription). The
client then asks the grade again of itself and opens its lapse window
(`clone_grade_fanfare_ui_controller.py` 59); the transport takes the notice's word, and the
page shows nothing of the change. The page has no reader of the end time. For a
check, the server answers an alpha's grade when started with `EVE_CLONE_GRADE=alpha`, and
makes Alphas of the accounts that have bought nothing when started with
`EVEJS_OMEGA_LICENSE=false`.

**A selection's packets, 2026-10-13.** What the server sends between
`charUnboundMgr.SelectCharacterID` and its answer, in the four recorded logins and here. The
client asks `dogmaIM`'s `GetAllInfo` as soon as it has read the session change, before the
selection's answer.

| Packet, in its order | On Tranquility | What the client does | This server |
|---|---|---|---|
| `OnSubscriptionTimeUpdateServer` by `clientID` | every selection, first; a selection its node turns away too | the PLEX panel's days left | the same (`eve.js` `6fac42e03`) |
| `OnMultiEvent` by `clientID` (3,966 bytes) | one login of the four, the one docked in a station: module attribute changes of the ship and its fitted items from their types' values towards their modified ones, some in steps, and `OnGodmaShipEffect`s of the online effect | drops it: `godma.OnModuleAttributeChange_` returns where `session.charid` is None (1324), and it scattered `OnAttributes` with nothing, four times | not sent: the trail of Tranquility's own dogma loading a ship |
| the session change | | | |
| `OnTaleData` by `charid`: `(solarSystemID, {taleID: KeyVal(templateClassID, locationID, taleID)})` | after 19 of the 20 recorded session changes of `solarsystemid2` (logins and jumps), two to six packets later, one to six tales; none at the login in Jita, and none empty | the tale service keeps a tale that has an `objectiveChainID` (the recorded have none); the incursion service acts on an incursion's class (the recorded are class 3) | the same, for the four systems it knows tales of (`eve.js` `9da9aa017`); a call of `taleMgr` sends none (`e4700d089`), as Tranquility's one recorded call sends none |
| `OnServerSkillsChanged` by `charid` | none at a login (four in all the recordings, elsewhere) | refreshes its skills | sent after the session change: this server's own priming of the client's skills (`c6ea2ff44`) |
| the call's answer, None | | | |

Neither the transport nor the page reads the tales or the end of the Omega time. `OnTaleData`
is also sent to a system (by `solarsystemid2`, 17 times, one tale each) far from any session
change: a tale of the system's own, which this server does not send.

**A missile in the client, 2026-10-13.** The client's missile object (`spaceObject/missile.py`) reckons its
time to its target once, as it is prepared (`_GetTimeToTarget`, 144 to 154: under 1.6 seconds it does not spread),
and flies its warhead by that time. It is "collided" at once where it does not spread (`Prepare`, 188), and
otherwise when destiny's ball touches the ball it follows (`DoCollision`, 208: the model is then put on a ball of
the client's own, and the warhead flies on to its explosion whatever becomes of the server's ball). `Release`
(243) clears the model only of a missile that has not collided and is removed with an explosion; a removal with no
explosion clears nothing. Tranquility removes every missile with `TerminalPlayDestructionEffect(missile, None)`
(None is an explosion to `michelle.py`, 1205), so there the ball has touched by the removal's stamp. An entry
stamped R is applied before the park's step from R: a ball that touched in the step from t has collided by the
time an entry stamped t + 1 is applied.

This server gives a client stamps two more than its raw dispatch stamp, for a launch and for a removal alike
(recorded, 2026-10-13). A client's park keeps the server's own stamps (the pilot's ship in the park is within a
metre of the server's, stamp for stamp), so such an entry is applied two seconds after it is sent: the client's
missile is launched two seconds after the server's, from where the launcher's ball is then. It removes a missile from afar late and with no entry, which `Release`'s rule makes safe.
Since `eve.js` `6117e48fe` it also keeps the ball a client's park makes of each missile and knows the step that ball
touches in, to a step (`scripts/missiles-in-park.js` measures a recording of it).

**When an entry is applied, 2026-10-13.** `michelle.py` sorts what arrives into a history by stamp (`FlushState`,
1098 to 1140) and looks at it before each tick (`DoPreTick`, 900 to 917): an entry one or two past the park's
tick is left until then; one at the tick or before is applied at once, the park first taken back to a kept state
of that tick or an earlier one (`SynchroniseToSimulationTime`, 1074 to 1096; with no such state a new whole state
is asked for); one three or more past makes the park step forward to it at once. Each entry is logged as it is
applied ("Action: <name> <stamp> - current: <tick>", `RealFlushState`, 1163), so those two numbers are the same;
the lead as an update arrived is in the dump of the history written then ("------ History Dump <tick>", after
"DoDestinyUpdate call for tick <stamp>"). Over the 46 of Tranquility's recordings that have those dumps, an
update's stamp less the park's tick as it arrived was -1 for 77, 0 for 3,597 and +1 for 2,529, and never 2.

This server stamps what it sends one or two after its own stamp (a whole state one; a missile's launch and removal
two; an NPC's follow and orbit orders one since `eve.js` `3378afe85`, where its delivery does not raise them), and
its delivery was seen to raise an NPC's order to the stamp it had last sent the session. The client's history takes
an entry under one it has not yet applied: it is sorted in.

A client's park and a server's agree on a tick's number and never on when in the second it falls: the client's
ticks are a whole second apart from its own first (`Ballpark.cpp` `OnTick`; `docs/game-port-destiny-notes.md`
3.2), and a stamp in CCP's library is the server park's own count of ticks. This server's stamps are the clock's
seconds. Its first whole state is stamped the second after the one it is built in, with its moving balls where
the scene will have them as that second begins (since `eve.js` `23459f2b3`; before, where they stood as it was
built). Its movement is authored once a second, on the clock's second (since `eve.js` `ba3422279`; before, a scene
with no pilot in it that woke began its seconds where the waking fell: 0.36, 0.60 and 0.86 s in, measured
2026-10-13).

A park is not at one tick a second. Before each tick it applies what is due, and while more than one later stamp is
still queued it steps once more and looks again (`DoPreTick`, 912 to 915); an entry behind its tick takes it back to
that tick, where it stays, and with no kept state at or before that tick it asks for the whole state again
(`SynchroniseToSimulationTime`, 1076 to 1088). Its ticks begin when the client makes it (`AddBallpark`, 315 to 333,
starts it before any state has come); a whole state sets the tick's number, not when in the second it falls. On this
server, whose stamps for one moment are spread from its own to four past it, a park stood 0 to 3 ticks ahead of the
server's stamp in six recordings, went back 11 times and stepped three ticks forward at once twice, and asked for a
new state in none (`scripts/park-tick-against-stamps.js`). On Tranquility an entry arrives none or one ahead.
Tranquility sends a ship that lies still nothing (5 `SetBallPosition` in its 46 recordings, none periodic); this
server sent each one its own place again every five seconds until `eve.js` `37e38b889`.
`OnDamageStateChange` is applied in its turn without the park being moved to its stamp (`michelle.py` 1165), but it
is held until its stamp and is a stamp in the queue, so it counts for the park's extra step (912 to 915). On
Tranquility a damage state carries the stamp of the missile's removal for 485 of 507.
A whole state sets the park's time to its stamp and each ball to the place written in it (`michelle.py` `SetState`,
968 to 975; CCP's `destiny/src/Thunkers.cpp` `Ballpark::ReadFullStateFromStream`, 2463 to 2469), and entries
stamped before it are thrown away (`FlushState`, 1103 to 1111). This server reads its clock as it builds a state
and again as it sends it; since `eve.js` `869ee9c0f` the first whole state's balls are those of the stamp it is
sent with. So, since `689de3af3`, are those of a whole state sent again in mid-session (the answer to
`UpdateStateRequest`, which the client asks when it has lost its place: michelle's `RequestReset`); until then each
moving ball in it was written as it stood, its travel to the state's stamp behind.
A ship's massive flag. The client's own simulation clears it as real warp begins and sets it at dropout (CCP's
`destiny/src/Ballpark.cpp`, 4160 to 4162 and 4330 to 4332), clears it at a cloak and sets it at an uncloak out of
warp (5250, 5276); the browser's park does the same (`src/gamePort/destiny/ballpark.js`). Tranquility sends the
pilot's own ship `SetBallMassive(ship, 0)` with the undock, `1` with the first command after it and `0` with the
`Stop` of a docking, and none at any other `WarpTo` (28 recordings: 27, 26, 28, and 54 `WarpTo` with none). This
server writes a ship's ball non-massive and sends `SetBallMassive(ship, 0)` twice after each dropout: it has no
collisions for ships.
A ball's first order. The client sorts what it is sent into its history by stamp and applies it in that order as
the park reaches each stamp, whenever it arrived (`michelle.py` `FlushState`, 1098 to 1140; `DoPreTick`, 900 to
917): an order stamped after a ball's `AddBalls2` needs no wait. Tranquility adds a ball already in its mode (477
of 2,621 balls that are not rigid are added in orbit, in 46 recordings) and stamps the first order naming it the
`AddBalls2`'s own stamp (189 of 283), or one to three ticks after (6). This server held a new ball's movement
three ticks past the acquisition until `eve.js` `3c96302d8`.
The mission tracker (`missions/client/missionObjectivesTracker.py`). For each mission of the journal that the pilot
has accepted and that has not run out, in the order of their running out (52 to 82), the client asks
`sm.RemoteSvc('missionTrackerMgr').GetMissionInfoItems(agentID)` (275), one after another: at every change of the
session once a character is on it (89 to 94, 213), as each warp ends (84 to 87), and when the server says a mission's
objectives are done or failed (180 to 186). With none accepted it asks nothing. Tranquility's recordings have it in
24, three at a time for a pilot on three missions. The game port asks it so since `40c02295`, taking a warp's end
from the pilot's ball leaving warp; nothing is kept of the answer yet. Not asked yet: `UpdateAllMissions`,
`GetAllMissionObjectives`, `IsInActiveDungeonID`. The last is the info panel's: the mission's objective as it is
drawn asks it (`missions/client/ui/missionObjectiveData.py` 169, 233, 292), right behind `GetMissionInfoItems` at a
change of ship in the recordings.
The achievements' event handler (`achievements/client/eventHandler.py`). At a change of the session with the ship
in it and the new ship not `None` (251 to 260) it takes godma's item of the session's ship and, where that is of the
ship category, asks `invCache.GetInventoryFromId(shipID).GetAvailableTurretSlots()` (419 to 429); a capsule is a
ship. The client's godma has primed by then, at the session's change. Tranquility's recordings have the call in 20.
The game port asks it since `873de6dd`, owed from the change and made as godma is next primed, which here is when
something first wants the ship's readings.
Godma's priming (`eve/client/script/environment/godma.py`). With a character on the session, at any change of the
station, the solar system, the ship, the character or the structure, godma lets go its inventories, primes
(`GetAllInfo(character, ship, structure)`, `Prime` 2399 to 2410) and binds its dogma location afresh
(`ProcessSessionChange` 1154 to 1200). The game port primes when something first wants the ship's readings: read
2026-10-13 and left so (the log's entry of that day has why).
At a change of ship the recordings also have `GetSelfInvItem` and `List(flag=5)` on the ships' inventories, and
`shipCosmeticsMgr.GetEnabledCosmetics(shipID)`. The first two are an inventory controller's
(`environment/invControllers.py` 95 to 110, 134 to 138), made by the inventory window's tree
(`ui/services/inventorysvc.py` 325) and other windows; the third a drawn ship's (the fitting window's scene, the
hangar's). No service was found that asks them at a change: a page with no such window and no hull asks none.
The jump timers (`eve/client/script/ui/services/crimewatchSvc.py` 605 to 612). `GetJumpTimers` asks
`sm.RemoteSvc('jumpTimers').GetTimers(session.charid)` while it has none and keeps what answers: the jump
activation's end, the jump fatigue's end and when they were last reckoned, each a time or `None` (three `None`s are
kept as any answer). `OnJumpTimersUpdated(*args)` replaces what is kept. What is kept is let go as the service
starts and at a reset of the session, and at no change of place. The timer panel reads them as it is made, at a
login docked or in space (`ui/crimewatch/crimewatchTimers.py` 335, 355), and draws the fatigue's and the
activation's timers from them (456 to 466). Tranquility's four recordings of a login each have the one call,
answered `(None, None, None)`. The game port asks it since `501c5a84`, at the choosing behind the pilot's security
status, and keeps it so; no page shows the timers yet.
The wars (`eve/client/script/ui/services/wars/war_cso.py`). The war registry is reached by one moniker and by
nothing else: `eveMoniker.GetWar()`, `Moniker('warRegistry', (session.allianceid or session.corpid, 1))`, kept
until that owner is another's and bound before each use (`GetMoniker`, 57 to 67). `GetWars(ownerID)` keeps an
owner's wars twelve hours and asks `GetMoniker().GetWars(ownerID)` where it has none or they are older (98 to
106); `OnWarChanged(war, ownerIDs, change)` is worked into what is kept (82 to 96; `evewar/util.py` 183 to 202: a
war whose change says its ID is gone is taken out, any other is the war of its ID and is among its kept owners').
At a login the timer panel has the service say whether the pilot is at war, which asks its owner's wars
(`crimewatchTimers.py` 356; 302 to 311; not for a pilot in a militia), and the service's thread reads the same
wars every ten seconds (172 to 182), which asks again once they are twelve hours old. At a change of alliance or
corporation what is kept of both is let go and the reckoning is made again (69 to 80). Tranquility's recordings of
a login have `MachoResolveObject((owner, 1))`, `MachoBindObject((owner, 1), None)` and `GetWars(owner)` on the
object. The game port has all of it since `cee8eb78`, and the asking at a change of alliance or corporation since
`f2ce8c39` (at once for a pilot in a militia too, where the client's thread asks within ten seconds); everything a
page asks of the war registry goes on that moniker.
The location panel (`eve/client/script/ui/shared/infoPanels/infoPanelLocationInfo.py`), up from the first, docked or
in space. `UpdateLocationInfo` (155 to 162), with a system and a character on the session, draws the system, the
nearest thing or the station, the system's bounty output (`_UpdateDynamicResourceInfoAsync`, 319 to 326:
`dynamicResourceSvc.GetDynamicBountySettingForCurrentSystem()`, which is
`dynamicBountyMgr.GetOutputForClientSolarSystem()` kept by a memoize of ninety minutes), and whose the system is
(`UpdateSOVLocationInfo`, 335 to 352): in known space or a wormhole's, with the pilot's setting to show
sovereignty on, it reads `fwWarzoneSvc.GetLocalOccupationState()`, and in a system no faction holds goes on to
the system's sovereignty structures (348).
The warzone service (`eve/client/script/ui/services/fwWarzoneSvc.py`) keeps (solar system, occupation state) for
the system the session is in. `GetLocalOccupationState` (47 to 60) asks
`sm.RemoteSvc('fwWarzoneSolarsystem').GetLocalOccupationState()` with nothing where what it keeps is not of the
session's system, asks once more where the answer is for another system, and raises after two such; a change of
`solarsystemid2` lets go what is kept (34 to 37); `OnWarzoneOccupationStateUpdated(solarsystemID, state)` of the
session's system is the state from then (78 to 93). Tranquility's recordings have the call once at each login and
once after each change of solar system, answered `(system, None)`. The game port asks it so since `fd0c7cda`.
The dynamic resource service (`eve/client/script/ui/shared/dynamicResource/dynamicResourceSvc.py`) keeps the system's
bounty output ninety minutes (`GetDynamicBountySettingForCurrentSystem`, 58 to 65, under `@expiring_memoize(5400)`):
`sm.RemoteSvc('dynamicBountyMgr').GetOutputForClientSolarSystem()` with nothing, answering `(output, dbsIsActive)`,
or `(1.0, False)` with nothing asked where the server's global config has `dynamic_bounty_system_disabled` set. A
change of `solarsystemid2` lets it go and has the panel draw again, which asks (175 to 182);
`OnSystemDynamicBountyStateChanged(systemID, rate)` of the session's system makes it `(rate, True)` (160 to 165).
Tranquility's recordings have the call once at each login and once after each change of solar system, answered
`(1.0, False)`. The game port asks it so since `77010339`, the global config's switch taken as not set. Of the
panel's askings the sovereignty structures of a system no faction holds are left.
The security service (`security/client/securitySvc.py`) keeps the modified security level of each solar system
whose security is other than the map's. `Initialize` (39 to 43) asks
`sm.RemoteSvc('securityMgr').get_modified_systems()` with nothing and keeps each row's `modifiedSecurity`, a level
above nought and under 0.05 as 0.05 (18 to 21); it runs as the session first has a solar system (`OnSessionChanged`,
45 to 48), once. `OnSecurityModified(solar_system_id, modifier_amount, new_security)` sets a system's level from
then (50 to 54). Tranquility answers a `CIndexedRowset` keyed on `solarSystemID`, its rows of
(`solarSystemID` I4, `security` R8, `modifiedSecurity` R8), with none in the recordings. The game port asks it so
since `1c682e45` and keeps the answer and the notices' levels; an answer's rows are not read yet. (The character
selection screen's `map.GetSecurityModifiedSystems` is another read, asked before a character is chosen.)
The character settings service (`eve/client/script/ui/services/characterSettingsSvc.py`) keeps the settings the
client stores at the server for the character, each under a key: `_GetSettings` (31 to 34) asks
`session.ConnectToRemoteService('charMgr').GetCharacterSettings()` with nothing while it has none and keeps what
answers until the session is reset (26 to 29). `Get(key)` reads one out of it (36 to 42); `Save(key, value)` calls
`charMgr.SaveCharacterSetting(key, value)` and sets the kept one, a value of nothing or of no text being deleted
and one over 102400 long refused (44 to 51); `Delete(key)` calls `charMgr.DeleteCharacterSetting(key)` where the
key is kept (53 to 58). Its readers are the mail's settings, the fleet's setups, the inventory's and the chat's
filters, the sensor overlay's folders, the wallet's own payments and two of the settings menu's. Tranquility
answers a `utillib.KeyVal` of the settings, each a unicode string, with a `__doc__` beside them, and its
recordings of a login each have the one call. The game port asks it so since `168bc37b`, at the choosing; the
saving and the deleting are not made yet.
The achievement service (`achievements/client/achievementSvc.py`), the client's own "opportunities". As a character
comes onto the session and it has no data yet (`OnSessionChanged`, 182 to 188) it asks
`sm.RemoteSvc('achievementTrackerMgr').GetCompletedAchievementsAndClientEventCount()` with nothing
(`FetchMyAchievementStatus`, 128 to 134) and keeps the answer's `completedDict` and the counts of its `eventDict`
until the session is reset (190 to 192). It counts the client's own doings and sends them back,
`UpdateClientAchievmentsAndCounters(completedDict, stats)`, when an achievement is completed, at most every three
minutes otherwise, and as the client shuts down (194 to 230). Its event handler is what asks the ship's free turret
slots (above). Tranquility's recordings, of a later build, have the same call under the service name
`monolithTaskTrackerMgr`. The game port asks it since `c89be25f`, at the choosing between the journal and the
fighters, and sends nothing back.
The non-diminishing injection service (`eve/client/script/ui/services/nonDiminishingInjectionService.py`) keeps how
many skill injections the character may still take at their full worth. At every change of the session's
character (`OnCharacterSessionChanged`, 23 to 25, scattered by `carbon/common/script/sys/sessions.py` 586 to 590)
it asks `sm.RemoteSvc('nonDiminishingInjectionMgr').GetAvailableNonDiminishingInjections()` with nothing (49 to 51)
and keeps the number; `OnNonDiminishingInjectionsAdded(amount)` and `OnNonDiminishingInjectionsUsed(amount)` count
it up and down, `OnNonDiminishingInjectionsRemoved()` sets it to nought (27 to 42); `GetRemaining` answers what is
kept (44 to 47). Tranquility's recordings of a login each have the one call, answered 0. The game port asks it so
since `a293316f`, at the choosing between the bookmarks and the character's settings.
The season service (`seasons/client/seasonservice.py`). As a character comes onto the session
(`ProcessSessionChange`, 64 to 67) it initialises once for that character (69 to 82): it asks
`sm.RemoteSvc('seasonManager').get_season_data_for_character()` with nothing (`_fetch_season_data`, 268 to 279),
which answers nothing where no season runs, a list where the character is to choose among several, or the
season it is in; and where a season is the character's own (103 to 104) it asks its progress,
`get_character_progress_by_character_id()` (`_fetch_character_data`, 281 to 288). The server's notices (a
challenge's progress, completion, rewards and expiry, the seasonal goals, a season chosen, started or ended)
change what it keeps from then. Tranquility's recordings of a login have the first call, answered nothing. The
game port asks both so since `f020fef7`, at the choosing behind the standings, and keeps nothing.
The milestone service (`milestones/client/milestoneSvc.py`). At every change of the session's character
(`OnCharacterSessionChanged`, 20 to 23) it forgets the time it had left and calls
`sm.RemoteSvc('milestoneMgr').ProcessCharacterLogon()` with nothing, which answers nothing; the server's
`OnMilestoneTimerStarted(timeLeft)` is kept (25 to 27) and `GetTimeLeftInMilestone` answers it (29 to 30);
`ClaimRewards(milestoneID)` is the player's (32 to 35). On this server the logon's call starts the account's login
milestone: two hours online, then `OnLoginMilestoneAchieved` and a reward to claim, the time online written as
the session ends. Tranquility's recordings of a login each have the one call. The game port makes it since
`d1298c33`, at the choosing between the bookmarks and the non-diminishing injections, and keeps the time; the
claiming is not made yet.
The tutorial's two reads. `operations/common/util.py` `is_npe_enabled_for_character` (93 to 101) asks
`sm.RemoteSvc('operationsManager').can_character_play_the_tutorial(character_id)` with the character alone, once
for a character (it is memoized); its askers go by `operations/client/util.py` `are_operations_active` (12 to 13)
for the session's own character, and some of the client's services ask as a pilot comes in. The game port asks
it so since `73f82d5f`. The AIR tutorial's controller (`storylines/client/airnpe.py`) asks
`sm.RemoteSvc('air_npe').get_air_npe_state()` with nothing the first time something asks whether the tutorial is
active or completed (78 to 83, 95 to 99), keeps it by character, and takes `OnAirNpeStateChanged(character_id,
new_state_id)` for it from then (63 to 70). On this server that asking is what resumes the tutorial for the
session (`server/src/services/npe/airNpeService.js`, after the call). The game port does not make it: the
operator's to say.
The insurgency campaign service (`eve/client/script/ui/services/insurgencyCampaignSvc.py`).
`GetCurrentCampaignSnapshots_Memoized` (92 to 98) asks
`sm.RemoteSvc('insurgencySolarsystem').GetAllVisibleCampaigns()` with nothing and keeps the list half a minute
(`@Memoize(0.5)`: minutes, `caching/memoize.py` 14 to 37; with no argument a memoize keeps 108000 seconds, thirty
hours); the server's notices of a campaign started, updated or ending where the client is let it go (59 to 90).
Its readers are the insurgency's dashboard service, the agency and the map; the insurgency's info panel asks of
itself, its `IsAvailable` (`ui/shared/infoPanels/infoPanelInsurgency.py` 287 to 290) asking whether the session's
system is in a campaign each time the info panels are looked over. Tranquility's recordings have the call once at
each login and once after each change of solar system. The game port asks it so since `5cd1aa7b`. The local
campaign's own read (`GetLocalCampaignClientSnapshot`, 47 to 57) is not asked at a login, and is not made.
The redeem service (`eve/client/script/ui/services/redeemsvc.py`). `FetchRedeemTokens` (63 to 65) asks
`sm.RemoteSvc('userSvc').GetRedeemTokens()` with nothing and keeps the rowset of what the account may redeem;
`GetRedeemTokens` (51 to 54) answers what is kept. It fetches as its neocom extension is set up
(`InitializeNeocomExtension`, 37 to 46, called by `neocomSvc.py` 258 as a pilot comes in), at the server's
`OnRedeemingQueueUpdated` (162 to 169), and at a claim's end (127); `ClaimRedeemTokens(tokens, charID,
useHomeStation)` is the player's (99 to 131). The character selection screen reads the tokens too, before a
character is chosen. The game port fetches so since `bf601703`, from the choosing on; the claiming is not made.
Project Discovery's client service (`projectdiscovery/client/baseservice.py`, and the Covid project's over it,
`projects/covid/service.py`, which is the one the client runs: `projectdiscoveryClientSvc.py` 10 to 16). At a
change of the session's character, where the character is not the one it had, it asks
`sm.RemoteSvc('ProjectDiscovery').initialize_tutorial_status()` with nothing and keeps the bool (22 to 30); its
`is_enabled` (`baseservice.py` 39 to 42) asks `is_enabled()` with nothing while none is kept, and the neocom asks
that of its button for the project (`btnDataNode.py` 478 to 485). The localization client
(`carbon/client/script/localization/localizationClient.py` 24 to 27), as a first character comes onto a session
whose role has `ROLE_QA` (`serviceConst.py` 30), tells `localizationServer.UpdateLocalizationQAWrap` whether any of
the client's QA settings of its texts is on (`localization/settings/qaSettings.py` 53 to 65), one bool. The game
port makes the three so since `1b180463`: the wrap with False, on a session of the role alone; the tutorial's answer
not kept. `browserLockdownSvc.GetFlaggedSitesHash` at a login is the sites service's, asked as its lists are
populated for the chat's spam check (`chatutil/spam.py` 23; `carbonui/control/browser/sites.py` 348 to 354, 380 to
398), and is not made.
The client's own logging. `eventLog.LogClientStats(session.sid, locationID, package, crashes)`
(`eve/client/script/sys/clientStatsSvc.py` 893, at the proxy) is the client's statistics of its own machine and
drawing: gathered as the game is entered and at its states after (362 to 384), at each change of location (899 to
903) and at its exit (311), each package the state's name, the character, the user, the session's sid, the date
and the statistics' values (906 to 925; 928 on: the graphics card, the operating system, the graphics settings,
frame times). `clientStatLogger.LogString(text)` is the report that no ballpark came after thirty tries a second
apart (`eve/client/script/remote/michelle.py` 343 to 370), and the jump monitor's line where the server's global
config has `useClientSideJumpMonitor` (`eve/client/script/util/jumpMonitor.py` 47 to 49, 97, 128, 132).
Tranquility's recordings have the first in 27 files; the second after a login into space, and not after a docked
one. The game port makes neither: it has nothing of what the first carries, and not the failure the second
reports.
The chat's login (`xmppchatclient/xmppchatsvc.py`, `xmpp/xmppConnection.py`, `xmpp/xmpphandler.py`). A character on
the session, and the chat logs in (149 to 151, 109 to 112, 247 to 271). `self.XmppChatMgr.Hostname()` at the proxy
(284) is the chat's hostname, on which every JID is built: the pilot's `<charID>@<hostname>`, a room's
`<channel>@conference.<hostname>` (1190 to 1195), the stream's `to` (`xmpphandler.py` 55). The address the socket
dials (`xmppConnection.py` 413) is the global config's `ejabberd_client_address` or, where it names none,
`self.XmppChatMgr.GetDeprecatedPrefsFallback()` (307 to 312). The secret is
`sm.RemoteSvc('chatAuthenticationService').GetAuthenticationToken()`, read once the socket is up
(`xmppConnection.py` 423), or the word `ejabberd` where that answers nothing (317 to 325); the name in the SASL
word is the character's number, and the resource bound is `eveclient` (257). Logged in, it asks
`self.XmppChatMgr.ResyncSystemChannelAccess()` (345 to 368), again every five seconds while that names none, and
joins each channel named by the channel's own name; a channel's category is its name up to the first underscore
(`chatutil/__init__.py` 257 to 258), the kinds `nolocal`, `wormhole`, `nullsec` and `triglavian` are Local to it
(359 to 360), and for `nolocal` no presence is sent (1050 to 1054). Tranquility answers its chat domain for the
hostname and connects at another address; its resync is a list of two names. A pilot on the game port logs in so
since `3d9530a7`.
The chat's stanzas (`xmpp/xmpphandler.py`). The stream opens with `to`, `version`, `xmlns`, `xmlns:stream` in that
order (51 to 58), twice. A request is an `iq` with `id`, `type`, `from` and a space before the closing bracket
where it has no `to` (283 to 294), its id `id1`, `id2` and on from one at each connection, one count for requests,
joins, leaves and lines (320 to 323): the bind first, from the name (70 to 73), the session second, from the JID
the bind answered (75 to 90). Then `<presence><show/></presence>` (97 to 101), and the client is logged in at the
next thing the server sends (242 to 245). A join is a presence with `from`, an id, `to` the room and the nick, and
an empty MUC element unless a password or a history is asked (296 to 310); a leave the same with
`type='unavailable'` (312 to 318). A line is a message from the bare name with `type='groupchat'`, `xml:lang='en'`
and an id, its text cut past 2048 (`chatutil/__init__.py` 302 to 305), the characters of a C category taken out
and `&`, `<`, `>` replaced (110 to 120). The client pings nothing and answers the server's ping (148 to 175). At a
login it joins each channel the resync named and then each once more (`xmppchatsvc.py` 355 to 363); at a logoff it
leaves its session's channels in the order of its session categories and closes the stream (35 to 45, 153 to 162,
170 to 171). A retail client's own connection is in the chat stub's hour logs on this machine
(`eve.js/_local/logs/xmpp-stub.*.log`). A pilot on the game port sends these since `20a843e9`. The client's Python is
a narrow build with Unicode 5.2.0 data (asked of its `python27.dll` with its `unicodedata.pyd`): 383 ranges below
0x10000 are of a C category, the surrogates among them (`withoutCategoryC`, `src/gamePort/py27.js`).
The chat at a change of the session (`xmppchatclient/xmppchatsvc.py`). `OnSessionChanged` (149 to 164) goes
through `SESSION_CHANGE_CATEGORIES` (35 to 45: `solarsystemid2` Local, `allianceid`, `corpid`, `fleetid`,
`warfactionid`) and, where a value is in the change and was something, leaves the channel named from the old value
(`LeaveChannel`, 1154 to 1162, which sends its leave whether or not the channel was joined). It joins nothing
there. The service hears eight notices (the three of a ban, the session's change and its reset, a disconnect, a GM's
poke), none of a channel to join. The new channel comes from the chat server: an invite from `admin` has the
channel joined (542 to 559), and a presence in a channel has the window of the channel's category made or found and
set to that channel (632 to 687, 853 to 881; `xmppchatwindow.py` 611 to 633), the client's own presence passed
over in the wormhole, nullsec and Triglavian kinds (652 to 654). EveJS takes the chat connection out of the old
rooms and puts it into the new at a session's change, and sends their presences
(`services/chat/sessionChatSync.js`, `xmppStubServer.js` 2490 to 2550); it sends no invite. And it sends a
pilot's own presence to each of its rooms every thirty seconds (measured in the stub's logs, 2026-10-06 and
2026-10-13), which a chat window counts as activity, so the window's check of a quiet channel
(`xmppchatclient/xmppchatwindow.py` 1344 to 1364: every `maxChatChannelIdleTimeSeconds`, 180 by default, and up
to three seconds more, a channel quiet for longer is joined again with the history of the quiet time less two
seconds) finds nothing quiet here. A lost connection is made again five seconds on, to the same hostname and
address, with the secret asked again (`xmpp/xmppConnection.py` 399 to 465). A window drops a line that is spam
as it puts it out and sends none (`xmppchatclient/xmppchatwindow.py` 353 to 359, 952 to 956). `IsSpam`
(`chatutil/spam.py` 27 to 47) normalizes the line (17 to 18: lower case; `1370` written `leto`, each of
`,-_*+=^~@`, U+263B and U+3002 a dot, U+03BC `m`, U+03BF `o`, U+043C `m`, U+043E `o`, U+0441 `c`; a space,
`\`, `|`, `/`, `!`, the three kinds of bracket, `<`, `>`, both quotes, the backtick and U+00B4 taken out;
`dot` made a dot; two dots or more made one: the table is the module's compiled constants', the decompiled Python
having it wrong) and looks for each taboo in it, the first found settling it: spam unless the line as written has
the taboo too, not at its start, and every such occurrence follows a letter or a number. The taboos are what the
sites service has as banned in chat, each normalized, kept thirty hours (21 to 24): of the flagged sites, those
flagged 1, each one's domain (`carbonui/control/browser/sites.py` 348 to 354, 416 to 432), the flagged sites
being the list on disk unless its MD5 is not `browserLockdownSvc.GetFlaggedSitesHash()`, when
`GetFlaggedSitesList()` is asked (380 to 406). Tranquility and EveJS both answer the MD5 of `[]`. A pilot on the
game port checks so since `5f0b9627`.
Private conversations and optional invitations (read 2026-10-19). Start Conversation calls
`xmppchatsvc.Invite(charID, None)`: create through the proxy's
`XmppChatMgr.CreatePrivateChannel(charID)`, keep the target as not yet invited, and join the returned room
(1197 to 1208, 1239 to 1263). Opening the conversation sends no ordinary player invitation. The first
`SendGroupChat` marks the target invited and sends the mediated MUC invite with reason `Private chat` before
its groupchat line (328 to 342). Later lines do not repeat it. Invite To Chat in an existing private/player
room sends the mediated invite immediately with empty reason; `xmppchatwindow.CanInvite` (598 to 604) permits
any target outside that room. The character menu rejects self, NPC and multiple selections. Elevated chat roles
use `XmppChatMgr.AddCharacterToChannel` instead of that ordinary invitation path (1257 to 1261).

`xmppConnection.Invite` and `RejectInvite` (297 to 306) address the room from the bare character JID and
put `invite to=` or `decline to=` inside the MUC user namespace. Acceptance joins; blocked senders reject with
`blocked`, auto rejection and an ordinary rejection with `rejected`, and the dialog's block choice with
`rejected_and_blocked` (`xmppchatsvc` 561 to 601). A personal contact is accepted automatically before the
already-joined check. `_HandleDecline` (604 to 624) reads the rejecting sender, clears that pending invitation,
closes a pending private room and reports `ChtRejected`, `ChtCharNotReachable` or `ChtBlockedNow`.
The original compiled build-3396210 functions confirmed create/join/first-send order and both stanza templates.
An all-folder Tranquility recording search found chat setup but no exact private conversation capture; these
private contracts come from the client, not a claimed Tranquility observation.

Three actual game-port/XMPP sessions reproduced EveJS dropping declines and refusing an explicitly invited
third player. EveJS `4dce363ec` relays each decline from the room with the authenticated rejecting character;
`f35c0cfe9` admits an explicitly invited additional participant without adding moderation rights. After a cold
start, all three reasons arrived, an uninvited third player was refused, then its invitation, join, reply and
three-member rosters succeeded. Creation alone still sent zero invitations. The production XMPP adapter now
keeps full private/player/bot/system identities, retains optional invitations and declines, and exposes atomic
room join/read/send/leave/invite/reject/acknowledge through the BFF and typed page API. The two native proxy
writes use the existing confirmed pilot-call boundary. Three live BFF pilots held two independent private
rooms, exchanged messages, added a third participant, exercised all decline reasons and kept one room working
after closing the other. A real successful preflight held across logout/reselection was retired without a late
invitation request; closing a native session during its actual spam-list read prevented the late line.
The room-key rule comes from original compiled GetWindowNameForGroup (895 to 907). Native private
GetDisplayName asks disco#info at the full room JID; a player room asks the conference service with its
room name as node (1327 to 1342). The adapter now correlates these IQ replies, returns the actual identity
name and occupant count, and rejects pending requests when the connection closes, using IssueRequest
203 to 234's thirty-second deadline. Original compiled GetDisplayName and xmpphandler.issue_request
confirmed both stanzas: private counts below two choose PrivateChatAlone; without a window, two or more
choose PrivateChat with the count. GetPrivateChannelDisplayName uses other member names, a pending
target fallback, and GroupChat for multiple others. GetMembers is the native member dict's keys (window459),
so names follow its Python dict order. Live room counts changed 0/1/2/1/0, concurrent private/player IQs
kept distinct replies, and queries never implicitly joined. A real successful response held across pilot
replacement retired; closing an actual pending IQ rejected it and ignored the held late reply.
The page now owns this private-conversation sequence in `chatConversations.ts`. Shared single-owner
Contacts and Member List menus offer Start Conversation and the native eligible-room submenu. Private
rooms retain independent histories, rosters and drafts alongside Local/Corp on desktop and phone.
The nonmodal invitation window is keyed by sender and offers the native four choices, default Accept;
Accept and Add opens the existing Contact Management form rather than writing a default contact.
Blocked, auto-reject, personal-contact and already-joined decisions run in native order. Each awaited
operation keeps its captured pilot, including the spam preflight before the first invitation.
The mutable member-key table follows CPython 2.7 deletion and resize order; thirty operations matched
the installed client's compiled `GetMembers`. Live browser checks covered first-send order, rejection
cleanup, all four choices, duplicate invitations, pending-close cleanup, two independent rooms and a
third participant. A real successful preflight held across a change of pilot retired without an invite
or line. The native elevated mask includes Legion (262144); EveJS `5242286f7` fixes its omitted role,
verified by an actual Legion-only session's denied RPC before and delivered invitation/join/reply after.

Owner double-click (read 2026-10-19). `userentry.User.OnDblClick` (565-588),
`chat/client/member_list_entry` (343-355) and `xmppchatuserentry2` (335-347) honor a
custom node callback first. Ordinary rows read `settings.user.ui.dblClickUser`,
default0: ShowInfo takes cfg.eveowners' actual typeID and ownerID; choice1 enters
the chat Invite path above without the character menu's self/NPC gate. The chat
service supplies the corresponding native refusals. `ConstructChatSettings`
(systemmenu1197-1206) offers Show Info0/Start Conversation1; SettingsSvc keys the
user section by userid, separately from character settings. Contacts and member
tracking supply ordinary User entries. Search selects User for owner categories,
but AgentEntry for agents. Its OnDblClick966-978 retains the agent conversation
callback while docked and ignores this choice.

The original compiled three owner methods confirmed both choices, actual owner
type arguments, custom overrides and destroyed entries. The browser now shares
the setting between one account's pilots, separately from other accounts, and
uses it for contact/search/member/chat roster rows. Actual AppFlow and browser
sessions verified these scopes, persistence, info versus chat dispatch and agent
callback precedence. Native recorded traffic contained the expected private
channel creations and elevated AddCharacterToChannel calls, with NPC DoAction
separate. Recursive corpus searches found no dblClickUser or CreatePrivateChannel
capture; unrelated space-double-click telemetry is not evidence of this gesture.

Explicit owner Show Info (read2026-10-19). User.ShowInfo549-552 and menusvc579-580
use cfg.eveowners' actual type; GetMenuFromItemIDTypeID2281-2297 offers it for
corporation/alliance/faction owners too. Their shared Contacts menu now does so,
independently of the configured double-click action. Missing local ownerType
resolution for NPC/faction rows is fixed: LoadEveOwners548-584 preloads faction30,
NPC corporation2 and NPC character1373. Known rows use local tables; player types
retain the native GetMultiOwnersEx read. Original compiled User.ShowInfo, actual
AppFlow types and desktop/phone typed corporation/faction windows verified this.
Recorded owner-type reads contain player owners only, no NPC/faction lookup and
no private-chat creation. The compiled ShowInfo window selection policy and the
window-manager port and remaining asynchronous reconstruction unit are recorded in
[game-port-info-windows.md](game-port-info-windows.md).

Independent info windows (c6b1,2026-10-19). Original compiled ShowInfo412-454,
its bucket/registration helpers, HistoryBuffer and InfoWindow.NavigateHistory
confirm newest-created reuse, duplicate modern no-op, legacy reconstruction,
new/addNewWindow/Shift/user preference, modal decisions and history routing.
Original idCheckers and installed type/group data determine ship/ordinary and
character/corporation/legacy content; generic type0 has group0 and is valid.
The browser now keeps per-pilot windows, components, history and geometry, with
desktop focus and phone instance selectors. It snapshots asynchronous owner
gestures and dispatches every synchronous multi-owner request. Captured stable
component handles prevent focus/layout changes from rereading info. Live native
counts were unchanged through minimize/restore, desktop/phone changes and pilot
switching. Actual native account replacement cleared the old pilot's windows.
The old global-target and contextual-tab assertions were retired, not skipped.
Native loading guards, thread cancellation and ship pendingLoadData behavior
remain required c6b2 work; the window manager does not claim those complete.

Before a character is chosen. The cfg, as its data are loaded, asks `config.GetBlackListedPlanets()`
(`eve/common/script/sys/eveCfg.py` 367, 475 to 477) and, by a thread, `config.GetOldStationData()` (701, 741 to
753). The AIR tutorial's controller asks `air_npe.is_air_npe_enabled()` at each coming of the global config
(`storylines/client/airnpe.py` 72 to 76). The raffle service, on a session with a country, asks
`raffleProxy.AmIBanned()` at the proxy once, the commands' list wanting to know whether the raffles are open
(`raffles/client/raffle_service.py` 39 to 57; `eveCommands.py` 744). As a character is entered as,
`characterSelection.TryEnterGame` (`eve/client/script/ui/login/charSelection/characterSelection.py` 742 to 767)
makes `Moniker('populationCap', (charID, 1))` and asks `GetCharacterLoadSlot(charID)`, the call in the bind;
with more than one place answered it asks its player to choose and calls `MoveCharacterToNewSystem`. Tranquility
answers one place, a solar system to a slot's key. The character selection screen's own: the daily rewards
(`loginCampaignManager.get_client_campaign_state`, `seasonalLoginCampaignManager.get_active_campaign`), the lapsed
game time's warning (`GetCharOmegaDowngradeStatus`, 299 to 306), the paper dolls its portraits are drawn from, the
redeeming's tokens. The game port makes the first five since `8a6c3738` and none of the screen's own. A pilot on the game port reconnects
and checks so since `3611198a`, and follows its session since `82986a37`.

**What an overview lists, 2026-10-13** (`eve/client/script/parklife/tacticalConst.py`). The overview is made of a
table of groups
(`construct_groups`, 112 to 127): every group but those of the Charge category that are not one of seven
(`bombGroups`, 86 to 93: 90, 863, 864, 479, 548, 4088, 1548), those whose category is not one of thirteen
(`validCategories`, 72 to 85: 3, 6, 11, 2, 25, 18, 22, 23, 65, 8, 40, 46, 87) and sixty-four set aside
(`filterGroups`, 7 to 71, one of them a bare 11). Every preset's groups, the overview's and the brackets', are cut
down to the table (`overview/presetservice.py`, `GetValidGroups`, 315 to 321), a group not in it is not shown
whatever a preset has (`IsGroupIDShown`, 286 to 289), and what in space may be clicked goes by it too
(`is_interactable_entity`, 132 to 133; `ui/inflight/navigation.py` 509). The page's `overviewCanList`
(`web/src/space/overview.ts`) has the whole table since `44c2c9fc`.

**The scanner's orders, 2026-10-13** (`eve/client/script/parklife/scanSvc.py`, `probescanning/probeTracker.py`). A
launch is a formation's: `MoveProbesToFormation` (169 to 182) refuses where the probes held and the charges
loaded are fewer than the formation's (`CheckCanCreateFormation`, 163 to 166; eight for the pinpoint and the
spread, by the compiled module), and launches the formation's number less the active probes,
`dogmaLM.LaunchProbes(module.itemID, numProbes)` on the ship's dogma location (`FindModuleAndLaunchProbes`, 487
to 498). A scan is `GetScanMan().RequestScans(probes)` (193 to 198): the idle probes, `{probeID: KeyVal}`, or
None; after it the client holds itself to be scanning (`scanHandler.SetProbesAsScanning`, with its ship where it
sent None) until `OnSystemScanStopped`, and its probes to be moving. A recall is `RecoverProbes(probeIDs)` (340
to 341), every active probe, answered with the ones recalled; a reconnection is `ReconnectToLostProbes()` (269 to
285). The three are asked of the object `GetSystemScanMgr()` answered. Before it asks, the client refuses: all
while scanning (`UserErrorIfScanning`, 40 to 48); a recall or a reconnection from a capsule; a recall with a
probe's ball within 2,000 metres; a scan in void space; a reconnection without an online launcher or inside a
minute of the last. No Tranquility recording has a probe. EveJS tells the scan's start before it answers the
asking where no probe has to move (1 and 7 ms before, on the wire), and does a recall asked in the middle of a
scan. The page makes the four so since `0c36b290` (`web/src/bridge/scannerWrites.ts`).

**A module online and offline, 2026-10-13** (`eve/client/script/dogma/clientDogmaLocation.py`). From a fitting slot
(`ui/shared/fitting/fittingSlotController.py`, `ToggleOnlineModule`, 357 to 366): `OnlineModule` (698 to 711)
starts the online effect in the client's own dogma and asks `remoteDogmaLM.SetModuleOnline(dogmaItem.locationID,
moduleID)`, the ship the module is in and the module, taking `EffectAlreadyActive2` for no refusal;
`OfflineModule` (713 to 723) asks `TakeModuleOffline` with the same two, and nothing for a ship being boarded or
left. A module in a weapon bank is asked about first (`QueryGroupOffline`, 359 to 362). The client onlines a
module newly fitted by itself (`_OnlineModuleIfApplicable`, 624 to 632), and that is the one
`SetModuleOnline(shipID, moduleID)` Tranquility has recorded, on the dogma location's object. The module's button
on the rack goes by the online effect instead (`shipmodulebutton._ChangeOnline`, 823 to 847: godma's
`Activate(itemID, 'online', None, 0)` and `Deactivate(itemID, 'online')`), asking before any offline. EveJS wants
95 in 100 of the capacitor for an online in space and leaves 5; asked for what is so already it answers nothing.
The page makes the slot's two since `130ae40f` (`web/src/bridge/dogmaWrites.ts`).

**An agent's two writes, 2026-10-13** (`eve/client/script/ui/station/agents`). What is said to an agent is
`GetAgentMoniker(agentID).DoAction(actionID)` (`agentDialogueWindow.ExecuteAgentAction`, 427 to 428), None to open
a conversation; Tranquility has it in 23 recordings, on the agent's object, and once inside that object's binding:
`MachoBindObject(agentID, ('DoAction', (None,), {}))`. An offer is taken out of the journal by
`GetAgentMoniker(agentID).RemoveOfferFromJournal()`, with nothing (`agents.py` 782 to 784), from the journal's
menu for a mission that is offered (`missionentry.py` 66 to 67); no recording has one. EveJS answers nothing to a
removal, with an offer or without. The page makes both on the agent's object since `e1b4d4a9`
(`web/src/bridge/agentWrites.ts`), and the game port sends the opening inside the binding.

**Lost drones reconnected to, 2026-10-13** (`eve/client/script/ui/services/menuSvcExtras/droneFunctions.py`).
`ReconnectToDrones` (217 to 241), from the ship's own menu and its shortcut: with no ballpark, in a structure or
with no ball for the ship, nothing; the candidates are every ball of the Drone category that is the pilot's own
character's and not among the drones the client holds to be its own (`michelle.GetDrones`), twenty-five at most
(`MAX_DRONE_RECONNECTS`, `appConst.py` 2069, and 25 in the compiled module); with any,
`eveMoniker.GetEntityAccess().CmdReconnectToDrones(droneCandidates)` (`_ReconnectToDroneCandidates`, 244 to 259),
and what the server answers of the drones it would not take is told to the pilot; with none, the pilot is told
so and nothing is asked. No Tranquility recording has it. EveJS answers an empty dict where it refuses nothing,
and passes over a drone that is another's or is held. The page makes the call since `db24bfc6`
(`web/src/bridge/boundEntityWrites.ts`), for the drones its window or its lost-drone check names.

**A market order taken down, 2026-10-13** (`eve/client/script/ui/shared/market/quote.py`). `CancelOffer(order)`
(299 to 303), from an order's own menu: the pilot is asked (`CancelMarketOrder`, 300 to 301), and then
`marketQuote.CancelOrder(order.orderID, order.regionID)`, which is
`GetMarketProxy().CancelCharOrder(orderID, regionID)` (`ui/services/marketsvc.py` 281 to 283), both off the
order's own row. Nothing after: the server tells `OnOwnOrdersChanged`. No Tranquility recording has one. EveJS
reads the order's number alone, refuses an order that is not the pilot's in a sentence, and answers nothing
whether it took the order down or found it closed. The page makes the call since `95bb72b5`
(`web/src/bridge/marketOrderWrites.ts`), and judges by its own reads of the pilot's orders and wallet.

**Orders placed and repriced, 2026-10-14** (`eve/client/script/ui/services/marketsvc.py`,
`ui/shared/market/buyThisTypeWindow.py`, `sellMulti.py`). A buy: `BuyStuff` (256 to 268),
`PlaceBuyOrder(stationID, typeID, round(float(price), 2), quantity, orderRange, minVolume, duration, useCorp,
expectedBrokersFee)`, the window's own range or the station's (667 to 672), a least fill of 1 (677 to 679), and the
broker's fee rate the window showed (701). A sale: `SellMulti` (275 to 276), `PlaceMultiSellOrder(itemList,
useCorp, duration, expectedBrokersFee)`, each item a `KeyVal` of eight (`sellMulti.py` 483 to 501), the rate the
first item's for an order that stands and None for a sale at once (443 to 446). A reprice: `ModifyOrder` (285 to
289), `ModifyCharOrder(order.orderID, newPrice, order.bid, order.stationID, order.solarSystemID, order.price,
order.range, order.volRemaining, order.issueDate)`, from the modify window (`buyThisTypeWindow.py` 603 to 622).
Every price, rate and delta is a float. No Tranquility recording has any of the three. EveJS holds an order to a
rate named and checks none where None is named; it answers a buy with None, a sale with whether it traded or set
an order up, a reprice with None. The page makes the three since `b80c3f59` (`web/src/bridge/marketOrderWrites.ts`),
and the game port sends a whole price, rate or delta as a float since `b1fbb8e7`.

**A change of place, 2026-10-14** (`eve/client/script/ui/station/base.py`, `ui/shared/dockedUI/undockingSvc.py`).
Every change of place the client makes goes through its session manager, `sessionMgr.PerformSessionChange(kind,
call, ...)`: not while another change is under way, nor before the last one's timer has run, and the session is
another one after it. The undock (`_DoUndockAttempt`, 488 to 521): `PerformSessionChange('undock',
shipsvc.Undock, shipID, ignoreContraband, onlineModules=GetOnlineModules(shipID))`, on the ship's object for the
station, the ship the session's own; refused with `ShipContrabandWarningUndock`, the pilot is asked, and on OK the
undock is made again with the flag set (506 to 511). For a pilot of the page's the session manager's keeping is the
BFF's: the generic call makes a page's change of place under it since `ea7df3b0` (`dispatchPlaceChangeWrite`), and
the page makes the undock (`web/src/bridge/placeChanges.ts`).

**A dock, 2026-10-14** (`eve/client/script/ui/services/menuSvcExtras/movementFunctions.py`, `ui/services/menusvc.py`,
`ui/services/structure/structureDocking.py`). At a station: `RealDock` (503 to 518), `PerformSessionChange('dock',
bp.CmdDock, itemID, session.shipid)`, on the ballpark's bound object (Tranquility's recordings have it so), from the
menu's `DockStation` (2991 to 2997, which flies the ship close first) and the flight's `DockOrJumpOrActivateGate`
(346 on). A station is `idCheckers.IsStation`: 60000000 to 63999999. At a structure: `structureDocking.Dock(structureID,
session.shipid)`, asked of the service by its name once the ship is close (64 to 80). EveJS answers a station's dock
from too far with `DockingApproach`. The page docks at a station since `6de7ef5c` (`web/src/bridge/placeChanges.ts`),
under the BFF's keeping of the change; a structure by its route still.

**A jettison, 2026-10-14** (`eve/client/script/ui/services/menuSvcExtras/invItemFunctions.py`,
`menucheckers/itemCheckers.py`). An item's menu offers Jettison where the pilot is in a ship in space and the item
may go (`OfferJettison` 401, `IsJettisonable` 1230: no ship, no player's container, nothing with a cargo bay of its
own, in a hold a jettison takes, `inventorycommon/const.py` 257). The pilot is asked (`ConfirmJettison`), then
`GetShipAccess().Jettison(itemIDs)` (`Jettison`, 56 to 73) on the ship's Moniker for the solar system
(`eveMoniker.GetShipAccess` 42), the items' IDs as one list. The answer is `(jettisonedToCanIDs,
jettisonItemList)`; an item asked for and in neither raises `NotAllItemsWereJettisoned` with the types that stayed.
EveJS answers the two lists, the first empty where it refused, and refuses one inside its cooldown with
`ShpJettisonPending`; on the game port the can comes with the park's next update, some 1.4 s after the answer. The
page makes it since `ec6dacc0` (`web/src/bridge/shipWrites.ts`) outside a Mining Operation; an operation's hosted
bot asks the route, which finds its can and gives it to the operation.

**A module switched on and off, 2026-10-14** (`eve/client/script/ui/inflight/shipModuleButton/shipmodulebutton.py`,
`eve/client/script/environment/godma.py`). The button's click (`Click`, from 933) finds the module's default effect
(`GetDefaultEffect`, 908: the type's default effect that is not `online`, of the activation or the target
category), gives it a target only where it is aimed at one (1318), and calls the effect's `Activate(targetID,
repeats)` (1348); the count is the button's (`GetRepeatCount`, 112 to 122, set at the button's making, 178: 1000
for a module that always repeats or has a repeatable effect, the pilot's own setting where one is kept, else 0; a
ctrl-click 1000, 929; 0 for an effect that cannot repeat, 1338). The effect calls godma's `Activate(itemID,
effectName, target, repeat)` (985, then 2062), and a stop `Deactivate(itemID, effectName)` (996, then 2101): the
effect is always named. EveJS takes the module's first activatable effect where none is named, or one the type does
not carry (`space/runtime/scene/modules.js` 1213 to 1222), keeps the count as given and tells the ship's watchers
it, a negative count kept as none (`space/runtime/moduleCycleSchedule.js`, `normalizeEffectRepeatCount`). The page
makes both since `e773e6dd` (`web/src/bridge/dogmaWrites.ts`), the effect the type's default from the game's data
(`GET /api/types/default-effects`) where the caller gives the type, until stopped as -1, and reads the module's
own state after (`GET /api/bridge/modules/:itemID/state`). The game port makes each the client's
(`src/gamePort/retailCalls.js`, `activation` and `deactivation`): it names the module's default effect where the page
names none, as godma knows the module, gives a target only to an effect aimed at one, and sends 1000 or 0 for -1 by
whether the effect can repeat.

**A stargate jump, 2026-10-14** (`stargate/client/gateJumpSvc.py`, `eve/client/script/parklife/autopilot.py`). The
menu's `StargateJump` (`menusvc.py` 3025 on, flying the ship close first) and the autopilot (358) come to
`PerformSessionChange(..., remoteBallpark.CmdStargateJump, stargateID, beaconID, session.shipid)` (`JumpThroughGate`,
98 to 127), on the ballpark's bound object, beaconID the gate's own far gate off its slim item
(`jumps[0].toCelestialID`); with none the client does not jump. EveJS sends a stargate's `jumps` as a rowset of
`toCelestialID` and `locationID`, and works the far gate out from the gate where a caller names none. The page
makes the jump since `f01eb1e3` (`web/src/bridge/placeChanges.ts`), under the BFF's keeping of the change, which
binds the park again in the new system before it answers; the game port names the far gate off the slim item since
`1fc36df7`.

**A module fitted and unfitted, 2026-10-13** (`eve/client/script/dogma/clientDogmaLocation.py`,
`ui/shared/fitting/fittingSlotController.py`, `ui/shared/fittingScreen/tryFit.py`,
`ui/shared/fitting/fittingUtil.py`). Into a slot: `TryFit` (669 to 673),
`invCache.GetInventoryFromId(shipID, locationID=session.stationid).Add(item.itemID, item.locationID, qty=1,
flag=flagID)`; `invCache`'s own `Add` asks `CheckCanFit` first for a fitting flag or `flagAutoFit` (1005). To
no slot: `shipInv.moniker.MultiAdd(itemIDs, sourceID, flag=const.flagAutoFit)` (`tryFit.py` 135,
`fittingUtil.py` 157), past `invCache`'s own. Unfitted (`UnfitModule`, 217 to 243): a module in a weapon bank is
asked about and ungrouped, its charge taken out, and then
`invCache.GetInventory(const.containerHangar).Add(moduleID, shipID, flag=const.flagHangar)` docked, or the ship's
own `Add(moduleID, shipID, qty=None, flag=const.flagCargo)` in space. EveJS moves nothing of another pilot's
(`FakeItemNotFound`, asked live for `Add`), answers `Add` with the item's number and `MultiAdd` with `True`,
and an `Add` of a thing not there with None. The page makes the calls since `71601be5`
(`web/src/bridge/fitModule.ts`), and judges by its own reads of the slots.

**A launchpad's goods sent up into a customs office, 2026-10-13** (`eve/client/script/ui/shared/planet/importExportUI.py`).
The window is opened at an office in space (`ApplyAttributes`, 81 to 103: the office's slim item from the
ballpark) and asks the office's rate as it resets (`UpdateTaxRate`, 382 to 385:
`eveMoniker.GetPlanetOrbitalRegistry(session.solarsystemid).GetTaxRate(officeID)`): None where the office's owner
does not let the pilot use it, and then an export is refused (`ExportCommodity`, 467 to 469). The transfer
(`ConfirmCommodityTransfer`, 537 to 558) is `invCache.GetInventoryFromId(officeID).ImportExportWithPlanet(
spaceportPinID, importData, exportData, self.taxRate)`; on `TaxChanged` the rate is asked again, refused where
there is none, and the pilot asked (`CustomsOfficeTaxRateChanged`) before it sends again. EveJS answers the
transfer None, and refuses a rate not the office's (`TaxChanged`) and a pin not the pilot's
(`CannotImportEndpointNotFound`). The page makes the calls since `30c68a1c` (`web/src/bridge/customsWrites.ts`),
in space only.

**A stack dropped on a stack, 2026-10-13** (`eve/client/script/ui/shared/item.py`,
`environment/invControllers.py`, `environment/invCache.py`). An item's `OnDropData` (958 on) takes each dropped stack
of the target's type as (its itemID, the target's, its whole stack, or a number asked with shift held), the source
where the dropped stacks lie (`node.rec.locationID`, 1004); the target's container's controller
(`MultiMerge`, 327 to 335) hands `[(source, destination, qty)]` to its inventory, whose `MultiMerge` (1100 to
1124) sends `self.moniker.MultiMerge(ops, sourceContainerID)`. Recorded once on Tranquility, in the hangar's
container: `MultiMerge([(source, target, 3822)], 60001717)`. EveJS answers None whether it merged or not, and
merges nothing of a stack in a hangar that is not the session's own character's. The page makes the call since
`8ab05f70` (`web/src/bridge/inventoryWrites.ts`) where it holds the place's rows.

**Items trashed, 2026-10-14** (`eve/client/script/ui/services/menuSvcExtras/invItemFunctions.py`,
`environment/invCache.py`, `eve/common/script/net/eveMoniker.py`). `TrashInvItems` (602 to 626): the items in one
place, the pilot asked, each of a type that may be trashed, then
`errors = invCache.GetInventoryMgr().TrashItems(itemsToTrash, locationID)` and each error shown. The manager is the
one `invCache` keeps for where the session is (193 to 201), `Moniker('invbroker', (solarsystemid,
groupSolarSystem))` where the session has a solar system, else the station's (`GetInventoryMgr`, 122 to 131).
`locationID` is the station or structure the first item lies in directly, the office's station for a
corporation's item, else the item's own place (`GetStationIDOfItem`, 660 to 691). EveJS destroys only the
session's own character's items (or a director's in the office here), never the ship flown, and answers None or
`["CannotTrashItem"]`. The page makes the call since `bd2562f0` (`web/src/bridge/inventoryWrites.ts`).

**A saved fitting applied, 2026-10-14** (`eve/client/script/environment/fittingSvc.py`). `LoadFitting` (554 to 618):
`shipInv = invCache.GetInventoryFromId(activeShip)`, the ship's type checked against the fitting's, the rigs fitted
or put in the cargo by the pilot's word, the hangar's items to fit from by type, then
`shipInv.FitFitting(activeShip, shipTypeID, itemsToFit, session.stationid or session.structureid, fittingObjKeyVal,
cargoItemsByType, fitRigs)`, which answers what failed to load. EveJS refuses a ship that is not the pilot's
(`FakeItemNotFound`). The page makes the call since `52c3e41c` (`web/src/bridge/fitModule.ts`, `applyFitting`).

**Stack All, 2026-10-14** (`eve/client/script/environment/invControllers.py`, `environment/invCache.py`). The window's
container asks its own inventory `StackAll(self.locationFlag)` (382 to 388): `flagHangar` for the hangar,
`flagCargo` for the ship's hold. `invCache`'s container lists first and asks nothing where it has no two stacks
of a type, passing over a singleton (1065 to 1093). EveJS merges per type, owner and flag and answers `True`. The
page makes the call since `3199e04d` (`web/src/bridge/inventoryWrites.ts`).

**Things moved by the pilot, 2026-10-14** (`eve/client/script/environment/invControllers.py`). One thing:
`_AddItem` (229 to 262), the whole stack or a number asked with shift held, and `__AddItem` (195 to 226),
`Add(itemID, sourceLocationID, qty=quantity, flag=self.locationFlag)` on the window's container's own inventory. Many:
`AddItems` (489 to 562), sorted by volume times stack, smallest first, `MultiAdd(itemIDs, sourceLocation,
flag=self.locationFlag)`, or `flagNone` where the container has no flag. The flags: `flagHangar` (`StationItems`,
1138), `flagCargo` (`ShipCargo`, 605), a ship's bays their own (669 to 776), a container none (60). The page makes
the pilot's own moves between the hangar, the hold and a container since `0fe34b9e`
(`web/src/bridge/inventoryWrites.ts`, `moveItems`).

**The corporation's hangar, 2026-10-14** (`environment/invControllers.py`, `ui/services/corporation/officeManager.py`).
The office is `officeManager.GetCorpOfficeAtLocation()` (99 to 111), the office of `GetMyCorporationsOffices()`
whose `stationID` is where the session is docked; `StationCorpHangar` takes its `officeID` (949 to 952), and its
inventory is `invCache.GetInventoryFromId(officeID)` (`BaseCorpContainer._GetInvCacheContainer`, 856 to 860).
What lies in it lies in that number with the division's flag (`IsItemHere`, 867 to 868); the flag is
`corpFlagByDivision.get(divisionID)` (`SetDivisionID`, 848 to 850), `flagCorpSAG1` to `flagCorpSAG7`, 115 to 121
in the compiled `inventorycommon/const.py`. A move into a division is the office's `Add` or `MultiAdd` with that
flag, a move out the destination's own with the office as the source, a merge the office's `MultiMerge`. EveJS
publishes the office's `itemID` as its `officeID` and lists as the office's what lies in any of its three numbers.
The page makes the calls since `a2132b95` (`web/src/bridge/inventoryWrites.ts`, `officeAt`, `corpDivisionFlag`).

**The skill history, 2026-10-13.** `skillsvc.GetSkillHistory(maxresults=50)` (361 to 364) asks the bound skill
handler once and keeps the answer; the character sheet's History tab shows each row's date, skill, what happened
(`ACTIONS`, by `eventTypeID`) and a level it reckons from `absolutePoints` and the skill's rank
(`skillHistoryPanel.py` 54 to 64). At login `skillHistoryProvider.py` asks for 10 and makes a notification of
every row. Tranquility's answer, recorded at three logins: a `carbon.common.script.sys.crowset.CRowset` whose
header is a `blue.DBRowDescriptor` of `logDate` (64), `eventTypeID` (2), `skillTypeID` (3), `relativePoints` (3)
and `absolutePoints` (3), with packed rows, the newest first. The three logins overlap into eighteen rows one
after the other: seventeen levels trained (53) and one use of free points (307, the points used and what the
skill then had), every date a whole second, a level trained after another its training time after it, and no
row of a start or a stop.

This server answers so since `eve.js` `54125d9ff`, and writes no row at a start since `a0fd2e19c`. A packed row
reaches the page through the game port with its fields by name and its date a long, and through the gateway with
its values by place and its date a string of digits; the page's reader takes either
(`web/src/bridge/boundSkills.ts`, `a51216b2`). Since `ff0e09f3` the page's Character Sheet lists it, as the client's History panel's skills tab does
(`charsheet/historyPanel.py` 21 to 32): a line of each row whose skill the pilot has, with the date by the label
`/Carbon/UI/Common/DateTime/DateLongShort`, the event's word by `ACTIONS`, and the level reckoned by
`GetSPForLevelRaw` (`characterskills/util.py` 40 to 46), the newest first (`web/src/bridge/skillHistoryPanel.ts`).
The page asks the history with no count said and the pilot's skills, by the generic call; on the game port the
answer is the one the transport keeps from the login's asking of ten, as the client's skill service keeps its own.

**The Industry window's monitor, 2026-10-13.** `industrySvc.ConnectJob` (299 to 301) makes the job the one
monitored and has `(monitorID, available)` of `industryMonitor.ConnectJob(job.dump())`: what the job's input
place has, by type. One job is monitored, the last connected. `OnIndustryMaterials(jobID, materials)` (324 to
327) sets `job.available` where the monitored job's monitor is that number, and the window shows it. The
window's close lets the monitor go (`DisconnectJob`, 304 to 307). No recording has the notice, nor any of
industry's.

This server sends it since `eve.js` `83c66feb6`: by `clientID`, to the session that opened the monitor (the one
it opened last), after an item change that session is told of, where what the place has is not what it was last
told. The transport keeps a monitor's answer and answers a later `ConnectJob` for the same job from it, and puts
the notice's word into what it keeps (`pilots.js`, `monitoredJobHas`, `8f8621c0`). The page's next preview has
it. Since `68d3eb62` the page's window shows the notice's word at once, as the client's does: the BFF's preview
says the monitor's number where the transport keeps the monitor, and the window shows the materials of a notice
that names that number and came after the preview was asked (`web/src/bridge/industryMaterials.ts`). Through the
gateway the preview's monitor is let go at once, and the preview says no number.

**Crimewatch's notices, 2026-10-10.** Each changes one thing the service keeps, and nothing
is asked after it (`crimewatchSvc.py` 222 to 288).

| Notice | Carries | What the client does | On Tranquility | This server |
|---|---|---|---|---|
| `OnWeaponsTimerUpdate`, `OnPvpTimerUpdate`, `OnNpcTimerUpdate`, `OnCriminalTimerUpdate`, `OnDisapprovalTimerUpdate` | `(state, expiryTime)` | that timer is in that state until that time | the NPC one, 86 times in 17 files: by `charid`, as `(400, None)`, `(401, None)`, `(402, a long)` | by `charid`, as `(x02, a long)` and `(x00, None)`; to a pilot in space only |
| `OnSystemCriminalFlagUpdates` | `(newIdles, newSuspects, newCriminals)` | the idle forgotten, then the criminals, then the suspects (`UpdateSuspectsAndCriminals`, 195) | 9 times in 6 files: by `solarsystemid2`, three sets | by `solarsystemid2`, three sets (tuples until 2026-10-13, `eve.js` `49c3c99fa`) |
| `OnCrimewatchEngagementCreated`, `...StartTimeout` | `(otherCharID, timeout)` | the engagement with that pilot ends then | not recorded | by `clientID` |
| `OnCrimewatchEngagementStopTimeout` | `(otherCharID)` | it goes on with no end (`crimewatchEngagementTimeoutOngoing`, -1) | not recorded | not seen |
| `OnCrimewatchEngagementEnded` | `(otherCharID)` | it is gone | not recorded | by `clientID` |
| `OnSystemDisapprovalFlagUpdates` | `(newIdles, newNaughty)` | who is disapproved of, which `GetClientStates` does not say | not recorded | by `clientID`, two tuples |

The transport works each into the states it keeps (`src/gamePort/crimewatchStates.js`), in
the form the states came in, reading the flags' three as sets, tuples or lists. Set beside the
server's own answers through a walk of fourteen notices, what it keeps was the same after
each. States or a notice in a form it does not read are let go, and the next read asks. The
page reads `GET /api/bridge/crimewatch` at each notice still; on the game port that is
answered from what is kept. A timer is started for a check with the GM's
`/cwatch <npc|weapon|pvp|suspect|disapproval> <seconds>`, in space.

**A rock, 2026-10-10.** A client knows an asteroid by its slim item: its type, its group, the
Asteroid category and a name. The type is the ore a laser takes from it. Which belt it is of
is not sent to a client, and how much is left in it comes from a survey scan
(`miningScanMgr`), not from the ballpark. The gateway's space snapshot has all three on an
asteroid's row, from the server's own scene (`miningYieldTypeID`, `beltID`,
`remainingQuantity`); the game port's has the first as the rock's own type and the other two
as null (`spaceProjection.js`). The web client's bots tell a rock by those fields, so until
the first was there no bot on the game port could mine. At one belt of 121 rocks the two
transports agreed on every rock's type, group and yield.

**A drone, 2026-10-10.** michelle's park keeps a table of the pilot's drones
(`stateByDroneID`): for each, its owner, the ship controlling it, its activity state, its type,
the controller's owner and its target. A whole state's `droneState` fills it (`Park.SetState`,
970), and `OnDroneStateChange` changes it (1496): on Tranquility an entry of a ballpark
update, a list of the seven, in each of nine recordings; on this server that and a notice of
its own. A drone that is neither the session's character's nor controlled by the session's
ship is taken out of the table. So a client knows these things of its own drones only. The
game port's park keeps the table the same way, and a drone's row in the space snapshot says
`controllerID`, `controllerOwnerID`, `droneActivity` and `targetEntityID` from it, or null
where the park was not told; the gateway says them of every drone. A launched drone comes
with the ballpark update after `ship.LaunchDrones` has answered, so the BFF's launch route
waits for it on the game port.

**A ship nobody flies, 2026-10-10.** A client is not told the server's word for an NPC. It
has three things. The type's group: the overview's table of NPC groups (`state.py`,
`GetNPCGroups`) keeps the police's (182), CONCORD's (301), the customs officials' (446) and
the faction navies' (288) apart from the pirates' and the missions'. The slim item's
`hostile_response_threshold` and `friendly_response_threshold`
(`npcs/client/entitystandings.py`): a threshold above nought is hostile whatever the pilot's
standing (`is_npc_hostile`), and otherwise the standing between the ship's faction and the
pilot is set against it; an attack on one that is not hostile is asked about first
(`consider.py`, 69). And the owner: one above the system's own (9999) and below the players'
(90000000) is an NPC (`idCheckers.IsNPC`), which is how the overview and the state service
know a thing is not a player's (`overviewWindow.py` 968, `state.py` 778). Tranquility sends 11
and 11 with a pirate, -11 with the law (27 recordings); this server the same, and -5 and 5
with the ORE mining fleet. An NPC's slim item carries no name. The game port's row says
"concord" of a ship of the law's four groups not sent as hostile, "drifter" of a Drifter
Battleship (group 1310), and "npc" of any other; that is the server's own word for every one
of its NPC profiles but the drifters'. The group alone is not: this server's catalogue puts
out ships of CONCORD's types that it calls NPCs and sends as hostile.

**A ship that compresses, 2026-10-10.** A ship running an industrial core and a compressor
is a compression facility for itself and its fleet. A client is told on the ship's slim
item: `compression_facility_typelists` (`itemcompression/__init__.py`), a dict of type list
to the range that list is taken at. `itemcompression/client/inSpaceCompression.py` lists the
facilities in range: the pilot's own ship at no distance, and any other ship that has the
dict, whose `charID` is a member of the pilot's fleet, for each list whose range the surface
distance is within. The compression window then offers an item only if some facility's
lists hold its type (`compress_in_space_controller.py`), and compresses with
`inSpaceCompressionMgr.CompressItemInSpace`. No recording of Tranquility has the dict. This
server sends the slim item again (`OnSlimItemChange`) when the modules start and stop; a
Porpoise with a Medium Industrial Core I and a Medium Asteroid Ore Compressor I was given
list 334 at 66,000 m. The game port's row gives the widest range and the lists, as the
gateway's does.

**An ice site and an ore anomaly, 2026-10-10.** A client reaches one by the scanner: the
sites of its system come with `scanMgr.GetFullState`, each with a label (`targetID`,
"MTK-452") and an archetype (27 an ore anomaly, 28 ice, 24 a combat site among those seen),
and the warp is `CmdWarpToStuff("scan", label)`. On the grid the rocks are ordinary slim
items of the Asteroid category whose type is what they yield: ice is one of them (White
Glaze, group 465). The site's own things are celestials to a client: the ice field's anchor
and its marker are of the asteroid belt's group (type 17774), an anomaly's marker is of
group 885, its scenery of groups 226 and 227. The web gateway's snapshot has the server's
own names for those four ("iceFieldAnchor", "siteObjectiveMarker", "universeAnomalySite",
"siteEnvironmentProp"); the game port's has what the category and group say. Rows were set
side by side on both grids in Halaima: the same count, the rocks the same but for what is
left in them.

**The map's stations, 2026-10-10.** `map.GetStationInfo()` is asked once by the client's UI
service and kept for the client's life (`uisvc.py` 246), and by five other callers through the
object cache. On the game port the first asking is answered with a cached reference, which
the transport fetches once (`objectCaching.GetCachableObject`); later askings on that session
are answered from what it holds, with nothing sent.

**Asking with a cached version.** When the client already holds an answer, it sends that answer's
version as `machoVersion`, and the server can reply "still good" instead of the answer. We always
send 1, so the server always answers in full. (What comes back is handled; see below.)

## Reading the server's answers in the browser

Member List's personal contact actions follow compiled `User.GetMenu`, `CharacterChecker` and `menusvc`:
a single other player offers Add Contact or Edit/Remove Contact, plus Block or Unblock. Self and multiple selected
members offer none of those personal actions; the Contacts window's own multi-edit menu is a different path.
The existing Contact Management and removal question are reused without opening the Contacts list. Add/Edit keep
the five positional `charMgr` arguments, removal passes the ID list, and BlockOwners/UnblockOwners each pass a list.
Buddy additions prime the held online state before a missing status lookup; removing personal contacts clears
their online entries, as native `onlineStatus.ClearOnlineStatus` does. No personal-contact write recording was found
in the recursive Tranquility corpus search. Alliance row contact actions are separate work.

The remaining corporation owner-menu administration flows and their native membership prerequisite are
sized in [Corporation owner actions](game-port-corporation-owner-actions.md). Membership is retained from
`GetEveOwners` and changed by notices; it is not a target's public corporation read.

Corporation member-row contacts follow compiled `CharacterChecker` 55-60/314-321 and
`SessionChecker.IsDiplomat`: director or diplomat, non-NPC targets, including self and multiple selections.
`menusvc` 604-609 and compiled `menuMerge.MergeMenus`/`_ExecMulti` keep a separate callback for each
eligible owner. A mixed selection offers Add for missing contacts and Edit/Remove for existing ones. Each owner
gets its own management window or removal question; canceling one leaves the others pending. This differs from
the Contacts list's bulk standing editor. The shared dialog host preserves those independent modal lifetimes.
Corporate dialogs use the existing fractional standing/label controls and corporation moniker writers; personal
dialogs retain their buddy/notification fields and personal scope. Live CEO, ordinary-member and non-director
diplomat checks cover single/self/mixed/multiple selections, cancellation, fractional readback and phone layout.
A second client's already-open Corporate Contacts view follows the actual organization notices, without another
`GetCorporateContacts`; successful writes are positional Add/EditCorporateContact(id, level) and separate
RemoveCorporateContacts([id]) calls. No exact corporate-write TQ recording was found. Alliance scope and its
executor-corporation gate are the next unit, rather than inferred from the corporation implementation.

The alliance server contact foundation is corrected in EveJS `82608f269` (native-rule assertion follow-up
`bba9a58b8`). Compiled corporate/alliance Confirm methods return decimal standings; the native address book keeps
the existing mask on Edit, keeps the other label field when one is None, and consumes mask-only organization
notices. Live TCP before/after checks show Edit2.5/multi-edit-1.5 preserved, bit60 retained, label name/color
preserved independently, and assignment/removal notices delivered to executor and non-executor alliance members.
AssignLabels now leaves an absent contact absent in both corporation and alliance scopes, as the native controller
opens Add separately and its cancellation creates no contact. A non-executor write remains refused. The resulting
standing, full mask and labels survive a stopped-store check and a fresh server boot/login. No exact alliance-write
TQ capture was found; this proves the compiled-client rules and local wire behavior. Alliance member-menu UI,
scoped labels/writers and the BFF's held alliance-notice amendments remain the next unit.

Successful personal contact writes now amend the held native `GetContactList` and `GetLabels` answers
(`addressbookService.py` 617-869, 1001-1147). Existing row descriptors, row order, unrelated fields and full-width
label masks survive; refused writes and replies belonging to retired sessions publish no local change. Label
deletion clears its bit on contacts and retires only the labels table, which native immediately reads again.
The client's local contact/label/block events refresh already-open personal Contacts views from those held answers;
these are local events, not server packets. A view discards superseded or unmounted reads.
Live browser captures show one `GetContactList` per selected session through Add/Edit/Delete/Block/Unblock,
label create/rename/assign/remove/delete and repeated member menus. Label deletion adds one `GetLabels` read.
Live TCP instrumentation also preserved bit 60 through low-bit removal and multi-edit, retained the previous answer
after an injected server refusal, and published no local event for a real reply held until after session release.
The replacement session read the server's persisted write. No exact TQ write/error/fanout recording was found;
this does not establish Python dict tombstone order across deletions or incoming personal-notice parity.

Corporation and alliance labels preserve no color (`None`) independently of explicit white (`0`).
Original compiled `addressbookService.CreateContactLabel` 1015-1020 and `GetLabelText` 1189-1202,
executed through the installed Python 2.7 DLL, keep None and render plain label text; explicit 0
adds a white color tag (`mailSvc.py` 31). EveJS previously changed a newly created uncolored label
to 0 on the next session's `GetLabels`; server fix `76299b459` preserves null in both organization
registries. Native game-port writes, rename, fresh sessions and a full server restart retain
None alongside explicit 0/2, assigned label masks and standing 2.5. Captured replies show None in
corporate CIndexedRowset packed rows and alliance KeyVals. The unmodified Corporation Contacts
and Alliance Contacts panels display those actual persisted labels; orange is colored, while
the existing browser swatch policy renders white and uncolored labels in its own text color.
The recursive TQ corpus has an empty corporate `GetLabels` reply but no matching label-write
recording, so this establishes compiled-client behavior and local wire parity, not a TQ write
default. CCP `blue/src/PyRowSet.cpp` 1151-1180 supports None in numeric DBRow columns.

Contact label IDs must fit the native signed mask: positive powers of two through bit 62.
The original `appConst.pyc` defines `maxLong = 9223372036854775807`; executing compiled
`addressbookService.DeleteContactLabel` 1072-1089 in all three scopes clears bit 62 but
leaves bit 63 assigned. CCP `blue/src/PyRowSet.cpp` 1208-1213 uses signed `PyLong_AsLongLong`
for the corporate label ID's DBTYPE_I8 column. Ordinary EveJS create/delete cycles previously
advanced a historical allocation hint to bit 63 and failed to marshal the reply after persisting
the label. Server fix `79e033278` reuses a free valid bit when the hint exhausts the range and
refuses a full 63-label book with the installed `LabelCantCreateMore` dialog. TQ allocation order
and the exact capacity refusal are not recorded; choosing the free bit is an emulator policy.
Live native calls covered 70 create/delete cycles per scope, full books, refusal without mutation,
bit-62 reuse after deletion, retained bit 60 and a full server restart. The page now sends a label
creation UserError through its ordinary client-dialog handler, matching compiled
`eve_exception_handler.handle_exception` 34-38. Refused creation adds no label and retires no
held label table. The browser shows the installed capacity wording and can create again after
deleting a staged label. These checks used actual server replies without a response hook.

Corporation > Members > Decorations now has its catalogue view (`corp_ui_member_decorations`
55-87): `corporationSvc.GetAllCorpMedals(corpID)`, then each creator's owner name, with title,
creator, `FmtDate(date, 'ss')`, the catalogue's blank reason column and `noRecepients` count.
Descriptions are row hints. The recursive TQ search finds the admin-panel capture at 1242-1249:
one-hour CachedMethodCallResult, CachedObject/GetCachableObject, then a Python list containing
two empty CRowsets. EveJS `a71777f32` now matches that recorded container and both typed descriptors;
the previous result was a tuple of generic rowsets and omitted graphics `layer`. Catalogue
title/description are WSTR, the date is FILETIME, and graphics preserve signed I4 color bits.
Populated layer values are unrecorded; preserving an explicit stored layer or using input ordinal
within each medal/part is an emulator policy. Other medal endpoint shapes remain unchanged.

The shared page decoder reads both CRowsets and legacy generic rows, including Unicode wrappers;
the existing member-menu Award Decoration selector uses it too. Native creation notices already
invalidate the BFF's object cache (`medals.OnCorporationMedalAdded` 122-132); the page now reloads
an initialized catalogue on that notice, including while hidden. Returning to it uses the held
native cache. Live empty payloads exactly matched the decoded TQ value. Native writes and the
browser verified Unicode titles/hints, dates, count 3, signed ARGB and graphics order, visible
and hidden notice refresh, and the existing award-selection list without a write on Cancel.
An ordinary member read all three decorations after a full server restart, with no award action.
Expanding a medal now builds its preview locally from those held graphics and adds the native
ViewAwardees group (`GetDecorationSubContent`90-110, `infosvc.GetMedalEntry`529-561).
Opening the second group calls `corporationSvc.GetRecipientsOfMedal(medalID)`; repeated
`recepientID` rows are grouped in Python integer-dict order, retaining the first issuer, date
and reason and counting every award (`GetMedalSubContent`112-149). Names are resolved recipient
then issuer in that order. The recipient's Show Info action opens the character window.
The live ordinary-member browser showed two and one awards, accented text, an empty recipient
group and a fresh read on reopening. Wire capture shows no recipient call for the preview,
one per recipient-group opening, and no award write from the observer. Data survives a full
EveJS restart. No new recipient wire-shape claim is made against TQ: the recursive corpus
search contains no such reply. The current server rows satisfy the compiled consumer.
List sorting preferences and the creation window remain separate units.

The installed medal atlases use uncompressed BGRA32 DDS. `/client-res/ui/texture/…dds`
now converts that indexed format to RGBA PNG while retaining the existing PNG route.
The masks and DDS header layout agree with CCP `trinityal/tests/WithValidRenderContextFixture.cpp`
60-87,111-132. Live Amarr ribbon and Compass medal output matched an independent DDS
decoder in every RGBA pixel and loaded in the browser at 256×256. Other DDS formats
(including DXT5) remain unsupported. The browser preview crops the native 128px quadrants,
preserves input order (ignoring the catalogue's layer field), and uses the native half-size
parts and truncated 20/128 overlap. Original compiled MapLogo/MedalRibbon.Startup/LoadData
execution confirms the mapping, sizes and untinted -1 sentinel. Signed ARGB channels follow
CCP TriColor.PyFromInt302-316 and carbonui.util.color.HextoiRGBA256-275; the SVG tint uses sRGB
channel multiplication. CCP Tr2Sprite2dContainer.cpp312-318 gathers children in reverse order,
so the first graphic is drawn on top. This is a minimal browser rendering; exact GPU sampling,
color-space settings and pixel equality with a full retail UI have not been measured.

The medal entry's Show Info passes type29496, medalID and held graphics, as
`MedalRibbonEntry.ShowInfo`869-872. Original compiled `InfoWindowMonolith` methods
read `GetMedalDetails(medalID).info[0]` twice: first title/description1450-1453,
then ownerID/numberOfRecipients675-687. The issuer header builds its logo, then
looks up a player corporation's ticker and owner name in that order. The icon uses
the supplied abstract graphics at render size256 in a 128×256 frame1347-1352.
The page preserves that sequence and ordinary window history/reuse. Live browser
verification showed accented text, correct large icon, count3/count0, issuer logo
navigation and history back to the medal. Wire capture has two details calls for
each reconstruction and none for minimize/restore. The original browser check
established field availability, but a later native encoding check found a server
defect: details title/description and recipient/received reasons were UTF-8 PyString.
Installed `eveprefs`7,205-206 sets CP1252; original compiled
`LabelCore._Layout`669 -> `stringManip.GetAsUnicode`39-44 therefore corrupts those
bytes. EveJS now explicitly returns PyUnicode for these persisted user texts.
Actual before/after replies run through the original compiled label and recipient
consumers show mojibake before and preserved accented text after (cdx2531).

Received-medal rows also need title/description: `charSheetUtil.GetMedalScrollEntries`
29-57 passes them directly to compiled `infosvc.GetMedalEntry`529-561, which reads
both without a details lookup. EveJS appends the missing Unicode fields after
its original seven columns. The actual old row raises AttributeError in that
original consumer; the fixed row constructs the entry and held graphics.
This establishes required named fields, not an exact TQ received-row descriptor.
There is no GetMedalDetails reply in the recursive TQ corpus search, so its exact
TQ container/descriptor/cache policy remains unverified.

Decorations uses ordinary `Scroll` with sortGroups/reverseGroupSortEnabled false
(`corp_ui_member_decorations.Load`39-49). Compiled `Scroll.SortAsRoot`914-951 keeps
medal groups in server order, places nested groups before preview entries, and
sorts recipient rows by the selected column key then the lowercase full label.
`_GetSortValue`721-758 strips only `font.DeTag`'s color/alignment tags, attempts
the native numeric/unit conversion, otherwise appends the remaining columns
without lowercasing them. Python 2 numeric keys precede text. Descending reverses
the completed list, including ties. The page follows this order and saves
`scrollsortby_3[corp_decorations_scroll] = [localizedHeader, reversed]` in the
account's user settings (`GetSortBy`674-689, `ChangeSortBy`966-992). A new column
starts ascending; clicking the current column flips direction. An unavailable
saved header falls back to the first header (`__LoadHeaders`1106-1125).
An empty opened recipient group shows the native NoItem label
(`PrepareSubContent`1314-1339). Live counts2/10, numeric/text reasons, group order
and preference survival across a full page reload were verified.

Every Decorations column, including the last, can resize. `Scroll`452-472 saves
`columnWidths_3[corp_decorations_scroll][localizedHeader]` in user settings and
clamps manual widths to24; an unmoved handle saves nothing. Double-clicking a
header or its handle fits the loaded column and saves the result
(`ResetColumnWidth`1133-1177, `ColumnHeader`353/158). Automatic measurement considers
headers and loaded tabbed rows, their indentation and two8px margins; native
`font.MeasureTabstops`306-343 starts at32. The browser measures its rendered font
and controls, so these are behavior/measurement-boundary matches rather than
native glyph-pixel equality. Saved widths remain fixed as groups load/collapse;
unsaved widths fit the current loaded text. Header click dispatch follows compiled
`uilib._TryExecuteClickHandler`957-981: first click sorts, second fits, with no
second sort toggle. This ordinary scroll has no column hide/reorder menu.

Group-open state belongs to the character's `listgroups`, rather than the user
section used for widths and sorting. Compiled `registry.Get/SetListGroupOpenState`
553-575 stores `listgroups[listID][str(medalID)].open`. The native identities are
`corpdecorations` for the medal and `corpdecorationdetails` for recipients
(`corp_ui_member_decorations`69-108). Compiled `ListGroup.Toggle`935-960 persists
the toggled group before reconstructing subcontent; closing a parent preserves
its child's preference. `Scroll.AddNode/PrepareSubContent`1300-1339 reconstructs
saved-open groups in catalogue order, including recipient reads for saved-open
children. A closed parent or child suppresses that read. The page keeps these
identities and character scope, reconstructs remembered groups after catalogue
loads, and re-reads a remembered-open recipient group when reopening its parent.

Creation is being built in three parts: the native medals service operation,
the layer designer, then window submission/wallet selection. The service operation
is `medals.CreateMedal`31-53: Director OR Personnel Manager, name length at most100,
description length at most1000, then top-level `corporationSvc.CreateMedal` with
three arguments. Title/description are Unicode, graphics are nested Python lists
from `MedalRibbonPickerWindow.SubmitData`553-560. Only an exact
`ConfirmCreatingMedal` refusal prompts with formatted bold cost and Yes suppression;
only Yes retries with fourth True. No returns normally, so the future window
still closes; role/length/other refusals keep it open. The flow's boolean reports
normal completion versus a displayed refusal, rather than a newly allocated ID.
Original compiled execution confirms these branches. No creation/confirmation
reply was found in the recursive TQ search; neither a mandatory confirmation nor
a fee amount is established. The current EveJS success path returns immediately.
The designer and wallet checks remain separate work; this service operation does
not add the window's missing-field or wallet checks to the service.

Member Details' Give Shares follows compiled `corp_dlg_edit_member.OnGiveShares`, `uix.QtyPopup` and
`bco_shares.MoveCompanyShares`: an integer quantity from 1 to 2147483647, initially 1 and selected, then
`corpRegistry.MoveCompanyShares(session.corpid, targetCharID, quantity)` on the corporation moniker. The button
has no client role gate; Cancel makes no call, and the action neither applies nor clears the member-profile
draft. Server UserErrors go through the ordinary client dialog handler. No transfer recording was found in the
recursive Tranquility corpus search; this contract comes from the compiled native methods (2026-10-19).

The wallet's `GiveSharesDialog.TransferShares` passes the holding's issuer as the first argument. Its corporate
owner is `session.corpid` (`CorpSharesPanel.GetOwnerID`), and `GetCorpRegistry` remains bound to that session
corporation. Corporate transfer authority and the debited allocation belong to that owner.

Bulk member grants use the compiled task-management `ExecuteActions(targetIDs, actions)` path. `bco_members`
forwards numeric GIVE cash/share actions unchanged. The native `SharesPanel.OnShareChange` rereads a visible
owner's holdings, so the server publishes the grant's share changes after settlement completes. Mixed cash/share
settlements keep the actual write's before/after allocations with their applied checkpoint; replay does not
reapply or republish a completed grant. No Tranquility bulk-grant call or notice was found in the corpus.

The corporation wallet's Shares / Owned by Corp view follows compiled `CorpISKPanel.GetMainTabs`,
`CorpSharesPanel` and `SharesPanel`: accountant or junior-accountant roles, owner from `session.corpid`,
`GetSharesByShareholder(True)` on tab selection and matching `OnShareChange` while visible. Corporate and personal
holdings are kept separately. Hiding either Shares view stops its notification-triggered reads. The Shareholders
subtab and the remaining share menus are separate work.

Compiled `corpvotes.ApplySanctionedAction` calls `voteManager.ActivateSanctionedAction(voteCaseID)`.
Share-creation activation now sends the corporate holder's `OnShareChange` after recording the action as applied;
an already applied activation changes neither issued shares nor the holding and sends no duplicate notice.
The live corporate view was verified on both an existing holding and an exhausted holding recreated by a vote.
The Tranquility corpus contains no activation recording, so its exact errors, notice order and selector remain open.

### Direct station trade: source audit and implementation slices

The receiver-side Tranquility recording `Archive/In station trade.txt` is the primary packet
reference. Lines41-48 show `OnTradeInitiate(initiatorCharID, Moniker)` with `idtype="charid"`.
The moniker state is `(trademgr, nodeID, (dockedLocationID, solarSystemID, traders, clientIDs), None)`.
Its first call is carried by `MachoBindObject(params, ('List', (), {}))`. The inline answer is a
`carbon.common.script.sys.row.Row` with headers `tradeContainerID, traders, state, money, items`:
the traders are a tuple, state and money are lists, and items is a Python set. The empty state is
`[None, None]`, not numeric flags. Repeated List reads are visible during window construction.

Original compiled `pvptradesvc.StartTradeSession` calls `InitiateTrade(charID)` and then List
twice on the path that opens a new window: once in `_ShowTradeSessionWindow`, once in
`OnTradeInitiate`. An incoming invitation starts at the latter and reads List once before
opening. `PVPTrade.ApplyAttributes` reads again, as do its two inventory controllers through
`invControllers.PlayerTrade._GetItems`. Reuse the same moniker; do not repeat InitiateTrade
to refresh the window. `CharacterChecker.OfferTradeWithCharacter281-290` requires one other
non-NPC character who is a guest of the current station or structure (`IsGuest403-408`).

`pvptradewnd.Cancel80-89` asks `ConfirmCancelTrade({}, OKCANCEL)`; refusal sends nothing and
confirmation clears the window's session reference before Abort. `_OnClose67-78` otherwise
attempts Abort, including after completion. The recorded completion path returns True from
MakeOffer and the close-time Abort. Accept constructs a KeyVal manifest containing the container,
both money offers and the union of both item sets; `OnTradeOffer` carries manifests/None, not
boolean state flags. OfferMoney and cancellation are client-code-backed but not exercised by
this successful item-only recording. Ship warnings, item restrictions, offer resets and completion
notifications must be ported with the exchange controls, before exposing a usable trade action.

The installed Python27 oracle executed the original compiled menu, outgoing/incoming controller
and Cancel methods (loop evidence cdx2924, with UI/RPC boundaries recorded). A cold live native
two-account probe cdx2923/cdx2931 verified the existing server's returned/received monikers,
carried List and subsequent bound List row shapes, True Abort and bilateral OnTradeCancel.
The probe used Two/test2 and Pilot1/test in Jita; it did not stage items or complete a trade.
The full store baseline was restored byte for byte afterward. Later slices below add the browser UI.

The same recording's lines386/388 prove corporate source inventory: a staged item changes from
owner98826653/location1052880078604/flag115 to the offering pilot's trade row. Server commit
`f17205f03` replaces the old personal-only gate for direct rows in the acting corporation's local,
non-impounded office division, using existing Hangar Take permissions. Staged ownership becomes
the offering pilot's; saved original custody remains available for cancellation. Native cold
before/after probes verified the authorized refusal before, then staging, exact abort restoration,
re-staging and bilateral manifest completion to the recipient afterward. Another corporation and
a division without Take remain refused. Nested corporate source containers remain unsupported.

Commit `16649b126` also sends the partial source stack's quantity debit to the acting pilot.
Native `invCache.OnItemsChanged219-307` and its container's `_ProcessItemChange1327-1430` consume
that row to update cached office inventory. A measured split of quantity2 into1 previously sent
only the new trade row; the corrected call also sends the remaining office row quantity1 with
old quantity2 to the source pilot. The counterparty receives the trade row. Server ledger
`f6f383aca` records those real packet probes, full fixture restoration and remaining limits;
interrupted-stage recovery, lockdown and impound cases were not exercised live.

Implementation order: carry returned and notified trade
monikers through the browser transport; port inventory/money/manifests and cancel/complete
controllers; then wire the guest-gated member menus and verify both pilots in the browser.
The generic returned-bound-object helper recognizes remote substructs. Direct Trade now has an
explicit transport path for its returned/notified Moniker: the BFF retains its actual node and
parameters and gives the browser a pilot-scoped carriage reference for that received object.
The reference is additional browser/BFF metadata and never goes to EveJS. List and Abort bind that
same retained object lazily; Trade is absent from the location-derived `MONIKER_SERVICES` table.
Consecutive trades can reuse identical parameters, so parameter equality cannot identify a trade
object. Cold production AppFlow evidence cdx2980 verified two rounds with identical params and
distinct containers/references, repeated List on each source object, receiver List and cancellation.
Actual wire2987 contains four carried List binds, two subsequent List calls, two InitiateTrade and
two Abort calls, no trade address-resolution request and no unmatched replies. A reference received
by the other pilot is refused before native dispatch.

The exchange bridge now sends single Add with `qty` and `flag=None`, and MultiAdd with the
Python list of IDs sorted by type volume times stacksize and `flag=0`, as the original compiled
inventory methods confirmed in cdx2995. OfferMoney carries a float even at zero; MakeOffer carries
the native KeyVal with money list and Python set of both sides' packed rows. Production AppFlow
cdx3003 staged a partial stack then two remaining stacks, offered0.25/0.50, read the manifest/None
state, accepted both manifests and received completion for both pilots. Wallets changed by the
expected net0.25 and close Abort remained valid. Decoded wire3007 confirms the argument kinds;
actual zero-money call3008 uses PyZeroReal0x0b. The TQ offer packet itself is LARGE PAYLOAD; the
client's decoded scatter at968 exposes its manifest fields, not exact packet bytes. No TQ money
offer was found.

The browser now owns each exchange in `app/directTrades.ts`, keyed by container and received
moniker. It opens the native-sized window for incoming trades even when that pilot is inactive.
The two native inventory requests share one List result (TQ220-226); actual cold browser capture
cdx3043 shows four opening List calls for the source and three for the recipient, without polling.
Money, manifests, item rows and closure follow the native notifications. Cancel asks the installed
ConfirmCancelTrade question and clears its close-time reference before Abort; OnTradeCancel
closes without another call. Completion closes with Abort. Both flows were observed in the browser:
a .25/.50 ISK exchange completed with a net .25 transfer, then a new exchange canceled after first
declining the confirmation. The actual wire contains two close-time Aborts for completion and one
for cancellation, all True. Self and non-guest member menus omit Trade; a present guest gets it.

Offer Money uses the current offer as minimum, wallet wealth as maximum, initial100 and digits2.
The native float field trims excess decimals (original compiled SingleLineEditFloat29-41).
Displayed offers use eveformat.isk's default zero decimals, while the manifest retains fractions;
QtyPopup's hint uses FmtAmt's grouped whole bounds. Original compiled currency13-18 and FmtAmt
confirm these separate display rules. The browser's first screenshot caught a clipped money label;
its corrected 64px header and whole-ISK labels were then checked visually (cdx3045).

Inventory stacks now drop through the same received trade moniker. Retained List rows supply
their actual source location; selected stacks use native type volume times quantity for MultiAdd,
with flag0, while a single Add uses flagNone. PlayerTrade1672-1687's active-ship, asset-safety-wrap
and static typelist gates run before those writes. The installed typeListLoader.pyd's lists36/142
match every inclusion/exclusion array in the same-build CCP data used by the app. Ship-hangar
rows now provide the existing inventory drag payload too. Native Shift quantity rules are ported,
but a physical Shift-drag has not yet been proven with the available input API.

Cold browser capture3069 proves local injector/wrap/active-ship refusals with no Add, two
volume-ordered MultiAdds, three single Adds, nonempty offers and acceptance reset after adding.
Declining the recipient's TradeShipWarning sends no MakeOffer; accepting it completes the Rifter,
three Acolytes and one Hobgoblin. Browser hangars and stopped custody read3082 agree on delivery.
Cancellation restores the drone stacks, including a subsequent reverse-direction trade. The
ordinary Member List's Trade entry is also verified. A drop on the other-party header routes to
the offering pilot's controller. Cold capture3099 also verifies a drop wholly inside the other
party's blank lower inventory: Add(item, Jita, qty3, flagNone) returns True, and both windows show
the offering pilot's three Acolytes. Cancel returns them to the source hangar. Temporary event
tracing3094 showed the earlier failed automated gestures ended on a newly entered element
without a final dragover or drop event; the successful gesture emitted both on the inventory
div. No application hit-area change was needed, and the diagnostic logging was removed.

Native GetItemLabel251-264 uses type names for ordinary drones and combines type/item names for
named hulls. The first nonempty browser check exposed an incorrect location-name preference;
it is corrected using IsValidNamedItem's existing ship/group predicate and TypeNameAndItemName.
Original compiled3070 confirms an ordinary drone makes no location-name lookup and a named ship
uses the combined label. Deploy-component naming remains beyond that existing predicate.

Personal ordinary containers directly in the current hangar or active cargo are now valid Trade
sources. Original compiled invCache.AcceptPossibleRemovalTax754-780 and GetCachedItem confirm
these parent chains require no price RPC. Cold capture3124 offers the actual container IDs as
sources, restores exact contents on Abort, then completes delivery of Acolyte3/Hobgoblin2 while
leaving both containers with their original owner/location/flag. The browser's open-container
view now follows item notices through the existing native inventory cache; it clears on offering
and refills on cancellation. Stopped custody3125 agrees with the recipient's hangar screenshot3118.
That capture did not exercise deeper/corporate ancestry or charged asset-safety recovery.
The later recovery, corporation and nested-container cases are recorded separately in the loop journal.

Single active fitted-source drags now follow the original compiled AddItems489-525 and
DogmaLocation1077-1134 (web `f85b40b0`, server `2eedd415b`). A loaded slot supplies its charge;
that path lists the source flag and sends UnloadAmmo(ship,module,(tradeID,actor,None),None).
A module binds/reads the destination self item, sends scalar UnloadAmmo and then inventory Add
without qty or flag, after any bank confirmation/breakup. Cold browser capture3469 offers
EMP20, both original guns and shield377, including a drop on the peer half. Abort restores the
loaded charge and original gun slot automatically; a new completed trade retains all four
original IDs in the recipient's personal Jita hangar across cold restart3481. The native charge
tuple previously failed the server's scalar-only preflight. No exact fitted-Trade TQ capture
or launched retail UI is claimed; multiple fitted selection is a distinct native producer.

Original compiled PlayerTrade.AddItems and BaseInvContainer._AddItem/__AddItem/
PromptUserForQuantity193-327 confirm the ordinary single-stack quantity branch: Shift asks
QtyPopup(max,0,max,NoMoreUnits), Cancel or zero sends no Add, and a stack of one bypasses the
popup. The browser's production dialog and native partial offer were checked cold with an
explicit DOM drop shiftKey boundary using the actual captured inventory drag payload: Cancel
and zero retain an empty Trade, choosing3 from50 leaves47 at source and offers3, and Pyerite1
offers without a question. Actual browser buttons accept the dialog and completed trade;
native custody reads confirm the source remainder and recipient split. This checks the
production handler, dialog and RPC, not a physical Shift gesture: the available drag input
reset the modifier, as retained event observations show. Physical Shift remains unverified.

Ordinary numeric multi-item Inventory moves now pass through the cached inventory wrapper
(original invCache1027-1063): active-hull refusal before locking, destination-self and persistent
lock skips, per-flow local move locks, a NEW acquired-minus-empty-charges set, then finally
unlock in the acquired set's traversal order. ItemLocking30-34/57-79 supplies a cached dictionary
for the current station/structure, invalidated by native OnLockedItemChange. Dictionary long
keys stay exact decimal strings; moved IDs are limited to safe integers. Single Add and other
inventory writers do not yet share this local broker; fitted/tuple producers remain separate.
Direct PlayerTrade1691 returns its session moniker and retains the controller's volume order.

Cold browser capture3568 moves eight original mineral stacks to cargo and back. The controller's
volume order9187..9180 becomes native set order9180..9187, with one station lock-dictionary read
across both moves. Original compiled MultiAdd/ItemLocking reproduces both actual wire calls
(agent4); fifteen installed-runtime order cases also match, including collisions and safe
near-2^53 IDs. All117 calls succeed without decoding errors. Native custody read3573 and cold
restart3579 agree exactly on original IDs/quantities, empty cargo and unchanged cash; no mutation
replay. That first fixture has an empty lock dictionary. Populated capture3595 subsequently
checks a mixed corporation blueprint selection: only the unlocked ID reaches MultiAdd. An
actual peer unlock notice causes a fresh empty dictionary read on the same page, then both
remaining blueprints move. Relocking invalidates the cache again; an all-locked selection
reads two keys and sends no move RPC. Original compiled consumers reproduce all four actual
MultiAdd lists and three browser cache invalidations (agent5). The outcome now states how many
items stayed at source, or "No items moved", without attributing a local skip to the server.
All276 calls succeed; cold restart3611 preserves both corporate locked originals and the
personal cargo original, with unchanged cash and no replay. Full staged baseline is restored.
Ordinary single Add now shares the broker with MultiAdd; other numeric inventory writers
remain follow-up work.
The prerequisite container metadata cache now keeps the actual backing self row separately
from listed contents and from a public own-item notice override. Original compiled
`invCache` constructor913-936, properties942-975 and List/ListByFlags1131-1205 show why:
a cold station hangar lists first, then lazily fetches its itemID/typeID; a numeric inventory
already has its ID, so listing it needs no self RPC. Canonical backing `GetSelfInvItem()`
reads reuse that reply until the container is dropped. A public own-item notice does not
prime a cold backing type. Owner/group consumers prefer the public notice, then backing
self, then an already-listed row (OnItemChange295-300, GetCorpKeys645-657).
Actual production transport3628 verifies both empty listing forms, one self read per
container lifetime, numeric listing without self, and fresh metadata after reselection.
Closed wire3630 has252 successful calls including100 from the real browser; its empty item
hangar and populated Badger cargo render normally. Lifecycle3634 verifies incoming corporate
contents without a parent listing or relist, ownership notices, and real role resignation:
the now-personal container stays held while the still-corporate container is rebound and
receives the server's access refusal. The raw metadata route represents backing
`_SetItemData`, not every native public `GetItem(force)` behavior or a capacity cache.

**Ordinary single Add and shared locks.** Original compiled `invCache.Add998-1025` rejects
the active hull first, evaluates the destination ID, returns None for explicit zero quantity,
checks persistent locks before self-placement, then evaluates the destination type before
acquiring `lockAddItemToContainer`. A contender uses the holder's reason and values. The
default MultiAdd holder produces `ItemIsLocked` with the client's already-formatted held date
and `NoReasonWasSpecified` text; a named Add holder carries only its actual `containerType`.
Installed native localization and the existing web formatter agree (agent4). Add preserves
the remote result; both paths release by ID, including on an early valid item notice, with
no acquisition token. Same-pilot invalidation replaces the broker's current map; an old
finally still operates on that current map (agent5). Whole-pilot retirement stays isolated.
The structure hangar alias seeds its numeric ID, avoiding a station-only metadata lookup.

Cold browser42 refuses the locked blueprint locally, then moves original Tritanium50 to
cargo and back (3659/3661). StationPanel disables overlapping UI actions; the held HTTP
request3660 proves no browser contention. Production flow3663/3664, with deliberate request
gates and real replies, verifies Add-held MultiAdd skips and both contention payloads.
The production helper/API then forwards actual item notices before a gated first completion;
the same original Nocxium30 moves back before that first operation returns, and both Add
results retain their numeric ID. Closed3667 has218 successful calls,29 notices and no
unmatched/decode errors. Cold3670 preserves all eight exact stacks, empty cargo, all three
corporate blueprints, the original persistent lock and unchanged balance without replay.
Trace diagnostics, tuple/fitted producers, natural scheduler timing, other numeric writers
and universal public GetItem/capacity semantics are outside this ordinary move slice.
The prerequisite server fix ee5ac2acc sends the subscribed four-argument lock-change event;
actual lock/unlock notices pass original compiled cache handlers (agent3). Notification audience
and lane are not established by a Tranquility lock-change capture.

The remaining ancestry/removal-tax paths, inventory view controls, item menus/tooltips,
splitter persistence and additional character-menu placements remain follow-up work.
Corporate and active-ship-bay source coverage is recorded
per case in the ignored loop journal; the older drop verification above covers its own fixture.

`src/gamePort/bridgeJson.js` maps what the game port decodes to onto the JSON the web gateway
emits, which is what the browser's decoders were written against. How well that holds, read by
read, is [`game-port-parity-report.md`](game-port-parity-report.md); what is decided about the
differences is in the plan's Phase 2 section.

One thing to know when a call answers None for no reason: the server answers None when a handler
or its own marshaller throws. The only trace is a `[PKT] ERR` line in `eve.js/_local/logs/server*.log`.

## Still needs a recording of the real client

The `?` rows above. `scripts/record-game-port.js` is the tool: it sits between any client
and the server and writes every frame; its `describe` mode prints each frame's kind, addresses,
call and value types, which is exactly what the `?` rows need.

To record without touching the client or its launcher, start eve.js with `EVEJS_SERVER_PORT=26005`
(a stock setting) and run the recorder on 26000 forwarding to 26005.

This has not been done. The client must be started through the eve.js launcher, whose checks keep
it from reaching CCP's servers, and on 2026-10-07 its `start.ini` pointed at a server other than
this machine, so a local recorder would not have seen it.
