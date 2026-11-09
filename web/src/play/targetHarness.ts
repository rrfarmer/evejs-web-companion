// DEV-ONLY harness for the target bar (target-harness.html): made-up targets, sliders for the first one.
// window.tb exposes the entries so a check can set them from script.

import { TargetBar, type TargetBarEntry } from "./targetBar.ts";

const bar = new TargetBar();
document.body.appendChild(bar.root);

// where the play page puts its Selected Item window (spaceView.ts)
const selected = document.getElementById("selected")!;
const anchor = () => ({ left: innerWidth - 300, top: 14, width: 280 });
const placeSelected = () => {
  const a = anchor();
  Object.assign(selected.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: "116px" });
  bar.setAnchor(a);
};
placeSelected();
addEventListener("resize", placeSelected);

const sample: Omit<TargetBarEntry, "itemID" | "active" | "locking">[] = [
  { typeID: 587, name: "Rifter", distance: 12_400, shieldRatio: 1, armorRatio: 1, hullRatio: 1 },
  { typeID: 24698, name: "Drake", typeName: "Drake", distance: 32_750, shieldRatio: 0.62, armorRatio: 1, hullRatio: 1 },
  { typeID: 17841, name: "Federation Navy Comet", distance: 8_500, shieldRatio: 0.2, armorRatio: 0.45, hullRatio: 0.9 },
  { typeID: 23707, name: "Hornet", distance: 650, shieldRatio: 0, armorRatio: 0, hullRatio: 0.3 },
  { typeID: 2006, name: "Pith Guardian Wreck Container With A Long Name", distance: 152_000_000_000, shieldRatio: null, armorRatio: null, hullRatio: null },
];
let next = 1000;
const entries: TargetBarEntry[] = sample.slice(0, 3).map((s, i) => ({ ...s, itemID: next++, active: i === 0, locking: false }));

const controls = document.getElementById("controls")!;
const log = document.createElement("div");
log.id = "log";
for (const key of ["shieldRatio", "armorRatio", "hullRatio", "distance"] as const) {
  const label = document.createElement("label");
  const max = key === "distance" ? 200000 : 1;
  label.innerHTML = `<span>${key}</span><input type="range" min="0" max="${max}" step="${key === "distance" ? 50 : 0.01}"><span class="out"></span>`;
  const input = label.querySelector("input")!;
  const out = label.querySelector(".out")!;
  const first = () => entries[0];
  input.value = String(first()?.[key] ?? 0);
  out.textContent = input.value;
  input.addEventListener("input", () => {
    const e = first();
    if (e) (e as unknown as Record<string, number>)[key] = Number(input.value);
    out.textContent = input.value;
  });
  controls.appendChild(label);
}
const button = (text: string, fn: () => void) => {
  const b = document.createElement("button");
  b.textContent = text;
  b.addEventListener("click", fn);
  controls.appendChild(b);
};
button("Lock one", () => {
  const s = sample[next % sample.length]!;
  const e: TargetBarEntry = { ...s, itemID: next++, active: false, locking: true, lockTimeMs: 3000, lockStartedAt: performance.now() };
  entries.push(e);
  setTimeout(() => { e.locking = false; if (!entries.some((x) => x.active)) e.active = true; }, 3600);
});
button("Unlock first", () => { entries.shift(); if (entries.length && !entries.some((x) => x.active)) entries[0]!.active = true; });
controls.appendChild(log);

bar.onSelect = (id) => { for (const e of entries) e.active = e.itemID === id; log.textContent = `select ${id}`; };
bar.onUnlock = (id) => { const i = entries.findIndex((e) => e.itemID === id); if (i >= 0) entries.splice(i, 1); log.textContent = `unlock ${id}`; };

const bracket = document.getElementById("bracket")!;
function frame(): void {
  bar.update(entries);
  // a locking target's indicator goes in its in-space bracket; the harness has one bracket, for the newest
  const lockingID = [...entries].reverse().find((e) => e.locking)?.itemID;
  const ind = lockingID === undefined ? null : bar.lockingIndicator(lockingID);
  if (ind && ind.parentElement !== bracket) { bracket.replaceChildren(ind); }
  if (!ind && bracket.firstChild) bracket.replaceChildren();
}
const loop = () => { frame(); requestAnimationFrame(loop); };
requestAnimationFrame(loop);
setInterval(() => { if (document.hidden) frame(); }, 100);

(window as unknown as { tb: { entries: TargetBarEntry[]; bar: TargetBar } }).tb = { entries, bar };
