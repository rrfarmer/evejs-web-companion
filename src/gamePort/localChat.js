"use strict";

const PREFIX = "eve_public.chat.local.api.";
const MEMBERSHIP_WAIT_MS = 4_000;
const EARLY_MEMBERSHIP_MS = 5_000;
const SPEAKER_IDLE_MS = 900_000;
const BACKLOG_LIMIT = 200;

// Region 10000070 in the 3698585 SDE. The client classifies these using the system's faction.
const POCHVEN = new Set([
  30000021, 30000157, 30000192, 30000206, 30001372, 30001381, 30001413, 30001445, 30002079,
  30002225, 30002411, 30002652, 30002702, 30002737, 30002770, 30002797, 30003046, 30003495,
  30003504, 30005005, 30005029, 30010141, 30020141, 30031392, 30040141, 30045328, 30045329,
]);

function systemCategory(id) {
  const range = Math.floor(id / 1_000_000);
  if ([32, 34, 36].includes(range)) return "nolocal";
  if (range === 31 || id === 30100000) return "wormhole";
  return POCHVEN.has(id) ? "triglavian" : "local";
}

function positive(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function chatError(message, code = "CHAT_NATIVE_UNAVAILABLE", statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode });
}

/** The pilot's Public Gateway Local controller. Other channels still use their own transports. */
class NativeLocalChat {
  constructor({ characterID, request, changed, now = Date.now }) {
    this.characterID = characterID;
    this.request = request;
    this.changed = changed;
    this.now = now;
    this.room = null;
    this.earlyMembership = null;
    this.membershipTimer = null;
    this.speakerTimer = null;
  }

  move(value) {
    const systemID = positive(value);
    if ((this.room?.systemID ?? null) === systemID) return;
    clearTimeout(this.membershipTimer);
    clearTimeout(this.speakerTimer);
    const early = this.earlyMembership;
    this.earlyMembership = null;
    const category = systemID === null ? null : systemCategory(systemID);
    const room = systemID === null ? null : {
      systemID, name: `${category}_${systemID}`,
      delayed: category === "wormhole" || category === "triglavian",
      suppressed: category === "nolocal",
      loaded: category === "nolocal", roster: new Map(), messages: [], revision: 0, refresh: null,
    };
    this.room = room;
    if (room && !room.suppressed && early?.systemID === systemID && this.now() - early.at < EARLY_MEMBERSHIP_MS) {
      this.replaceMembers(room, early.members);
      return;
    }
    this.publish();
    if (room && !room.suppressed) {
      this.membershipTimer = setTimeout(() => {
        if (this.room === room && !room.loaded) this.refreshMembers(room).catch(() => {});
      }, MEMBERSHIP_WAIT_MS);
      this.membershipTimer.unref?.();
    }
  }

  snapshot(limit) {
    const room = this.room;
    const capped = Math.max(1, Math.min(Number(limit) || 50, BACKLOG_LIMIT));
    const oldest = this.now() - SPEAKER_IDLE_MS;
    return {
      channel: "local", roomName: room?.name ?? null, solarSystemID: room?.systemID ?? null,
      corporationID: null, loaded: room?.loaded ?? false,
      roster: [...(room?.roster.values() ?? [])].filter(member => member.spokeAt == null || member.spokeAt > oldest)
        .map(({ spokeAt, ...member }) => member),
      messages: room?.messages.slice(-capped) ?? [],
    };
  }

  publish() {
    this.changed(this.snapshot());
  }

  async call(type, payload = {}) {
    let result;
    try {
      result = await this.request(`${PREFIX}${type}`, payload);
    } catch (error) {
      throw chatError(error.message || "Local chat could not reach the public gateway.");
    }
    if (result.statusCode !== 200) {
      const status = result.statusCode === 400 || result.statusCode === 403 ? result.statusCode : 502;
      throw chatError(result.statusMessage || "The public gateway refused the Local chat request.",
        status === 502 ? "CHAT_NATIVE_UNAVAILABLE" : "CHAT_LINE_REFUSED", status);
    }
    return result.payload;
  }

  refreshMembers(room) {
    if (room.refresh) return room.refresh;
    const revision = room.revision;
    room.refresh = this.call("GetMembershipListRequest").then(payload => {
      if (this.room === room && room.revision === revision && positive(payload?.solar_system?.sequential) === room.systemID) {
        this.replaceMembers(room, payload.members);
      }
    }).finally(() => { room.refresh = null; });
    return room.refresh;
  }

