# syntax=docker/dockerfile:1
# SimpleOPDS API server (TypeScript). Build context: ./server
FROM node:22-alpine AS build
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

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefer-offline --no-audit --no-fund

# compiled JS + the runtime data files it reads (resolved via SERVER_ROOT)
COPY --from=build /app/dist ./dist
COPY schema.sql genres.json ./
COPY assets ./assets

ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0 \
    SOPDS_ROOT_LIB=/books \
    SOPDS_CONVERT_CACHE=/app/data/convert-cache

EXPOSE 8000

CMD ["node", "dist/src/index.js"]
