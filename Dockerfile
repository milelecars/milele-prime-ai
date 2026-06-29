# syntax=docker/dockerfile:1
# Plain multi-stage build — no `node_modules/.cache` mount, so `npm ci` can wipe
# node_modules during install without colliding with a mounted cache volume
# (the Nixpacks default cache mount on /app/node_modules/.cache caused EBUSY).

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# prebuild clears ./dist (not node_modules/.cache); build is `tsc`.
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
