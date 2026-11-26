// A mail's body as the client writes it and shows it.
//
// The client's compose window is its rich editor (evemail.py 1794: EditPlainText, showattributepanel=1), and what it
// sends is the editor's value in the editor's markup (carbonui/control/editPlainText.py, GetValue, 423 to 566): the
// text typed with &, < and > written as entities (Decode, 320 to 321), each line after the first begun with <br>, a
// tag at each change of bold, italic, underline, link, size or colour, and nothing at all where there is nothing but
// tags. A tab typed is four spaces (InsertText, 258). What is typed in the page's plain box is the editor's text with
// nothing styled, and is sent so.
//
// The client's reading pane is the same editor, read only (evemail.py 258), and shows a body by its markup
// (InsertText, 245 to 302): a heading made a bold line (249 to 257); lines split at <br>, <br/>, <br /> or a newline
// (LINESPLIT, 30); a line holding both a < and a > read piece by piece, each piece up to a > being text up to its
// first < (its entities read back, Encode, 317 to 318) and a tag after it (ParseTag, 323 onward), and any other line
// all text. The page shows the same lines, and in them the text bold, italic, underlined or a link as the tags say;
// a size or colour it leaves to its own type, and any other tag it passes over, as the client's stacks of tags would
// to no visible end.

import { parseHelpPointerUrl } from "./helpPointerLink.ts";

/** One run of a line: its text, and how it is marked. */
export interface MailRun {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  /** The link it is part of (a href= or url=), or null. */
  readonly link: string | null;
}

/** LINESPLIT (editPlainText.py 30). */
const LINE_SPLIT = /<br>|<br \/>|<br\/>|\r\n|\n/;

/** Decode (editPlainText.py 320 to 321): the characters the markup gives meaning to, as entities. */
function decode(text: string): string {
  return text.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
}

/** Encode (editPlainText.py 317 to 318): the entities read back, in the client's order. */
function encode(text: string): string {
  return text.split("&gt;").join(">").split("&lt;").join("<").split("&amp;").join("&").split("&GT;").join(">").split("&LT;").join("<");
}

/** StripTags: the text of markup without its tags. */
function stripTags(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

/**
 * What the client's editor sends of text typed into it with nothing styled (GetValue): each line's characters
 * written as entities, a tab four spaces, the lines joined by <br>; nothing where there is nothing but tags.
 */
export function mailMarkupOfTyped(typed: string): string {
  const markup = encodeTyped(typed);
  return stripTags(markup) === "" ? "" : markup;
}

function encodeTyped(text: string): string {
  return decode(text.replace(/\t/g, "    ")).replace(/\r\n|\n/g, "<br>");
}

/** The label is stored in the compose textarea at these offsets. */
export interface MailDraftLink {
  readonly start: number;
  readonly end: number;
  readonly url: string;
}

export function isMailItemLink(url: string): boolean {
  return /^showinfo:[1-9]\d*(?:\/\/\d+)*$/i.test(url) &&
    url.slice("showinfo:".length).split("//").every(id => Number.isSafeInteger(Number(id)));
}

export function isMailDraftLink(url: string): boolean {
  return isMailItemLink(url) || parseHelpPointerUrl(url) !== null;
}

/** Retain complete links on either side of one textarea edit. Editing inside a label makes it plain text. */
export function updateMailDraftLinks(before: string, after: string, links: readonly MailDraftLink[]): MailDraftLink[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const shift = newEnd - oldEnd;
  return links.flatMap(link => {
    if (link.end <= start) return [link];
    if (link.start < oldEnd) return [];
    return [{ ...link, start: link.start + shift, end: link.end + shift }];
  });
}

/** Compose uses plain text and validated item-link ranges, so typed markup is always escaped. */
export function mailMarkupOfDraft(body: string, links: readonly MailDraftLink[]): string {
  if (!links.length) return mailMarkupOfTyped(body);
  let result = "";
  let at = 0;
  for (const { start, end, url } of links) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < at || end <= start ||
        end > body.length || !isMailDraftLink(url)) continue;
    result += encodeTyped(body.slice(at, start));
    result += `<a href="${url}">${encodeTyped(body.slice(start, end))}</a>`;
    at = end;
  }
  return result + encodeTyped(body.slice(at));
}

/** The marks a body's tags have set so far: counted, as the client's stacks are pushed and popped. */
interface Marks {
  bold: number;
  italic: number;
  underline: number;
  readonly links: string[];
}

