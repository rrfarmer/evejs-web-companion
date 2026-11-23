// Remember a workspace choice by name. Account authorization stays in Farmer.
export function workspacePreference(key: string) {
  return {
    read(): string | null {
      try {
        const raw = globalThis.sessionStorage?.getItem(key);
        if (!raw) return null;
        const {account} = JSON.parse(raw);
        return typeof account === "string" ? account : null;
      }
      catch { return null; }
    },
    remember(account: string) {
      try { globalThis.sessionStorage?.setItem(key, JSON.stringify({account})); }
      catch { /* The current selection still works without browser storage. */ }
    },
    clear() {
      try { globalThis.sessionStorage?.removeItem(key); }
      catch { /* Browser storage is unavailable. */ }
    },
  };
}

export function removeLegacyControllerToken() {
  try { globalThis.sessionStorage?.removeItem('uoc:restored:controller:v1'); }
  catch { /* Browser storage is unavailable. */ }
}
