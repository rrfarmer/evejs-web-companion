// Vite build for the TS web stack (goal R1b). The TS app lives in web/ and
// builds into public/dist/, which src/server.js serves at the ROOT — this is
// the only app now. No dev server is required to ship: `npm run build:web`
// then `npm start` is the production arrangement.
//
// R45: the vanilla app that used to own "/" (public/index.html, app.js,
// styles.css, commandClient.js, eventClient.js, mutationScope.js) is deleted.
// It had been dead since R9b — all six of its tabs fetched a retired route
// family and got index.html back with a 200, so nothing ever surfaced the
// breakage. The SPA became a strict superset at R41 and now serves "/".
//
// Dev arrangement (optional): `npm run dev:web` runs the Vite dev server on
// its default port (5173) and proxies /api and /icon-cache to the running BFF
// (default http://127.0.0.1:26500), so the TS app can iterate with hot reload
// while the BFF keeps owning auth, the bridge proxy, and static vanilla pages.
// Override the proxy target with EVEJS_WEB_BFF_URL if the BFF runs elsewhere.
import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
// View library (locked by the R2 spike): Svelte 5. Components stay thin pure
// readers of the framework-agnostic signal store (web/src/store), which
// implements the Svelte store contract so `$slice` auto-subscription works.
import { svelte } from "@sveltejs/vite-plugin-svelte";
// Styling (goal R8): Tailwind CSS v4 via its first-party Vite plugin. The
// CSS-first entry (web/src/styles.css: `@import "tailwindcss"`) is imported
// from main.ts, so Vite emits the compiled Tailwind bundle into public/dist/
// alongside the app and the built index.html links it. Presentation only —
// no change to the store, flow, or bridge.
import tailwindcss from "@tailwindcss/vite";

const bffTarget = process.env.EVEJS_WEB_BFF_URL || "http://127.0.0.1:26500";

