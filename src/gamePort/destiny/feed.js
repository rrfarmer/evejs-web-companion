"use strict";

// The Destiny feed: what a pilot's ballpark is told by the server, passed on to a browser that runs
// its own Park (the three.js play page, docs/threejs-play-plan.md). Used by both sides: the BFF
// makes the items, the browser bundle reads them, and the same code feeds both parks.
//
// An item carries the notification's own marshal bytes, exactly as the server sent them: a
// notification packet's body is (?, blob), and the blob is a marshal stream of
// (1, method, args, kwargs) or (0, payload) (session.js readNotification). Passing the blob on
// untouched means the browser decodes the very bytes the BFF decoded, with the same decoder;
// re-encoding decoded values would not do (a number the server wrote as a float, but whole and
// past 32 bits, would come back an int64).

/** The notifications michelle hands its park (michelle.py, pilotSpace.js feed). */
const FEED_METHODS = new Set(["DoDestinyUpdate", "DoDestinyUpdates", "DoSimClockRebase", "OnDroneStateChange", "OnDroneActivityChange"]);

/** blue counts in 100 ns; the park's clock in milliseconds. */
const BLUE_TICKS_PER_MS = 10_000n;

/** The two readings of a DoSimClockRebase, as a difference in milliseconds; null if they are not two whole numbers. */
function rebaseDelta(times) {
  const pair = Array.isArray(times) ? times : times && Array.isArray(times.items) ? times.items : null;
  if (!pair || pair.length !== 2) return null;
  try {
    const [from, to] = pair.map((value) => BigInt(value));
    return Number(to - from) / Number(BLUE_TICKS_PER_MS);
  } catch {
    return null;
  }
}

const text = (value) => (value instanceof Uint8Array ? new TextDecoder().decode(value) : typeof value === "string" ? value : value && typeof value.value === "string" ? value.value : null);

function toBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64");
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A feed item for a notification readNotification() gave, or null when the park has no use for it. */
function feedItem(notification, atMs) {
  if (!notification || !FEED_METHODS.has(notification.method)) return null;
  const outer = notification.packet?.body?.[0];
  const blob = Array.isArray(outer) ? outer[1] : null;
  if (!(blob instanceof Uint8Array)) return null;
  return { atMs, method: notification.method, inner: toBase64(blob) };
}

/** The (method, args) of a feed item, decoded as readNotification() decodes them. */
function readFeedItem(item, marshalDecode) {
  const inner = marshalDecode(fromBase64(item.inner));
  if (!Array.isArray(inner)) return { method: item.method, args: null };
  if (inner[0]) return { method: text(inner[1]) ?? item.method, args: inner[2] ?? null };
  const payload = inner[1];
  return { method: item.method, args: Array.isArray(payload) && payload.length === 2 && payload[0] === 1 ? payload[1] : payload };
}

/**
 * Hand one notification to a park, as michelle does (pilotSpace.js feed). `guard(name, fn)` runs a
 * step and reports what it throws. Returns true when the notification was the ballpark's.
 */
function applyToPark(park, method, args, guard = (name, fn) => fn()) {
  if (method === "DoDestinyUpdate") {
    guard("DoDestinyUpdate", () => park.doDestinyUpdate(args[0], args[1], args[2]));
    return true;
  }
  if (method === "DoDestinyUpdates") {
    guard("DoDestinyUpdates", () => park.doDestinyUpdates(args[0]));
    return true;
  }
  if (method === "DoSimClockRebase") {
    const delta = rebaseDelta(Array.isArray(args) ? args[0] : null);
    if (delta !== null) park.adjustTimes(delta);
    return true;
  }
  // michelle.OnDroneStateChange and OnDroneActivityChange (265, 270): a drone's notice of its own goes to the
  // park, as the entry of a ballpark update does. The notice is the page's to hear as well.
  if (method === "OnDroneStateChange" && Array.isArray(args)) guard("OnDroneStateChange", () => park.OnDroneStateChange(...args));
  if (method === "OnDroneActivityChange" && Array.isArray(args)) guard("OnDroneActivityChange", () => park.OnDroneActivityChange(...args));
  return false;
}

module.exports = { FEED_METHODS, BLUE_TICKS_PER_MS, rebaseDelta, feedItem, readFeedItem, applyToPark };
