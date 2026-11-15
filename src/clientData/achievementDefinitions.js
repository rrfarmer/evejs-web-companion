"use strict";

// The 24.02 AchievementData flatbuffer (ACHV). Field numbers are from
// achievement_system/client/model/flatbuffer/generated.py. Keep localization
// IDs so the browser can use the language of the installed client.
function readAchievementDefinitions(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let remainingTables = 50_000;
  const fail = () => { throw new Error("Invalid achievement definitions (ACHV)."); };
  const check = (at, size) => {
    if (!Number.isSafeInteger(at) || at < 0 || size < 0 || at + size > b.length) fail();
    return at;
  };
  const u16 = (at) => b.readUInt16LE(check(at, 2));
  const u32 = (at) => b.readUInt32LE(check(at, 4));
  const indirect = (at) => {
    const offset = u32(at);
    if (offset < 4) fail();
    return check(at + offset, 4);
  };
  function table(at) {
    if (--remainingTables < 0) fail();
    const v = at - b.readInt32LE(check(at, 4));
    const fields = u16(v), length = u16(v + 2);
    if (fields < 4 || fields % 2 || length < 4) fail();
    check(v, fields);
    check(at, length);
    const field = (slot, width) => {
      const entry = 4 + 2 * slot;
      const offset = entry < fields ? u16(v + entry) : 0;
      // The producer reuses vtables at matching offsets even across types
      // with different field widths. Bound the decoded width by the buffer.
      if (offset && (offset < 4 || offset >= length)) fail();
      return offset ? check(at + offset, width) : null;
    };
    const ref = (slot) => {
      const f = field(slot, 4);
      return f === null ? null : indirect(f);
    };
    function integer(slot, width, read) {
      const f = field(slot, width);
      if (f === null) return 0;
      const value = Number(read.call(b, f));
      if (!Number.isSafeInteger(value)) fail();
      return value;
    }
    return {
      byte: (slot) => integer(slot, 1, b.readUInt8),
      int: (slot) => integer(slot, 4, b.readUInt32LE),
      long: (slot) => integer(slot, 8, b.readBigUInt64LE),
      date: (slot) => integer(slot, 8, b.readBigInt64LE),
      text(slot) {
        const p = ref(slot);
        if (p === null) return "";
        const n = u32(p);
        check(p + 4, n + 1);
        if (b[p + 4 + n] !== 0) fail();
        return b.toString("utf8", p + 4, p + 4 + n);
      },
      child(slot) {
        const p = ref(slot);
        return p === null ? null : table(p);
      },
      list(slot, read) {
        const p = ref(slot);
        if (p === null) return [];
        const n = u32(p);
        if (n > remainingTables) fail();
        check(p + 4, n * 4);
        return Array.from({ length: n }, (_, i) => read(table(indirect(p + 4 + i * 4))));
      },
    };
  }
  if (b.length < 8 || b.toString("ascii", 4, 8) !== "ACHV") fail();
  const categories = [], achievements = [], seen = new Set();
  const identifier = (t) => {
    const id = t.text(0).toLowerCase();
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) fail();
    return id;
  };
  const reward = (t) => {
    const kind = [null, "ISK", "SP", "item", "title"][t.byte(1)] ?? null;
    const payload = t.child(2);
    return { id: identifier(t), kind, description: t.int(5), omega: Boolean(t.byte(4)),
      amount: payload && (kind === "ISK" || kind === "SP" || kind === "item") ? payload.long(kind === "item" ? 1 : 0) : null,
      typeID: kind === "item" ? payload?.int(0) ?? null : null,
      titleID: kind === "title" ? payload?.text(0) ?? null : null };
  };
  const categoryMilestone = (t) => ({ id: identifier(t), target: t.int(1), rewards: t.list(2, reward) });
  const achievementMilestone = (t) => ({ id: identifier(t), target: t.long(1), points: t.int(2), rewards: t.list(3, reward) });
  function achievement(t, category) {
    const id = identifier(t);
    if (seen.has(id)) fail();
    seen.add(id);
    achievements.push({ id, category, name: t.int(1), description: t.int(2), flavor: t.int(3), icon: t.text(4),
      milestones: t.list(7, achievementMilestone), releasedAt: t.date(8), expiresAt: t.date(9), archived: Boolean(t.byte(12)),
      visibility: t.byte(14), featured: Boolean(t.child(18)?.byte(2)) });
    return id;
  }
  function category(t, parent, depth = 0) {
    if (depth > 12) fail();
    const id = identifier(t);
    if (seen.has(id)) fail();
    seen.add(id);
    const presentation = t.child(10);
    const row = { id, parent, name: t.int(1), description: t.int(2), icon: t.text(3),
      milestones: t.list(4, categoryMilestone), style: presentation?.text(1) ?? "",
      featured: presentation?.int(2) ?? 0, categories: [], achievements: [] };
    categories.push(row);
    row.categories = t.list(5, (child) => category(child, id, depth + 1));
    row.achievements = t.list(6, (child) => achievement(child, id));
    return id;
  }
  const root = table(indirect(0));
  const roots = {};
  for (const [name, slot] of Object.entries({ career: 0, challenges: 1, timeLimited: 2, manual: 4 })) {
    const t = root.child(slot);
    if (t) roots[name] = category(t, null);
  }
  if (!roots.career || !roots.challenges) fail();
  return { roots, categories, achievements };
}

module.exports = { readAchievementDefinitions };
