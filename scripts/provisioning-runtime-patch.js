"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const helper = path.resolve(__dirname, "../runtime-patches/provisioningObservation.js");
const files = ["server/src/_secondary/express/evejsWebGatewayRuntime.js", "server/src/_secondary/express/evejsWebGateway.js", "server/src/edge/gateway/gatewayRuntimeProtocol.js",
  "server/src/services/online/characterControlRuntime.js"];
const sha = v => crypto.createHash("sha256").update(v).digest("hex");
function insert(source, anchor, text, marker) {
  if (source.includes(marker)) {
    if (!source.replace(/\r\n/g,"\n").includes(text)) throw new Error(`Installed seam differs: ${marker}`);
    return source;
  }
  if (source.split(anchor).length !== 2) throw new Error(`Expected unique semantic seam: ${anchor}`);
  return source.replace(anchor, (source.includes("\r\n") ? text.replace(/\n/g,"\r\n") : text) + anchor);
}
function plans(root) {
  const sources = files.map(file => fs.readFileSync(path.join(root,file),"utf8"));
  const observationSeam = `    // Ship Provisioning Phase 6A: synchronous, observation-only world seam.
    buildProvisioningObservation(accountID, characterID = null, source = { kind: "hangar" }) {
      return require("./provisioningObservation").createProvisioningObservation({
        read: gameStore.read, processRole: gameStore._processRole,
        control: characterID => characterControlRuntime.peekCharacterControlSnapshot(characterID),
      }).project(accountID, characterID, source);
    },
`;
  // Upgrade only the exact earlier workstream-owned seam, never a foreign body.
  const priorSeam = observationSeam.replace(".peekCharacterControlSnapshot(", ".getCharacterControlSnapshot(");
  if (sources[0].includes(priorSeam)) sources[0] = sources[0].replace(priorSeam, observationSeam);
  else if (sources[0].includes(priorSeam.replace(/\n/g,"\r\n"))) sources[0] = sources[0].replace(priorSeam.replace(/\n/g,"\r\n"),observationSeam.replace(/\n/g,"\r\n"));
  sources[0] = insert(sources[0], "    buildSnapshot(accountID, characterID) {", observationSeam, "    buildProvisioningObservation(accountID,");
  sources[1] = insert(sources[1], "  snapshots: true,", "  provisioningObservation: true,\n", "  provisioningObservation: true,");
  sources[1] = insert(sources[1], '  app.get(`${GATEWAY_PREFIX}/snapshot`,', `  app.get(\x60\x24{GATEWAY_PREFIX}/provisioning-observation\x60, requireAuthorizedRuntime(async (runtime, req, res) => {
    if (typeof runtime.buildProvisioningObservation !== "function") {
      sendGatewayError(res, 503, "PROJECTION_UNAVAILABLE", "Provisioning observation is unavailable."); return;
    }
    const accountID = Number(req.query.accountID);
    const characterID = req.query.characterID === undefined ? null : Number(req.query.characterID);
    const source = req.query.sourceKind === "corp" ? { kind: "corp", corporationID: Number(req.query.corporationID), division: Number(req.query.division) } : { kind: "hangar" };
    try { res.status(200).json({ ok: true, source: GATEWAY_SOURCE, apiVersion: GATEWAY_API_VERSION, projection: await runtime.buildProvisioningObservation(accountID, characterID, source) }); }
    catch (error) { sendGatewayError(res, 403, "PROJECTION_REFUSED", String(error.code || "PROJECTION_UNAVAILABLE")); }
  }));

`, '/provisioning-observation\x60, requireAuthorizedRuntime');
  sources[2] = insert(sources[2], '  "buildSnapshot",', '  "buildProvisioningObservation",\n', '  "buildProvisioningObservation",');
  sources[3] = insert(sources[3], '  function getCharacterControlSnapshot(characterIDValue) {', `  // Observation only: an expired lease is unreadable until normal lifecycle
  // authority cleans it up. A Center read never expires or notifies an owner.
  function peekCharacterControlSnapshot(characterIDValue) {
    const characterID = normalizeCharacterID(characterIDValue);
    if (!characterID) throw makeControlError(ERROR_CODES.UNAVAILABLE);
    const retailSession = findRetailSession(characterID);
    const lease = browserLeases.get(characterID);
    if ((retailSession && lease) || (lease && nowMs() >= lease.expiresAtMs)) {
      throw makeControlError(ERROR_CODES.UNAVAILABLE);
    }
    return retailSession ? retailSnapshot(characterID) : lease ? browserSnapshot(characterID, lease) : offlineSnapshot(characterID);
  }

`, '  function peekCharacterControlSnapshot(');
  sources[3] = insert(sources[3], '    getCharacterControlSnapshot,', '    peekCharacterControlSnapshot,\n', '    peekCharacterControlSnapshot,');
  const helperFile = "server/src/_secondary/express/provisioningObservation.js", after = fs.readFileSync(helper);
  const before = fs.existsSync(path.join(root,helperFile)) ? fs.readFileSync(path.join(root,helperFile)) : null;
  // This NEW file is the complete owned artifact. Do not overwrite another
  // implementation/local edit at its path. Existing runtime files use seams.
  if (before && before.toString().replace(/\r\n/g,"\n") !== after.toString().replace(/\r\n/g,"\n")) throw new Error("Installed projection helper differs; preserve and review it before upgrading.");
  return [...files.map((file,i) => ({ file, before: fs.readFileSync(path.join(root,file)), after: Buffer.from(sources[i]) })),
    { file: helperFile, before, after: before || after }];
}
if (require.main === module) {
  const args = process.argv.slice(2), arg = key => args[args.indexOf(key)+1];
  const root = path.resolve(arg("--root") || ""), write = args.includes("--write"), evidence = args.includes("--evidence") && path.resolve(arg("--evidence"));
  if (!args.includes("--root")) throw new Error("Use --root <runtime> [--write --evidence <directory>]");
  if (write && (!evidence || path.basename(root) !== "EveJS-0.12.9-test")) throw new Error("Deployment requires mutable EveJS-0.12.9-test and backup evidence directory.");
  const changes = plans(root); // validate ALL seams before writing ANY file.
  if (write) {
    fs.mkdirSync(evidence, { recursive: true });
    for (const c of changes) { if (c.before) { const backup=path.join(evidence,c.file); fs.mkdirSync(path.dirname(backup),{recursive:true}); if (!fs.existsSync(backup)) fs.writeFileSync(backup,c.before); }
      fs.writeFileSync(path.join(root,c.file),c.after); }
  }
  const manifest = { classification: "D", artifact: "Phase 6A read-only world projection", root, deployed: write, helperSHA256: sha(fs.readFileSync(helper)),
    files: changes.map(c => ({ file: c.file, before: c.before && sha(c.before), after: sha(c.after) })) };
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence,write ? "deployment.json" : "verification.json"),JSON.stringify(manifest,null,2)); }
  console.log(JSON.stringify(manifest,null,2));
}
module.exports = { plans };
