// ProbeScannerWindow's compact mode (CompactModeWindowAction; Prepare_Header_: ProbeScannerCompactHeader with no
// caption; ProbeScannerPalette.ConstructFilterCont: the filter row in the header's extra_content, no ScanResults
// label), as a signal the window's header menu and its content share; kept.

import { createSignal } from "../store/signals.ts";

const KEY = "evejs.ui.probeScannerCompact";
export const probeScannerCompact = createSignal<boolean>((() => { try { return globalThis.localStorage?.getItem(KEY) === "1"; } catch { return false; } })());
export function setProbeScannerCompact(on: boolean): void {
  try { globalThis.localStorage?.setItem(KEY, on ? "1" : "0"); } catch { /* lasts the page */ }
  probeScannerCompact.set(on);
}
