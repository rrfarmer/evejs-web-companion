import test from "node:test";
import assert from "node:assert/strict";
import { decodeAgencySeason, decodeAgencySeasonProgress, seasonPageKind } from "./agencySeason.ts";

const keyVal = (entries: unknown[]) => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });

test("template 2216 selects the active Vanguard page; the previous template and no selection do not", () => {
  const end = "134500000000000000";
  const season = keyVal([["template_id", 2216], ["title", 125], ["end_time", { type: "long", value: end }]]);
  const decoded = decodeAgencySeason({ result: season });
  assert.equal(decoded?.titleID, 125);
  assert.equal(decoded?.endMs, Number((BigInt(end) - 116444736000000000n) / 10000n));
  assert.equal(seasonPageKind(decoded?.templateID ?? null), "vanguard");
  assert.equal(seasonPageKind(2200), "season");
  assert.equal(decodeAgencySeason({ type: "list", items: [season] }), null);
  assert.equal(decodeAgencySeason(null), null);
});

test("season progress decodes the ObjectEx2 challenge state and leaves expired challenges out", () => {
  const fields = [["name", 123], ["message_text", 456], ["progress", 1], ["max_progress", 5], ["points_awarded", 20]];
  const challenge = (dict: unknown[]) => ({ type: "objectex2", header: [], dict });
  const progress = keyVal([["seasonal_points", 40], ["max_seasonal_points", 300], ["challenges", {
    type: "dict", entries: [[101, challenge(fields)], [102, challenge([...fields, ["is_expired", true]])]],
  }]]);
  assert.deepEqual(decodeAgencySeasonProgress(progress), { points: 40, target: 300,
    challenges: [{ id: 101, name: 123, detail: 456, current: 1, target: 5, points: 20 }] });
});
