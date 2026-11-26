// The page's xmppchatsvc private-conversation flow (build 3396210:328-342,
// 561-624,1197-1269,1327-1388). Atomic protocol operations stay in api.ts.
import * as api from "./api.ts";
import { createSignal, readonlySignal } from "../store/signals.ts";
import { decodeChatChannel } from "../bridge/chat.ts";
import { addressBookOf, contactLabelsOf, type AddressBook, type NamedAddressBook } from "../bridge/contacts.ts";
import { isNpcOwner } from "../bridge/mail.ts";
import { autoRejectInvitations } from "./autoRejectInvitations.ts";
import type { ChatChannelState } from "../store/types.ts";
import type { JsonValue } from "../bridge/wire.ts";
import type { ContactAction } from "../ui/contactAction.ts";

export type ChatInviteChoice = "accept" | "acceptadd" | "reject" | "block";
export interface ChatConversation { readonly channel: string; readonly title: string; readonly state: ChatChannelState }
export interface ChatInvitation { readonly id: string; readonly roomName: string; readonly senderCharacterID: number; readonly password: string }
export interface ChatConversationState {
  readonly generation: number; readonly active: string | null; readonly rooms: readonly ChatConversation[];
  readonly invitations: readonly ChatInvitation[]; readonly contactAdds: readonly { readonly id: number; readonly action: ContactAction; readonly current: () => void }[];
  readonly openSerial: number; readonly busy: boolean; readonly error: string | null;
}
interface Scope { readonly me: number; readonly role: bigint; readonly options: api.ApiOptions; readonly current: () => void }
interface Hooks {
  readonly capture: () => Scope;
  readonly word: (label: string, args: Readonly<Record<string, string | number>>, fallback: string) => string;
  readonly say: (dialog: string, args: Readonly<Record<string, JsonValue>>, fallback: string) => void;
}
const record = (value: JsonValue | undefined): Record<string, JsonValue> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
const retired = (error: unknown): boolean => (error as { code?: string })?.code === "SESSION_REQUEST_RETIRED";
const ENGLISH_HELP_ROOM = "system_263238_263262";

