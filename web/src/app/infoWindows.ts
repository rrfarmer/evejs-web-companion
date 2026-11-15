import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";
import type { InfoIdentity, InfoOpenOptions, InfoSubject } from "../bridge/infoWindow.ts";
import { createInfoReadScope, type InfoReadScope } from "./infoReadScope.ts";
import type { CorporationInfoRead, CorporationPublicInfo, CorporationShowInfo } from "../bridge/ownerInfo.ts";

interface Entry { readonly request: InfoSubject; readonly subject: InfoSubject; readonly identity: InfoIdentity }
/** Empty native dict while reconstructing; null is the recorded None identity tuple. */
const pendingHistory = { pending: true } as const;
type HistoryEntry = Entry | null | typeof pendingHistory;
type CorporationResult = CorporationInfoRead | null | undefined;
const isPending = (entry: HistoryEntry): entry is typeof pendingHistory => entry !== null && "pending" in entry;
export interface InfoWindowState {
  readonly id: number;
  readonly entry: Entry;
  readonly captionEntry: Entry;
  readonly subject: ReadableSignal<InfoSubject | null>;
  /** Current reconstruction's result and the result still visible during history. */
  readonly corporationResult: ReadableSignal<CorporationResult> | null;
  readonly visibleCorporationResult: ReadableSignal<CorporationResult> | null;
  readonly history: readonly HistoryEntry[];
  readonly index: number;
  /** Ordinary content: ConstructLayout/ReconstructSubContainer flush old controls. */
  readonly reconstruction: number;
  readonly reads: InfoReadScope;
  readonly loading: boolean;
  /** BaseInfoWindow saves the latest busy request without starting it. */
  readonly pendingLoadData: Entry | null;
  readonly waitingForReconstruction: boolean;
  /** Visible corporation content follows its description/public-info work. */
  readonly contentConstructed: boolean;
  readonly x: number; readonly y: number; readonly w: number; readonly h: number;
  readonly z: number; readonly minimized: boolean; readonly modal: boolean;
}

/** infosvc.ShowInfo412-454, HistoryBuffer and InfoWindow.NavigateHistory75-86.
 * Windows stay in registration order; focus must never reorder that list. */
