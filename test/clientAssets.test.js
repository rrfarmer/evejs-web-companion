"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createClientAssets } = require("../src/clientData/clientAssets");
const { createApp } = require("../src/server");
const { extractOverviewPresets, extractSystemCelestials } = require("../tools/client-extract/extract.mjs");
const { buildGraphicSofDefaults } = require("../tools/client-extract/lib/assetSde.mjs");
const { buildHull, SOF_BUILD } = require("../tools/client-extract/lib/sof.mjs");
const { buildSystemScenes, indexedHullGeometry, CELESTIAL_BUILD } = require("../tools/client-extract/lib/typeGraphics.mjs");

async function put(root, name, value) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function withAssets(options, run) {
  const app = createApp({
    eveStore: {}, eveGatewayClient: {}, webAuth: {}, staticData: {}, errorLogger() {},
    clientAssets: createClientAssets({ clientRoot: null, build: "", errorLogger() {}, ...options }),
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(pathname => `http://127.0.0.1:${server.address().port}${pathname}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("a SKIN's path insert chooses installed variants for individual hull textures", () => {
  const root = "res:/dx9/model/ship/minmatar/frigate/mf4/";
  const material = root + "mf4_t1_m.dds";
  const albedo = root + "mf4_t1_a.dds";
  const navyMaterial = root + "navy/mf4_t1_navy_m.dds";
  const nefantarMaterial = root + "nefantar/mf4_t1_nefantar_m.dds";
  const installed = new Set([material, albedo, navyMaterial, nefantarMaterial]);
  const hull = { name: "mf4_t1", opaqueAreas: [{ textures: [
    { name: "MaterialMap", resFilePath: material },
    { name: "AlbedoMap", resFilePath: albedo },
  ] }] };
  const sof = {
    data: {},
    hulls: new Map([[hull.name, hull]]),
    factions: new Map([["minmatarnavy", { resPathInsert: "navy" }]]),
    materials: new Map(),
    hasResource: resource => installed.has(resource),
  };
  const maps = set => buildHull(sof, hull.name, "minmatarnavy", null, set).areas[0].textures;
  assert.deepEqual(maps(null), { MaterialMap: navyMaterial, AlbedoMap: albedo });
  assert.deepEqual(maps({ resPathInsert: "" }), { MaterialMap: navyMaterial, AlbedoMap: albedo });
  assert.deepEqual(maps({ resPathInsert: "Nefantar" }), { MaterialMap: nefantarMaterial, AlbedoMap: albedo });
  assert.deepEqual(maps({ resPathInsert: "missing" }), { MaterialMap: material, AlbedoMap: albedo });
  assert.deepEqual(maps({ resPathInsert: "None" }), { MaterialMap: material, AlbedoMap: albedo });
});

test("a stock graphic default uses its own SOF variant across type and graphic requests", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evejs-client-stock-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const clientRoot = path.join(temp, "install"), root = path.join(temp, "assets"), dir = path.join(root, "3698585");
  const sde = path.join(temp, "sde");
  const stem = "dx9/model/crane";
  const ship = { graphicID: 2709, hull: "ci1_t2", faction: "kaalakiota", race: "caldari", gr2: `res:/${stem}.gr2` };
  const recipe = { _key: 385, sofFactionName: "kaalakiota", resPathInsert: "none" };
  await put(clientRoot, "tq/start.ini", "build=3698585\n");
  await put(sde, "graphics.jsonl", JSON.stringify({ _key: 2709, sofHullName: ship.hull, sofMaterialSetID: 385 }) + "\n");
  await put(sde, "graphicMaterialSets.jsonl", JSON.stringify(recipe) + "\n");
  await put(dir, "config.json", JSON.stringify({ sde }));
  await put(dir, "typeGraphics.json", JSON.stringify({ 12729: ship, 12730: { ...ship, graphicID: 2710 } }));
  await put(dir, "graphics/2709.json", JSON.stringify(ship));
  await put(dir, `${stem}.glb`, "mesh");
  await put(dir, `${stem}.json`, JSON.stringify({ textures: {}, lods: [0] }));
  await put(dir, `${stem}.kaalakiota.sof.json`, JSON.stringify({ sofBuild: SOF_BUILD }));
  const extracted = [];
  await withAssets({
    root, clientRoot,
    async extract(args) {
      const command = args.slice(4);
      extracted.push(command);
      if (command[0] === "--sof-defaults") {
        const defaults = buildGraphicSofDefaults(sde);
        assert.deepEqual(defaults, { 2709: recipe });
        await put(dir, "graphicSofDefaults.json", JSON.stringify(defaults));
      } else {
        assert.deepEqual(command, ["--type", "12729"]);
        await put(dir, `${stem}.kaalakiota.material-385.sof.json`, JSON.stringify({ sofBuild: SOF_BUILD }));
      }
    },
  }, async url => {
    const route = "/client-assets/type/12729";
    const [first, second] = await Promise.all([fetch(url(route)), fetch(url(route))]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const model = await first.json();
    assert.deepEqual(await second.json(), model);
    const graphic = await fetch(url("/client-assets/graphic/2709")).then(r => r.json());
    const faction = await fetch(url("/client-assets/type/12730")).then(r => r.json());
    assert.equal(model.sofMaterialSetID, 385);
    assert.equal(model.sof, `/client-assets/${stem}.kaalakiota.material-385.sof.json`);
    assert.equal(graphic.sof, model.sof);
    assert.equal(faction.sof, `/client-assets/${stem}.kaalakiota.sof.json`);
    assert.equal(faction.model, model.model);
  });
  assert.deepEqual(extracted, [["--sof-defaults"], ["--type", "12729"]]);
});

test("the production BFF serves the installed build with standard asset responses", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evejs-client-assets-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const clientRoot = path.join(temp, "install");
  const root = path.join(temp, "assets");
  await put(clientRoot, "tq/start.ini", "build=3698585\n");
  await put(root, "3698585/typeNames.json", '{"build":3698585}');
  await put(root, "9999999/typeNames.json", '{"build":9999999}');
  await put(root, "3698585/config.json", '{"client":"local-only"}');
  await put(root, "3698585/extract.log", "local-only");
  await put(root, "3698585/audio/sample.ogg", Buffer.from("OggS-fake"));
  const decalMask = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII=", "base64");
  await put(root, "3698585/dx9/model/decal/registry.png", decalMask);
  await withAssets({ root, clientRoot, fallbackBuild: "3396210" }, async url => {
    const index = await fetch(url("/client-assets/typeNames.json?v=1"));
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /^application\/json\b/);
    assert.deepEqual(await index.json(), { build: 3698585 });
    const media = await fetch(url("/client-assets/audio/sample.ogg"), { headers: { Range: "bytes=0-3" } });
    assert.equal(media.status, 206);
    assert.match(media.headers.get("content-type"), /^audio\/ogg\b/);
    assert.equal(await media.text(), "OggS");
    const mask = await fetch(url("/client-assets/dx9/model/decal/registry.png"));
    assert.equal(mask.status, 200);
    assert.match(mask.headers.get("content-type"), /^image\/png\b/);
    assert.deepEqual(Buffer.from(await mask.arrayBuffer()), decalMask);
    const head = await fetch(url("/client-assets/audio/sample.ogg"), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    for (const name of ["missing.glb", "config.json", "extract.log"]) {
      const response = await fetch(url(`/client-assets/${name}`));
      assert.equal(response.status, 404, name);
      assert.equal(await response.text(), "", name);
    }
  });
  await withAssets({ root, clientRoot, build: "9999999" }, async url => {
    const response = await fetch(url("/client-assets/typeNames.json"));
    assert.deepEqual(await response.json(), { build: 9999999 });
  });
});

test("a cold SKIN request bakes a separate SOF variant over the stock geometry", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evejs-client-skin-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const clientRoot = path.join(temp, "install");
  const root = path.join(temp, "assets");
  const dir = path.join(root, "3698585");
  const stem = "dx9/model/naga";
  const ship = { hull: "cbc3_fn", faction: "caldarinavy", race: "caldari", gr2: `res:/${stem}.gr2` };
  await put(clientRoot, "tq/start.ini", "build=3698585\n");
  await put(dir, "typeGraphics.json", JSON.stringify({ 95630: ship }));
  await put(dir, `${stem}.glb`, "mesh");
  await put(dir, `${stem}.json`, JSON.stringify({ textures: {}, lods: [0] }));
  await put(dir, `${stem}.caldarinavy.sof.json`, JSON.stringify({ sofBuild: SOF_BUILD }));
  const extracted = [];
  await withAssets({ root, clientRoot, async extract(args) {
    extracted.push(args.slice(-3));
    await put(dir, "typeSkins/95630.3657.json", JSON.stringify({
      ...ship, typeID: 95630, faction: "empire_caldari", skinMaterialSetID: 3657, sofBuild: SOF_BUILD,
    }));
    await put(dir, `${stem}.type-95630.skin-3657.sof.json`, JSON.stringify({ sofBuild: SOF_BUILD }));
  } }, async url => {
    const stock = await fetch(url("/client-assets/type/95630")).then(response => response.json());
    const address = url("/client-assets/type/95630/skin/3657");
    const res = await Promise.all([fetch(address), fetch(address)]);
    const [painted, second] = await Promise.all(res.map(response => response.json()));
    assert.deepEqual(painted, second);
    assert.equal(painted.model, stock.model);
    assert.equal(stock.sof, `/client-assets/${stem}.caldarinavy.sof.json`);
    assert.equal(painted.sof, `/client-assets/${stem}.type-95630.skin-3657.sof.json`);
    assert.equal(painted.faction, "empire_caldari");
  });
  assert.deepEqual(extracted, [["--type-skin", "95630", "3657"]]);
});

test("the portal's production route refreshes the cached shader quality branches", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evejs-client-portal-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const clientRoot = path.join(temp, "install");
  const root = path.join(temp, "assets");
  const dir = path.join(root, "3698585");
  const graphicIDs = ["20956", "28102"];
  const extracted = [];
  await put(clientRoot, "tq/start.ini", "build=3698585\n");
  for (const id of graphicIDs) await put(dir, `effects/${id}.json`, '{"effectBuild":4}');
  await withAssets({ root, async extract() { assert.fail("serving a portable asset should not need an install"); } }, async url => {
    const response = await fetch(url("/client-assets/effect/20956.json"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).effectBuild, 4);
  });
  await withAssets({
    root,
    clientRoot,
    async extract(args) {
      const [flag, id] = args.slice(-2);
      assert.equal(flag, "--effect");
      extracted.push(id);
      const controllerVariableOverrides = id === "28102" ? { WH_State: 1 } : {};
      await put(dir, `effects/${id}.json`, JSON.stringify({ effectBuild: 6, root: { displayFilter: 0 }, controllerVariableOverrides }));
    },
  }, async url => {
    for (const id of graphicIDs) {
      const address = url(`/client-assets/effect/${id}.json`);
      const responses = await Promise.all([fetch(address), fetch(address)]);
      for (const response of responses) {
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.root.displayFilter, 0);
        assert.deepEqual(data.controllerVariableOverrides, id === "28102" ? { WH_State: 1 } : {});
      }
    }
  });
  assert.deepEqual(extracted, graphicIDs);
});

test("overview extraction rejects a decompile for a different install build", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evejs-client-assets-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const clientRoot = path.join(temp, "install");
  const clientCode = path.join(temp, "python");
  await put(clientRoot, "tq/start.ini", "build=3698585\n");
  await put(clientCode, "MANIFEST.json", '{"build":3396210}');
  assert.throws(
    () => extractOverviewPresets(null, clientRoot, temp, clientCode),
    /Overview presets need build 3698585 client code, got 3396210/,
  );
  await assert.rejects(fs.access(path.join(temp, "overviewPresets.json")), { code: "ENOENT" });
});

test("concurrent model requests share one extraction and produce the model and its metadata", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evejs-client-assets-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const clientRoot = path.join(temp, "install");
  const root = path.join(temp, "assets");
  const dir = path.join(root, "3698585");
  await put(clientRoot, "tq/start.ini", "build=3698585\n");
  await put(dir, "typeGraphics.json", JSON.stringify({
    603: { gr2: "res:/dx9/model/merlin.gr2", faction: "caldari" },
  }));
  await put(dir, "dx9/model/merlin.glb", Buffer.from("glTF"));
  let extracted = 0;
  await withAssets({
    root,
    clientRoot,
    async extract(args) {
      assert.deepEqual(args.slice(-2), ["--type", "603"]);
      extracted++;
      await put(dir, "dx9/model/merlin.json", '{"textures":{},"lods":[{}]}');
      await put(dir, "dx9/model/merlin.caldari.sof.json", JSON.stringify({ sofBuild: SOF_BUILD }));
    },
  }, async url => {
    const answers = await Promise.all(Array.from({ length: 4 }, () => fetch(url("/client-assets/type/603"))));
    for (const answer of answers) {
      assert.equal(answer.status, 200);
      assert.deepEqual(await answer.json(), {
        typeID: 603, model: "/client-assets/dx9/model/merlin.glb", sof: "/client-assets/dx9/model/merlin.caldari.sof.json",
        textures: {}, lods: 1, gr2: "res:/dx9/model/merlin.gr2", faction: "caldari",
      });
    }
    assert.equal(extracted, 1);
    const model = await fetch(url("/client-assets/dx9/model/merlin.glb"));
    assert.equal(model.headers.get("content-type"), "model/gltf-binary");
    assert.equal(await model.text(), "glTF");
  });
});

test("the native SOF mesh path resolves differently named indexed hull geometry", () => {
  const indexed = "res:/dx9/model/structure/amarr/modular/construction/amarr_containers_01a.gr2";
  const resources = new Set([indexed]);
  assert.equal(indexedHullGeometry(resources, { geometryResFilePath: indexed.toUpperCase() }), indexed);
  assert.equal(indexedHullGeometry(resources, { geometryResFilePath: "res:/dx9/absent.gr2" }), null);
});

test("an older type index learns the authored mesh once, including for concurrent requests", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evejs-client-yard-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const clientRoot = path.join(temp, "install"), root = path.join(temp, "assets"), dir = path.join(root, "3698585");
  const stem = "dx9/model/structure/amarr/modular/construction/amarr_containers_01a";
  const gr2 = `res:/${stem}.gr2`;
  await put(clientRoot, "tq/start.ini", "build=3698585\n");
  await put(dir, "typeGraphics.json", JSON.stringify({ 76218: { hull: "ama_containers_01a", faction: "amarrbase", gr2: null } }));
  let extracted = 0;
  await withAssets({
    root, clientRoot,
    async extract(args) {
      assert.deepEqual(args.slice(-2), ["--type", "76218"]);
      extracted++;
      await put(dir, `${stem}.glb`, "glTF");
      await put(dir, `${stem}.json`, '{"textures":{},"lods":[{}]}');
      await put(dir, `${stem}.amarrbase.sof.json`, JSON.stringify({ sofBuild: SOF_BUILD }));
      await put(dir, "typeGeometry/76218.json", JSON.stringify({ gr2 }));
    },
  }, async url => {
    const requests = await Promise.all([fetch(url("/client-assets/type/76218")), fetch(url("/client-assets/type/76218"))]);
    for (const response of requests) {
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.gr2, gr2);
      assert.equal(body.model, `/client-assets/${stem}.glb`);
      assert.equal(body.sof, `/client-assets/${stem}.amarrbase.sof.json`);
    }
    assert.equal(extracted, 1);
  });
});

test("celestial caches refresh the installed population flags and keep legacy files readable", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evejs-client-planets-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const clientRoot = path.join(temp, "install"), root = path.join(temp, "assets"), dir = path.join(root, "3698585");
  const sde = path.join(temp, "sde");
  const solarSystemID = 30000144;
  const file = "celestials/30000144.json";
  const legacy = { solarSystemID, celestialBuild: 2, items: { 40009235: { typeID: 11, kind: "planet" } } };
  await put(dir, file, JSON.stringify(legacy));
  await withAssets({ root, build: "3698585" }, async url => {
    const old = await fetch(url("/client-assets/" + file));
    assert.equal(old.status, 200);
    assert.deepEqual(await old.json(), legacy);
  });

  await put(clientRoot, "tq/start.ini", "build=3698585\n");
  await put(sde, "graphics.jsonl", "");
  await put(sde, "mapPlanets.jsonl", [
    { _key: 40009235, solarSystemID, typeID: 11, attributes: { population: true } },
    { _key: 40009238, solarSystemID, typeID: 11, attributes: { population: false } },
    { _key: 40009241, solarSystemID, typeID: 11 },
  ].map(row => JSON.stringify(row)).join("\n"));
  await put(sde, "mapMoons.jsonl", "");
  let bakes = 0;
  await withAssets({
    root,
    clientRoot,
    async extract(args) {
      assert.deepEqual(args.slice(-2), ["--system-celestials", "30000144"]);
      bakes++;
      await extractSystemCelestials({ has: () => false }, sde, solarSystemID, dir);
    },
  }, async url => {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url("/client-assets/" + file));
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.celestialBuild, CELESTIAL_BUILD);
      assert.deepEqual(Object.values(data.items).map(item => item.population), [true, false, null]);
    }
    assert.equal(bakes, 1);
  });
});

test("cold celestial requests combine the installed graphic IDs and matching map export", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evejs-split-sde-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const clientRoot = path.join(temp, "install");
  const root = path.join(temp, "assets");
  const graphics = path.join(temp, "eve-online-client-static-data-3698585-jsonl");
  const maps = path.join(temp, "eve-online-static-data-3698585-jsonl");
  const solarSystemID = 30002659;
  const heightMap = "res:/texture/planet.dds";
  const nebula = "res:/dx9/scene/universe/g01_cube.red";
  await put(clientRoot, "tq/start.ini", "build=3698585\n");
  await put(clientRoot, "tq/resfileindex.txt", heightMap + ",00/planet,test,4,4\n");
  await put(clientRoot, "ResFiles/00/planet", "DDS ");
  await put(root, "3698585/config.json", JSON.stringify({ client: clientRoot, sde: graphics, build: "3698585" }));
  await put(graphics, "_sde.jsonl", '{"clientBuild":"3698585"}\n');
  await put(graphics, "graphicids.jsonl", [
    { _key: 3842, graphicFile: heightMap },
    { _key: 11824, graphicFile: nebula },
  ].map(row => JSON.stringify(row)).join("\n"));
  await put(maps, "_sde.jsonl", '{"buildNumber":3698585}\n');
  await put(maps, "mapPlanets.jsonl", JSON.stringify({
    _key: 40169266, solarSystemID, typeID: 2016,
    attributes: { population: false, heightMap1: 3842 },
  }));
  await put(maps, "mapMoons.jsonl", JSON.stringify({ _key: 40169269, solarSystemID, typeID: 14 }));
  await put(maps, "mapRegions.jsonl", '{"_key":10000032,"nebulaID":11824}');
  await put(maps, "mapStars.jsonl", '{"_key":40169265,"typeID":45033}');
  await put(maps, "mapSolarSystems.jsonl", JSON.stringify({
    _key: solarSystemID, name: { en: "Dodixie" }, regionID: 10000032, starID: 40169265,
  }));

  assert.equal((await buildSystemScenes(maps))[solarSystemID].nebula, nebula);
  await withAssets({ root, clientRoot }, async url => {
    const response = await fetch(url("/client-assets/celestials/30002659.json"));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(Object.keys(data.items), ["40169266", "40169269"]);
    assert.equal(data.items[40169266].population, false);
    assert.equal(data.items[40169266].NormalHeight1, "/client-assets/texture/planet.dds");
    assert.equal(data.items[40169269].kind, "moon");
    const map = await fetch(url(data.items[40169266].NormalHeight1));
    assert.equal(map.status, 200);
    assert.equal(await map.text(), "DDS ");
  });
});

test("the installed build generates and caches the Drifter Collection explosion graph", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "evejs-client-drifter-explosion-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const clientRoot = path.join(temp, "install"), root = path.join(temp, "assets");
  const name = "drifterCollectionExplosion.json";
  const graph = { explosionBuild: 1, delayMs: 4200, durationMs: 38000, scale: 0.75 };
  await put(clientRoot, "tq/start.ini", "build=3698585\n");
  await put(root, `3396210/${name}`, '{"explosionBuild":1,"old":true}');
  await fs.mkdir(path.join(root, "3698585"), { recursive: true });
  let bakes = 0;
  await withAssets({
    root, clientRoot, fallbackBuild: "3396210",
    async extract(args) {
      assert.equal(args.at(-1), "--drifter-collection-explosion");
      bakes++;
      await put(root, `3698585/${name}`, JSON.stringify(graph));
    },
  }, async url => {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url(`/client-assets/${name}`));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), graph);
    }
    assert.equal(bakes, 1);
  });
});
