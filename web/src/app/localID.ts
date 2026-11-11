const localPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let sequence = 0;

/**
 * Bookkeeping identity for local state; never use this for credentials. Browser
 * code takes every id from here rather than calling crypto.randomUUID itself
 * (localID.test.ts checks this).
 */
export function nextLocalID(): string {
  // randomUUID is only exposed in secure browser contexts. LAN HTTP pages
  // still need distinct ids, including two made in one millisecond.
  return globalThis.crypto?.randomUUID?.() ?? `local-${localPrefix}-${++sequence}`;
}
