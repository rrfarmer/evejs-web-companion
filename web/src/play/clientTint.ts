// The app's panels in the client's colours, in the play mode only (/fly). The app's design is navy: its panels,
// fields, lines and much of its text are low-saturation blues, some through the design system's variables (which
// play.css re-tints under .fly-windows), many through each panel family's own variables (--stn-*, --hangar-*) or
// colours written in its rules. The client's windows are neutral greys with colour kept for what it means.
//
// So: every style rule on the page that sets a navy colour (a custom property or a colour property, in hex or rgb)
// is copied under the play mode's window layer with that colour turned to the grey of the same luminance, keeping
// its alpha. Saturated colours (a bar's fill, a warning, the shield's blue) are left as they are. The copies are
// one stylesheet, made again when the page gains stylesheets (a panel's styles arrive with the panel).

type Rgba = [number, number, number, number];

function parseColour(value: string): Rgba | null {
  const v = value.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith("%") ? parseFloat(x) / 100 : Number(x)));
    if (p.length < 3 || p.some((x) => !Number.isFinite(x))) return null;
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  return null;
}

/**
 * The app's chrome blue: bluer than it is red, with little colour in it (chroma, max - min, under 70 of 255), or only a
 * faint wash of it. Its panels, lines and text are 20 to 55; what means something (an accent, a bar's fill, the
 * shield's blue) is 90 and up and seen at full strength.
 */
export function isNavy([r, g, b, a]: Rgba): boolean {
  if (b <= r + 8) return false;
  // a faint blue wash (a hover, a header's glow) is chrome whatever its hue: under a quarter opaque
  return Math.max(r, g, b) - Math.min(r, g, b) < 70 || a < 0.25;
}

/** The grey of the same luminance (Rec. 709), with the colour's alpha. */
export function neutral([r, g, b, a]: Rgba): string {
  const v = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  return a >= 1 ? `rgb(${v}, ${v}, ${v})` : `rgba(${v}, ${v}, ${v}, ${+a.toFixed(3)})`;
}

/** A value with each navy colour in it (hex or rgb/rgba) turned grey; null where it has none. */
export function neutralInValue(value: string): string | null {
  let changed = false;
  const out = value.replace(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi, (token) => {
    const colour = parseColour(token);
    if (!colour || !isNavy(colour)) return token;
    changed = true;
    return neutral(colour);
  });
  return changed ? out : null;
}

/** Each selector of a list under the scope; none for the document's own (:root, html, body) or a nested one. */
function scoped(selectorText: string, scope: string): string | null {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < selectorText.length; i++) {
    const c = selectorText[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) { parts.push(selectorText.slice(start, i)); start = i + 1; }
  }
  parts.push(selectorText.slice(start));
  const out = parts.map((s) => s.trim()).filter((s) => s && !s.includes("&") && !/^(:root|html|body)\b/.test(s) && !s.startsWith(scope)).map((s) => `${scope} ${s}`);
  return out.length ? out.join(", ") : null;
}

/** The copies, as one stylesheet's text. */
export function clientTintCss(sheets: Iterable<CSSStyleSheet>, scope = ".fly-windows", skip?: CSSStyleSheet | null): string {
  const out: string[] = [];
  const walk = (rules: CSSRuleList, wrap: (css: string) => string) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const decls: string[] = [];
        for (let i = 0; i < rule.style.length; i++) {
          const prop = rule.style[i]!;
          if (!prop.startsWith("--") && !/color$|^background-image$|shadow$/.test(prop)) continue;
          // a whole colour, or the colours inside a gradient or a shadow, each turned grey where it is navy
          const value = rule.style.getPropertyValue(prop);
          const turned = neutralInValue(value);
          if (turned === null) continue;
          decls.push(`${prop}: ${turned}${rule.style.getPropertyPriority(prop) ? " !important" : ""};`);
        }
        const selector = decls.length ? scoped(rule.selectorText, scope) : null;
        if (selector) out.push(wrap(`${selector} { ${decls.join(" ")} }`));
      } else if (rule instanceof CSSMediaRule) {
        walk(rule.cssRules, (css) => wrap(`@media ${rule.conditionText} { ${css} }`));
        continue;
      }
      const inner = (rule as CSSGroupingRule).cssRules;
      if (inner && !(rule instanceof CSSMediaRule)) walk(inner, wrap);
    }
  };
  for (const sheet of sheets) {
    if (sheet === skip) continue;
    try { walk(sheet.cssRules, (css) => css); } catch { /* another origin's sheet: not ours to read */ }
  }
  return out.join("\n");
}

/** Keep the copies on the page while the play mode is up; the returned function takes them away. */
export function applyClientTint(scope = ".fly-windows"): () => void {
  const style = document.createElement("style");
  style.id = "client-tint";
  document.head.appendChild(style);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let count = -1;
  const build = () => {
    timer = null;
    const sheets = Array.from(document.styleSheets);
    if (sheets.length === count) return;
    count = sheets.length;
    style.textContent = clientTintCss(sheets, scope, style.sheet);
    // the tint's own sheet is one of them: counted after it is written
    count = document.styleSheets.length;
  };
  build();
  const observer = new MutationObserver(() => { if (timer === null) timer = setTimeout(build, 100); });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => { observer.disconnect(); if (timer !== null) clearTimeout(timer); style.remove(); };
}
