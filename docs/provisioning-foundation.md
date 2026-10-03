# Shared provisioning Review and Replenish

Definition source and physical item source are separate selectors. Definition
identity pins account/provider, corporation, fitting ID/date and the complete
definition fingerprint. Equipment equality compares hull, fitted slots and
declared operational carried equipment without physical item IDs or unrelated
cargo. Identical fitting definitions expose alternatives rather than choosing
the first. A hull name is never a fitting name.

Supplies have a separate declared quantity/location policy and fingerprint.
`deficit = max(0, target - verified current)`; loaded/carried policy counts each
physical quantity once. Equipment VERIFIED can coexist with supplies LOW.
Incomplete reads produce UNKNOWN, not verified emptiness.

Personal local stock and exact local corporation divisions are supported by
qualified adapters. Corporation owner, office/contents location, division and
direct Query/Take authority are revalidated. Query is not Take. Assigned title
roles remain UNKNOWN. Strict corporation sources never fall back to personal.

The shared pilot reservation and gateway dispatch fence exclude conflicting WC
mutations. `replenishment-custody.json` records credential-free evidence before
every dispatch. Persistence failure prevents dispatch. Source/destination
rereads and exact deltas prove completion, including same-type merges.
Uncertain results block until read-only reconciliation; ACK is not completion.
Partial stock shortage leaves independent supply LOW/MISSING status.

One WC writer per writable data directory is required. The journal is not a
multi-process ownership lock. Initial mutation support is docked NPC stations;
structures, remote stock and unqualified bay routing remain unsupported.

Accepted bounded disposable live evidence covers personal/corporation deficits,
repeat no-op, partial shortage, stack merging, Take refusal and custody recovery.
Publication reconstruction retains those mechanisms and their focused tests.
