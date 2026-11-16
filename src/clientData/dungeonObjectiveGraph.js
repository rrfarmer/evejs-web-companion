"use strict";

// Both client graphs delegate arrival to 669 and listen for start_objectives.
const DUNGEON_OBJECTIVE_GRAPHS = new Set([952, 1065]);

function dungeonObjectiveEntryRules(graph) {
  if (!graph || !graph.tags?.includes("client")) return null;
  const nodes = graph.nodes ?? {};
  const parameter = (node, key) => node?.nodeParameters?.[key]?.value;
  const listener = Object.values(nodes).find((node) =>
    node.nodeType === 31 && parameter(node, "message_key") === "start_objectives");
  if (listener?.connections?.output?.length !== 1) return null;
  const objectiveKeyOf = (node) => {
    const key = parameter(node, "message_value");
    return node?.nodeType === 42 && parameter(node, "message_key") === "start_objective" &&
      !node.connections?.output?.length && typeof key === "string" ? key : null;
  };
  const direct = objectiveKeyOf(nodes[listener.connections.output[0]]);
  if (direct !== null) return [{ listKey: null, objectiveKey: direct }];

  const rules = [];
  const seen = new Set();
  let id = listener.connections.output[0];
  while (id !== undefined) {
    if (seen.has(id)) return null;
    seen.add(id);
    const node = nodes[id];
    if (node?.nodeType !== 22 || parameter(node, "operator") !== "in" ||
        parameter(node, "blackboard_key") !== "dungeon_id" || parameter(node, "flipped") ||
        parameter(node, "object_path")) return null;
    const operand = node.nodeParameters.blackboard_value?.connection;
    const read = nodes[operand?.node];
    const listKey = parameter(read, "blackboard_key");
    if (operand?.parameter !== "blackboard_value" || read?.nodeType !== 18 ||
        typeof listKey !== "string" || parameter(read, "object_path")) return null;

    const yes = node.connections?.on_success ?? [];
    const no = node.connections?.on_failure ?? [];
    if (no.length > 1 || no.some((next) => !yes.includes(next))) return null;
    const messages = yes.filter((next) => !no.includes(next)).map((next) => nodes[next]);
    if (!messages.length) return null;
    for (const message of messages) {
      const objectiveKey = objectiveKeyOf(message);
      if (objectiveKey === null) return null;
      rules.push({ listKey, objectiveKey });
    }
    id = no[0];
  }
  return rules;
}

module.exports = { DUNGEON_OBJECTIVE_GRAPHS, dungeonObjectiveEntryRules };
