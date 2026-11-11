// A Granny file's animations as keys: each animation's name and duration, and per bone (its transform track) the
// position, orientation and scale/shear keys - time and value - decoded from Granny's curve formats. The formats' layouts
// follow Norbyte's LSLib (MIT; LSLib/Granny/Model/CurveData) as a reference; the code is ours.
//
// Every animated curve in the client's turrets is of degree 2 (a quadratic B-spline whose control points are stored
// one per knot). As LSLib does, each control point is taken as the key value at its knot (an approximation of the
// spline: the controls lie close to the curve). Constant curves give one key; DaIdentity none (the track keeps the
// component's identity: no move, no turn, unit scale).

/** 16 scale and offset entries the compressed quaternion formats index (D4nK16uC15u, D4nK8uC7u). */
const SCALE_TABLE = [1.4142135, 0.70710677, 0.35355338, 0.35355338, 0.35355338, 0.17677669, 0.17677669, 0.17677669,
  -1.4142135, -0.70710677, -0.35355338, -0.35355338, -0.35355338, -0.17677669, -0.17677669, -0.17677669];
const OFFSET_TABLE = [-0.70710677, -0.35355338, -0.53033006, -0.17677669, 0.17677669, -0.17677669, -0.088388346, 0,
  0.70710677, 0.35355338, 0.53033006, 0.17677669, -0.17677669, 0.17677669, 0.088388346, -0];

/** A float stored as its top 16 bits (OneOverKnotScaleTrunc). */
function truncFloat(u) {
  const v = new DataView(new ArrayBuffer(4));
  v.setUint32(0, ((u >>> 0) & 0xffff) << 16);
  return v.getFloat32(0);
}
/** A granny.mjs array field (a table of one column, or a plain array) as numbers. */
function nums(field) {
  if (!field) return [];
  if (Array.isArray(field)) return field.map(Number);
  const col = field.columns ? Object.values(field.columns)[0] : null;
  return col ? Array.from(col.data, Number) : [];
}

/** D4nK16uC15u / D4nK8uC7u: a unit quaternion from three packed components (its fourth rebuilt). */
function quatFromControl(a, b, c, bits, scales, offsets) {
  const hi = 1 << (bits - 1), mask = hi - 1;
  const s1 = (((b & hi) ? 1 : 0) << 1) | ((c & hi) ? 1 : 0);
  const s2 = (s1 + 1) & 3, s3 = (s2 + 1) & 3, s4 = (s3 + 1) & 3;
  const da = (a & mask) * scales[s2] + offsets[s2];
  const db = (b & mask) * scales[s3] + offsets[s3];
  const dc = (c & mask) * scales[s4] + offsets[s4];
  let dd = Math.sqrt(Math.max(0, 1 - (da * da + db * db + dc * dc)));
  if (a & hi) dd = -dd;
  const q = [0, 0, 0, 0];
  q[s2] = da; q[s3] = db; q[s4] = dc; q[s1] = dd;
  return q;
}

/**
 * One curve as keys: { times, values (flat, `width` per key), width } or null for an identity curve. `width` is the
 * curve's dimension (3 position, 4 orientation, 9 scale/shear).
 */
export function decodeCurve(curve, width) {
  const d = curve?.CurveData;
  if (!d) return null;
  const key = Object.keys(d).find((k) => k.startsWith("CurveDataHeader_")) ?? "";
  const format = key.slice("CurveDataHeader_".length);
  switch (format) {
    case "DaIdentity": return null;
    case "D3Constant32f": case "D4Constant32f": case "DaConstant32f": {
      const v = nums(d.Controls);
      return { times: [0], values: v.slice(0, width), width };
    }
    case "DaK32fC32f": {
      const times = nums(d.Knots), c = nums(d.Controls);
      const w = times.length ? Math.round(c.length / times.length) : width;
      return { times, values: c, width: w };
    }
    case "D4nK16uC15u": case "D4nK8uC7u": {
      const bits = format === "D4nK16uC15u" ? 16 : 8;
      const unit = bits === 16 ? 0.000030518509 : 0.0078740157;
      const sel = Number(d.ScaleOffsetTableEntries) & 0xffff;
      const scales = [0, 4, 8, 12].map((s) => SCALE_TABLE[(sel >> s) & 15] * unit);
      const offsets = [0, 4, 8, 12].map((s) => OFFSET_TABLE[(sel >> s) & 15]);
      // the knot scale is a whole float here (not truncated: 65535 / 4.25 s is 15420)
      const scale = Number(d.OneOverKnotScale) || 1;
      const kc = nums(d.KnotsControls);
      const n = Math.floor(kc.length / 4);
      const times = [], values = [];
      for (let i = 0; i < n; i++) {
        times.push(kc[i] / scale);
        values.push(...quatFromControl(kc[n + i * 3], kc[n + i * 3 + 1], kc[n + i * 3 + 2], bits, scales, offsets));
      }
      return { times, values, width: 4 };
    }
    case "D3I1K16uC16u": case "D3I1K8uC8u": case "D3K16uC16u": case "D3K8uC8u": case "D3I1K32fC32f": {
      const kc = nums(d.KnotsControls);
      const one = format.startsWith("D3I1");
      const n = Math.floor(kc.length / (one ? 2 : 4));
      const scale = format === "D3I1K32fC32f" ? 1 : truncFloat(Number(d.OneOverKnotScaleTrunc));
      const cs = nums(d.ControlScales), co = nums(d.ControlOffsets);
      const times = [], values = [];
      for (let i = 0; i < n; i++) {
        times.push(format === "D3I1K32fC32f" ? kc[i] : kc[i] / scale);
        for (let j = 0; j < 3; j++) values.push(kc[n + (one ? i : i * 3 + j)] * (cs[j] ?? 0) + (co[j] ?? 0));
      }
      return { times, values, width: 3 };
    }
    default:
      return { unsupported: format };
  }
}

/**
 * The file's animations: [{ name, duration, tracks: { boneName: { position, orientation, scaleShear } } }] (each a
 * decodeCurve result or null), and the formats met that are not decoded (by name: count).
 */
export function readAnimations(root) {
  const unsupported = {};
  const anims = (root.Animations ?? []).map((a) => {
    const tracks = {};
    for (const tg of a.TrackGroups ?? []) {
      for (const t of tg.TransformTracks ?? []) {
        const one = (c, w) => {
          const r = decodeCurve(c, w);
          if (r?.unsupported) { unsupported[r.unsupported] = (unsupported[r.unsupported] ?? 0) + 1; return null; }
          return r;
        };
        tracks[t.Name] = { position: one(t.PositionCurve, 3), orientation: one(t.OrientationCurve, 4), scaleShear: one(t.ScaleShearCurve, 9) };
      }
    }
    return { name: a.Name, duration: Number(a.Duration ?? 0), tracks };
  });
  return { animations: anims, unsupported };
}
