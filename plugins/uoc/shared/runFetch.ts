import type { ApiOptions } from "../../../web/src/plugin-api/index.ts";

type Send = (input: RequestInfo | URL, init?: RequestInit, priority?: ApiOptions["priority"]) => Promise<Response>;
type RoutedFetch = Send & {
  hostedRoute?: (url: string, init: RequestInit) => { send: Send } | undefined;
};

/** Keep Farmer's hosted route when adding a guard or timing around a run's fetch. */
export function wrapRunFetch(fetch: typeof globalThis.fetch, wrap: (send: Send) => Send): typeof globalThis.fetch {
  const upstream = fetch as RoutedFetch;
  const wrapped = wrap(upstream);
  const routeFor = upstream.hostedRoute;
  if (!routeFor) return wrapped;
  return Object.assign(wrapped, {
    hostedRoute(url: string, init: RequestInit) {
      const route = routeFor.call(upstream, url, init);
      // Farmer calls the route's sender directly once a hosted slot is available.
      return route && { ...route, send: wrap(route.send) };
    },
  });
}
