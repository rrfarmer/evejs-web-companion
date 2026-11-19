"use strict";

// Goal R7: the BFF Local + Corp chat routes, now carried over XMPP.
//
// GET /api/bridge/chat/:channel returns the held session's member roster +
// recent messages; POST /api/bridge/chat/:channel/send speaks in the room. The
// BFF holds the connection server-side; the browser addresses channels by name.
// Wire contract: docs/bridge-wire-contract.md.
//
// ⚠ THE TRANSPORT UNDER THESE ROUTES CHANGED AND THESE TESTS CHANGED WITH IT.
// They used to stub `gateway.readChat`/`sendChat`. EveJS v0.12.8 deleted those
// gateway routes outright (and marked browser-backed sessions as having left
// Local), so the BFF now joins the same XMPP stub the retail client joins. The
// fake below is that stub's wire behaviour, not a mock of our own client: the
// handshake stages, the `local`/`corp` room aliases resolved server-side, the
// self-presence that echoes the join's stanza id, and the MUC nick that IS the
// speaker's character id.

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { once } = require("events");

const { createApp } = require("../src/server");
// ⚠ THE REAL CLIENT, HANDED IN THE WAY THE REAL GATEWAY CLIENT HANDS IT IN.
// Chat hangs off the injected gateway client (`createChatSession`), so an app
// built with a fake gateway has no chat and opens no socket — which is what
// keeps every OTHER test in this suite from connecting to whatever is listening
// on a real 5222. This suite is the one that wants the genuine client, pointed
// at the fake stub below.
const { createXmppChatSession } = require("../src/evejsXmppChat");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTERS = [{ characterID: 7, accountID: 4, characterName: "Test Pilot" }];
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const HOME_SYSTEM_ID = 30000142;
const NEXT_SYSTEM_ID = 30000144;
const CORPORATION_ID = 98000000;

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = {
  host: process.env.EVEJS_XMPP_HOST,
  port: process.env.EVEJS_XMPP_PORT,
  domain: process.env.EVEJS_XMPP_DOMAIN,
  tls: process.env.EVEJS_XMPP_TLS,
};

/**
 * Point the BFF at the fake stub.
 *
 * ⚠ `EVEJS_XMPP_TLS=0` IS THE ONE THING THESE TESTS DO NOT EXERCISE. The real
 * chat edge is a TLS listener (`edge/chat/chatEdgeProcess.worker.js`), and the
 * client connects with `tls.connect` by default; the fake below is a plain TCP
 * server because the alternative is a certificate fixture to generate, ship and
 * keep unexpired for a switch that is one line of `connectChatSocket`.
 * Everything above the socket — the handshake, the aliases, attribution — is
 * byte-identical on both paths.
 */
function pointAtStub(port) {
  process.env.EVEJS_XMPP_HOST = "127.0.0.1";
  process.env.EVEJS_XMPP_PORT = String(port);
  process.env.EVEJS_XMPP_DOMAIN = "localhost";
  process.env.EVEJS_XMPP_TLS = "0";
}
const activeServers = new Set();
const activeStubs = new Set();

function attr(xml, name) {
  const match = new RegExp(`\\b${name}=['"]([^'"]*)['"]`, "i").exec(xml);
  return match ? match[1] : "";
}

/**
 * A stand-in for `services/chat/xmppStubServer.js`, reproducing exactly the
 * behaviour `src/evejsXmppChat.js` depends on:
 *
 *   • SASL PLAIN accepted without checking the secret; the JID's local part is
 *     the identity.
 *   • `local@conference.<domain>` / `corp@conference.<domain>` resolved to the
 *     real room server-side, so the client never names a room itself.
 *   • the self-presence answering a join carries that join's own stanza id and
 *     `<status code='110'/>`; every other presence carries a server id.
 *   • a groupchat message is delivered to occupants as
 *     `from='<room>/<speaker character id>'`.
 */
