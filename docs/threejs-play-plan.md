# FarmerThreeJSFun: real browser play with three.js

Branch `FarmerThreeJSFun`, a side experiment off `master`. Draft for review, 2026-11-09.

## What we are building

One player flies one character, chosen from the characters already logged in through our
server, in a three.js 3D view of space backed by eve.js. Nothing in it is automated: the bot host
does not drive a pilot held by the Play page. The goal is the whole game, not only combat.

### Directives (operator, 2026-11-09)

1. **Look and feel nearly identical to the retail client**, at the level eve-cs.com reaches. That
   site's interface is the bar for how "game-like" this must be. We add the windows the rest of
   the game needs (it does combat only; we do the whole game).
2. **Real hulls from day 1.** Models, textures and UI art come from the EVE client installed on
   this machine, through **an extraction script we can distribute. The extracted data is never
   distributed or committed.**
3. **Destiny and client behaviour are not ours to choose.** Movement, effect timing and ranges
   follow the real Destiny and the retail client exactly. Visuals and layout are free, aiming at
   the retail look.
4. **Character choice:** pick one of our logged-in characters from the list; from then on it is
   player-controlled.
5. **Side experiment.** It merges into `master` later, if it works.

### Reference material we have

| What | Where | Use |
| --- | --- | --- |
| Our Destiny port, checked to CCP's own fixtures | `src/gamePort/destiny/{state,ballpark,park}.js` | The physics, in the browser too |
| A game-port pilot's live ballpark | `src/gamePort/pilotSpace.js` | Where the Destiny feed is tapped |
| Retail client, build 3396210 | `C:\Users\ryanf\Documents\EVE Online - 3396210` (`tq/resfileindex.txt` → `ResFiles/`) | Models, textures, UI art, SOF data |
| Decompiled client Python | `eve.js/tools/ClientCodeGrabber/Latest` | Camera, brackets, HUD behaviour, effect timing |
| CCP open-source carbonengine | `Documents/GitHub/CCP/carbonengine/*`, `Documents/GitHub/trinity` | How trinity reads `.gr2` / `.black`, SOF, shaders |
| eve-cs.com local copy | `tools/eve-cs-mirror/site` | **Visual reference only**; no code or files from it |

## Architecture

```
 eve.js server ──machoNet──> BFF game-port pilot (src/gamePort)
                               │  pilotSpace.js: its own Park, as now (authoritative for routes, bots off)
                               │  + NEW play channel: forwards the Destiny feed unchanged
                               ▼
                          WebSocket /play  (one pilot, one page)
                               │  down: DoDestinyUpdate(s), sim-clock rebase, slim items, damage,
                               │        godma/effect/target notifications, OnSpecialFX
                               │  up:   commands → the bridge's existing write routes
                               ▼
 Browser Play page ─ Park (same park.js/ballpark.js/state.js) stepped by the page's sim clock
                     ├─ three.js world: balls drawn at park position, interpolated per frame
                     └─ Svelte HUD/windows over the canvas (retail layout)
```

### 1. Physics: the browser runs its own Park

- The retail client runs a Park, steps it once per sim-clock second, and draws each frame at a
  fraction between ticks. We do the same in the browser with **the same files** the BFF uses.
  `ballpark.js` depends only on `state.js`. `park.js` needs `marshalDecode` only for raw entries,
  so either the BFF decodes and forwards JSON (with the state blob as bytes, which `state.js`
  reads), or the marshal decoder is bundled too. Decide in spike S2.
- The BFF keeps its own Park as now (the existing routes, overview and tests rely on it). Both
  Parks step the same feed, so they can be checked against each other in a test.
- This keeps the "space updates once per second" rule: the server sends at 1 Hz and the page never
  polls space. Smooth motion comes from local stepping and interpolation, as on retail.
- Commands use existing bridge writes (`movementWrites`, targeting, module activation, drones),
  so there are no new server-side game rules.

### 2. Rendering (three.js)

- **Floating origin:** positions kept as doubles on the CPU; the scene is re-centred on the
  camera target each frame. A logarithmic depth buffer covers grid metres to AU.
