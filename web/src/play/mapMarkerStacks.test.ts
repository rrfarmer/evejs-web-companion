import assert from "node:assert/strict";
import { test } from "node:test";
import { markerStacks, markerTooltipRows, type ProjectedMarker } from "./mapMarkerStacks.ts";

function marker(groupID: number, x = 0, extra: Partial<ProjectedMarker> = {}): ProjectedMarker {
  return { kind: "celestial", groupID, x, y: 0, cameraDistance: 10, name: "", highlighted: false, ...extra };
}

test("known d-scan groups lead stacks by native group, name and camera distance", () => {
  const gate = marker(10);
  const station = marker(15, 0, { highlighted: true });
  const unknown = marker(1657, 0, { highlighted: true });
  const moon = marker(8, 0, { highlighted: true, name: "a" });
  const fartherMoon = marker(8, 0, { highlighted: true, name: "a", cameraDistance: 20 });
  const laterMoon = marker(8, 0, { highlighted: true, name: "b", cameraDistance: 1 });
  assert.deepEqual(markerStacks([gate, unknown, laterMoon, fartherMoon, moon, station]).stacks.get(station),
    [moon, fartherMoon, laterMoon, gate, unknown]);
  station.highlighted = moon.highlighted = fartherMoon.highlighted = laterMoon.highlighted = false;
  assert.ok(markerStacks([station, unknown, moon, gate]).stacks.has(gate));
});

test("overlap is anchored to a leading bracket, with strict 12px limits and reverse tooltip order", () => {
  const result = marker(0, 0, { kind: "result", groupID: undefined });
  const station = marker(15, 11);
  const planet = marker(7, 12);
  const probe = marker(0, 12, { kind: "probe", groupID: undefined });
  const markers = [planet, station, probe, result];
  const { stacks, covered } = markerStacks(markers);
  assert.deepEqual([...stacks], [[result, [station]], [planet, [probe]]]);
  assert.deepEqual([...covered], [station, probe]);
  assert.deepEqual(markerTooltipRows(result, markers), [station, result]);
  assert.deepEqual(markerTooltipRows(planet, markers), [probe, planet, station]);
});
