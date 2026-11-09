// FSD `.static` files: a u32 schema length, a protocol-0 pickle of the schema, then the data
// the schema describes. Ported from the client's pure-Python loader, fsd/schemas/binaryLoader.py
// and fsd/schemas/loaders/*.py (build 3396210). Values come out whole as plain JS values.
//
// Six .static files carry no schema; the client passes their sibling res:/staticdata/<name>.schema
// (YAML) instead, so readFsdStatic takes it as options.schema. Some .static files are SQLite
// databases, not FSD; staticFileKind() tells them apart.

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

/** Python-typed keys of a parsed dict whose keys are not all strings: string key -> typed key. */
export const TYPED_KEYS = Symbol("fsdTypedKeys");

export class FsdError extends Error {
  constructor(detail, file = "<buffer>") {
    super(detail);
    this.name = "FsdError";
    this.detail = detail;
    this.file = file;
    this.path = [];
  }
  finish(file) {
    this.file = file;
    this.message = `${file}${this.path.join("")}: ${this.detail}`;
    return this;
  }
}

// FsdDataPathObject: the client names a failing node by its path, e.g. [2380].name.
function atPath(err, seg) {
  if (!(err instanceof FsdError)) {
    const e = new FsdError(err && err.message ? err.message : String(err));
    e.cause = err;
    err = e;
  }
  err.path.unshift(seg);
  return err;
}

// Python's str(key), as the dump keys its JSON.
function pyKey(k) {
  if (typeof k === "string") return k;
  if (typeof k === "boolean") return k ? "True" : "False";
  if (k === null) return "None";
  if (Array.isArray(k)) return k.map(pyKey).join(",");
  return String(k);
}

function setKey(obj, key, value) {
  const s = typeof key === "string" ? key : pyKey(key);
  if (typeof key !== "string") {
    if (!obj[TYPED_KEYS]) Object.defineProperty(obj, TYPED_KEYS, { value: new Map(), enumerable: false });
    obj[TYPED_KEYS].set(s, key);
  }
  if (s === "__proto__") Object.defineProperty(obj, s, { value, enumerable: true, writable: true, configurable: true });
  else obj[s] = value;
}

function typedEntries(obj) {
  const typed = obj[TYPED_KEYS];
  return Object.keys(obj).map((k) => [typed && typed.has(k) ? typed.get(k) : k, obj[k]]);
}

// Python str bytes, decoded as the dump does (UTF-8); bytes that are not UTF-8 stay as latin1.
function bytesToText(u8) {
  try { return utf8Strict.decode(u8); } catch { return latin1.decode(u8); }
}

// ---------------------------------------------------------------------------------------------
// Minimal pickle protocol 0 reader (cPickle.loads in GetEmbeddedSchemaAndSizeFromFile).
// Covers the opcodes the schemas use: ( d l t a s p g I S N c R .

