#!/usr/bin/env node
// Extract models and textures from YOUR installed EVE client for the three.js play page.
//
//   node tools/client-extract/extract.mjs [--client "<EVE folder>"] [--out <dir>] --hull <res path or stem> ...
//
// Nothing here ships client data: the script reads the client on this machine and writes to
// _local/client-assets/<build>/ (git-ignored). Output mirrors res: paths, lower case:
//   <hull>.glb          every LOD of the model, mirrored into glTF's right-handed space
//   <hull>_<x>.dds      the hull's textures, copied unchanged (block-compressed, uploaded as is)
//   <hull>.json         what was extracted from where: LODs, areas, textures, vertex components
// and manifest.json at the build root.

import fs from "node:fs";
import path from "node:path";
import { openResFiles, clientBuild, findClient } from "./lib/resfiles.mjs";
import { readGranny } from "./lib/granny.mjs";
import { meshArrays } from "./lib/mesh.mjs";
import { writeGlb } from "./lib/glb.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const REPO = path.resolve(HERE, "..", "..");

function parseArgs(argv) {
  const out = { hulls: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client") out.client = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--hull") out.hulls.push(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

// Texture suffixes of a ship hull's own texture set (beside its .gr2)
const TEXTURE_ROLES = { a: "albedo", ar: "albedoRoughness", d: "dirt", g: "glow", m: "materialMask", n: "normal", o: "occlusion", p3: "paintMask", pmdg: "paintMaskDirtGlow", r: "roughness" };

function hullPath(rf, spec) {
  if (spec.startsWith("res:/")) return spec.toLowerCase();
  const hits = rf.list("res:/dx9/model/", new RegExp(`/${spec.toLowerCase()}\\.gr2$`));
  if (hits.length !== 1) throw new Error(`--hull ${spec}: ${hits.length} matches (${hits.slice(0, 5).join(", ")})`);
  return hits[0].toLowerCase();
}

async function extractHull(rf, res, outRoot) {
  const g = await readGranny(rf.read(res), res);
  const lods = g.root.Meshes.map(meshArrays);
  const stem = res.slice(0, -".gr2".length);
  const base = path.join(outRoot, ...stem.slice("res:/".length).split("/"));
  fs.mkdirSync(path.dirname(base), { recursive: true });

  const textures = {};
  for (const [suffix, role] of Object.entries(TEXTURE_ROLES)) {
    for (const variant of ["", "_lowdetail", "_mediumdetail"]) {
      const tres = `${stem}_${suffix}${variant}.dds`;
      if (!rf.has(tres)) continue;
      fs.writeFileSync(`${base}_${suffix}${variant}.dds`, rf.read(tres));
      (textures[role] ??= {})[variant.slice(1) || "full"] = `${path.basename(stem)}_${suffix}${variant}.dds`;
    }
  }

  const name = path.basename(stem);
  fs.writeFileSync(`${base}.glb`, writeGlb({ name, lods, extras: { source: res, textures } }));
  const info = {
    source: res,
    lods: lods.map((m) => ({ name: m.name, vertices: m.vertexCount, triangles: m.indices.length / 3, maxScreenSize: m.extended?.maxScreenSize ?? null, areas: m.groups.map((x) => ({ name: m.materials[x.material] ?? null, triangles: x.count })), components: m.components })),
    textures,
    artTool: g.root.ArtToolInfo?.FromArtToolName ?? null,
    exportedFrom: g.root.FromFileName ?? null,
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(info, null, 2));
  return { res, glb: `${base}.glb`, lods: lods.length, textures: Object.keys(textures).length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let client = args.client ?? process.env.EVE_CLIENT_DIR;
  if (!client) {
    const found = findClient();
    if (found.length !== 1) throw new Error(found.length ? `several EVE installs found, pick one with --client: ${found.join(" | ")}` : "no EVE install found, give --client");
    client = found[0];
  }
  const build = clientBuild(client);
  const outRoot = path.resolve(args.out ?? path.join(REPO, "_local", "client-assets", build));
  const rf = openResFiles(client);
  console.log(`client ${client} (build ${build}) -> ${outRoot}`);
  if (!args.hulls.length) throw new Error("nothing to do: give --hull <stem or res path>");
  const done = [];
  for (const spec of args.hulls) {
    const res = hullPath(rf, spec);
    const r = await extractHull(rf, res, outRoot);
    console.log(`${res}: ${r.lods} LODs, ${r.textures} texture roles -> ${path.relative(outRoot, r.glb)}`);
    done.push(r.res);
  }
  const manifestFile = path.join(outRoot, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { build, client: path.basename(client), hulls: [] };
  manifest.hulls = [...new Set([...manifest.hulls, ...done])].sort();
  manifest.updated = new Date().toISOString();
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
