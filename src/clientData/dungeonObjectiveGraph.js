"use strict";

// These client graphs delegate arrival to 669 and listen for start_objectives.
const DUNGEON_OBJECTIVE_GRAPHS = new Set([882, 952, 1065, 1078]);
const WINTER_NEXUS_OBJECTIVE_GRAPH = 784;
const POCHVEN_WORMHOLE_OBJECTIVE_GRAPH = 963;
const DUNGEON_ARRIVAL_OBJECTIVE_GRAPH = 669;
const ELECTION_TRADER_OBJECTIVE_GRAPH = 1013;

function electionTraderObjectiveRules(graph, dungeonID) {
  if (!graph?.tags?.includes("client")) return null;
  const nodes = graph.nodes ?? {};
  const value = (node, key) => node?.nodeParameters?.[key]?.value;
  const next = (node, pin) => node?.connections?.[pin]?.length === 1 ? nodes[node.connections[pin][0]] : null;
  const warpFinished = Object.values(nodes).find((node) => node.nodeType === 5 && value(node, "atom_id") === 90);
  const warping = next(warpFinished, "output");
  if (warping?.nodeType !== 9 || value(warping, "atom_id") !== 116 || value(warping, "is_not")) return null;
  const seen = new Set();
  let check = next(warping, "on_failure");
  while (check && !seen.has(check)) {
    if (check.nodeType !== 22 || value(check, "blackboard_key") !== "dungeon_id" || value(check, "flipped") ||
        value(check, "object_path") || (value(check, "operator") && value(check, "operator") !== "equalTo")) return null;
    seen.add(check);
    if (Number(value(check, "blackboard_value")) === dungeonID) {
      const start = next(check, "on_success");
      const objectiveKey = value(start, "message_value");
      return start?.nodeType === 42 && value(start, "message_key") === "start_objective" && typeof objectiveKey === "string"
        ? [{ listKey: null, objectiveKey }] : null;
    }
    check = next(check, "on_failure");
  }
  return null;
}

function pochvenWormholeObjectiveRules(graph, arrivalGraph) {
  if (!graph?.tags?.includes("client") || !arrivalGraph?.tags?.includes("client")) return null;
  const nodes = graph.nodes ?? {};
  const value = (node, key) => node?.nodeParameters?.[key]?.value;
  const next = (node, pin) => node?.connections?.[pin]?.length === 1 ? nodes[node.connections[pin][0]] : null;
  const matches = (node, key) => node?.nodeType === 22 && value(node, "blackboard_key") === key &&
    (!value(node, "operator") || value(node, "operator") === "equalTo") && !value(node, "flipped") && !value(node, "object_path");
  const isStart = (node) => node?.nodeType === 42 && value(node, "message_key") === "start_objective";
  const startKey = (node) => isStart(node) ? value(node, "message_value") : null;
  const listener = Object.values(nodes).find((node) => node.nodeType === 31 && value(node, "message_key") === "start_objectives");
  const collapse = next(listener, "output");
  const stateKey = "dungeon_state";
  if (!matches(collapse, stateKey) || value(collapse, "blackboard_value") !== "WormholeCollapsed") return null;

  const otherBranches = (collapse.connections?.on_failure ?? []).map((id) => nodes[id]);
  const cooldown = otherBranches.find((node) => matches(node, stateKey) && value(node, "blackboard_value") === "Cooldown");
  const collapsedKey = startKey(next(collapse, "on_success"));
  const timerKey = startKey(next(cooldown, "on_success"));
  const destroyKey = startKey(next(cooldown, "on_failure"));
  const warping = Object.values(arrivalGraph.nodes ?? {}).find((node) => startKey(node) === "warping");
  if (!warping || typeof collapsedKey !== "string" || typeof timerKey !== "string" || typeof destroyKey !== "string") return null;

  const except = { key: stateKey, values: ["WormholeCollapsed"] };
  const rules = [
    { listKey: null, objectiveKey: startKey(warping), duringWarp: true },
    { listKey: null, objectiveKey: collapsedKey, when: { key: stateKey, value: "WormholeCollapsed" } },
    { listKey: null, objectiveKey: timerKey, when: { key: stateKey, value: "Cooldown" } },
    { listKey: null, objectiveKey: destroyKey, unless: { key: stateKey, values: ["WormholeCollapsed", "Cooldown"] } },
  ];
  let difficulty = otherBranches.find((node) => matches(node, "current_difficulty"));
  const visited = new Set();
  while (difficulty) {
    if (visited.has(difficulty) || !matches(difficulty, "current_difficulty")) return null;
    visited.add(difficulty);
    const rank = value(difficulty, "blackboard_value");
    const objectiveKey = startKey(next(difficulty, "on_success"));
    if (typeof rank !== "string" || typeof objectiveKey !== "string") return null;
    rules.push({ listKey: null, objectiveKey, when: { key: "current_difficulty", value: rank }, unless: except });
    difficulty = next(difficulty, "on_failure");
  }
  // Graph 963 stops the in-dungeon group before reapplying a changed state or difficulty.
  const restartOn = [stateKey, "current_difficulty"];
  return visited.size ? rules.map((rule) => rule.duringWarp ? rule : { ...rule, restartOn }) : null;
}

