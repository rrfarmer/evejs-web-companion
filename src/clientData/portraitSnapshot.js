"use strict";

// Browser canvas encoders produce baseline or progressive JPEGs. Bound the
// body, and require a 512px square frame header followed by an image scan.
function portraitSnapshotBytes(base64) {
  if (typeof base64 !== "string" || base64.length > 60_000 || base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 16 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return null;
  let frame = false;
  for (let offset = 2; offset + 4 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    if (offset + 3 >= bytes.length) return null;
    const marker = bytes[offset++];
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length >= bytes.length) return null;
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || length < 8 || bytes[offset + 2] !== 8 ||
          bytes.readUInt16BE(offset + 3) !== 512 || bytes.readUInt16BE(offset + 5) !== 512) return null;
      frame = true;
    }
    if (marker === 0xda) return frame && length >= 6 ? bytes : null;
    offset += length;
  }
  return null;
}

module.exports = { portraitSnapshotBytes };
