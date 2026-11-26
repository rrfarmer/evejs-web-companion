// A mail sent by the page itself (the plan's Phase 6b).
//
// Until 2026-10-14 this was one route of the BFF (POST /api/bridge/mail/send), which held the message to its own
// limits, made the call, and read the sender's mailbox again (SyncMail) for the message. The client:
//
//   the window    the compose window's Send (evemail.py, ClickSend, 2245 to 2290): a recipient at least, else the
//                 pilot is told there is none; no more than mailMaxRecipients (50, appConst.py 1782) — the window
//                 refuses the 51st as it is added (1909 to 1910); a subject, else NoSubject; a subject no longer
//                 than mailMaxSubjectSize (150, 1784), and a body no longer than mailMaxBodySize (8000, 1785), the
//                 two fields' own lengths (1794, 1838)
//   the call      mailSvc.SendMail (959 to 993):
//                   eveMisc.CSPAChargedAction('CSPAMailCheck', self.mailMgr, 'SendMail', toCharacterIDs, toListID,
//                                             toCorpOrAllianceID, title, body, isReplyTo, isForwardedFrom)
//                 the recipients a list; the mailing list where the window has one, which must be one the pilot has
//                 joined (961 to 964, EveMailCanOnlySendToOwnMailinglists; the window keeps no other, 2198 to
//                 2201); the pilot's own corporation or alliance where the window has one (its toCorpAlliance's first, checked
//                 again by ValidateCorpOrAlliance, 2272 to 2277), an int, else None; and the message it answers or
//                 forwards, 0 for none (the defaults, 959). Answered the message's number, or None,
//                 where the client does nothing more; with a number it keeps the body and the header itself
//                 (OnMailSent) and reads nothing again.
//
// THE CONTACT COST (eveMisc.CSPAChargedAction, 89 to 101): a server that charges for mail to a pilot raises
// ContactCostNotApproved with the cost, the client asks the pilot to pay, and on yes sends again with
// approvedCost. This server raises none (services/mail, read 2026-10-14), and the page does not ask: such a refusal
// comes to the pilot as the server's word.
//
// No Tranquility recording has a mail sent.

import type { Ask } from "./ask.ts";
import { MAIL_MAX_BODY, MAIL_MAX_RECIPIENTS, MAIL_MAX_TITLE } from "./mail.ts";
import { mailMarkupOfDraft, type MailDraftLink } from "./mailMarkup.ts";
import { unwrapLong, type JsonValue } from "./wire.ts";

/** A plain message from the compose window: to pilots, a mailing list, or both, with a subject and a body. */
export interface MailToSend {
  readonly toCharacterIDs: readonly number[];
  /** The mailing list it goes to, one the pilot has joined (the compose window's toListID); none for pilots only. */
  readonly toListID?: number | null;
  /** The pilot's own corporation or alliance it goes to (the compose window's toCorpAlliance, its first); none for neither. */
  readonly toCorpOrAllianceID?: number | null;
  readonly title: string;
  readonly body: string;
  readonly bodyLinks?: readonly MailDraftLink[];
  /** The message quoted, in the mail's markup, sent after what is typed (mailSvc.GetReplyMessage); none for a new one. */
  readonly quote?: string;
  /** The message answered, or forwarded; none (0) for a new one. */
  readonly isReplyTo?: number;
  readonly isForwardedFrom?: number;
}

/**
 * Sends the message as the compose window's Send does, refused before the call where the window refuses it.
 * Answers the message's number, or null where the server answered None (it says nothing of why). Fails as the call
 * fails.
 */
export async function sendMail(act: Ask, mail: MailToSend): Promise<number | null> {
  const recipients = [...new Set(mail.toCharacterIDs.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const toListID = typeof mail.toListID === "number" && Number.isSafeInteger(mail.toListID) && mail.toListID > 0 ? mail.toListID : null;
  const toCorpOrAllianceID = typeof mail.toCorpOrAllianceID === "number" && Number.isSafeInteger(mail.toCorpOrAllianceID) && mail.toCorpOrAllianceID > 0
    ? mail.toCorpOrAllianceID
    : null;
  if (recipients.length === 0 && toListID === null && toCorpOrAllianceID === null) throw Object.assign(new Error("Choose someone to send this to first."), { code: "MAIL_NO_RECIPIENT" });
  if (recipients.length > MAIL_MAX_RECIPIENTS) {
    throw Object.assign(new Error(`You can send to at most ${MAIL_MAX_RECIPIENTS} people at once.`), { code: "MAIL_TOO_MANY_RECIPIENTS" });
  }
  if (mail.title.trim() === "") throw Object.assign(new Error("Give your message a subject first."), { code: "MAIL_NO_SUBJECT" });
  if (mail.title.length > MAIL_MAX_TITLE || mail.body.length > MAIL_MAX_BODY) {
    throw Object.assign(new Error("That message is longer than the mail system accepts."), { code: "MAIL_TOO_LONG" });
  }
  const body = mailMarkupOfDraft(mail.body, mail.bodyLinks ?? []) + (mail.quote ?? "");
  if (mail.bodyLinks?.length && body.length > MAIL_MAX_BODY) {
    throw Object.assign(new Error("That message is longer than the mail system accepts."), { code: "MAIL_TOO_LONG" });
  }
  const answer: JsonValue = await act("mailMgr", "SendMail", [
    // The body as the client's editor sends what is typed in it (bridge/mailMarkup.ts), the quote below it.
    recipients, toListID, toCorpOrAllianceID, mail.title, body, mail.isReplyTo ?? 0, mail.isForwardedFrom ?? 0,
  ]);
  const messageID = Number(unwrapLong(answer) ?? Number.NaN);
  return Number.isSafeInteger(messageID) && messageID > 0 ? messageID : null;
}
