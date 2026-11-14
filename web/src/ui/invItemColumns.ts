// The inventory list's columns as the client's scrolls show an item (uix.GetInvItemDefaultHeaders with
// uix.GetItemData's values and sort_<header> values, _item_column_value_getter_by_column): Name, Quantity, Group,
// Category, Size, Slot, Volume, Meta level, Tech level, Est. Price - GetInvItemDefaultHiddenHeaders (Meta level, Tech
// level, Category) hidden at first. Shared by the corporation's assets (CorporationAssets.svelte) and the Personal
// Assets window's items (PersonalAssets.svelte).
import type { AssetTypeFacts } from "../app/flow.ts";
import { formatNumeric, fmtAmt } from "../bridge/pyNumbers.ts";
import { iskWords } from "../bridge/questions.ts";
import { plainText } from "../bridge/clientWords.ts";
import type { NameKind } from "../store/names.ts";

/** An item as the columns read it: its type, its stack (negative for an assembled one) and its singleton flag
 * (2 a blueprint copy). */
export interface InvItem { readonly itemID: number; readonly typeID: number; readonly stacksize: number; readonly singleton: number }
export interface InvItemColumn { readonly label: string; text(item: InvItem): string; sort(item: InvItem): number | string; readonly right?: boolean }
export interface InvItemColumnContext {
  /** A label's words filled (formatTemplate over the store's templates). */
  text(label: string, args?: Record<string, unknown>): string;
  nameOf(kind: NameKind, id: number): string;
  facts(): ReadonlyMap<number, AssetTypeFacts>;
  templates(): Readonly<Record<string, string | null>>;
}

export const INV_ITEM_DEFAULT_HIDDEN: readonly string[] = ["UI/Inventory/ItemMetaLevel", "UI/Inventory/ItemTechLevel", "UI/Inventory/ItemCategory"];
/** The words the columns use. */
export const INV_ITEM_COLUMN_WORDS: readonly string[] = ["UI/Common/Name", "UI/Common/Quantity", "UI/Inventory/ItemGroup", "UI/Inventory/ItemCategory",
  "UI/Inventory/ItemSize", "UI/Inventory/ItemSlot", "UI/Inventory/ItemVolume", "UI/Inventory/ItemMetaLevel", "UI/Inventory/ItemTechLevel",
  "UI/Contracts/ContractsWindow/EstPrice", "UI/InfoWindow/SmallSize", "UI/InfoWindow/MediumSize", "UI/InfoWindow/LargeSize", "UI/InfoWindow/XLargeSize",
  "UI/Inventory/SlotRigs", "UI/Inventory/SlotHigh", "UI/Inventory/SlotMedium", "UI/Inventory/SlotLow", "UI/InfoWindow/ValueAndUnit", "UI/Util/FmtIsk",
  "UI/Util/FmtIskNoDecimal", "/Carbon/UI/Common/Hide", "/Carbon/UI/Common/Show", "UI/Common/Buttons/Close"];

const SIZES: Record<number, string> = { 1: "UI/InfoWindow/SmallSize", 2: "UI/InfoWindow/MediumSize", 3: "UI/InfoWindow/LargeSize", 4: "UI/InfoWindow/XLargeSize" };
const SLOTS: Record<number, string> = { 2663: "UI/Inventory/SlotRigs", 12: "UI/Inventory/SlotHigh", 13: "UI/Inventory/SlotMedium", 11: "UI/Inventory/SlotLow" };

