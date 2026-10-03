# Offline Review and runtime observation

`/ship-provisioning` is the account-wide standalone control plane. It lazy-mounts
without ordinary cockpit restoration/polling. Review never selects or acquires a
target. Fitting provider and physical source remain independent. Exact matches,
identical alternatives, modified equipment and unknown fits use shared contracts.

The read-only 0.12.9 extension is classification D. It validates account ownership
and corporation privacy, and projects hull, fitted/carried items and local stock.
COMPLETE/PARTIAL/UNAVAILABLE quality and synchronous world-cache double-read
evidence prevent partial roots or mixed reads from claiming verified absence.
This is not a universal atomic storage revision. Expired/unreadable control is
UNKNOWN; observation does not expire leases or notify/replace owners. Query never
proves Take: candidate corp stock shows TAKE UNKNOWN / REVALIDATE ON APPLY.

## Portable verification

Set `EVEJS_CLEAN_REFERENCE` to an immutable clean 0.12.9 directory. Alternatively,
set `EVEJS_REPO` to an existing EveJS Git history; the fixture recovery script
recovers hash-pinned source into a temporary directory. It does not check out or
modify EveJS. No CodexLab folder layout is required.

Run `node --test runtime-patches/provisioningObservation.test.js
runtime-patches/provisioningComposition.test.js` with that environment configured.
Composition uses disposable source fixtures, syntax checks and semantic seams;
it never starts the gameplay server. Existing-file hashes record provenance and
fixture identity, not exclusive whole-file ownership.

## Setup order

Follow the existing Upwell and Pilot Training setup notes, then:

1. Upwell: `dockable-structure-search.patch`, `accessible-structure-services.patch`.
2. Factory where needed: `live-factory-gateway.patch` with `--unidiff-zero`, the
   gateway-runtime-only hunk of `pilot-training-generic.patch`, then
   `factory-gateway-placement.patch`; install the complete Factory helper.
3. Plan the observation patch with `node scripts/provisioning-runtime-patch.js
   --root <runtime>`. Expected seams must be unique; unknown edits fail closed.
4. Verify composition before deployment. Never write to the clean reference.

Deployment requires backup evidence and the explicitly mutable basename
`EveJS-0.12.9-test`: pass `--write --evidence <backup-directory>` only to that
reviewed runtime. Reuse an already matching deployment. Restart through the
normal Launcher only if deployment actually requires it.

Affected runtime paths are recorded in
`runtime-patches/provisioning-observation-provenance.json`. Accepted live evidence
includes offline exact/modified/LOW states, incomplete observation, busy ownership
and corporation definition/stock reads without target selection.
