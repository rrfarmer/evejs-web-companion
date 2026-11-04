"use strict";

// The web client (the EVE.js web companion) under test against this tree's server: its BFF in a
// container on the tree's port block, a real browser driven through Playwright, and planetary
// industry set up and aged so a feature that takes days of production can run in minutes.
// A tree links this folder in as tools/gridcheck/plugins/companion. Guide: docs/gridcheck.md.

module.exports = {
  name: "companion",
  apiVersion: 1,
  applies({ resolve }) {
    return resolve("services/planet/planetRuntimeStore")
      ? true
      : { ok: false, reason: "this tree has no planetary industry (no server/src/services/planet/planetRuntimeStore.js)" };
  },
  server(ctx) {
    return require("./server").createCompanionServer(ctx);
  },
  get tool() {
    return require("./tool");
  },
};
