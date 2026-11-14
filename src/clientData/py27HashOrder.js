"use strict";

// The order a Python 2.7 dict or set of whole numbers iterates in, as CPython 2.7 lays out its table (dictobject.c,
// setobject.c): a whole number hashes to itself; a key goes to slot hash & mask, and on a collision to
// i = 5 * i + perturb + 1 (perturb starting at the hash, shifted right 5 each time); the table starts at 8 slots and,
// once an insert makes fill * 3 >= size * 2, is rebuilt at the smallest power of two above used * 4 (used * 2 past
// 50000), the old slots reinserted in their order. Iteration walks the slots. No deletions are made here.
//
// The client shows some lists as such a set: the job board's ore and ice types in a site (DungeonJob.resources:
// set(get_consolidated_ore_types_in_dungeon(...))), so their order on screen is this one.

function insert(table, mask, key) {
  let i = key & mask;
  let perturb = key;
  while (table[i] !== undefined) {
    i = (i * 5 + perturb + 1) % 0x100000000;
    perturb = Math.floor(perturb / 32);
    i &= mask;
  }
  table[i] = key;
}

/** The keys (non-negative whole numbers, inserted in this order, duplicates dropped) in a Python 2.7 dict's or set's order. */
function py27HashOrder(keys) {
  let size = 8;
  let table = new Array(size);
  let used = 0;
  const seen = new Set();
  for (const key of keys) {
    if (!Number.isSafeInteger(key) || key < 0 || seen.has(key)) continue;
    seen.add(key);
    insert(table, size - 1, key);
    used += 1;
    if (used * 3 >= size * 2) {
      const minused = used > 50000 ? used * 2 : used * 4;
      let next = 8;
      while (next <= minused) next *= 2;
      const old = table;
      size = next;
      table = new Array(size);
      for (const k of old) if (k !== undefined) insert(table, size - 1, k);
    }
  }
  return table.filter((k) => k !== undefined);
}

module.exports = { py27HashOrder };
