// Numbers as the client's Python 2.7 and its native localization write them, measured in the client's own
// python27.dll and _evelocalization.dll (scripts/py27-oracle.py).
//
// A Python float and a Python int are written differently (str(5.0) is "5.0", str(5) is "5"; FormatNumeric writes an
// int whole whatever places it is asked for), and a JavaScript number cannot say which it was. So each writer here is
// told: the float ones take a number as a float, and an int is passed as `{ int: n }` where the client's value is one.

/** A Python int (int or long), as opposed to a float. */
export interface PyInt {
  readonly int: number;
}

export type PyNumber = number | PyInt;

export const isPyInt = (value: PyNumber): value is PyInt => typeof value === "object";

/**
 * str(float) in Python 2.7 (float_str: twelve figures, 'g', with ".0" put on where it looks whole, and so written with
 * an exponent from eleven figures before the point, one sooner than '%.12g'): 0.30000000000000004 is "0.3", 45.0
 * "45.0", 1e16 "1e+16", 1.23456789012345 "1.23456789012", 123456789012.5 "1.23456789012e+11". Where a 13th figure is
 * exactly 5 the client rounds to even and this rounds up; no number the page writes has one.
 */
export function pyStrFloat(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa, exponentText] = value.toExponential(11).split("e");
  const exponent = Number(exponentText);
  const sign = mantissa!.startsWith("-") ? "-" : "";
  const digits = mantissa!.replace("-", "").replace(".", "");
  if (exponent < -4 || exponent >= 11) {
    const kept = digits.replace(/0+$/, "");
    const written = kept.length > 1 ? `${kept[0]}.${kept.slice(1)}` : kept;
    return `${sign}${written}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  let whole: string;
  let fraction: string;
  if (exponent >= 0) {
    whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
    fraction = digits.slice(exponent + 1);
  } else {
    whole = "0";
    fraction = "0".repeat(-exponent - 1) + digits;
  }
  fraction = fraction.replace(/0+$/, "");
  return `${sign}${whole}.${fraction === "" ? "0" : fraction}`;
}

/** str() of a Python number: an int as itself, a float as Python 2.7 writes one. */
export function pyStr(value: PyNumber | null): string {
  if (value === null) return "None";
  return isPyInt(value) ? String(Math.trunc(value.int)) : pyStrFloat(value);
}

/**
 * round(value, places) in Python 2.7: correctly rounded from the float's exact value, a half away from nought
 * (round(2.675, 2) is 2.67, round(0.125, 2) 0.13, round(2.5) 3.0); a float.
 */
export function pyRound(value: number, places = 0): number {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21 || places > 100) return value;
  if (places < 0) {
    const size = 10 ** -places;
    return Number((value / size).toFixed(0)) * size;
  }
  return Number(value.toFixed(places));
}

function grouped(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * eveLocalization.FormatNumeric(value, useGrouping, decimalPlaces) (localization/formatters/numericFormatters.py,
 * the client's _evelocalization.dll), as measured: an int written whole, whatever places are asked for; a float to
 * `decimalPlaces` places (two where none are given), its value times ten to the places rounded a half away from
 * nought (1.005 to two places is "1.00", 0.015 "0.02", 0.125 "0.13", 2.5 to none "3"), a minus kept on a negative that
 * rounds to nought (-0.001 is "-0.00") and none on -0.0; grouped by commas where asked.
 */
export function formatNumeric(value: PyNumber, options: { readonly useGrouping?: boolean; readonly decimalPlaces?: number | null } = {}): string {
  const group = options.useGrouping === true;
  if (isPyInt(value)) {
    const whole = Math.trunc(value.int);
    const digits = String(Math.abs(whole));
    return `${whole < 0 ? "-" : ""}${group ? grouped(digits) : digits}`;
  }
  if (!Number.isFinite(value)) return String(value);
  const places = options.decimalPlaces ?? 2;
  const scaled = Math.round(Math.abs(value) * 10 ** places);
  const digits = BigInt(scaled).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${value < 0 ? "-" : ""}${group ? grouped(whole) : whole}${places > 0 ? `.${fraction}` : ""}`;
}

/** format.FmtAmt(amount) (carbon/common/script/util/format.py 137 to 151, its 'ln' form): long(amount), grouped. */
export function fmtAmt(amount: number | null): string {
  return formatNumeric({ int: Math.trunc(amount ?? 0) }, { useGrouping: true, decimalPlaces: 0 });
}

/**
 * format.FmtAmt(amount, 'ss') (its short form): under 10,000 grouped; else to 2 places in thousands under 100,000 (K),
 * millions under 1e8 (M), billions under 1e11 (B), trillions (T) (FmtThousandShort etc.) - the client: 12345 "12.35K",
 * 99999 "100.00K", 123456 "0.12M", 123456789 "0.12B".
 */
export function fmtAmtShort(amount: number | null): string {
  const amt = Math.trunc(amount ?? 0);
  const val = Math.abs(amt);
  if (val < 10_000) return fmtAmt(amt);
  const [div, unit] = val < 100_000 ? [1e3, "K"] : val < 1e8 ? [1e6, "M"] : val < 1e11 ? [1e9, "B"] : [1e12, "T"];
  return `${formatNumeric(amt / div, { useGrouping: true, decimalPlaces: 2 })}${unit}`;
}
