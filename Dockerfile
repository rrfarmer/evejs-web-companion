# syntax=docker/dockerfile:1.7
#
# Running this POC in a container is OPTIONAL. `npm start` on the host stays a
# first-class, fully supported setup and needs none of this. See the
# "Docker (optional)" section of README.md for the four supported
# in/out-of-container combinations.

# --- Web app build -----------------------------------------------------------
# public/dist is deliberately excluded from the build context (.dockerignore),
# so the image builds the Vite bundle itself rather than shipping whatever
# happened to be on the host.
FROM node:24-bookworm-slim AS web-build

WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 is in `dependencies`, so a full `npm ci` may compile it from
# source when no prebuild matches this platform.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends g++ make python3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci

COPY tsconfig.json vite.config.ts ./
COPY web ./web
# The plugins this build carries (plugins/index.ts lists them); the web build
# compiles their windows and blocks in.
COPY plugins ./plugins
# The starter-bot seeds are BFF data, but only the browser's codec can prove
# they are valid documents — the server is plain JS and cannot run it. So the
# web-side test that decodes them lives here and needs the file, even though
# nothing in the bundle imports it. Copied alone rather than all of src/: the
# web build has no business seeing the rest of the server.
COPY src/starterBots.json ./src/starterBots.json
RUN npm run build:web


# --- Runtime dependencies ----------------------------------------------------
FROM node:24-bookworm-slim AS node-dependencies

RUN apt-get update \
 && apt-get install --yes --no-install-recommends g++ make python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# --- Runtime -----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
# The game port's transport reads the bridge contract as it loads, and the
# server loads the transport as it starts: without this the container stops
# at start-up with "Cannot find module" (test/dockerImage.test.js keeps watch).
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node scripts ./scripts
# The server bot host runs the BROWSER stack in this process: src/botHost.js
# imports web/src/app/flow.ts and friends at runtime, letting Node strip the
# types. Without the sources every bot start fails BOT_STACK_UNAVAILABLE, and
# only there -- the BFF still boots, so the gap is invisible until someone
# presses start. Source only, and the graph it pulls is relative-import-only,
# so this needs nothing from the pruned devDependencies.
COPY --chown=node:node web/src ./web/src
# The BFF runs each plugin's backend, and the bot host its blocks, from here.
COPY --chown=node:node plugins ./plugins
COPY --from=node-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=web-build --chown=node:node /app/public/dist ./public/dist

# web-users.json, session-secret.txt, the bot script store and the icon cache
# all live here. Without a volume every restart signs everyone out.
RUN mkdir -p /app/data && chown -R node:node /app/data

# HOST: 127.0.0.1 (the src/config.js default) would bind the loopback interface
# of the CONTAINER, making the published port unreachable. The container's
# network namespace is the isolation boundary here; compose still publishes to
# 127.0.0.1 on the host.
ENV NODE_ENV=production \
    EVEJS_WEB_POC_DATA_DIR=/app/data \
    PORT=26500 \
    HOST=0.0.0.0

VOLUME ["/app/data"]

EXPOSE 26500

USER node

# Liveness only: the built index.html is static, so this proves the BFF is
# serving HTTP without reporting "unhealthy" merely because EveJS is down.
# /api/health is the readiness answer, and it deliberately 500s in that case.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl --fail --silent --output /dev/null http://127.0.0.1:26500/ || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "src/server.js"]
