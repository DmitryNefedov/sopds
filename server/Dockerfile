# syntax=docker/dockerfile:1
# SimpleOPDS API server (TypeScript). Build context: ./server
#
# Debian rather than Alpine: the runtime stage installs Calibre, which is
# packaged and tested far better against glibc than musl. Both stages share the
# base so it is pulled once. Nothing here is a native module — the compiled
# output copied between stages is plain JavaScript.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The npm download cache lives in a BuildKit cache mount, not in a layer. Any
# edit to package.json — adding a script, say — invalidates the layer above and
# re-runs the install, and the layer itself is a fat target for the builder's
# garbage collector. Either way the packages then come off local disk instead of
# the network: this stage pulls ~27 MB, 25 MB of which is the PGlite test
# database that only `npm test` ever loads.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
# `npm run build`, not `npx tsc`: npx falls back to *fetching* a package when the
# binary is not resolvable locally, and there is a package literally named `tsc`
# on the registry that is not the TypeScript compiler.
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app

# Calibre provides `ebook-convert`. The server prefers it over its built-in
# converters whenever it is on PATH (see src/convert/index.ts) and falls back to
# them silently if it is not — so this layer is the entire opt-in.
#
# It is also by far the largest thing in the image (~1 GB of Python and Qt), so
# it goes first: nothing below it can invalidate it. The .debs live in cache
# mounts rather than in the layer, which is what `docker-clean` would otherwise
# defeat by deleting them mid-build.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends calibre

# Fail the build here rather than let a broken Calibre look like a working one:
# at runtime a probe that throws is indistinguishable from "not installed", and
# the server would just quietly fall back to the built-in converters.
RUN ebook-convert --version

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefer-offline --no-audit --no-fund

# compiled JS + the runtime data files it reads (resolved via SERVER_ROOT)
COPY --from=build /app/dist ./dist
COPY schema.sql genres.json ./
COPY assets ./assets

# QT_QPA_PLATFORM: Calibre links Qt even for its command-line tools, and without
#   a display `ebook-convert` aborts on startup in a container.
# CALIBRE_CONFIG_DIRECTORY: Calibre writes a config tree on first run; point it
#   at the persistent volume so it survives container restarts.
ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0 \
    SOPDS_ROOT_LIB=/books \
    SOPDS_CONVERT_CACHE=/app/data/convert-cache \
    QT_QPA_PLATFORM=offscreen \
    CALIBRE_CONFIG_DIRECTORY=/app/data/calibre

EXPOSE 8000

CMD ["node", "dist/src/index.js"]
