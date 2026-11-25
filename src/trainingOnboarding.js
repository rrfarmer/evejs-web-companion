"use strict";
const { trainingError } = require("./pilotTrainingRead");

function scalar(value) { return value && typeof value === "object" && "value" in value ? value.value : value; }
function row(value) {
  if (value?.type === "packedrow" && value.fields) return Object.fromEntries(Object.entries(value.fields).map(([k, v]) => [k, scalar(v)]));
  const entries = value?.args?.entries;
  if (!Array.isArray(entries)) throw trainingError("CORPORATION_STATE_UNKNOWN");
  const fields = Object.fromEntries(entries);
  if (fields.header?.items && fields.line?.items && fields.header.items.length === fields.line.items.length)
    return Object.fromEntries(fields.header.items.map((key, i) => [key, scalar(fields.line.items[i])]));
  return Object.fromEntries(entries.map(([key, v]) => [key, scalar(v)]));
}
module.exports = { row };
