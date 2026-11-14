// The client's in-space combat notification (eve/client/script/ui/control/message.py CombatMessage, on
// carbonui/control/message.py's MessageParentClass; fed by uilog.Logger.Say from AddCombatMessage).
//  - Six line containers, bottom-aligned in the box (CENTERBOTTOM, or BOTTOMLEFT / BOTTOMRIGHT by the text alignment):
//    the new line at the bottom (top 0), the others raised to (i + 1) x 20 px (MorphScalar top, 0.4 s, or 0.166 s while
//    more than eight were shown in the last 8 s), the fifth of them fading out (FadeOut over a step); each line's
//    opacity [0,0] [0.2|0.05,1] [1,0] over 5 s (fadeOutTime).
//  - One message put up each 1/6 s (numMessagePerSec), one older than 5 s dropped (expiryTime); an attacker's miss
//    once in 10 s (noDamageMsgTimer), its damage not shown; the damage (damage_html) in its own label before the text.
//  - The box: width the widest line (no less than 100) + 30, height the shown lines' + 10, its bottom at topOffset
//    (top = max(-40, min(desktop height - height, topOffset - height)) - SetSizeAndPosition); its place from
//    damageMessages_config (align, text alignment, left, topOffset) or GetDefaultAlignmentValues (CENTERTOP, centred,
//    left 0, topOffset max(32 % of the height, 225)).
//  - Moving mode (logger.MoveNotifications - EnterDragMode): the box takes the mouse, a faint frame and fill, a close
//    button (Exit Message Moving Mode) at its top right, and where no line is up the example text (12 px, 380 wide, the
//    box 400 x its height + 20). Dragged, its top follows the mouse and DoAlignment places it: within 200 px of the
//    right edge (or alignment "right") anchored right, of the left edge (or "left") anchored left, else centred; the
//    text aligned to match unless the alignment setting names one; saved as it moves.
import { labelColorCss, labelLines } from "../bridge/labelMarkup.ts";
import { combatAlignment, combatBoxConfig, combatFlags, combatFontSize, combatMovingMode, saveCombatBoxConfig, type CombatBoxConfig } from "../ui/combatSettings.ts";

const PER_SECOND = 6;
const EXPIRY_MS = 5000;
const FADE_S = 5;
const LINES = 6;
const STEP_PX = 20;
const NO_DAMAGE_MS = 10_000;
const MIN_TOP = -40;

/** An icon drawn before the text (apply_message_to_container: Sprites in the icon container, the label's height
 *  square, in the message's icon_color). */
export interface CombatMessageIcon { readonly src: string; readonly color: string | null }
interface Queued { readonly at: number; readonly markup: string; readonly damage: { readonly amount: number; readonly color: string } | null; readonly icons: readonly CombatMessageIcon[] }

/** Client markup as spans: each run's text in its colour, weight and (where it names one) size. */
export function markupToElement(markup: string): HTMLElement {
  const out = document.createElement("span");
  for (const line of labelLines(markup)) {
    for (const run of line.tabs.flat()) {
      const span = document.createElement("span");
      span.textContent = run.text;
      if (run.bold) span.style.fontWeight = "bold";
      if (run.italic) span.style.fontStyle = "italic";
      if (run.color !== null) span.style.color = labelColorCss(run.color);
      if (run.fontSize !== null) span.style.fontSize = `${run.fontSize}px`;
      out.appendChild(span);
    }
  }
  return out;
}

