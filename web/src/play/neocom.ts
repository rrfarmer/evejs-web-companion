// The Neocom: the client's bar down the left edge, its default buttons in the client's order
// (neocomConst.RAWDATA_NEOCOMDEFAULT) with the client's own window icons, the EVE menu at the top and the
// EVE-time clock at the bottom. A button opens its window where the play page has one, and says so where not yet.

import { clientTexture } from "./window.ts";

export interface NeocomButton { id: string; label: string; icon: string }

const icon = (name: string) => clientTexture(`res:/UI/Texture/WindowIcons/${name}.png`);

// RAWDATA_NEOCOMDEFAULT, as far as the play page goes: the career program and the job board, Project Discovery and
// the like are left out until there is something behind them.
export const NEOCOM_DEFAULT: readonly NeocomButton[] = [
  { id: "agency", label: "Agency", icon: icon("agentfinder") },
  { id: "mail", label: "EVE Mail", icon: icon("evemail") },
  { id: "inventory", label: "Inventory", icon: icon("items") },
  { id: "assets", label: "Assets", icon: icon("assets") },
  { id: "wallet", label: "Wallet", icon: icon("wallet") },
  { id: "market", label: "Regional Market", icon: icon("market") },
  { id: "fitting", label: "Fitting", icon: icon("fitting") },
  { id: "map", label: "Map", icon: icon("map") },
  { id: "charactersheet", label: "Character Sheet", icon: icon("charactersheet") },
  { id: "chat", label: "Chat", icon: icon("chatchannels") },
];

export class Neocom {
  readonly root = document.createElement("nav");
  private readonly clock = document.createElement("div");

  constructor(open: (id: string) => void) {
    this.root.className = "neocom";
    this.root.innerHTML = `<div class="eve" title="EVE Menu"></div><div class="nc-buttons"></div><div class="nc-fill"></div>`;
    const list = this.root.querySelector(".nc-buttons")!;
    for (const b of NEOCOM_DEFAULT) {
      const el = document.createElement("button");
      el.className = "nc-btn";
      el.title = b.label;
      el.innerHTML = `<img src="${b.icon}" alt="">`;
      el.addEventListener("click", () => open(b.id));
      list.appendChild(el);
    }
    this.clock.className = "nc-clock";
    this.root.appendChild(this.clock);
    const tick = () => {
      const d = new Date();
      this.clock.textContent = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    };
    tick();
    setInterval(tick, 10_000);
  }
}
