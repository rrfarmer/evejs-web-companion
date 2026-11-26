import { formatWholeIsk } from "../ui/isk.ts";
import { placePointerPanel } from "./labelShortcutTooltip.ts";
import { playUiEvent } from "./uiAudio.ts";

export interface WalletBalanceUpdate {
  readonly currency: "ISK" | "PLEX";
  readonly balance: number;
  readonly difference: number;
  readonly balanceLabel: string;
  readonly creditLabel: string;
  readonly debitLabel: string;
}

const BATCH_DELAY = 500;
const COUNT_DELAY = 1000;
const LIFETIME = 5000;
const formatAmount = (value: number, currency: WalletBalanceUpdate["currency"]) => currency === "ISK"
  ? formatWholeIsk(String(value), "round")
  : `${value.toLocaleString("en-US", { maximumFractionDigits: 0 })} PLEX`;

export class WalletBalancePopup {
  private readonly waiting = new Map<WalletBalanceUpdate["currency"], WalletBalanceUpdate>();
  private panel: HTMLElement | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly anchor: () => HTMLElement) {}

  add(change: WalletBalanceUpdate): void {
    const previous = this.waiting.get(change.currency);
    this.waiting.set(change.currency, { ...change, difference: (previous?.difference ?? 0) + change.difference });
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
    this.waiting.clear();
    this.panel?.remove();
    this.panel = null;
  }

  private showWaiting(): void {
    const transactions = (["ISK", "PLEX"] as const).flatMap(currency => {
      const value = this.waiting.get(currency);
      return value ? [value] : [];
    });
    this.waiting.clear();
    const first = transactions[0];
    if (!first) return;
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
      return { text, amount };
    };
    const delta = row("", "");
    const announce = (change: WalletBalanceUpdate) => {
      const credit = change.difference > 0;
      delta.text.textContent = credit ? change.creditLabel : change.debitLabel;
      delta.amount.textContent = (credit ? "+" : "") + formatAmount(change.difference, change.currency);
      delta.amount.className = credit ? "wallet-credit" : "wallet-debit";
    };
    announce(first);
    const balances = transactions.map(change => {
      const start = change.balance - change.difference;
      const balance = row(change.balanceLabel, formatAmount(start, change.currency)).amount;
      balance.className = "wallet-update-balance";
      balance.setAttribute("aria-live", "off");
      return { change, start, balance };
    });
    this.panel = panel;
    document.body.append(panel);
    placePointerPanel(panel, anchor.getBoundingClientRect(), "LEFT_2");
    panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    void playUiEvent(first.difference > 0 ? "ui_money_in2_play" : "ui_money_out_play");
    const animateBalance = (index: number) => {
      const item = balances[index];
      if (!item) {
        this.countTimer = null;
        return;
      }
      const { change, start, balance } = item;
      if (index > 0) announce(change);
      let step = 0;
      const countUp = () => {
        step++;
        balance.textContent = formatAmount(start + change.difference * step / 20, change.currency);
        this.countTimer = setTimeout(step < 20 ? countUp : () => animateBalance(index + 1), 25);
      };
      countUp();
    };
    this.countTimer = setTimeout(() => animateBalance(0), COUNT_DELAY);
    this.closeTimer = setTimeout(() => {
      panel.remove();
      this.closeTimer = null;
      this.panel = null;
      this.showWaiting();
    }, LIFETIME);
  }
}