export class CombatMessage {
  private readonly root = document.createElement("div");
  private readonly queue: Queued[] = [];
  /** The shown lines, newest first. */
  private readonly lines: HTMLDivElement[] = [];
  private readonly noDamage = new Map<number, number>();
  private readonly shown: number[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: (() => void)[] = [];
  private config: CombatBoxConfig | null = null;
  private alignment: "auto" | "left" | "right" | "center" = "auto";
  private moving = false;
  private frame: HTMLDivElement | null = null;
  private fake: HTMLDivElement | null = null;
  /** The example text's words (UI/Accessories/Log/ExampleText), set by the page. */
  exampleText: () => string = () => "Example Text";
  /** The close button's hint (UI/Accessories/Log/ExitMessageMovingMode), set by the page. */
  exitHint: () => string = () => "Exit Message Moving Mode";
  /** What was put up, for checks: each line's text, newest first. */
  get text(): string[] { return this.lines.map((l) => l.textContent ?? ""); }
  /** The box's place, for checks. */
  get box(): { left: number; top: number; width: number; height: number; textAlign: string } {
    const r = this.root.getBoundingClientRect(), p = this.parent.getBoundingClientRect();
    return { left: Math.round(r.left - p.left), top: Math.round(r.top - p.top), width: Math.round(r.width), height: Math.round(r.height), textAlign: this.current().textAlign };
  }

  constructor(private readonly parent: HTMLElement) {
    this.root.className = "combat-msg";
    this.parent.appendChild(this.root);
    this.timer = setInterval(() => this.step(), 1000 / PER_SECOND);
    this.unsubscribe.push(
      combatFontSize.subscribe((size) => { this.root.style.fontSize = `${size}px`; this.place(); }),
      combatBoxConfig.subscribe((config) => { this.config = config; this.place(); }),
      // ChangeAlignment: DoAlignment again
      combatAlignment.subscribe((alignment) => { const was = this.alignment; this.alignment = alignment; if (was !== alignment) this.doAlignment(0); }),
      combatMovingMode.subscribe((on) => (on ? this.enterDragMode() : this.exitDragMode())),
      // _on_show_inflight_messages_setting_changed: the box closed
      combatFlags.subscribe((flags) => { if (flags.damageMessageShowInspaceNotifications === false) this.clear(); }),
    );
    this.root.addEventListener("pointerdown", (e) => this.beginDrag(e));
    // OnEndChangeDevice: the default place again for the new size
    addEventListener("resize", this.onResize);
  }
  private readonly onResize = () => this.place();

  /** AddMessage: a combat line - a miss from the same attacker put up once in 10 s, its damage shown only on a hit. */
  add(markup: string, hitQuality: number | null, attackerID: number | null, damage: { amount: number; color: string } | null): void {
    const now = performance.now();
    if (hitQuality === 0 && attackerID) {
      const last = this.noDamage.get(attackerID);
      if (last !== undefined && last > now - NO_DAMAGE_MS) return;
      this.noDamage.set(attackerID, now);
      damage = null;
    } else if (attackerID) this.noDamage.delete(attackerID);
    this.queue.push({ at: now, markup, damage, icons: [] });
  }

  /** AddActionMessage: a mining / bounty line (logger.SayMessage), its icons before it. */
  addAction(markup: string, icons: readonly CombatMessageIcon[] = []): void {
    this.queue.push({ at: performance.now(), markup, damage: null, icons });
  }

  /** The in-space notifications turned off (_on_show_inflight_messages_setting_changed: the box closed). */
  clear(): void {
    this.queue.length = 0;
    for (const l of this.lines) l.remove();
    this.lines.length = 0;
    this.place();
  }

  /** GetDefaultAlignmentValues, or the saved damageMessages_config. */
  private current(): CombatBoxConfig {
    if (this.config) return this.config;
    return { align: "CENTERTOP", textAlign: "center", left: 0, topOffset: Math.max(this.parent.clientHeight * 0.32, 225) };
  }

  /** The text alignment shown: the setting's where it names one (SetTextAlignmentIfNeeded), else the place's. */
  private textAlign(): "left" | "right" | "center" {
    return this.alignment !== "auto" ? this.alignment : this.current().textAlign;
  }

  /** ShowMsg: one message each step, the stale dropped; the new line in at the bottom, the shown ones up. */
  private step(): void {
    const now = performance.now();
    this.shown.push(0);
    let message: Queued | undefined;
    while ((message = this.queue.shift()) && message.at < now - EXPIRY_MS) { /* discarded */ }
    if (!message) { this.trimShown(); return; }
    this.shown[this.shown.length - 1] = 1;
    this.trimShown();
    // the example text goes when a line comes
    this.fake?.remove();
    this.fake = null;
    const busy = this.shown.reduce((a, b) => a + b, 0) > 8;
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
      inner.appendChild(n);
    }
    for (const icon of message.icons) {
      const i = document.createElement("span");
      i.className = "combat-msg-icon";
      i.style.setProperty("--icon", `url("${icon.src}")`);
      if (icon.color) i.style.backgroundColor = icon.color;
      inner.appendChild(i);
    }
    // a line with icons has a space before its text
    inner.appendChild(markupToElement(message.icons.length ? ` ${message.markup}` : message.markup));
    line.appendChild(inner);
    line.style.bottom = "5px";
    this.root.appendChild(line);
    // the others up a step each (sorted by their top: the newest lowest); the fifth fades out; past six gone
    const move = busy ? 0.166 : 0.4;
    this.lines.forEach((l, i) => {
      l.style.transition = `bottom ${move}s linear, opacity ${1 / PER_SECOND}s linear`;
      l.style.bottom = `${5 + (i + 1) * STEP_PX}px`;
      if (i === 4) l.style.opacity = "0";
    });
    this.lines.unshift(line);
    while (this.lines.length > LINES) this.lines.pop()!.remove();
    this.place();
    // a line gone by its fade is let go
    setTimeout(() => {
      const i = this.lines.indexOf(line);
      if (i >= 0) { this.lines.splice(i, 1); line.remove(); this.place(); }
    }, FADE_S * 1000);
  }

  private trimShown(): void { while (this.shown.length > 8 * PER_SECOND) this.shown.shift(); }

