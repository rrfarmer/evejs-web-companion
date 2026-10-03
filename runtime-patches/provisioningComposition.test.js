"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { plans } = require("../scripts/provisioning-runtime-patch");

test("portable clean reference composes Upwell, Factory and observation without selecting or starting runtime", () => {
  const reference = process.env.EVEJS_CLEAN_REFERENCE || require("../scripts/prepare-runtime-test-reference").prepareRuntimeTestReference().reference;
  const steps = [
    ["dockable-structure-search.patch", []],
    ["accessible-structure-services.patch", []],
    ["live-factory-gateway.patch", ["--unidiff-zero"]],
    ["pilot-training-generic.patch", ["--include=server/src/_secondary/express/evejsWebGatewayRuntime.js"]],
    ["factory-gateway-placement.patch", []],
  ];
  const files = new Set(require("./provisioning-observation-provenance.json").files.filter(f => f.cleanBaselineSHA256).map(f => f.file));
  for (const [file] of steps) for (const match of fs.readFileSync(path.join(__dirname, file), "utf8").matchAll(/^--- a\/(.+)\r?$/gm)) {
    if (!match[1].endsWith("/factorySkillAcquisition.js")) files.add(match[1]);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provisioning-composition-"));
  try {
    for (const file of files) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Patch fixtures use normalized text; the deployed semantic patch also
      // separately verifies preservation of existing CRLF seams.
      fs.writeFileSync(target, fs.readFileSync(path.join(reference, file), "utf8").replace(/\r\n/g, "\n"));
    }
    for (const [file, options] of steps) {
      const args = ["apply", "--ignore-whitespace", ...options, path.join(__dirname, file)];
      execFileSync("git", ["apply", "--check", "--ignore-whitespace", ...options, path.join(__dirname, file)], { cwd: root });
      execFileSync("git", args, { cwd: root });
    }
    const helper = "server/src/_secondary/express/factorySkillAcquisition.js";
    fs.copyFileSync(path.join(__dirname, "factorySkillAcquisition.js"), path.join(root, helper));
    files.add(helper);
    const changes = plans(root);
    for (const c of changes) { fs.writeFileSync(path.join(root, c.file), c.after); files.add(c.file); }
    assert.deepEqual(plans(root).map(c => c.after), changes.map(c => c.after));
    const runtime = fs.readFileSync(path.join(root, "server/src/_secondary/express/evejsWebGatewayRuntime.js"), "utf8");
    assert.match(runtime, /buildProvisioningObservation/);
    assert.match(runtime, /selectFactoryCharacter/);
    assert.match(runtime, /peekCharacterControlSnapshot/);
    for (const file of files) if (file.endsWith(".js")) execFileSync(process.execPath, ["--check", path.join(root, file)]);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
