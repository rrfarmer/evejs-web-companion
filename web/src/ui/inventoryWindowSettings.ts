// invWindow.Inventory's window-level settings as signals the window and its header menu share: the sidebar
// (_is_tree_expanded_setting, 'UI/Inventory/ShowSidebar', shown by default), the window's compact mode
// (CompactModeWindowAction: the search field in the header, the top action container gone, the view modes as the
// menu's radio buttons), and the quick filter and view mode the header's search and the menu's radios write.

import { createSignal } from "../store/signals.ts";

const read = (key: string, fallback: boolean): boolean => {
  try { const v = globalThis.localStorage?.getItem(key); return v === "1" ? true : v === "0" ? false : fallback; } catch { return fallback; }
};
const keep = (key: string, on: boolean): void => {
  try { globalThis.localStorage?.setItem(key, on ? "1" : "0"); } catch { /* lasts the page */ }
};

export const invSidebar = createSignal<boolean>(read("evejs.ui.inventory.sidebar", true));
export const invCompact = createSignal<boolean>(read("evejs.ui.inventory.compact", false));
/** The quick filter (the search field), wherever compact mode puts it. */
export const invFilter = createSignal<string>("");
/** The view mode the compact menu's radios set (the window keeps its own copy in step). */
export const invViewMode = createSignal<"icons" | "details" | "list" | null>(null);

export function setInvSidebar(on: boolean): void { keep("evejs.ui.inventory.sidebar", on); invSidebar.set(on); }
export function setInvCompact(on: boolean): void { keep("evejs.ui.inventory.compact", on); invCompact.set(on); }

/** invSettings.keep_inv_quick_filter_setting (UserSettingBool keepInvQuickFilterInput, False): the quick filter kept when
 * another container is shown (else Container.SetInvCont clears it). */
export const invKeepFilter = createSignal<boolean>(read("evejs.ui.inventory.keepQuickFilter", false));
export function setInvKeepFilter(on: boolean): void { keep("evejs.ui.inventory.keepQuickFilter", on); invKeepFilter.set(on); }

/** invSettings.always_open_secondary_inventory_setting (UserSettingBool openSecondaryInv, False): a double-click on a
 * container's tree entry opens it in a window of its own (OnTreeViewDblClick: TreeDataInv.OpenNewWindow, else the
 * entry's children toggled). */
export const invAlwaysSeparate = createSignal<boolean>(read("evejs.ui.inventory.openSecondary", false));
export function setInvAlwaysSeparate(on: boolean): void { keep("evejs.ui.inventory.openSecondary", on); invAlwaysSeparate.set(on); }

/** invSettings.always_show_full_tree_setting (UserSettingBool alwaysShowFullInvTree, False). In the client's ship cargo
 * window in space (g382) it makes the tree's top level the full location tree (the ship and the PLEX Vault) in place of
 * the ship as the root; the page's tree has no PLEX Vault entry, so here it is the setting and its menu entry. */
export const invFullTree = createSignal<boolean>(read("evejs.ui.inventory.alwaysShowFullTree", false));
export function setInvFullTree(on: boolean): void { keep("evejs.ui.inventory.alwaysShowFullTree", on); invFullTree.set(on); }

/** invSettings.show_training_details (CharSettingBool show_training_details, True): offered to an omega clone only
 * (is_omega_with_grace_period); ShouldShowTrainingDetails gates an item tooltip's training time and skill action. */
export const invTrainingDetails = createSignal<boolean>(read("evejs.ui.inventory.showTrainingDetails", true));
export function setInvTrainingDetails(on: boolean): void { keep("evejs.ui.inventory.showTrainingDetails", on); invTrainingDetails.set(on); }
