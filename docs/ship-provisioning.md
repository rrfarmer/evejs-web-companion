# One local new hull

The shared engine extends replenishment custody, rather than introducing another
inventory transaction model. A pinned Review is revalidated before mutation:
one hull acquisition → assembly proof → exact boarding → slot-specific fitting
→ carried equipment/supplies → fresh authoritative Review.

Packaged stacks may split or retain an ID. Authoritative source depletion and a
unique resulting singleton identify the target. Multiple plausible singletons
block. ACK alone never identifies a ship. Fitting may partially commit; each
step has durable before/after evidence and reconciles committed items before
continuation. Recovery advances only from proven state and never rolls back an
unrelated ship or blindly repeats acquisition.

An exact current equipment match is ALREADY_SATISFIED with zero hull acquisition.
Same hull with different equipment is not a match; the original ship is
preserved. Supplies remain independent, including VERIFIED equipment with LOW
supplies. The historical refit macro is not used as completion proof.

Initial new-hull support is ordinary published T1 frigates, ordinary fitted
modules, qualified drone/carried equipment and cargo-carried supplies at local
NPC stations. Required rigs/subsystems, destructive refitting, rig replacement,
structures, remote/secure/nested stock, singleton equipment stock and
unqualified specialized bays visibly refuse. Matching/Review can cover broader
equipment without claiming those hulls are provisionable.

Accepted disposable live evidence covers personal/corporation acquisition,
packaged stack splits, retained IDs, exact boarding, partial fitting,
restart reconciliation, repeat no-op and independent LOW supplies.
