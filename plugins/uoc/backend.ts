import {createRequire} from "node:module";
import path from "node:path";
import {startBackend,pluginDataDir,type BackendRoute,type BackendRun} from "../../web/src/plugin-api/backend.ts";
import manifest from "./plugin.ts";
import {readPreparationEvidence,closePreparationEvidence} from "./operations/miningEvidence.ts";
import {createCombatRoutes} from "./operations/combatRoutes.ts";
import {createDistributionStore} from "./logistics/store.ts";
import {civilianCheckpointRoutes} from "./civilian/index.ts";
import {civilianCheckpointRun} from "./civilian/checkpoint.ts";
import {withCivilianPolicy} from "./shared/civilianReport.ts";
import {worldForRequest,worldRoute} from "./shared/backendScope.ts";
import {ownerTrainingRoutes} from "./training/ownerServices.ts";
import {runControlRoutes} from "./runControl.ts";
import {securityProgressRoutes} from "./combat/progress.ts";
import {fleetSecurityProgressRoutes} from "./combat/fleetTelemetry.ts";

export {decodeCivilianMiningSetup,civilianMiningPlan} from "./mining/setup.ts";

function lazyRun(load:()=>Promise<BackendRun>):BackendRun {
  return {
    async check(setup) { return (await load()).check(setup); },
    async start(run) { return (await load()).start(run); },
  };
}

export const civilianMiningRun=lazyRun(async()=> (await import("./mining/host.ts")).civilianMiningRun);

const miningRouteNames=[
  "POST /mining-targets/mark-safe",
  "POST /mining-targets/reset-depleted",
  "GET /mining-operations",
  "GET /mining-operations/:operationID/delivery-receipts",
  "POST /mining-operations",
  "POST /mining-operations/observe",
  "POST /mining-operations/:operationID/stop",
  "GET /mining-operations/:operationID/recovery",
  "POST /mining-operations/:operationID/recovery/dispatch",
  "POST /mining-operations/:operationID/recovery/accept",
  "POST /mining-operations/:operationID/recovery/finalize",
  "POST /mining-operations/:operationID/relocate",
  "POST /mining-operations/:operationID/delete",
  "GET /mining-operations/:operationID/launch-plan",
  "POST /mining-operations/:operationID/launch-plan",
  "POST /mining-operations/:operationID/launch/begin",
  "POST /mining-operations/:operationID/launch/dispatch",
  "POST /mining-operations/:operationID/launch/accept",
  "POST /mining-operations/:operationID/launch/refuse",
  "POST /mining-operations/:operationID/launch/end",
  "GET /mining-operations/:operationID/launch",
];

