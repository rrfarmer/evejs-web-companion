# Mining Command Center

Open **MCC** from the WC header or visit `/mining-command-center` directly. The
Command Center opens as a separate page with its own sign-in form, without a
pilot workspace. An operation coordinates
server-hosted pilots around one current resource target. Each pilot still uses
Farmer's ordinary script runner and EveJS authority; the Command Center owns
the target reservation, membership, logistics and Stop policy.

## Define an operation

Choose an anchor system, one target family, participating pilots, each pilot's
role and a finite run limit. Standard miner and hauler profiles use the shared
operation target. Custom routines must satisfy the operation target contract.
One member's failure degrades that member without silently ending healthy runs.

| Family | Supported behavior |
| --- | --- |
| Belt | Shared belt target, ordinary ore mining and belt surface travel. |
| Ore Anomaly | Current-system scanner identity and Farmer's ore-site behavior. |
| Ice | Ice-site identity and online Ice Harvesters; ore-only fits are refused. Ordinary Mining Drones are not used for Ice harvesting. |

GAS and adjacent-system scouting are deferred.
Resource preferences order eligible choices; they do not create a remote scan
or permit two active operations to reserve the same target.

## Standard Defender

Select **Standard Defender** and an ordinary saved corporation fitting, with
the same preparation source and supply policy used by other operation members.
Readiness verifies the observed ship, saved equipment, skill prerequisites and
at least one supported damage path: combat drones or turrets/launchers. Every
fitted weapon needs proven compatible loaded or carried ammunition. Known
supply shortages may use the existing preparation engine; final readiness must
observe ammunition aboard under the hosted owner. Unreadable readiness, a busy
pilot and unresolved provisioning custody block MAIN. There is no prescribed
hull or separate Defender equipment loader.

Defender follows the operation's current owned Belt, Ore Anomaly or Ice target.
It neither reserves a site nor patrols independently. At that site it uses the
shared `fight-with-drones` core, including existing fit-driven Phase-1 utilities.
Utilities are optional; their absence does not fail readiness. Acute hull
damage below the current 30% policy triggers home/dock/pause before combat or
armor maintenance. Repair without an applicable fitted repairer falls through.
The operation's delivery destination supplies the emergency home; a structure
must be dockable by the Defender, but Defender does not need freight-delivery
corporation access merely to dock there.

On target relocation, owned combat state settles before travel to the new
target. The operation run and target claim are reread before new combat/site
mutations; an old decision cannot start work at the retired target. Missing
target authority settles prior owned state and waits. Clear-grid completion
uses the core's observed settlement and a four-second yield before rechecking
the current operation site. Operation Stop uses ordinary hosted settlement and
release; uncertain cleanup retains ownership. Custom Defender routines remain
unsupported. No Phase-2 EWAR or separate MCC combat engine is enabled.

## Command / Support

An optional Standard **Command / Support** pilot uses the ordinary hosted
script runner and the reusable Mining Support controllers. Select existing or
managed fleet membership, Core/fuel policy, compression, self-mining, tractor,
collection and support-loss policy. Support-bound miners use the separate
**Fleet Miner** behavior with observed fitted mining reach and a fresh mining
burst envelope. Definitions with support disabled retain the legacy profiles.

Fleet observations come from the currently claimed members' own flows. They
are ephemeral: neither saved fleet IDs nor cached coordinates authorize a
join or movement. The Command pilot follows the operation's owned target;
positioning covers its miners, while a hauler remains free to visit delivery.
Support-bound Standard haulers join the selected support fleet through the
reusable Join support fleet block. Delivery trips do not become positioning
recipients. With support disabled their original profiles remain unchanged.

Unavailable support enters a 30-second recovery interval. Thereafter the
selected policy pauses productive mining, explicitly uses ordinary mining,
or starts normal operation Stop. Required Core availability gates that same
policy. Continue-without-Core remains visibly degraded. A verified full
collection hold yields a settled nonempty container claim to ordinary hauling;
unresolved transfers keep custody. No fuel is rerouted or destroyed.

Stop and deadline cancel new support work, settle miners and controlled
drones, release settled tractor custody, observe compressor and Core shutdown,
verify mobility, and observe fitted bursts inactive before Parking/release.
Deferred cycles require actual lifecycle observations. A fresh docked hull
uses the existing hosted docked safety boundary; unresolved inventory custody
still blocks release. Missing hosted ownership cannot prove successful Stop.

## Deliver mining freight

**Hauler Service** lets miners jettison mining freight for service haulers. The
operation records the exact containers created by its miners; haulers do not
collect unrelated cans. The existing container claim service excludes a second
hauler from an actively serviced operation container. If the can's identity
cannot be confirmed after jettison, collection blocks for reconciliation.
When the resource target depletes, miners settle modules
and controlled drones and dump remaining partial holds. Haulers retain the old
logistics target until its grid and freight are confirmed clear, including
partial deliveries, then catch up to the current operation target.

