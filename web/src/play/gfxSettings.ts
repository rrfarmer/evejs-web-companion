// The client's graphics settings (evegraphics/settings.py: the device group's shaderQuality, postProcessingQuality,
// textureQuality, lodQuality, shadowQuality, aoQuality, volumetricQuality, reflectionQuality, antiAliasing; the ui
// group's turretsEnabled, effectsEnabled, missilesEnabled, explosionEffectsEnabled, droneModelsEnabled,
// cameraShakeEnabled) as the play page keeps them: in the browser's storage, the system menu writing them and the views
// reading them each frame. Defaults as a high-classification device gets them.

import { colorTheme, DEFAULT_COLORTHEMEID, lighten, scaleSaturation } from "./colorThemes.ts";

export interface GfxSettings {
  /** 1 low (SM_3_0_LO), 2 medium (SM_3_0_HI), 3 high (SM_3_0_DEPTH): device.GetShaderModelForShaderQuality. */
  shaderQuality: 1 | 2 | 3;
  /** 0 low (the post-process off: PostProcess.IsDisabled), 1 medium, 2 high. */
  postProcessingQuality: 0 | 1 | 2;
  /** 0 high, 1 medium, 2 low (the mip dropped). */
  textureQuality: 0 | 1 | 2;
  /** 1 low, 2 medium, 3 high (LOD_SETTINGS). */
  lodQuality: 1 | 2 | 3;
  /** 0 disabled, 1 low, 2 high (3 ray-traced: not offered here). */
  shadowQuality: 0 | 1 | 2;
  /** 0 off, 1 low, 2 medium, 3 high. */
  aoQuality: 0 | 1 | 2 | 3;
  volumetricQuality: 1 | 2 | 3 | 4;
  reflectionQuality: 1 | 2 | 3 | 4;
  turretsEnabled: boolean;
  effectsEnabled: boolean;
  missilesEnabled: boolean;
  explosionEffectsEnabled: boolean;
  droneModelsEnabled: boolean;
  cameraShakeEnabled: boolean;
  /** uiColorSettings.show_window_bg_blur_setting (enableWindowBlur, default on). */
  windowBlur: boolean;
  /** window_transparency_setting (0 .. 1, default 1): with the blur. */
  windowTransparency: number;
  /** window_transparency_noblur_setting (0 .. 1, default 0.05): without it. */
  windowTransparencyNoBlur: number;
  /** uiColorSvc's theme (settings.char.windows wndColorThemeID; colorThemes.DEFAULT_COLORTHEMEID Photon). */
  colorThemeID: string;
  /** The Audio panel (settings.public.audio): audioEnabled, masterVolume 0.8, uiGain 0.5, eveampGain (music) 0.5,
   *  evevoiceGain 0.7, worldVolume 0.7 - the client's defaults; useCombatMusic (audioSvc.GetCombatMusicUsage: 1). */
  audioEnabled: boolean;
  useCombatMusic: boolean;
  masterVolume: number;
  uiGain: number;
  eveampGain: number;
  evevoiceGain: number;
  worldVolume: number;
}

export const GFX_DEFAULTS: Readonly<GfxSettings> = {
  shaderQuality: 3, postProcessingQuality: 2, textureQuality: 0, lodQuality: 3, shadowQuality: 2, aoQuality: 3,
  volumetricQuality: 3, reflectionQuality: 3, turretsEnabled: true, effectsEnabled: true, missilesEnabled: true,
  explosionEffectsEnabled: true, droneModelsEnabled: true, cameraShakeEnabled: true,
  windowBlur: true, windowTransparency: 1, windowTransparencyNoBlur: 0.05, colorThemeID: DEFAULT_COLORTHEMEID,
  audioEnabled: true, useCombatMusic: true, masterVolume: 0.8, uiGain: 0.5, eveampGain: 0.5, evevoiceGain: 0.7, worldVolume: 0.7,
};

import { setMipLevelSkipCount } from "../three/ddsTexture.ts";

const KEY = "evejs.play.gfxSettings";
type Listener = (settings: Readonly<GfxSettings>) => void;
const listeners = new Set<Listener>();

function load(): GfxSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<GfxSettings>;
      const merged = { ...GFX_DEFAULTS } as Record<string, unknown>;
      for (const k of Object.keys(GFX_DEFAULTS)) {
        const v = (stored as Record<string, unknown>)[k];
        if (typeof v === typeof (GFX_DEFAULTS as Record<string, unknown>)[k]) merged[k] = v;
      }
      return merged as unknown as GfxSettings;
    }
  } catch { /* storage refused: the defaults */ }
  return { ...GFX_DEFAULTS };
}

