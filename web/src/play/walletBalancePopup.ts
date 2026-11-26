import { formatWholeIsk } from "../ui/isk.ts";
import { placePointerPanel } from "./labelShortcutTooltip.ts";
import { playUiEvent } from "./uiAudio.ts";

export interface WalletBalanceUpdate {
  readonly balance: number;
  readonly difference: number;
  readonly balanceLabel: string;
  readonly creditLabel: string;
  readonly debitLabel: string;
}

const BATCH_DELAY = 500;
const COUNT_DELAY = 1000;
const LIFETIME = 5000;
const formatISK = (value: number) => formatWholeIsk(String(value), "round");

export class WalletBalancePopup {
  private waiting: WalletBalanceUpdate | null = null;
  private panel: HTMLElement | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly anchor: () => HTMLElement) {}

  add(change: WalletBalanceUpdate): void {
    this.waiting = { ...change, difference: (this.waiting?.difference ?? 0) + change.difference };
    if (this.panel || this.batchTimer !== null) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.showWaiting();
    }, BATCH_DELAY);
  }

  dispose(): void {
    if (this.batchTimer !== null) clearTimeout(this.batchTimer);
    if (this.countTimer !== null) clearTimeout(this.countTimer);
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.batchTimer = this.countTimer = this.closeTimer = null;
    this.waiting = null;
    this.panel?.remove();
    this.panel = null;
  }

  private showWaiting(): void {
    const change = this.waiting;
    this.waiting = null;
    if (!change) return;
    const anchor = this.anchor();
    if (!anchor.isConnected || !anchor.getBoundingClientRect().width) return;

    const panel = document.createElement("div");
    panel.className = "neocom-wallet-update";
    panel.setAttribute("role", "status");
    const row = (label: string, value: string) => {
      const text = document.createElement("strong");
      text.textContent = label;
      const amount = document.createElement("span");
      amount.textContent = value;
      panel.append(text, amount);
      return amount;
    };
    const credit = change.difference > 0;
    const prefix = credit ? "+" : "";
    const delta = row(credit ? change.creditLabel : change.debitLabel, prefix + formatISK(change.difference));
    delta.className = credit ? "wallet-credit" : "wallet-debit";
    const start = change.balance - change.difference;
    const balance = row(change.balanceLabel, formatISK(start));
    balance.className = "wallet-update-balance";
    balance.setAttribute("aria-live", "off");
    this.panel = panel;
    document.body.append(panel);
    placePointerPanel(panel, anchor.getBoundingClientRect(), "LEFT_2");
    panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    void playUiEvent(credit ? "ui_money_in2_play" : "ui_money_out_play");
    this.countTimer = setTimeout(() => {
      let step = 0;
      const countUp = () => {
        step++;
        balance.textContent = formatISK(start + change.difference * step / 20);
        this.countTimer = step < 20 ? setTimeout(countUp, 25) : null;
      };
      countUp();
    }, COUNT_DELAY);
    this.closeTimer = setTimeout(() => {
      panel.remove();
      this.closeTimer = null;
      this.panel = null;
      this.showWaiting();
    }, LIFETIME);
  }
}
