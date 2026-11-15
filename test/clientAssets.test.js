"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createClientAssets } = require("../src/clientData/clientAssets");
const { createApp } = require("../src/server");
const { extractOverviewPresets } = require("../tools/client-extract/extract.mjs");
const { SOF_BUILD } = require("../tools/client-extract/lib/sof.mjs");
const { indexedHullGeometry } = require("../tools/client-extract/lib/typeGraphics.mjs");

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
  await withAssets({ root, clientRoot, fallbackBuild: "3396210" }, async url => {
    const index = await fetch(url("/client-assets/typeNames.json?v=1"));
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /^application\/json\b/);
    assert.deepEqual(await index.json(), { build: 3698585 });
    const media = await fetch(url("/client-assets/audio/sample.ogg"), { headers: { Range: "bytes=0-3" } });
    assert.equal(media.status, 206);
    assert.match(media.headers.get("content-type"), /^audio\/ogg\b/);
    assert.equal(await media.text(), "OggS");
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