export function readPickle0(u8, name = "<pickle>") {
  const stack = [];
  const marks = [];
  const memo = new Map();
  const ORDERED_DICT = { global: "collections.OrderedDict" };
  let pos = 0;
  const fail = (msg) => { throw new FsdError(`pickle: ${msg} at byte ${pos}`, name).finish(name); };
  const line = () => {
    const end = u8.indexOf(0x0a, pos);
    if (end < 0) fail("unterminated line");
    const s = latin1.decode(u8.subarray(pos, end));
    pos = end + 1;
    return s;
  };
  const top = () => stack[stack.length - 1];
  const fromMark = () => {
    if (!marks.length) fail("no mark");
    return stack.splice(marks.pop());
  };
  const dictFrom = (pairs) => {
    const o = {};
    for (const [k, v] of pairs) setKey(o, k, v);
    return o;
  };
  while (pos < u8.length) {
    const op = String.fromCharCode(u8[pos++]);
    switch (op) {
      case "(": marks.push(stack.length); break;
      case "d": {
        const items = fromMark();
        const pairs = [];
        for (let i = 0; i < items.length; i += 2) pairs.push([items[i], items[i + 1]]);
        stack.push(dictFrom(pairs));
        break;
      }
      case "l": case "t": stack.push(fromMark()); break;
      case "a": { const v = stack.pop(); top().push(v); break; }
      case "s": { const v = stack.pop(); const k = stack.pop(); setKey(top(), k, v); break; }
      case "p": memo.set(line(), top()); break;
      case "g": {
        const id = line();
        if (!memo.has(id)) fail(`memo ${id} missing`);
        stack.push(memo.get(id));
        break;
      }
      case "I": {
        const s = line();
        if (s === "01") stack.push(true);
        else if (s === "00") stack.push(false);
        else {
          if (!/^[-+]?\d+$/.test(s)) fail(`bad INT ${s}`);
          const n = Number(s);
          stack.push(Number.isSafeInteger(n) ? n : BigInt(s));
        }
        break;
      }
      case "S": stack.push(bytesToText(pyStringLiteral(line(), fail))); break;
      case "N": stack.push(null); break;
      case "c": {
        const g = `${line()}.${line()}`;
        if (g !== ORDERED_DICT.global) fail(`global ${g} not supported`);
        stack.push(ORDERED_DICT);
        break;
      }
      case "R": {
        const args = stack.pop();
        const fn = stack.pop();
        if (fn !== ORDERED_DICT) fail("REDUCE of something other than OrderedDict");
        stack.push(dictFrom(args.length ? args[0] : []));
        break;
      }
      case ".": return stack.pop();
      default: fail(`opcode ${JSON.stringify(op)} not supported`);
    }
  }
  return fail("no STOP");
}