function startFakeStub(options = {}) {
  const state = {
    solarSystemID: options.solarSystemID || HOME_SYSTEM_ID,
    corporationID: options.corporationID || CORPORATION_ID,
    domain: "localhost",
    conference: "conference.localhost",
    clients: new Set(),
    joins: [],
    said: [],
  };

  function send(client, xml) {
    client.socket.write(xml);
  }

  function userData(characterID, name) {
    const info = JSON.stringify([characterID, name, 1373, true, null]);
    return (
      `<eve_user_data info='${info.replace(/'/g, "&apos;").replace(/"/g, "&quot;")}' ` +
      `corpid='${state.corporationID}' role='0' warfactionid='None' allianceid='None'/>`
    );
  }

  function presence(client, roomJid, characterID, name, extra = {}) {
    const id = extra.id || `evejs-${Date.now()}-${Math.random()}`;
    const status = extra.self ? "<status code='110'/>" : "";
    const type = extra.unavailable ? " type='unavailable'" : "";
    send(
      client,
      `<presence from='${roomJid}/${characterID}' to='${client.boundJid}' id='${id}'${type}>` +
        `${userData(characterID, name)}<x xmlns='http://jabber.org/protocol/muc#user'>` +
        `<item affiliation='member' role='participant' jid='${characterID}@${state.domain}'/>` +
        `${status}</x></presence>`,
    );
  }

  function roomJidFor(to) {
    const bare = String(to).split("/")[0];
    const alias = bare.split("@")[0];
    if (alias === "local") {
      return `local_${state.solarSystemID}@${state.conference}`;
    }
    if (alias === "corp") {
      return `corp_${state.corporationID}@${state.conference}`;
    }
    return bare;
  }

  function handleStanza(client, xml) {
    if (/^<presence\b/i.test(xml)) {
      if (/type=['"]unavailable['"]/i.test(xml)) {
        const roomJid = roomJidFor(attr(xml, "to"));
        client.rooms.delete(roomJid);
        return;
      }
      const to = attr(xml, "to");
      const roomJid = roomJidFor(to);
      const joinID = attr(xml, "id");
      client.rooms.add(roomJid);
      state.joins.push({ characterID: client.characterID, to, roomJid, joinID });
      // Self-presence first, carrying the join's own id — this is how the
      // client learns which room its alias resolved to.
      presence(client, roomJid, client.characterID, "Test Pilot", {
        id: joinID,
        self: true,
      });
      // Then the occupants already in the room.
      for (const occupant of options.occupants || []) {
        presence(client, roomJid, occupant.characterID, occupant.name);
      }
      return;
    }
    if (/^<message\b/i.test(xml)) {
      const roomJid = roomJidFor(attr(xml, "to"));
      const body = /<body>([\s\S]*?)<\/body>/i.exec(xml);
      const text = body ? body[1] : "";
      state.said.push({ characterID: client.characterID, roomJid, message: text });
      deliver(roomJid, client.characterID, text);
    }
  }

  function deliver(roomJid, characterID, text) {
    for (const client of state.clients) {
      if (!client.rooms.has(roomJid)) {
        continue;
      }
      send(
        client,
        `<message from='${roomJid}/${characterID}' to='${client.boundJid}' ` +
          `type='groupchat' id='m-${state.said.length}'><body>${text}</body></message>`,
      );
    }
  }

  const server = net.createServer((socket) => {
    const client = {
      socket,
      buffer: "",
      stage: "stream1",
      characterID: 0,
      boundJid: "",
      rooms: new Set(),
    };
    state.clients.add(client);
    socket.setEncoding("utf8");
    socket.on("close", () => state.clients.delete(client));
    socket.on("error", () => state.clients.delete(client));
    socket.on("data", (chunk) => {
      client.buffer += chunk;
      if (client.stage === "stream1" && client.buffer.includes("<stream:stream")) {
        client.buffer = "";
        client.stage = "auth";
        send(
          client,
          "<?xml version='1.0'?><stream:stream from='localhost' id='evejs' version='1.0' " +
            "xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>" +
            "<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'>" +
            "<mechanism>PLAIN</mechanism></mechanisms></stream:features>",
        );
        return;
      }
      if (client.stage === "auth" && client.buffer.includes("<auth")) {
        const payload = /<auth[^>]*>([\s\S]*?)<\/auth>/i.exec(client.buffer);
        const decoded = Buffer.from(payload ? payload[1] : "", "base64").toString("utf8");
        client.characterID = Number(decoded.split(" ")[1]) || 0;
        client.boundJid = `${client.characterID}@localhost/evejs-web-companion`;
        client.buffer = "";
        client.stage = "stream2";
        send(client, "<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>");
        return;
      }
      if (client.stage === "stream2" && client.buffer.includes("<stream:stream")) {
        client.buffer = "";
        client.stage = "bind";
        send(
          client,
          "<?xml version='1.0'?><stream:stream from='localhost' id='evejs2' version='1.0' " +
            "xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>" +
            "<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/>" +
            "<session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></stream:features>",
        );
        return;
      }
      if (client.stage === "bind" && client.buffer.includes("<bind")) {
        client.buffer = "";
        client.stage = "session";
        send(
          client,
          `<iq type='result' id='bind'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'>` +
            `<jid>${client.boundJid}</jid></bind></iq>`,
        );
        return;
      }
      if (client.stage === "session" && client.buffer.includes("<session")) {
        client.buffer = "";
        client.stage = "ready";
        send(client, "<iq type='result' id='sess'/>");
        return;
      }
      if (client.stage === "ready") {
        while (true) {
          const match = /<(message|presence|iq)\b[\s\S]*?(<\/\1>|\/>)/i.exec(client.buffer);
          if (!match) {
            break;
          }
          client.buffer = client.buffer.slice(match.index + match[0].length);
          handleStanza(client, match[0]);
        }
      }
    });
  });

  const stub = {
    state,
    async listen() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      // ⚠ THE WRAPPER, NOT THE RAW SERVER. Teardown has to go through the
      // close() below, which destroys the live chat connections first; handing
      // `afterEach` the bare `net.Server` would leave it waiting on a socket
      // that is open exactly as long as the character is online.
      activeStubs.add(stub);
      return server.address().port;
    },
    /** Another pilot speaks in the room this session is joined to. */
    say(roomPrefix, characterID, text) {
      const roomJid = `${roomPrefix}@${state.conference}`;
      deliver(roomJid, characterID, text);
    },
    /** The room's own voice: MOTD, notices, refusals. */
    admin(roomPrefix, payload) {
      const roomJid = `${roomPrefix}@${state.conference}`;
      for (const client of state.clients) {
        if (!client.rooms.has(roomJid)) {
          continue;
        }
        const body = JSON.stringify(payload)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
        send(
          client,
          `<message from='${roomJid}/admin' to='${client.boundJid}' type='groupchat' ` +
            `id='a-1'><body>${body}</body></message>`,
        );
      }
    },
    moveTo(solarSystemID) {
      state.solarSystemID = solarSystemID;
    },
    close() {
      activeStubs.delete(stub);
      // ⚠ THE SOCKETS FIRST. `net.Server#close` waits for every live connection
      // to end, and a held session's chat connection is open on purpose for as
      // long as the character is online — so closing the listener alone would
      // hang the teardown of every test that ever read chat.
      for (const client of state.clients) {
        client.socket.destroy();
      }
      return new Promise((resolve) => server.close(resolve));
    },
  };
  return stub;
}

