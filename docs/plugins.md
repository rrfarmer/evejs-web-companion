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
   something new, that is a core change.
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
  pilotSession.ts       a pilot's session in a plugin's process, for a run
  flying.ts             what a plugin's own loop flies a pilot with
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

Add it to the build by listing a loader for its manifest in `plugins/index.ts` and
one for its views in `plugins/views.ts`: `{ id: "my-plugin", load: () => import("./my-plugin/plugin.ts") }`.
Never a static import: a plugin's code runs when its module loads, and each loader is
run on its own so that one that throws fails alone. Nothing in core changes.

## What a plugin can add

Core defines what each of these looks like, reads what each plugin registered,
and decides where and when to show or call it. These are the plugin API's only
extension points: a plugin that needs another one proposes it as a core change.

### A global window

A window about every pilot rather than the one on screen. It floats on the global
layer on the desktop and is a panel on a phone (`web/src/ui/globalWindow.ts`,
`globalWindowViews.ts`).

Plugin windows open from the **Plugins menu** at the end of the brand strip, not
from buttons of their own (`PluginMenu.svelte`, `pluginPins.ts`):

- The menu lists each plugin, in the order of `plugins/index.ts`. One with several windows opens them in place, on
  hover or on a click (a phone has no hover).
- The pin at the end of a row puts a launcher (a toolbar button) in the strip. A
  plugin row's pin pins the whole plugin, and its launcher lists its windows. A
  window row's pin pins that one window. A plugin with a single window has no list,
  and its launcher opens the window. Windows of a plugin pinned whole are covered by
  its launcher and are not pinned twice.
- A plugin this browser has not seen before pins itself, whole, while fewer than
  three are pinned. The first plugins show up without any setup, and the
  tenth pushes nothing out.
- Unpinned means no launcher, even while the window is open; it still opens from
  the Plugins menu.
- Pins are kept per browser. "Manage plugins" at the foot of the menu opens the
  Plugins window.

A plugin may register as many windows as it needs.

#### What each name and icon is for

A plugin gives core its words and icons as fields, and core decides where they go:

```ts
definePlugin({
  name: "Trade Tools",        // its name in the Plugins menu and the Plugins window
  label: "Trade",             // optional: its launcher's word when pinned whole and it has several windows
  glyph: ["M4 4h16v16H4z"],   // optional: the plugin's own icon
  windows: [{
    id: "plugin:trade-tools",
    label: "Prices",          // its launcher's word
    title: "Trade prices",    // its full name: title bar, sublist row, accessible name
    hint: "What it is for",   // the launcher's tooltip
    glyph: ["M4 12h16"],      // its icon
  }],
});
```

| Where | Words | Icon |
| --- | --- | --- |
| Plugins menu, a plugin's row | manifest `name` | manifest `glyph`, else the first window's `glyph` |
| Plugins menu, a window's row in the sublist | window `title` | none |
| Launcher, plugin with one window, pinned | window `label` | manifest `glyph`, else the window's `glyph` |
| Launcher, plugin with several windows, pinned whole | manifest `label`, else the first window's `label` | manifest `glyph`, else the first window's `glyph` |
| Launcher, one window pinned alone | window `label` | the window's `glyph` |
| The list a whole plugin's launcher opens | window `title` | the window's `glyph` |
| Launcher's tooltip | window `hint`; for a plugin with several windows, its name and the windows' titles | |
| Launcher's accessible name | window `title`, or the manifest `name` when it stands for several windows | |
| Window's title bar | window `title` | |

So a plugin with one window needs no manifest `label` or `glyph`: the PI Manager has
neither, and its "PI" and "Planetary Industry" are its window's `label` and `title`.
Give a plugin with several windows a manifest `glyph` when no one window stands for
the whole: without one, the first window in the list does, so that order matters.

