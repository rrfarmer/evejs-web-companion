import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { resolveUocPage } from "./route.ts";
const require = createRequire(import.meta.url),
  server = pathToFileURL(require.resolve("svelte/internal/server")).href;
async function component(file: string, stubChildren = false, setup = "") {
  const url = new URL(file, import.meta.url);
  const source = readFileSync(url, "utf8");
  let code = compile(setup ? source.replace("</script>", () => setup + "\n</script>") : source, {
    filename: file,
    generate: "server",
  }).js.code.replace("'svelte/internal/server'", JSON.stringify(server));
  if (stubChildren)
    code = code.replace(
      /import (\w+) from ["'][^"']+\.svelte["'];/g,
      (_line, name) =>
        `const ${name}=($r,props={})=>$r.push('<i data-panel="${name}" data-mode="'+(props.mode??'training')+'"></i>');`,
    );
  code = code.replace(/from (["'])(\.[^"']+)\1/g, (_match, _quote, path: string) =>
    "from " + JSON.stringify(new URL(path, url).href));
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`))
    .default;
}
test("routes preserve module hierarchy and bookmarkable section URLs", () => {
  for (const [url, want] of [
    ["/uoc/", "home"],
    ["/uoc/mining-command-center/", "mining-operations"],
    ["/uoc/mining-command-center/?section=civilian", "civilian"],
    ["/uoc/pilot-training/", "training"],
    ["/uoc/ship-provisioning/", "provisioning"],
    ["/uoc/distribution-center/", "distribution"],
  ]) {
    const u = new URL(url!, "http://local");
    assert.equal(resolveUocPage(u.pathname, u.search), want);
  }
  assert.equal(resolveUocPage("/uoc/unknown/", ""), null);
});
test("the hub links to the four open centers and marks Combat as in development", async () => {
  const Hub = await component("../restored/ui/UnifiedOperations.svelte");
  const html = render(Hub, {}).body;
  assert.equal((html.match(/<a class="module\b/g) ?? []).length, 4);
  for (const path of [
    "mining-command-center",
    "pilot-training",
    "ship-provisioning",
    "distribution-center",
  ]) {
    assert.ok(html.includes(`href="/uoc/${path}/"`), path);
  }
  assert.ok(html.includes('href="/"'));
  assert.doesNotMatch(html, /href="\/uoc\/combat-operations-center/);
  assert.match(html, /aria-disabled="true"[^>]*>.*Combat Operations Center.*In development/s);
});
test("Combat bookmarks lead to the in-development page without mounting the workspace", () => {
  for (const section of ["", "?section=security", "?section=anomalies"]) {
    assert.equal(
      resolveUocPage("/uoc/combat-operations-center/", section),
      "combat-in-development",
    );
  }
  const page = readFileSync(new URL("./ModulePage.svelte", import.meta.url), "utf8");
  assert.match(
    page,
    /activePage === "combat-in-development".*title="Combat Operations Center".*state="In development"/s,
  );
  assert.doesNotMatch(page, /CombatOperations\.svelte|<CombatOperations\b/);
});
test("module routes mount original centers, keeping Civilian inside MCC", () => {
  const source = readFileSync(new URL("./ModulePage.svelte", import.meta.url), "utf8");
  for (const name of [
    "UnifiedOperations",
    "MiningCommandCenter",
    "GoblinFactory",
    "ProvisioningCenter",
    "DistributionCenter",
  ])
    assert.ok(source.includes(`../restored/ui/${name}.svelte`));
  for (const old of ["MiningFleetPanel", "CombatPanel", "AnomalyFleetPanel", "TrainingPanel"])
    assert.ok(!source.includes(old));
  const mcc = readFileSync(
    new URL("../restored/ui/MiningCommandCenter.svelte", import.meta.url),
    "utf8",
  );
  assert.ok(mcc.includes("CivilianMissions"));
  assert.ok(mcc.includes("section=civilian"));
  assert.ok(!source.includes("<CivilianMissions"));
});
test("the registered page loads UOC through the shared WC build", async () => {
  const { default: manifest } = await import("../plugin.ts");
  const { default: views } = await import("../views.ts");
  assert.ok(manifest.page);
  assert.equal(typeof views.page, "function");
  const build = readFileSync(new URL("../build-page.mjs", import.meta.url), "utf8");
  assert.match(build, /"\.\/node_modules\/vite\/bin\/vite\.js", "build"/);
  assert.doesNotMatch(build, /configFile:\s*false|public\/dist\/uoc/);
});
test("operations and pilot selection use current workspace access without an account sign-in gate", () => {
  for (const name of [
    "MiningCommandCenter",
    "CivilianMissions",
    "CombatOperations",
    "OperationPilotPicker",
    "GoblinFactory",
    "ProvisioningCenter",
  ]) {
    const source = readFileSync(new URL(`../restored/ui/${name}.svelte`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /FarmerAccountPicker|signInFarmerAccount/, name);
  }
  const provisioning = readFileSync(
    new URL("../restored/ui/ProvisioningCenter.svelte", import.meta.url),
    "utf8",
  );
  assert.match(provisioning, /connect\(row\.accountName, row\.characterID\)/);
});
test("standalone tools retain the actual WC74 stage structure and candidate resource readout", () => {
  const training = readFileSync(
      new URL("../restored/ui/GoblinFactory.svelte", import.meta.url),
      "utf8",
    ),
    provisioning = readFileSync(
      new URL("../restored/ui/ProvisioningCenter.svelte", import.meta.url),
      "utf8",
    );
  for (const child of ["TrainingGoal", "TrainingPilotSkills", "TrainingSettingsPanel"])
    assert.ok(training.includes(child));
  for (const stage of [
    "1. Choose pilot",
    "2. Choose ship and fitting",
    "3. Inspect equipment",
    "4. Review plan",
    "5. Confirm equipment changes",
  ])
    assert.ok(provisioning.toLowerCase().includes(stage.toLowerCase()), stage);
  assert.ok(provisioning.includes("CPU"));
  assert.ok(provisioning.includes("Powergrid"));
  assert.ok(provisioning.includes("cpuRemaining"));
});
test("the Civilian profile editor keeps mission settings and stays inside the Civilian page", () => {
  const source = readFileSync(
    new URL("../restored/ui/CivilianMissions.svelte", import.meta.url),
    "utf8",
  );
  for (const panel of [
    "TrainingPanel",
    "ProvisioningCenter",
    "MiningFleetPanel",
    "CombatOperations",
  ])
    assert.ok(!source.includes(panel));
  for (const field of ["Mission type", "Level rule", "Stop rule", "Add pilot"])
    assert.ok(source.includes(field), field);
});

test("UOC status badges retain readable labels across centers", async () => {
  const Status = await component("../restored/ui/CenterStatus.svelte");
  for (const [state, tone] of [
    ["Active", "active"],
    ["Ready", "ready"],
    ["Paused", "paused"],
    ["Stopped", "stopped"],
    ["Needs attention", "attention"],
  ] as const) {
    const html = render(Status, { props: { state } }).body;
    assert.match(html, new RegExp(`data-tone="${tone}"[^>]*>${state}<`));
  }
});

test("Distribution renders named routes, confirmed progress and freight needing attention", async () => {
  const { register } = await import("node:module");
  register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);
  const { default: Workspace } = await import("../restored/ui/DistributionWorkspace.svelte");
  const { default: Editor } = await import("../restored/ui/DistributionEditor.svelte");
  const selected = {
    id: "route",
    config: {
      name: "Ore delivery",
      mode: "MANUAL",
      corporationID: 99,
      source: {
        name: "Source Station",
        kind: "station",
        destinationID: 60000001,
        systemID: 1,
        division: 7,
      },
      destination: {
        name: "Delivery Hub",
        kind: "structure",
        destinationID: 1030000000001,
        systemID: 2,
        division: 1,
      },
      items: [{ typeID: 1230, name: "Veldspar", quantity: 15 }],
      fillPercent: 0,
      waitMinutes: 0,
    },
    execution: { id: "run", state: "STOPPING", delivered: { 1230: 6 }, trips: 1 },
  };
  const props = {
    view: {
      ok: true,
      operations: [selected],
      roster: [
        {
          characterID: 99,
          account: "known-account",
          name: "Transporter",
          shipName: "FixtureHauler",
          hosted: null,
          trip: {
            operationID: "route",
            cargo: [{ typeID: 1230, quantity: 9 }],
            checking: null,
            issue: "Destination hangar is unavailable.",
          },
        },
      ],
    },
    selected,
    availability: {},
    names: { 1230: "Veldspar" },
    docks: {},
    busy: false,
    issue: "",
  };
  const operations = render(Workspace, { props: { ...props, section: "operations" } }).body;
  assert.match(operations, /Source Station.*Division 7/s);
  assert.match(operations, /Delivery Hub.*Division 1/s);
  assert.match(operations, /6 \/ 15 delivered/);
  assert.match(operations, /Finishing freight/);
  const fleet = render(Workspace, { props: { ...props, section: "fleet" } }).body;
  assert.match(
    fleet,
    /FixtureHauler.*Needs attention.*Destination hangar is unavailable.*9 Veldspar aboard/s,
  );
  assert.match(fleet, /data-tone="attention"[^>]*>Needs attention/);
  assert.match(operations, /data-tone="paused"[^>]*>Finishing freight/);
  assert.match(operations, /class="center-heading".*<h1>Distribution Center<\/h1>/s);
  assert.doesNotMatch(operations + fleet, /60000001|1030000000001|known-account|custody|claims/i);
  const editor = render(Editor, {
    props: { initial: { ...selected.config, mode: "SUPPLY" }, corporations: [], busy: false },
  }).body;
  for (const label of ["Item catalog", "Keep at destination", "Maximum wait", "Save operation"])
    assert.ok(editor.includes(label));
  assert.doesNotMatch(editor, /All items in source division/);
  const all = {
    ...selected,
    config: { ...selected.config, allItems: true, items: [] },
    execution: {
      ...selected.execution,
      state: "INCOMPLETE",
      deliveredVolumeM3: 2.5,
      unshipped: [
        {
          typeID: 34,
          quantity: 8,
          reason: "One unit does not fit in this hauler's compatible holds.",
        },
      ],
    },
  };
  const allEditor = render(Editor, {
    props: { initial: all.config, corporations: [], busy: false },
  }).body;
  assert.match(allEditor, /Selected items.*All items in source division/s);
  assert.doesNotMatch(allEditor, /Item catalog/);
  const result = render(Workspace, {
    props: {
      ...props,
      view: { ...props.view, operations: [all] },
      selected: all,
      names: { ...props.names, 34: "Tritanium" },
      section: "operations",
    },
  }).body;
  for (const label of [
    "containers and their contents",
    "Finished with items left",
    "6 units delivered",
    "Items left at source",
    "8 × Tritanium",
  ])
    assert.ok(result.includes(label), label);
  assert.match(result, /2[.,]5 m³/);
});

test("Training lists saved HR candidates before a trainee or account is opened", async () => {
  const { register } = await import("node:module");
  register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);
  const { setKnownCharacterStorage } = await import("../../../web/src/app/knownCharacters.ts");
  const { installPageContext } = await import("../restored/app/context.ts");
  const { default: Training } = await import("../restored/ui/GoblinFactory.svelte");
  const key = "evejs-web-known-characters:v1";
  setKnownCharacterStorage({
    getItem: (name) =>
      name === key
        ? JSON.stringify([
            {
              accountName: "Foreman",
              characterID: 10,
              characterName: "Corporate Director",
              shipName: null,
              skillPoints: null,
              balance: null,
              lastSeen: 1,
            },
            {
              accountName: "Miner",
              characterID: 11,
              characterName: "FixtureMiner4",
              shipName: null,
              skillPoints: null,
              balance: null,
              lastSeen: 1,
            },
          ])
        : null,
    setItem: () => assert.fail("Rendering the initial roster must be passive."),
  });
  installPageContext({
    accountPass: {
      optionsFor: async () => assert.fail("Displaying candidates must not authorize the roster."),
      forget: () => {},
      release: async () => {},
    },
  });
  try {
    const html = render(Training, {}).body;
    assert.doesNotMatch(html, /Create account/);
    const picker = html.match(/<label[^>]*>Corporation HR Pilot[\s\S]*?<\/select>/)?.[0];
    assert.ok(picker);
    assert.match(picker, /Corporate Director · Foreman/);
    assert.match(picker, /FixtureMiner4 · Miner/);
    assert.match(html, /<button[^>]* disabled[^>]*>Save corporation settings<\/button>/);
  } finally {
    installPageContext({});
    setKnownCharacterStorage(null);
  }
});

test("Training permits saving a verified Director in the current world", async () => {
  const { register } = await import("node:module");
  register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);
  const { default: Settings } = await import("../restored/ui/TrainingSettings.svelte");
  const { defaultTrainingSettings, trainingPilotKey } =
    await import("../restored/training/settings.ts");
  const key = trainingPilotKey("Foreman", 10);
  const props = {
    settings: {
      ...defaultTrainingSettings(),
      onboarding: { enabled: true, corporationID: 123, authorityKey: key, rights: "NONE" },
    },
    corporations: [
      {
        corporationID: 123,
        name: "Verified Corporation",
        divisions: [{ accountKey: 1000, name: "Master Wallet" }],
      },
    ],
    authorities: [
      {
        characterID: 10,
        key,
        name: "Director",
        account: "Foreman",
        corporationID: 123,
        eligible: true,
      },
    ],
    candidates: [{ key, name: "Director", account: "Foreman" }],
    busy: false,
    worldReady: true,
    onInspect: () => {},
    onSave: () => {},
  };
  const renderWith = (input: typeof props) => render(Settings, { props: input }).body;
  const html = renderWith(props);
  assert.match(html, /Verified Corporation \(123\)/);
  const saveButton = html.match(/<button[^>]*>Save corporation settings<\/button>/)?.[0];
  assert.ok(saveButton);
  assert.doesNotMatch(saveButton, /\bdisabled\b/);
  assert.match(
    renderWith({ ...props, worldReady: false }),
    /<button[^>]* disabled[^>]*>Save corporation settings<\/button>/,
  );
  assert.match(
    renderWith({ ...props, authorities: [{ ...props.authorities[0]!, eligible: false }] }),
    /<button[^>]* disabled[^>]*>Save corporation settings<\/button>/,
  );
});

test("Training funding restores legacy settings, persists the chosen policy and renders its selected option", async () => {
  const { register } = await import("node:module");
  register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);
  const { default: Settings } = await import("../restored/ui/TrainingSettings.svelte");
  const { defaultTrainingSettings, readTrainingSettings, saveTrainingSettings, trainingPilotKey } =
    await import("../restored/training/settings.ts");
  const legacy = {
    ...defaultTrainingSettings(),
    fundingPolicy: undefined,
    onboarding: {
      enabled: true,
      corporationID: 123,
      authorityKey: trainingPilotKey("Foreman", 10),
      rights: "NONE" as const,
    },
    trainingWallet: { corporationID: 123, accountKey: 1000 },
    home: {
      locationID: 6,
      name: "Home",
      systemID: 3,
      kind: "NPC_STATION",
      relocation: "MANUAL_GM_ONLY",
      capability: "STATION",
    },
  };
  let raw: string | null = null;
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
  };
  assert.equal(readTrainingSettings(storage).fundingPolicy, "CHARACTER_WALLET_ONLY");
  for (const [automaticFunding, fundingPolicy] of [
    [false, "CHARACTER_WALLET_ONLY"],
    [true, "CHARACTER_PLUS_CORPORATION_SHORTFALL"],
  ] as const) {
    raw = JSON.stringify({ ...legacy, automaticFunding });
    assert.equal(readTrainingSettings(storage).fundingPolicy, fundingPolicy);
  }
  const saved = {
    ...readTrainingSettings(storage),
    fundingPolicy: "CORPORATION_WALLET_ONLY" as const,
    automaticFunding: undefined,
  };
  saveTrainingSettings(storage, saved);
  const reopened = readTrainingSettings(storage);
  assert.equal(reopened.fundingPolicy, "CORPORATION_WALLET_ONLY");
  assert.deepEqual(reopened.onboarding, legacy.onboarding);
  assert.deepEqual(reopened.trainingWallet, legacy.trainingWallet);
  assert.deepEqual(reopened.home, legacy.home);
  const html = render(Settings, {
    props: {
      settings: reopened,
      corporations: [],
      authorities: [],
      busy: false,
      worldReady: true,
      onInspect: () => {},
      onSave: () => {},
    },
  }).body;
  assert.match(html, /Set up an HR pilot in EveJS/);
  assert.match(html, /Pilot wallet only/);
  assert.match(html, /Pilot wallet, then corporation/);
  assert.match(
    html,
    /<option value="CORPORATION_WALLET_ONLY" selected(?:="")?>Corporation wallet only/,
  );
  assert.match(html, /transfers the full book cost/);
});

test("Provisioning places the pilot filter beside the compact selector", async () => {
  const { register } = await import("node:module");
  register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);
  const { default: Provisioning } = await import("../restored/ui/ProvisioningCenter.svelte");
  const html = render(Provisioning, {}).body;
  const section = html.match(/<h2[^>]*>1\. Choose pilot<\/h2>[\s\S]*?<\/section>/)?.[0];
  assert.ok(section);
  assert.equal((section.match(/<select\b/g) ?? []).length, 1);
  assert.match(section, /<option[^>]*value=""[^>]*>Choose a pilot<\/option>/);
  assert.match(section, /Refresh pilots/);
  assert.match(
    section,
    /<div[^>]*class="picker-controls[^"]*"[^>]*>[\s\S]*?<select\b[\s\S]*?Filter pilots\s*<input[^>]*type="search"/,
  );
});

test("standalone Provisioning shows the inspection available to the selected pilot", async () => {
  const Provisioning = await component("../restored/ui/ProvisioningCenter.svelte", true, `
    const { owner, serviceAccess } = $props();
    token = "page-token";
    pilotID = provider = 7;
    fittingID = 11;
    roster = { pilots: [{ characterID: pilotID, name: "Hauler", control: { owner, online: owner !== "OFF" }, serviceAccess }], providers: [] };
    preflight = { definitions: { contracts: [{ name: "Hauling fit", shipTypeID: 100, definition: { fittingID } }], invalid: [] } };
  `);
  for (const owner of ["OFF", "BROWSER", "BOT"]) {
    const serviceAccess = owner === "BOT" ? "READ_ONLY_ACTIVE_UOC" : null;
    const html = render(Provisioning, { props: { owner, serviceAccess } }).body;
    assert.match(html, /Hauling fit/);
    assert.doesNotMatch(html, /Review fitting in Cockpit|Inspect Cockpit inventory/);
    const check = html.match(/(<button\b[^>]*>)\s*Check ship and available equipment\s*<\/button>/);
    assert.ok(check);
    assert.equal(/\bdisabled\b/.test(check[1]!), owner === "BROWSER");
    if (owner === "BROWSER") assert.match(html, /Fitting and Inventory in .*Cockpit/);
  }
});
