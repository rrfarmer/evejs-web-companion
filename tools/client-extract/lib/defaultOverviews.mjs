// The client's default overview presets (res:/staticData/defaultOverviews.fsdbinary, read in the client by the
// compiled defaultOverviewsLoader: characterdata/defaultOverviews.py), decoded from the file's layout, which was read
// against that loader's own output for build 3396210 (every preset's groups the same, in the same order):
//
//   - a record is { u64 nameOffset, u32 overviewNameID, u32 1 }, nameOffset counted from byte 24 of the file, to
//     the preset's short name: a u64 length and its bytes (padded to 8);
//   - the preset's groups are the list that ends where the name begins: a u64 count and that many u32 groupIDs.
//
// Each step is checked; a file that does not hold to it is refused rather than half read.

/** [{ shortName, nameID, groups }] of every preset in the file. */
export function readDefaultOverviews(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u64 = (at) => Number(dv.getBigUint64(at, true));
  const out = [];
  for (let at = 24; at + 16 <= buf.length; at += 8) {
    if (dv.getUint32(at + 12, true) !== 1) continue;
    const nameID = dv.getUint32(at + 8, true);
    if (nameID < 1000) continue;
    const lenAt = u64(at) + 24;
    if (lenAt + 8 > buf.length) continue;
    const len = u64(lenAt);
    if (len < 1 || len > 64 || lenAt + 8 + len > buf.length) continue;
    const shortName = buf.subarray(lenAt + 8, lenAt + 8 + len).toString("latin1");
    if (!/^[a-z][a-z0-9_]*$/.test(shortName)) continue;
    // the list that ends where the name's length begins
    let groups = null;
    for (let p = lenAt - 8; p >= 24 && !groups; p -= 4) {
      const n = u64(p);
      if (n > 0 && n < 5000 && (p + 8 + 4 * n === lenAt || Math.ceil((p + 8 + 4 * n) / 8) * 8 === lenAt)) {
        groups = Array.from({ length: n }, (_, i) => dv.getUint32(p + 8 + 4 * i, true));
      }
    }
    if (!groups) throw new Error(`defaultOverviews: no group list before preset ${shortName}`);
    out.push({ shortName, nameID, groups });
  }
  if (!out.some((p) => p.shortName === "default")) throw new Error("defaultOverviews: no 'default' preset found");
  return out;
}

/** characterdata/defaultOverviews.py DEFAULT_TAB_NAMES: the overview's tabs as the client first sets them up. */
export const DEFAULT_TAB_NAMES = ["default", "defaultmining", "defaultwarpto"];