Keep a `label` short: the strip is shared with every other launcher. A launcher shows
at most 18 characters, the length of "Planetary Industry", then `...`. Nothing refuses
a longer one, and the full name stays in the launcher's accessible name. The menu
cuts a name that outruns its row in the same way, at the row's width.

- Its id is `plugin:<plugin id>` or `plugin:<plugin id>.<name>`.
- Its view is a Svelte component given `{ sessions, onOpen, onGoToPilot }`
  (`GlobalWindowProps`). Each session carries that pilot's `store` and `flow`, so a plugin
  in the page acts as the pilots signed in there, with all a player's rights.
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
| `formerly` | ids it had before (a core block that moved out), so saved scripts keep working. Each must be nobody else's: a plugin claiming a live block's id is refused |

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
  plugin cannot answer, nothing of that tick is acted on and its bot stops as for
  any block that failed: docked it pauses at once, and in space it flies home first,
  asking no plugin on the way. Either way it says why. A plugin still starting is
  not a failure, for up to 30 s: the bot acts on nothing and looks again next tick,
  so its watches keep running and no answer is applied to an old reading.

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

### A run

A run is a loop a plugin writes itself, flying a pilot from its own process: for
what a block's one tick at a time cannot say. To core it is a bot like any other,
on the same launch approval, claim, roster, restart, run limit and Stop, and it
shows in the Bot Manager with the rest.

```ts
// plugins/<id>/backend.ts
import { startBackend } from "../../web/src/plugin-api/backend.ts";
import { createPilotSession } from "../../web/src/plugin-api/pilotSession.ts";

startBackend({
  manifest,
  routes: {},
  cleanup: () => {},
  runs: {
    patrol: {
      // The setup comes from outside, and this is its one gate.
      check: (setup) => ({ ok: true, setup: readSetup(setup), name: "Patrol", policy: { riskClasses: ["combat"], restartSafe: true } }),
      async start(run) {
        const { store, flow } = await createPilotSession(run);
        const loop = startPatrol(flow, store, run.setup, run.resumeData);
        loop.onChange((state) => run.report({ status: "running", phase: state.phase, why: state.why, resumeData: state.lap }));
        return { stop() { loop.stop(); flow.setLivePush(false); } };
      },
    },
  },
});
```

In the page, `checkPluginRun` asks the plugin what a setup means and what it risks,
`createPluginRunGrant` makes the approval from that, and `startPluginRun` starts it.

| Who | What they do |
| --- | --- |
| Core | Claims the pilot, so a tab cannot take it. Selects it, holds its token and logs it off. Keeps the run on the roster and brings it back after a restart of the BFF. Ends it at its run limit, and on Stop brings the drones home. |
| The plugin | Says what a setup means and what it risks. Flies the pilot. Says what it is doing (`report`). |

**The token and the claim stay with core.** A run's `fetch` sends each request over
the plugin's channel, and core adds them on its side. A run may ask only the BFF's own
API, only core selects a pilot or ends its session, and a run cannot start or stop a bot.

**`createPilotSession` does not select.** It attaches to the session core already
holds, because a select takes the pilot out of its fleet. It loads all of the flow,
about 170 MB, which is why it is a module of its own. A backend that flies nothing
never pays for it.

**`report`** says what the run is doing. Sending `stopped`, `idle` or `error` ends the
run, and core logs the pilot off where it is. `readout` is carried for the plugin's
own windows, up to 16 KB. `resumeData` is kept on disk and handed back to `start`
after a restart, up to 64 KB, so send it only when it changes.

**When the process stops,** core keeps the session and the pilot stays in its fleet.

- The process restarts, and `start` is called again with `resumed: true`. The pilot may
  be anywhere and doing anything by then, so read before acting. On a test server,
  mid-fight, a killed process was flying again in about 3 s and a hung one in about 11 s.
- It has 20 s to come back. If it does not, or if it stops a third time in two minutes,
  or if `restartSafe` is false, core stops waiting: every loop stopped, drones in, dock
  at the nearest station, log off, and the Bot Manager says why. It does not wait for
  the plugin host to give up, which takes over a minute.

