"use strict";

const { prepareHullColors } = require("./lib/hullColorCompression.cjs");

const [root, ...files] = process.argv.slice(2);
prepareHullColors(files, root, (file, error) => console.warn(`${file}: ${error.message}`))
  .then(totals => { if (totals.failed) process.exitCode = 1; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
