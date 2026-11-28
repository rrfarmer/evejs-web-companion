import {
  PROGRAM_DONE_PHASE,
  SCRIPT_FORMAT,
  SCRIPT_VERSION,
  startingStation,
  type BotScript,
} from "../../../web/src/plugin-api/index.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";

export function miningSystemTransitScript(systemID: number): BotScript {
  return {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: "MCC — Travel to mining system",
    notes: "",
    home: startingStation(),
    interrupts: [],
    program: [
      {
        id: "mining-system",
        kind: "macro",
        macro: "travel-to-system",
        args: {
          system: {
            kind: "system",
            ref: { entity: "system", id: systemID, name: null, systemName: null },
          },
        },
      },
    ],
  };
}

/** The caller's existing member task owns the ship until WC's finite script retires. */
export async function travelToMiningSystem(
  session: PilotSession,
  systemID: number,
  deadline: number,
  current: () => void,
): Promise<"program-done" | "timed-out"> {
  const { flow, store } = session;
  current();
  if (Date.now() >= deadline) return "timed-out";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeBot: (() => void) | undefined;
  let unsubscribeTravel: (() => void) | undefined;
  try {
    await flow.startCustomBot(miningSystemTransitScript(systemID));
    return await new Promise<"program-done" | "timed-out">((resolve, reject) => {
      timer = setTimeout(() => resolve("timed-out"), Math.max(0, deadline - Date.now()));
      const initialTravel = store.travel.get();
      unsubscribeTravel = store.travel.subscribe((travel) => {
        if (travel !== initialTravel && travel.failureReason) reject(Error(travel.failureReason));
      });
      unsubscribeBot = store.customBot.subscribe((progress) => {
        try {
          current();
        } catch (error) {
          reject(error);
          return;
        }
        if (progress.status === "running") return;
        if (progress.status === "stopped" && progress.phase === PROGRAM_DONE_PHASE)
          resolve("program-done");
        else reject(Error(progress.pauseReason ?? progress.why ?? "Mining-system route stopped."));
      });
    });
  } finally {
    clearTimeout(timer);
    unsubscribeBot?.();
    unsubscribeTravel?.();
    // Wait out the stock runner's last tick before the member can navigate the belt or park.
    await flow.cancelHostedHome("script");
    flow.stopCustomBot();
  }
}
