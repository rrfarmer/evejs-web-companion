"use strict";

// The image must carry everything the server loads.
//
// The Dockerfile's last stage copies a few trees and nothing else, and
// .dockerignore keeps everything but a few trees out of the build context. A
// module under src/ that requires a file outside those trees works on the host
// and stops the container at start-up with "Cannot find module". That happened:
// the game port's transport loads contracts/evejs-web-bridge-contract.json, the
// server loads the transport as it starts, and the image had no contracts/.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const slashed = (file) => path.relative(ROOT, file).split(path.sep).join("/");

/** The paths the image's last stage copies out of the build context: "src", "scripts", ... */
function copiedIntoTheImage(dockerfile) {
  const stages = dockerfile.split(/^FROM /m);
  const last = stages[stages.length - 1];
  const copied = [];
  for (const line of last.split(/\r?\n/)) {
    const match = /^COPY\s+(?!--from)(?:--\S+\s+)*(.+)$/.exec(line.trim());
    if (!match) continue;
    const parts = match[1].trim().split(/\s+/);
    for (const source of parts.slice(0, -1)) copied.push(source.replace(/^\.\//, "").replace(/\/$/, ""));
  }
  return copied;
}

/** The trees .dockerignore lets into the build context ("!src/"), and the patterns it takes out again. */
function buildContext(dockerignore) {
  const lines = dockerignore.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  return {
    allowed: lines.filter((line) => line.startsWith("!")).map((line) => line.slice(1).replace(/\/\*\*$/, "").replace(/\/$/, "")),
    testsKeptOut: lines.includes("src/**/*.test.js"),
  };
}

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(at, out);
    else if (/\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(at);
  }
  return out;
}

/** Every file a module under src/ requires by a relative path, as [required, by]. */
function relativeRequires() {
  const found = [];
  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      found.push([slashed(path.resolve(path.dirname(file), match[1])), slashed(file)]);
    }
  }
  return found;
}

const under = (file, trees) => trees.some((tree) => file === tree || file.startsWith(`${tree}/`));

test("the Dockerfile and .dockerignore are read as written: the trees the image is given", () => {
  const copied = copiedIntoTheImage(fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8"));
  const context = buildContext(fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8"));
  assert.deepEqual(copied, ["package.json", "package-lock.json", "src", "contracts", "scripts", "web/src", "plugins"]);
  for (const tree of copied) assert.ok(under(tree, context.allowed), `${tree} is copied into the image but kept out of the build context`);
  assert.equal(context.testsKeptOut, true);
  // The reading itself, on a small file: a copy from another stage is not a copy out of the context.
  assert.deepEqual(copiedIntoTheImage("FROM a AS build\nCOPY web ./web\nFROM b\nCOPY --chown=node:node one two ./\nCOPY --from=build /app/x ./x\nCOPY three ./three\n"), ["one", "two", "three"]);
  assert.deepEqual(buildContext("# all\n**\n!src/\n!src/**\n!package.json\nsrc/**/*.test.js\n"), { allowed: ["src", "src", "package.json"], testsKeptOut: true });
});

test("everything a module under src/ requires is in the image", () => {
  const copied = copiedIntoTheImage(fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8"));
  const context = buildContext(fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8"));
  const requires = relativeRequires();
  assert.ok(requires.length > 150, `${requires.length} relative requires found under src/`);
  const missing = requires.filter(([required]) => !under(required, copied) || !under(required, context.allowed) || /\.test(\.js)?$/.test(required));
  assert.deepEqual(missing, []);
  // The one that was missing is among those looked at.
  assert.ok(requires.some(([required, by]) => required === "contracts/evejs-web-bridge-contract.json" && by === "src/gamePort/pilots.js"));
});
