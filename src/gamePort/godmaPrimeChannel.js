"use strict";

/** StateManager.Prime2399-2419 and its three notice receivers1307/1342/1441.
 * This is the receive/send boundary only, not a general event dispatcher.
 */
function createGodmaPrimeChannel() {
  let priming = false;
  // null admits notices immediately. A failed Prime leaves false until the
  // next begin: the old channel's notices would never be applied.
  let channel = null;
  function cancel(receivers = channel) {
    if (!receivers || channel !== receivers) return;
    channel = false;
    priming = false;
    for (const resume of receivers) resume(false);
    receivers.length = 0;
  }
  function begin() {
    cancel();
    priming = true;
    channel = [];
    return channel;
  }
  function receive(work) {
    if (channel === null) return work();
    if (channel === false) return false;
    return new Promise(resolve => channel.push(resolve)).then(released => released && work());
  }
  async function release(receivers) {
    if (channel !== receivers) return;
    priming = false;
    // The installed Stackless channel prefers the receiver (-1). Give each
    // receiver its turn before the next send, without awaiting its work.
    while (channel === receivers && receivers.length) {
      receivers.shift()(true);
      await Promise.resolve();
    }
    if (channel === receivers) channel = null;
  }
  return {
    begin, cancel, receive, release,
    state: () => ({ priming, channel: Boolean(channel), receivers: channel?.length ?? 0 }),
  };
}

module.exports = { createGodmaPrimeChannel };
