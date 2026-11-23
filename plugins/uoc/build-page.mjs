import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repo = fileURLToPath(new URL("../../", import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: repo, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const outputArg = process.argv.indexOf("--out-dir");
if (outputArg >= 0 && !process.argv[outputArg + 1]) throw Error("--out-dir needs a destination.");
if (process.argv.includes("--with-core")) run(["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);

// The same entry serves WC and registered plugin pages, including deep links.
const build = ["./node_modules/vite/bin/vite.js", "build"];
if (outputArg >= 0) build.push("--outDir", path.resolve(process.argv[outputArg + 1]), "--emptyOutDir", "false");
run(build);