### Flying a pilot

A run's loop flies with what core's own bots fly with: `session.flow.flying` for what
needs the pilot's session, and `web/src/plugin-api/flying.ts` for the pure reads,
decoders and rules. `flying.ts` is a module of its own because a plugin that flies
nothing has no use for it. A block needs none of this: see `blocks.ts`.

```ts
runs: {
  trade: {
    check(setup) { /* ... */ },
    async start(run) {
      const { flow } = await createPilotSession(run);
      let flying = true;

      // Not awaited: `start` answers within 30 s, and the loop goes on after it.
      const loop = (async () => {
        let hold = null;
        try {
          // Take the ship first. `stop` is called if something else takes it.
          hold = flow.flying.holdShip("plugin:my-plugin", "My plugin", () => { flying = false; });
          if (!(await flow.flying.readFit())) throw new Error("The ship's fit could not be read.");
          while (flying) {
            const status = decodeFlightStatus((await getFlightStatus(flow.requestOptions())).flight);
            // Something may have stopped this during that read.
            if (flying && status.docked) await flow.flying.orderedStep((now) => undock(flow.flying.bridgeDo, now, true));
            await flow.flying.sleepUntilPush(2_000);
          }
        } catch (error) {
          if (flying) run.report({ status: "error", why: String(error) });
        } finally {
          hold?.release();
          // The session's live stream, or it goes on trying to reconnect for as long as this process lives.
          flow.setLivePush(false);
        }
      })();

      // Core calls this for a player's Stop, and when the run ends.
      return { async stop() { flying = false; await loop; } };
    },
  },
},
```

- **`stop` on the handle is what ends a run.** Core stops a run through the handle `start`
  returns, and has 5 s to wait for it. The hold's `stop` covers what happens to the flow:
  in a run that is rarely anything, because only your loop flies that flow.
- **Never let the loop's promise reject.** In a process nothing catches it, so it takes the
  process down and every run of your plugin with it. In a page it puts up the client-wide
  error overlay. A read fails for ordinary reasons, and a
  run being stopped gets `PLUGIN_RUN_ENDED` from every read: decide what each means, and
  report `stopped` or `error` when the run ends itself, or the row goes on saying it is
  running. The sketch above gives up on the first failure, which a real loop would not.
- **`holdShip(owner, name, stop)`** takes `plugin:<plugin id>` as the owner. `name` is shown
  in the page while a loop running there holds the ship; for a run, the Bot Manager shows
  the name `check` gave. No other bot flies while a plugin holds the ship, though a player can still start a route by
  hand. It holds it until
  `stop` is called or it calls `release`. `stop` is called when anything else takes the ship, a
  player stops it from the Bot Manager, a panic recall pulls it home, or the session closes or
  is lost. However a hold ends, whatever route the autopilot is flying ends with it, and one
  `startRoute` is still planning does not start. `stop` may not take the
  ship itself, and what it throws or rejects with is logged and goes no further. `holdShip` refuses with no
  pilot online, while the last controller's Stop is settling, while drone recovery is still
  checking a pilot in the page, and while the session closes.
- **`readFit()` comes before the module lists** (`resolveDefenseModuleIDs`,
  `resolveRemoteRepModuleIDs`, `resolveSalvageModuleIDs`). Attaching reads no fit, and until
  `readFit` has run they are empty. It answers `false` if the fit's modules could not be
  read or told apart, and then the lists may be short because nobody knows. It rejects if the
  request for the fit itself failed, so call it inside your `try`. `loadFitting` in `flying.ts` is the
  plain request and fills no store. Call `readFit` again after a refit.
