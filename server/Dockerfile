# syntax=docker/dockerfile:1
# SimpleOPDS API server (TypeScript). Build context: ./server
#
# Debian rather than Alpine because the runtime stage installs Calibre, which is
# packaged and tested far better against glibc. Nothing here is a native module.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The npm download cache lives in a BuildKit cache mount, not in a layer, so an
# edit to package.json re-runs the install off local disk instead of the network.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
# `npm run build`, not `npx tsc`: npx *fetches* a package when the binary is not
# resolvable locally, and the registry's `tsc` is not the TypeScript compiler.
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app

# Calibre provides `ebook-convert`, which the server prefers over its built-in
# converters whenever it is on PATH (src/services/convert/index.ts). At ~1 GB it
# is the largest thing in the image, so it goes first and nothing below can
# invalidate it; its .debs live in cache mounts that `docker-clean` would wipe.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update -qq \
    && apt-get install -y --no-install-recommends calibre

# Fail here rather than let a broken Calibre look like a missing one: at runtime
# a probe that throws is indistinguishable from "not installed".
RUN ebook-convert --version

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefer-offline --no-audit --no-fund

# compiled JS + the runtime data files it reads (resolved via SERVER_ROOT).
# db/changelog/ is the schema fallback for a plain Postgres; the compose image
# (Dockerfile.postgres) already has it baked in, so there initSchema is a no-op.
COPY --from=build /app/dist ./dist
COPY genres.json ./
COPY db ./db
COPY assets ./assets

# QT_QPA_PLATFORM: Calibre links Qt even for its command-line tools, and without
#   a display `ebook-convert` aborts on startup in a container.
# CALIBRE_CONFIG_DIRECTORY: point Calibre's first-run config tree at the
#   persistent volume so it survives container restarts.
ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0 \
    SOPDS_ROOT_LIB=/books \
    SOPDS_CONVERT_CACHE=/app/data/convert-cache \
    QT_QPA_PLATFORM=offscreen \
    CALIBRE_CONFIG_DIRECTORY=/app/data/calibre

EXPOSE 8000

CMD ["node", "dist/src/index.js"]
