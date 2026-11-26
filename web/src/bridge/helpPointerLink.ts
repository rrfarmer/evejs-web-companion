import { linkScheme } from "./showInfoLink.ts";

export function helpPointerUrl(name: string): string {
  return `helpPointer:${name}`;
}

export function parseHelpPointerUrl(url: string): string | null {
  if (linkScheme(url) !== "helppointer") return null;
  const name = url.slice(url.indexOf(":") + 1);
  return /^[\w.-]+$/.test(name) ? name : null;
}

export function helpPointerLinksFromDrop(payload: unknown): { url: string; text: string }[] {
  const links: { url: string; text: string }[] = [];
  for (const entry of Array.isArray(payload) ? payload : [payload]) {
    if (!entry || typeof entry.url !== "string" || !parseHelpPointerUrl(entry.url) || typeof entry.text !== "string") return [];
    links.push({ url: entry.url, text: entry.text });
  }
  return links;
}
