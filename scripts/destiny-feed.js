#!/usr/bin/env node
"use strict";

// A recording of a real server (test/fixtures/destiny*.json, made by scripts/record-*.js) as a
// Destiny feed for the three.js play page, plus where the BFF's own Park puts every ball at every
// tick when it is fed those same bytes. The browser's Park plays the feed and must agree to the
// last bit (web/park-harness.html, spike S2 of docs/threejs-play-plan.md).
//
//   node scripts/destiny-feed.js [fixture name, default destinyWarp] [--out _local/play-feed]

const fs = require("node:fs");
const path = require("node:path");
const { marshalDecode } = require("../src/gameProtocol/marshal");
const { Park } = require("../src/gamePort/destiny/park");
const { Ballpark } = require("../src/gamePort/destiny/ballpark");
const { feedItem, readFeedItem, applyToPark } = require("../src/gamePort/destiny/feed");
const { notifications } = require("../test/helpers/destinyRecording");

/**
 * Play a feed through a park the way the harness does: a tick for each whole second of the
 * recording's clock that has gone by before an item arrives, then the item; at the end, up to
 * three more ticks while the park still holds updates stamped ahead of it.
 */
function playFeed(items, { decode, makePark, onTick }) {
  const park = makePark();
  const failures = [];
  const guard = (name, fn) => { try { fn(); } catch (error) { failures.push(`${name}: ${error.message}`); } };
  let clock = items.length ? items[0].atMs : 0;
  let ticks = 0;
  const tickTo = (atMs) => {
    while (clock + 1000 <= atMs) {
      park.tick();
      clock += 1000;
      onTick(park, ticks++);
    }
  };
  for (const item of items) {
    tickTo(item.atMs);
    const { method, args } = readFeedItem(item, decode);
    applyToPark(park, method, args, guard);
  }
  tickTo(clock + 1000);
  for (let more = 0; more < 3 && park.history.length > 0; more++) tickTo(clock + 1000);
  return { park, failures, ticks };
}

/** Every ball's position after a tick: [id, x, y, z, mode], ids as strings. */
function snapshot(park) {
  const out = [];
  for (const [id, ball] of park.ballpark.balls) out.push([String(id), ball.newPos.x, ball.newPos.y, ball.newPos.z, ball.mode]);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith("--")) ?? "destinyWarp";
  const outIdx = args.indexOf("--out");
  const outDir = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(__dirname, "..", "_local", "play-feed"));
  const fixture = require(path.join(__dirname, "..", "test", "fixtures", `${name}.json`));

  const items = notifications(fixture).map((n) => feedItem(n, n.atMs)).filter(Boolean);
  const expected = [];
  const { park, failures, ticks } = playFeed(items, {
    decode: marshalDecode,
    makePark: () => new Park({ ballpark: new Ballpark() }),
    onTick: (p) => expected.push(snapshot(p)),
  });

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}.json`);
  const feed = {
    about: `${fixture.about ?? name} As a Destiny feed (scripts/destiny-feed.js), with the BFF park's positions after every tick.`,
    source: `test/fixtures/${name}.json`,
    solarSystemID: fixture.solarSystemID ?? null,
    shipID: fixture.shipID != null ? String(fixture.shipID) : null,
    items,
    expected,
    summary: { items: items.length, ticks, balls: park.ballpark.balls.size, failures, resets: park.resets, fatalDesyncs: park.fatalDesyncs },
  };
  fs.writeFileSync(file, JSON.stringify(feed));
  console.log(`${file}: ${items.length} items, ${ticks} ticks, ${park.ballpark.balls.size} balls at the end, failures ${failures.length}, resets ${park.resets}`);
}

module.exports = { playFeed, snapshot };
if (require.main === module) main();
