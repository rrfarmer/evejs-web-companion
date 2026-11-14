// The client's in-space combat notification (eve/client/script/ui/control/message.py CombatMessage, fed by
// uilog.Logger.Say from AddCombatMessage): up to six lines at the top of the middle of the view (centred, at 32 % of
// the height and no less than 225 px - GetDefaultAlignmentValues with the ship HUD at the bottom), font size 12
// (dmgnotifictions_fontsize). Messages are queued and one is put up each 1/6 s (numMessagePerSec), a message older than
// 5 s dropped (expiryTime); the new line enters at the top, the others step down 20 px each (MorphScalar top, 0.4 s, or
// 0.166 s while more than eight were shown in the last 8 s), the fifth fading out; each line's opacity runs 0 -> 1 at
// 0.2 (0.05 busy) -> 0 over 5 s (fadeOutTime). A miss from an attacker is put up once in 10 s (noDamageMsgTimer). The
// damage leads the line (damage_html: its colour, bold).
import { labelColorCss, labelLines } from "../bridge/labelMarkup.ts";

const PER_SECOND = 6;
const EXPIRY_MS = 5000;
const FADE_S = 5;
const LINES = 6;
const STEP_PX = 20;
const NO_DAMAGE_MS = 10_000;

interface Queued { readonly at: number; readonly markup: string; readonly damage: { readonly amount: number; readonly color: string } | null }

/** Client markup as spans: each run's text in its colour, weight and size. */
export function markupToElement(markup: string, fontSize: number): HTMLElement {
  const out = document.createElement("span");
  for (const line of labelLines(markup)) {
    for (const run of line.tabs.flat()) {
      const span = document.createElement("span");
      span.textContent = run.text;
      if (run.bold) span.style.fontWeight = "bold";
      if (run.italic) span.style.fontStyle = "italic";
      if (run.color !== null) span.style.color = labelColorCss(run.color);
      if (run.fontSize !== null) span.style.fontSize = `${run.fontSize}px`;
      else span.style.fontSize = `${fontSize}px`;
      out.appendChild(span);
    }
  }
  return out;
}

export class CombatMessage {
  private readonly root = document.createElement("div");
  private readonly queue: Queued[] = [];
  private readonly lines: HTMLDivElement[] = [];
  private readonly noDamage = new Map<number, number>();
  private readonly shown: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** What was put up, for checks: each line's text, newest first. */
  get text(): string[] { return this.lines.filter((l) => l.isConnected).map((l) => l.textContent ?? ""); }

  constructor(private readonly parent: HTMLElement, private readonly fontSize = 12) {
    this.root.className = "combat-msg";
    this.parent.appendChild(this.root);
    this.timer = setInterval(() => this.step(), 1000 / PER_SECOND);
  }

  /** AddMessage: a combat line - a miss from the same attacker put up once in 10 s, its damage shown only on a hit. */
  add(markup: string, hitQuality: number | null, attackerID: number | null, damage: { amount: number; color: string } | null): void {
    const now = performance.now();
    if (hitQuality === 0 && attackerID) {
      const last = this.noDamage.get(attackerID);
      if (last !== undefined && last > now - NO_DAMAGE_MS) return;
      this.noDamage.set(attackerID, now);
      damage = null;
    } else if (attackerID) this.noDamage.delete(attackerID);
    this.queue.push({ at: now, markup, damage });
  }

  /** ShowMsg: one message each step, the stale dropped; the new line in, the shown ones down. */
  private step(): void {
    const now = performance.now();
    this.shown.push(0);
    let message: Queued | undefined;
    while ((message = this.queue.shift()) && message.at < now - EXPIRY_MS) { /* discarded */ }
    if (!message) { this.trimShown(); return; }
    this.shown[this.shown.length - 1] = 1;
    this.trimShown();
    const busy = this.shown.reduce((a, b) => a + b, 0) > 8;
    // the line's place and its step-out fade on the outer; its own 5 s fade on the inner (an animated opacity would
    // override the outer's)
    const line = document.createElement("div");
    line.className = "combat-msg-line";
    const inner = document.createElement("span");
    inner.className = "combat-msg-text";
    inner.style.animationDuration = `${FADE_S}s`;
    inner.style.animationName = busy ? "combat-msg-fade-busy" : "combat-msg-fade";
    if (message.damage) {
      const n = document.createElement("b");
      n.textContent = `${Math.round(message.damage.amount)} `;
      n.style.color = message.damage.color;
      n.style.fontSize = `${this.fontSize}px`;
      inner.appendChild(n);
    }
    inner.appendChild(markupToElement(message.markup, this.fontSize));
    line.appendChild(inner);
    this.root.prepend(line);
    this.lines.unshift(line);
    // the others down a step each; the fifth fades out; past six gone
    const move = busy ? 0.166 : 0.4;
    this.lines.forEach((l, i) => {
      l.style.transition = `top ${move}s linear, opacity ${1 / PER_SECOND}s linear`;
      l.style.top = `${i * STEP_PX}px`;
      if (i === 5) l.style.opacity = "0";
    });
    while (this.lines.length > LINES) this.lines.pop()!.remove();
    // a line gone by its fade is let go
    setTimeout(() => { if (line.isConnected) { line.remove(); const i = this.lines.indexOf(line); if (i >= 0) this.lines.splice(i, 1); } }, FADE_S * 1000);
  }

  private trimShown(): void { while (this.shown.length > 8 * PER_SECOND) this.shown.shift(); }

  dispose(): void { if (this.timer) clearInterval(this.timer); this.root.remove(); }
}
