// Pure reward reconciliation from WC75 core-prototype web/src/nav/missionRewards.ts.
import { decodeCashBalance, toAmountString } from "./amount.ts";
import { decodeJournalEntries, missionRewardTaxISK, type JournalEntry } from "./walletJournal.ts";
import { isListValue, readRowField, type JsonValue } from "../wire.ts";

export interface MissionRewardSnapshot {
  readonly characterID: number;
  readonly agentID: number;
  readonly corporationID: number | null;
  readonly cash: string | null;
  readonly lp: string | null;
  readonly memberCorporationID: number | null;
  readonly corporationLp: string | null;
  readonly journal: readonly RewardEntry[] | null;
}

interface RewardEntry extends Omit<JournalEntry, "amount"> { readonly amount: string }

export interface MissionRewardReadout {
  readonly missionKey: string;
  readonly characterID: number;
  readonly agentID: number;
  readonly corporationID: number | null;
  readonly confirmedIsk: string | null;
  readonly withheldIsk: string | null;
  readonly observedCashChange: string | null;
  readonly observedLpChange: string | null;
  readonly observedCorporationLpChange: string | null;
  readonly iskReason: string | null;
  readonly lpReason: string | null;
}

function cents(value: string | null): bigint | null {
  if (value === null || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const negative = value.startsWith("-");
  const [whole, decimal = ""] = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(whole!) * 100n + BigInt(decimal.padEnd(2, "0"));
  return negative ? -result : result;
}

function money(value: bigint): string {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

function lpBalance(value: JsonValue, corporationID: number | null): string | null {
  if (!Number.isSafeInteger(corporationID) || corporationID! <= 0 || value === null ||
      typeof value !== "object" || Array.isArray(value)) return null;
  const rowset = value as { readonly type?: JsonValue; readonly list?: JsonValue };
  if (rowset.type !== "objectex2") return null;
  const rows = rowset.list;
  if (!Array.isArray(rows)) return null;
  let result: string | null = null;
  const seen = new Set<number>();
  for (const row of rows) {
    const issuer = Number(toAmountString(readRowField(row, "issuerCorpID")));
    const balance = toAmountString(readRowField(row, "loyaltyPoints"));
    if (!Number.isSafeInteger(issuer) || issuer <= 0 || seen.has(issuer) || balance === null || !/^\d+$/.test(balance)) return null;
    seen.add(issuer);
    if (issuer === corporationID) result = balance;
  }
  // This is an authoritative full balance rowset. An absent issuer has no LP
  // wallet yet, which is distinct from an unreadable or malformed rowset.
  return result ?? "0";
}

function journalEntries(value: JsonValue): readonly RewardEntry[] | null {
  if (!isListValue(value)) return null;
  const entries = decodeJournalEntries(value), ids = new Set<number>();
  const result: RewardEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const amount = toAmountString(readRowField(value.items[index], "amount"));
    if (!Number.isSafeInteger(entry.transactionID) || entry.transactionID <= 0 || ids.has(entry.transactionID) ||
        !Number.isSafeInteger(entry.entryTypeID) || entry.entryTypeID <= 0 || cents(amount) === null ||
        !Number.isSafeInteger(entry.ownerID1) || !Number.isSafeInteger(entry.ownerID2)) return null;
    ids.add(entry.transactionID);
    result.push({ ...entry, amount: amount! });
  }
  return result;
}

/** Capture only the explicitly read pilot balances and journal, before or after Complete. */
export function captureMissionRewards(input: {
  readonly characterID: number; readonly agentID: number; readonly corporationID: number | null;
  readonly cash: JsonValue; readonly lp: JsonValue; readonly journal: JsonValue;
  readonly memberCorporationID?: number | null; readonly corporationLp?: JsonValue;
}): MissionRewardSnapshot {
  const memberCorporationID = input.memberCorporationID ?? null;
  return { characterID: input.characterID, agentID: input.agentID, corporationID: input.corporationID,
    cash: decodeCashBalance(input.cash), lp: lpBalance(input.lp, input.corporationID), journal: journalEntries(input.journal),
    memberCorporationID, corporationLp: memberCorporationID === null ? null : lpBalance(input.corporationLp ?? null, input.corporationID) };
}

const WALLET_JOURNAL_LIMIT = 100;

function addedJournalEntries(before: MissionRewardSnapshot["journal"], after: MissionRewardSnapshot["journal"]): readonly RewardEntry[] {
  if (!before || !after) return [];
  // A full window could have rolled over since an empty snapshot.
  if (before.length === 0) return after.length < WALLET_JOURNAL_LIMIT ? after : [];

  const priorIds = new Set(before.map(row => row.transactionID));
  const currentById = new Map(after.map(row => [row.transactionID, row]));
  const unchanged = (entry: RewardEntry) => {
    const present = currentById.get(entry.transactionID);
    return !!present && present.entryTypeID === entry.entryTypeID && present.referenceID === entry.referenceID &&
      present.ownerID1 === entry.ownerID1 && present.ownerID2 === entry.ownerID2 && present.amount === entry.amount &&
      present.transactionDate === entry.transactionDate && present.description === entry.description;
  };
  if (!before.every(unchanged)) {
    // EveJS prepends new rows. When old rows fall out, the retained suffix matches the previous prefix.
    const firstRetained = after.findIndex(row => priorIds.has(row.transactionID));
    if (firstRetained < 0 || !after.slice(firstRetained).every((row, index) => {
      const prior = before[index];
      return prior?.transactionID === row.transactionID && unchanged(prior);
    })) return [];
  }
  return after.filter(row => !priorIds.has(row.transactionID));
}

/**
 * Attribute ISK only to new stock agent payout rows. LP has no equivalent
 * per-mission transaction row, so it is explicitly an observed balance change.
 */
export function compareMissionRewards(before: MissionRewardSnapshot, after: MissionRewardSnapshot,
  identity: { readonly characterID: number; readonly agentID: number; readonly missionKey: string; readonly completed: true }): MissionRewardReadout {
  const base: MissionRewardReadout = { missionKey: identity.missionKey, characterID: identity.characterID,
    agentID: identity.agentID, corporationID: null, confirmedIsk: null, withheldIsk: null, observedCashChange: null,
    observedLpChange: null, observedCorporationLpChange: null,
    iskReason: "Mission payout could not be attributed.", lpReason: "LP balance change is unavailable." };
  if (!identity.missionKey || identity.completed !== true || before.characterID !== identity.characterID ||
      after.characterID !== identity.characterID || before.agentID !== identity.agentID || after.agentID !== identity.agentID)
    return base;
  const corporationID = Number.isSafeInteger(before.corporationID) && before.corporationID! > 0 &&
    before.corporationID === after.corporationID ? before.corporationID : null;
  const priorCash = cents(before.cash), currentCash = cents(after.cash);
  const observedCashChange = priorCash !== null && currentCash !== null ? money(currentCash - priorCash) : null;
  const observedLpChange = corporationID && before.lp !== null && after.lp !== null
    ? (BigInt(after.lp) - BigInt(before.lp)).toString() : null;
  const observedCorporationLpChange = corporationID && before.memberCorporationID !== null &&
    before.memberCorporationID === after.memberCorporationID && before.corporationLp !== null && after.corporationLp !== null
    ? (BigInt(after.corporationLp) - BigInt(before.corporationLp)).toString() : null;
  let confirmedIsk: string | null = null;
  let withheldIsk: string | null = null;
  const eligible = addedJournalEntries(before.journal, after.journal).filter(row => [33, 34].includes(row.entryTypeID) &&
    row.ownerID1 === identity.agentID && row.ownerID2 === identity.characterID && row.referenceID === identity.agentID);
  const credits = eligible.map(row => {
    const amount = cents(row.amount), tax = missionRewardTaxISK(row);
    const withheld = tax === null ? null : cents(toAmountString(tax));
    return amount !== null && withheld !== null && amount >= 0n && amount + withheld > 0n ? { amount, withheld } : null;
  });
  if (credits.length > 0 && new Set(eligible.map(row => row.entryTypeID)).size === eligible.length &&
      credits.every(credit => credit !== null)) {
    confirmedIsk = money(credits.reduce((sum, credit) => sum + credit.amount, 0n));
    withheldIsk = money(credits.reduce((sum, credit) => sum + credit.withheld, 0n));
  }
  return { ...base, corporationID, confirmedIsk, withheldIsk, observedCashChange, observedLpChange, observedCorporationLpChange,
    iskReason: confirmedIsk === null ? base.iskReason : null,
    lpReason: observedLpChange === null ? base.lpReason : "LP change is observed for the agent's corporation; individual payout attribution is unavailable." };
}
