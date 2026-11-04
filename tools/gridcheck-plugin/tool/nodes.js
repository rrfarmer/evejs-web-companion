"use strict";

// How a step or a command names something on the page. browserHost.js turns it into a locator.

const NODE_KEYS = Object.freeze(["role", "name", "text", "label", "placeholder", "css", "exact", "index", "within"]);
const FINDERS = Object.freeze(["role", "text", "label", "placeholder", "css"]);

// The problems with a node, as text; none means it is good.
function nodeProblems(node) {
  if (typeof node === "string") return node ? [] : ["a node's text, or an object naming it"];
  if (node === null || typeof node !== "object" || Array.isArray(node)) return ["a node's text, or { role, name, text, label, placeholder, css, exact, index, within }"];
  const problems = [];
  for (const key of Object.keys(node)) {
    if (!NODE_KEYS.includes(key)) problems.push(`${key}: unknown key; a node takes ${NODE_KEYS.join(", ")}`);
  }
  if (!FINDERS.some((key) => node[key] !== undefined)) problems.push(`a node needs one of ${FINDERS.join(", ")}`);
  if (node.name !== undefined && node.role === undefined) problems.push("name goes with role; on its own use text");
  if (node.index !== undefined && !(Number.isInteger(node.index) && node.index >= 0)) problems.push("index: which of several matches, from 0");
  if (node.within !== undefined) problems.push(...nodeProblems(node.within).map((problem) => `within: ${problem}`));
  return problems;
}

// The node a command's flags name, or null.
function nodeFromFlags(flags) {
  const node = {};
  for (const key of ["role", "name", "text", "label", "placeholder", "css"]) {
    if (flags[key] !== undefined) node[key] = String(flags[key]);
  }
  if (!FINDERS.some((key) => node[key] !== undefined)) return null;
  if (flags.exact) node.exact = true;
  if (flags.index !== undefined) node.index = Number(flags.index);
  return node;
}

module.exports = { NODE_KEYS, nodeFromFlags, nodeProblems };
