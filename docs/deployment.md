# Deployment guide

Three production paths for a tzin app: Node container, Cloudflare Workers, and multi-node clustering.

> New here? The fastest way to a deployable project is
> `npx create-tzin my-app` — pick the `node`, `bun` or `workers`
> template, then follow the matching section below.

## 1. Node.js (Docker)

### Build your app

A tzin app is a standard TypeScript project with `src/app.ts` exporting the App:

```bash
npx create-tzin my-app --template node   # src/app.ts + src/index.ts + tsconfig.json
cd my-app && npm install
```

Build it with the TypeScript compiler (the template's `build` script):

```bash
npm run build            # tsc → dist/ (template script: "build": "tzin build")
```

The compiled app lives in `dist/`. Serve it with the Node adapter (your own `src/app.ts` exports the app):

```ts
// src/main.ts  — your production entrypoint
import { listen } from '@carlos-tzin/tzin'
import app from './app.js'

listen(app, { port: Number(process.env.PORT) || 3000 })
```

### Dockerfile (multi-stage, matches the node template)

Copy this into the app repo created above. It uses the template's own
layout (`tsconfig.json` → `dist/`, entry `src/index.ts` → `dist/index.js`)
so `docker build .` works with no path edits — only change the image
name and `PORT` if needed.

```dockerfile
# ---- build ---- — same files the node template ships
FROM node:20-slim AS build
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build          # tsc → dist/ (template script: "build": "tzin build")

# Copy your app entrypoint (the file that exports + starts the app)
COPY src/app.ts ./app.ts
COPY src/main.ts ./main.ts   # if you have a separate starter

# ---- runtime ----
FROM node:20-slim
WORKDIR /app

COPY --from=build /build/dist ./dist
COPY --from=build /build/package.json ./
COPY --from=build /build/package-lock.json ./

# Production deps only — drops the template's devDependencies
# (tsx, vitest, typescript, @types/node).

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Matches the node template's `start` script ("node dist/index.js").
CMD ["node", "dist/index.js"]
```

End-to-end on a machine with a Docker daemon (not validated in CI here):

```bash
npx create-tzin my-app --template node && cd my-app && npm install
cp /path/to/tzin/Dockerfile /path/to/tzin/.dockerignore .
docker build -t my-tzin-app .
docker run -p 3000:3000 --env PORT=3000 my-tzin-app
curl -fs localhost:3000/health   # {"status":"ok"}
```

(The template's `/health` returns 200 — the Dockerfile `HEALTHCHECK`
above assumes exactly that.)

> **Note:** If your app entrypoint does both export + listen in the same file (like `examples/node-demo.ts`), compile it and run the resulting `dist/*.js` directly. If it only exports the app (recommended), add a tiny `main.ts` that calls `listen()`.

### Build and run

```bash
docker build -t my-tzin-app .
docker run -p 3000:3000 --env PORT=3000 my-tzin-app
```

### Multi-node without code changes? Not quite — one optional file

`tzin` has no magic env-var switch for clustering: a `Hub` joins a cluster
only when you pass it a `MessageBus`. The **node template** ships the
optional helper for exactly this — `src/bus.ts`:

- No `REDIS_URL` → `redisBus()` returns `undefined`, app runs standalone.
- `REDIS_URL=redis://…` → returns an ioredis-backed `MessageBus`
  (lazy `import('ioredis')`, so the dep is only needed when you scale).
- `src/bus.ts` typechecks with **zero new dependencies** (structural typing).

To use it, wire the hub where you create channels (or just leave the file
unused — it costs nothing). Install the driver only for scaled deploys:

```bash
npm i ioredis
```

### docker-compose (app + Redis for clustering)

```yaml
services:
  app:
    build: .
    ports: ["3000:3000"]
    environment:
      - NODE_ENV=production
      - PORT=3000
      - TZIN_BUS=redis
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --save "" --appendonly no
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped
```

Scale horizontally (needs `npm i ioredis` + the `src/bus.ts` wiring above):

```bash
docker compose up -d --scale app=3
```

Each node shares channels and presence through Redis pub/sub. See [MessageBus / clustering](architecture.md#multi-node) for the wiring.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | — | Set to `production` |
| `TZIN_BUS` | — | Set to `redis` to enable multi-node (requires Redis URL via `REDIS_URL` or ioredis defaults) |

## 2. Cloudflare Workers

### Requirements

- Wrangler CLI: `npm install -D wrangler` (or use `npx wrangler`)
- A Workers-compatible project (see `create-tzin` workers template)
- Durable Objects enabled for WebSocket channels (workerd binds each socket to its creating request's I/O context)

### Minimal wrangler.toml

```toml
name = "my-tzin-workers-app"
main = "src/app.ts"
compatibility_date = "2025-01-01"
workers_dev = true

[durable_objects]
bindings = [{ name = "TZIN_APP", class_name = "TzinChannels" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TzinChannels"]
```

### App entrypoint (Workers)

```ts
// src/app.ts
import {
  createApp, contract, impl, t,
  Hub, Presence, channelRoutes, wsChannels,
  toDurableWorker, toWorker, TzinChannels,
} from '@carlos-tzin/tzin'

export { TzinChannels }

const health = contract({
  method: 'GET',
  path: '/health',
  responses: { 200: t.Object({ ok: t.Boolean() }) },
})

export default toDurableWorker(() => {
  const hub = new Hub()
  const presence = new Presence(hub, 30_000)

  const app = createApp([
    impl(health, () => ({ status: 200 as const, body: { ok: true } })),
    ...channelRoutes(hub, { presence }),
  ])
  return toWorker(app, { wsRoutes: [wsChannels(hub, { presence })] })
})
```

### Deploy

```bash
npx wrangler deploy
```

Use `tzin deploy --target workers` from the CLI if your project has `wrangler.toml`.

> **When you need Durable Objects:** Any app using WebSocket channels (`wsChannels`) or cross-connection broadcast must run inside a DO. Plain HTTP-only apps can use `toWorker` without a DO.

### Local dev

```bash
npx wrangler dev
# or with miniflare directly (used by CI probe):
npm run probe:workers
```

## 3. Multi-node clustering (Redis)

For horizontal scale with shared channels and presence, wire hubs over a `MessageBus`. Redis PUBLISH/SUBSCRIBE maps in ~15 lines:

```ts
import { createClient } from 'ioredis'
import { Hub } from '@carlos-tzin/tzin'

const redis = await createClient({ url: process.env.REDIS_URL }).connect()
const hub = new Hub({
  bus: {
    publish: (ch, msg) => redis.publish(ch, msg),
    subscribe: (ch, fn) => {
      const sub = redis.duplicate()
      sub.subscribe(ch)
      sub.on('message', (c, m) => c === ch && fn(m))
      return () => sub.destroy()
    },
  },
})
```

Each node runs the same app code; all publishes fan out to every node's local subscribers. Presence state is cluster-wide (see `src/presence.ts`).

## Health check

Every tzin app should expose a health contract:

```ts
const health = contract({
  method: 'GET',
  path: '/health',
  responses: { 200: t.Object({ status: t.String() }) },
})

impl(health, async () => ({
  status: 200 as const,
  body: { status: 'ok' },
}))
```

The Dockerfile above assumes `/health` returns 200. Adjust the `HEALTHCHECK` CMD if your path differs.

## Process management (bare Node, no Docker)

- **PM2:** `pm2 start dist/index.js --name tzin --env production` (the node template's entry)
- **SIGTERM:** tzin's Node adapter handles graceful shutdown; make sure your process manager forwards signals.
- **Logs:** stdout/stderr. For structured logging, see the [logging roadmap phase](roadmap.md#fase-7-logging).

## What's next — status

- [x] **Docker / compose reference** — `Dockerfile` (multi-stage, doc-first),
  `.dockerignore`, `docker-compose.yml` (app + Redis, healthchecks). No daemon
  here to `docker build`, so treat as reviewed-not-executed.
- [x] **Workers copy-paste project** — `examples/workers-quickstart/` (real files)
  + `examples/workers-quickstart.md` (same files, explained). Runtime verified
  by the existing miniflare probe (`npm run probe:workers`, 5/5).
- [x] **Release automation (assisted)** — `scripts/release.mjs <patch|minor|major>
  [--dry-run]`: bumps root version, syncs `create-tzin` templates to `^NEXT`,
  prepends a CHANGELOG skeleton, commits + tags. Publish itself stays manual
  (OTP) — see `Next steps` output of the script.
- [ ] **Tag-triggered CI publish** — see `.github/workflows/release.yml` (runs
  on `v*` tags, needs `NPM_TOKEN` secret). Not yet exercised end-to-end.
- [x] **`tzin deploy --target node` as a real artifact** — `src/cli.ts` now
  builds with `tsc` and then: `--pack` tars `dist + package.json (+Dockerfile /
  docker-compose.yml / .dockerignore` when present) into
  `<name>-<version>.tgz`; `--docker <tag>` runs `docker build -t <tag>`;
  `--push` chains `docker push`. Validated here with a scratch project
  (build → pack → tarball lists `dist/ + package.json`); docker build/push
  paths only print their commands because this environment has no daemon.
