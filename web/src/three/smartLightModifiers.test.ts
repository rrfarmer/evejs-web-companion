import assert from "node:assert/strict";
import test from "node:test";
import { smartLightColor, smartLightUsesCamera, type SmartLightModifier } from "./smartLightModifiers.ts";

const color = (changes: Partial<Extract<SmartLightModifier, { kind: "color" }>> = {}): SmartLightModifier => ({
  kind: "color", color: [0, 0, 1, 0.5], blend: 1, brightness: 1, saturation: 1,
  factor: 1, active: false, startsActive: true, variable: "", duration: 2.5, curve: 0, delayIn: 0, delayOut: 0, ...changes,
});
const listener = (children: SmartLightModifier[], variable = "IsWarping"): SmartLightModifier =>
  ({ kind: "listener", variable, initial: 0, invert: false, duration: 1, factor: 1, children });

test("the smart-light listener opens before its color fades and both weights decay on reversal", () => {
  const mix = smartLightColor([1, 0, 0, 1], [listener([color()])]);
  let warp = 0;
  const time = (now: number) => mix(now, { variable: () => warp, speed: 0, maxSpeed: 0 });
  assert.deepEqual(time(0), [1, 0, 0, 1]);
  warp = 1;
  assert.deepEqual(time(1), [1, 0, 0, 1]);
  assert.deepEqual(time(1.5), [1, 0, 0, 1]);
  const edge = time(2);
  assert.ok(edge[2]! > 0);
  assert.ok(Math.abs(time(2.75)[2]! - 0.5) < 1e-12);
  warp = 0;
  assert.ok(Math.abs(time(3)[2]! - 0.5) < 1e-12);
  assert.ok(Math.abs(time(3.5)[2]! - 0.15) < 1e-12);
  assert.deepEqual(time(4), [1, 0, 0, 1]);
});

test("the color modifier preserves alpha and applies fractional native blend, saturation and brightness", () => {
  // Installed 3698585 Squall fixture with the single enabled color modifier.
  const base = [0.7019608020782471, 0.42352938652038574, 0.2862744927406311, 1];
  const target = [0.20000000298023224, 0.10000000149011612, 0.800000011920929, 0.4000000059604645];
  const mix = smartLightColor(base, [color({ color: target, active: true, blend: 0.5, factor: 0.5, saturation: 0, brightness: 1 })]);
  const result = mix(0, { variable: () => undefined, speed: 0, maxSpeed: 0 });
  const native = [0.4986228048801422, 0.3817110061645508, 0.41774043440818787, 1];
  assert.ok(result.every((v, i) => Math.abs(v - native[i]!) < 1e-7));
});

test("speed expressions and exponential fades use the authored inputs", () => {
  const source = "min(1.0, (shipSpeed*0.5)/max(shipMaxSpeed, 1.0))";
  const mix = smartLightColor([1, 0, 0, 1], [
    { kind: "expression", source, factor: 1, children: [color({ active: true })] },
  ]);
  assert.deepEqual(mix(0, { variable: () => undefined, speed: 100, maxSpeed: 200 }), [0.75, 0, 0.25, 1]);
  assert.deepEqual(mix(1, { variable: () => undefined, speed: 500, maxSpeed: 200 }), [0, 0, 1, 1]);
  const expo = smartLightColor([0, 0, 0, 1], [color({ variable: "on", duration: 1, curve: 5 })]);
  const input = { variable: () => 1, speed: 0, maxSpeed: 0 };
  expo(0, input);
  assert.equal(expo(0.5, input)[2], 0.03125);
});

test("camera distance and placement reproduce the native single-locator color samples", () => {
  const fade = color({ active: true, blend: 0, brightness: 0, duration: 0 });
  const input = { variable: () => undefined, speed: 0, maxSpeed: 0 };
  const base = [0, 0.4, 0, 0.75];
  const distance = Math.hypot(-30, 27, 32);
  const alignment = 57 * Math.SQRT1_2 / distance;
  const cases: [Extract<SmartLightModifier, {kind: "camera"}>["driver"], number][] = [
    [{ kind: "distance", near: 20, far: 400, inverse: false }, 0.366834431886673],
    [{ kind: "distance", near: 20, far: 400, inverse: true }, 0.033165574073791504],
    [{ kind: "placement", exponent: 1, inverse: false }, 0.08699502795934677],
    [{ kind: "placement", exponent: 2, inverse: false }, 0.1550697386264801],
    [{ kind: "placement", exponent: 0.5, inverse: true }, 0.3538389205932617],
  ];
  for (const [driver, native] of cases) {
    const modifier: SmartLightModifier = { kind: "camera", driver, lower: 0, upper: 1, factor: 1, children: [fade] };
    const mix = smartLightColor(base, [modifier]);
    assert.deepEqual(mix(0, input), base);
    const result = mix(1, { ...input, camera: { distance, alignment } });
    assert.ok(Math.abs(result[1]! - native) < 4e-7);
    assert.equal(result[3], 0.75);
    assert.ok(smartLightUsesCamera([listener([modifier])]));
    assert.ok(!smartLightUsesCamera([listener([fade])]));
  }
});
