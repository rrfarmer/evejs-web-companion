# EVE Combat Sim offline mirror

The public simulator runs locally with Node.js 18+ and a current Chromium browser.
The server has no package dependencies. The downloaded `site/` folder is required
and intentionally excluded from Git.

Double-click **StartOffline.bat**, or run:

```powershell
node serve.mjs
```

Open **http://localhost:8765/**. Keep the server running while using the site.
It binds to loopback by default. `--port 9000` selects another port.
All simulator assets are served from disk. Normal operation never contacts the
upstream site; the browser's content policy also blocks external resources.

Home, scenarios, Abyssal Deadspace, wormhole space, fitting, local settings and
mobile navigation use the downloaded data. EVE SSO, live character/account data
and the member-only scenario editor are unavailable offline. The original
member runtime and editor were not supplied in this guest mirror. Local account
responses remain guest responses.

The server adapts the captured guest bundle's production-host checks in memory,
selects guest startup on local hosts, removes remote preconnects, handles scenario
routes and directory discovery, and reuses local type artwork across icon sizes.
It preserves the downloaded bundle on disk and rejects an unrecognized origin
guard rather than applying a speculative patch after an upstream update.

## Prepare or update the download (internet required)

```powershell
node --max-old-space-size=8192 mirror.mjs
node complete.mjs
```

The original crawler collects pages, scripts, models, textures, data and CDN
dependencies. `complete.mjs` fills computed paths: model UVs, planet textures,
skyboxes, all 2,573 catalogued wormhole systems, scenario systems, Abyssal data,
props, map sprites, lens flares, sun textures and type images. Newly fetched JSON
is scanned for more dependencies. Run it again after exercising previously
unvisited controls to collect exact paths from `site/__missing.txt`.

`mirror.mjs --refresh` refreshes the upstream copy. Do not use refresh merely to
start the existing offline installation. `complete.mjs --check` lists outstanding
download candidates without using the network. Previously checked unavailable
resources are retained in `site/__unavailable-assets.json`; use
`--retry-unavailable` to retry them. Some are optional model sidecars or examples
mentioned in library source, rather than required runtime files.

`node serve.mjs --fill` explicitly enables online cache filling while browsing.
Stop it afterward and restart without `--fill` for offline use. The health
endpoint `/__offline/status` reports whether upstream fetching is enabled.

## Verify without internet

```powershell
node check.mjs
node --test serve.test.mjs
```

The audit checks the 79 scenario files, their system dependencies, all catalogued
wormhole systems, model references and data-referenced assets. It separately
reports optional UV sidecars absent from the original site. The server tests
disable upstream fetch and exercise routes, guest mode, missing data, icon reuse,
media seeking and the browser content policy.

For rendered checks, use an existing Playwright installation or install
`playwright-core` in a separate temporary directory, then supply its package path
and a Chromium executable:

```powershell
node verify-browser.mjs --playwright C:\path\to\playwright-core --browser C:\path\to\chrome.exe --all
```

The browser verifier starts its own server on a free port with upstream fetch
disabled, blocks and records external browser requests, checks desktop/mobile
pages, verifies each requested scenario's name, starts it and checks the running
simulation. It records failures and missing resources in
`site/__browser-report.json`. Default coverage is five representative scenarios;
`--all` covers all 79. Other options:

- `--scenarios ecm,sandbox` selects focused checks.
- `--full-graphics` checks the normal renderer instead of minimum graphics.
- `--screenshots C:\path\to\evidence` saves screenshots.
- `--report C:\path\to\report.json` chooses the report destination.
- `--query effect=pulsar` selects extra scenario options for a focused check.
- `--duration 5000` observes five seconds of running simulation per scenario.

For another computer, copy this tool folder **including `site/`**, install Node.js
and use the launcher. Neither npm installation nor internet access is required
to run the prepared mirror.
