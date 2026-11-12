// The shared item icon, RENDERED (goal R27).
//
// `typeIcons.test.ts` covers the arithmetic; this file covers the markup that
// arithmetic turns into, because the invariants R27 has to hold are properties
// of the emitted HTML:
//
//   * the picture and the fallback tile occupy the SAME fixed box (R8 — rows
//     must not jitter as images stream in, and the reflow cards must not
//     reshuffle underneath the player);
//   * `alt` / `aria-label` is the item's NAME and nothing rendered or spoken is
//     ever a number (R7d);
//   * an unknown type emits NO `src` at all, so there is never a broken image;
//   * the browser never asks an external host for anything.
//
// It also holds the UNIFICATION proof: `TypeIcon.svelte` is the only component
// in the app allowed to contain an `<img>`. Before R27 the fitting window had
// its own pair with its own 404 bookkeeping; that test is what stops a second
// implementation growing back.
//
// Rendered with Svelte's SERVER generator (see svelteSsrHook.ts) — no DOM
// needed. `onerror` therefore does not fire here, which is exactly why the
// null-typeID path matters: it is the same tile branch a 404 lands on, and it
// is reachable without a browser.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const TypeIcon = ((await import("./TypeIcon.svelte")) as { default: unknown }).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

interface IconProps {
  typeID: number | null;
  name: string;
  size?: "sm" | "md" | "lg" | "socket";
  fallbackText?: string | null;
}

function markup(props: IconProps): string {
  return (render(TypeIcon as never, { props } as never) as { body: string }).body;
}

// --- a cached picture -------------------------------------------------------

test("a known type renders its cached picture, labelled with the item's NAME", () => {
  const html = markup({ typeID: 587, name: "Rifter" });
  assert.match(html, /<img/);
  assert.match(html, /src="\/client-res\/type-picture\/587\/64\.png"/);
  assert.match(html, /alt="Rifter"/);
});

test("the browser is never sent to an external image host", () => {
  const html = markup({ typeID: 587, name: "Rifter" });
  assert.doesNotMatch(html, /https?:|evetech|images\.|\/\//);
});

// --- the fallback, which is the COMMON case ---------------------------------
//
// `data/` is gitignored: on a fresh clone and in CI there is no icon cache at
// all, so every one of these renders takes the tile path. It is the default
// state of the design, not an error state.

test("an unknown type renders a named tile instead of a broken picture", () => {
  const html = markup({ typeID: null, name: "Veldspar" });
  assert.doesNotMatch(html, /<img/, "a null type must not emit an <img> at all");
  assert.doesNotMatch(html, /src=/, "and therefore must not emit any src");
  assert.match(html, /class="type-icon-tile"/);
  assert.match(html, /aria-label="Veldspar"/);
  assert.match(html, />VE</, "the tile shows letters derived from the name");
});

test("an absurd type is treated as no type, never as a URL", () => {
  for (const typeID of [0, -1, 1.5, Number.NaN]) {
    const html = markup({ typeID, name: "Veldspar" });
    assert.doesNotMatch(html, /<img|src=/, `typeID ${typeID} emitted an image`);
    assert.match(html, /class="type-icon-tile"/);
  }
});

test("a name that has not resolved yet still renders a deliberate tile", () => {
  // `resolvedName` hands us an em dash when the name cache has nothing. The
  // tile must not become an empty square or a stray dash.
  const html = markup({ typeID: null, name: "—" });
  assert.match(html, /class="type-icon-tile"/);
  assert.match(html, />\?</);
});

// --- R8: one box, whichever half is showing ---------------------------------

test("the picture and the tile occupy the SAME fixed box", () => {
  // The size lives on the wrapper and NOWHERE else, so a row measures the same
  // before, during and after an image loads. If a size ever moves onto the
  // <img> or the tile, this is what catches it.
  const withPicture = markup({ typeID: 587, name: "Rifter" });
  const withTile = markup({ typeID: null, name: "Rifter" });
  const box = /class="type-icon type-icon-sm"/;
  assert.match(withPicture, box);
  assert.match(withTile, box);
  // Neither branch carries its own dimensions.
  assert.doesNotMatch(withPicture, /width=|height=|style="/);
  assert.doesNotMatch(withTile, /width=|height=|style="/);
});

test("every offered size names its box on the wrapper", () => {
  for (const size of ["sm", "md", "lg", "socket"] as const) {
    for (const typeID of [587, null]) {
      const html = markup({ typeID, name: "Rifter", size });
      assert.match(
        html,
        new RegExp(`class="type-icon type-icon-${size}"`),
        `size ${size} (typeID ${typeID}) lost its box`,
      );
    }
  }
});

// --- R7d: names, never numbers ----------------------------------------------

test("R7d — nothing an icon renders or speaks is ever a number", () => {
  // The typeID is allowed to appear in the `src` path and NOWHERE else: an
  // asset path is not data shown to the player (the R21 precedent). So strip
  // the src, and no trace of 587 may survive anywhere in the markup.
  for (const props of [
    { typeID: 587, name: "Rifter" },
    { typeID: 587, name: "Rifter", size: "socket" as const, fallbackText: "Rifter" },
    { typeID: null, name: "Rifter" },
  ]) {
    const stripped = markup(props).replace(/src="[^"]*"/g, "");
    assert.doesNotMatch(stripped, /587/, `a typeID escaped the src path: ${JSON.stringify(props)}`);
  }
});

test("the accessible name is the item's name in BOTH states", () => {
  assert.match(markup({ typeID: 587, name: "Damage Control II" }), /alt="Damage Control II"/);
  assert.match(
    markup({ typeID: null, name: "Damage Control II" }),
    /aria-label="Damage Control II"/,
  );
});

// --- the fitting socket's larger tile ---------------------------------------

test("a socket's tile can carry a readable abbreviation instead of initials", () => {
  // A socket is the one caller with no name rendered beside it, so its tile is
  // the label rather than an anchor for one.
  const html = markup({
    typeID: null,
    name: "425mm AutoCannon II",
    size: "socket",
    fallbackText: "425mm AC II",
  });
  assert.match(html, />425mm AC II</);
  assert.match(html, /aria-label="425mm AutoCannon II"/, "the FULL name is still what is spoken");
});

// --- the unification proof --------------------------------------------------

/** A component's source with its prose stripped, so a sweep reads the MARKUP. */
function componentCode(file: string): string {
  return readFileSync(path.join(UI_DIR, file), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function componentsWhere(pattern: RegExp, except: readonly string[] = []): string[] {
  return readdirSync(UI_DIR)
    .filter((file) => file.endsWith(".svelte") && !except.includes(file))
    .filter((file) => pattern.test(componentCode(file)));
}

test("TypeIcon is the ONLY component in the app that renders a picture", () => {
  // R27's whole point. The fitting window used to hold the app's only two
  // image tags plus its own missing-icon set; they are gone. A second
  // implementation appearing anywhere fails here.
  const offenders = componentsWhere(/<img\b/, ["TypeIcon.svelte"]);
  assert.deepEqual(offenders, [], `these components render their own image: ${offenders.join(", ")}`);
});

test("no component hardcodes an external image host", () => {
  const offenders = componentsWhere(/images\.evetech\.net|https?:\/\//);
  assert.deepEqual(offenders, [], `these components reach an external host: ${offenders.join(", ")}`);
});
