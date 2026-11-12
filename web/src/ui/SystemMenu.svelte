<script lang="ts">
  // The client's system menu (shared/systemMenu/systemmenu.py SystemMenu, opened by Esc: uicore.cmd.OnEsc). A layer
  // over the whole view, the scene blurred under it; its content centred, 40% of the width (at least WIDTH 1024, at
  // most 1200): the top 64 (the settings window icon at 32, "Settings" at 68, the close button at the right), the
  // bottom 96 (Return to Game, Log Off / Safe Logoff, Quit Game at the right), between them the tree of panels 300 wide
  // (NAME_BY_PANELID, in GetPanelData's order) and the panel chosen at 32 beside it. Display & Graphics: Display Setup
  // (the window mode), Graphics Content Settings (its description, then the combos - label 300 wide, padBottom 8 -
  // anti-aliasing, post processing, shader, texture, LOD, shadow, ambient occlusion, volumetrics, reflection), the
  // Brightness / Optimize Settings / Reset Graphic Settings buttons, Effects (the checkboxes). Camera: the camera
  // shake. The settings are the play page's (gfxSettings.ts) and apply at once.
  import { onMount } from "svelte";
  import { plainText } from "../bridge/clientWords.ts";
  import { gfx, setGfx, resetGfx, onGfx, type GfxSettings } from "../play/gfxSettings.ts";
  import { CLIENT_SHORTCUTS } from "../play/clientShortcuts.ts";
  import { COLOR_THEMES } from "../play/colorThemes.ts";
  import { playUiEvent } from "../play/uiAudio.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, onClose }: { store: ClientStore; flow: AppFlow; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const P = "UI/SystemMenu/DisplayAndGraphics/";
  const G = `${P}GraphicContentSettings/`;
  const PANELS = [
    ["displayandgraphics", "UI/SystemMenu/DisplayAndGraphics/Header", "Display & Graphics"],
    ["camera", "UI/SystemMenu/Camera/Header", "Camera"],
    ["audio", "UI/SystemMenu/AudioAndChat/AudioHeader", "Audio"],
    ["generic", "UI/SystemMenu/GeneralSettings/Header", "User Interface"],
    ["gameplay", "UI/SystemMenu/Gameplay/Header", "Gameplay"],
    ["shortcuts", "UI/SystemMenu/Shortcuts/Header", "Shortcuts"],
    ["reset settings", "UI/SystemMenu/ResetSettings/Header", "Reset Settings"],
    ["language", "UI/SystemMenu/Language/Header", "Language"],
    ["about eve", "UI/SystemMenu/AboutEve/Header", "About EVE"],
  ] as const;
  // systemMenuConst PANEL_IDS_SHORTCUTS: the Shortcuts node's branch (ConstructShortcutsTreeBranch)
  const SHORTCUT_PANELS = [
    ["window", "UI/SystemMenu/Shortcuts/WindowTab", "Window"], ["combat", "UI/SystemMenu/Shortcuts/CombatTab", "Combat"],
    ["general", "UI/SystemMenu/Shortcuts/GeneralTab", "General"], ["navigation", "UI/SystemMenu/Shortcuts/NavigationTab", "Navigation"],
    ["modules", "UI/SystemMenu/Shortcuts/ModulesTab", "Modules"], ["drones", "UI/SystemMenu/Shortcuts/DronesTab", "Drones"],
    ["fighters", "UI/Common/Fighters", "Fighters"], ["charactercreator", "UI/CharacterCreation", "Character Creation"],
  ] as const;
  const Q = { low: `${P}Common/LowQuality`, medium: `${P}Common/MediumQuality`, high: `${P}Common/HighQuality`, ultra: `${P}Common/UltraQuality`, disabled: `${P}Common/Disabled` };
  type Key = keyof GfxSettings;
  // graphicsOptionsConst.py's options, in its order
  const COMBOS: { key: Key; label: string; own: string; options: [string, number][] }[] = [
    { key: "postProcessingQuality", label: `${G}PostProcessing`, own: "Post Processing", options: [[Q.low, 0], [Q.medium, 1], [Q.high, 2]] },
    { key: "shaderQuality", label: `${G}ShaderQuality`, own: "Shader Quality", options: [[Q.low, 1], [Q.medium, 2], [Q.high, 3]] },
    { key: "textureQuality", label: `${G}TextureQuality`, own: "Texture Quality", options: [[Q.low, 2], [Q.medium, 1], [Q.high, 0]] },
    { key: "lodQuality", label: `${G}LODQuality`, own: "LOD Quality", options: [[Q.low, 1], [Q.medium, 2], [Q.high, 3]] },
    { key: "shadowQuality", label: `${G}ShadowQuality`, own: "Shadow Quality", options: [[Q.disabled, 0], [Q.low, 1], [Q.high, 2]] },
    { key: "aoQuality", label: `${G}AOQuality`, own: "Ambient Occlusion", options: [[Q.disabled, 0], [Q.low, 1], [Q.medium, 2], [Q.high, 3]] },
    { key: "volumetricQuality", label: `${G}VolumetricsQuality`, own: "Volumetrics Quality", options: [[Q.low, 1], [Q.medium, 2], [Q.high, 3], [Q.ultra, 4]] },
    { key: "reflectionQuality", label: `${G}ReflectionQuality`, own: "Reflection Quality", options: [[Q.low, 1], [Q.medium, 2], [Q.high, 3], [Q.ultra, 4]] },
  ];
  const EFFECTS: { key: Key; label: string; own: string }[] = [
    { key: "turretsEnabled", label: `${P}Effects/TurretEffects`, own: "Turret Effects" },
    { key: "effectsEnabled", label: `${P}Effects/Effects`, own: "Effects" },
    { key: "missilesEnabled", label: `${P}Effects/MissileEffects`, own: "Missile Effects" },
    { key: "explosionEffectsEnabled", label: `${P}Effects/ShipExplosions`, own: "Ship Explosions" },
    { key: "droneModelsEnabled", label: `${P}Effects/DroneModels`, own: "Drone Models" },
  ];
  const WORDS = {
    settings: "UI/Common/Settings", returnToGame: "UI/SystemMenu/ReturnToGame", logOff: "UI/SystemMenu/LogOff", quit: "UI/SystemMenu/QuitGame",
    displaySetup: `${P}DisplaySetup/Header`, windowed: `${P}DisplaySetup/WindowedOrFullscreen`, windowMode: "/Carbon/UI/Service/Device/WindowMode",
    fullScreen: "/Carbon/UI/Service/Device/FullScreen", contentHeader: `${G}Header`, contentDescription: `${G}Description`,
    antiAliasing: `${G}AntiAliasing`, brightness: `${G}Brightness`, optimize: `${G}OptimizeSettings`, reset: `${G}ResetGraphicSettings`,
    effects: `${P}Effects/Header`, cameraHeader: `${P}CameraSettings/InSpaceCameraSettings`, cameraShake: `${P}Effects/CameraShake`,
    windowAppearance: "UI/SystemMenu/GeneralSettings/WindowAppearance", windowBlur: "UI/SystemMenu/GeneralSettings/General/EnableWindowBlur",
    blurDisabledHint: "UI/SystemMenu/GeneralSettings/WindowBlurDisabledHint", transparency: "UI/SystemMenu/GeneralSettings/Transparency",
    off: `${P}Common/Off`, fullTransparency: "UI/SystemMenu/GeneralSettings/FullTransparency",
    filter: "UI/Inventory/Filter", command: "UI/SystemMenu/Shortcuts/Command", shortcut: "UI/SystemMenu/Shortcuts/Shortcut",
    noShortcut: "UI/SystemMenu/Shortcuts/NoShortcut", noneFound: "UI/SystemMenu/Shortcuts/NoShortcutsFoundWithFilter",
    editShortcut: "UI/SystemMenu/Shortcuts/EditShortcut", clearShortcut: "UI/SystemMenu/Shortcuts/ClearShortcut",
    defaultShortcuts: "UI/SystemMenu/Shortcuts/DefaultShortcuts",
    colorTheme: "UI/SystemMenu/GeneralSettings/ColorTheme", shipTheme: "UI/SystemMenu/GeneralSettings/General/ShipTheme",
    presets: "UI/SystemMenu/GeneralSettings/ColorTheme/Presets",
    audioEngine: "UI/SystemMenu/AudioAndChat/AudioEngine/Header", audioEnabled: "UI/SystemMenu/AudioAndChat/AudioEngine/AudioEnabled",
    useCombatMusic: "UI/SystemMenu/AudioAndChat/AudioEngine/UseCombatMusic",
    suppressTurret: "UI/SystemMenu/AudioAndChat/VolumeLevel/SuppressTurretSounds",
    oldJukebox: "UI/SystemMenu/AudioAndChat/AudioEngine/OldJukeboxOverride",
    volumeHeader: "UI/SystemMenu/AudioAndChat/VolumeLevel/Header",
  } as const;
  // LoadAudio's volume sliders: the setting, its label, the client's default
  const VOLUMES = [
    ["masterVolume", "UI/SystemMenu/AudioAndChat/VolumeLevel/MasterLevel", "Master Level"],
    ["eveampGain", "UI/SystemMenu/AudioAndChat/VolumeLevel/MusicLevel", "Music Level"],
    ["uiGain", "UI/SystemMenu/AudioAndChat/VolumeLevel/UISoundLevel", "UI Sound Level"],
    ["evevoiceGain", "UI/SystemMenu/AudioAndChat/VolumeLevel/UIVoiceLevel", "UI Voice Level"],
    ["worldVolume", "UI/SystemMenu/AudioAndChat/VolumeLevel/WorldLevel", "World Level"],
  ] as const;
  const word = (label: string, own: string): string => {
    const t = $words.templates[label];
    return typeof t === "string" && t !== "" ? plainText(t) : own;
  };

  let panel = $state<string>("displayandgraphics");
  let settings = $state<GfxSettings>({ ...gfx() });
  let fullScreen = $state(typeof document !== "undefined" && document.fullscreenElement !== null);
  onMount(() => {
    flow.requestWords([...Object.values(WORDS), ...PANELS.map((p) => p[1]), ...SHORTCUT_PANELS.map((p) => p[1]), ...Object.values(Q),
      ...COMBOS.map((c) => c.label), ...EFFECTS.map((e) => e.label), ...COLOR_THEMES.map((t) => t.id), ...VOLUMES.map((v) => v[1])]);
    const off = onGfx((s) => { settings = { ...s }; });
    const onFull = () => { fullScreen = document.fullscreenElement !== null; };
    document.addEventListener("fullscreenchange", onFull);
    return () => { off(); document.removeEventListener("fullscreenchange", onFull); };
  });
  /** The Shortcuts panel: the Shortcuts node itself shows General (LoadPanel: LoadShortcuts(PANELID_SHORTCUTS_GENERAL)). */
  const shortcutKey = $derived(panel === "shortcuts" ? "general" : SHORTCUT_PANELS.some((p) => p[0] === panel) ? panel : null);
  let shortcutFilter = $state("");
  let shortcutsAsked = false;
  $effect(() => {
    if (shortcutKey === null || shortcutsAsked) return;
    shortcutsAsked = true;
    flow.requestWords([...new Set(CLIENT_SHORTCUTS.map((c) => c.label).filter((l): l is string => l !== null))]);
  });
  /**
   * _PopulateShortcutsScroll: the category's commands, or with a filter every command whose description holds it;
   * each "description<t>shortcut" (NoShortcut where it has none). The description: the command's name label, else its
   * function's name (FuncToDesc).
   */
  const shortcutRows = $derived.by(() => {
    if (shortcutKey === null) return [];
    const filterText = shortcutFilter.trim().toLowerCase();
    return CLIENT_SHORTCUTS.filter((c) => filterText !== "" || c.category === shortcutKey)
      .map((c) => ({ cmd: c.cmd, description: c.label ? word(c.label, c.cmd) : c.cmd, keys: c.keys, locked: c.locked === true }))
      .filter((c) => filterText === "" || c.description.toLowerCase().includes(filterText));
  });
  /** CloseMenuClick: PlaySound(uiconst.SOUND_BUTTON_CLICK, "ui_button_soft4_play"), then the menu closed (OnEsc). */
  function closeMenuClick(): void {
    void playUiEvent("ui_button_soft4_play");
    onClose();
  }
  /** ColorThemeContainer._load: the presets sorted by their names (localization.util.Sort). */
  const themes = $derived([...COLOR_THEMES].map((t) => ({ ...t, name: word(t.id, t.id.split("/").pop() ?? t.id) })).sort((a, b) => a.name.localeCompare(b.name)));
  /** OnShaderQualityCombo: at low shader quality the shadow, ambient occlusion and reflection combos are disabled. */
  const disabled = (key: Key): boolean => settings.shaderQuality === 1 && (key === "shadowQuality" || key === "aoQuality" || key === "reflectionQuality");
  function setWindowMode(mode: number): void {
    if (mode === 0 && document.fullscreenElement === null) void document.documentElement.requestFullscreen?.().catch(() => {});
    if (mode === 1 && document.fullscreenElement !== null) void document.exitFullscreen?.().catch(() => {});
  }
