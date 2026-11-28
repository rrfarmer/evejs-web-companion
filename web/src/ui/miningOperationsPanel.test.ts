import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const GlobalLaunchers = (await import("./GlobalLaunchers.svelte")).default;

test("the shared WC header retains stock actions without a standalone MCC launcher", () => {
  const output = render(GlobalLaunchers as never, {
    props: { openIds: new Set(), onOpen: () => {} },
  } as never);
  assert.doesNotMatch(output.body, /data-launch="miningOperations"|href="\/mining-command-center"/);
  for (const id of ["botManager", "plugins", "industryManager"]) {
    assert.match(output.body, new RegExp(`<button\\b[^>]*data-launch="${id}"`));
  }
});