// Client assets for the three.js play page (FarmerThreeJSFun). tools/client-extract writes them to
// _local/client-assets/<build>/ from the local EVE install; they are never committed. Served at
// /client-assets from the build named by EVE_CLIENT_BUILD, else the newest build folder there.
function clientAssets(): Plugin {
  const root = path.resolve(__dirname, "_local", "client-assets");
  const types: Record<string, string> = { ".glb": "model/gltf-binary", ".json": "application/json", ".dds": "application/octet-stream" };
  return {
    name: "client-assets",
    configureServer(server) {
      // The extractor runs as its own process (always the code on disk), one run per thing at a time, shared by
      // every request that wants it.
      const extracting = new Map<string, Promise<void>>();
      const extractOnce = (key: string, buildDir: string, args: string[]): Promise<void> => {
        if (!extracting.has(key)) {
          const config = JSON.parse(fs.readFileSync(path.join(buildDir, "config.json"), "utf8")) as { client: string };
          const run = new Promise<void>((resolve, reject) => {
            execFile(process.execPath, [path.resolve(__dirname, "tools", "client-extract", "extract.mjs"), "--client", config.client, "--out", buildDir, ...args],
              { maxBuffer: 1 << 24 }, (error, _out, err) => (error ? reject(new Error(String(err || error.message).trim())) : resolve()));
          }).finally(() => extracting.delete(key));
          extracting.set(key, run);
        }
        return extracting.get(key)!;
      };
      server.middlewares.use("/client-assets", async (req, res, next) => {
        let builds: string[] = [];
        try { builds = fs.readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a)); } catch { /* none yet */ }
        const build = process.env.EVE_CLIENT_BUILD || builds[0];
        if (!build) { res.statusCode = 404; return res.end("no client assets: run tools/client-extract/extract.mjs"); }
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
        // /client-assets/type/<typeID>: how a type is drawn, its model extracted from the client on first ask
        // (tools/client-extract; needs typeGraphics.json and config.json from `extract.mjs --type-graphics --sde`).
        // /client-assets/scene/<solarSystemID>: the system's space scene (its region's nebula cube maps), copied on first ask.
        const sceneAsk = /^\/scene\/(\d+)$/.exec(rel);
        if (sceneAsk) {
          try {
            const buildDir = path.join(root, build);
            const sys = JSON.parse(fs.readFileSync(path.join(buildDir, "systemScenes.json"), "utf8"))[sceneAsk[1]!] ?? null;
            res.setHeader("content-type", "application/json");
            if (!sys?.nebula) return res.end(JSON.stringify({ solarSystemID: Number(sceneAsk[1]), ...(sys ?? {}), maps: null }));
            const stem = String(sys.nebula).toLowerCase().replace(/.(red|black)$/, "").slice("res:/".length);
            const have = () => fs.existsSync(path.join(buildDir, stem + ".dds"));
            if (!have()) await extractOnce(`scene:${stem}`, buildDir, ["--scene", sys.nebula]);
            const maps: Record<string, string> = {};
            for (const [role, suffix] of [["nebula", ""], ["reflection", "_refl"], ["blur", "_blur"]] as const) {
              if (fs.existsSync(path.join(buildDir, stem + suffix + ".dds"))) maps[role] = `/client-assets/${stem}${suffix}.dds`;
            }
            return res.end(JSON.stringify({ solarSystemID: Number(sceneAsk[1]), ...sys, maps }));
          } catch (e) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: (e as Error).message }));
          }
        }
        // /client-assets/celestial/<typeID>: a planet, moon or sun type's object file read for its textures and shader
        // parameters (tools/client-extract lib/celestial.mjs), on first ask.
        // /client-assets/celestials/<solarSystemID>.json: the system's planets and moons, each with its own shader preset
        // and height maps (extract.mjs --system-celestials, from the SDE), made on first ask.
        // /client-assets/overviewPresets.json: the overview's default presets and tabs (extract.mjs --overview), made on
        // first ask.
        if (rel === "/overviewPresets.json") {
          try {
            const buildDir = path.join(root, build);
            const file = path.join(buildDir, "overviewPresets.json");
            if (!fs.existsSync(file)) await extractOnce("overview", buildDir, ["--overview"]);
            res.setHeader("content-type", "application/json");
            return res.end(fs.readFileSync(file));
          } catch (e) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: (e as Error).message }));
          }
        }
        const systemCelestialsAsk = /^\/celestials\/(\d+)\.json$/.exec(rel);
        if (systemCelestialsAsk) {
          try {
            const buildDir = path.join(root, build);
            const file = path.join(buildDir, "celestials", `${systemCelestialsAsk[1]}.json`);
            // a list from an older extraction (before the sphere mesh, the gas giants' rings) is made again
            if (!fs.existsSync(file) || !fs.readFileSync(file, "utf8").includes('"celestialBuild":2')) {
              await extractOnce(`celestials:${systemCelestialsAsk[1]}`, buildDir, ["--system-celestials", systemCelestialsAsk[1]!]);
            }
            res.setHeader("content-type", "application/json");
            return res.end(fs.readFileSync(file));
          } catch (e) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: (e as Error).message }));
          }
        }
        const celestialAsk = /^\/celestial\/(\d+)$/.exec(rel);
        if (celestialAsk) {
          try {
            const buildDir = path.join(root, build);
            const tg = JSON.parse(fs.readFileSync(path.join(buildDir, "typeGraphics.json"), "utf8"))[celestialAsk[1]!] ?? null;
            res.setHeader("content-type", "application/json");
            if (!tg?.graphicFile) return res.end(JSON.stringify({ typeID: Number(celestialAsk[1]), celestial: null }));
            const rel2 = String(tg.graphicFile).toLowerCase().slice("res:/".length).replace(/\.(red|black)$/, "") + ".celestial.json";
            if (!fs.existsSync(path.join(buildDir, rel2))) await extractOnce(`celestial:${rel2}`, buildDir, ["--celestial", tg.graphicFile]);
            return res.end(fs.readFileSync(path.join(buildDir, rel2)));
          } catch (e) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: (e as Error).message }));
          }
        }
        // /client-assets/graphic/<graphicID>: a SOF graphic that is no type's (a station hangar), as /type/ answers.
        const graphicAsk = /^\/graphic\/(\d+)$/.exec(rel);
        if (graphicAsk) {
          try {
            const buildDir = path.join(root, build);
            const infoFile = path.join(buildDir, "graphics", `${graphicAsk[1]}.json`);
            if (!fs.existsSync(infoFile)) await extractOnce(`graphic:${graphicAsk[1]}`, buildDir, ["--graphic", graphicAsk[1]!]);
            const g = JSON.parse(fs.readFileSync(infoFile, "utf8"));
            res.setHeader("content-type", "application/json");
            if (g.scene && !("postprocess" in g.scene)) {
              // a scene extracted before it carried its post-process settings is extracted again
              fs.rmSync(infoFile);
              await extractOnce(`graphic:${graphicAsk[1]}:postprocess`, buildDir, ["--graphic", graphicAsk[1]!]);
              return res.end(fs.readFileSync(infoFile, "utf8"));
            }
            if (g.scene) return res.end(JSON.stringify(g));
            const stem = String(g.gr2).slice("res:/".length, -".gr2".length);
            const sofName = `${stem}.${String(g.faction ?? "none").toLowerCase()}.sof.json`;
            // a SOF build from before it carried the sprite, plane, spotlight and haze sets is made again
            if (fs.existsSync(path.join(buildDir, sofName)) && !fs.readFileSync(path.join(buildDir, sofName), "utf8").includes('"sofBuild":10')) {
              await extractOnce(`graphic:${graphicAsk[1]}:sets`, buildDir, ["--graphic", graphicAsk[1]!]);
            }
            const info = JSON.parse(fs.readFileSync(path.join(buildDir, stem + ".json"), "utf8"));
            const sof = fs.existsSync(path.join(buildDir, sofName)) ? `/client-assets/${sofName}` : null;
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ graphicID: g.graphicID, model: `/client-assets/${stem}.glb`, sof, textures: info.textures, lods: info.lods.length, hull: g.hull, faction: g.faction, race: g.race }));
          } catch (e) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: (e as Error).message }));
          }
        }
        const typeAsk = /^\/type\/(\d+)$/.exec(rel);
        if (typeAsk) {
          try {
            const buildDir = path.join(root, build);
            const tg = JSON.parse(fs.readFileSync(path.join(buildDir, "typeGraphics.json"), "utf8"))[typeAsk[1]!] ?? null;
            res.setHeader("content-type", "application/json");
            if (!tg?.gr2) return res.end(JSON.stringify({ typeID: Number(typeAsk[1]), model: null, ...(tg ?? {}) }));
            const stem = String(tg.gr2).slice("res:/".length, -".gr2".length);
            const sofName = `${stem}.${String(tg.faction ?? "none").toLowerCase()}.sof.json`;
            // a SOF build from before it carried the sprite and plane sets is made again
            const sofStale = fs.existsSync(path.join(buildDir, sofName)) && !fs.readFileSync(path.join(buildDir, sofName), "utf8").includes('"sofBuild":10');
            if (!fs.existsSync(path.join(buildDir, stem + ".glb")) || !fs.existsSync(path.join(buildDir, sofName)) || sofStale) {
              await extractOnce(`type:${typeAsk[1]}`, buildDir, ["--type", typeAsk[1]!]);
            }
            const info = JSON.parse(fs.readFileSync(path.join(buildDir, stem + ".json"), "utf8"));
            const sof = fs.existsSync(path.join(buildDir, sofName)) ? `/client-assets/${sofName}` : null;
            return res.end(JSON.stringify({ typeID: Number(typeAsk[1]), model: `/client-assets/${stem}.glb`, sof, textures: info.textures, lods: info.lods.length, ...tg }));
          } catch (e) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: (e as Error).message }));
          }
        }
        const file = path.resolve(root, build, "." + rel);
        if (!file.startsWith(path.resolve(root, build) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader("content-type", types[path.extname(file)] ?? "application/octet-stream");
        fs.createReadStream(file).pipe(res);
      });
      // Recorded Destiny feeds for the park harness (scripts/destiny-feed.js); dev only.
      const feeds = path.resolve(__dirname, "_local", "play-feed");
      server.middlewares.use("/play-feed", (req, res, next) => {
        const name = path.basename(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/"));
        const file = path.join(feeds, name);
        if (!/\.json$/.test(name) || !fs.existsSync(file)) return next();
        res.setHeader("content-type", "application/json");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

// The BFF's Destiny code (src/gamePort/destiny, CommonJS) bundled for the browser on demand, so the
// play page's park is the very code the BFF runs. `import { Park } from "virtual:destiny"`.
function destinyForTheBrowser(): Plugin {
  const id = "virtual:destiny";
  const resolved = "\0" + id;
  const src = (p: string) => JSON.stringify(path.resolve(__dirname, "src", p).replace(/\\/g, "/"));
  const entry = [
    `export { Park } from ${src("gamePort/destiny/park.js")};`,
    `export { Ballpark } from ${src("gamePort/destiny/ballpark.js")};`,
    `export { MODE, MODE_NAME, readState } from ${src("gamePort/destiny/state.js")};`,
    `export { readFeedItem, applyToPark, rebaseDelta } from ${src("gamePort/destiny/feed.js")};`,
    `export { marshalDecode } from ${src("gameProtocol/marshal.js")};`,
    `export { projectSpace, kindOf, CATEGORY, GROUP } from ${src("gamePort/spaceProjection.js")};`,
  ].join("\n");
  return {
    name: "destiny-for-the-browser",
    resolveId: (source) => (source === id ? resolved : null),
    async load(loading) {
      if (loading !== resolved) return null;
      const { rolldown } = await import("rolldown");
      const bundle = await rolldown({
        input: "destiny-entry",
        platform: "browser",
        cwd: __dirname,
        transform: { inject: { Buffer: ["buffer", "Buffer"] } },
        plugins: [{ name: "entry", resolveId: (s) => (s === "destiny-entry" ? s : null), load: (s) => (s === "destiny-entry" ? entry : null) }],
      });
      const { output } = await bundle.generate({ format: "esm" });
      await bundle.close();
      for (const file of ["gamePort/destiny/park.js", "gamePort/destiny/ballpark.js", "gamePort/destiny/state.js", "gamePort/destiny/feed.js", "gamePort/spaceProjection.js", "gameProtocol/marshal.js", "gameProtocol/marshalStringTable.js"]) {
        this.addWatchFile(path.resolve(__dirname, "src", file));
      }
      return output[0]?.code ?? "";
    },
  };
}

export default defineConfig({
  root: "web",
  plugins: [svelte(), tailwindcss(), clientAssets(), destinyForTheBrowser()],
  // Built asset URLs are absolute under "/" because the Express static
  // middleware serves public/dist/ AT THE ROOT (R45). This must stay in step
  // with where src/server.js mounts the build: emit /dist/assets/* while the
  // document is served at "/" and the browser gets a document that loads and
  // two assets that 404 — a blank page with no error anywhere.
  base: "/",
  build: {
    // Keep the output in its OWN directory. Pointing outDir at public/ itself
    // would let emptyOutDir wipe sibling files on every build.
    outDir: "../public/dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // Vite does not read PORT on its own. Honouring it lets a second dev server
    // run alongside one that already holds 5173 (two sessions iterating at once)
    // without either having to be stopped. Unset, it is the usual 5173.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      // ws: the page's requests go on its socket (/api/socket, app/pageFetch.ts) unless told otherwise; a proxy
      // that does not carry the upgrade leaves every socket request waiting.
      "/api": { target: bffTarget, ws: true },
      "/icon-cache": bffTarget,
      // The installed client's own pictures, as the BFF serves them (src/clientData/clientTextures.js).
      "/client-res": bffTarget,
    },
  },
});
