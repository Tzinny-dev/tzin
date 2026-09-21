# Example Dockerfile for a tzin app (multi-stage, documentation-first).
#
# Copy this file into YOUR app repo and adapt paths. It is NOT wired to
# this framework repo's own src/ layout — replace the COPY lines with
# your app's entrypoint (e.g. src/app.ts + src/main.ts).
#
# Expected app layout:
#   package.json / package-lock.json
#   tsconfig.build.json          (tsc → dist/)
#   src/app.ts                   (exports the tzin App)
#   src/main.ts                  (imports app, calls listen())

# ---- build ----
FROM node:20-slim AS build
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app

COPY --from=build /build/dist ./dist
COPY --from=build /build/package.json ./
COPY --from=build /build/package-lock.json ./

# Production deps only — drops devDependencies (tsx, vitest, wrangler…).
RUN npm ci --omit=dev --ignore-scripts

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Your compiled entrypoint goes here (example: dist/main.js).
CMD ["node", "dist/main.js"]
