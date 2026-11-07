# Testing the web client with Gridcheck

[Gridcheck](https://github.com/Clogs/gridcheck) boots an EveJS server, flies characters on it and
reads the grid as a timeline. `tools/gridcheck-plugin` in this repo is a Gridcheck plugin that tests
this web client against that server, in a real browser. A scenario signs in on the page, clicks what
a player clicks, and checks both what the page shows and what the server holds. The plugin also sets
up planetary industry and ages it, so a feature that takes days of production runs in minutes.

The plugin builds the web client from a checkout you name, so a worktree of a branch under test is
enough. The server runs on its own port block, so nothing here touches a server you play on.

## Setting it up

You need:

- A **tree**: an EveJS server checkout with planetary industry and Gridcheck vendored into
  `tools/gridcheck` (see Gridcheck's README). It has to be a Gridcheck that keeps a plugin the tree
  added, which 0.3.6 does not.
- Docker, and Edge or Chrome.
- A checkout of this repo.

Below, `gridcheck` means `node tools/gridcheck/bin/gridcheck.js`, run from the root of the tree.

**1. Link the plugin into the tree.** Gridcheck loads its plugins from `tools/gridcheck/plugins/`. A
plugin it didn't install itself is the tree's: `gridcheck vendor check` leaves it out and `gridcheck
vendor update` keeps it. A link means the plugin stays current with your checkout. A copy works too.

```bash
# Windows, in cmd
mklink /J tools\gridcheck\plugins\companion <web client checkout>\tools\gridcheck-plugin
```

```bash
# Linux or macOS
ln -s <web client checkout>/tools/gridcheck-plugin tools/gridcheck/plugins/companion
```

If the tree's git tracks `tools/gridcheck`, keep the link out of its history, since its target is
particular to your machine: add `tools/gridcheck/plugins/companion` to the tree's `.git/info/exclude`.

A server that is already up has loaded its plugins, so run `gridcheck down` first.

**2. Check that it loaded.** `gridcheck status` should list `companion` under `plugins` as active. If
it is skipped, the same line says why.

**3. Point it at the web client, and run a scenario.**

```bash
gridcheck web setup                                                   # once: Playwright, in _local/gridcheck/companion/
gridcheck web use <web client checkout> --reference <tree with _local/sde>
gridcheck run pi-haul
```

`web use` is remembered. It names the web client under test, and doesn't have to be the checkout the
plugin is linked from: to test a branch, name its worktree. `--reference` names the tree whose
`_local/gameStore/data` and `_local/sde` the web client reads its static data from. It is this tree
when this tree has them.

`gridcheck run` lists the plugin's scenarios with the rest. The report is in the run's folder under
`_local/gridcheck/runs/`, and the commit under test is in it.

## What runs where

| Piece | Where | What it does |
| --- | --- | --- |
| Web client | a container, `gridcheck-web-<slot>`, on the block's +11 port | Built from the checkout, with a volume of its own that goes when it stops. |
| Browser | a small process of its own (`tools/gridcheck-plugin/tool/browserHost.js`), on the block's +12 port | Headless Edge or Chrome through Playwright, with an empty profile. It hears every page error between commands. |
| Colony routes | the bridge, `/companion/*` (`tools/gridcheck-plugin/server.js`) | Static data, reading what a colony holds, moving stored times. |
| Building a colony | the CLI, on the held session | `planetMgr.UserUpdateNetwork`, the call a retail client makes, so the server's rules apply. |

Every connection the web client makes is set to this tree's server. The client's own defaults are the
stock ports, which on your machine may be a server people play on, so `web up` refuses a checkout
that reads a host, port or URL variable the plugin doesn't set. A prebuilt image (`--no-build`,
`--image`) is read the same way, from inside the image. Add the variable to `containerEnv` in
`tools/gridcheck-plugin/tool/webClient.js`. It also refuses a server `gridcheck up` didn't start.

## Pilots

A pilot the web client flies never gets a `gridcheck login`: since server 261018.1, one login closes
the account's other clients. So a scenario holds a session on an account of its own, follows the
pilot with `"watch": { "pilot": "<account>" }`, and talks to that pilot through the bridge
(`pilotSlash`, `gridcheck pilot <account> slash ...`).

A followed pilot may be offline. `PILOT online=true` and `online=false` say when it comes and goes,
and the watch carries on. Its session isn't a gateway session, so there is no client view and no
`DIVERGE`. `gridcheck watch --pilot <account>` does the same by hand.

## A scenario

```json
{
  "recipe": "pi-colonies",
  "watch": { "pilot": "e2epi" },
  "setup": [
    { "login": { "user": "e2eagent", "name": "Agent Observer" } },
    { "colonyAge": 8, "user": "e2epi" },
    "webUp",
    { "webLogin": "e2epi" },
    { "webClick": { "role": "button", "name": "Planetary Industry" } },
    { "webSelect": { "role": "combobox", "name": "Add" }, "option": "PI Hauler" },
    { "webClick": { "role": "button", "name": "Add", "exact": true } },
    { "webClick": { "role": "button", "name": "Refresh" } },
    { "webClick": { "role": "button", "name": "Restart 2 extractors" } },
    { "botWait": "e2epi", "timeout": 120 },
    { "colonyRead": "e2epi" }
  ],
  "until": { "any": ["COLONY extracting=1"], "from": "start", "timeout": 30, "grace": 3 },
  "expect": ["BOT what=end status=stopped", "no BOT ok=false", "no COLONY finished=1", "no WEB_ERROR what=exception"]
}
```

Name the first step's account yourself: a world recipe leaves its last pilot as the held account.

| Step | Does |
| --- | --- |
| `"webUp"`, `{ "webUp": { "build": false, "image": "<tag>" } }` | Builds the checkout's image (a rebuild with nothing changed takes seconds) and starts the web client and a signed-out browser. Fails on a checkout it can't keep to this tree's server. |
| `{ "webLogin": "<account>" }` | The page's own login form. Any password works there; a new name makes a new account. |
| `{ "webOpen": "/path" }` | Goes to a path. Reloading the page signs every pilot back in, as it does for a player. |
| `{ "webClick": <node> }` | Clicks it, as a mouse would: a window over it blocks the click, and the error names that window. Dialogs are accepted, and recorded. |
| `{ "webFill": <node>, "value": "..." }`, `{ "webSelect": <node>, "option": "..." }`, `{ "webPress": "Enter", "node": <node> }` | Types, chooses, presses. |
| `{ "webExpect": <node>, "text": "...", "count": 1, "hidden": true, "timeout": 15 }` | Waits until it shows (with that text in it, or that many of it, or none with `hidden`). Fails saying what it found instead. |
| `{ "webShot": "label" }` | A picture of the page, listed in the report with the client's. |
| `{ "botWait": "<account>", "timeout": 600 }` | Waits for that pilot's next bot run to end or pause, and puts its flight recorder on the timeline as `BOT` lines. |
| `{ "pluginSignal": "<plugin>", "signal": "SIGKILL" }` | Signals a web client plugin's backend process. `SIGSTOP` stops it answering. |
| `{ "pilotSlash": "/setisk 5000000", "user": "<account>" }` | A slash command on a pilot someone else holds. |
| `{ "colony": { "planetID": 40161463, "level": 5, "extract": [{ "resource": "Base Metals" }, { "resource": "Aqueous Liquids", "make": "Water" }, { "resource": "Micro Organisms", "into": "command" }] } }` | Builds a colony for the held character, through the retail call. It needs ISK and skills. In a scenario or a recipe. |
| `{ "colonyAge": 8, "user": "<account>", "planetID": 40161463 }` | As if that many days had passed. See below. |
| `{ "colonyStock": { "planetID": 40161463, "pin": "launchpad", "type": "Base Metals", "quantity": 1000 }, "user": "<account>" }` | Goods in a launchpad or a command centre. |
| `{ "colonyRead": "<account>" }` | `COLONY` lines for each of that pilot's colonies, as the server settles them now. |
| `{ "fleetForm": ["<account>"], "boss": "<account>" }` | A fleet with that boss (the held character when `boss` is left out) and an invitation to each member. A web client pilot answers it in the page: `webClick` Yes `within` the `alertdialog`. The page holds a fleet only through the call it made to join it, so the server does not join anyone itself. Everyone must be online. |
| `{ "shipHealth": { "shield": 0, "armor": 0.4 }, "user": "<account>" }` | That pilot's ship in space left at those fractions of each layer named, with the notices real damage sends, so its client and the page see it as damage taken. A hull of 0 is refused: it sets health, it never destroys a ship. A few steps two seconds apart make health fall at a known rate. |

**A node** is `{ "role": "button", "name": "Refresh" }` first, since that's what a player or a screen
reader sees. Otherwise `text`, `label`, `placeholder` or `css`, with `exact`, `index`, and `within` for
a node to look inside. Two matches are an error that lists them. `gridcheck web snapshot` prints the
page as roles and names, which is how to find one.

**Aging** moves a colony's stored times back, and the server settles the production the next time
it reads the colony. A week of extraction lands on the launchpads and the programme has run out,
with nothing restarted. The clock itself doesn't move, because the page compares a programme's end
against the server's wall clock.

| Kind | Fields |
| --- | --- |
| `WEB` | `what` (`up`), `url`, `commit`, `dirty`, `image`, `channel`. The commit under test is in the report, read from the image's labels: an image this plugin didn't build has none. |
| `WEB_ERROR` | `what`: `exception` (the page threw), `console` (an error it logged), `response` (an API call answered 5xx), `dialog`. `text`, `url`, `status`. Comes with each web step, `botWait` and `colonyRead`, so what the page does after the last of them isn't heard. |
| `COLONY` | `characterID`, `user`, `planetID`, `planetName`, `level`, `pins`, `extractors`, `extracting`, `finished`, `launchpadUnits`, `commandUnits`, `routes`. |
| `BOT` | `what`: `phase`, `issue`, `result`, `end`. `says`, `phase`, `status`, `reason`, `ok`, `run`. |

Most checks happen in `setup`, so `"until": { "from": "start" }` on a last `colonyRead` is the usual
stop. A web step that fails ends the run as not completed, with what it found.

At the end of the run its `web/` folder keeps the web client's log and its bot logs, and the web
client and browser stop. `--keep-up` leaves them up to look at.

## By hand

```bash
gridcheck up --world pi-colonies
gridcheck web up
gridcheck web login e2epi
gridcheck web click --role button --name "Planetary Industry"
gridcheck web snapshot
gridcheck web expect --role tab --name Colonies
gridcheck web shot "what I see"
gridcheck web errors
gridcheck colony show e2epi
gridcheck colony age e2epi --days 8
gridcheck web bot e2epi
gridcheck down
```

An agent has the same as MCP tools, `companion_web` and `companion_colony`.

## The world

The recipe `pi-colonies` has two pilots with every skill in Amamake, docked at the Brutor Tribe Bureau:

| Account | Pilot | Colonies |
| --- | --- | --- |
| `e2epi` | PI Hauler, with an Epithal | Amamake I, Base Metals to a launchpad. Amamake IV, Aqueous Liquids through a factory making Water, to a launchpad. |
| `e2epi2` | PI Launcher, with no hauler | Amamake II, Aqueous Liquids to its command centre. |

The recipe `companion-fight` has two pilots with every skill in a Vexor, docked at the same station:

| Account | Pilot | Ship |
| --- | --- | --- |
| `e2efc` | Fleet Boss | Nothing fitted. The scenario makes it invulnerable to rats with `/invu on`. |
| `e2eflee` | Flee Pilot | A 10MN afterburner, a medium armour repairer and five Hobgoblin IIs: it tanks on armour, burns, and has drones to leave behind. |

## The PI scenarios

| Scenario | What it checks |
| --- | --- |
| `pi-restart` | A finished programme shows as needing the pilot; Restart runs a hosted bot; the server holds running programmes and the board says so. |
| `pi-haul` | Two colonies hauled: board, send up at each customs office, empty it, fly home, unload, board back. Stock shows the goods. |
| `pi-launch` | A command centre's goods launched and the container collected in space. |
| `pi-no-hauler` | A haul with no planetary hold pauses, the board says why, and Stop ends it. Checks nothing was launched: needs `fix/companion-pi-haul-boards-first`, and fails without it. |
| `pi-planner` | A plan created, done, reopened, deleted. An expansion plan proposed and kept. |
| `pi-plugin-crash` | The plugin's backend killed: the Plugins window says it restarted, and the plans it keeps are still there. Needs the web client's plugin system, which isn't on `master` yet, and fails without it. |
| `pi-add-pilot` | Adding a pilot shows its colonies with no Refresh. Needs `fix/companion-pi-added-pilot-colonies`, and fails without it, as the panel stays blank until Refresh. |

Beside them, on the same world:

| Scenario | What it checks |
| --- | --- |
| `lock-target` | A pilot undocks and locks the station from the overview, and the page shows it locked. The server tells of a made lock inside an `OnMultiEvent`, so this fails if the BFF takes `OnTarget` only on its own. |

On `companion-fight`:

| Scenario | What it checks |
| --- | --- |
| `companion-flee` | A companion in a fight, its drones out, whose armour falls about 9% a second through its flee floor, warps out at once without recalling its drones. The boss undocks, the companion follows, both are moved off the station's grid so leaving is a warp, rats are spawned, and `shipHealth` lowers the armour. Needs `fix/companion-flee-drone-wait`, and fails without it: the companion recalls its drones and waits first. |

They live in `tools/gridcheck-plugin/scenarios/`. To check a feature of your own, add a scenario there
with the feature, or write one in the tree's `tools/gridcheck-scenarios/`, or pass a path.

## Testing the plugin itself

```bash
node --test test/gridcheckPlugin.test.js
```

That needs no server, Docker or browser. With `GRIDCHECK_CHECKOUT=<a Gridcheck checkout>` set, it also
loads every scenario and recipe through Gridcheck's own validator, so a mistyped step is found without
booting anything. `gridcheck run <scenario> --check` does the same for one scenario in a tree.
