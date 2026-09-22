# Example Dockerfile for a tzin app (multi-stage, documentation-first).
#
# Tested layout: an app scaffolded with `npx create-tzin my-app --template node`
#   package.json            (scripts: build → tsc, start → node dist/index.js)
#   tsconfig.json           (tsc → dist/, rootDir src/)
#   src/index.ts            (imports app, calls listen())
#   src/app.ts              (exports the tzin App)
#
# Copy this file into YOUR app repo. If your entrypoint differs
# (e.g. src/main.ts), adjust the CMD line.

# ---- build ----
FROM node:20-slim AS build
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app

COPY --from=build /build/dist ./dist
COPY --from=build /build/package.json ./
COPY --from=build /build/package-lock.json ./

# Production deps only — drops devDependencies (tsx, vitest, typescript…).
RUN npm ci --omit=dev --ignore-scripts

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/openapi.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Matches the node template's `start` script.
CMD ["node", "dist/index.js"]
