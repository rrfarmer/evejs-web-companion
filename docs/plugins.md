# Plugins

The web client is the game's own windows plus the bot builder. Everything else
(PI Manager, Industry Manager, Companions, MCC, Provisioning Center, and
whatever comes next) is meant to be a **plugin**: a folder under `plugins/`
that adds to the client and never edits core.

The PI Manager (`plugins/pi-manager`) is the first plugin and the worked
example for everything below.

## Rules

1. **Core is the retail client, and the bot builder.** If a signed-in pilot can
   do it in the retail client on their own session, it is core: its windows,
   its reads and each single action a bot can take (warp, loot, board a ship,
   launch from a command centre). Anything else is a plugin.
2. **No mods.** A plugin never edits or overrides core. If it needs core to do
   something new, it asks for a new contribution point or primitive in a core
   change.
3. **Plugins never depend on other plugins.** What two plugins both need goes
   into core.
4. **A failing plugin fails only itself.** A plugin that refuses to load, throws
   or hangs takes down its own windows, routes and bots, never the client or the
   BFF.
5. **A plugin imports only the plugin API and its own folder.**
   `web/src/plugins/pluginBoundary.test.ts` enforces this, and it also checks the
   other direction: core imports no plugin, only the build's plugin list. A
   plugin's tests may use core's test harness; its shipped code may not.

## Layout

```
plugins/
  index.ts              the build's plugin list (manifests): read by the page and the BFF
  views.ts              the plugins' window views (Svelte): read by the page only
  package.json          {"type": "module"}
  pi-manager/
    plugin.ts           the manifest (default export)
    views.ts            what its windows draw
    blocks.ts           its bot blocks
    backend.ts          its backend, run by the BFF in its own process
    backend/            the backend's own modules (database, stores)
    lib/  ui/           its web modules and Svelte windows
    test/               its tests
web/src/plugin-api/
  index.ts              the plugin API: manifest types, PLUGIN_API_VERSION, core reads and helpers
  blocks.ts             what a bot block is built from
  ui.ts                 core's Svelte pieces (pickers, type icon)
  backend.ts            the backend's side of the channel
  deciderProcess.ts     the process for a plugin with blocks and no backend
web/src/plugins/pluginHost.ts   loads plugins into the page (and the BFF's bot code)
src/pluginHost.js               runs plugin backends, each in its own process
```

## The manifest

```ts
// plugins/<id>/plugin.ts
import { definePlugin } from "../../web/src/plugin-api/index.ts";
import { MY_BLOCKS } from "./blocks.ts";

export default definePlugin({
  id: "my-plugin",            // lowercase words joined by hyphens
  name: "My Plugin",
  version: "1.0.0",
  apiVersion: 1,              // the PLUGIN_API_VERSION it was built for
  description: "One line: what it adds.",
  windows: [{ id: "plugin:my-plugin", label: "Mine", title: "My Plugin", hint: "What it is for", glyph: ["M4 4h16v16H4z"] }],
  macros: MY_BLOCKS,
  backend: "backend.ts",      // optional
});
```

Add it to the build by listing its manifest in `plugins/index.ts` and its views in
`plugins/views.ts`. Nothing in core changes.

## Contribution points

A contribution point is a slot core owns and a plugin fills. Core defines its
shape, reads what each plugin registered for it, and decides where and when to
show or call it. The list below is the plugin API: a plugin that needs a new
slot proposes it as a core change.

### A global window

A window about every pilot rather than the one on screen. It opens from a door
beside the brand, floats on the global layer on the desktop, and is a panel on a
phone (`web/src/ui/globalWindow.ts`, `globalWindowViews.ts`).

- Its id is `plugin:<plugin id>` or `plugin:<plugin id>.<name>`.
- Its view is a Svelte component given `{ sessions, onOpen, onGoToPilot }`
  (`GlobalWindowProps`); never a pilot's store or flow.
- Its glyph is SVG path data in a 24x24 box, stroked, like the Neocom's.

### A bot builder block

A block decides one tick at a time: from what the bot sees, the next single
action. Core performs it. A block definition (`PluginMacro`) carries everything
core's own blocks have spread over several tables:

| Field | What core does with it |
| --- | --- |
| `id` | `<plugin id>:<block>`, as `pi-manager:restart-extractors` |
| `name`, `category`, `does`, `needs` | the palette entry |
| `spec` | the arguments and whether an `until` is required; the codec and the editor's validator check it |
| `runPolicy` | what starting it risks and whether a restarted run may re-enter it; the launch grant prices it |
| `reads` | the costly reads it needs each tick while it runs (`colonies`, `piLaunches`, `customsOffices`, `shipNames`, `holds`, `planetaryHolds`) |
| `decide` | the next step |
| `newArgs`, `sentence` | a new step's arguments, and the step as a sentence |
| `formerly` | ids it had before (a core block that moved out), so saved scripts keep working |

A block returns core's actions only. Every game call is core's; the choices are
the plugin's. `plugin-api/blocks.ts` has the pieces core's own blocks are made of
(`tick`, `WAIT`, `ACTING`, `num`, `warpLanded`, `scriptTravelHome`,
`boardParkedShip` and so on).

A block is plain TypeScript with no DOM and no Node API, because it runs in two
places:

- **In the page**, for a bot the page flies: it decides in the page, as core's do.
- **In its plugin's process**, for a bot the BFF hosts. The runner decides a tick
  in passes. A pass that meets a plugin block with no answer yet records the
  question and is thrown away. The plugin process is asked, and the pass runs
  again with the answer. Deciding is pure, so the second pass is exact. If the
  plugin cannot answer, its bot pauses and says why, and nothing of that tick is
  acted on.

A script that uses a block of a plugin the build does not have (or a browser has
switched off) is refused when it is read, naming the plugin. The stored script is
untouched.

### A backend

The BFF forks a plugin's backend as a child process once the server listens, and
talks to it over its message channel.

```ts
// plugins/<id>/backend.ts
import { jsonStore, startBackend } from "../../web/src/plugin-api/backend.ts";
import manifest from "./plugin.ts";

if (typeof process.send === "function") {
  startBackend({
    manifest,                                    // its blocks are decided here for hosted bots
    routes: {
      "GET /things": () => ({ body: { ok: true, things: jsonStore("things.json").read() ?? [] } }),
      "POST /things/:thingID": (request) => ({ status: 201, body: { ok: true, id: request.params.thingID } }),
    },
    cleanup: () => { /* remove what it keeps */ },  // required
    adopt: (records) => { /* take over what core kept for it, once */ },
  });
}
```

- Its routes are `/api/plugins/<id>/...`. The BFF checks the session and passes
  only the account. In the page, `pluginGetJson` and `pluginPostJson` call them.
- It writes only to its data directory (`pluginDataDir()`, `data/plugins/<id>`).
  `jsonStore` writes a JSON document there atomically. A backend may also open
  its own SQLite database there, as the PI Manager does.
- A plugin with blocks and no backend still gets a process: the plugin API's
  `deciderProcess.ts`, which loads `plugins/<id>/plugin.ts` and only decides.

## Isolation

| Where | What contains a failure |
| --- | --- |
| Loading | Each plugin is checked whole before anything of it registers: a window or block id that is not its own, a duplicate, or another API version, and it loads nothing and says why. Every other plugin loads regardless. |
| Page | Each window is drawn inside an error boundary. **Not isolated:** a plugin's infinite loop in page code still freezes the tab. Keep heavy work in the backend. |
| BFF | Each backend is its own process. A throw is that request's 500; a request in flight when it dies gets a 503; one it does not answer within 30 s gets a 504. The watchdog pings every 5 s and kills a backend that misses two pings. A backend that exits is restarted after 1 s, 5 s, then 30 s, and stays stopped after five failures in ten minutes. |
| Files | Each backend runs under Node's permission model. It may read its plugin folder, the web sources and `node_modules`, and write only `data/plugins/<id>`. The core database is out of reach. Node calls this a seat belt for trusted code, not a sandbox against hostile code. Backends are also allowed native packages (`--allow-addons`, for SQLite), and Node warns that native code can step outside the model, so a plugin that ships native code is trusted code. |
| Bots | A hosted bot's plugin blocks are decided in the plugin's process (2 s per answer); a plugin that cannot answer pauses only its own bots. |

The Plugins window (beside the brand) shows each plugin: whether it loaded, why
not, and its backend's state and restarts (`GET /api/plugins`).

## State and cleanup

- A plugin keeps its own state in its data directory, and never in the core
  database.
- `cleanup` is required. To remove a plugin, stop the BFF, run
  `node scripts/plugin-uninstall.js <id>` while the plugin is still listed, then
  take it out of `plugins/index.ts` and rebuild. The script runs the plugin's
  cleanup and then deletes its data directory, whatever the cleanup left.
- `adopt` takes over, once, what core kept for a plugin before it was one. The
  BFF calls it when the backend first comes up, and records it in
  `data/plugin-handoffs.json` so it never runs twice. The PI Manager's old plans
  arrive this way.

## Switching a plugin off

Each browser can switch a plugin off in the Plugins window. It takes effect the
next time the page loads, because windows and blocks register before the first
paint and a running bot must never lose a block under it. A switched-off plugin
loads nothing in that browser, so its windows are gone and scripts using its
blocks are refused there. **The BFF still loads it:** a bot the server hosts keeps
running. Switching a plugin off for everyone means taking it out of the build.

## Versioning

`PLUGIN_API_VERSION` (`web/src/plugin-api/index.ts`) is a promise. Bump it when
something exported from the plugin API changes in a way a built plugin would break
on. A plugin declares the version it was built for, and the host refuses one built
for another, saying so in the Plugins window.

## Testing

- A plugin's tests live in its `test/` folder. They may import core's harness
  (`createScriptRunner`, `createAppFlow`, fixtures); its shipped code may not.
- `plugins/pi-manager/test/harness.ts` shows how to register a plugin's blocks
  for a test as the page does.
- Run them with the core suite: `node --test "web/src/**/*.test.ts" "plugins/**/*.test.ts" "plugins/**/*.test.cjs"`.
- `test/pluginHost.test.js` drives a real backend through a crash, a hang, a throw
  and a read of the core database.

## Not done yet

- **Third-party plugins from another repository.** They are planned as packages
  listed for the build, each built on its own, so a plugin that fails to build is
  left out and reported rather than failing the build. Today a plugin lives in
  `plugins/` and is built with core, so a plugin that does not compile fails the
  build.
- **Permissions declared in the manifest** (which reads and writes a plugin may
  ask core for) are not enforced yet.
- **Switching a plugin off for the BFF** (per account or for everyone) is not
  there yet; see above.
