# SimpleOPDS API server (TypeScript). Build context: ./server
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

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
