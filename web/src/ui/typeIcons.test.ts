// The item-icon rules (goal R27): where a picture comes from, and what stands
// in for it when there is none.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { iconInitials, typeIconUrl } from "./typeIcons.ts";

// --- where a picture comes from --------------------------------------------

test("icons come from the LOCAL cache and never an external host", () => {
  const url = typeIconUrl(3634)!;
  assert.equal(url, "/client-res/type-picture/3634/64.png");
  // Same-origin, relative: no scheme, no host, nothing to leak.
  assert.ok(url.startsWith("/"));
  assert.doesNotMatch(url, /^https?:|\/\/|evetech|images\./);
});

test("a nonsense type has no icon rather than a broken URL", () => {
  assert.equal(typeIconUrl(0), null);
  assert.equal(typeIconUrl(-1), null);
  assert.equal(typeIconUrl(1.5), null);
  assert.equal(typeIconUrl(Number.NaN), null);
  assert.equal(typeIconUrl(null), null);
});

test("deciding an icon's URL never touches the filesystem", () => {
  // The whole reason a machine with no `data/icon-cache` renders identical
  // markup: the client works out the URL arithmetically and lets the BFF 404.
  // If this module ever grows an import, that assumption needs re-checking.
  const source = readFileSync(new URL("./typeIcons.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m, "typeIcons.ts must stay dependency-free");
  assert.doesNotMatch(source, /\bfs\.|existsSync|readFile/, "no filesystem access");
});

// --- what stands in for a picture ------------------------------------------

test("a tile's letters come from the NAME, never from an id", () => {
  assert.equal(iconInitials("Veldspar"), "VE");
  assert.equal(iconInitials("Tritanium"), "TR");
  assert.equal(iconInitials("Damage Control II"), "DC");
  assert.equal(iconInitials("425mm AutoCannon II"), "4A");
  assert.equal(iconInitials("Large Shield Extender II"), "LS");
});

test("the tier marker never becomes the whole tile", () => {
  // "Damage Control II" must not read as "DI" or "II" — the words that name
  // the thing win over the tier.
  assert.equal(iconInitials("Damage Control II"), "DC");
  assert.equal(iconInitials("Gyrostabilizer II"), "GY");
  assert.equal(iconInitials("Warp Disruptor I"), "WD");
  // ...unless the tier marker is genuinely all there is.
  assert.equal(iconInitials("II"), "II");
});

test("a name that has not resolved yet still gets a deliberate tile", () => {
  // `resolvedName` renders an em dash for a name it does not have. A tile of
  // punctuation would look broken, so it reads as an honest "unknown".
  assert.equal(iconInitials("—"), "?");
  assert.equal(iconInitials(""), "?");
  assert.equal(iconInitials("   "), "?");
});

test("a tile is never longer than two characters", () => {
  const names = [
    "Veldspar",
    "Damage Control II",
    "425mm AutoCannon II",
    "Medium Ancillary Armor Repairer",
    "Compressed Dark Ochre",
    "—",
    "II",
    "X",
  ];
  for (const name of names) {
    assert.ok(
      iconInitials(name).length <= 2,
      `${name} -> ${iconInitials(name)} is too wide for the tile`,
    );
  }
});
