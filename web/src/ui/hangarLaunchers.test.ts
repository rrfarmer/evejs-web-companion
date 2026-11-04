// The doors beside the brand in the Pilot Hangar. Some are links and some are
// buttons, and they must look alike. The hangar's reset of `button` removes
// padding and border with the same weight as `.global-launch`, and comes later,
// so the hangar's own rule has to say both again.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} is in styles.css`);
  return css.slice(start, css.indexOf("}", start));
}

test("⚠ a door that is a button keeps its padding and border in the hangar, as a door that is a link does", () => {
  const reset = ruleBody(":is(.hangar, .hangar-chrome) :where(button)");
  assert.match(reset, /\bpadding: 0;/, "the reset the rule below has to answer");
  assert.match(reset, /\bborder: 0;/, "the reset the rule below has to answer");
  const door = ruleBody(".hangar .global-launch");
  assert.match(door, /\bpadding: 0 0\.5rem;/);
  assert.match(door, /\bborder: 1px solid /);
});

test("⚠ the strip scrolls inside itself at every width, so its doors cannot run the hangar past the screen", () => {
  const strip = ruleBody(".hangar .global-launchers");
  assert.match(strip, /\bflex: 0 1 auto;/);
  assert.match(strip, /\bmin-width: 0;/);
  assert.match(strip, /\boverflow-x: auto;/);
  const media = css.indexOf("@media (max-width: 759px)");
  assert.ok(css.indexOf(".hangar .global-launchers {") < media, "the rule is not only inside the mobile block");
});
