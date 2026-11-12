// The client's colour themes (eve/client/script/ui/shared/colorThemes.py COLOR_THEME_PRESETS): each a tint (the
// windows' background colour), focus and focus_dark (the selection and highlight colours), accent and alert.
// DEFAULT_COLORTHEMEID is Photon; ORE, SOE and Carbon are Omega-only in the client.

export interface ColorTheme {
  readonly id: string;
  readonly tint: string;
  readonly focus: string;
  readonly focusDark: string;
  readonly accent: string;
  readonly alert: string;
  readonly omegaOnly: boolean;
}

export const COLOR_THEMES: readonly ColorTheme[] = [
  { id: "UI/ColorThemes/Photon", tint: "#060a0c", focus: "#58A7BF", focusDark: "#305665", accent: "#58A7BF", alert: "#F39058", omegaOnly: false },
  { id: "UI/ColorThemes/Amarr", tint: "#07030d", focus: "#A38264", focusDark: "#7F6744", accent: "#FFEE93", alert: "#F39058", omegaOnly: false },
  { id: "UI/ColorThemes/Caldari", tint: "#030e0e", focus: "#9AD2E3", focusDark: "#5790A1", accent: "#48C7BF", alert: "#DC8C2E", omegaOnly: false },
  { id: "UI/ColorThemes/Gallente", tint: "#0A090F", focus: "#58BF9A", focusDark: "#479377", accent: "#6DB09E", alert: "#F39058", omegaOnly: false },
  { id: "UI/ColorThemes/Minmatar", tint: "#030909", focus: "#D05C3B", focusDark: "#9D452D", accent: "#9D452D", alert: "#F39058", omegaOnly: false },
  { id: "UI/ColorThemes/ORE", tint: "#030805", focus: "#DDB825", focusDark: "#8E7100", accent: "#55999C", alert: "#DE8B78", omegaOnly: true },
  { id: "UI/ColorThemes/SOE", tint: "#070d11", focus: "#E55252", focusDark: "#853C3C", accent: "#A1DDE0", alert: "#C0B337", omegaOnly: true },
  { id: "UI/ColorThemes/Carbon", tint: "#000000", focus: "#e5e5e5", focusDark: "#4d4d4d", accent: "#e0e0e0", alert: "#F39058", omegaOnly: true },
];
export const DEFAULT_COLORTHEMEID = "UI/ColorThemes/Photon";

export function colorTheme(id: string): ColorTheme {
  return COLOR_THEMES.find((t) => t.id === id) ?? COLOR_THEMES[0]!;
}

function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
}

/** carbonui Color.from_hsb(h, s * scale, b) of a colour: its saturation scaled, its hue and brightness kept. */
export function scaleSaturation(hex: string, scale: number): [number, number, number] {
  const [r, g, b] = rgbOf(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const v = max, s = max === 0 ? 0 : (max - min) / max;
  let h = 0;
  if (max !== min) {
    const d = max - min;
    h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  const s2 = Math.min(1, Math.max(0, s * scale));
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s2), q = v * (1 - f * s2), t = v * (1 - (1 - f) * s2);
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]!;
  return rgb.map((c) => Math.round(c * 255)) as [number, number, number];
}

/** A colour mixed toward white (the page's bright accent, made from the theme's focus). */
export function lighten(hex: string, amount: number): string {
  const [r, g, b] = rgbOf(hex).map((c) => Math.round((c + (1 - c) * amount) * 255));
  return `rgb(${r}, ${g}, ${b})`;
}
