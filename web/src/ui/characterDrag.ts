/** A character row, as opposed to the text or link dragged from a message body. */
export const CHARACTER_DRAG_MIME = "application/x-evejs-character";

export function dragCharacter(event: DragEvent, characterID: number, name: string): void {
  event.dataTransfer?.setData(CHARACTER_DRAG_MIME, String(characterID));
  event.dataTransfer?.setData("text/plain", name);
}

export function droppedCharacter(event: DragEvent): number | null {
  const raw = event.dataTransfer?.getData(CHARACTER_DRAG_MIME);
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
