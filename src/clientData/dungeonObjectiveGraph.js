"use strict";

// These client graphs delegate arrival to 669 and listen for start_objectives.
const DUNGEON_OBJECTIVE_GRAPHS = new Set([882, 952, 1065]);

function dungeonObjectiveEntryRules(graph) {
  if (!graph || !graph.tags?.includes("client")) return null;
  const nodes = graph.nodes ?? {};
  const parameter = (node, key) => node?.nodeParameters?.[key]?.value;
  const listener = Object.values(nodes).find((node) =>
    node.nodeType === 31 && parameter(node, "message_key") === "start_objectives");
  if (listener?.connections?.output?.length !== 1) return null;
  // Observatory Infiltration starts its vault objective after the lockdown group,
  // and its lobby objective after starting the lobby's lockdown banner.
  const after = (node) => node?.connections?.output?.length === 1 ? nodes[node.connections.output[0]] : null;
  const send = (node, key) => node?.nodeType === 42 && parameter(node, "message_key") === key ? parameter(node, "message_value") : null;
  const first = after(listener);
  if (send(first, "start_group") === "lockdown") {
    const lobbyListener = Object.values(nodes).find((node) =>
      node.nodeType === 31 && parameter(node, "message_key") === "start_lobby_objectives");
    const banner = (lobbyListener?.connections?.output ?? []).map((id) => nodes[id]).find((node) =>
      send(node, "start_objective") === "lockdown_lobby");
    const lobbyStart = after(banner);
    const vaultStart = after(first);
    const lobby = send(lobbyStart, "start_objective");
    const vault = send(vaultStart, "start_objective");
    if (typeof lobby !== "string" || typeof vault !== "string") return null;
    const rules = [{ listKey: null, objectiveKey: lobby, lobby: true }, { listKey: null, objectiveKey: vault }];
    const conditional = (check, inLobby) => {
      const key = parameter(check, "blackboard_key");
      const value = parameter(check, "blackboard_value");
      const operator = parameter(check, "operator");
      const match = check?.connections?.on_success;
      const shown = match?.length === 1 ? send(nodes[match[0]], "show_objective") : null;
      if (check?.nodeType === 22 && (!operator || operator === "equalTo") &&
          typeof key === "string" && typeof value === "string" && typeof shown === "string") {
        rules.push({ listKey: null, objectiveKey: shown, ...(inLobby ? { lobby: true } : {}), when: { key, value } });
      }
    };
    const vaultCheck = after(after(vaultStart));
    conditional(after(after(lobbyStart)), true);
    conditional(vaultCheck, false);
    if (vaultCheck?.connections?.on_failure?.length === 1) {
      conditional(nodes[vaultCheck.connections.on_failure[0]], false);
    }
    return rules;
  }
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

// Graph 882 sets the enter and event maps along the four empire-faction branches.
function observatoryConversationIDs(graph) {
  const nodes = graph?.nodes ?? {};
  const next = (node, pin) => node?.connections?.[pin]?.length === 1 ? nodes[node.connections[pin][0]] : null;
  const value = (node, key) => node?.nodeParameters?.[key]?.value;
  const read = (node, key) => {
    if (node?.nodeType !== 19 || value(node, "blackboard_key") !== key) return null;
    try { return JSON.parse(value(node, "blackboard_value")); }
    catch { return null; }
  };
  const result = {};
  for (const node of Object.values(nodes)) {
    if (node.nodeType !== 22 || value(node, "blackboard_key") !== "system_faction_id") continue;
    const faction = Number(value(node, "blackboard_value"));
    const preload = next(node, "on_success");
    if (preload?.nodeType !== 4 || value(preload, "atom_id") !== 588) continue;
    const entry = next(preload, "output");
    const enter = read(entry, "enter_conversations");
    const event = read(next(entry, "output"), "event_conversations");
    const branch = { lobby: enter?.Lobby, complete: enter?.Complete, failure: event?.Failure };
    if (Number.isSafeInteger(faction) && faction > 0 &&
        Object.values(branch).every(id => Number.isSafeInteger(id) && id > 0)) result[faction] = branch;
  }
  return result;
}

module.exports = { DUNGEON_OBJECTIVE_GRAPHS, dungeonObjectiveEntryRules, observatoryConversationIDs };
