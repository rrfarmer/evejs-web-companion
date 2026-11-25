/** Shared reference data used across the flight UI, independent of the pilot and system. */
const metadata = [
  "typeNames",
  "overviewPresets",
  "overviewStates",
  "overviewStateOrders",
  "overviewFilterGroups",
  "asteroidRules",
] as const;
type FlightMetadata = typeof metadata[number];
const reads = new Map<FlightMetadata, Promise<unknown>>();

export function readFlightMetadata<T>(name: FlightMetadata, signal?: AbortSignal): Promise<T | null> {
  const cached = reads.get(name);
  if (cached) return cached as Promise<T | null>;
  const read = fetch(`/client-assets/${name}.json`, { signal })
    .then(response => response.ok ? response.json() as Promise<T> : null)
    .catch(() => null)
    .then(value => {
      // An unavailable optional asset can be retried when its panel opens.
      if (value === null) reads.delete(name);
      return value;
    });
  reads.set(name, read);
  return read;
}

export const flightHudAsset = (name: string): string => `/client-res/ui/hud/${name.toLowerCase()}.png`;

const fonts = ["regular", "bold"];
const hud = [
  "medallion_plate", "capacitor_backing", "capacitor_00", "capacitor_01", "capacitor_02", "capacitor_03", "capacitor_04",
  "rack_gauge_bar", "overload_hex_outline", "overload_hex_fill", "overload_hex_fill_inset",
  "rack_glyph_high", "rack_glyph_mid", "rack_glyph_low",
];

function preload(href: string, as: "font" | "image", signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const link = document.createElement("link");
    link.rel = "preload";
    link.href = href;
    link.as = as;
    if (as === "font") link.crossOrigin = "anonymous";
    const done = (keep: boolean) => {
      signal.removeEventListener("abort", cancel);
      link.onload = link.onerror = null;
      if (!keep) link.remove();
      resolve();
    };
    const cancel = () => done(false);
    signal.addEventListener("abort", cancel, { once: true });
    link.onload = () => done(true);
    link.onerror = cancel;
    document.head.append(link);
  });
}

const PREPARATION_LIMIT_MS = 4000;

/** Use the browser's HTTP cache and retain parsed metadata for the live UI. Bound the time before sign-in. */
export async function prepareFlightAssets(update: (finished: number, total: number) => void): Promise<void> {
  const controller = new AbortController();
  const signal = controller.signal;
  const jobs = [
    ...metadata.map(name => () => readFlightMetadata(name, signal)),
    ...fonts.map(name => () => preload(`/client-res/ui/fonts/evesansneue-${name}.otf`, "font", signal)),
    ...hud.map(name => () => preload(flightHudAsset(name), "image", signal)),
  ];
  let next = 0;
  let finished = 0;
  update(finished, jobs.length);
  const worker = async () => {
    while (!signal.aborted && next < jobs.length) {
      try { await jobs[next++]!(); } catch { /* Optional asset. */ }
      if (!signal.aborted) update(++finished, jobs.length);
    }
  };
  const timer = setTimeout(() => controller.abort(), PREPARATION_LIMIT_MS);
  try {
    await Promise.all(Array.from({ length: 4 }, worker));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
