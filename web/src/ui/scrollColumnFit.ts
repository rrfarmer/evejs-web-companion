// carbonui Scroll.ResetColumnWidth (scroll.py 1133): a column of an id'd scroll fitted to its widest text - the header's
// or a row's - with the scroll's tabMargin (uiconst.LABELTABMARGIN 8) either side, no narrower than MINCOLUMNWIDTH 24.

const MIN_COLUMN_WIDTH = 24;
const TAB_MARGIN = 8;

/** The width ResetColumnWidth gives the column of this header cell, measured from the table's text as drawn. */
export function fittedColumnWidth(th: HTMLTableCellElement): number {
  const table = th.closest("table");
  const index = th.cellIndex;
  const columns = th.parentElement instanceof HTMLTableRowElement ? th.parentElement.cells.length : 0;
  const range = document.createRange();
  const textWidth = (el: Node | null | undefined): number => {
    if (!el || !el.textContent?.trim()) return 0;
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width;
  };
  // the header's own text (its label, not the sort caret or the scale handle)
  let widest = 0;
  for (const node of th.childNodes) if (node.nodeType === Node.TEXT_NODE || (node instanceof HTMLElement && !node.matches(".scaler, .dir, .dscan-scaler"))) widest += textWidth(node);
  for (const body of table?.tBodies ?? []) {
    for (const tr of body.rows) {
      if (tr.cells.length !== columns) continue; // a group's heading row spans the columns
      widest = Math.max(widest, textWidth(tr.cells[index]));
    }
  }
  return Math.max(MIN_COLUMN_WIDTH, Math.ceil(widest) + TAB_MARGIN * 2);
}


/**
 * Scroll.OnHome / OnEnd (commandSvc's Home / End to the focused scroll): ScrollToProportion(0.0 / 1.0) - the list
 * scrolled to its top or its end, the selection as it was. The scroll is the nearest ancestor that scrolls.
 */
export function scrollListHomeEnd(from: HTMLElement, end: boolean): void {
  let el: HTMLElement | null = from.parentElement;
  while (el && !(el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  if (el) el.scrollTop = end ? el.scrollHeight : 0;
}
