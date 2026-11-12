// The client's graphics settings (evegraphics/settings.py: the device group's shaderQuality, postProcessingQuality,
// textureQuality, lodQuality, shadowQuality, aoQuality, volumetricQuality, reflectionQuality, antiAliasing; the ui
// group's turretsEnabled, effectsEnabled, missilesEnabled, explosionEffectsEnabled, droneModelsEnabled,
// cameraShakeEnabled) as the play page keeps them: in the browser's storage, the system menu writing them and the views
// reading them each frame. Defaults as a high-classification device gets them.

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
}

export const GFX_DEFAULTS: Readonly<GfxSettings> = {
  shaderQuality: 3, postProcessingQuality: 2, textureQuality: 0, lodQuality: 3, shadowQuality: 2, aoQuality: 3,
  volumetricQuality: 3, reflectionQuality: 3, turretsEnabled: true, effectsEnabled: true, missilesEnabled: true,
  explosionEffectsEnabled: true, droneModelsEnabled: true, cameraShakeEnabled: true,
};

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

/** The settings now. */
export function gfx(): Readonly<GfxSettings> {
  return current;
}

/** Settings changed (the menu's combos and checkboxes apply at once, as the client's OnGraphicsSettingCombo does). */
export function setGfx(change: Partial<GfxSettings>): void {
  current = { ...current, ...change };
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(current)); } catch { /* kept for this page only */ }
  for (const l of listeners) l(current);
}

/** ResetGraphicsSettings: every setting to its default. */
export function resetGfx(): void {
  setGfx({ ...GFX_DEFAULTS });
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
