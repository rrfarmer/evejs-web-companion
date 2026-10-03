"use strict";

// Recover the patch tests' exact source fixtures from the existing EveJS Git
// history. No checkout, worktree, gameStore import, or live runtime mutation.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const manifest = require("../runtime-patches/mining-support-0.12.9-manifest.json");
const provisioning = require("../runtime-patches/provisioning-observation-provenance.json");
const cleanReferenceFiles = { ...manifest.cleanReferenceFiles,
  ...require("../runtime-patches/upwell-0.12.9-manifest.json").cleanReferenceFiles,
  ...require("../runtime-patches/pilot-training-0.12.9-manifest.json").cleanReferenceFiles };
for (const { file, cleanBaselineSHA256 } of provisioning.files) {
  if (!cleanBaselineSHA256) continue;
  const expected = cleanBaselineSHA256.toUpperCase();
  if (cleanReferenceFiles[file] && cleanReferenceFiles[file] !== expected)
    throw new Error(`Runtime fixture baselines disagree for ${file}`);
  cleanReferenceFiles[file] = expected;
}
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
const supplementalFiles = [
  "server/src/common/numbers.js",
  "server/src/services/fitting/liveFittingState.js",
  "server/src/services/_shared/floatPrecision.js",
  "server/src/space/modules/genericModuleFuelRuntime.js",
  "server/src/space/modules/liveModuleAttributes.js",
  "server/src/space/modules/moduleAttributeDiff.js",
];

function prepareRuntimeTestReference(repo = process.env.EVEJS_REPO || path.resolve(__dirname, "../../eve.js")) {
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 8_000_000 });
  const pinned = new Map();
  const revisions = {};
  for (const [file, expected] of Object.entries(cleanReferenceFiles)) {
    const history = git("log", "--format=%H", "--", file).toString().trim().split(/\s+/).filter(Boolean);
    for (const revision of history) {
      const bytes = git("show", `${revision}:${file}`);
      const windowsBytes = Buffer.from(bytes.toString("utf8").replace(/\r?\n/g, "\r\n"));
      const matched = digest(bytes) === expected ? bytes : digest(windowsBytes) === expected ? windowsBytes : null;
      if (matched !== null) {
        pinned.set(file, matched);
        revisions[file] = revision;
        break;
      }
    }
    if (!pinned.has(file)) throw new Error(`Cannot recover pinned runtime fixture ${file}. Supply EVEJS_CLEAN_REFERENCE or a complete EveJS history through EVEJS_REPO.`);
  }
  // Supplemental dependencies are evaluated in fixture VMs, with their game
  // authorities injected. Take them from the pinned gateway revision.
  const base = revisions["server/src/_secondary/express/evejsWebGatewayRuntime.js"];
  for (const file of supplementalFiles) pinned.set(file, git("show", `${base}:${file}`));
  const reference = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-runtime-test-reference-"));
  for (const [file, bytes] of pinned) {
    const target = path.join(reference, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  fs.writeFileSync(path.join(reference, "source-revisions.json"), `${JSON.stringify(revisions, null, 2)}\n`);
  return { reference, revisions };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(prepareRuntimeTestReference())}\n`);
module.exports = { prepareRuntimeTestReference };
