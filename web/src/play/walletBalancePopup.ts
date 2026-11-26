import { formatWholeIsk } from "../ui/isk.ts";
import { placePointerPanel } from "./labelShortcutTooltip.ts";
import { playUiEvent } from "./uiAudio.ts";

export type WalletBalanceChange = {
  readonly balance: number;
  readonly difference: number;
  readonly balanceLabel: string;
} & ({ readonly currency: "ISK" | "PLEX" } | {
  readonly currency: "LP";
  readonly issuerID: number;
  readonly format: (value: number) => string;
});

export type WalletBalanceUpdate = WalletBalanceChange & {
  readonly creditLabel: string;
  readonly debitLabel: string;
};

const BATCH_DELAY = 500;
const COUNT_DELAY = 1000;
const LIFETIME = 5000;
const DISPLAY_ORDER = { ISK: 0, PLEX: 1, LP: 2 };

function formatAmount(value: number, change: WalletBalanceChange): string {
  if (change.currency === "LP") return change.format(value);
  if (change.currency === "ISK") return formatWholeIsk(String(value), "round");
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 0 })} PLEX`;
}

export class WalletBalancePopup {
  private readonly waiting = new Map<"ISK" | "PLEX" | number, WalletBalanceUpdate>();
  private panel: HTMLElement | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly anchor: () => HTMLElement) {}

  add(change: WalletBalanceUpdate): void {
    const key = change.currency === "LP" ? change.issuerID : change.currency;
    const previous = this.waiting.get(key);
    this.waiting.set(key, { ...change, difference: (previous?.difference ?? 0) + change.difference });
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
    const transactions = [...this.waiting.values()].sort((a, b) => DISPLAY_ORDER[a.currency] - DISPLAY_ORDER[b.currency]);
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
      delta.amount.textContent = (credit ? "+" : "") + formatAmount(change.difference, change);
      delta.amount.className = credit ? "wallet-credit" : "wallet-debit";
    };
    announce(first);
    const balances = transactions.map(change => {
      const start = change.balance - change.difference;
      const balance = row(change.balanceLabel, formatAmount(start, change)).amount;
      balance.className = "wallet-update-balance";
      balance.setAttribute("aria-live", "off");
      return { change, start, balance };
    });
    this.panel = panel;
    document.body.append(panel);
    placePointerPanel(panel, anchor.getBoundingClientRect(), "LEFT_2");
    panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    const direction = first.currency === "ISK" ? first.difference : transactions.reduce((sum, change) => sum + change.difference, 0);
    void playUiEvent(direction > 0 ? "ui_money_in2_play" : "ui_money_out_play");
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
        balance.textContent = formatAmount(start + change.difference * step / 20, change);
        this.countTimer = setTimeout(step < 20 ? countUp : () => animateBalance(index + 1), 25);
      };
      countUp();
    };
    this.countTimer = setTimeout(() => animateBalance(0), COUNT_DELAY);
    this.closeTimer = setTimeout(() => {
      panel.remove();
      if (this.countTimer !== null) clearTimeout(this.countTimer);
      this.countTimer = null;
      this.closeTimer = null;
      this.panel = null;
      this.showWaiting();
    }, LIFETIME);
  }
}
