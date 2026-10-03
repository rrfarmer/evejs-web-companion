# Standalone Defender combat core

Defender composes the existing `fight-with-drones` block and shared runner safety.
It does not introduce another combat engine or enable the MCC DEFENDER role.
`fight-the-rats` remains the stationary block.

## Routine and safety authority

`modernDefenderCopy` makes an independent document from the historical routine.
Storage, home and patrol bindings remain the caller's responsibility. It removes
the hostile→raw launch watch, replaces stationary combat with mobile combat, and
places Hull <30% → dock and pause first. Thirty percent is this routine's current
policy, not a universal safe threshold. Serious hull damage does not automatically
repair and resume. The historical armor <30% station fallback is retained, with an
ordinary local armor-repair watch at that same threshold. An absent or already
working repairer falls through.

The shared runner checks explicit escape/pause authority before optional work,
including an upgrade from a recoverable repair trip to terminal escape. Unreadable
health beside hostiles cannot be masked by optional combat. Recovered repairer OFF
maintenance runs before persistent optional watches. Existing repair capacitor
floor (20%) and propulsion start floor (30%) remain separate policies.

Repair watches are thermostats explicitly authorized by the document. Their
maintenance is distinct from the combat invocation's ownership of temporary
modules. Emergency travel takes precedence over optional settlement work;
docking authoritatively retires the ship's space effects and orders.

## Movement, drones and ordinary tank

The mobile ladder retains whole-grid wave detection, bounded closing, stand-off
band, threat priority, sticky threat anchor, pre-lock, shared AB/MWD policy and
damaged-drone rotation. Weapon reach never sets the movement band. A user hold
override is explicit doctrine; the computed band otherwise serves drone control
and observed threat reach. AB remains distinct from scram-vulnerable MWD.
Unknown capacitor cannot authorize a new propulsion activation.

The combat block owns bounded combat-drone launch, target assignment and rotation.
No separate hostile launch watch competes for interrupt priority. The launch
receipt supplies exact launched identities; unrelated roster growth is not
claimed. Existing per-drone confirmed/refused/uncertain engagement semantics are
preserved. Uncertain engagement stops visibly for review rather than replaying a
whole flight.

Only fitted ordinary continuous shield/armor hardeners enter the mobile hardener
list. That list is independent of the observation's starting macro: one decide
tick may finish Undock or travel and enter combat immediately. ADC, Emergency Hull
Energizer, ancillary repair and utility families are excluded. Passive Damage
Control, amplifiers, extenders, drone damage amplifiers and rigs need no activation.

## Weapon and reload contract

`combatFit` uses the current fitted item/type/ship/slot identity and fresh effective
bound dogma. It reads loaded charge sublocations as well as modules. Ordinary
weapon cycle classification accepts speed (51) or duration (73).

The conservative turret envelope is effective optimal (54) plus one falloff (158),
with known positive tracking (160) and a known loaded charge. It is a range
envelope, not a calculated hit probability: angular velocity, signature and a full
application model are not claimed. Missile reach uses effective charge velocity
(37) × flight time (281, milliseconds). Missing range/charge evidence skips that
weapon. Longer guns may fire while shorter guns remain idle. Neither asks movement
to close merely to improve a short gun.

Scripted reload uses the exact unbanked weapon and cargo stack. Both accepted
charge group and charge size must be known and match. Unknown or banked weapons
are excluded; there is no incompatible largest-stack fallback. Three attempts
per weapon/invocation bound definite refusals. No compatible ammo leaves the
remaining combat capabilities usable.

`issueCombatReload` revalidates pilot/run/ship authority after its fresh read,
dispatches once, then observes the exact loaded type and positive quantity. The
production path allows at most 21 reads separated by 750 ms, accounting for the
server's deferred reload cycle. These are read-only reconciliation calls. Retired
authority or unconfirmed completion pauses mutation custody; no second load is
sent after an ambiguous result. Ordinary bound-dogma support is reused, without a
runtime patch or invented ammunition.

## Module outcomes and settlement

The BFF preserves the requested module ID. Confirmation requires that exact module
active, or an authoritative mapping to its bank master. An unrelated new active
module is insufficient. Activation false is a definite refusal; absent evidence
or identity mismatch is uncertain. Accepted deactivation can remain active until
its cycle boundary: the BFF observes without redispatching.

`combatOwnership` records only modules, locks, exact drone orders, movement and
fleet calls initiated by this invocation. Pre-existing active modules and locks
are left alone. A clear grid or explicit combat `until` performs bounded observed
settlement before DONE:

1. Retire the owned fleet call.
2. Recall the controlled owned drone cohort and observe disposition.
3. Stop owned temporary weapons, propulsion and ordinary hardeners.
4. Observe deferred cycle stops without sending them again.
5. Stop the owned movement order and observe STOP.
6. Release owned unnecessary locks and observe absence.

Unreadable state blocks completion. Changed bank ownership fails closed rather
than switching off unrelated bank members. Settlement has a 90-observation bound;
failure requires human review. Pending OFF remains settlement custody, not a
successful world-completion claim. Definite refusal remains safely retryable.

Stop retires decisions, waits for in-flight work, and runs the same settlement
under generation/deadline guards. Uncertain cleanup intent is retained before
dispatch. Start, Resume and controller replacement cannot bypass unresolved
custody. Old generations cannot dispatch further cleanup or complete a new run.

## Reuse and deferred work

The generic layers are combat fit/ammo facts, module outcomes, action ownership,
settlement and the existing mobile ladder. Standalone Defender owns safety policy,
home/patrol bindings, yield and station fallback. Future MCC Standard Defender
should supply its profile and patrol policy through existing hosted ownership,
preflight, operation lifecycle, recovery and Stop/Restart handling. It should use
this combat core, not a second MCC combat engine.

Targeted utilities, self buffs, cap boosters and ancillary repair remain unused by
this core. A future utility framework must first add explicit classifier,
observation, targeting/range/charge/cap and outcome contracts, then enroll its
actions in the same ownership/settlement interfaces. Exact turret application,
safe bank ownership and broader weapon families require separate qualification.

Qualification must use disposable Test identities, fresh authoritative reads,
focused deterministic boundaries and a sustained gameplay run. Unit tests alone
do not establish live acceptance; task-owned QA state and journals are excluded
from product commits.