function fakeAuth() {
  return {
    createSessionToken() {
      return COOKIE_TOKEN;
    },
    verifySessionToken(token) {
      return token === COOKIE_TOKEN
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: SESSION_ID }
        : null;
    },
    countConfiguredUsers() {
      return 1;
    },
  };
}

function fakeStore() {
  return {
    async getAccount(username) {
      return username === ACCOUNT.username ? { ...ACCOUNT } : null;
    },
    async getCharacterForAccount(accountID, characterID) {
      return Number(accountID) === ACCOUNT.accountID &&
        CHARACTERS.some((c) => c.characterID === Number(characterID))
        ? { ...CHARACTERS[0] }
        : null;
    },
    async releaseCharacterControl() {
      return { controlState: "offline" };
    },
  };
}

function fakeStaticData() {
  return { getStation() { return null; }, getTypeName(id) { return `Type ${id}`; } };
}

function fakeGateway(overrides = {}) {
  const flight = { solarSystemID: HOME_SYSTEM_ID, docked: false, inSpace: true, stationID: 0, shipID: 9001 };
  const gateway = {
    flight,
    async selectCharacter() {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: 4,
          characterID: 7,
          characterName: "Test Pilot",
          stationID: 60003760,
          structureID: null,
          solarSystemID: HOME_SYSTEM_ID,
          corporationID: CORPORATION_ID,
          shipID: 9001,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: 7 };
    },
    async readFlightStatus() {
      return { flight: { ...flight }, notifications: [] };
    },
    async readSpaceSnapshot() {
      return { space: { entities: [] }, notifications: [] };
    },
    createChatSession(options) {
      return createXmppChatSession(options);
    },
    ...overrides,
  };
  return gateway;
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: options.store || fakeStore(),
    eveGatewayClient: options.gateway || fakeGateway(),
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function apiRequest(baseUrl, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (options.authenticated !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

async function selectOnServer(baseUrl) {
  const selected = await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
  const ready = await apiRequest(baseUrl, "/api/bridge/drone-recovery/ready", {
    method: "POST", body: { checkID: selected.payload.droneRecoveryCheckID },
  });
  assert.equal(ready.response.status, 200, JSON.stringify(ready.payload));
}

/**
 * Stand up the stub, point the BFF at it, and get a character online.
 *
 * ⚠ THE ENV IS THE ONLY SEAM, ON PURPOSE. `src/evejsXmppChat.js` resolves its
 * host the way the running BFF does — `EVEJS_XMPP_HOST`, else the gateway URL's
 * own host — so a test that sets those two variables exercises the same
 * resolution production uses rather than an injected socket factory that
 * proves nothing about it.
 */
/**
 * Read a chat channel until it holds at least `count` messages, or give up.
 *
 * A line the stub says travels over a real socket before the BFF's XMPP client
 * sees it, so a read issued on the very next line can land first and find the
 * backlog empty. Bounded like the join wait below: a message that never comes
 * still fails the test, a message that is merely in flight does not.
 */
async function readChatUntil(baseUrl, path, count) {
  let last = await apiRequest(baseUrl, path);
  for (let attempt = 0; attempt < 100 && (last.payload?.chat?.messages?.length ?? 0) < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    last = await apiRequest(baseUrl, path);
  }
  return last;
}

async function startChatWorld(stubOptions = {}, serverOptions = {}) {
  const stub = startFakeStub(stubOptions);
  pointAtStub(await stub.listen());
  const gateway = serverOptions.gateway || fakeGateway();
  const { baseUrl } = await startTestServer({ ...serverOptions, gateway });
  await selectOnServer(baseUrl);
  return { stub, baseUrl, gateway };
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  for (const [key, value] of Object.entries({
    EVEJS_XMPP_HOST: ORIGINAL_ENV.host,
    EVEJS_XMPP_PORT: ORIGINAL_ENV.port,
    EVEJS_XMPP_DOMAIN: ORIGINAL_ENV.domain,
    EVEJS_XMPP_TLS: ORIGINAL_ENV.tls,
  })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }));
  }
  for (const stub of activeStubs) {
    closing.push(stub.close());
  }
  await Promise.all(closing);
});

