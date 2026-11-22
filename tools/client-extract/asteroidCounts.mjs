#!/usr/bin/env node
// The 3698585 client's asteroid counts per belt (eveuniverse/client/asteroids.py AsteroidCount: the FSD
// res:/staticdata/asteroidCountByTypeIDBeltID.static, beltID -> {typeID: count}), the original counts
// mining_util.get_depletion_status measures a belt's present asteroids against.
//
//   node tools/client-extract/asteroidCounts.mjs [--client "<EVE folder>"]
//
// Writes _local/client-assets/<build>/asteroidCounts/<floor(beltID / 10000)>.json (git-ignored), each
// {beltID: [typeID, count, typeID, count, ...]}, so the page fetches only the shard of the belt it arrives at.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openResFiles, clientBuild } from "./lib/resfiles.mjs";
import { readFsdStatic } from "./lib/fsdStatic.mjs";
import { resolveClient } from "./extract.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const given = argv.includes("--client") ? argv[argv.indexOf("--client") + 1] : undefined;
const client = resolveClient(given);
const build = clientBuild(client);
const rf = openResFiles(client);
const name = "res:/staticdata/asteroidCountByTypeIDBeltID.static";
const data = readFsdStatic(rf.read(name), name);
const entries = data instanceof Map ? [...data.entries()] : Object.entries(data);
const shards = new Map();
for (const [beltID, counts] of entries) {
  const pairs = counts instanceof Map ? [...counts.entries()] : Object.entries(counts);
  const shard = Math.floor(Number(beltID) / 10000);
  if (!shards.has(shard)) shards.set(shard, {});
  shards.get(shard)[beltID] = pairs.flatMap(([typeID, count]) => [Number(typeID), Number(count)]);
}
const out = path.join(REPO, "_local", "client-assets", build, "asteroidCounts");
fs.mkdirSync(out, { recursive: true });
for (const [shard, belts] of shards) fs.writeFileSync(path.join(out, `${shard}.json`), JSON.stringify(belts));
console.log(`${entries.length} belts in ${shards.size} shards -> ${out}`);
// The same for dungeons (AsteroidCount.get_asteroid_count_by_type_id_for_dungeon: the FSD
// res:/staticdata/asteroidCountByTypeIDRoomIDDungeonID.static, dungeonID -> {roomID: {typeID: count}}), what
// get_depletion_status_for_dungeon measures an ore site's present asteroids against: dungeons.json,
// {dungeonID: {roomID: [typeID, count, ...]}}.
const dname = "res:/staticdata/asteroidCountByTypeIDRoomIDDungeonID.static";
const ddata = readFsdStatic(rf.read(dname), dname);
const pairsOf = (m) => (m instanceof Map ? [...m.entries()] : Object.entries(m));
const dungeons = {};
for (const [dungeonID, rooms] of pairsOf(ddata)) {
  dungeons[dungeonID] = {};
  for (const [roomID, counts] of pairsOf(rooms)) dungeons[dungeonID][roomID] = pairsOf(counts).flatMap(([typeID, count]) => [Number(typeID), Number(count)]);
}
fs.writeFileSync(path.join(out, "dungeons.json"), JSON.stringify(dungeons));
console.log(`${Object.keys(dungeons).length} dungeons -> ${path.join(out, "dungeons.json")}`);
