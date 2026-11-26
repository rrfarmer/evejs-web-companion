"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { buildNativePreferences } = require("../../scripts/build-native-preferences");
const execute = promisify(execFile);
const script = path.resolve(__dirname, "../../scripts/client-preferences-modules.py");
const bootstrapFile = path.resolve(__dirname, "../../scripts/native-prefs/bootstrap.py");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
let processRuntime = null;

/**
 * Actual installed Python values, not JSON copies or inferred numeric classes.
 * Scalars can be inspected; arbitrary heap values retain their real native
 * object, identity, truth, methods and item operations. No general JS container
 * projection is claimed. JS strings mean Unicode, Buffers byte str, Number
 * means float, BigInt means long. Source int literals use int() explicitly.
 */
function valueRuntime(binding) {
  const interned = new Map(), closed = new WeakSet();
  let ownsValue, nativeOf;
  const collected = new FinalizationRegistry(identity => { if (!interned.get(identity)?.deref()) interned.delete(identity); });
  function handle(value) {
    const native = nativeOf(value);
    if (!native || value.disposed) throw new TypeError("A live value from this installed Python runtime is required.");
    return native;
  }
  function wrap(native, releaseDuplicate = true) {
    const identity = binding.identity(native), old = interned.get(identity)?.deref();
    if (old && !old.disposed) { if (releaseDuplicate && nativeOf(old) !== native) binding.dispose(native); return old; }
    const value = new NativeValue(native, identity);
    interned.set(identity, new WeakRef(value));
    collected.register(value, identity);
    return value;
  }
  class NativeValue {
    // Give the handle the wrapper's lifetime without a table sized by peak traffic.
    #native;
    static {
      ownsValue = value => typeof value === "object" && value !== null && #native in value;
      nativeOf = value => ownsValue(value) ? value.#native : undefined;
    }
    constructor(native, identity) {
      this.#native = native;
      Object.defineProperty(this, "identity", { value: identity, enumerable: true });
      Object.freeze(this);
    }
    get disposed() { return closed.has(this); }
    get kind() { return binding.describe(handle(this)).kind; }
    get scalar() {
      const described = binding.describe(handle(this));
      if (described.kind === "opaque") throw new TypeError("A native heap object has no implicit JavaScript scalar projection.");
      return described.value;
    }
    truth() { return binding.truth(handle(this)); }
    getAttr(name) { return wrap(binding.getAttr(handle(this), name)); }
    setAttr(name, value) { binding.setAttr(handle(this), name, handle(convert(value))); return this; }
    getItem(key) { return wrap(binding.getItem(handle(this), handle(convert(key)))); }
    setItem(key, value) { binding.setItem(handle(this), handle(convert(key)), handle(convert(value))); return this; }
    call(...args) { return wrap(binding.call(handle(this), args.map(value => handle(convert(value))))); }
    dispose() {
      if (!this.disposed) { binding.dispose(this.#native); closed.add(this); if (interned.get(this.identity)?.deref() === this) interned.delete(this.identity); }
    }
  }
  function make(kind, value) { return wrap(binding.value(kind, value)); }
  function convert(value) {
    if (ownsValue(value)) { handle(value); return value; }
    if (value === null) return make("none", null);
    if (typeof value === "boolean") return make("bool", value);
    if (typeof value === "bigint") return make("long", value.toString());
    if (typeof value === "number") return make("float", value);
    if (typeof value === "string") return make("unicode", value);
    if (Buffer.isBuffer(value)) return make("bytes", value);
    throw new TypeError("Use an actual native Python value or an explicitly typed primitive.");
  }
  return Object.freeze({
    wrap, convert,
    int: value => make("int", value),
    long: value => {
      if (typeof value !== "bigint" && (typeof value !== "string" || !/^[+-]?\d+$/.test(value))) throw new TypeError("An exact BigInt or decimal string is required for a native long.");
      return make("long", String(value));
    },
    float: value => make("float", value),
    bytes: value => make("bytes", value),
    unicode: value => make("unicode", value),
    bool: value => make("bool", value),
    none: () => make("none", null),
    global: name => wrap(binding.getGlobal(name)),
    exception: error => Object.freeze({
      type: wrap(error.pythonType, false), value: wrap(error.pythonValue, false),
      traceback: wrap(error.pythonTraceback, false),
    }),
  });
}

/**
 * Each owner is a REAL original eveprefs.Handler(IniIniFile('prefs', root)).
 * Owners have independent INI snapshots backed by the explicitly selected
 * shared profile file, as separate retail clients do. This is the preference
 * owner, not full eveprefs.Init/boot/profile detection/SetClusterPrefs or Blue
 * startup. It never reads or changes the operator's retail settings profile.
 *
 * The process hosts one main-owner Python2 VM, shared stdlib, original cPickle
 * and real heap refs. It is not separate engines/subinterpreters/tasklets or a
 * promise of arbitrary application-module/extension imports. The importer
 * admits installed stdlib, the three real eveprefs modules and the original
 * caching package/lazy/memoize modules used by native static data.
 */
function createClientPreferencesProvider({ clientRoot, python = "python", settingsRoot, cacheRoot = path.resolve(__dirname, "../../data/native-preferences") }) {
  let pending = null;
  function ready() {
    if (pending) return pending;
    pending = (async () => {
      if (typeof clientRoot !== "string" || !path.isAbsolute(clientRoot)) throw new Error("An installed client root is required for native preferences.");
      if (typeof settingsRoot !== "string" || !path.isAbsolute(settingsRoot)) throw new Error("An explicit companion preference profile directory is required.");
      const dll = path.join(clientRoot, "tq", "bin64", "python27.dll"), archive = path.join(clientRoot, "tq", "code.ccp");
      const bootstrap = fs.readFileSync(bootstrapFile), bootstrapSHA256 = hash(bootstrap);
      const [built, extracted] = await Promise.all([
        buildNativePreferences({ cacheRoot: path.join(cacheRoot, "bindings") }),
        execute(python, [script, archive, dll, path.join(cacheRoot, "modules")], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 }),
      ]);
      const captured = JSON.parse(extracted.stdout);
      if (hash(fs.readFileSync(captured.filename)) !== captured.archiveSHA256 || hash(fs.readFileSync(dll)) !== captured.pythonSHA256) throw new Error("Installed preference input identity changed during preparation.");
      const signature = JSON.stringify([captured.archiveSHA256, captured.pythonSHA256, bootstrapSHA256, built.sources]);
      if (processRuntime && processRuntime.signature !== signature) throw new Error("A different installed preference runtime is already active; restart this BFF before changing it.");
      if (!processRuntime) {
        const binding = require(built.target);
        const initialized = binding.initialize(dll, Buffer.from(captured.filename.replaceAll("\\", "/"), "utf8"), bootstrap.toString("utf8"));
        if (initialized) binding.dispose(initialized);
        if (hash(fs.readFileSync(dll)) !== captured.pythonSHA256) throw new Error("Loaded Python runtime identity changed during preparation.");
        processRuntime = { signature, binding, values: valueRuntime(binding), identity: Object.freeze({ ...captured, bootstrapSHA256, native: built }) };
      }
      return processRuntime;
    })();
    return pending;
  }
  async function createOwner() {
    const runtime = await ready(), values = runtime.values;
    // Directory creation is this explicit profile policy. AtomicFileWrite itself
    // creates no directory and keeps the client's exact sharing/failure behavior.
    fs.mkdirSync(settingsRoot, { recursive: true });
    const handler = values.global("_create_preferences").call(settingsRoot);
    let disposed = false;
    const call = (name, args) => {
      if (disposed) throw new Error("Native preference owner is disposed.");
      return handler.getAttr(name).call(...args);
    };
    return Object.freeze({
      handler, identity: runtime.identity, settingsRoot,
      int: values.int, long: values.long, float: values.float,
      bytes: values.bytes, unicode: values.unicode, bool: values.bool, none: values.none,
      exception: values.exception,
      HasKey: key => call("HasKey", [key]).truth(),
      GetKeys: (...args) => call("GetKeys", args),
      GetValue: (...args) => call("GetValue", args),
      SetValue: (...args) => call("SetValue", args),
      SpoofKey: (...args) => call("SpoofKey", args),
      DeleteValue: (...args) => call("DeleteValue", args),
      dispose() { if (!disposed) { handler.dispose(); disposed = true; } },
    });
  }
  return Object.freeze({ ready, createOwner });
}

module.exports = { createClientPreferencesProvider };
