import { parse, stringify } from "yaml";

export const CHAT_WORD_FILTERS_SETTING = "chatFilters";

export interface ChatWordFilters {
  readonly bannedWords: readonly string[];
  readonly highlightWords: readonly string[];
  readonly blinkOnHighlightWords: boolean;
}

export function readChatWordFilters(text: string | null): ChatWordFilters {
  let mapping: Record<string, unknown> | null = null;
  if (text) {
    try {
      const parsed: unknown = parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) mapping = parsed as Record<string, unknown>;
    } catch { /* an unreadable setting is treated as empty */ }
  }
  const words = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((word): word is string => typeof word === "string" && word.length > 0) : [];
  return {
    bannedWords: words(mapping?.bannedWords),
    highlightWords: words(mapping?.highlightWords),
    blinkOnHighlightWords: mapping?.blinkOnHighlightWords === true,
  };
}

export function writeChatWordFilters(filters: ChatWordFilters): string {
  return stringify(filters);
}

export function chatWordPattern(words: readonly string[], global = false): RegExp | null {
  const alternatives = words.filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return alternatives.length ? new RegExp(alternatives.join("|"), global ? "giu" : "iu") : null;
}
