"use strict";

const { deflateSync } = require("node:zlib");

// A synthetic instance of the documented login carrier, with no private mod assets.
function marshal(source) {
  const body = Buffer.from(source);
  const header = Buffer.alloc(5);
  header[0] = 0x74;
  header.writeUInt32LE(body.length, 1);
  return Buffer.concat([header, body]);
}
function loginProgram(catalog, inner = "fixture_native()") {
  const bundle = deflateSync(Buffer.from(JSON.stringify({ catalog, visuals: {} }))).toString("base64");
  const program = Buffer.from(`_family_bundle = "${bundle}"\nraise Exception("never execute server code")`).toString("base64");
  return marshal(`(lambda _result: (eval(compile(__import__('base64').b64decode('${program}'), '<empire-hauler-login>', 'exec'), {'__builtins__': __builtins__, '_family_context': globals()}), _result)[1])(${inner})`);
}

module.exports = { loginProgram, marshal };