test("bringing a character online joins Local AND Corp, with nothing reading chat", async () => {
  // ⚠ THE BEHAVIOUR A PILOT ACTUALLY HAS. The retail client joins both rooms in
  // the same breath as selecting a character; a character who is online but in
  // no room cannot be seen or addressed by anyone in the system. The first cut
  // of this connected lazily on the first chat READ, which meant an online
  // companion nobody was polling sat outside Local and Corp entirely.
  const stub = startFakeStub();
  pointAtStub(await stub.listen());
  const { baseUrl } = await startTestServer({ gateway: fakeGateway() });

  await selectOnServer(baseUrl);
  // The join is fire-and-forget, so that a chat server which is down can never
  // stop a character coming online.
  for (let attempt = 0; attempt < 100 && stub.state.joins.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const rooms = stub.state.joins.map((join) => join.roomJid).sort();
  assert.deepEqual(rooms, [
    `corp_${CORPORATION_ID}@conference.localhost`,
    `local_${HOME_SYSTEM_ID}@conference.localhost`,
  ]);
});

test("GET /api/bridge/chat/local joins the room the SERVER resolves and reports its roster", async () => {
  const { stub, baseUrl } = await startChatWorld({
    occupants: [{ characterID: 8, name: "Neighbor" }],
  });

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  // The client addressed the ALIAS; the room name came back from the server.
  // (Both rooms are joined at select, so this picks its own rather than
  // assuming which join happened to land last.)
  const join = stub.state.joins.find((entry) => entry.to.startsWith("local@"));
  assert.ok(join, "the local alias was joined");
  assert.equal(join.roomJid, `local_${HOME_SYSTEM_ID}@conference.localhost`);
  assert.equal(payload.chat.roomName, `local_${HOME_SYSTEM_ID}`);
  assert.equal(payload.chat.solarSystemID, HOME_SYSTEM_ID);
  const roster = payload.chat.roster.map((member) => member.characterID).sort();
  assert.deepEqual(roster, [7, 8]);
  assert.equal(payload.chat.roster.find((m) => m.characterID === 8).name, "Neighbor");
});

test("a line said in Local is attributed to the SENDER'S character id, from the MUC nick", async () => {
  const { stub, baseUrl } = await startChatWorld({
    occupants: [{ characterID: 8, name: "Neighbor" }],
  });
  await apiRequest(baseUrl, "/api/bridge/chat/local");

  stub.say(`local_${HOME_SYSTEM_ID}`, 8, "follow 1000 m");
  const { payload } = await readChatUntil(baseUrl, "/api/bridge/chat/local", 1);

  const said = payload.chat.messages.at(-1);
  assert.equal(said.message, "follow 1000 m");
  // ⚠ THE WHOLE POINT OF THE TRANSPORT. The companion's order gate keys on this
  // id, and it is filled in server-side from the speaker's own session — not
  // from anything in the message text.
  assert.equal(said.characterID, 8);
  assert.equal(said.characterName, "Neighbor");
  assert.ok(said.createdAtMs > 0);
});

test("the room's own voice (admin speak) arrives as a message, other admin commands do not", async () => {
  const { stub, baseUrl } = await startChatWorld();
  await apiRequest(baseUrl, "/api/bridge/chat/local");

  stub.admin(`local_${HOME_SYSTEM_ID}`, {
    cmd: "speak",
    charid: 1,
    messageText: "Welcome to Local.",
  });
  stub.admin(`local_${HOME_SYSTEM_ID}`, { cmd: "roster", charid: 1 });

  const { payload } = await readChatUntil(baseUrl, "/api/bridge/chat/local", 1);
  assert.equal(payload.chat.messages.length, 1);
  assert.equal(payload.chat.messages[0].message, "Welcome to Local.");
  assert.equal(payload.chat.messages[0].characterID, 1);
});

test("GET /api/bridge/chat/corp joins the corp room", async () => {
  const { stub, baseUrl } = await startChatWorld();
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/corp");
  assert.equal(response.status, 200);
  assert.equal(payload.chat.roomName, `corp_${CORPORATION_ID}`);
  assert.equal(payload.chat.corporationID, CORPORATION_ID);
  assert.equal(stub.state.joins.at(-1).roomJid, `corp_${CORPORATION_ID}@conference.localhost`);
});

test("Local and Corp joined together each resolve to their own room", async () => {
  // ⚠ THE CASE THAT BREAKS A CLIENT THAT CORRELATES JOINS BY ANYTHING BUT THE
  // STANZA ID: two aliases outstanding, two self-presences, and room names the
  // client is deliberately unable to predict.
  const { baseUrl } = await startChatWorld();
  const [local, corp] = await Promise.all([
    apiRequest(baseUrl, "/api/bridge/chat/local"),
    apiRequest(baseUrl, "/api/bridge/chat/corp"),
  ]);
  assert.equal(local.payload.chat.roomName, `local_${HOME_SYSTEM_ID}`);
  assert.equal(corp.payload.chat.roomName, `corp_${CORPORATION_ID}`);
});

test("POST /api/bridge/chat/local/send speaks in the room and the echo comes back as a message", async () => {
  const { stub, baseUrl } = await startChatWorld();

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/local/send", {
    method: "POST",
    body: { message: "hello local" },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.chat.sent, true);
  assert.equal(payload.chat.entry.message, "hello local");

  const said = stub.state.said.at(-1);
  assert.equal(said.message, "hello local");
  assert.equal(said.characterID, 7);
  assert.equal(said.roomJid, `local_${HOME_SYSTEM_ID}@conference.localhost`);

  const after = await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.equal(after.payload.chat.messages.at(-1).message, "hello local");
  assert.equal(after.payload.chat.messages.at(-1).characterID, 7);
});