- **`sleepUntilPush(ms)`** sleeps until the next look, or until a push wants acting on. A push
  cannot end a sleep sooner than about a third of a second after it began. `onPush(listener)`
  is what it is built on, and is called for a fleet broadcast, a fleet target tag, this
  ship's lock landing and a jam starting. It says only that something arrived; the store has
  what. A fleet fight pushes many of these, so a loop that looks on each one floods the server.
- **A write throws the server's refusal,** because a loop has to see one to decide on
  it. The flow's panel methods, by contrast, catch a refusal and say it in a panel.
- **Compare `sessionGeneration()` across an await** before acting on what came back,
  because the session may have closed in between. It does not change for a session that
  was lost: the next read throws instead.
- **Routes are the pilot's.** `createPilotSession` gives the flow the route settings
  core's session for the run had when it began. A change the pilot makes later reaches
  the run only after a restart of the BFF.

**What a loop keeps about a pilot** goes in `store.pluginState("plugin:<plugin id>",
initial)`, a signal. The same key gives the same signal, a second name goes after a dot
(`plugin:<plugin id>.<name>`), and it goes back to `initial` when the pilot goes offline
the account signs out, or a pilot is chosen on that store, so never change `initial` in
place. Core reads none of it. It
belongs to one store, and a run's store is in your backend's process. So a window cannot
see a run's state: send what a window shows as `readout`. What must survive a restart of
your process goes in `resumeData`.

**What a loop did** goes in the pilot's flight recorder, the same log core's bots write
(`data/bot-logs/<characterID>.jsonl`). `flow.flying.log.write(line)` batches and sends
it, and can never stop the loop. Some things to know:

- Give each run an id from `newRunID`, and write one line of kind `start` when it first
  starts, not when it comes back (`run.resumed`). A `start` line rotates the log, and only
  three runs are kept.
- `action` is your own, as plain data with a `kind`, and `trace` is anything you want kept
  about a decision, which you read back yourself. Keep both plain and small: a line that
  cannot be sent as JSON, or a batch over 64 KB, loses the whole batch, up to 500 lines.
- `readBotLog` gives back one file of the pilot's log, the lines since the last `start`
  from anyone unless you ask for an older one, along with `trimmed` and `unreadable`
  markers. Tell your lines by their `run`.
- `stop()` has 5 s and is your last chance to write. Write the `end` line there and `await
  flow.flying.log.flush()`. It is called on a Stop, and also after you end the run yourself
  with a report. While a run is being stopped, writing to the recorder is the one thing it
  can still do.
- `stop()` is not called if your process has died, and lines not yet sent die with it, so a
  crashed or recalled run has no `end` line. A pilot that went offline has no session left
  to write with, so those lines are lost as well.

### A loop in a tab

A plugin can fly a pilot from the page as well, on a pilot signed in there. The server
is not involved, so the loop ends when the tab closes.

Nothing more is needed than a session from your window's `sessions`. A plugin's modules
stay loaded for as long as the page does, so a loop outlives the window that started it.
Keep what you start in a module of your own rather than in a component.

Write the flying once, on a `store` and `flow`, and it can run both ways. Keep the hold and
the end of the session outside it, because those are what differ:

```ts
// lib/fly.ts: only the `while`. Never rejects: it says what went wrong and returns.
export async function fly(store: ClientStore, flow: AppFlow, flying: () => boolean, say: (why: string) => void) {
  try {
    if (!(await flow.flying.readFit())) throw new Error("The ship's fit could not be read.");
    while (flying()) { /* look, decide, act, sleepUntilPush */ }
  } catch (error) {
    if (flying()) say(String(error));
  }
}

// In a run, from `start`:
const { store, flow } = await createPilotSession(run);
let flying = true;
const hold = flow.flying.holdShip("plugin:my-plugin", "My plugin", () => { flying = false; });
const loop = fly(store, flow, () => flying, (why) => { flying = false; run.report({ status: "error", why }); })
  // If `fly` finished its job by itself, say so, or the row goes on saying it is running.
  .then(() => { if (flying) run.report({ status: "stopped" }); })
  .finally(() => { hold.release(); flow.setLivePush(false); });
return { async stop() { flying = false; await loop; } };

// In a tab, from a window's button. `holdShip` can refuse: say so, and do not start.
let flying = true;
const hold = session.flow.flying.holdShip("plugin:my-plugin", "My plugin", () => { flying = false; });
void fly(session.store, session.flow, () => flying, showInMyWindow).finally(() => hold.release());
```

