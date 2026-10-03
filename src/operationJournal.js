"use strict";

const fs = require("node:fs");
const path = require("node:path");

// WC-owned, credential-free evidence. Persistence failure is a refusal to send.
// Unlike best-effort roster persistence, callers must not swallow write errors.
function createOperationJournal({ filePath = null } = {}) {
  let records = {};
  if (filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed?.version !== 1 || !parsed.records || typeof parsed.records !== "object" || Array.isArray(parsed.records))
        throw new Error("Invalid operation journal; recovery evidence must be preserved.");
      if (Object.entries(parsed.records).some(([key, row]) => !key || key === "__proto__" || !row ||
          typeof row !== "object" || Array.isArray(row) || Object.hasOwn(row, "key")))
        throw new Error("Invalid journal record; recovery evidence must be preserved.");
      records = parsed.records;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const clone = value => JSON.parse(JSON.stringify(value));
  function put(key, value) {
    if (typeof key !== "string" || !key || key === "__proto__") throw new Error("Invalid journal identity");
    const next = { ...records, [key]: clone(value) };
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.${process.pid}.tmp`;
      const fd = fs.openSync(temp, "w");
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, records: next })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, filePath);
    }
    records = next;
    return clone(value);
  }
  return { get: key => Object.hasOwn(records, key) ? clone(records[key]) : null,
    list: () => Object.entries(records).map(([key, value]) => ({ key, ...clone(value) })), put };
}

module.exports = { createOperationJournal };