let current: GfxSettings = load();
// device.py ApplySettings: trinity.device.mipLevelSkipCount = textureQuality (textures loaded after it take it)
setMipLevelSkipCount(current.textureQuality);
applyWindowAppearance(current);

/** The settings now. */
export function gfx(): Readonly<GfxSettings> {
  return current;
}

/** Settings changed (the menu's combos and checkboxes apply at once, as the client's OnGraphicsSettingCombo does). */
export function setGfx(change: Partial<GfxSettings>): void {
  current = { ...current, ...change };
  setMipLevelSkipCount(current.textureQuality);
  applyWindowAppearance(current);
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(current)); } catch { /* kept for this page only */ }
  for (const l of listeners) l(current);
}

/** ResetGraphicsSettings: every setting to its default. */
export function resetGfx(): void {
  // (the graphics only: the window appearance is the User Interface panel's)
  const { windowBlur: _b, windowTransparency: _t, windowTransparencyNoBlur: _n, colorThemeID: _c, audioEnabled: _a,
    masterVolume: _m, uiGain: _u, eveampGain: _e, evevoiceGain: _v, worldVolume: _w, ...graphics } = GFX_DEFAULTS;
  setGfx(graphics);
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/**
 * carbonui BlurredSceneUnderlay, every window's background: with the blur (enableWindowBlur, and the shader quality
 * above low: _IsBlurEnabled) the scene behind blurred at the brightness lerp(0, 0.2 focused / 0.3 not, transparency);
 * without it a fill of DEFAULT_BRIGHTNESS 0.04 at the opacity lerp(1, 0.95 focused / 0.75 not, transparency).
 */
export function windowAppearance(s: Readonly<GfxSettings> = current): { blur: boolean; bg: string; bgFocused: string; backdrop: string; backdropFocused: string } {
  const blur = s.windowBlur && s.shaderQuality > 1;
  if (blur) {
    const t = Math.min(1, Math.max(0, s.windowTransparency));
    return { blur, bg: "transparent", bgFocused: "transparent",
      backdrop: `blur(6px) brightness(${lerp(0, 0.3, t).toFixed(3)})`, backdropFocused: `blur(6px) brightness(${lerp(0, 0.2, t).toFixed(3)})` };
  }
  const t = Math.min(1, Math.max(0, s.windowTransparencyNoBlur));
  // UpdateColor: the fill is the theme's tint, its saturation scaled by SATURATION_MULTIPLIER_MAX 0.3 (+ 0.7 x the
  // transparency, which is 0 without the blur)
  const [r, g, b] = scaleSaturation(colorTheme(s.colorThemeID).tint, 0.3);
  return { blur, backdrop: "none", backdropFocused: "none",
    bg: `rgba(${r}, ${g}, ${b}, ${lerp(1, 0.75, t).toFixed(3)})`, bgFocused: `rgba(${r}, ${g}, ${b}, ${lerp(1, 0.95, t).toFixed(3)})` };
}

function applyWindowAppearance(s: Readonly<GfxSettings>): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  const a = windowAppearance(s);
  root.style.setProperty("--win-bg", a.bg);
  root.style.setProperty("--win-bg-focused", a.bgFocused);
  root.style.setProperty("--win-backdrop", a.backdrop);
  root.style.setProperty("--win-backdrop-focused", a.backdropFocused);
  // the theme's colours for the page's chrome (play.css: the accent is its focus, the dim its focus_dark)
  const theme = colorTheme(s.colorThemeID);
  root.style.setProperty("--theme-focus", theme.focus);
  root.style.setProperty("--theme-focus-dark", theme.focusDark);
  root.style.setProperty("--theme-focus-bright", theme.id === DEFAULT_COLORTHEMEID ? "#8fd0e6" : lighten(theme.focus, 0.4));
  root.style.setProperty("--theme-accent", theme.accent);
  root.style.setProperty("--theme-alert", theme.alert);
  root.style.setProperty("--theme-tint", theme.tint);
}

export function onGfx(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * sceneRenderJobSpace.GetSpaceRenderingSettingsFromClientSettings: distortion and the dynamic lights only at high
 * shader quality; no ambient occlusion or reflections at low.
 */
export function spaceRendering(s: Readonly<GfxSettings> = current): { postProcess: boolean; distortion: boolean; shadows: boolean } {
  // (the shadow quality's combo is disabled at low shader quality: no shadows there)
  return { postProcess: s.postProcessingQuality !== 0, distortion: s.shaderQuality === 3, shadows: s.shadowQuality !== 0 && s.shaderQuality !== 1 };
}
