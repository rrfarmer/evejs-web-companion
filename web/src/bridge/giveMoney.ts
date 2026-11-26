// Give Money, as the client gives it: an owner's menu's Give Money (menusvc.py _CharacterMenu, 615 to 616:
// wallet.TransferMoney(session.charid, None, charID, None)) opens the transfer window (walletSvc.py TransferMoney, 142
// to 151; transferMoneyWnd.py), which gives the pilot's own ISK to the character:
//
//   amount  a float of two decimal places, at least 0.1 and at most what the pilot has (walletSvc's wealth, the
//           GetCashBalance(0) it keeps and OnAccountChange puts right), 0.1 where nothing is typed (93; the field's
//           GetValue and CheckBounds, baseSingleLineEditNumber.py 105 to 119 and 320 to 331);
//   reason  forty characters at most, with < and > written as the entities (94; singleLineEditText.py GetValue, 39
//           to 45);
//
// and its OK (Confirm, 138 to 152) asks nothing where the amount is not above nought, and otherwise
//
//   sm.RemoteSvc('account').GiveCash(self.toID, amount, reason, toAccountKey=toAccountKey)
//
// the account key None for a character, then says the transfer was made and closes. Tranquility's recording of a
// transfer to a corporation (Open Wallet - Plex - Corp Wallet - Corp Transfers) has GiveCash(98827279, 100.0, '')
// with toAccountKey=1000; none has one to a character.
//
// WHAT THE SERVER TAKES FROM THE CALLER: the character given to, the amount and the reason. The ISK is the session's
// own character's (account's Handle_GiveCash).

import type { Ask } from "./ask.ts";

/** transferMoneyWnd.py 37: the least that is given. */
export const TRANSFER_MIN_ISK = 0.1;
/** transferMoneyWnd.py 94: the longest reason. */
export const TRANSFER_REASON_MAX = 40;

/**
 * The amount the window's field holds for what was typed, as the client's float field makes it: nothing typed the
 * least; what is not a number nought; the decimals past the second cut off; held between the least and what the
 * pilot has (`wealth`, none where it is not known).
 */
export function transferAmount(typed: string, wealth: number | null): number {
  const text = typed.trim().replace(/,/g, "");
  if (text === "") return TRANSFER_MIN_ISK;
  // SingleLineEditFloat.ValidateNewText cuts the typed decimal suffix, not
  // value*100 (which turns 2.55 into 2.54 through binary floating arithmetic).
  const dot = text.indexOf(".");
  const value = Number(dot < 0 ? text : text.slice(0, dot + 3));
  if (!Number.isFinite(value)) return 0;
  const cut = value;
  if (wealth !== null && cut > wealth) return wealth;
  return cut < TRANSFER_MIN_ISK ? TRANSFER_MIN_ISK : cut;
}

/** The reason as the window's field gives it: its first forty characters, < and > written as the entities. */
export function transferReason(typed: string): string {
  return typed.slice(0, TRANSFER_REASON_MAX).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** BaseSingleLineEditNumbers.GetValue320-331: reading does not clamp old text
 * after SetMaxValue changes only the maximum (125-127).
 */
export function transferValue(typed: string): number {
  const text = typed.trim().replace(/,/g, "");
  if (text === "") return TRANSFER_MIN_ISK;
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

/** Native InsertCharacters64-100 / Float.ValidateNewText: upper bound while
 * typing, decimal suffix cut as text, lower bound deferred until focus leaves.
 */
export function transferEditedAmount(typed: string, maximum: number, previous: string): string {
  let text = typed.replace(/[^-0-9e.]/g, "");
  if (text === "") return "";
  if (text === "." || text.split(".").length > 2) return previous;
  const dot = text.indexOf(".");
  if (dot >= 0) text = text.slice(0, dot + 3);
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return previous;
  return value > maximum ? String(maximum) : text;
}

/**
 * The wallet's Give ISK tab (giveIskPanel.py TransferISK, 101 to 112): GiveCash(selectedCharacterID, amount), with no
 * reason and no account key. Answers whether the server answered something, which is what the tab goes by (`if ret:`):
 * only then does it clear itself and say the transfer was made. Fails as the call fails.
 */
export async function giveIskFromWallet(act: Ask, toID: number, amount: number): Promise<boolean> {
  if (!Number.isSafeInteger(toID) || toID <= 0) throw new Error("That is no one to give ISK to.");
  const answered = await act("account", "GiveCash", [toID, amount]);
  return answered !== null && answered !== undefined && answered !== false && answered !== 0;
}

/** qtyConst.MIN_AMOUNT_TO_DISPLAY_FULL_TEXT: the least the amount's words are shown for. */
const READABLE_FROM = 10_000;
const UNIT_PREFIXES: readonly (string | null)[] = [null, "UI/Util/UnitPrefixThousand", "UI/Util/UnitPrefixMillion", "UI/Util/UnitPrefixBillion", "UI/Util/UnitPrefixTrillion"];
/** The labels the amount's words may need. */
export const READABLE_ISK_LABELS: readonly string[] = [...UNIT_PREFIXES.filter((label): label is string => label !== null), "UI/Common/ISK"];

/**
 * GetQtyText(amount, EDIT_INPUT_TYPE_ISK) (qtyTooltip/tooltip.py 19 to 30): under ten thousand nothing; else
 * eveformat.isk_readable, three significant figures over the thousands' unit word ("1.5 million ISK", number.py
 * _readable_value_and_log1k), with the client's "about" mark before it where the figures are not the amount. The
 * mark's character did not survive the client's decompiling (qtyConst.ABOUT_CHAR); "≈" stands for it. Null where
 * nothing is shown or a word is not to hand.
 */
export function readableIsk(amount: number, word: (label: string) => string | null): string | null {
  if (!(amount >= READABLE_FROM)) return null;
  const digits = 3 - 1 - Math.floor(Math.log10(Math.abs(amount)));
  const rounded = Math.round(amount * 10 ** digits) / 10 ** digits;
  const log1k = Math.max(0, Math.min(Math.floor(Math.log10(Math.abs(rounded)) / 3), 4));
  const value = rounded / 1000 ** log1k;
  let places = 0;
  for (let i = 0; i < 2; i += 1) {
    if (Math.round(value * 10 ** (2 - i)) % 10 > 0) {
      places = 2 - i;
      break;
    }
  }
  const prefix = UNIT_PREFIXES[log1k] ?? null;
  const unit = prefix === null ? "" : word(prefix);
  const isk = word("UI/Common/ISK");
  if (unit === null || isk === null) return null;
  const figures = value.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
  const text = `${figures}${unit ? ` ${unit}` : ""} ${isk}`;
  return Math.abs(rounded - amount) <= Math.abs(amount) * 1e-9 ? text : `≈ ${text}`;
}

/** Gives `amount` of the pilot's ISK to the character `toID`, with the reason. Fails as the call fails. */
export async function giveMoney(act: Ask, toID: number, amount: number, reason: string, toAccountKey: number | null = null): Promise<void> {
  if (!Number.isSafeInteger(toID) || toID <= 0) throw new Error("That is no one to give money to.");
  await act("account", "GiveCash", [toID, amount, reason], { toAccountKey });
}
