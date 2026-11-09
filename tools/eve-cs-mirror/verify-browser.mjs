#!/usr/bin/env node
// Optional browser verification. Install Playwright outside this mirror and pass
// --playwright <package directory> --browser <Chromium executable>.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const { chromium } = createRequire(import.meta.url)(opt("playwright", "playwright-core"));
const site = path.join(here, "site");
const reportFile = opt("report", path.join(site, "__browser-report.json"));
const report = { started: new Date().toISOString(), externalRequests: [], pages: [], scenarios: [] };
const deny = "data:text/javascript," + encodeURIComponent('globalThis.fetch=()=>{throw new Error("Offline verification forbids upstream fetch")};');
const server = spawn(process.execPath, ["--import", deny, "serve.mjs", "--port", "0"], { cwd: here, stdio: ["ignore", "pipe", "pipe"] });
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    let output = "", errors = "";
    server.stdout.on("data", chunk => { output += chunk; const m = /http:\/\/localhost:\d+/.exec(output); if (m) resolve(m[0]); });
    server.stderr.on("data", chunk => { errors += chunk; });
    server.on("error", reject); server.on("exit", code => reject(new Error(`Server exited ${code}: ${errors}`)));
  });
  browser = await chromium.launch({ headless: true, ...(opt("browser") ? { executablePath: opt("browser") } : {}), args: ["--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== base) { report.externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  function observe(page) {
    const result = { errors: [], missing: [], warnings: [] };
    page.on("pageerror", e => result.errors.push(e.message));
    page.on("response", r => { if (r.status() >= 400) result.missing.push({ status: r.status(), url: r.url() }); });
    page.on("console", m => { if (m.type() === "error" || (m.type() === "warning" && /failed|did not load/i.test(m.text()))) result.warnings.push(m.text().slice(0, 500)); });
    return result;
  }
  for (const route of ["/", "/scenarios", "/abyssal-deadspace", "/wormhole-space", "/settings", "/?mobile=1", "/scenarios?mobile=1"]) {
    const page = await context.newPage(), result = { route, ...observe(page) };
    try {
      await page.goto(base + route, { waitUntil: "networkidle" });
      assert.ok((await page.locator("body").innerText()).includes("EVE Combat Sim"));
      result.title = await page.title();
    } catch (e) { result.failure = e.message; }
    report.pages.push(result); await page.close();
  }
  const ids = JSON.parse(fs.readFileSync(path.join(site, "data/scenarios/index.json")));
  const selected = opt("scenarios")?.split(",") ?? (args.includes("--all") ? ids.map(x => x.split("/").pop()) : ["ecm", "sandbox", "abyss-t0", "wh-c1-perimeter-ambush-point", "fleet-basics-dps"]);
  for (const id of selected) {
    const key = ids.find(x => x.split("/").pop() === id);
    assert.ok(key, `Unknown scenario: ${id}`);
    const expected = JSON.parse(fs.readFileSync(path.join(site, `data/scenarios/active/${key}.json`))).name;
    const page = await context.newPage(), result = { id, expected, ...observe(page) };
    try {
      await page.goto(`${base}/play/${id}?seed=42${args.includes("--full-graphics") ? "" : "&graphics=minimum"}${opt("query") ? "&" + opt("query") : ""}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#start-popup .title")?.textContent && getComputedStyle(document.querySelector("#loading-screen")).display === "none", { timeout: 60000 });
      result.title = await page.locator("#start-popup .title").textContent();
      assert.equal(result.title, expected, "The requested scenario must not silently fall back");
      await page.locator("#objective .hold").click();
      await page.waitForFunction(() => /RUNNING/i.test(document.querySelector("#objective")?.innerText ?? ""), { timeout: 10000 });
      await page.waitForTimeout(Number(opt("duration", 2000)));
      result.objective = await page.locator("#objective").innerText();
      result.overviewRows = await page.locator("#overview tbody tr").count();
      assert.ok(result.overviewRows > 0);
      if (opt("screenshots")) {
        fs.mkdirSync(opt("screenshots"), { recursive: true });
        await page.screenshot({ path: path.join(opt("screenshots"), `${id}.png`) });
      }
    } catch (e) { result.failure = e.message; }
    report.scenarios.push(result); await page.close();
    console.log(`${id}: ${result.failure ? "FAIL " + result.failure : "running"}, ${result.errors.length} errors, ${result.missing.length} missing`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  }
  assert.deepEqual(report.externalRequests, [], "No external requests may be attempted");
  const failures = [...report.pages, ...report.scenarios].filter(x => x.failure || x.errors.length || x.missing.length || x.warnings.length);
  assert.equal(failures.length, 0, `${failures.length} page/scenario checks failed; see site/__browser-report.json`);
  console.log(`${report.pages.length} pages and ${report.scenarios.length} scenarios passed with upstream fetch disabled and external browser requests blocked.`);
} finally {
  report.finished = new Date().toISOString();
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  await browser?.close(); server.kill();
}