</script>

<div class="sysmenu" role="dialog" aria-label={word(WORDS.settings, "Settings")}>
  <div class="sm-content">
    <div class="sm-top">
      <img alt="" src="/client-res/ui/texture/windowicons/settings.png" />
      <span class="sm-headline">{word(WORDS.settings, "Settings")}</span>
      <button type="button" class="sm-close" aria-label="Close" onclick={closeMenuClick}>✕</button>
    </div>
    <div class="sm-center">
      <nav class="sm-tree">
        {#each PANELS as [id, label, own] (id)}
          <button type="button" class="sm-node" class:sel={panel === id} onclick={() => { panel = id; shortcutFilter = ""; }}>{word(label, own)}</button>
          {#if id === "shortcuts" && shortcutKey !== null}
            {#each SHORTCUT_PANELS as [sub, subLabel, subOwn] (sub)}
              <button type="button" class="sm-node sub" class:sel={shortcutKey === sub && panel !== "shortcuts"} onclick={() => { panel = sub; shortcutFilter = ""; }}>{word(subLabel, subOwn)}</button>
            {/each}
          {/if}
        {/each}
      </nav>
      <div class="sm-panel">
        {#if panel === "displayandgraphics"}
          <h3 class="first">{word(WORDS.displaySetup, "Display Setup")}</h3>
          <label class="sm-combo"><span>{word(WORDS.windowed, "Window Mode")}</span>
            <select value={fullScreen ? 0 : 1} onchange={(e) => setWindowMode(Number(e.currentTarget.value))}>
              <option value={1}>{word(WORDS.windowMode, "Window mode")}</option>
              <option value={0}>{word(WORDS.fullScreen, "Fullscreen")}</option>
            </select>
          </label>
          <h3>{word(WORDS.contentHeader, "Graphics Content Settings")}</h3>
          <p class="sm-desc">{word(WORDS.contentDescription, "")}</p>
          <label class="sm-combo"><span>{word(WORDS.antiAliasing, "Anti-Aliasing")}</span>
            <select disabled title="The play page draws with the browser's multisampling"><option>{word(Q.high, "High")}</option></select>
          </label>
          {#each COMBOS as c (c.key)}
            <label class="sm-combo"><span>{word(c.label, c.own)}</span>
              <select disabled={disabled(c.key)} value={disabled(c.key) ? -1 : settings[c.key]}
                onchange={(e) => setGfx({ [c.key]: Number(e.currentTarget.value) } as Partial<GfxSettings>)}>
                {#if disabled(c.key)}<option value={-1}>{word(Q.disabled, "Disabled")}</option>{/if}
                {#each c.options as [label, value] (value)}<option {value}>{word(label, String(value))}</option>{/each}
              </select>
            </label>
          {/each}
          <div class="sm-buttons">
            <button type="button" disabled>{word(WORDS.brightness, "Brightness")}</button>
            <button type="button" disabled>{word(WORDS.optimize, "Optimize Settings")}</button>
            <button type="button" onclick={() => resetGfx()}>{word(WORDS.reset, "Reset Graphic Settings")}</button>
          </div>
          <h3>{word(WORDS.effects, "Effects")}</h3>
          {#each EFFECTS as e (e.key)}
            <label class="sm-check"><input type="checkbox" checked={settings[e.key] as boolean}
              onchange={(ev) => setGfx({ [e.key]: ev.currentTarget.checked } as Partial<GfxSettings>)} /> {word(e.label, e.own)}</label>
          {/each}
        {:else if panel === "generic"}
          <!-- ConstructWindowAppearanceSection: the blur (disabled at low shader quality), the transparency slider of
               the blur's setting or the no-blur one -->
          <h3 class="first">{word(WORDS.windowAppearance, "Window Appearance")}</h3>
          <label class="sm-check" title={settings.shaderQuality <= 1 ? word(WORDS.blurDisabledHint, "") : ""}><input type="checkbox" disabled={settings.shaderQuality <= 1}
            checked={settings.windowBlur} onchange={(ev) => setGfx({ windowBlur: ev.currentTarget.checked })} /> {word(WORDS.windowBlur, "Enable Window Blur")}</label>
          {@const key = settings.windowBlur ? "windowTransparency" : "windowTransparencyNoBlur"}
          <div class="sm-slider">
            <span>{word(WORDS.transparency, "Transparency")}</span>
            <small>{word(WORDS.off, "Off")}</small>
            <input type="range" min="0" max="1" step="0.01" value={settings[key]}
              oninput={(ev) => setGfx({ [key]: Number(ev.currentTarget.value) } as Partial<GfxSettings>)} />
            <small>{word(WORDS.fullTransparency, "Full Transparency")}</small>
          </div>
          <!-- ConstructColorThemeSection: the ship-faction checkbox, then ColorThemeContainer's presets - each entry 32
               high, its ThemePreview (16 px tiles 2 apart: focus, accent, tint, alert) and name; a click chooses it -->
          <h3>{word(WORDS.colorTheme, "Color Theme")}</h3>
          <label class="sm-check" title="Not on the play page yet"><input type="checkbox" disabled /> {word(WORDS.shipTheme, "Use ship faction theme")}</label>
          <div class="sm-theme-head">{word(WORDS.presets, "Presets")}</div>
          {#each themes as t (t.id)}
            <button type="button" class="sm-theme" class:sel={settings.colorThemeID === t.id} onclick={() => setGfx({ colorThemeID: t.id })}>
              <span class="tiles">{#each [t.focus, t.accent, t.tint, t.alert] as c, i (i)}<i style={`background: ${c}`}></i>{/each}</span>
              <span>{t.name}</span>
            </button>
          {/each}
        {:else if shortcutKey !== null}
          <!-- _ConstructShortcutsPanel: the filter at the top, the commands' scroll (Command, Shortcut), Edit / Clear /
               Default Shortcuts at the bottom (the play page keeps the defaults: those are not built) -->
          <div class="sm-shortcuts">
            <input class="sm-filter" type="search" maxlength="64" placeholder={word(WORDS.filter, "Filter")} bind:value={shortcutFilter} />
            <div class="sm-sc-head"><span>{word(WORDS.command, "Command")}</span><span>{word(WORDS.shortcut, "Shortcut")}</span></div>
            <div class="sm-sc-list">
              {#each shortcutRows as row (row.cmd)}
                <div class="sm-sc-row" class:locked={row.locked} title={row.cmd}><span>{row.description}</span><span>{row.keys || word(WORDS.noShortcut, "No shortcut")}</span></div>
              {:else}
                <p class="sm-desc">{shortcutFilter ? word(WORDS.noneFound, "") : ""}</p>
              {/each}
            </div>
            <div class="sm-buttons sc">
              <button type="button" disabled>{word(WORDS.editShortcut, "Edit Shortcut")}</button>
              <button type="button" disabled>{word(WORDS.clearShortcut, "Clear Shortcut")}</button>
              <button type="button" disabled>{word(WORDS.defaultShortcuts, "Default Shortcuts")}</button>
            </div>
          </div>
        {:else if panel === "audio"}
          <!-- LoadAudio: Audio Engine (Audio Enabled, Suppress Turret Sounds, Override with Old Jukebox, Use Combat
               Music), Volume Level (the five sliders, 0 .. 1) -->
          <h3 class="first">{word(WORDS.audioEngine, "Audio Engine")}</h3>
          <label class="sm-check"><input type="checkbox" checked={settings.audioEnabled}
            onchange={(ev) => setGfx({ audioEnabled: ev.currentTarget.checked })} /> {word(WORDS.audioEnabled, "Audio Enabled")}</label>
          <label class="sm-check"><input type="checkbox" checked={settings.suppressTurret}
            onchange={(ev) => setGfx({ suppressTurret: ev.currentTarget.checked })} /> {word(WORDS.suppressTurret, "Suppress Turret Sounds")}</label>
          <label class="sm-check"><input type="checkbox" checked={settings.useOldJukeboxOverride}
            onchange={(ev) => setGfx({ useOldJukeboxOverride: ev.currentTarget.checked })} /> {word(WORDS.oldJukebox, "Override with Old Jukebox")}</label>
          <label class="sm-check"><input type="checkbox" checked={settings.useCombatMusic}
            onchange={(ev) => setGfx({ useCombatMusic: ev.currentTarget.checked })} /> {word(WORDS.useCombatMusic, "Use Combat Music")}</label>
          <h3>{word(WORDS.volumeHeader, "Volume Level")}</h3>
          {#each VOLUMES as [key, label, own] (key)}
            <div class="sm-slider">
              <span>{word(label, own)}</span>
              <input type="range" min="0" max="1" step="0.01" value={settings[key]} disabled={!settings.audioEnabled}
                oninput={(ev) => setGfx({ [key]: Number(ev.currentTarget.value) } as Partial<GfxSettings>)} />
            </div>
          {/each}
        {:else if panel === "camera"}
          <h3 class="first">{word(WORDS.cameraHeader, "In-Space Camera Settings")}</h3>
          <label class="sm-check"><input type="checkbox" checked={settings.cameraShakeEnabled}
            onchange={(ev) => setGfx({ cameraShakeEnabled: ev.currentTarget.checked })} /> {word(WORDS.cameraShake, "Camera Shake")}</label>
        {:else}
          <p class="sm-desc">Not on the play page yet.</p>
        {/if}
      </div>
    </div>
    <div class="sm-bottom">
      <button type="button" onclick={closeMenuClick}>{word(WORDS.returnToGame, "Return to Game")}</button>
      <button type="button" disabled title="Not on the play page yet">{word(WORDS.logOff, "Log Off")}</button>
      <button type="button" disabled title="Close the tab to quit">{word(WORDS.quit, "Quit Game")}</button>
    </div>
  </div>
</div>

<style>
  .sysmenu { position: fixed; inset: 0; z-index: 900; backdrop-filter: blur(12px); background: rgba(0, 0, 0, 0.35); }
  .sm-content { position: absolute; top: 0; bottom: 0; left: 50%; transform: translateX(-50%); width: max(40%, min(1024px, 100%)); max-width: 1200px;
    display: flex; flex-direction: column; background: rgba(0, 0, 0, 0.45); color: #ccc; font-size: 13px; }
  .sm-top { flex: 0 0 64px; display: flex; align-items: center; position: relative; background: rgba(40, 46, 50, 0.5); border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .sm-top img { position: absolute; left: 32px; width: 32px; height: 32px; }
  .sm-headline { position: absolute; left: 68px; font-size: 20px; color: #fff; }
  .sm-close { position: absolute; right: 4px; width: 32px; height: 32px; background: none; border: 0; color: #ccc; font-size: 16px; cursor: pointer; }
  .sm-center { flex: 1; display: flex; padding: 32px 32px 32px 16px; min-height: 0; }
  .sm-tree { flex: 0 0 300px; display: flex; flex-direction: column; overflow: auto; margin: -32px 0 -32px -16px; padding: 32px 0 32px 16px; background: rgba(255, 255, 255, 0.03); }
  .sm-node { text-align: left; background: none; border: 0; color: #bbb; font-size: 14px; height: 36px; padding: 0 12px; cursor: pointer; }
  .sm-node.sel { background: rgba(255, 255, 255, 0.1); color: #fff; }
  .sm-panel { flex: 1; overflow: auto; padding-left: 32px; min-width: 0; }
  .sm-panel h3 { margin: 48px 0 8px; font-size: 16px; font-weight: normal; color: #fff; }
  .sm-panel h3.first { margin-top: 0; }
  .sm-desc { margin: 0 0 8px; opacity: 0.6; }
  .sm-combo { display: flex; align-items: center; margin-bottom: 8px; }
  .sm-combo span { flex: 0 0 300px; }
  .sm-combo select { flex: 1; max-width: 300px; height: 28px; }
  .sm-check { display: flex; align-items: center; gap: 6px; height: 24px; }
  .sm-theme-head { margin-top: 12px; opacity: 0.45; font-size: 14px; }
  .sm-theme { display: flex; align-items: center; gap: 8px; width: 100%; max-width: 420px; height: 32px; padding: 0 2px; text-align: left;
    background: none; border: 0; color: inherit; font-size: 13px; cursor: pointer; }
  .sm-theme:hover { background: rgba(255, 255, 255, 0.05); }
  .sm-theme.sel { background: color-mix(in srgb, var(--theme-focus, #58a7bf) 25%, transparent); }
  .sm-theme .tiles { display: flex; gap: 2px; }
  .sm-theme .tiles i { width: 16px; height: 16px; display: block; }
  .sm-node.sub { height: 30px; padding-left: 32px; font-size: 13px; }
  .sm-shortcuts { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .sm-filter { width: 160px; margin: 0 0 8px 16px; height: 24px; }
  .sm-sc-head, .sm-sc-row { display: grid; grid-template-columns: 1fr 180px; padding: 0 6px; }
  .sm-sc-head { height: 24px; align-items: center; opacity: 0.6; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .sm-sc-list { flex: 1; overflow: auto; min-height: 0; }
  .sm-sc-row { min-height: 26px; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
  .sm-sc-row.locked { opacity: 0.55; }
  .sm-buttons.sc { margin-top: 16px; }
  .sm-slider { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
  .sm-slider span { flex: 0 0 300px; }
  .sm-slider input { flex: 0 1 220px; }
  .sm-slider small { opacity: 0.6; white-space: nowrap; }
  .sm-buttons { display: flex; gap: 8px; margin-top: 32px; }
  .sm-buttons button, .sm-bottom button { height: 32px; padding: 0 16px; font-size: 13px; }
  .sm-bottom { flex: 0 0 96px; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-right: 16px; background: rgba(40, 46, 50, 0.5); }
</style>