test("POST /api/bridge/chat/corp/send speaks in Corp", async () => {
  const { stub, baseUrl } = await startChatWorld();
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/corp/send", {
    method: "POST",
    body: { message: "corp broadcast" },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.chat.channel, "corp");
  assert.equal(stub.state.said.at(-1).roomJid, `corp_${CORPORATION_ID}@conference.localhost`);
});

test("a jump re-joins Local, because retail's own auto-move never fires for this session", async () => {
  // `chatHub.moveLocalSession` rides on `sendSessionChange`, which is a capture
  // stub for a browser-backed session. Without this the companion would sit in
  // its old system's Local for the rest of the run.
  const gateway = fakeGateway();
  const { stub, baseUrl } = await startChatWorld({}, { gateway });
  await apiRequest(baseUrl, "/api/bridge/chat/local");
  stub.say(`local_${HOME_SYSTEM_ID}`, 8, "stay here");

  // The ship jumps: the world moves, and the held session learns about it from
  // the flight-status read every client already makes.
  gateway.flight.solarSystemID = NEXT_SYSTEM_ID;
  stub.moveTo(NEXT_SYSTEM_ID);
  await apiRequest(baseUrl, "/api/bridge/flight/status");

  const { payload } = await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.equal(payload.chat.roomName, `local_${NEXT_SYSTEM_ID}`);
  assert.equal(payload.chat.solarSystemID, NEXT_SYSTEM_ID);
  // The old system's Local is not this pilot's chat any more.
  assert.deepEqual(payload.chat.messages, []);
  const leaves = stub.state.joins.filter((join) => join.roomJid.includes(String(NEXT_SYSTEM_ID)));
  assert.equal(leaves.length, 1);
});

