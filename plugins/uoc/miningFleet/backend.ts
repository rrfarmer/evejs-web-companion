import { uocStore } from "../backendStores.ts";
import { operationAllowsFinish, operationHasController } from "../runControl.ts";
import { worldForRequest } from "../shared/backendScope.ts";
import {
  readPreparationEvidence,
  discardPreparationEvidence,
} from "../operations/miningEvidence.ts";
import {
  createMiningOperationRoutes,
  findMiningLaunchJournal,
} from "../operations/miningRoutes.ts";
import { createFleetMiningCycle } from "./miningCycle.ts";
import { createMiningFleetRuntime } from "./runtime.ts";
import { settleFleetMember } from "./settle.ts";

export function createMiningBackend() {
  const definitions = uocStore("restored-mining-definitions.sqlite");
  const fleet = createMiningFleetRuntime({
    createCycle: createFleetMiningCycle,
    settle: settleFleetMember,
    dockedUnloadsOnly: true,
    launchJournal: (operationID, runID) => findMiningLaunchJournal(definitions, operationID, runID),
  });

  const miningRoutes = createMiningOperationRoutes(
    {
      document: definitions.document,
      requestStop: fleet.requestOperationStop,
      getWorldScope: worldForRequest,
      isOperationActive: operationHasController,
      canFinish: operationAllowsFinish,
      retainedSetup: fleet.retainedSetup,
      authorizeFinish: fleet.authorizeFinish,
      finalizeRetainedStop: fleet.finalizeRetainedStop,
      finishSnapshot: fleet.finishSnapshot,
      preparationSnapshot: readPreparationEvidence,
      markTargetSafe: fleet.markTargetSafe,
      resetDepletedBelt: fleet.resetDepletedBelt,
      targetSnapshot: fleet.targetSnapshot,
      operationSnapshot: fleet.operationSnapshot,
      deliveryReceiptIndex: fleet.deliveryReceiptIndex,
      deliveryReceipt: fleet.deliveryReceipt,
      completedFleetResult: fleet.completedFleetResult,
      checkSetup: (setup) => fleet.runs.MINER.check(setup),
      telemetrySnapshot: fleet.telemetrySnapshot,
      supportSnapshot: fleet.supportSnapshot,
      memberSnapshot: fleet.memberSnapshot,
      async relocate(intent) {
        const next = await fleet.prepareRelocation(intent);
        return !!next && fleet.requestRelocation({ ...intent, next });
      },
    },
    definitions,
    { discardGeneration: fleet.discardGeneration, discardPreparation: discardPreparationEvidence },
  );
  return { fleet, miningRoutes };
}