/** ParseTag (editPlainText.py 323 onward), for the marks the page shows. */
function parseTag(raw: string, marks: Marks): void {
  let tag = raw.replace(/"/g, "").replace(/'/g, "").toLowerCase();
  if (tag.startsWith("font ") || tag === "/font") {
    return;
  }
  tag = tag.replace("a href=", "url=").replace("/a", "/url").replace("bold", "b").replace("/bold", "/b").replace("italic", "i").replace("/italic", "/i");
  const closing = tag.startsWith("/");
  const name = closing ? tag.slice(1) : tag.includes("=") ? tag.split("=")[0]! : tag;
  const step = closing ? -1 : 1;
  if (name === "b") marks.bold = Math.max(0, marks.bold + step);
  else if (name === "i") marks.italic = Math.max(0, marks.italic + step);
  else if (name === "u") marks.underline = Math.max(0, marks.underline + step);
  else if (name === "url") {
    if (closing) marks.links.pop();
    else marks.links.push(raw.replace(/"/g, "").replace(/'/g, "").replace(/^\s*(a\s+href|url)\s*=\s*/i, ""));
  }
}

/** A body's markup as the client's reading pane shows it: its lines, each of runs of text as marked. */
export function mailBodyLines(markup: string | null): readonly (readonly MailRun[])[] {
  if (markup === null || markup === "") {
    return [];
  }
  let source = markup;
  if (source.includes("<h")) {
    for (let level = 1; level <= 6; level += 1) {
      source = source.split(`<h${level}>`).join("<br><b>").split(`</h${level}>`).join("</b><br>");
    }
  }
  source = source.replace(/\t/g, "    ");
  const marks: Marks = { bold: 0, italic: 0, underline: 0, links: [] };
  const run = (text: string): MailRun => ({
    text,
    bold: marks.bold > 0,
    italic: marks.italic > 0,
    underline: marks.underline > 0,
    link: marks.links.at(-1) ?? null,
  });
  return source.split(LINE_SPLIT).map((line) => {
    const runs: MailRun[] = [];
    if (line.includes("<") && line.includes(">")) {
      for (const piece of line.split(">")) {
        const at = piece.indexOf("<");
        const text = encode(at < 0 ? piece : piece.slice(0, at));
        if (text !== "") runs.push(run(text));
        const tag = at < 0 ? "" : piece.slice(at + 1);
        if (tag !== "") parseTag(tag, marks);
      }
    } else if (line !== "") {
      runs.push(run(encode(line)));
    }
    return runs;
  });
}

// --- The message quoted in a reply or a forward -------------------------------
//
// mailSvc.GetReplyMessage (the client's, for both its reply and its forward): after two empty lines, a line of
// dashes, the message's subject, who it was from (a link to the sender's information; an automated mail's sender in
// bold), when it was sent (FmtDate 'ls'), who it went to (GetReceiverText, format 0: the corporation or alliance it
// went to, and each pilot a link, by name, each followed by a comma and two spaces), an empty line, and its body; the
// whole cut at a line break before nine tenths of a body's room, with "..." after.

/** The words of the quote, by their labels (mailSvc.GetReplyMessage; GetReplyWnd's "Re:"). */
export const MAIL_QUOTE_LABELS = {
  from: "UI/Mail/From",
  sent: "UI/Mail/Sent",
  to: "UI/Mail/To",
  re: "UI/Mail/GenericInboxRe",
  boldName: "UI/Map/StarMap/lblBoldName",
} as const;

/** What a quote is made of: the message, its people by name, its date in words, and its body's markup. */
export interface MailQuoteSource {
  readonly subject: string;
  readonly senderID: number;
  readonly senderName: string;
  /** An automated mail (statusMask's automated bit): its sender is named in bold, with no link. */
  readonly automated: boolean;
  readonly sentText: string;
  /** The corporation or alliance it went to, by name, or null. */
  readonly corporationName: string | null;
  readonly recipients: readonly { readonly id: number; readonly name: string }[];
  readonly body: string;
}

/** The words filled: "From", "Sent", "To", and a name in bold. */
export interface MailQuoteWords {
  readonly from: string;
  readonly sent: string;
  readonly to: string;
  readonly bold: (name: string) => string;
}

/** A pilot's information, as the client links it (showinfo:1377//id). */
function infoLink(id: number, name: string): string {
  return `<a href="showinfo:1377//${id}">${name}</a>`;
}

/** mailSvc.GetReplyMessage: the message quoted, in the mail's markup, cut to its room. */
export function mailQuoteMarkup(source: MailQuoteSource, words: MailQuoteWords, maxBody: number): string {
  let receivers = source.corporationName ? `${source.corporationName}, ` : "";
  for (const person of [...source.recipients].sort((left, right) => (left.name.toLowerCase() < right.name.toLowerCase() ? -1 : left.name.toLowerCase() > right.name.toLowerCase() ? 1 : 0))) {
    receivers += `${infoLink(person.id, person.name)},  `;
  }
  const sender = source.automated ? words.bold(source.senderName) : infoLink(source.senderID, source.senderName);
  let text = `<br><br>--------------------------------<br>${source.subject}<br>${words.from}: ${sender}<br>${words.sent}: ${source.sentText}<br>${words.to}: ${receivers}<br><br>${source.body}`;
  const room = maxBody * 0.9;
  if (text.length > room) {
    while (text.length > room) {
      const at = text.lastIndexOf("<br>");
      if (at >= Math.floor(room * 0.7)) {
        text = text.slice(0, at);
      } else {
        text = text.slice(0, Math.floor(text.length * 0.9));
      }
    }
    text += "<br>...";
  }
  return text;
}
