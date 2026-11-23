// uicore.uilib.Key(VK_SHIFT): whether Shift is held now, for code that asks at the moment it runs rather than from an
// event of its own (Inventory.OpenOrShow after a container's items have come). Kept from the key and pointer events the
// page sees; lost focus lets it go.

let shift = false;
let installed = false;

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const fromEvent = (e: KeyboardEvent | MouseEvent) => { shift = e.shiftKey; };
  window.addEventListener("keydown", fromEvent, true);
  window.addEventListener("keyup", fromEvent, true);
  window.addEventListener("pointerdown", fromEvent, true);
  window.addEventListener("pointermove", fromEvent, true);
  window.addEventListener("blur", () => { shift = false; });
}

/** Whether Shift is held at this moment. */
export function shiftHeld(): boolean {
  install();
  return shift;
}

install();