**Self-Unload** settles equipment and controlled drones, delivers the mining
hold's eligible freight, confirms its empty hold and returns to the same
operation target. Unrelated cargo and equipment remain aboard. Standard
delivery can use the pilot's personal hangar or a specific corporation and
division. Corporation delivery is strict: a personal-hangar fallback, wrong
division, partial result or unreadable post-transfer state does not count as
success.

An NPC station or accessible player structure can be a delivery destination.
Structure delivery requires current docking access. Corporation delivery there
also requires an online office service and an accessible corporation office.
A dockable structure alone does not prove corporation inventory access.

## Stop and Parking

Parking is separate from delivery. Choose Stay, return and dock, or return,
unload mining freight and dock. Its destination may be a station or accessible
player structure. Unload Parking can target a personal hangar or an exact
corporation division. The latter uses the same strict corporation postcondition
as delivery. A blocked member remains visible as blocked/degraded; the
operation does not report parked merely because Stop was requested.

The operation uses the shared drone recall and hosted Stop lifecycle. A
confirmed empty controlled flight precedes ordinary relocation and terminal
cleanup. Repeated Stop is idempotent. After a process restart, current target
and live ownership are reread rather than reconstructed from saved observations.
The first owned grant expiry invokes shared Stop while hosted claims remain
held, then applies Parking and releases ownership after confirmed settlement.
Expiry requests share an in-flight manual Stop. A missing member or undocked
finalisation remains visibly failed; it cannot produce STOPPED/PARKED success.
Stay mode at expiry uses the ordinary hosted home/dock fallback. This safety
cleanup does not extend the productive run grant.

## Travel Assist and limits

An owned, restart-safe operation run can recover a positively lost session
without renewing its grant. `POST /api/bots/:botID/reconnect` also requests a
controlled reconnect for the owning account. The host freezes its existing
runner, fences the retired request generation, waits for issued work, and
reselects through the normal owned session path. Lost-drone recovery, the same
hull and fit, fresh scene/fleet and current operation target must be proved
before productive work resumes. Recovery has three lifetime select attempts,
a 30-second retry interval for positively lost sessions, and a three-minute
bound capped by the original expiry. Stop and expiry supersede resumption.

Other scripts containing non-restart-safe actions refuse this reconnect path.
The generated Hauler Service miner has a narrow same-process ore-jettison custody
exception while its static `restartSafe:false` remains unchanged. Exact fresh
source/can provenance must prove a recoverable outcome; pending or ambiguous
mutations retain control and cannot be blindly retried. See
[jettison-custody.md](jettison-custody.md). A restart-safe hauler or COMMAND run
remains eligible only while its original ownership is current.
Trusted HTTP notification drains use the same dispatcher as the live stream;
an invitation carried by a roster, scene or script read is retained only for
the pilot/session generation that issued that read.
Script and drone observation responses preserve successful flight, bind, bay,
ship-info and scene drains together, including partial bay/ship-info failures.
Recovery `READY` requires the role's recovery preflight. A support-bound HAULER
must freshly prove membership in its surviving selected support fleet before its
long-lived loot step resumes. COMMAND's normal reconciliation still gates anchor
and support readiness; an acknowledged invite supplies no membership proof.

Pending inventory, container custody, module or movement orders block automatic
resumption with control retained. A lost issued write remains unresolved even
if its response arrives after recovery started; Stop/Parking cannot release
that custody as success. An interrupted recovery roster requires review after
process restart. Session-scoped intent is re-derived after safe reacquisition;
runtime fleet IDs and anchors are never durable recovery authority.
Fresh exact module states can settle completed orders while the runner is
quiesced. Superseded movement intent can be retired only after observed STOP,
settled speed and unrestricted movement/warp; this does not claim arrival.
Unresolved transfers, claims and other pending work still retain control.

For managed COMMAND recovery, a fresh uniquely surviving fleet can supply an
invitation through one currently owned operation member with a fleet grant.
The existing support fleet reducer chooses the ordinary invite; COMMAND then
accepts it and proves membership through its normal reconciliation loop.
Unknown intended-member authority, conflicting surviving fleets, or retired
peer ownership blocks the invitation. Recovery never creates a replacement
fleet while members positively survive.
The invitation is bound to that exact fleet; the runtime's membership gate
refuses it if the inviter leaves or changes fleets before dispatch.

Optional Travel Assist controls only an AB or MWD it activated for the current
approach. It keeps that module cycling during the approach, switches it off
near the target or when authority changes, and leaves externally activated
modules alone. A confirmed module command is distinct from observed physical
acceleration. The current hosted-run ceiling follows Farmer's 72-hour grant
policy; no unlimited or automatically extended run is created.

Operation definitions remain in `data/mining-operations.json` version 1.
Current gameplay acceptance and environment-specific limitations should be
reported separately from this product guide.
