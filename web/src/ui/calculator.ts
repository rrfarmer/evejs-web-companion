type Binary = "+" | "-" | "*" | "/";
const priority: Record<Binary, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
const isBinary = (key: string): key is Binary => key === "+" || key === "-" || key === "*" || key === "/";

/** The installed calculator displays up to fourteen fractional places. */
export function calculatorNumber(value: number): string {
  return String(Number(value.toFixed(14)));
}

export class Calculator {
  display = "0";
  private values: number[] = [];
  private operators: (Binary | "(")[] = [];
  private editing = false;
  private pending = false;

  recall(value: string): void {
    this.display = value;
    this.editing = true;
    this.pending = false;
  }

  press(key: string): void {
    if (/^[0-9.]$/.test(key)) {
      if (!this.editing) {
        if (!this.operators.length) this.values = [];
        this.display = "0";
      }
      if (key === "." && this.display.includes(".")) return;
      const replaceZero = this.display === "0" && key !== ".";
      this.recall(replaceZero ? key : this.display + key);
      return;
    }
    if (key === "clear" || key === "clearall") {
      if (key === "clearall") {
        this.values = [];
        this.operators = [];
        this.display = "0";
        this.editing = false;
        this.pending = false;
        return;
      }
      this.recall("0");
      return;
    }
    if (key === "negate") {
      this.recall(this.display.startsWith("-") ? this.display.slice(1) : "-" + this.display);
      return;
    }
    if (key === "(") {
      if (this.editing || (!this.pending && this.values.length)) this.press("*");
      this.operators.push("(");
      this.pending = true;
      return;
    }
    if (isBinary(key) && this.pending && isBinary(this.operators.at(-1) ?? "")) {
      this.operators[this.operators.length - 1] = key;
      return;
    }
    this.commitEntry();
    if (key === "square" || key === "root" || key === "percent") {
      const value = this.values.pop() ?? 0;
      const base = this.values.at(-1);
      this.values.push(key === "square" ? value ** 2 : key === "root" ? Math.sqrt(value)
        : (base ?? Number.NaN) * value / 100);
    } else if (isBinary(key)) {
      this.reduce(priority[key]);
      this.operators.push(key);
      this.pending = true;
    } else if (key === ")") {
      this.reduce(0);
      if (this.operators.at(-1) === "(") this.operators.pop();
    } else if (key === "=") {
      while (this.operators.length) {
        this.reduce(0);
        if (this.operators.at(-1) === "(") this.operators.pop();
      }
      this.pending = false;
    }
    const result = this.values.at(-1) ?? 0;
    if (!Number.isFinite(result)) {
      this.press("clearall");
      throw new Error("Invalid calculation");
    }
    this.display = calculatorNumber(result);
  }

  private commitEntry(): void {
    if (this.editing || this.values.length === 0) this.values.push(Number(this.display));
    this.editing = false;
  }

  private reduce(minimum: number): void {
    let op = this.operators.at(-1);
    while (op && op !== "(" && priority[op] >= minimum) {
      this.operators.pop();
      const right = this.values.pop() ?? 0;
      const left = this.values.pop() ?? right;
      const next = op === "+" ? left + right : op === "-" ? left - right : op === "*" ? left * right : left / right;
      this.values.push(next);
      op = this.operators.at(-1);
    }
  }
}