- **Ships built the way trinity builds them:** typeID → graphicID → SOF hull + faction + race
  (`res:/staticdata/graphicids.fsdbinary`, `res:/dx9/model/spaceobjectfactory/data.black`).
  That gives mesh, material zones, faction colours, booster locators, turret locators, lights.
- **A PBR material approximating the client's ship shader** from its texture set (`_d`, `_n`,
  `_r`, `_m`, `_p3`, `_g`, `_a`, `_ar`, `_pmdg`), faction colours applied per material zone,
  booster trails, glow. The look is ours to tune; the inputs are the client's.
- **Scenery:** nebula skybox per system/region, sun with lens flare, planets and moons, station
  and gate models, asteroid belts. All of it from the client, through SOF where the client uses it.
- **Effects** driven by server events with retail timing: turret beams and tracers on effect start
  and stop, missiles as balls, explosions on terminal ball removal, the warp tunnel in warp mode,
  shield/armour impacts.
- **Camera:** the retail orbit camera (orbit around the ship, zoom, look-at, tracking camera),
  taken from the decompiled camera code.

### 3. Interface: retail layout, Svelte over the canvas

Retail-identical layout and art (UI textures straight from `res:/ui/texture/...`, the same files
eve-cs uses):

- **Space HUD:** ship status gauge (capacitor ring, shield/armour/hull, speed and the speed
  control), module rack with overload, target bar, selected item, overview, brackets in 3D space,
  the right-click radial/context menu, d-scan, the probe scanner, the drone window,
  Local chat, the Neocom.
- **Whole-game windows** that eve-cs does not have: inventory and cargo, fitting, market,
  industry, mail, contacts, fleet, corporation, character sheet, map, station services. Most
  exist in the app already; they get restyled to the retail chrome rather than rewritten.
- **Window chrome:** the retail look of draggable, stackable, pinnable windows. Built on our own
  Desktop window system, restyled.
- Logic already in `web/src/space/` (overview, tactical, selection, rowActions, shipSpeed) is
  reused under the new look.

### 4. Character selection and control

- The Play page lists the characters our server holds sessions for, and the player picks one.
- That pilot is marked **player-held**: the bot host and every automation leave it alone while
  the page has it. One page per pilot; closing the tab ends play. This is the "one client per
  account" rule.

## The client extractor (distributable script, no data)

`tools/client-extract/` is plain Node with no dependencies, run as
`node tools/client-extract/extract.mjs --client "<EVE folder>"`. It auto-detects the folder when
there is a single install, reads the build from `tq/start.ini`, and writes to a **git-ignored**
`_local/client-assets/<build>/`, which the dev server serves. It only re-extracts what changed,
and stops with the file named on any format it does not recognise (a newer client is coming).

| Stage | Input | Output | Risk |
| --- | --- | --- | --- |
| Index | `tq/resfileindex.txt` → `ResFiles/<blob>` (uncompressed on disk) | path → file lookup | low |
| FSD static data | `graphicids.fsdbinary`, groups/types as needed | typeID → graphic → SOF names | low-medium |
| `.black` reader | SOF `data.black` (180 MB), faction `.black` files | hulls, factions, locators, material zones, as JSON | medium: format read from carbonengine sources (red-to-black-converter, blue) and trinity |
| **`.gr2` reader** | Granny 3D v7 files; their sections are **Oodle1-compressed** (format 2, seen on `ab1_t1.gr2`) | meshes, mesh areas, bones, LODs, as `.glb` | **highest:** needs our own Oodle1/BitKnit decoder, written here. eve-cs shows it can be done in Node |
| Textures | `.dds` (BC1/BC3/BC5/BC7) | KTX2/DDS where the GPU takes it, otherwise decoded to WebP | medium |
| UI art | `res:/ui/texture/**/*.png` (14,328 files) | copied | low |
| Scenery | skyboxes, planets, sun, effect textures | as above | medium |
| Sound (later) | `.wem` / `.bnk` (Wwise) | Ogg | medium; deferred |

Order of work: index → one hull end to end (gr2 → glb → three.js viewer) → SOF → all hulls.

## Milestones

**M0 — spikes (prove the two risky parts first)**
- S1: one Caldari hull (M1 is in Jita), extracted by our script and drawn in a bare three.js viewer page
  with its real textures.
