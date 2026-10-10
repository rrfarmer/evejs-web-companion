// Contract WRITE acks (goal R91, Phase-3 WRITES — PLUMBING ONLY).
//
// FAST-MODE educated-guess decoders for the 11 confirm-gated contractProxy
// WRITES (CreateContract / AcceptContract / CompleteContract / DeleteContract /
// DeleteMultipleContracts / PlaceBid / FinishAuction / SplitStack /
// DeleteNotification / DeleteContractNotification / GM_ExpireContract). Each BFF
// route answers the uniform dispatchBridgeWrite envelope
// `{ ok, applied, result, notifications }`; these decoders read that ack.
//
// Server return shapes (contractProxyService.js), the educated guesses here:
//   • CreateContract          → buildList(contractIDs) (the new contract ids)
//   • AcceptContract          → buildContractRow(accepted) (a row, or null)
//   • DeleteMultipleContracts → [buildList(deleted), buildList(failed)]
//   • CompleteContract / DeleteContract → boolean
//   • PlaceBid / SplitStack / DeleteNotification / DeleteContractNotification → null (stubs)
//   • FinishAuction / GM_ExpireContract → false (stub / GM-only)
// ⚠ The financial (AcceptContract / PlaceBid), destructive (Delete*) and admin
// (GM_ExpireContract) writes are confirm-gated + reachability-only — NEVER fired
// live in the plumbing pass — so these shapes are EDUCATED GUESSES, not captured
// bytes (QA later).
//
// LOCAL coercions only — this module deliberately does NOT import from market*.ts
// (a separate session owns those files).

// A CONTRACT TAKEN ON is made by the page itself (the plan's Phase 6b). Until
// 2026-10-10 it was POST /api/bridge/contracts/accept, which checked that the
// page had said `confirm` and made one call. The client's contracts service
// makes that call once it has asked the pilot (contracts.py 345 to 420: the
// contract read, the stations it starts and ends at, a courier's volume against
// the ship, and a yes or no on what is to be paid and got):
//
//   contractProxy.AcceptContract(contractID, forCorp)
//                                  contracts.py 422: the contract's ID, and whether it is taken on for
//                                  the corporation. It answers the contract's row. Recorded on
//                                  Tranquility with (contractID, False), answering a DBRow.
//
// The details window has a button for each (contractsDetailsWnd.py 516, 528); the
// one for the corporation is shown only to a character with its Contract Manager
// role. The page has the first alone: it is not told the session's roles.
// Either transport carries the call.

import type { Ask } from "./ask.ts";
import { isListValue, readPlainJsonField, readRowField, type JsonValue } from "./wire.ts";

/** The uniform ack every confirm-gated contract write returns. */
export interface ContractWriteAck {
  readonly ok: boolean;
  readonly applied: boolean;
}

function ackTruthy(value: JsonValue | undefined): boolean {
  return value === true;
}

/** Read the `result` field off a BFF write-ack envelope (null when absent). */
function ackResult(response: JsonValue): JsonValue | null {
  const result = readPlainJsonField(response, "result");
  return result === undefined ? null : result;
}

/** Coerce a wire list (or plain array) of ids to a clean positive-int number[]. */
function idList(value: JsonValue | null): number[] {
  const items = isListValue(value)
    ? value.items
    : Array.isArray(value)
      ? value
      : [];
  return (items as JsonValue[])
    .map((v) => Number(v) || 0)
    .filter((v) => v > 0);
}

/** Decode a plain contract write ack (applied-only: PlaceBid / SplitStack / Delete*Notification / …). */
export function decodeContractWriteAck(response: JsonValue): ContractWriteAck {
  return {
    ok: ackTruthy(readPlainJsonField(response, "ok")),
    applied: ackTruthy(readPlainJsonField(response, "applied")),
  };
}

/** CreateContract ack: the handler returns a list of the new contract ids. */
export interface CreateContractAck extends ContractWriteAck {
  readonly contractIDs: number[];
}

export function decodeCreateContractAck(response: JsonValue): CreateContractAck {
  return { ...decodeContractWriteAck(response), contractIDs: idList(ackResult(response)) };
}

/**
 * A contract taken on: for the character, or for its corporation where `forCorp`. Answers the ID of the
 * contract the server says was accepted, read off the row it answers; 0 where it answered no such row, which is
 * a decline: a call that answered is not proof that anything was settled. Fails as the call fails.
 */
export async function acceptContract(act: Ask, contractID: number, forCorp: boolean): Promise<number> {
  const accepted = Number(readRowField(await act("contractProxy", "AcceptContract", [contractID, forCorp]), "contractID"));
  return accepted > 0 ? accepted : 0;
}

/**
 * DeleteMultipleContracts ack: the handler returns [deleted, failed] id lists.
 * ⚠ NEVER fired live — this shape is an educated guess.
 */
export interface DeleteMultipleContractsAck extends ContractWriteAck {
  readonly deleted: number[];
  readonly failed: number[];
}

export function decodeDeleteMultipleContractsAck(response: JsonValue): DeleteMultipleContractsAck {
  const result = ackResult(response);
  const first = isListValue(result) ? result.items[0] : Array.isArray(result) ? result[0] : null;
  const second = isListValue(result) ? result.items[1] : Array.isArray(result) ? result[1] : null;
  return {
    ...decodeContractWriteAck(response),
    deleted: idList((first ?? null) as JsonValue | null),
    failed: idList((second ?? null) as JsonValue | null),
  };
}
