// The play page: sign in, choose one of the account's characters, and fly it by hand.
//
// Everything that touches the server goes through the app's own client (app/api.ts, bridge/*): the same
// routes, the same retail calls, the same refusals. What is new is how it is shown: a 3D view drawn
// from the browser's own Destiny park, fed live by the BFF (/api/play/destiny).

import "./play.css";
import {
  login, readRosterCharacters, selectCharacter, markDroneRecoveryReady, getFlightStatus, bridgeDo,
} from "../app/api.ts";
import { getSessionToken, withSessionTokenQuery } from "../app/sessionToken.ts";
import { decodeCharacterSelectionData } from "../bridge/characterSelection.ts";
import { approach, orbit, stopShip, warpToItem, type FlightNow } from "../bridge/movementWrites.ts";
import { undock, dock } from "../bridge/placeChanges.ts";
import { LivePark } from "../three/livePark.ts";
import { SpaceView } from "./spaceView.ts";
import type { CharacterSummary } from "../store/types.ts";
import type { JsonValue } from "../bridge/wire.ts";

const app = document.getElementById("play")!;
const act = bridgeDo();

interface Flight { inSpace: boolean; docked: boolean; shipID: number | null; solarSystemID: number | null; stationID: number | null; structureID: number | null }

async function flight(): Promise<Flight> {
  const f = ((await getFlightStatus()).flight ?? {}) as Record<string, JsonValue>;
  const n = (k: string) => (typeof f[k] === "number" ? (f[k] as number) : null);
  return { inSpace: f.inSpace === true, docked: f.docked === true, shipID: n("shipID"), solarSystemID: n("solarSystemID"), stationID: n("stationID"), structureID: n("structureID") };
}
const flightNow = async (): Promise<FlightNow> => { const f = await flight(); return { inSpace: f.inSpace, shipID: f.shipID, solarSystemID: f.solarSystemID, structureID: f.structureID }; };

function screen(html: string): HTMLElement {
  app.innerHTML = "";
  const el = document.createElement("div");
  el.innerHTML = html;
  const node = el.firstElementChild as HTMLElement;
  app.appendChild(node);
  return node;
}

// ── sign in ──────────────────────────────────────────────────────────────────
function showLogin(error = ""): void {
  const el = screen(`<div class="screen"><form class="login-box">
    <h1>EVE</h1>
    <label>Username</label><input name="u" autocomplete="username" autofocus>
    <label>Password</label><input name="p" type="password" autocomplete="current-password">
    <button class="btn primary" type="submit">Log in</button><div class="error"></div></form></div>`);
  el.querySelector(".error")!.textContent = error;
  el.querySelector("form")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const u = (f.elements.namedItem("u") as HTMLInputElement).value.trim();
    const p = (f.elements.namedItem("p") as HTMLInputElement).value;
    const b = f.querySelector("button")!;
    b.disabled = true;
    try { await login(u, p); void showSelect(); }
    catch (err) { b.disabled = false; f.querySelector(".error")!.textContent = (err as Error).message; }
  });
}

// ── character select ─────────────────────────────────────────────────────────
async function showSelect(): Promise<void> {
  screen(`<div class="screen"><div class="select-title">Select character</div><div class="select">Loading…</div></div>`);
  let characters: readonly CharacterSummary[];
  try { characters = decodeCharacterSelectionData(await readRosterCharacters()).characters; }
  catch (err) { showLogin((err as Error).message); return; }
  const list = app.querySelector(".select")!;
  list.innerHTML = "";
  for (const c of characters) {
    const card = document.createElement("div");
    card.className = "char-card";
    card.innerHTML = `<img alt=""><div class="who"><div class="name"></div><div class="where"></div></div>`;
    // The EveJS image server, as the app's own portraits (ui/ownerImages.ts portraitUrl).
    (card.querySelector("img") as HTMLImageElement).src = `http://127.0.0.1:26001/Character/${c.characterID}_256.jpg`;
    (card.querySelector("img") as HTMLImageElement).onerror = function () { (this as HTMLImageElement).style.visibility = "hidden"; };
    card.querySelector(".name")!.textContent = c.characterName;
    card.querySelector(".where")!.textContent = c.shipName ?? "";
    card.addEventListener("click", () => void enter(c));
    list.appendChild(card);
  }
}

// ── in the game ─────────────────────────────────────────────────────────────
let live: LivePark | null = null;
let view: SpaceView | null = null;

async function enter(c: CharacterSummary): Promise<void> {
  screen(`<div class="screen"><div class="select-title">Entering as ${c.characterName}…</div></div>`);
  try {
    const selected = await selectCharacter(c.characterID);
    // The BFF holds a newly selected pilot still until its lost-drone check has been made (droneRecoveryGate.js).
    if (selected.droneRecoveryCheckID) await markDroneRecoveryReady(selected.droneRecoveryCheckID);
    live?.close();
    live = new LivePark();
    live.connect(withSessionTokenQuery("/api/play/destiny"));
    await place(selected.station ? { name: selected.station.stationName, system: selected.station.solarSystemName, security: selected.station.security ?? null } : null);
  } catch (err) {
    screen(`<div class="screen"><div class="login-box"><div class="error"></div><button class="btn">Back</button></div></div>`);
    app.querySelector(".error")!.textContent = (err as Error).message;
    app.querySelector("button")!.addEventListener("click", () => void showSelect());
  }
}

let systemName = "";
let systemSecurity: number | null = null;

async function place(station: { name: string; system: string; security: number | null } | null): Promise<void> {
  if (station) { systemName = station.system; systemSecurity = station.security; }
  const f = await flight();
  if (f.docked) showStation(station?.name ?? "Station");
  else showSpace();
}

function showStation(name: string): void {
  view?.dispose();
  view = null;
  const el = screen(`<div class="station"><div class="station-name"></div><div class="station-sub"></div><button class="btn undock">Undock</button><div class="error" style="position:absolute;right:24px;top:80px"></div></div>`);
  el.querySelector(".station-name")!.textContent = name;
  el.querySelector(".station-sub")!.textContent = systemName;
  const b = el.querySelector<HTMLButtonElement>(".undock")!;
  b.addEventListener("click", async () => {
    b.disabled = true;
    b.textContent = "Undocking";
    try {
      await undock(act, flightNow, false);
      showSpace();
    } catch (err) {
      b.disabled = false;
      b.textContent = "Undock";
      el.querySelector(".error")!.textContent = (err as Error).message;
    }
  });
}

function showSpace(): void {
  app.innerHTML = "";
  view?.dispose();
  view = new SpaceView(live!, {
    gotoDirection: (x, y, z) => act("beyonce", "CmdGotoDirection", [x, y, z]).then(() => undefined),
    stop: () => stopShip(act, flightNow),
    approach: (id) => approach(act, flightNow, id),
    orbit: (id) => orbit(act, flightNow, id, 5000),
    warpTo: (id) => warpToItem(act, flightNow, id, 0),
    dock: async (id) => { await dock(act, flightNow, id); if ((await flight()).docked) showStation("Station"); },
  }, { system: systemName, security: systemSecurity });
  app.appendChild(view.root);
  (window as unknown as { __play: unknown }).__play = { live, view };
}

if (getSessionToken()) void showSelect();
else showLogin();
