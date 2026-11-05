# Goal R109: Industry Manager — a build tree you can save and work through

**Status:** All six slices built and exercised on the running companion (2026-10-01). The layout of section 4 became option C after the first live run: the blueprint browser lives in the left column as a second tab beside the plans, and the right side is only the plan. **Client + BFF only; no eve.js change.**

This is a design document, not a brief to start coding from. It follows R108 (the
Planetary Industry manager) on purpose: same spine-first shape, same intent-only saved
plans, same stock discipline. Where R108 already solved something, this reuses it and
says so.

---

## 1. The ask

1. Choose a blueprint — one a pilot owns, or any blueprint at all.
2. See its whole craft tree, down to raw materials.
3. Save it as a plan.
4. Track what is missing against what the pilots and the corporation hold.
5. (Follows naturally) see what is already being built, and what to start next.

## 2. What already exists

Researched before designing; every line was read, not assumed.

### Static data — the recipe table is already on disk, and already shared with the server

`D:\evet\_local\gameStore\data\industryBlueprints\data.json` (SDE build 3396210, 21.7 MB).
The server reads it in `server/src/services/industry/industryStaticData.js:60-80`; the
companion reads **the same file** through `src/staticData.js:1613` `getIndustryBlueprint`.

| Fact | Value |
|---|---|
| Blueprint rows | 5081, of which **4176 published** (the rest are test/unpublished — filter them) |
| Activities per row | `manufacturing`, `reaction`, `invention`, `copying`, `research_*`, each `{materials, products, skills, time}` |
| Manufacturing rows | 4870 |
| Reaction formulas | 120 (119 published) |
| Invention rows | 1117 (products carry `probability`) |
| Reverse index in file | `blueprintTypeIDsByProductTypeID`, 4839 entries, one blueprint per product |

**Trap, verified:** the file's reverse index contains **none of the 119 reaction
products**, and reaction rows carry `productTypeID: 0` at top level — the product lives
only in `activities.reaction.products`. A product→recipe index must be built from the
activity products, not borrowed from the file.

Reaching the client today: `POST /api/industry/blueprints {blueprintTypeIDs}`
(`src/server.js:20832`, cap 500) — lookup **by blueprint id only**. No product→blueprint
route, no search, no tree.

### Live reads and writes (R15)

`GET /api/bridge/industry` (`server.js:3893`) returns the held character's blueprints
(ME, TE, runs, BPO/BPC, location, busy job), jobs, slot counts, facilities.
`Industry.svelte` lists them and already **installs, delivers and cancels** jobs with a
preview-and-confirm flow. There is no tree, no plan, no "any blueprint" browser.

### The material formula — the server's, exactly

`industryParityHelpers.js:187-230` + `:149-161`, per job, per material:

```
qty = max(runs, ceil(round2(base * runs * (1 - ME/100) * facilityMod)))
```

ME applies to manufacturing only; reactions get the facility modifier alone.
`facilityMod` is the product of the facility's matching modifier tuples (hull + rigs,
rigs scaled by security band), and the live facility read already carries those tuples.

**Existing bug found in passing:** the client's `previewMaterials`
(`web/src/bridge/industry.ts:428-447`) skips both the `round2` step and the facility
modifier, so the install preview can disagree with what the server consumes. That
is a separate `fix/` branch, not part of this goal. Whichever one lands first owns the
shared rounding function, and the other uses it.

### Saved plans — the PI pattern, ready to copy

- `src/companionDb.js` — SQLite at `<dataDir>/companion.sqlite`, versioned by an
  append-only MIGRATIONS array.
- `src/piPlanStore.js` — intent only (type, quantity, note, active/done, `rev`),
  optimistic concurrency (`PI_PLAN_REV_CONFLICT`), limits, global per deployment.
- Routes `GET/POST /api/pi/plans[/:id][/delete]` with an error-code→status map.
- `web/src/app/piPlans.ts` (client wrapper) and `piPlanView.ts` (browser-local view
  state: which plan is open, which nodes are unfolded).
- Status (covered / N to change / N blocked) is **recomputed live**, never stored.

### Stock — the roster snapshot already sees every item