// The repr() of a Python 2 str, as protocol 0 STRING writes it.
function pyStringLiteral(s, fail) {
  const q = s[0];
  if ((q !== "'" && q !== '"') || s[s.length - 1] !== q || s.length < 2) fail(`bad STRING ${s}`);
  const out = [];
  for (let i = 1; i < s.length - 1; i++) {
    let c = s.charCodeAt(i);
    if (c !== 0x5c) { out.push(c & 0xff); continue; }
    const e = s[++i];
    if (e === "x") { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else if (e === "n") out.push(10);
    else if (e === "r") out.push(13);
    else if (e === "t") out.push(9);
    else if (e === "\\" || e === "'" || e === '"') out.push(e.charCodeAt(0));
    else fail(`escape \\${e} not supported`);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------------------------
// Minimal YAML reader for the sibling .schema files (persistence.LoadSchema, PyYAML safe_load
// with OrderedDict maps). Covers block maps, flow maps and lists, anchors, aliases, plain and
// quoted scalars, and plain scalars wrapped onto continuation lines.

export function parseSchemaYaml(text, name = "<schema>") {
  const fail = (msg) => { throw new FsdError(`schema YAML: ${msg}`, name).finish(name); };
  if (typeof text !== "string") text = new TextDecoder("utf-8").decode(text);
  const raw = [];
  for (const l of text.split(/\r?\n/)) {
    const t = l.trim();
    if (!t || t.startsWith("#") || t === "---" || t === "...") continue;
    raw.push({ indent: l.length - l.trimStart().length, text: t });
  }
  // Logical lines: join wrapped flow collections and wrapped plain scalars.
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    const cur = { ...raw[i] };
    for (;;) {
      const next = raw[i + 1];
      if (!next) break;
      const open = flowDepth(cur.text) > 0;
      const opensBlock = /:$/.test(cur.text) || /:\s+&\S+$/.test(cur.text) || /^-$/.test(cur.text);
      if (open || (next.indent > cur.indent && !opensBlock)) { cur.text += " " + next.text; i++; }
      else break;
    }
    lines.push(cur);
  }
  const anchors = new Map();
  let li = 0;

  function parseBlock(indent) {
    if (lines[li].text.startsWith("- ") || lines[li].text === "-") return parseSeq(indent);
    const obj = {};
    while (li < lines.length && lines[li].indent === indent && !lines[li].text.startsWith("- ")) {
      const t = lines[li].text;
      const { key, rest } = splitKey(t);
      li++;
      let value;
      let r = rest.trim();
      let anchor = null;
      const am = /^&(\S+)\s*(.*)$/.exec(r);
      if (am) { anchor = am[1]; r = am[2]; }
      if (r === "") {
        const n = lines[li];
        if (n && n.indent > indent) value = parseBlock(n.indent);
        else if (n && n.indent === indent && n.text.startsWith("- ")) value = parseSeq(indent);
        else value = null;
      } else value = parseInline(r);
      if (anchor) anchors.set(anchor, value);
      setKey(obj, key, value);
    }
    if (li < lines.length && lines[li].indent > indent) fail(`unexpected indent at "${lines[li].text}"`);
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    while (li < lines.length && lines[li].indent === indent && (lines[li].text.startsWith("- ") || lines[li].text === "-")) {
      const r = lines[li].text.slice(1).trim();
      li++;
      if (r === "" || /^[^'"{[]*:(\s|$)/.test(r)) fail("block sequence of maps not supported");
      arr.push(parseInline(r));
    }
    return arr;
  }

  function splitKey(t) {
    if (t[0] === "'" || t[0] === '"') {
      const { value, end } = readQuoted(t, 0);
      const m = /^\s*:(\s|$)/.exec(t.slice(end));
      if (!m) fail(`no ':' after key in "${t}"`);
      return { key: value, rest: t.slice(end + m[0].length) };
    }
    const m = /:(\s|$)/.exec(t);
    if (!m) fail(`no key in "${t}"`);
    return { key: resolvePlain(t.slice(0, m.index).trim()), rest: t.slice(m.index + m[0].length) };
  }

  function parseInline(s) {
    const st = { s, i: 0 };
    const v = flowValue(st, false);
    skipWs(st);
    if (st.i !== s.length) fail(`trailing text in "${s}"`);
    return v;
  }

  function skipWs(st) { while (st.i < st.s.length && st.s[st.i] === " ") st.i++; }

  function flowValue(st, inFlow) {
    skipWs(st);
    const c = st.s[st.i];
    if (c === "&") {
      const m = /^&(\S+)\s*/.exec(st.s.slice(st.i));
      st.i += m[0].length;
      const v = flowValue(st, inFlow);
      anchors.set(m[1], v);
      return v;
    }
    if (c === "*") {
      const m = /^\*([^\s,\]}]+)/.exec(st.s.slice(st.i));
      st.i += m[0].length;
      if (!anchors.has(m[1])) fail(`unknown alias *${m[1]}`);
      return anchors.get(m[1]);
    }
    if (c === "{") {
      st.i++;
      const obj = {};
      for (;;) {
        skipWs(st);
        if (st.s[st.i] === "}") { st.i++; return obj; }
        const key = flowScalar(st, true);
        skipWs(st);
        if (st.s[st.i] !== ":") fail(`expected ':' in "${st.s}"`);
        st.i++;
        skipWs(st);
        const value = st.s[st.i] === "," || st.s[st.i] === "}" ? null : flowValue(st, true);
        setKey(obj, key, value);
        skipWs(st);
        if (st.s[st.i] === ",") st.i++;
        else if (st.s[st.i] !== "}") fail(`expected ',' or '}' in "${st.s}"`);
      }
    }
    if (c === "[") {
      st.i++;
      const arr = [];
      for (;;) {
        skipWs(st);
        if (st.s[st.i] === "]") { st.i++; return arr; }
        arr.push(flowValue(st, true));
        skipWs(st);
        if (st.s[st.i] === ",") st.i++;
        else if (st.s[st.i] !== "]") fail(`expected ',' or ']' in "${st.s}"`);
      }
    }
    return flowScalar(st, inFlow);
  }

  function flowScalar(st, inFlow) {
    const c = st.s[st.i];
    if (c === "'" || c === '"') {
      const { value, end } = readQuoted(st.s, st.i);
      st.i = end;
      return value;
    }
    const start = st.i;
    while (st.i < st.s.length) {
      const ch = st.s[st.i];
      if (inFlow && (ch === "," || ch === "]" || ch === "}" || ch === "[" || ch === "{")) break;
      if (ch === ":" && (st.i + 1 === st.s.length || /[\s,\]}]/.test(st.s[st.i + 1]))) break;
      if (ch === "#" && st.s[st.i - 1] === " ") break;
      st.i++;
    }
    return resolvePlain(st.s.slice(start, st.i).trim());
  }

  function readQuoted(s, i) {
    const q = s[i];
    let out = "";
    let j = i + 1;
    for (;;) {
      if (j >= s.length) fail(`unterminated string in "${s}"`);
      const ch = s[j];
      if (q === "'" && ch === "'") {
        if (s[j + 1] === "'") { out += "'"; j += 2; continue; }
        return { value: out, end: j + 1 };
      }
      if (q === '"' && ch === '"') return { value: out, end: j + 1 };
      if (q === '"' && ch === "\\") {
        const e = s[j + 1];
        const simple = { n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", '"': '"', "/": "/", " ": " " };
        if (e in simple) { out += simple[e]; j += 2; continue; }
        const len = { x: 2, u: 4, U: 8 }[e];
        if (!len) fail(`escape \\${e} not supported`);
        out += String.fromCodePoint(parseInt(s.substr(j + 2, len), 16));
        j += 2 + len;
        continue;
      }
      out += ch;
      j++;
    }
  }

  const v = lines.length ? parseBlock(lines[0].indent) : null;
  if (li !== lines.length) fail(`could not read "${lines[li].text}"`);
  return v;
}

// Bracket depth of a line's flow collections, outside quotes.
function flowDepth(t) {
  let d = 0;
  let q = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === q) q = null; continue; }
    if ((c === "'" || c === '"') && (i === 0 || /[\s,[{:]/.test(t[i - 1]))) q = c;
    else if (c === "{" || c === "[") d++;
    else if (c === "}" || c === "]") d--;
  }
  return d;
}

