# GamePort login catalog

Stock EveJS sends its signed function from `server/src/network/tcp/handshake.js`.
It carries the native client handlers. The additional catalog described here is
produced by the optional **empire-specialized-haulers** mod.

* The mod's `catalog.js`, `makeCatalog`, builds additional item, Dogma and
  effect rows from its fleet definitions and the server's installed static data.
* Its `install.js`, `buildProgram`, serializes `{catalog, visuals}` as UTF-8 JSON,
  zlib-deflates it and puts its base64 representation in the first line of the
  client program as `_family_bundle = "..."`. The catalog contains
  `additions.itemTypes` (rows), `additions.typeDogma` (rows keyed by type ID)
  and `effects` (rows keyed by effect ID).
* Its `login-envelope.js`, `createDelivery().compose`, adds that program as the
  base64 argument of the `<empire-hauler-login>` wrapper around the original
  expression. The transport is a Python marshal string (0x74, four-byte
  little-endian length, expression bytes) in the login signed-function tuple.
* GamePort offers that buffer to the BFF instance. WC reads only the named
  carrier and data literal. It checks the native argument against its existing
  digest allowlist to produce the native reply. A different unrecognised native
  expression still receives the ordinary unknown-function response. No client
  Python runs and WC does not claim to have installed client graphics.

The overlay is held by the BFF for its configured game server. A subsequent
plain login leaves the most recent validated catalog available to its other
pilots. A restart clears it. Stock rows take precedence. Runtime-only skill
requirements require valid Dogma. Ordinary installations keep their existing
client-data availability rules.