- S2: the browser Park on the live feed of one game-port pilot, checked against the BFF's Park
  position by position (a test fixture recorded from real server bytes).

**M0 results (2026-11-09)**

- **S1: done.** `tools/client-extract/` reads the client's own files with no dependencies:
  - Granny `.gr2` in both pointer layouts (32-bit and 64-bit).
  - Both section compressions, Oodle1 (`lib/oodle1.mjs`) and BitKnit (`lib/bitknit.mjs`), translated from the
    client's `_trinity_dx11.dll`.
  - The packed tangent frame, decoded as CCP's `cmf::UnpackTangentsLegacy`; normals agree with the
    triangle winding on 100% of faces.
  - Output is glTF `.glb` with every LOD, mirrored into right-handed space, plus the hull's `.dds` textures
    copied untouched.

  Over every ship model in the client: 3,109 of 3,109 Oodle1 sections and 4,905 of 4,905 BitKnit sections
  decode, and all pointer fixups land in range. `web/hull-viewer.html` draws a hull with its own textures,
  uploaded block-compressed (BC4/BC5/BC7). Checked on the Raven (`cb1_t1`) and the Badger (`ci1_t1`).
  Colour still waits on the SOF faction materials (`MaterialMap`/`PaintMaskMap`), which is M1.
- **S2: done on recorded real-server feeds; the live link is M1's first step.** The browser runs the BFF's own
  Destiny code, bundled on demand by the `virtual:destiny` Vite plugin.
  - Feed items carry each notification's own marshal bytes (`src/gamePort/destiny/feed.js`). Re-encoding
    decoded values was not exact: whole floats past 32 bits come back as int64.
  - `pilotSpace.js` now feeds its park through the same `applyToPark`.
  - `web/park-harness.html` plays each feed, made by `scripts/destiny-feed.js`, and compares every ball at
    every tick with the BFF's Park: 35,759 of 35,759 positions identical to the bit over three recordings
    (undock, warp, gate jump in Jita). A one-ulp change to one expected value is reported.

**M1 — fly (in Jita):** character pick, undock from Jita 4-4 into space, real hulls for every ball on grid, retail camera,
double-click to fly, approach/orbit/keep at range, the speed control, overview, selected item,
ship status gauge, brackets.

**M2 — fight:** locking and the target bar, module rack and activation, turret/missile effects,
damage, explosions and wrecks, drones, looting.

**M3 — travel:** align/warp/tunnel, gates and jumps, docking and undocking, the system scene
(sun, planets, nebula), the map, a station view handing over to the station windows.

**M4 — the rest of the game:** the remaining windows in retail chrome (inventory, fitting,
market, industry, mail, fleet, corp, character sheet, chat).

**M5 — polish:** sound, settings, graphics quality levels, performance on large grids.

## How we check it

- **Physics:** the browser Park and the BFF Park on the same recorded feed agree exactly. Our
  existing Destiny fixtures run in the browser build too.
- **Behaviour:** effect timing and ranges compared to Tranquility recordings
  (`D:\SSDSync\EveBadStuff\LOGS`) and the retail client run through Gridcheck.
- **Look:** side-by-side screenshots against the retail client and the eve-cs reference for each
  window and HUD element.
- **Distribution:** a check that no extracted asset is tracked by git.

## Decisions from review (2026-11-09)

1. **All our own code.** No code or converted files are taken from eve-cs; its local copy is a
   visual reference only. The extractor, the Granny/Oodle decoder, the SOF reader, the renderer
   and the UI are written here. We may well arrive at the same design, or a better one.
2. **Client build:** extract from the pinned **3396210** client now. A newer client is coming, so
   the extractor must not hard-code anything build-specific: it reads the build from
   `tq/start.ini`, keeps one output folder per build, and a format change (Granny version, `.black`
   schema, FSD layout) fails loudly with the file named rather than producing wrong data.
3. **Output folder:** `_local/client-assets/<build>/` in this repo, git-ignored. The dev server
   serves the current build's folder.
4. **Starting point:** M1 starts in **Jita** (30000142), undocking from Jita IV - Moon 4 - Caldari
   Navy Assembly Plant. M1's scenery and hull list are therefore the Jita grid first: the station,
   the Caldari star and planets, the gate grid, and whatever ships are in space there.