if(typeof process.send==="function"){
  let mining:Promise<typeof import("./miningFleet/backend.ts")>|undefined;
  const loadMining=()=> mining??=import("./miningFleet/backend.ts");
  const miningRoutes:Record<string,BackendRoute>={};
  for(const name of miningRouteNames){
    miningRoutes[name]=async request=> (await loadMining()).miningRoutes[name]!(request);
  }

  let combatFleet:Promise<ReturnType<typeof import("./combat/fleetHost.ts").createFleetSecurityRuns>>|undefined;
  const loadCombatFleet=()=> combatFleet??=import("./combat/fleetHost.ts").then(module=>module.createFleetSecurityRuns());
  let anomalyFleet:Promise<ReturnType<typeof import("./combat/anomalies/fleetHost.ts").createAnomalyFleetRuns>>|undefined;
  const loadAnomalyFleet=()=> anomalyFleet??=import("./combat/anomalies/fleetHost.ts").then(module=>module.createAnomalyFleetRuns());
  let patrolFleet:Promise<ReturnType<typeof import("./combat/patrol/host.ts").createPatrolRuns>>|undefined;
  const loadPatrolFleet=()=> patrolFleet??=import("./combat/patrol/host.ts").then(module=>module.createPatrolRuns());

  const require=createRequire(import.meta.url);
  let logisticsDB:{document:Parameters<typeof createDistributionStore>[0];close():void}|undefined;
  const logisticsDocument=(name:string)=>{
    const db=logisticsDB??=require("./documentStore.cjs").createDocumentStore(path.join(pluginDataDir(),"distribution.sqlite"));
    return db.document(name);
  };
  const logistics=createDistributionStore(world=>logisticsDocument("routes:"+world),logisticsDocument);
  let distributionDriver:BackendRun|undefined;
  const restoredCombat=createCombatRoutes({getWorldScope:worldForRequest,preparationSnapshot:readPreparationEvidence});

  startBackend({
    manifest,
    routes:{
      "GET /world":worldRoute,
      ...logistics.routes,
      ...miningRoutes,
      ...civilianCheckpointRoutes,
      ...restoredCombat.routes,
      ...runControlRoutes,
      ...ownerTrainingRoutes,
      ...securityProgressRoutes,
      ...fleetSecurityProgressRoutes,
    },
    runs:{
      "distribution-carrier":lazyRun(async()=> {
        const {createDistributionDriver}=await import("./logistics/host.ts");
        return distributionDriver??=createDistributionDriver(logistics);
      }),
      "combat-patrol-member":lazyRun(async()=> (await loadPatrolFleet()).member),
      "civilian-checkpoint":civilianCheckpointRun,
      "anomaly-fleet-inspect":lazyRun(async()=> (await import("./combat/anomalies/inspect.ts")).anomalyInspectRun),
      "anomaly-fleet-member":lazyRun(async()=> (await loadAnomalyFleet()).member),
      "civilian-mining":withCivilianPolicy(civilianMiningRun,"mining"),
      "civilian-distribution":withCivilianPolicy(lazyRun(async()=> (await import("./distribution/host.ts")).civilianDistributionRun),"distribution"),
      "coc-security":lazyRun(async()=> (await import("./combat/host.ts")).civilianSecurityRun),
      "coc-fleet-inspect":lazyRun(async()=> (await import("./combat/inspect.ts")).combatFleetInspectRun),
      "security-fleet-owner":lazyRun(async()=> (await loadCombatFleet()).owner),
      "security-fleet-assistant":lazyRun(async()=> (await loadCombatFleet()).assistant),
      "mcc-inspect":lazyRun(async()=> (await import("./miningFleet/inspect.ts")).miningFleetInspectRun),
      "mcc-prepare":lazyRun(async()=> (await import("./operations/miningPreparationHost.ts")).miningPreparationRun),
      "mcc-miner":lazyRun(async()=> (await loadMining()).fleet.runs.MINER),
      "mcc-hauler":lazyRun(async()=> (await loadMining()).fleet.runs.HAULER),
      "mcc-command":lazyRun(async()=> (await loadMining()).fleet.runs.COMMAND),
      "mcc-defender":lazyRun(async()=> (await loadMining()).fleet.runs.DEFENDER),
      "mcc-finish":lazyRun(async()=> (await loadMining()).fleet.runs.FINISH),
      "training":lazyRun(async()=> (await import("./training/host.ts")).trainingRun),
      "training-inspect":lazyRun(async()=> (await import("./training/host.ts")).trainingInspectRun),
      "training-hr":lazyRun(async()=> (await import("./training/hr.ts")).trainingHRRun),
      "training-join":lazyRun(async()=> (await import("./training/hr.ts")).trainingJoinRun),
      "provision-inspect":lazyRun(async()=> (await import("./provisioning/host.ts")).provisioningInspectRun),
      "provision-apply":lazyRun(async()=> (await import("./provisioning/host.ts")).provisioningApplyRun),
    },
    async cleanup(){
      logisticsDB?.close();
      closePreparationEvidence();
      restoredCombat.close();
      (await mining)?.closeMiningDefinitions();
    },
  });
}
