// The EVE client's resource store: tq/resfileindex.txt maps each res: path to a
// blob under ResFiles/. Lines are `res:/path,blob/name,md5,size,compressedSize`.
// Blobs on disk are stored whole (size == file length), so reading one is a plain read.

import fs from "node:fs";
import path from "node:path";

export function clientBuild(clientDir) {
  const ini = fs.readFileSync(path.join(clientDir, "tq", "start.ini"), "utf8");
  const m = /^\s*build\s*=\s*(\d+)/im.exec(ini);
  if (!m) throw new Error(`no build= line in ${path.join(clientDir, "tq", "start.ini")}`);
  return m[1];
}

export function openResFiles(clientDir) {
  const indexFile = path.join(clientDir, "tq", "resfileindex.txt");
  const entries = new Map();
  for (const line of fs.readFileSync(indexFile, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const [res, blob, md5, size] = line.split(",");
    entries.set(res.toLowerCase(), { res, blob, md5, size: Number(size) });
  }
  const resDir = path.join(clientDir, "ResFiles");
  return {
    entries,
    has: (res) => entries.has(res.toLowerCase()),
    entry: (res) => entries.get(res.toLowerCase()) ?? null,
    read(res) {
      const e = entries.get(res.toLowerCase());
      if (!e) throw new Error(`not in the client's index: ${res}`);
      const buf = fs.readFileSync(path.join(resDir, ...e.blob.split("/")));
      if (buf.length !== e.size) throw new Error(`${res}: ${buf.length} bytes on disk, index says ${e.size}`);
      return buf;
    },
    list(prefix, re = null) {
      const p = prefix.toLowerCase();
      const out = [];
      for (const [k, e] of entries) if (k.startsWith(p) && (!re || re.test(k))) out.push(e.res);
      return out;
    },
  };
}

/** The single EVE install under the usual places, when --client is not given. */
export function findClient() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const roots = [path.join(home, "Documents"), "C:\\", "D:\\", "C:\\Program Files", "C:\\Program Files (x86)"];
  const found = [];
  for (const r of roots) {
    let names = [];
    try { names = fs.readdirSync(r); } catch { continue; }
    for (const n of names) {
      if (!/^EVE( Online)?/i.test(n)) continue;
      const d = path.join(r, n);
      if (fs.existsSync(path.join(d, "tq", "resfileindex.txt"))) found.push(d);
    }
  }
  return [...new Set(found.map((d) => fs.realpathSync(d)))];
}