What differs in a tab:

| | A run | A tab |
|---|---|---|
| Who starts it | `startPluginRun` and a launch approval | your own code, on a player's click |
| A player's Stop | The Bot Manager calls the handle's `stop` | The Bot Manager calls the hold's `stop` |
| The hold's `stop` | Rarely called | **How your loop is stopped**, so it must end the loop |
| Its name in the page | From `check` | From `holdShip` |
| What a window sees | `readout` | `store.pluginState`, directly |
| A restart | Your process comes back, with `resumeData` | Closing or reloading the tab ends the run. Come back from your own saved state if you want to |
| The live stream | Yours to close (`setLivePush(false)`) | The page's. **Do not close it** |
| The session | Core's | The player's. **Do not release it** when your loop ends |

`holdShip` refuses until drone recovery has checked a pilot that has just signed in, so a
start can be told to wait. If that check failed it stays refused until someone retries,
with `flow.retryDroneRecovery()` or the Retry on that pilot's notice, so say what it said
rather than waiting for ever. Ask `store.bots.get().runningBotID` whether a pilot is already
flying something before you offer a Start, and remember that taking the ship stops it.

Be careful with sessions a player is looking at. A background pilot has no live stream
(only the pilot on screen does), so it learns of pushes from the answers to your own
reads, and `sleepUntilPush` wakes on those.

## Isolation

| Where | What contains a failure |
| --- | --- |
| Loading | Each plugin is checked whole before anything of it registers: a window or block id that is not its own, a duplicate, or another API version, and it loads nothing and says why. Every other plugin loads regardless. |
| Loading | Each plugin's modules are loaded on their own, in the page and the BFF (`web/src/plugins/loadPlugins.ts`). One that throws, rejects or never finishes loading is left out and says why, and the client and the other plugins load regardless. In the page it is given 20 s, because nothing is drawn until plugins are in. |
| Page | Each window is drawn inside an error boundary. **Not isolated:** a plugin's infinite loop in page code, including one at the top of its module, still freezes the tab. In the BFF the same loop at the top of a manifest's module freezes the BFF, because the BFF loads manifests to read their blocks. Keep a module's top level to declarations, and heavy work in the backend. |
| BFF | Each backend is its own process. A throw is that request's 500; a request in flight when it dies gets a 503; one it does not answer within 30 s gets a 504. The watchdog pings every 5 s and kills a backend that misses two pings. A backend that exits is restarted after 1 s, 5 s, then 30 s, and stays stopped after five failures in ten minutes. |
| Files | Each backend runs under Node's permission model. It may read its plugin folder, the web sources and `node_modules`, and write only `data/plugins/<id>`. The core database is out of reach. Node calls this a seat belt for trusted code, not a sandbox against hostile code. Backends are also allowed native packages (`--allow-addons`, for SQLite), and Node warns that native code can step outside the model, so a plugin that ships native code is trusted code. |
| Bots | A hosted bot's plugin blocks are decided in the plugin's process (2 s per answer); a plugin that cannot answer stops only its own bots, which fly home first if they are in space. |
| Runs | A run's pilot is recalled and docked by core if its plugin's process stays down (see [A run](#a-run)). Only that plugin's runs are affected. Node's permission model does not stop sockets, so a backend can still open a connection to the BFF; it has no token to use on it. |

The Plugins window ("Manage plugins" in the Plugins menu) shows each plugin: whether it loaded, why
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