  /** SetSizeAndPosition, and the box placed by its align and left. */
  private place(): void {
    const config = this.current();
    const textAlign = this.textAlign();
    this.root.dataset.textAlign = textAlign;
    let width: number, height: number;
    if (this.lines.length === 0 && this.fake) {
      width = 400;
      height = this.fake.offsetHeight + 20;
    } else {
      const widths = this.lines.map((l) => (l.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0);
      width = Math.max(100, ...widths) + 30;
      height = this.lines.reduce((sum, l) => sum + l.offsetHeight, 0) + 10;
    }
    const W = this.parent.clientWidth, H = this.parent.clientHeight;
    const top = Math.max(MIN_TOP, Math.min(H - height, config.topOffset - height));
    const left = config.align === "TOPLEFT" ? config.left : config.align === "TOPRIGHT" ? W - width - config.left : (W - width) / 2 + config.left;
    Object.assign(this.root.style, { width: `${width}px`, height: `${height}px`, top: `${top}px`, left: `${left}px` });
  }

  /** DoAlignment: anchored right within 200 px of the right edge (or by the setting), left within 200 of the left,
   *  else centred; left moved by the drag's xDiff; kept on the screen; saved. */
  private doAlignment(xDiff: number): void {
    const config = this.current();
    const W = this.parent.clientWidth;
    const r = this.root.getBoundingClientRect(), p = this.parent.getBoundingClientRect();
    const absLeft = r.left - p.left, fromRightBorder = W - (r.right - p.left);
    const auto = this.alignment === "auto";
    let next: CombatBoxConfig;
    if ((auto && fromRightBorder < 200) || this.alignment === "right") {
      let left = config.align !== "TOPRIGHT" ? fromRightBorder : Math.max(0, config.left - xDiff);
      left = Math.max(Math.min(left, W - 100), 0);
      next = { align: "TOPRIGHT", textAlign: "right", left, topOffset: config.topOffset };
    } else if ((auto && absLeft < 200) || this.alignment === "left") {
      let left = config.align !== "TOPLEFT" ? absLeft : Math.max(0, config.left + xDiff);
      left = Math.max(Math.min(left, W - 100), 0);
      next = { align: "TOPLEFT", textAlign: "left", left, topOffset: config.topOffset };
    } else {
      let left = config.align !== "CENTERTOP" ? absLeft + r.width / 2 - W / 2 : config.left + xDiff;
      left = Math.min(Math.max(left, -(W - 100) / 2), (W - 100) / 2);
      next = { align: "CENTERTOP", textAlign: "center", left, topOffset: config.topOffset };
    }
    saveCombatBoxConfig(next);
  }

  /** EnterDragMode: the frame, the fill, the close button; the example text where no line is up. */
  private enterDragMode(): void {
    if (this.moving) return;
    this.moving = true;
    this.root.classList.add("moving");
    if (this.lines.length === 0) {
      this.fake = document.createElement("div");
      this.fake.className = "combat-msg-fake";
      this.fake.textContent = this.exampleText();
      this.root.appendChild(this.fake);
    }
    this.frame = document.createElement("div");
    this.frame.className = "combat-msg-frame";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "combat-msg-close";
    close.title = this.exitHint();
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", () => combatMovingMode.set(false));
    this.frame.appendChild(close);
    this.root.appendChild(this.frame);
    this.place();
  }

  /** ExitDragMode: the frame, fill, button and example text gone; saved. */
  private exitDragMode(): void {
    if (!this.moving) return;
    this.moving = false;
    this.root.classList.remove("moving");
    this.frame?.remove();
    this.frame = null;
    this.fake?.remove();
    this.fake = null;
    this.place();
  }

  /** BeginDrag / CalculateRepositioning: the top follows the mouse (fromTop kept), topOffset its bottom; DoAlignment. */
  private beginDrag(e: PointerEvent): void {
    if (!this.moving) return;
    e.preventDefault();
    const p = this.parent.getBoundingClientRect();
    const fromTop = this.root.getBoundingClientRect().top - e.clientY;
    let lastX = e.clientX;
    const onMove = (m: PointerEvent) => {
      const H = this.root.offsetHeight;
      const top = Math.max(MIN_TOP, m.clientY - p.top + fromTop);
      const xDiff = m.clientX - lastX;
      lastX = m.clientX;
      saveCombatBoxConfig({ ...this.current(), topOffset: top + H });
      this.doAlignment(xDiff);
    };
    const onUp = () => { removeEventListener("pointermove", onMove); removeEventListener("pointerup", onUp); };
    addEventListener("pointermove", onMove);
    addEventListener("pointerup", onUp);
  }

  dispose(): void {
    clearInterval(this.timer);
    removeEventListener("resize", this.onResize);
    for (const off of this.unsubscribe) off();
    this.root.remove();
  }
}
