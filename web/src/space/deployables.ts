// The space components the 3698585 client reads for deployables and other space objects, from deployableTypes.json
// (tools/client-extract/deployableTypes.py through gridcheck): which types deploy (and need a fleet to), and which carry
// the activate, scoop, cargoBay (its accessRange, allowFreeForAll) and fitting (its range) components.

export interface SpaceComponents {
  /** deploy: typeID -> requiresFleet. */
  readonly deploy: ReadonlyMap<number, boolean>;
  readonly activate: ReadonlySet<number>;
  readonly scoop: ReadonlySet<number>;
  /** cargoBay: typeID -> [accessRange m, allowFreeForAll]. */
  readonly cargoBay: ReadonlyMap<number, readonly [number, boolean]>;
  /** fitting: typeID -> range m. */
  readonly fitting: ReadonlyMap<number, number>;
}

const EMPTY: SpaceComponents = { deploy: new Map(), activate: new Set(), scoop: new Set(), cargoBay: new Map(), fitting: new Map() };
let loaded: SpaceComponents = EMPTY;
let loading: Promise<SpaceComponents> | null = null;

/** The components, read once. */
export function spaceComponents(): Promise<SpaceComponents> {
  loading ??= fetch("/client-assets/deployableTypes.json").then((r) => (r.ok ? r.json() : null)).then((j: {
    types?: [number, boolean][];
    components?: { activate?: number[]; scoop?: number[]; cargoBay?: Record<string, [number, boolean]>; fitting?: Record<string, number> };
  } | null) => {
    const c = j?.components ?? {};
    loaded = {
      deploy: new Map(j?.types ?? []),
      activate: new Set(c.activate ?? []),
      scoop: new Set(c.scoop ?? []),
      cargoBay: new Map(Object.entries(c.cargoBay ?? {}).map(([k, v]) => [Number(k), v] as const)),
      fitting: new Map(Object.entries(c.fitting ?? {}).map(([k, v]) => [Number(k), v] as const)),
    };
    return loaded;
  }).catch(() => { loading = null; return EMPTY; });
  return loading;
}

/** What has been read so far (empty until spaceComponents() settles), for code that cannot wait. */
export function spaceComponentsNow(): SpaceComponents {
  if (loaded === EMPTY) void spaceComponents();
  return loaded;
}

/** spacecomponents.IsActiveComponent: a type without the activate component is always active, else its slim item's. */
export function isActiveComponent(c: SpaceComponents, typeID: number | null, componentActive: boolean | null | undefined): boolean {
  return typeID === null || !c.activate.has(typeID) || componentActive === true;
}
