# Durable Startup/Main

Bot documents remain version 1. A finite prefix before a final loop is Startup;
the loop is Main. Normal loops retain their behavior. Mixed/advanced programs
remain verbatim and are not flattened by the editor.

Hosted Startup has a logical run identity distinct from transport/session
generations. `server-bots.json.startup.json` records credential-free checkpoints
using the shared `operationJournal` primitive. A fence is persisted before
dispatch; acknowledgement is not completion. Main waits for independently
verified postconditions. Persistence failure or ambiguous evidence blocks.

The initial mutation adapters are deliberately narrow: undock and supported
station docking/travel postconditions. Unsupported Startup actions block.
Completed checkpoints survive supported reconnect/restart. Stop followed by a
new Start gives fresh eligibility. An older unfinished prefix without durable
identity is not automatically resumed; it requires manual review.

Farmer's confirmed/refused/uncertain action semantics remain authoritative.
Only an actually fenced Startup action can use Startup recovery; unrelated Main
or interrupt progress is not made recoverable. Unconfirmed action progress is
never committed by the durable cursor write.

The JSON stores require one WC writer per writable data directory. They are not
multi-process locks. Use isolated data directories for separate instances.