test("a chat server that is not there FAILS the read rather than answering 'nobody said anything'", async () => {
  // ⚠ THE REGRESSION THIS WHOLE CHANGE EXISTS FOR. The deleted gateway routes
  // answered 404, `flow.ts` swallowed it, and an empty message list meant both
  // "silence" and "deaf" for two weeks. An unreachable chat server must be
  // loud.
  // Port 1 is reserved and never listening.
  pointAtStub(1);
  const { baseUrl } = await startTestServer({ gateway: fakeGateway() });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.equal(response.status, 502);
  assert.match(payload.error, /^CHAT_TRANSPORT_/);

  // ⚠ AND THE HELD SESSION SURVIVES IT. A chat server that is down says nothing
  // about whether the character is online, so this must not log the pilot out
  // the way a lost bridge session does.
  const after = await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.notEqual(after.payload.error, "NO_LIVE_SESSION");
});

// xmppchatsvc.GetWindowNameForGroup (895-907) and SESSION_CHANGE_CATEGORIES
// include alliance/fleet/faction. Those are native channel keys, not unknown input.
test("an unknown channel is rejected (400 INVALID_CHANNEL)", async () => {
  const { baseUrl } = await startChatWorld();
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/unknown");
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_CHANNEL");
});

test("an empty message is rejected (400 EMPTY_MESSAGE)", async () => {
  const { baseUrl } = await startChatWorld();
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/local/send", {
    method: "POST",
    body: { message: "   " },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "EMPTY_MESSAGE");
});