// PyYAML's YAML 1.1 implicit resolvers for plain scalars.
function resolvePlain(s) {
  if (s === "" || s === "~" || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(yes|Yes|YES|true|True|TRUE|on|On|ON)$/.test(s)) return true;
  if (/^(no|No|NO|false|False|FALSE|off|Off|OFF)$/.test(s)) return false;
  if (/^[-+]?(0|[1-9][0-9_]*)$/.test(s)) return Number(s.replace(/_/g, ""));
  if (/^[-+]?0x[0-9a-fA-F_]+$/.test(s)) return (s[0] === "-" ? -1 : 1) * parseInt(s.replace(/[-+_]/g, ""), 16);
  if (/^[-+]?0[0-7_]+$/.test(s)) return (s[0] === "-" ? -1 : 1) * parseInt(s.replace(/[-+_]/g, ""), 8);
  if (/^[-+]?([0-9][0-9_]*)?\.[0-9_]*([eE][-+][0-9]+)?$/.test(s) && /[0-9]/.test(s)) return Number(s.replace(/_/g, ""));
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s[0] === "-" ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Binary data. Each Data wraps one buffer, as the client's ctypes string buffer.

class Data {
  constructor(u8, opts) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.opts = opts;
  }
  sub(off, size) { return new Data(this.u8.subarray(off, off + size), this.opts); }
  u8at(off) { if (off >= this.u8.length) throw new RangeError("Offset is outside the bounds of the DataView"); return this.u8[off]; }
  u16(off) { return this.dv.getUint16(off, true); }
  u32(off) { return this.dv.getUint32(off, true); }
  i32(off) { return this.dv.getInt32(off, true); }
  f32(off) { return this.dv.getFloat32(off, true); }
  f64(off) { return this.dv.getFloat64(off, true); }
  bytes(off, n) {
    if (off + n > this.u8.length) throw new RangeError(`string of ${n} bytes at ${off} runs past the data`);
    return this.u8.subarray(off, off + n);
  }
}