`GET /api/roster/planets` reads each roster pilot through `gateway.getSnapshot` —
**no sign-in, no session** — and `stockFromSnapshot` (`server.js:19672`) walks every item
with its hangar / ship / container and station. It throws away all but planetary
categories (`PLANETARY_CATEGORY_IDS`). The same walk with a different filter is
industry stock. Corp hangars come through `web/src/app/corpStockRead.ts`, and the
`Holding` type in `web/src/bridge/piStock.ts:35` (typeID, quantity, source, place, owner,
read-at) is already generic. Only its display helpers are PI-specific.

### Prices

The only price source is static `basePrice` and the live per-type order book. There is
no adjusted price, so **no job-cost or profit figure can be honest**. Out of scope (§8).

### Prior art (other EVE planners)

| Tool | What it does that matters here |
|---|---|
| Ravworks | Bill of materials + job list + tree view; buy-vs-build per item *type*; pasted stock netted out of the tree; whole-batch rounding with leftovers; jobs split by max length |
| EVE IPH | build/buy by cost comparison; shopping list (desktop, reportedly being abandoned) |
| Indeve | multi-level incl. reactions; inventory integrated; multibuy export; jobs per phase |
| EVE Forge | nested capital trees; ME rounding done right; shopping list with multibuy |
| EVE Industry (eveindustry.app) | the only one with **saved projects** grouping jobs across characters |

Two gaps none of them fill, and both are this app's natural strengths: tracking a plan
as **progress over time**, and **reading stock and jobs live across every pilot** instead
of a pasted inventory. Multibuy text is the de facto shopping-list exchange format.

---

## 3. The one idea the whole system rests on

As with R108, the asks are one question asked several ways. Given a product, a number
of runs and a set of choices, expand the recipe into a tree, and annotate every node
with **how it is obtained** (built here / reacted here / bought / held), **what is
held**, **what is in production**, and **what is missing**.

One pure module, the **industry resolver**, owns that. The tree view, the missing list,
the shopping list and the "start next" list are four renderings of its output.

Rules the resolver must get right, each mutation-tested:

1. **Rounding is per job, not per run.** Use the server formula above. Two jobs of 5 runs
   consume more than one job of 10. A node's `jobs` split is part of its choice, and the
   default is one job.
2. **Outputs come in batches.** A product made 100 per run (ammo) or 160 per run
   (reactions) is built in whole runs. The surplus is shown as **leftover**, never hidden.
3. **Stock is netted top-down before expanding.** Holding 3 of a component means its
   subtree is expanded for `needed - 3` only. Prefer holding an intermediate over
   building it. **The target itself is never netted:** a plan to build ten is not done
   because ten sit in a hangar. Progress on the target comes from jobs (slice 5).
4. **Build or buy is a choice per type** (the Ravworks rule). It is applied to every
   occurrence of that type, because quantities are worked once per type (rule 1 and the
   resolver header). Default: build anything with a published recipe, since the ask is
   to *see the whole tree*. Buying is the player's override. Raw materials (minerals,
   moon goo, PI) are always leaves.
5. **Recipes are facts; the resolver never simulates the server.** Facility modifiers
   come from the live facility read; with no facility chosen the modifier is 1.0 and the
   node says so.