test("chat routes require a live session (409 NO_LIVE_SESSION with no character online)", async () => {
  const { baseUrl } = await startTestServer();
  const read = await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.equal(read.response.status, 409);
  assert.equal(read.payload.error, "NO_LIVE_SESSION");

  const send = await apiRequest(baseUrl, "/api/bridge/chat/local/send", {
    method: "POST",
    body: { message: "hi" },
  });
  assert.equal(send.response.status, 409);
  assert.equal(send.payload.error, "NO_LIVE_SESSION");
});

test("releasing the character closes the chat connection, so it leaves Local", async () => {
  const { stub, baseUrl } = await startChatWorld();
  await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.equal(stub.state.clients.size, 1);

  await apiRequest(baseUrl, "/api/bridge/release", { method: "POST", body: {} });
  // The socket close is what drops the pilot from the room server-side.
  for (let attempt = 0; attempt < 50 && stub.state.clients.size > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(stub.state.clients.size, 0);
});

test("delayed Local takes the destination even when its presence beats the session change", async (t) => {
  const updates = [];
  const chat = createXmppChatSession({ characterID: 7, login: {}, onLocalChange: (value) => updates.push(value) });
  t.after(() => chat.close());
  const delayed = "wormhole_31000488";
  const immediate = `local_${HOME_SYSTEM_ID}`;
  const presence = (room, id) => `<presence from='${room}@conference.localhost/${id}'/>`;
  chat.onSessionChanged({ solarsystemid2: [null, HOME_SYSTEM_ID] });
  chat.ready = true;
  chat.write = () => {};
  chat.onPresence(presence(immediate, 7));
  chat.onPresence(presence(immediate, 8));
  chat.onPresence(presence(delayed, 7));
  assert.equal(chat.snapshot("local").roomName, immediate);
  assert.equal(chat.snapshot("local").roster.length, 2);

  chat.onSessionChanged({ solarsystemid2: [HOME_SYSTEM_ID, 31000488] });
  chat.onPresence(presence(immediate, 8));
  chat.onPresence(presence(delayed, 8));
  await Promise.resolve();
  assert.equal(updates.at(-1).roomName, delayed);
  assert.equal(updates.at(-1).solarSystemID, 31000488);
  assert.deepEqual(updates.at(-1).roster, []);

  chat.onMessage(`<message from='${delayed}@conference.localhost/8'><body>hello</body></message>`);
  await chat.linesWork;
  assert.deepEqual(updates.at(-1).roster.map((member) => member.characterID), [8]);
  chat.keepLine(immediate, { characterID: 9, message: "old room", createdAtMs: Date.now() });
  chat.keepLine(delayed, { characterID: 10, message: "expired speaker", createdAtMs: Date.now() - 900_001 });
  assert.deepEqual(chat.snapshot("local").roster.map((member) => member.characterID), [8]);
  assert.ok(chat.snapshot("local").messages.every((line) => line.message !== "old room"));
});
