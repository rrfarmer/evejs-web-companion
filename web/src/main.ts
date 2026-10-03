// R2 entry: the first real page on the new stack (view-lib spike: Svelte 5).
// login form -> character selection -> docked station panel, all state in the
// framework-agnostic client-state store, all fetch/decode logic in
// app/flow.ts, the Svelte components pure readers. Replaces the R1b scaffold
// smoke page per its own note.

// Styling (goal R8): the Tailwind CSS v4 design-system entry. Importing it here
// makes Vite (via @tailwindcss/vite) compile Tailwind and emit the CSS bundle
// into public/dist/, and the built index.html links it automatically.
import "./styles.css";
import { mount } from "svelte";
import { isGoblinFactoryPath, isMiningCommandCenterPath, isPilotTrainingPath, isShipProvisioningPath } from "./app/pageRoute.ts";
import { installErrorOverlay } from "./app/errorOverlay.ts";

// Before anything else: a framework-free net for uncaught errors and unhandled
// rejections, so a throw that wedges the UI still shows a message instead of a
// silent freeze.
installErrorOverlay();

// R107 — App owns the pilot roster now: it creates one isolated session per
// pilot (store + per-session-token flow) and warms each one's health ping
// itself (app/sessions.ts). There is no single app-wide store/flow any more.
const target = document.getElementById("app");
if (isGoblinFactoryPath(window.location.pathname)) window.location.replace(`/pilot-training${window.location.search}${window.location.hash}`);
if (target && !isGoblinFactoryPath(window.location.pathname)) {
  if (isShipProvisioningPath(window.location.pathname)) {
    void import("./ui/ProvisioningCenter.svelte").then(({ default: Center }) => mount(Center, { target }));
  } else if (isPilotTrainingPath(window.location.pathname)) {
    // Standalone: no cockpit restore, active bot or space polling is mounted.
    void import("./ui/GoblinFactory.svelte").then(({ default: Training }) => mount(Training, { target }));
  } else if (isMiningCommandCenterPath(window.location.pathname)) {
    void import("./ui/MiningCommandCenter.svelte").then(({ default: CommandCenter }) => mount(CommandCenter, { target }));
  } else {
    void import("./ui/App.svelte").then(({ default: App }) => mount(App, { target }));
  }
}
