// DEV-ONLY harness for the ship HUD (hud-harness.html): the HUD alone, its values from sliders.
// window.hud exposes the state so a check can set it from script.

import { ShipHud, type ShipHudState } from "./shipHud.ts";

const params = new URLSearchParams(location.search);
const slots = { hi: Number(params.get("hi") ?? 8), med: Number(params.get("med") ?? 8), low: Number(params.get("low") ?? 8) };
const hud = new ShipHud({ slots });
document.body.appendChild(hud.root);

const state: ShipHudState = {
  shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1, capacitorMax: 1000,
  speed: 0, maxSpeed: 300, heatLow: 0, heatMed: 0, heatHi: 0,
};

const controls = document.getElementById("controls")!;
const log = document.createElement("div");
log.id = "log";
const sliders: [keyof ShipHudState, number, number, number][] = [
  ["shieldRatio", 0, 1, 0.01], ["armorRatio", 0, 1, 0.01], ["hullRatio", 0, 1, 0.01],
  ["capacitorRatio", 0, 1, 0.01], ["capacitorMax", 0, 6000, 25],
  ["speed", 0, 400, 0.1], ["maxSpeed", 0, 400, 1],
  ["heatLow", 0, 1, 0.01], ["heatMed", 0, 1, 0.01], ["heatHi", 0, 1, 0.01],
];
for (const [key, min, max, step] of sliders) {
  const label = document.createElement("label");
  label.innerHTML = `<span>${key}</span><input type="range" min="${min}" max="${max}" step="${step}"><span class="out"></span>`;
  const input = label.querySelector("input")!;
  const out = label.querySelector(".out")!;
  input.value = String(state[key]);
  out.textContent = String(state[key]);
  input.addEventListener("input", () => {
    (state as unknown as Record<string, number>)[key] = Number(input.value);
    out.textContent = input.value;
  });
  controls.appendChild(label);
}
controls.appendChild(log);
hud.onStop = () => { state.speed = 0; log.textContent = "Stop"; };
hud.onFullSpeed = () => { state.speed = state.maxSpeed ?? 0; log.textContent = "Full speed"; };

function frame(): void {
  hud.update(state);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// a hidden page gets no animation frames; keep it moving at a slower beat
setInterval(() => { if (document.hidden) hud.update(state); }, 100);

(window as unknown as { hud: { state: ShipHudState; hud: ShipHud } }).hud = { state, hud };