  async read(context) {
    const room = this.room;
    if (room && !room.suppressed) await this.refreshMembers(room);
    context.assertCurrent();
    return this.snapshot(context.limit);
  }

  async send(message, context) {
    const room = this.room;
    if (!room || room.suppressed) throw chatError("Local chat is unavailable in this system.", "CHAT_NO_CHANNEL", 409);
    context.assertCurrent();
    await this.call("BroadcastMessageRequest", { message });
    context.assertCurrent();
    return { channel: "local", roomName: room.name, sent: true, entry: this.entry(this.characterID, message) };
  }

  entry(characterID, message) {
    return { characterID, characterName: `Character ${characterID}`, message, createdAtMs: this.now() };
  }

  member(room, characterID) {
    return { characterID, name: `Character ${characterID}`, corporationID: null, allianceID: null, solarSystemID: room.systemID };
  }

  addMember(room, member, roster = room.roster) {
    const id = positive(member?.character?.sequential);
    if (!id) return;
    roster.set(id, {
      ...this.member(room, id),
      corporationID: positive(member.corporation?.sequential),
      allianceID: positive(member.alliance?.sequential),
      spokeAt: room.roster.get(id)?.spokeAt,
    });
  }

  replaceMembers(room, members) {
    const roster = new Map();
    for (const member of members ?? []) this.addMember(room, member, roster);
    room.roster = roster;
    room.loaded = true;
    room.revision++;
    this.scheduleExpiry(room);
    this.publish();
  }

  notice(typeName, payload) {
    if (!typeName?.startsWith(PREFIX)) return;
    const type = typeName.slice(PREFIX.length);
    const systemID = positive(payload?.solar_system?.sequential);
    if (!systemID) return;
    const room = this.room;
    if (room?.systemID !== systemID) {
      if (type === "MembershipListNotice") this.earlyMembership = { systemID, members: payload.members, at: this.now() };
      return;
    }
    if (room.suppressed) return;
    if (type === "MembershipListNotice") {
      this.replaceMembers(room, payload.members);
    } else if (type === "JoinNotice" || type === "MembershipRefreshedNotice") {
      if (type === "MembershipRefreshedNotice" && !room.roster.has(positive(payload.member?.character?.sequential))) return;
      this.addMember(room, payload.member);
      room.revision++;
      this.publish();
    } else if (type === "LeaveNotice") {
      room.roster.delete(positive(payload.character?.sequential));
      room.revision++;
      this.publish();
    } else if (type === "MessageBroadcastNotice") {
      const characterID = positive(payload.author?.sequential);
      if (!characterID || typeof payload.message !== "string" || !payload.message) return;
      const entry = this.entry(characterID, payload.message);
      if (characterID > 1) {
        const member = room.roster.get(characterID) ?? this.member(room, characterID);
        room.roster.set(characterID, room.delayed ? { ...member, spokeAt: entry.createdAtMs } : member);
        room.revision++;
        this.scheduleExpiry(room);
      }
      this.keepLine(room, entry);
    }
  }

  /** The legacy command channel still returns its system lines over XMPP. */
  systemLine(systemID, entry) {
    if (this.room?.systemID === systemID && !this.room.suppressed) this.keepLine(this.room, entry);
  }

  keepLine(room, entry) {
    room.messages.push(entry);
    if (room.messages.length > BACKLOG_LIMIT) room.messages.shift();
    this.publish();
  }

  scheduleExpiry(room) {
    clearTimeout(this.speakerTimer);
    const now = this.now();
    let earliest = Infinity;
    for (const { spokeAt } of room.roster.values()) {
      const expiry = spokeAt + SPEAKER_IDLE_MS;
      if (expiry > now && expiry < earliest) earliest = expiry;
    }
    if (Number.isFinite(earliest)) {
      this.speakerTimer = setTimeout(() => {
        if (this.room !== room) return;
        this.publish();
        this.scheduleExpiry(room);
      }, earliest - now);
      this.speakerTimer.unref?.();
    }
  }

  close() {
    clearTimeout(this.membershipTimer);
    clearTimeout(this.speakerTimer);
    this.room = null;
    this.earlyMembership = null;
  }
}

module.exports = { NativeLocalChat };
