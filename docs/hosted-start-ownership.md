# Public hosted Start ownership

`POST /api/bots/start` reserves the character and caller session while validating
and handing off pilot control. It passes that exact private Symbol to
`botHost.start`, which forwards it to the production ownership probe. Both maps
must contain that same Symbol, including after asynchronous ownership reads.
An operation name, character ID, different session or retired Symbol grants no
exception. The capability never comes from HTTP input or persisted bot state.

The host claims the character before `beforeStart`. That callback receives the
new private hosted claim capability. After any caller cockpit has been safely
released, the route verifies the claim and retires its character reservation.
The caller session remains fenced until the request finishes. This transfers
authority to the normal hosted lifecycle once, and allows acquired-session
failure cleanup and ordinary Stop to release the host's session.

For a free caller, a fresh runtime status must prove the pilot offline before
claiming. Public hosted selection also uses the existing atomic free-only
gateway selector. This closes the external-owner race without changing retail
login policy, adding a registry or changing the runtime. The existing selector
also refuses CEOs and unknown corporation authority and uses its established
session lifetime; these runtime restrictions are retained. A hosted claim alone
does not authorize takeover. Resume does not inherit a retired Start capability.

On failure, exact comparisons clean only this attempt's reservations. Existing
hosted claims and held cockpit rows continue to fence unresolved release or
write custody. A definitely released caller may be restored only after hosted
ownership has ended, under a separate private restoration reservation, fresh
offline proof and free-only acquisition. Retired Start callbacks cannot release
or restore a new generation.

Customs-export keeps its exact-self probe and its existing runtime offline
checks. MCC's existing explicit operation/run handoff exception is unchanged;
ordinary public Start cannot borrow it. Factory/temporary control, foreign
browser sessions, other hosted bots and unresolved custody remain blocking.
No Defender combat policy or MCC Defender execution is changed here.

The integration regression exercises the actual public route, actual host and
production ownership probe with a fake gateway/browser stack. It covers exact
identity, both-map context, foreign owners, stale generations, one-winner races,
failure cleanup, retained release uncertainty, restart and the MCC seam. Existing
customs-export, hosted recovery and Factory boundaries are run alongside it.
