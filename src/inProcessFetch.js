"use strict";

// A fetch for whoever asks the BFF from inside the BFF's own process.
//
// The hosted bots (src/botHost.js) run the page's own flows in this process,
// and those flows ask the BFF with `fetch`. They did so over loopback HTTP: a
// connection from the process to itself for every request, and one held open
// for each bot's event stream. This is a function of `fetch`'s own shape that
// hands the request to the app where it is (`dispatchInProcess`,
// src/pilotSocket.js) and answers with a `Response` made of what the route
// answered. The flows cannot tell the difference and no route is changed. It
// is the plan's Phase 6a for the bots: the same operations, in process
// (docs/game-port-transport-plan.md).
//
// WHAT IS RUN IN PROCESS. A request to the BFF's own API (`/api/...`) at the
// BFF's own address (`baseUrl`), with a body that is text or absent. The event
// stream is run with `streamInProcess` and answered with a body that is read
// as the route writes it, which is what the hosted event source reads
// (web/src/app/hostedEventSource.ts).
//
// WHAT IS NOT. Anything else is handed to the fetch given, unchanged: another
// address, a path that is not the API's, a request made of a `Request`, a body
// that is not text.
//
// ONE ANSWER IS NOT THE SAME, and it is no route's. A path no route has is
// answered 404 both ways; over HTTP the body is the app's own last page, and in
// process it is the refusal `dispatchInProcess` gives for it
// (`{ ok: false, error: "NOT_FOUND" }`), as on the tab's socket.
//
// A REQUEST GIVEN UP ON (its signal aborted) rejects with the signal's reason,
// as a fetch does. The route can observe its operation signal: native owner
// priming and scalar aggression reads use it to release their caller's locks.
// An event stream given up on is let go: its request
// is told it has closed, which is what its route waits for.

const { EVENTS_PATH, dispatchInProcess, streamInProcess } = require("./pilotSocket");

const REACHES = new Set(["inprocess", "loopback"]);

/**
 * How the hosted bots reach the BFF: `inprocess` (the default), or `loopback`
 * for HTTP to the BFF's own port as it was, which is the way back.
 *
 *   EVEJS_HOSTED_BOT_REACH    inprocess (the default) or loopback
 */
function hostedBotReach(env = process.env) {
  const said = String(env.EVEJS_HOSTED_BOT_REACH || "").trim().toLowerCase();
  if (said === "") return "inprocess";
  if (!REACHES.has(said)) {
    throw new Error(`EVEJS_HOSTED_BOT_REACH must be "inprocess" or "loopback", not "${env.EVEJS_HOSTED_BOT_REACH}".`);
  }
  return said;
}

/** Statuses a `Response` may not be given a body for. */
const NO_BODY = new Set([204, 205, 304]);

/** A route's headers as a `Response` takes them. */
function headersOf(given) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(given || {})) {
    if (Array.isArray(value)) for (const each of value) headers.append(name, String(each));
    else if (value !== undefined && value !== null) headers.set(name, String(value));
  }
  return headers;
}

function responseOf(status, headers, body) {
  return new Response(NO_BODY.has(status) || body.length === 0 ? null : body, { status, headers: headersOf(headers) });
}

/**
 *   createInProcessFetch(app, { baseUrl, fetch }) -> fetch
 *
 * `baseUrl` is the address the askers know the BFF by; `fetch` is where
 * everything that is not the BFF's own API goes (the world's, unless given).
 */
function createInProcessFetch(app, options = {}) {
  const origin = new URL(options.baseUrl).origin;
  const elsewhere = typeof options.fetch === "function" ? options.fetch : (input, init) => globalThis.fetch(input, init);

  function answered(request, signal) {
    return new Promise((resolve, reject) => {
      // (Whichever comes first is what the asker is told: a promise is settled once.)
      const onAbort = () => reject(signal.reason);
      const heard = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      dispatchInProcess(app, { ...request, signal })
        .then((answer) => responseOf(answer.status, answer.headers, answer.body))
        .then(
          (response) => {
            heard();
            resolve(response);
          },
          // Thrown outside of every handler, or an answer no Response can be made of: over HTTP that is a
          // connection that gave no answer. It must not be a request that is never answered at all.
          (error) => {
            heard();
            reject(new TypeError("fetch failed", { cause: error }));
          },
        );
    });
  }

  function streamed(request, signal) {
    return new Promise((resolve, reject) => {
      /** The answer's body, once the route has answered 200: what it writes from then on is read from it. */
      let body = null;
      let status = 0;
      let headers = {};
      const refusal = [];
      const handle = { close() {} };
      const onAbort = () => {
        handle.close();
        if (body) {
          try { body.error(signal.reason); } catch { /* already ended */ }
        } else {
          reject(signal.reason);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      handle.close = streamInProcess(app, request, {
        onHead(code, given) {
          status = code;
          headers = given;
          if (code !== 200) return;
          const stream = new ReadableStream({
            start(controller) { body = controller; },
            // Whoever was reading has stopped: the route is told its listener has gone.
            cancel() { handle.close(); },
          });
          resolve(new Response(stream, { status: 200, headers: headersOf(given) }));
        },
        onChunk(buffer) {
          if (body) body.enqueue(new Uint8Array(buffer));
          else refusal.push(buffer);
        },
        onEnd() {
          signal?.removeEventListener("abort", onAbort);
          if (body) {
            try { body.close(); } catch { /* given up on already */ }
            return;
          }
          try {
            resolve(responseOf(status, headers, Buffer.concat(refusal)));
          } catch (error) {
            reject(new TypeError("fetch failed", { cause: error }));
          }
        },
      }).close;
    });
  }

  return function inProcessFetch(input, init = {}) {
    let url = null;
    if (typeof input === "string" || input instanceof URL) {
      try {
        url = new URL(input, options.baseUrl);
      } catch {
        url = null;
      }
    }
    const body = init.body;
    const text = typeof body === "string";
    if (url === null || url.origin !== origin || !url.pathname.startsWith("/api/") || (body !== undefined && body !== null && !text)) {
      return elsewhere(input, init);
    }
    const signal = init.signal || null;
    if (signal && signal.aborted) return Promise.reject(signal.reason);
    const headers = {};
    new Headers(init.headers || {}).forEach((value, name) => { headers[name] = value; });
    // A fetch says what a text body is when the asker has not: so does this, and the app reads it as it would.
    if (text && headers["content-type"] === undefined) headers["content-type"] = "text/plain;charset=UTF-8";
    const request = { method: init.method, path: `${url.pathname}${url.search}`, headers, rawBody: text ? body : undefined, remoteAddress: "127.0.0.1" };
    return url.pathname === EVENTS_PATH ? streamed(request, signal) : answered(request, signal);
  };
}

module.exports = { createInProcessFetch, hostedBotReach };
