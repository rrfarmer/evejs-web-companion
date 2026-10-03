# Combat utilities, Phase 1

The shared `fight-with-drones` ladder consumes fitted capabilities. Utilities do
not add Builder steps, select player targets, change the hold doctrine, or enable
MCC Defender. The stationary `fight-the-rats` contract is unchanged.

## Enrolled capabilities

| Family | SDE group / activation effect | Automatic policy |
| --- | --- | --- |
| Stasis webifier | 65 / 6426 | Exact locked NPC primary inside effective optimal range |
| Target painter | 379 / 6425 | Same target/range contract, with combat drones or loaded supported weapons |
| Sensor booster | 212 / 2670 | Combat self-buff, understood unscripted or scripted mode |
| Tracking computer | 213 / 4559 | Same self-buff contract, only with supported turret tracking |
| Omnidirectional tracking link | 646 / 6557 | Same self-buff contract, only with classified combat drones |
| Ordinary capacitor booster | 76 / 48 | One cycle for an existing blocked required-action cap gate |

All other groups stay unenrolled. This includes Phase 2 tackle, neut/nos, ECM,
damps/disruptors, strategic modules, ancillary repairs, and AoE modules.

## Observation and authority

`combatUtilities.ts` joins exact fitted slot/item/type/online state, ship-scoped
bound dogma, loaded charge state, cargo, and the current ship's capacitor ratio.
The authenticated read-only `combat-utility-types` endpoint supplies pinned SDE
group/effect and charge facts. Effective cycle, capacitor cost, range and falloff
come from bound dogma. Malformed or foreign active-effect dictionaries are
unknown; they cannot prove that a module is idle.

Targeted utilities use optimal range conservatively. Falloff is observed, but
probabilistic falloff does not authorize an automatic application. Before
dispatch the issuer rechecks the exact locked NPC, ship identity, geometry,
range, module mode, capacitor, and current runner generation.

Known scripts are deliberately limited to sensor range/resolution/ECCM and
tracking/optimal-range modes supported by the pinned data. Unknown scripts stay
off. Pre-existing active modules are neither claimed nor reassigned.

## Outcomes and settlement

`combatUtilityIssue.ts` dispatches once and rereads the exact module. Continuous
effects require its exact activation effect and target binding; an ACK or another
active module cannot confirm success. Definite refusal remains retryable under
the runner's existing bounds. Uncertain mutation enters existing reconciliation
custody and is not blindly replayed. Generation retirement cannot commit an old
mutation.

The existing invocation ownership ledger includes utilities it activated. On
target change/death/range loss, an owned web or painter is retired once and its
OFF state is observed before reassignment. Combat settlement and public Stop
reuse the same bounded owned-module cleanup. They do not stop unrelated modules.
Pending retarget shutdown is also recorded in the shared settlement ledger, so
changing from combat to Stop/settlement cannot replay an uncertain OFF request.

## Capacitor demand and charges

There is no universal injection percentage. Required propulsion keeps its
existing 30% start floor; a usable idle local repairer keeps its existing 20%
start floor. Emergency retreat and repair OFF maintenance run first. An idle
ordinary cap booster may supply one cycle only when such a useful action is
blocked by its established floor. Optional buffs do not trigger injection.

Charge selection requires a declared accepted group, required numeric size when
present, and known charge volume that fits module capacity. EveJS ordinary cap
boosters omit numeric charge size and use physical capacity/volume sizing;
missing physical metadata fails closed. There is no incompatible fallback.
Loading and activation attempts are bounded. Injection confirmation requires
both an exact charge-count decrease (loaded plus cargo, allowing auto-reload)
and a fresh absolute capacitor increase. Dry/no-demand/sufficient-cap states
issue no injection.

## Focused verification

`combatUtilities.test.ts` covers the new contracts. `combatCore.test.ts` is the
single adjacent regression boundary. Accepted core movement, drone rotation,
strict weapon reload and hosted Start qualification are reused.

Live qualification uses public hosted Start, isolated WC data/ports, disposable
Test identities, and supported gameplay/GM routes. Runtime source and the
historical Defender record remain unchanged.
