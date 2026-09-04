# syntax=docker/dockerfile:1
# SimpleOPDS web UI (React + Vite, served by nginx). Build context: ./web
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Same as the api image: keep the npm download cache out of the layer, so a
# package.json edit costs an unpack rather than a re-download.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