function winterNexusObjectiveRules(graph, dungeonID) {
  if (!graph?.tags?.includes("client")) return null;
  const nodes = graph.nodes ?? {};
  const value = (node, key) => node?.nodeParameters?.[key]?.value;
  const next = (node, pin) => node?.connections?.[pin]?.length === 1 ? nodes[node.connections[pin][0]] : null;
  const check = (node, key) => node?.nodeType === 22 && value(node, "blackboard_key") === key &&
    (!value(node, "operator") || value(node, "operator") === "equalTo") && !value(node, "flipped") && !value(node, "object_path");
  const write = (node, key) => node?.nodeType === 19 && value(node, "blackboard_key") === key ? value(node, "blackboard_value") : null;
  const command = (node, key) => node?.nodeType === 42 && value(node, "message_key") === key ? value(node, "message_value") : null;
  const branch = Object.values(nodes).find((node) => check(node, "dungeon_id") && Number(value(node, "blackboard_value")) === dungeonID);
  const device = next(branch, "on_success");
  const cargoTypeID = Number(write(device, "cryostorm_device_id"));
  const zone = write(next(next(device, "output"), "output"), "dungeon_type");
  if (!Number.isSafeInteger(cargoTypeID) || cargoTypeID <= 0 || typeof zone !== "string") return null;

  const cargo = Object.values(nodes).find((node) => {
    const operand = node.atomParameters?.type_id?.connection;
    const read = nodes[operand?.node];
    return node.nodeType === 9 && value(node, "atom_id") === 23 && operand?.parameter === "blackboard_value" &&
      read?.nodeType === 18 && value(read, "blackboard_key") === "cryostorm_device_id";
  });
  let choice = next(cargo, "on_success");
  const visited = new Set();
  while (check(choice, "dungeon_type") && value(choice, "blackboard_value") !== zone && !visited.has(choice)) {
    visited.add(choice);
    choice = next(choice, "on_failure");
  }
  const depositObjectiveKey = check(choice, "dungeon_type") && value(choice, "blackboard_value") === zone
    ? command(next(choice, "on_success"), "start_objective") : null;

  const deposited = Object.values(nodes).find((node) => check(node, "mutator_deposited") &&
    Number(value(node, "blackboard_value")) === 1 && command(next(node, "on_failure"), "start_objective"));
  const hackObjectiveKey = command(next(deposited, "on_failure"), "start_objective");
  const stop = next(deposited, "on_success");
  const delay = next(stop, "output");
  const restartHackMs = Number(value(delay, "delay")) * 1000;
  if (typeof depositObjectiveKey !== "string" || typeof hackObjectiveKey !== "string" ||
      command(stop, "stop_objective") !== hackObjectiveKey || delay?.nodeType !== 17 ||
      command(next(delay, "output"), "start_objective") !== hackObjectiveKey ||
      !Number.isFinite(restartHackMs) || restartHackMs <= 0) return null;
  return { hackObjectiveKey, depositObjectiveKey, cargoTypeID, restartHackMs };
}

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

module.exports = {
  DUNGEON_OBJECTIVE_GRAPHS, DUNGEON_ARRIVAL_OBJECTIVE_GRAPH, POCHVEN_WORMHOLE_OBJECTIVE_GRAPH, WINTER_NEXUS_OBJECTIVE_GRAPH,
  ELECTION_TRADER_OBJECTIVE_GRAPH, dungeonObjectiveEntryRules, electionTraderObjectiveRules, observatoryConversationIDs,
  pochvenWormholeObjectiveRules, winterNexusObjectiveRules,
};