export function createChatConversations(hooks: Hooks) {
  let generation = 0, serial = 0, contactSerial = 0;
  const blank = (): ChatConversationState => ({ generation, active: null, rooms: [], invitations: [], contactAdds: [], openSerial: serial, busy: false, error: null });
  const state = createSignal<ChatConversationState>(blank());
  const pendingPrivate = new Map<string, { target: number; invited: boolean }>();
  const pendingInvites = new Map<number, string>();
  const information = new Map<string, Record<string, JsonValue>>();
  const directoryTitles = new Map<string, string>();
  const destroyedRooms = new Set<string>();
  const seenDeclines = new Set<string>();
  const ownerNames = new Map<number, string>();
  const owners = new Map<number, Promise<boolean>>();
  let rules: ReturnType<typeof api.readChatRules> | null = null;
  let book: Promise<AddressBook> | null = null;
  let refreshWork: Promise<void> | null = null;
  const patch = (change: Partial<ChatConversationState>) => state.set({ ...state.get(), ...change });
  function capture(): Scope {
    const scope = hooks.capture(), epoch = generation, held = scope.current;
    return { ...scope, current: () => { held(); if (epoch !== generation) throw Object.assign(new Error("This conversation belongs to a retired pilot."), { code: "SESSION_REQUEST_RETIRED" }); } };
  }
  const name = (id: number) => ownerNames.get(id) ?? String(id);
  async function names(scope: Scope, ids: readonly number[]): Promise<void> {
    const missing = [...new Set(ids)].filter(id => !ownerNames.has(id));
    if (!missing.length) return;
    const answer = await api.resolveNames(missing.map(id => ({ kind: "owner" as const, id })), scope.options); scope.current();
    for (const id of missing) { const value = answer.names[`owner:${id}`]; if (value) ownerNames.set(id, value); }
  }
  async function personal(scope: Scope): Promise<AddressBook> {
    book ??= api.bridgeAsk(scope.options)("charMgr", "GetContactList", []).then(addressBookOf);
    const answer = await book; scope.current(); return answer;
  }
  async function character(scope: Scope, id: number): Promise<boolean> {
    if (id === scope.me || id <= 0 || isNpcOwner(id)) return false;
    if (!owners.has(id)) owners.set(id, (async () => {
      rules ??= api.readChatRules(scope.options);
      const [constants, identity] = await Promise.all([rules, api.resolveNames([{ kind: "ownerType", id }], scope.options)]); scope.current();
      const typeID = Number(identity.names[`ownerType:${id}`]);
      if (!typeID) return false;
      const types = await api.getTypePrices([typeID], scope.options); scope.current();
      return types.groupID[typeID] === constants.groupCharacter;
    })());
    const result = await owners.get(id)!; scope.current(); return result;
  }
  async function applyRoom(scope: Scope, raw: JsonValue): Promise<void> {
    const value = record(raw), channel = String(value.channel ?? ""), roomName = String(value.roomName ?? "");
    const isHelpRoom = channel === ENGLISH_HELP_ROOM;
    const systemMessage = /^system_\d+_(\d+)$/.exec(channel)?.[1];
    if ((!/^(private|player)_/.test(channel) && !systemMessage) || !roomName || destroyedRooms.has(channel)) return;
    const decoded = decodeChatChannel(raw), pending = pendingPrivate.get(channel);
    const observed = Array.isArray(value.seenMembers) ? value.seenMembers : decoded.roster.map(member => member.characterID);
    if (pending && observed.includes(pending.target)) { pendingPrivate.delete(channel); if (pendingInvites.get(pending.target) === channel) pendingInvites.delete(pending.target); }
    for (const [who, room] of pendingInvites) if (room === channel && observed.includes(who)) pendingInvites.delete(who);
    await names(scope, [...decoded.roster.map(member => member.characterID), ...(pendingPrivate.get(channel) ? [pendingPrivate.get(channel)!.target] : [])]);
    if (!systemMessage && !information.has(channel)) { const info = await api.readChatRoomInfo(roomName, scope.options); scope.current(); information.set(channel, record(info)); }
    const info = information.get(channel);
    let title = systemMessage ? hooks.word(`#${systemMessage}`, {}, directoryTitles.get(channel) ?? (isHelpRoom ? "English Help" : roomName)) :
      typeof info?.name === "string" && info.name ? info.name : (directoryTitles.get(channel) ?? roomName);
    if (channel.startsWith("private_")) {
      const others = decoded.roster.filter(member => member.characterID !== scope.me).map(member => name(member.characterID));
      if (!others.length && decoded.roster.length && pendingPrivate.has(channel)) others.push(name(pendingPrivate.get(channel)!.target));
      title = others.length > 1 ? hooks.word("UI/Chat/GroupChat", { title: others.join(", ") }, `Group Chat (${others.join(", ")})`)
        : others.length === 1 ? hooks.word("UI/Chat/PrivateChat", { title: others[0]! }, `Private Chat (${others[0]})`)
          : !decoded.roster.length && Number(info?.occupants) >= 2 ? hooks.word("UI/Chat/PrivateChat", { title: Number(info?.occupants) }, `Private Chat (${Number(info?.occupants)})`)
            : hooks.word("UI/Chat/PrivateChatAlone", {}, "Private Chat (Alone)");
    }
    scope.current();
    if (destroyedRooms.has(channel)) return;
    const room = { channel, title, state: decoded };
    patch({ rooms: [...state.get().rooms.filter(entry => entry.channel !== channel), room] });
  }
  async function join(scope: Scope, room: string, password = ""): Promise<void> {
    let kept = ""; try { kept = globalThis.localStorage?.getItem(`evejs-web-user-ui:${room}Password`) ?? ""; } catch { /* browser storage unavailable */ }
    if (password) { try { globalThis.localStorage?.setItem(`evejs-web-user-ui:${room}Password`, password); } catch { /* held in this invitation */ } }
    const raw = await api.joinChatRoom(room, password || kept, scope.options); scope.current();
    await applyRoom(scope, raw); scope.current(); patch({ active: room, openSerial: ++serial });
  }
  async function close(scope: Scope, room: string): Promise<void> {
    await api.leaveChatRoom(room, scope.options); scope.current();
    removeRoom(room);
  }
  function removeRoom(room: string) {
    const pending = pendingPrivate.get(room);
    if (pending) pendingInvites.delete(pending.target);
    pendingPrivate.delete(room); information.delete(room);
    patch({ rooms: state.get().rooms.filter(entry => entry.channel !== room), active: state.get().active === room ? null : state.get().active });
  }
  async function accept(scope: Scope, invitation: ChatInvitation): Promise<void> {
    await join(scope, invitation.roomName, invitation.password); scope.current();
    await api.acknowledgeChatInvitation(invitation.id, scope.options); scope.current();
  }
  async function addContact(scope: Scope, id: number): Promise<void> {
    const contacts = await personal(scope);
    const labels = contactLabelsOf(await api.bridgeAsk(scope.options)("charMgr", "GetLabels", [])); scope.current();
    await names(scope, [id, ...contacts.contacts.map(entry => entry.contactID), ...contacts.blocked, ...contacts.agents]);
    const named: NamedAddressBook = { contacts: contacts.contacts.map(entry => ({ ...entry, name: name(entry.contactID) })), blocked: contacts.blocked.map(ownerID => ({ ownerID, name: name(ownerID) })), agents: contacts.agents.map(agentID => ({ agentID, name: name(agentID) })), labels };
    scope.current(); patch({ contactAdds: [...state.get().contactAdds, { id: ++contactSerial, action: { kind: "manage", ownerID: id, name: name(id), book: named }, current: scope.current }] });
  }
  async function refreshIn(scope: Scope): Promise<void> {
    const answer = record(await api.readChatRooms(scope.options)); scope.current();
    const channels = Array.isArray(answer.channels) ? answer.channels : [];
    const joined = new Set(channels.map(entry => String(record(entry).channel ?? "")));
    for (const raw of channels) await applyRoom(scope, raw);
    scope.current(); patch({ rooms: state.get().rooms.filter(room => joined.has(room.channel)) });
    const declines = Array.isArray(answer.declines) ? answer.declines : [];
    for (const value of declines) {
      const decline = record(value), id = String(decline.id), who = Number(decline.senderCharacterID), room = String(decline.roomName), reason = String(decline.reason);
      if (seenDeclines.has(id)) continue; seenDeclines.add(id);
      if (!pendingInvites.has(who)) continue;
      pendingInvites.delete(who); if (pendingPrivate.has(room)) await close(scope, room);
      scope.current(); const dialog = reason === "rejected" ? "ChtRejected" : reason === "blocked" ? "ChtCharNotReachable" : reason === "rejected_and_blocked" ? "ChtBlockedNow" : null;
      if (dialog) hooks.say(dialog, { char: who }, "The conversation invitation was declined.");
    }
    const waiting: ChatInvitation[] = [];
    for (const raw of Array.isArray(answer.invitations) ? answer.invitations : []) {
      const value = record(raw), invitation = { id: String(value.id), roomName: String(value.roomName), senderCharacterID: Number(value.senderCharacterID), password: String(value.password ?? "") };
      const contacts = await personal(scope); scope.current();
      if (contacts.blocked.includes(invitation.senderCharacterID)) await api.rejectChatInvitation(invitation.id, "blocked", scope.options);
      else if (autoRejectInvitations.get()) await api.rejectChatInvitation(invitation.id, "rejected", scope.options);
      else if (contacts.contacts.some(entry => entry.contactID === invitation.senderCharacterID)) await accept(scope, invitation);
      else if (joined.has(invitation.roomName)) await api.acknowledgeChatInvitation(invitation.id, scope.options);
      else waiting.push(invitation);
      scope.current();
    }
    await names(scope, waiting.map(invitation => invitation.senderCharacterID)); scope.current();
    patch({ invitations: waiting, error: null });
  }
  async function task(operation: (scope: Scope) => Promise<void>): Promise<void> {
    const scope = capture(); scope.current(); patch({ busy: true, error: null });
    try { await operation(scope); scope.current(); }
    catch (error) { if (!retired(error)) { scope.current(); patch({ error: error instanceof Error ? error.message : String(error) }); } throw error; }
    finally { try { scope.current(); patch({ busy: false }); } catch { /* retired owner */ } }
  }
  return {
    state: readonlySignal(state),
    name,
    reset() { generation++; pendingPrivate.clear(); pendingInvites.clear(); information.clear(); directoryTitles.clear(); destroyedRooms.clear(); seenDeclines.clear(); owners.clear(); rules = null; book = null; refreshWork = null; state.set(blank()); },
    invalidateContacts() { book = null; },
    async canStart(id: number) { return character(capture(), id); },
    async invitable(target: number) {
      const scope = capture();
      const result: { channel: string; title: string }[] = [];
      for (const room of state.get().rooms) {
        if (!/^(private|player)_/.test(room.channel) || room.state.roster.some(member => member.characterID === target)) continue;
        const info = record(await api.readChatRoomInfo(room.channel, scope.options)); scope.current();
        const title = room.channel.startsWith("private_")
          ? Number(info.occupants) < 2 ? hooks.word("UI/Chat/PrivateChatAlone", {}, "Private Chat (Alone)") : room.title
          : typeof info.name === "string" ? info.name : room.title;
        result.push({ channel: room.channel, title });
      }
      return result.sort((a, b) => a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
    },
    async refresh() {
      if (refreshWork) return refreshWork;
      const scope = capture();
      const work = refreshIn(scope).catch(error => { if (!retired(error)) { scope.current(); patch({ error: error instanceof Error ? error.message : String(error) }); } }).finally(() => { if (refreshWork === work) refreshWork = null; });
      refreshWork = work; return work;
    },
    select(room: string | null) { patch({ active: room }); },
    async joinDirectoryChannel(room: string, title: string) {
      if (!/^(?:system_\d+_\d+|player_[a-z0-9_-]+)$/.test(room)) throw new Error("Choose a channel from the directory.");
      if (state.get().rooms.some(entry => entry.channel === room)) {
        patch({ active: room, openSerial: ++serial });
        return;
      }
      await task(scope => {
        directoryTitles.set(room, title);
        return join(scope, room);
      });
    },
    async openHelpChannel() {
      if (state.get().rooms.some(room => room.channel === ENGLISH_HELP_ROOM)) {
        patch({ active: ENGLISH_HELP_ROOM, openSerial: ++serial });
        return;
      }
      await task(scope => join(scope, ENGLISH_HELP_ROOM));
    },
    async start(target: number, existingRoom?: string) { await task(async scope => {
      if (target === scope.me) { hooks.say("ChtCannotInviteSelf", { char: target, channel: existingRoom ?? null }, "You cannot invite yourself."); return; }
      if (!await character(scope, target)) { hooks.say("CustomInfo", { info: hooks.word("UI/Chat/ErrorNotAPlayerCharacter", {}, "That is not a player character.") }, "That is not a player character."); return; }
      if (!existingRoom && pendingInvites.has(target)) { hooks.say("ChtAlreadyInvited", { char: target }, "That pilot already has a pending invitation."); return; }
      let room = existingRoom;
      if (!room) {
        const raw = await api.bridgeDo(scope.options)("XmppChatMgr", "CreatePrivateChannel", [target]); scope.current();
        room = typeof raw === "string" ? raw : String(record(raw).value ?? "");
        if (!room) throw new Error("Could not create channel for private chat");
        pendingPrivate.set(room, { target, invited: false }); pendingInvites.set(target, room);
        await join(scope, room);
      }
      rules ??= api.readChatRules(scope.options); const constants = await rules; scope.current();
      if ((scope.role & constants.elevated) !== 0n) await api.bridgeDo(scope.options)("XmppChatMgr", "AddCharacterToChannel", [room, target, `Added by ${scope.me}`]);
      else if (existingRoom) await api.inviteToChatRoom(room, target, "", scope.options);
      scope.current();
    }); },
    async send(room: string, message: string) { if (!message.trim()) return; await task(async scope => {
      // The native window's spam check precedes SendGroupChat's first invitation.
      await api.prepareChatMessage(room, message, scope.options); scope.current();
      const pending = pendingPrivate.get(room);
      if (pending && !pending.invited) { pending.invited = true; await api.inviteToChatRoom(room, pending.target, "Private chat", scope.options); scope.current(); }
      await api.sendChat(room, message, scope.options); scope.current();
      await applyRoom(scope, await api.readChat(room, scope.options));
    }); },
    async close(room: string) { await task(scope => close(scope, room)); },
    async destroyDirectoryChannel(room: string) {
      await task(async scope => {
        await api.destroyChatChannel(room, scope.options);
        scope.current();
        destroyedRooms.add(room);
        directoryTitles.delete(room);
        try { globalThis.localStorage?.removeItem(`evejs-web-user-ui:${room}Password`); } catch { /* browser storage unavailable */ }
        removeRoom(room);
      });
    },
    updateDirectoryChannelTitle(room: string, title: string) {
      if (destroyedRooms.has(room)) return;
      directoryTitles.set(room, title);
      information.set(room, { ...information.get(room), name: title });
      patch({ rooms: state.get().rooms.map(entry => entry.channel === room ? { ...entry, title } : entry) });
    },
    async answer(sender: number, choice: ChatInviteChoice, expectedGeneration: number) {
      if (expectedGeneration !== generation) return;
      await task(async scope => {
        const invitations = state.get().invitations.filter(entry => entry.senderCharacterID === sender);
        if (choice === "acceptadd") void addContact(scope, sender).catch(error => { if (!retired(error)) { scope.current(); patch({ error: String(error) }); } });
        if (choice === "block") void api.bridgeDo(scope.options)("charMgr", "BlockOwners", [[sender]]).then(() => { scope.current(); book = null; }).catch(error => { if (!retired(error)) { scope.current(); patch({ error: String(error) }); } });
        for (const invitation of invitations) {
          if (choice === "accept" || choice === "acceptadd") await accept(scope, invitation);
          else await api.rejectChatInvitation(invitation.id, choice === "block" ? "rejected_and_blocked" : "rejected", scope.options);
          scope.current();
        }
        patch({ invitations: state.get().invitations.filter(entry => entry.senderCharacterID !== sender) });
      });
    },
    contactDone(id: number) { book = null; patch({ contactAdds: state.get().contactAdds.filter(entry => entry.id !== id) }); },
  };
}
export type ChatConversations = ReturnType<typeof createChatConversations>;
