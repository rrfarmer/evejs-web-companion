import assert from "node:assert/strict";
import test from "node:test";
import { colorWatchlistSelection } from "./watchlistSettings.ts";

test("coloring a selected watchlist entry colors the selection", () => {
  const current = { 11: 1, 13: 3 };
  assert.deepEqual(colorWatchlistSelection(current, [11, 12], 11, 4), { 11: 4, 12: 4, 13: 3 });
  assert.deepEqual(current, { 11: 1, 13: 3 });
});

test("coloring an unselected entry leaves the selection alone", () => {
  assert.deepEqual(colorWatchlistSelection({ 11: 1, 12: 2 }, [11, 12], 13, 4), { 11: 1, 12: 2, 13: 4 });
});

test("clearing from a selected entry clears the selection", () => {
  assert.deepEqual(colorWatchlistSelection({ 11: 1, 12: 2, 13: 3 }, [11, 12], 12, null), { 13: 3 });
});