6. **Cycles are refused, not followed.** A product reachable from itself (none expected
   in the SDE, but the data is a build's worth) stops the branch with a stated reason.

### Blueprints the pilots do not own

A plan made from "any blueprint" needs an ME/TE assumption. Default **ME 0 / TE 0** for
T1 originals, and **ME 2 / TE 4** for an invented T2 copy (the game's invention output).
The assumption is editable per blueprint type and stored with the plan. A node built from
an assumed blueprint says *assumed* beside its ME. A node built from an owned one names
the blueprint and where it is.

### T2 and invention

An invented copy is a **leaf with a reason** in v1: *"Needs N invented copies (10 runs
each)."* The datacores and decryptor are listed under it, but there is no probability
arithmetic. Expected-value invention is slice 6.

### PI materials

A planetary commodity in the tree is a leaf for industry, with a link: **Plan this in
Planetary Industry** opens the PI planner on that commodity and quantity. Two planners,
one handoff, no duplicated chain logic.

---

## 4. Where it lives on screen

A new global panel, **Industry Manager**, beside the existing `Industry` panel. `Industry`
stays the per-pilot job desk (install, deliver, cancel). The manager plans and tracks,
and every "start this job" hands off to `Industry`'s existing install flow, prefilled.
That means no second install path and no new write.

**Layout: option A, chosen by the operator on 2026-10-01** from three mockups:
A, a plan list beside the open plan; B, a tree/shopping workspace; C, a flat
stage-by-stage job list. A mirrors `PiManager`'s planner, which the operator already
knows. It borrows one thing from C: **Start next** is grouped by stage (buy, reactions,
components, final) instead of being one flat list.

```
┌ Industry Manager ──────────────────────────────────── [Refresh] ┐
│ Your plans        │ [Owned|Any] [blueprint ............] runs [] │
│  ▣ Hobgoblin II   │ You are short 5 items.  (read-at line)       │
│    10 runs, 5 miss│ ── Missing ───────────────── [Copy multibuy] │
│  ▣ Drake          │    Morphite        10 to buy                 │
│    covered        │    Guidance Sys PI  6 short  (plan in PI)    │
│  ── done ──       │ ── Tree ── fold; build|buy|react per node    │
│  [+ New plan]     │ ── Start next ── by stage: buy, reactions,   │
│                   │    components, final; [Set up in Industry]   │
└───────────────────┴──────────────────────────────────────────────┘
```

Each plan card carries its icon, name, runs, standing words (covered / N missing / N
blocked) and a standing bar, exactly as PI plan cards do. Build square: the mockup's
shapes are illustrative and `--radius-*` is 0.

Registration follows the PI contract: a `TabID` (`web/src/ui/tabs.ts`), a neocom glyph
(`neocomIcons.ts`, exhaustive), a `GLOBAL_TABS` + `GLOBAL_LAUNCHERS` entry, the
`PanelHost` / `GlobalPanel` branch, and `"IndustryManager"` added to
`panelFirstMount.test.ts`.

The tree snippet in `PiManager.svelte:1237` is inline. Extract it into a shared
`BuildTree.svelte` **only if** both panels can use it unchanged. Otherwise the industry
panel gets its own, so that PI is not reshaped for industry's sake.

---

## 5. The slices

Each one can ship on its own. Slice 1 is deliberately invisible, as R108's was.

### Slice 1 — the recipe book and the resolver *(no UI)*

- `staticData.js`: build once, cached: published rows only; a **product→recipe index
  covering manufacturing and reaction products**; per type, its `groupID`/`categoryID`.
- BFF: `POST /api/industry/recipe-closure {productTypeIDs}` returns every recipe
  reachable from those products (the whole subtree, in one call, small), and
  `GET /api/industry/blueprints/search?q=` returns name matches over published
  blueprints and formulas (limit 50). Both are `requireAuth`, static, with no gateway call,
  mirroring `/api/pi/schematics`.
- Client: `web/src/bridge/industryRecipes.ts` (decode, index) and
  `web/src/bridge/industryChain.ts` (the resolver, §3 rules 1-6).

Done when the resolver, driven by the **real table**, expands a T1 hull, a T2 module
(stopping at the invented copy) and a reaction-bearing T2 component. Per-node
quantities must match the server formula, and a test pins a 2-job split consuming more
than 1 job.

### Slice 2 — the panel: pick, see the tree *(no saving, no stock)*

The picker has two sources:

- **Owned:** the held pilot's blueprints from the existing `/api/bridge/industry` read,
  with real ME/TE/runs, BPO or BPC.
- **Any:** the search route.

There is no item picker that scales to thousands of rows today. `GridPicker.svelte`
(filter box + list) is the right shape to reuse.

The tree has fold/unfold, build/buy per node (inherited per type) and leftover lines.

Done when any published blueprint renders a correct tree, and toggling one node to
*buy* collapses its subtree and adds it to the buy list.

### Slice 3 — saved plans

- Migration 2: `industry_plans (id, product_type_id, runs, choices, note, status, rev,
  created_at, updated_at)`. The product alone names the recipe (one recipe per product),
  so no blueprint column is kept.
- `choices` is canonical JSON: `{ buy: [typeID], jobs: { typeID: n }, blueprints:
  { blueprintTypeID: { materialEfficiency, timeEfficiency } } }`. That is what to buy instead
  of build, job splits, and the efficiencies assumed for a blueprint nobody owns. It is
  **intent only**, and nothing computed is stored. A blueprint a pilot owns is always
  planned at its live terms, which override a stored assumption.
- `src/industryPlanStore.js` copies `piPlanStore.js`: limits, `rev` conflict, and the
  shape-only guard. Routes `/api/industry/plans...` go with the error map.
- Client: `industryPlans.ts` + `industryPlanView.ts` (the open plan and hand-made folds,
  in localStorage). Calls go through an online pilot's own session, or with nobody
  online through PI's throwaway hangar sign-in.
- The plan list shows active, then done. A plan's **standing** (covered / N missing)
  needs stock, so it arrives with slice 4.

Done when a plan survives a reload and a second tab's edit is refused, not lost.

### Slice 4 — stock and missing items

- BFF: `POST /api/roster/stock {characterIDs, typeIDs}`. It runs `stockFromSnapshot`, which
  now takes an optional set of type ids in place of the planetary-category filter, so it
  needs no select. With no set it is the planetary read unchanged, and a test pins that. It
  is POST because a capital's tree names a few hundred types.
- Every hangar pilot counts, read one account at a time on a throwaway sign-in, as the
  PI roster read does (`app/industryStockRead.ts`).
- Corp hangars come through `readCorpStock`, which now takes an item filter (planetary
  by default). A corp is read through a pilot of it online here, or one a server bot
  flies, once that pilot's own stock read has said which corp it is in. Per the standing
  rule, corp stock always counts, with no opt-out, and every unit says where it sits.
- Holdings reuse PI's `Holding`. Only two PI helpers changed, both just to be exported:
  `decodeStockStack` and `stationWords`.
- The resolver nets the per-type sum top-down (rule 3). The verdict leads:
  `You have everything to build {n} {name}.` or `You are short {k} items.`
- **Missing** lists each bought item that is still short, with what is held of what is
  needed. Opening one shows every place it sits, personal hangars first, then corp.
- **Copy multibuy** puts `Name quantity` lines on the clipboard. An unnamed item is
  counted, not pasted.
- Read at different moments, more than two minutes apart, it says
  `Read at different times - the oldest is {age} old.` A pilot or corp that could not be
  read says so on its own line, never board-wide.
- Plan cards gain their standing: `covered`, or `N missing`, with a meter of what share
  of the bought items is held in full. Building is work, not a gap: a component whose
  inputs are all held is not missing.
- The stock is read when the window opens, when a newly opened plan brings types the
  last read did not ask about, and on Refresh. It is never read on a timer.

Done when a plan's missing list changes after moving items into a roster pilot's hangar
and pressing Refresh, with no pilot signed in.

### Slice 5 — jobs: in production, and start next

- Running, paused and ready manufacturing and reaction jobs of every online pilot count
  as **in production**: runs times what one run makes, each job once however many
  sessions read it (`bridge/industryJobs.ts`). The resolver takes them as a second
  supply after stock. For an intermediate they shrink what is still short. For the
  target they are the only thing that counts: runs already installed are not started
  again, and their materials are already spent. Jobs never count toward an item the
  plan buys.
- A type nothing still consumes (everything above it held or running) leaves the plan
  entirely: no zero rows in the tree, the lists or the counts.
- **Start next** lists the steps with runs still to start, grouped by stage (reactions,
  components, final), deepest first, after one line pointing at Missing for the
  buying. A step can start when every input is held or in production.
- **Set up in Industry** opens the Industry panel of the pilot who holds the best idle
  copy of that blueprint and is online here (`onOpen("industry", sessionID)`, as the
  Bot Manager opens the builder). The job itself travels on its own signal,
  `app/industryInstallTarget.ts`, modelled on `bots/builderTarget.ts`: addressed to a
  pilot, consumed when served. The Industry panel fills in only step one: the
  blueprint, the work and the runs, served once its recipe has arrived. Choosing the
  facility, previewing the cost and confirming stay its own, so its confirm-gated
  install is still the only way a job starts.
- When every run of the target is in production, the verdict says so and suggests
  marking the plan done once it is delivered.

Done when starting a job from the plan moves that node from *start next* to *in
production* after the read refreshes.

### Slice 6 — invention odds

- **The server's formula**, not a wiki's
  (`server/src/services/industry/industryRuntimeState.js`, `computeInventionProbability`):
  chance = base x (1 + sum over the activity's skills of level x rate) x decryptor,
  capped at 1. The rate is 1/40 for a skill on client type list 799 (the encryption
  skills) and 1/30 for every other. A success gives a copy at ME 2 / TE 4 plus the
  decryptor's, with the product's runs plus the decryptor's and never fewer than one.
- `GET /api/industry/invention-terms` serves the two facts the browser cannot derive. List
  799 is read from the same `clientTypeLists` table the server matches against. Every
  decryptor (group 1304) comes with attributes 1112, 1113, 1114 and 1124 from the same
  `typeDogma` table. The recipe index now keeps each invention's skills.
- A **decryptor choice per T2 blueprint** is saved with the plan (`choices.decryptors`).
  It sets the invented copy's efficiencies and runs in the resolver, so fewer copies
  can be needed and the materials of the T2 step change. A blueprint a pilot owns still
  wins over any invented assumption.
- The chance is worked with the best skills among the pilots online here, each read
  once on its own session as its Skills panel would. With no skills known it is the base
  chance, and the row says skills were not counted.
- **Invention, on average** lists each T2 step: copies of N runs, the chance a try,
  whose skills, and about how many attempts (copies / chance, always rounded up). The
  datacores and decryptors those attempts use join **Missing** and Copy multibuy, tagged
  as invention. They count in the verdict and on the plan card. Variance is not
  modelled, and the words say so.

## 6. States and copy

| Situation | Words |
|---|---|
| Nothing chosen | `Choose a blueprint and this will work out everything it takes to build.` |
| Search, no match | `No blueprint is called that.` |
| Covered | `You have everything to build {n} {name}.` |
| Short | `You are short {k} items.` then the missing list |
| Assumed blueprint | `assumed ME {me}` beside the node |
| Invented copy leaf | `Needs {n} invented copies.` |
| No facility chosen | `No facility bonus counted.` |
| Leftover | `{n} left over` |
| Stale merge | `Read at different times — the oldest is {age} old.` |
| A pilot's stock unreadable | `{Pilot}'s hangars could not be read just now.` (per pilot, never board-wide) |

All copy is plain ASCII, and no ids appear anywhere (R7d).

## 7. Edge cases to specify rather than discover

- A BPC with fewer runs left than the node needs: the node says how many copies are short.
  It does not silently plan against a blueprint that cannot do it.
- Max runs per job (the 30-day rule) splits a node into several jobs, and the rounding
  rises with it. That is visible as a job count on the node.
- Two plans needing the same stock are judged **independently** (as PI does), and the
  plan list says so once. Allocating stock between plans is out of scope.
- The same type under two parents is one line, worked once and rounded once, so it is
  either built or bought everywhere. A per-node override would mean rounding the type
  twice, which is the overstatement rule 1 exists to prevent.
- Very deep capital trees: nodes start folded below depth 2, and the open set is
  remembered per plan.

## 8. Out of scope, and why

- **Job cost, profit, buy-vs-build by price.** No adjusted price or cost index reaches
  the companion. A number built on `basePrice` would be confidently wrong.
- **Starting jobs from the manager.** The install flow exists, is confirm-gated and
  tested. The manager hands off to it, and a second write path is exactly how the two
  would drift.
- **Allocating stock across plans.**
- **Buying on the market from the shopping list.** The `buy-multiple` route exists, but
  spending ISK from a planning view is its own goal.
- **Any eve.js change.** Everything above is reachable from the existing surface.

## 9. Risks

- **The formula drifts from the server's.** Mitigated by porting it with a citation and
  pinning it with tests against hand-checked server arithmetic, including round2.
- **The recipe-closure payload for a capital** may be large. Measure it in slice 1. If it
  exceeds ~500 KB, send only `materials`/`products`/`time` per activity.
- **Facility modifier tuples:** confirm `decodeFacilities` keeps them before slice 4
  counts them. Until then, every node uses 1.0 and says so.
- **PI refactor creep.** Sharing `Holding` must not change a single PI test.

## 10. Test obligations

As R108: every new test is watched failing first. Fixtures come from the real table and
captured bytes, and the resolver is mutation-tested. Pinned cases: per-job rounding,
batch leftovers, reaction products found through the activity index (the file index
misses them), unpublished rows absent, stock netted before expansion, and cycle refusal.