// LoaderState.RepresentSchemaNode
function represent(d, off, schema) {
  const f = FACTORIES[schema.type];
  if (!f) throw new FsdError(`Unknown type not supported in binary loader '${pyKey(schema.type ?? null)}'`);
  return f(d, off, schema);
}

// loaders/__init__.py: Vector{4,3,2}FromBinaryString. A tuple; aliased vectors (VectorLoader)
// come out as the same tuple, as the dump writes them.
function vector(n) {
  return (d, off, schema) => {
    const dbl = (schema.precision ?? "single") === "double";
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = dbl ? d.f64(off + 8 * i) : d.f32(off + 4 * i);
    return out;
  };
}

// StringFromBinaryString: u32 count, then the bytes.
function string(d, off) {
  return bytesToText(d.bytes(off + 4, d.u32(off)));
}

// UnicodeStringFromBinaryString: the same bytes, decoded strictly.
function unicode(d, off) {
  return utf8Strict.decode(d.bytes(off + 4, d.u32(off)));
}

// EnumFromBinaryString; the width is schemaOptimizer.GetLargeEnoughUnsignedTypeForMaxValue.
function enumValue(d, off, schema) {
  const max = schema.maxEnumValue;
  const v = max <= 255 ? d.u8at(off) : max <= 65536 ? d.u16(off) : d.u32(off);
  if (schema.readEnumValue) return v;
  for (const [k, val] of typedEntries(schema.values)) if (val === v) return k;
  return null;
}

// BoolFromBinaryString
function bool(d, off) { return d.u8at(off) === 255; }

// IntFromBinaryString
function int(d, off, schema) {
  if (("min" in schema && schema.min >= 0) || ("exclusiveMin" in schema && schema.exclusiveMin >= -1)) return d.u32(off);
  return d.i32(off);
}

// FloatFromBinaryString
function float(d, off, schema) {
  return (schema.precision ?? "single") === "double" ? d.f64(off) : d.f32(off);
}

// UnionFromBinaryString: u32 option index, then that option's value.
function union(d, off, schema) {
  const option = schema.optionTypes[d.u32(off)];
  if (!option) throw new FsdError(`union option ${d.u32(off)} not in the schema`);
  return represent(d, off + 4, option);
}

// listLoader.ListFromBinaryString. Fixed-size items sit back to back; variable-size items are
// found through a u32 offset table, relative to the list's start.
function list(d, off, schema, knownLength = undefined) {
  const length = schema.length ?? knownLength;
  const item = schema.itemTypes;
  const counted = length === undefined;
  const count = counted ? d.u32(off) : length;
  const start = off + (counted ? 4 : 0);
  const out = new Array(count);
  const fixed = "fixedItemSize" in schema;
  const size = fixed ? item.size : 0;
  for (let i = 0; i < count; i++) {
    try {
      out[i] = fixed ? represent(d, start + size * i, item) : represent(d, off + d.u32(start + 4 * i), item);
    } catch (e) { throw atPath(e, `[${i}]`); }
  }
  return out;
}