export function createInfoWindows(deps: {
  resolve(subject: InfoSubject): Promise<InfoIdentity | null>;
  readCorporation(corporationID: number, reads: InfoReadScope, header: (info: CorporationPublicInfo) => void): Promise<CorporationShowInfo | null>;
  reportError(error: unknown): boolean;
  reuse(): boolean;
  shift(): boolean;
}) {
  const state = createSignal<readonly InfoWindowState[]>([]);
  const raised = createSignal<{ readonly n: number; readonly id: number } | null>(null);
  const subjects = new Map<number, ReturnType<typeof createSignal<InfoSubject | null>>>();
  const assignedEntries = new WeakMap<InfoReadScope, Entry | null>();
  const corporationResults = new WeakMap<InfoReadScope, ReturnType<typeof createSignal<CorporationResult>>>();
  const activeLoads = new Map<number, InfoReadScope>();
  let serial = 0, raisedSerial = 0, generation = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const update = (id: number, change: (w: InfoWindowState) => InfoWindowState): void => {
    state.update(windows => windows.map(w => w.id === id ? change(w) : w));
  };
  const requestRaise = (id: number): void => { raised.set({ n: ++raisedSerial, id }); };
  const snapshot = (w: InfoWindowState): Entry | null => assignedEntries.get(w.reads) ?? null;
  function makeReads(id: number, entry: Entry, branch: boolean, directHistory = false, previous?: InfoReadScope, waiting = false): InfoReadScope {
    const epoch = generation;
    const initial = waiting ? null : entry.identity.content === "corporation" ? directHistory && previous ? assignedEntries.get(previous) ?? null : null : entry;
    const current = (): InfoWindowState | undefined => state.get().find(w => w.id === id && w.reads === reads);
    const reads = createInfoReadScope(() => epoch === generation, {
      requested: entry.identity, registered: !directHistory, initialIdentity: initial?.identity ?? null,
      onIdentify: () => {
        assignedEntries.set(reads, entry);
        // Same-class corporation history does not flush its old controls until
        // GetPublicInfo returns and the monolith parent starts reconstruction.
        if (entry.identity.content === "corporation" && current()) {
          if (directHistory) subjects.get(id)?.set({ ...entry.subject });
          update(id, w => ({ ...w, contentConstructed: false,
            visibleCorporationResult: w.corporationResult, reconstruction: w.reconstruction + (directHistory ? 1 : 0) }));
        }
      },
      onConstruct: () => { if (current()) update(id, w => ({ ...w, contentConstructed: true })); },
      onComplete: () => {
        const window = state.get().find(w => w.id === id);
        // The running direct history coroutine uses self.info_content again
        // for its caption. ShowInfo may have replaced that object with a new,
        // unassigned content while BaseInfoWindow queued its reconstruction.
        if (activeLoads.get(id) === reads && window?.waitingForReconstruction) {
          throw Object.assign(new Error("Trying to open a show info with no type_id. Possibly bad history data."), { code: "INFO_CAPTION_UNASSIGNED" });
        }
        const w = current(); if (!w) return;
        update(id, w => ({ ...w, captionEntry: entry,
          history: branch && w.history.length ? w.history.map((old, i) => i === w.index ? snapshot(w) : old) : w.history }));
      },
      onRetire: withHistory => {
        const w = current(); if (!withHistory || !w || !w.history.length || !isPending(w.history[w.index]!)) return;
        update(id, w => ({ ...w, history: w.history.map((old, i) => i === w.index ? snapshot(w) : old) }));
      },
    });
    assignedEntries.set(reads, initial);
    if (entry.identity.content === "corporation") corporationResults.set(reads, createSignal<CorporationResult>(undefined));
    reads.loading.subscribe(loading => {
      if (epoch !== generation) return;
      if (loading) activeLoads.set(id, reads);
      else if (activeLoads.get(id) !== reads) return;
      else activeLoads.delete(id);
      const w = state.get().find(w => w.id === id);
      if (w && w.loading !== loading) update(id, w => ({ ...w, loading }));
    });
    return reads;
  }
  const corporationResult = (reads: InfoReadScope): ReadableSignal<CorporationResult> | null => {
    const signal = corporationResults.get(reads); return signal ? readonlySignal(signal) : null;
  };
  function loadCorporation(entry: Entry, reads: InfoReadScope): void {
    const signal = corporationResults.get(reads);
    if (!signal || entry.identity.itemID === null) return;
    // One controller-owned coroutine feeds the view. A remount/focus must not
    // issue another copy, and an unregistered history read can outlive its view.
    void deps.readCorporation(entry.identity.itemID, reads, info => {
      reads.assertCurrent(); signal.set({ stage: "header", info });
    }).then(value => signal.set(value), error => {
      // The native header survives a later attribute failure. Main tabs have
      // not been constructed, so retain that stage rather than clearing it.
      if (signal.get() === undefined) signal.set(null);
      // Native eve_exception_handler logs ordinary exceptions by default.
      if (error?.code !== "INFO_RECONSTRUCTION_RETIRED" && error?.code !== "SESSION_REQUEST_RETIRED" && !deps.reportError(error)) console.error(error);
    });
  }
  function reconstruct(w: InfoWindowState, entry: Entry, branch: boolean, directHistory = false): void {
    // Ordinary ShowInfo stops the old tasklet before replacing its content.
    // That stop records an unfinished history slot before the new one is appended.
    w.reads.retireRegistered();
    w = state.get().find(current => current.id === w.id)!;
    if (!directHistory && w.loading && entry.identity.content !== "ship") {
      // change_info_content/ConstructLayout happen before the busy base call.
      // There is no registered tasklet to stop during direct history. Replace
      // the layout, retain its window-level loading flag, and save only the
      // latest pending tuple. No history append, RPC or automatic drain follows.
      const reads = makeReads(w.id, entry, branch, false, undefined, true);
      const result = corporationResult(reads);
      subjects.get(w.id)?.set({ ...entry.subject });
      update(w.id, current => ({ ...current, entry, reads, corporationResult: result,
        visibleCorporationResult: result, pendingLoadData: entry, waitingForReconstruction: true, contentConstructed: false,
        reconstruction: current.reconstruction + 1, minimized: false }));
      requestRaise(w.id);
      return;
    }
    let history = w.history;
    let index = w.index;
    if (branch) { history = [...history.slice(0, index + 1), entry.identity.content === "corporation" ? pendingHistory : entry]; index = history.length - 1; }
    const reads = makeReads(w.id, entry, branch, directHistory, w.reads);
    const defer = directHistory && entry.identity.content === "corporation";
    const result = corporationResult(reads);
    if (!defer) subjects.get(w.id)?.set({ ...entry.subject });
    update(w.id, current => ({ ...current, entry, history, index, reads, loading: false, corporationResult: result, waitingForReconstruction: false,
      contentConstructed: defer ? current.contentConstructed : entry.identity.content !== "corporation",
      captionEntry: entry.identity.content === "corporation" ? current.captionEntry : entry,
      visibleCorporationResult: defer ? current.visibleCorporationResult : result,
      reconstruction: current.reconstruction + (defer || entry.identity.content === "ship" ? 0 : 1), minimized: false }));
    loadCorporation(entry, reads);
    requestRaise(w.id);
  }
  function show(subject: InfoSubject, options: InfoOpenOptions = {}): Promise<number | null> {
    const epoch = generation;
    const shift = options.shift ?? deps.shift();
    const reuse = deps.reuse();
    // Preserve every synchronous multi-menu request; a signal/effect alone
    // would collapse several subjects into only the last one.
    const result = queue.then(async () => {
      if (epoch !== generation) return null;
      const identity = await deps.resolve(subject);
      if (epoch !== generation || identity === null) return null;
      const normalized = identity.itemID !== null
        ? identity.content === "character" ? { kind: "character" as const, characterID: identity.itemID }
          : identity.content === "corporation" ? { kind: "corporation" as const, corporationID: identity.itemID }
          : identity.typeID === 16159 ? { kind: "alliance" as const, allianceID: identity.itemID }
            : identity.typeID === 30 ? { kind: "faction" as const, factionID: identity.itemID } : subject
        : subject;
      const entry: Entry = { request: subject, subject: normalized, identity };
      const bucket = identity.content === "ship" ? "ship" : "ordinary";
      const windows = state.get();
      const modal = !!options.modal || !!options.progressModal || windows.some(w => w.modal && !w.minimized);
      const existing = windows.filter(w => (w.entry.identity.content === "ship" ? "ship" : "ordinary") === bucket).at(-1);
      const create = options.new || options.addNewWindow || !reuse || shift || modal || !existing;
      if (create) {
        const id = ++serial, signal = createSignal<InfoSubject | null>({ ...normalized });
        subjects.set(id, signal);
        const offset = (windows.length % 8) * 24;
        const reads = makeReads(id, entry, true), result = corporationResult(reads);
        const w: InfoWindowState = { id, entry, captionEntry: entry, subject: readonlySignal(signal), history: [identity.content === "corporation" ? pendingHistory : entry], index: 0, reconstruction: 1,
          reads, loading: false, pendingLoadData: null, waitingForReconstruction: false, contentConstructed: identity.content !== "corporation", corporationResult: result, visibleCorporationResult: result,
          x: 16 + offset, y: 16 + offset, w: bucket === "ship" ? 960 : 500, h: bucket === "ship" ? 656 : 600,
          z: Math.max(0, ...windows.map(w => w.z)) + 1, minimized: false,
          modal: modal && !options.progressModal };
        state.set([...windows, w]); loadCorporation(entry, reads); requestRaise(id); return id;
      }
      // Corporation content waits for GetPublicInfo before its parent assigns
      // type/item. Requested identity alone cannot decide a native duplicate.
      const applied = existing.reads.identity.get();
      const duplicate = applied !== null && applied.typeID === identity.typeID && applied.itemID === identity.itemID;
      // A duplicate modern window does not reconstruct OR maximize here.
      if (duplicate && identity.content !== "legacy") return existing.id;
      reconstruct(existing, entry, !options.traversingHistory && !duplicate);
      return existing.id;
    });
    queue = result.catch(() => {});
    return result;
  }
  return {
    state: readonlySignal(state), raised: readonlySignal(raised), show,
    focus(id: number, top?: number): void {
      const z = top ?? Math.max(0, ...state.get().map(w => w.z)) + 1;
      update(id, w => ({ ...w, z }));
    },
    close(id: number): void { state.get().find(w => w.id === id)?.reads.retireRegistered(false); subjects.delete(id); state.update(windows => windows.filter(w => w.id !== id)); },
    minimize(id: number): void {
      const w = state.get().find(w => w.id === id); if (!w) return;
      update(id, current => ({ ...current, minimized: !current.minimized }));
      if (w.minimized) requestRaise(id);
    },
    geometry(id: number, place: { x: number; y: number; w: number; h: number }): void {
      const old = state.get().find(w => w.id === id);
      if (old && Object.entries(place).some(([k, v]) => old[k as keyof typeof place] !== v)) update(id, w => ({ ...w, ...place }));
    },
    async navigate(id: number, direction: -1 | 1, shift = false): Promise<void> {
      const w = state.get().find(w => w.id === id); if (!w) return;
      // InfoWindow.OnBack/OnForward ignore input during ordinary reconstruction.
      // Ship history has no such guard. Only content-owned reads mark this flag.
      if (w.entry.identity.content !== "ship" && w.loading) return;
      const history = w.history.map((e, i) => i === w.index ? snapshot(w) : e);
      const index = w.index + direction; if (index < 0 || index >= history.length) return;
      const entry = history[index]!;
      update(id, current => ({ ...current, history, index }));
      if (entry === null || isPending(entry)) {
        // NavigateHistory reaches the original local type/key error after GoBack
        // has advanced the index. No content reconstruction or server call follows.
        throw Object.assign(new Error(entry === null ? "TypeNotFoundException: None" : "KeyError: 0"), { code: "INFO_HISTORY_UNASSIGNED" });
      }
      const current = state.get().find(w => w.id === id)!;
      if (w.entry.identity.content === entry.identity.content) reconstruct(current, entry, false, entry.identity.content !== "ship");
      else await show(entry.request, { traversingHistory: true, shift });
    },
    reset(): void { generation++; subjects.clear(); activeLoads.clear(); state.set([]); raised.set(null); queue = Promise.resolve(); },
  };
}
export type InfoWindows = ReturnType<typeof createInfoWindows>;
