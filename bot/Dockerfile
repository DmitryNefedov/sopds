# syntax=docker/dockerfile:1
# SimpleOPDS Telegram bot (TypeScript). Build context: ./bot
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefer-offline --no-audit --no-fund
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production

# Long-polls the Telegram Bot API - no port to open, nothing to expose.
CMD ["node", "dist/src/index.js"]