// objectLoader.ObjectLoader, read out whole: the attributes __getBinaryObjectAttributes__ lists
// (all but absent optional ones without a default), each as __getitem__ returns it.
const objectPlans = new WeakMap();
function objectPlan(schema) {
  let p = objectPlans.get(schema);
  if (p) return p;
  const lookups = schema.optionalValueLookups ?? {};
  const masks = new Map();
  for (const [k, m] of Object.entries(lookups)) {
    const b = BigInt(m);
    masks.set(k, [Number(b & 0xffffffffn) | 0, Number((b >> 32n) & 0xffffffffn) | 0]);
  }
  p = {
    fixed: "size" in schema,
    hasOptional: masks.size > 0,
    masks,
    variable: schema.attributesWithVariableOffsets ?? [],
    constant: schema.constantAttributeOffsets ?? {},
    attributes: Object.entries(schema.attributes),
  };
  objectPlans.set(schema, p);
  return p;
}

function object(d, off, schema) {
  const p = objectPlan(schema);
  let table = null;
  let base = 0;
  if (!p.fixed) {
    let present = p.variable;
    if (p.hasOptional) {
      const at = off + schema.endOfFixedSizeData;
      const lo = d.u32(at) | 0;
      const hi = d.u32(at + 4) | 0;
      present = present.filter((k) => {
        const m = p.masks.get(k);
        return !m || (lo & m[0]) !== 0 || (hi & m[1]) !== 0;
      });
    }
    const arrayStart = off + (schema.endOfFixedSizeData ?? 0) + 8;
    base = arrayStart + 4 * present.length;
    table = new Map();
    for (let i = 0; i < present.length; i++) table.set(present[i], d.u32(arrayStart + 4 * i));
  }
  const out = {};
  for (const [key, attr] of p.attributes) {
    let value;
    try {
      if (key in p.constant) value = represent(d, off + p.constant[key], attr);
      else if (table && table.has(key)) value = represent(d, base + table.get(key), attr);
      else if ("default" in attr) value = attr.default;
      else if ("isOptional" in attr) continue;
      else throw new FsdError(`Attribute '${key}' is not present on this instance.`);
    } catch (e) { throw atPath(e, `.${key}`); }
    setKey(out, key, value);
  }
  return out;
}

// dictLoader.CreatePythonDictOffset: the sorted key footer, as [key, offset, size] entries.
// Int keys use StandardFSDOptimizedDictFooter (u32 count, then i32 key, i32 offset[, i32 size]);
// any other key type reads keyFooter as a list (StandardFSDDictFooter).
function dictFooter(d, schema) {
  const out = [];
  if (schema.keyTypes.type === "int") {
    const withSize = "size" in schema.keyFooter.itemTypes.attributes;
    const step = withSize ? 12 : 8;
    const n = d.u32(0);
    for (let i = 0; i < n; i++) {
      const at = 4 + i * step;
      out.push([d.i32(at), d.i32(at + 4), withSize ? d.i32(at + 8) : 0]);
    }
  } else {
    for (const item of list(d, 0, schema.keyFooter)) out.push([item.key, item.offset, item.size ?? 0]);
  }
  return out;
}

function newDict(opts) { return opts.maps ? new Map() : {}; }
function dictSet(dict, key, value) {
  if (dict instanceof Map) dict.set(key, value);
  else setKey(dict, pyKey(key), value);
}

// dictLoader.DictLoader: u32 data size, values, then the footer, whose u32 size ends the data.
function dict(d, off, schema) {
  const sizeOfData = d.u32(off);
  const sizeOfFooter = d.u32(off + 4 + sizeOfData - 4);
  const footerStart = off + sizeOfData - sizeOfFooter;
  const footer = dictFooter(d.sub(footerStart, sizeOfFooter), schema);
  const out = newDict(d.opts);
  for (const [key, offset] of footer) {
    let v;
    try { v = represent(d, off + 4 + offset, schema.valueTypes); } catch (e) { throw atPath(e, `[${pyKey(key)}]`); }
    dictSet(out, key, v);
  }
  return out;
}

