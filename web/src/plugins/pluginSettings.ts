// A plugin's own settings in this browser (docs/plugins.md, "Settings"), kept apart from
// core's, so a plugin needs no field of core's and leaves none behind.

import { createSignal, type WritableSignal } from "../store/signals.ts";

const PREFIX = "evejs-web-plugin-settings:";
const HANGAR_PREFS_KEY = "evejs-web-hangar-prefs:v1";

export interface PluginSettingsOptions<T> {
  /** What the setting is before anything was saved, and if what was saved cannot be read. */
  readonly initial: T;
  /** Saved bytes are untrusted: answer what they mean, or undefined if they mean nothing. */
  readonly decode: (raw: unknown) => T | undefined;
  /** What this setting was called before it was yours: read once, while nothing of yours is saved. */
  readonly formerly?: () => unknown;
}

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    // Some privacy modes throw on touching localStorage.
    return null;
  }
}

function saved(key: string): { readonly raw: unknown } | null {
  try {
    const text = storage()?.getItem(key) ?? null;
    return text === null ? null : { raw: JSON.parse(text) };
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage refused: the setting holds while the page is open.
  }
}

const settings = new Map<string, WritableSignal<unknown>>();

/**
 * One setting of a plugin's, under a key of its own ("plugin:<plugin id>" or
 * "plugin:<plugin id>.<name>"). The same key gives the same signal, and what is
 * set on it is saved. It lasts in this browser only.
 */
export function pluginSetting<T>(key: `plugin:${string}`, options: PluginSettingsOptions<T>): WritableSignal<T> {
  const held = settings.get(key);
  if (held !== undefined) return held as WritableSignal<T>;
  const storageKey = `${PREFIX}${key}`;
  const stored = saved(storageKey);
  let value = stored === null ? undefined : options.decode(stored.raw);
  if (stored === null && options.formerly !== undefined) {
    let former: unknown;
    try {
      former = options.formerly();
    } catch {
      former = undefined;
    }
    value = former === undefined || former === null ? undefined : options.decode(former);
    // Written now, so that it is read once: core may drop its own copy on its next save.
    if (value !== undefined) save(storageKey, value);
  }
  const signal = createSignal<T>(value ?? options.initial);
  const kept: WritableSignal<T> = {
    ...signal,
    set(next) {
      signal.set(next);
      save(storageKey, signal.get());
    },
    update(updater) {
      kept.set(updater(signal.get()));
    },
  };
  settings.set(key, kept as WritableSignal<unknown>);
  return kept;
}

/**
 * A field of the Hangar's saved arrangement as it stands on disk, for a plugin taking
 * over a setting core kept there (`formerly`). Undefined if there is no such field.
 */
export function formerHangarSetting(field: string): unknown {
  const stored = saved(HANGAR_PREFS_KEY);
  const raw = stored?.raw;
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[field] : undefined;
}

/** Forget what this page holds: for tests, which change the storage underneath. */
export function resetPluginSettingsForTests(): void {
  settings.clear();
}