export function invItemColumns(ctx: InvItemColumnContext): readonly InvItemColumn[] {
  const typeName = (id: number) => ctx.nameOf("type", id) || String(id);
  // GetItemQty: nothing for a singleton (or a bookmark), else FmtAmt of the stack.
  const qtyOf = (item: InvItem) => (item.singleton || item.typeID === 51 ? "" : fmtAmt(item.stacksize));
  // _get_item_size: the charge size in its size class's words.
  const sizeOf = (item: InvItem) => { const v = ctx.facts().get(item.typeID)?.chargeSize; return v === null || v === undefined ? "" : plainText(ctx.text(SIZES[Math.trunc(v)] ?? "")); };
  // _get_item_slot: the implant slot, else the booster slot, else the power slot its effects fit.
  const slotOf = (item: InvItem) => {
    const f = ctx.facts().get(item.typeID);
    if (!f) return "";
    if (f.implantness !== null) return String(Math.trunc(f.implantness));
    if (f.boosterness !== null) return String(Math.trunc(f.boosterness));
    return f.slotEffect === null ? "" : plainText(ctx.text(SLOTS[f.slotEffect] ?? ""));
  };
  // GetItemVolume (a singleton's type volume, else its packaged one, times the stack) as ValueAndUnit with m3 (dogma unit
  // 9's display name), two places where it has a fraction; none for plastic wrap.
  const volumeOf = (item: InvItem) => {
    const f = ctx.facts().get(item.typeID);
    if (!f || item.typeID === 3468) return "";
    const each = item.singleton ? f.volume : f.packagedVolume;
    if (each === null) return "";
    const volume = each === -1 ? -1 : each * (item.stacksize < 0 ? 1 : item.stacksize);
    const places = Math.abs(volume - Math.trunc(volume)) > 1e-7 ? 2 : 0;
    return plainText(ctx.text("UI/InfoWindow/ValueAndUnit", { value: formatNumeric(places ? volume : Math.trunc(volume), { useGrouping: true, decimalPlaces: places }), unit: "m3" }));
  };
  // GetItemVolume's number, for the column's sort.
  const volumeNumber = (item: InvItem) => { const f = ctx.facts().get(item.typeID); const each = f ? (item.singleton ? f.volume : f.packagedVolume) : null; return item.typeID === 3468 || each === null ? 0 : each * (item.stacksize < 0 ? 1 : item.stacksize); };
  const estPriceNumber = (item: InvItem) => { const price = item.singleton === 2 ? null : ctx.facts().get(item.typeID)?.averagePrice ?? null; return price && item.stacksize ? item.stacksize * price : 0; };
  // estPrice: the cfg's average price times the stack (none for a blueprint copy), FmtISK.
  const priceOf = (item: InvItem) => {
    const price = item.singleton === 2 ? null : ctx.facts().get(item.typeID)?.averagePrice ?? null;
    return price && item.stacksize ? iskWords(item.stacksize * price, 2, ctx.templates(), ctx.nameOf) ?? "" : "";
  };
  return [
    { label: "UI/Common/Name", text: (i) => typeName(i.typeID), sort: (i) => typeName(i.typeID).toLowerCase() },
    { label: "UI/Common/Quantity", text: (i) => qtyOf(i), sort: (i) => (i.singleton || i.typeID === 51 ? 0 : i.stacksize), right: true },
    { label: "UI/Inventory/ItemGroup", text: (i) => ctx.nameOf("typeGroup", i.typeID), sort: (i) => ctx.nameOf("typeGroup", i.typeID).toLowerCase() },
    { label: "UI/Inventory/ItemCategory", text: (i) => ctx.nameOf("typeCategory", i.typeID), sort: (i) => ctx.nameOf("typeCategory", i.typeID).toLowerCase() },
    { label: "UI/Inventory/ItemSize", text: (i) => sizeOf(i), sort: (i) => sizeOf(i) },
    { label: "UI/Inventory/ItemSlot", text: (i) => slotOf(i), sort: (i) => slotOf(i) },
    { label: "UI/Inventory/ItemVolume", text: (i) => volumeOf(i), sort: (i) => volumeNumber(i), right: true },
    // metaLevel: FmtAmt(GetMetaLevel), nothing where there is none (or nought); sorted by the level or nought.
    { label: "UI/Inventory/ItemMetaLevel", text: (i) => { const m = ctx.facts().get(i.typeID)?.metaLevel ?? null; return m ? fmtAmt(m) : ""; }, sort: (i) => ctx.facts().get(i.typeID)?.metaLevel ?? 0, right: true },
    // _get_item_tech_level: '<right>%s' % techLevel, FmtAmt where it is set - so "None" where the type has none.
    { label: "UI/Inventory/ItemTechLevel", text: (i) => { const t = ctx.facts().get(i.typeID)?.techLevel ?? null; return t ? fmtAmt(t) : String(t === null ? "None" : t); }, sort: (i) => String(ctx.facts().get(i.typeID)?.techLevel ?? "None"), right: true },
    { label: "UI/Contracts/ContractsWindow/EstPrice", text: (i) => priceOf(i), sort: (i) => estPriceNumber(i), right: true },
  ];
}

/** The grid's column widths for the shown columns (the name wide, group and category shared, the numbers narrow). */
export function invItemGridColumns(shown: readonly InvItemColumn[]): string {
  return shown.map((c) => (c.label === "UI/Common/Name" ? "minmax(160px, 2fr)" : c.label === "UI/Inventory/ItemGroup" || c.label === "UI/Inventory/ItemCategory" ? "1fr" : c.label === "UI/Contracts/ContractsWindow/EstPrice" ? "110px" : c.label === "UI/Inventory/ItemVolume" ? "90px" : "64px")).join(" ");
}
