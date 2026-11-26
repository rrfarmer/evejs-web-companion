import type { ChatChannelState, ChatMessage } from "../store/types.ts";

interface SeenRoom {
  readonly roomName: string | null;
  readonly messages: readonly ChatMessage[];
  readonly latest: number;
  readonly unread: boolean;
}

export function createChatUnread() {
  const seen = new Map<string, SeenRoom>();
  let lastUnread: ReadonlySet<string> = new Set();
  return (rooms: ReadonlyMap<string, ChatChannelState>, pilot: number, displayed: string | null,
    disabled: ReadonlySet<string>, highlight: RegExp | null): ReadonlySet<string> => {
    const unread = new Set<string>();
    for (const id of seen.keys()) if (!rooms.has(id)) seen.delete(id);
    for (const [id, { roomName, messages }] of rooms) {
      const previous = seen.get(id);
      const sameRoom = previous?.roomName === roomName;
      const latest = sameRoom && previous.messages === messages ? previous.latest :
        messages.reduce((time, message) => Math.max(time, message.createdAtMs), sameRoom ? previous.latest : 0);
      // Rooms start with a backlog. Subsequent reads can overlap older reads
      // or replay the latest entries, including multiple entries at one time.
      const incoming = sameRoom && previous.messages !== messages && messages.some(message =>
        message.characterID > 1 && message.characterID !== pilot && message.createdAtMs >= previous.latest &&
        (!disabled.has(id) || highlight?.test(message.message)) &&
        !previous.messages.some(known => known.createdAtMs === message.createdAtMs &&
          known.characterID === message.characterID && known.message === message.message));
      const pending = id !== displayed && sameRoom && (previous.unread || incoming);
      seen.set(id, { roomName, messages, latest, unread: pending });
      if (pending) unread.add(id);
    }
    if (unread.size !== lastUnread.size || [...unread].some(id => !lastUnread.has(id))) lastUnread = unread;
    return lastUnread;
  };
}