// dictLoader.IndexLoader, read out whole (iteritems). Each value is read from its own slice of
// the file; a value that is itself a buildIndex dict is another IndexLoader over its slice.
// MultiIndexLoader iterates the same way; its named sub-indexes are not read.
function indexDict(d, schema, offsetToData, offsetToFooter = 0) {
  const fileObjectSize = d.u32(offsetToData);
  const sizeAt = offsetToFooter !== 0 ? offsetToFooter - 4 : offsetToData + fileObjectSize;
  const footerSize = d.u32(sizeAt);
  const footer = dictFooter(d.sub(sizeAt - footerSize, footerSize), schema);
  const valueSchema = schema.valueTypes;
  const out = newDict(d.opts);
  for (const [key, offset, size] of footer) {
    const at = 4 + offsetToData + offset;
    let v;
    try {
      v = valueSchema.buildIndex ? indexDict(d, valueSchema, at, at + size) : represent(d.sub(at, size), 0, valueSchema);
    } catch (e) { throw atPath(e, `[${pyKey(key)}]`); }
    dictSet(out, key, v);
  }
  return out;
}

// binaryLoader.defaultLoaderFactories
const FACTORIES = {
  float, vector4: vector(4), color: vector(4), vector3: vector(3), vector2: vector(2),
  string, resPath: string, enum: enumValue, bool, int, typeID: int, localizationID: int,
  union, list: (d, off, schema) => list(d, off, schema), object, dict, unicode,
  npcTag: int, deploymentType: int, npcEnemyFleetTypeID: int, groupBehaviorTreeID: int,
  npcCorporationID: int, spawnTableID: int, npcFleetCounterTableID: int, dungeonID: int,
  typeListID: int, npcFleetTypeID: int, metaGroupID: int, fsdReference: int, raceID: int,
  marketGroupID: int, ShipGroupID: int, certificateTemplateID: int, factionID: int,
};

// ---------------------------------------------------------------------------------------------

/** "sqlite" (a SQLite cache, not FSD), "embedded" (schema pickled in the file) or "bare" (needs its .schema). */
export function staticFileKind(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (latin1.decode(u8.subarray(0, 16)) === "SQLite format 3\0") return "sqlite";
  if (u8.length >= 5) {
    const n = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0, true);
    if (n + 4 <= u8.length && u8[4] === 0x28 /* ( */ && u8[3 + n] === 0x2e /* . */) return "embedded";
  }
  return "bare";
}

/** The schema embedded in a .static file (GetEmbeddedSchemaAndSizeFromFile). */
export function readFsdSchema(buffer, name = "<buffer>") {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const n = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0, true);
  return { schema: readPickle0(u8.subarray(4, 4 + n), name), size: n };
}

/**
 * Reads a whole FSD .static file, as binaryLoader.LoadFSDDataInPython does.
 * options.schema: the sibling .schema file (YAML text or bytes) or a parsed schema; required for
 *   files without an embedded schema.
 * options.maps: dicts as Maps with their typed keys, instead of objects keyed by str(key).
 */
export function readFsdStatic(buffer, name = "<buffer>", options = {}) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const opts = { maps: !!options.maps };
  try {
    let schema = options.schema ?? null;
    let offsetToData = 0;
    if (schema === null) {
      const kind = staticFileKind(u8);
      if (kind === "sqlite") throw new FsdError("a SQLite database, not an FSD binary file");
      if (kind !== "embedded") throw new FsdError("no embedded schema; pass its .schema file as options.schema");
      const r = readFsdSchema(u8, name);
      schema = r.schema;
      offsetToData = r.size + 4;
    } else if (typeof schema === "string" || schema instanceof Uint8Array) {
      schema = parseSchemaYaml(schema, name);
    }
    const d = new Data(u8, opts);
    if (schema.type === "dict" && schema.buildIndex) return indexDict(d, schema, offsetToData);
    return represent(d, offsetToData, schema);
  } catch (e) {
    if (e instanceof FsdError) throw e.finish(name);
    throw atPath(e, "").finish(name);
  }
}
