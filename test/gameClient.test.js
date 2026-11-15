"use strict";

// The short-visit game client, over a real socket.
//
// What it says on the wire is the session's business and is tested there
// (test/gamePortSession.test.js). These check the client's own job: open the
// connection, run the session over it, adapt the shapes, and let go cleanly.
// The server here replays the recording of a real eve.js server.

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { GameClient } = require("../src/gameClient");
const { frameSplitter, recordingSessionOptions: captureOptions } = require("../scripts/capture-game-frames");
const fixture = require("./fixtures/gamePortFrames.json");
// This recording was made on 3396210. New captures use the current default profile.
const recordingSessionOptions = () => ({ ...captureOptions(), client: {
  handshakeSecret: 170472, machoVersion: 496, version: 24.01,
  build: 3396210, codename: "V24.01", region: "ccp",
} });

const serverFrames = fixture.frames.filter((frame) => frame.from === "server").map((frame) => ({
  after: frame.afterClientFrames,
  bytes: Buffer.from(frame.hex, "hex"),
}));

const framed = (payload) => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
};

async function listener(context, onConnection) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

/** A server that replays the recording, writing each frame in two pieces. */
function replay(socket) {
  let received = 0;
  let next = 0;
  const flush = () => {
    while (next < serverFrames.length && serverFrames[next].after <= received) {
      const bytes = framed(serverFrames[next].bytes);
      next += 1;
      const cut = Math.min(3, bytes.length);
      socket.write(bytes.subarray(0, cut));
      socket.write(bytes.subarray(cut));
    }
  };
  socket.on("data", frameSplitter(() => {
    received += 1;
    flush();
  }));
  flush();
}

test("over a socket, the client logs in, selects, binds and calls the bound object", { timeout: 10_000 }, async (context) => {
  const port = await listener(context, replay);
  const client = new GameClient({ host: "127.0.0.1", port, sessionOptions: recordingSessionOptions() });
  context.after(() => client.close());

  await client.login(fixture.accountName);
  const selection = await client.call("charUnboundMgr", "GetCharacterSelectionData");
  assert.ok(Array.isArray(selection) && selection.length === 4);
  await client.call("charUnboundMgr", "SelectCharacterID", [fixture.characterID]);
  const stationID = client.session.attributes.stationid;
  assert.ok(Number(stationID) > 0, "the session change arrived with the answer");

  const office = await client.bind("invbroker", [stationID, 15]);
  assert.match(office, /^N=\d+:\d+$/, "bind answers the object's id, as the customs export expects");
  const hangar = await client.callBound(office, "GetInventory", [10004]);
  assert.equal(hangar.type, "substruct");
});

test("closing during a handshake the server never answers ends the login at once", { timeout: 3000 }, async (context) => {
  const port = await listener(context, () => {});
  const client = new GameClient({ host: "127.0.0.1", port });
  let outcome = null;
  const login = client.login("anyone").catch((error) => { outcome = error; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(outcome, null, "still waiting for the server's first frame");
  client.close();
  await login;
  assert.match(outcome?.message ?? "", /connection closed/i);
});

test("a call before login, or after close, is refused without touching the network", { timeout: 3000 }, async (context) => {
  let connections = 0;
  const port = await listener(context, () => { connections += 1; });
  const client = new GameClient({ host: "127.0.0.1", port });
  await assert.rejects(client.call("map", "Read"), /not logged in/);
  await assert.rejects(client.callBound("N=1:2", "Read"), /not logged in/);
  await assert.rejects(client.bind("invbroker", [1]), /not logged in/);
  client.close();
  await assert.rejects(client.call("map", "Read"), /not logged in/);
  assert.equal(connections, 0);
});

test("a server that is not there fails the login with the connect error", { timeout: 3000 }, async () => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await assert.rejects(new GameClient({ host: "127.0.0.1", port }).login("anyone"));
});
