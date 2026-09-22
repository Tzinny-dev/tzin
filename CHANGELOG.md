# Changelog

## 1.0.6 — 2026-09-22

Deployment fixes after the 1.0.5 release. No API changes.

### Templates

- `create-tzin/templates/node/src/bus.ts`: `import('ioredis' as string)`
  — the dynamic import was being resolved by `tsc` at compile time, so a
  freshly scaffolded app (without `ioredis` installed) failed to build with
  `Cannot find module 'ioredis'`. Now it typechecks and runs with zero new
  dependencies; `ioredis` is only fetched at runtime when `REDIS_URL` is set.

### Docker

- `Dockerfile` HEALTHCHECK now hits `/openapi.json` instead of `/health`.
  The node template mounts `bearerAuth` on every route, so `/health` returns
  401 and the healthcheck would always fail. `/openapi.json` is public.

### Compose / docs

- `docker-compose.yml`: removed the `TZIN_BUS=redis` env var (the framework
  never read it — clustering is enabled by `REDIS_URL` via `src/bus.ts`).
  Added a comment that `build: .` points at the app root, not the framework
  repo.
- `docs/deployment.md` env-var table: `TZIN_BUS` → `REDIS_URL`.

## 1.0.5 — 2026-09-21

Deployment polish + release automation. No API changes to the framework core.

### CLI deploy

- `tzin deploy --target node --pack` builds with `tsc` and packs
  `dist + package.json (+Dockerfile / docker-compose.yml / .dockerignore`
  when present) into `<name>-<version>.tgz`
- `tzin deploy --target node --docker <tag> [--push]` runs
  `docker build -t <tag>` and optionally `docker push`
- Fix: the trailing `usage()` call and a premature `process.exit(0)` killed
  async deploy/build before the `tsc` child finished — deploy printed the
  help text and died silently. Now gated behind a `matched` flag, unknown
  targets error clearly (`Available: node, workers`)

### Docker + docs

- `Dockerfile` (multi-stage, `node:20-slim`, prod-only deps,
  `HEALTHCHECK` on `/health`) aligned to the real node template layout
  (`tsconfig.json` → `dist/index.js`); `.dockerignore`; `docker-compose.yml`
  (app + Redis with healthchecks)
- `docs/deployment.md`: Node container, Workers Durable Objects,
  multi-node Redis recipes, exact `create-tzin → docker build` flow
- `examples/workers-quickstart/` + `.md`: copy-paste wrangler project
  (DO + channels + presence); README examples table updated

### Templates

- All `create-tzin` templates bumped to `@carlos-tzin/tzin ^1.0.5`
- Fix: `createApp([…, usersRoute])` nested an array inside the route list —
  now `...usersRoute` in node/bun/workers templates
- New optional `src/bus.ts` in the node template: `redisBus()` returns
  `undefined` without `REDIS_URL`, ioredis-backed `MessageBus` with it
  (lazy import, zero new deps to typecheck)

### Release process

- `scripts/release.mjs <patch|minor|major> [--dry-run]`: version bump,
  template sync, CHANGELOG skeleton, commit + tag
- `.github/workflows/release.yml`: tag-triggered CI (build + tests only);
  publishing is manual with the npm token in `~/.npmrc` (no repo secret)

## 1.0.4 — Node 20 compatibility fix

No API changes. CI was failing on the Node 20 floor because the WS test and the
Workers probe relied on the global `WebSocket`, which only exists on Node ≥22.

### Testing & coverage

- `native websockets` test and the Workers probe use the `ws` package client
  instead of the global `WebSocket`, keeping the Node 20 floor green

No API changes. Focused on proving the stable claim in CI and on the
type surface.

### Testing & coverage

- Unit suites for `cache.ts` and `rate-limit.ts` (30 tests) — previously the
  only modules without direct coverage
- Coverage gates in CI: `npm run test:coverage` requires ≥70% lines, functions,
  statements and branches across `src/` (baseline 73.6%)
- `vitest.config.ts` with the v8 provider; `coverage/` git-ignored

### CI matrix

- Node `20 / 22 / 24` — previously only 22 and 24; Node 20 is the documented
  floor and is now exercised
- Cloudflare Workers probe (`miniflare`) runs on every push, not just releases
- Benchmark job (`lookup`, `pipeline`, `http`) runs in CI with minimal rounds
  to catch runtime regressions early

### Type-surface cleanup

- Public `RouteImpl<any>` occurrences replaced by the new erasable
  `AnyRoute` type — `createApp`, MCP tools, OpenAPI, llms.txt, channels and
  route-table printing now take `AnyRoute[]` while `impl()` keeps full
  per-endpoint typing
- Browser client callbacks (`on`) and internal `any` returns typed as
  `unknown`; `client()` proxy input uses a typed `ClientInput`
- New exports: `AnyRoute`, `RouteResult`

## 1.0.1 — Repo moved to Tzinny-dev

Metadata-only release after the source repository moved from
`github.com/Charly921/tzin` to `github.com/Tzinny-dev/tzin`. No API changes.

## 1.0.0 — Stable Release

The first stable release of tzin. Contract-first TypeScript framework with
realtime, AI-native tooling, and a complete development experience.

### What's new since 0.1.2

#### Project Structure

- Convention-based project layout: `src/routes/`, `src/middleware/`, `src/app.ts`
- Config system: `defineConfig()`, auto-detection of `src/app.ts`
- Dev server: `tzin dev` with hot reload and route table display

#### CLI

- `tzin dev [entry] [--port N]` — dev server with hot reload
- `tzin build` — production build
- `tzin deploy --target node|workers` — deploy to production
- `tzin generate route <name>` — scaffold a route
- `tzin generate middleware <name>` — scaffold middleware
- `tzin generate test <name>` — scaffold a test

#### Database

- `defineModel(table, schema)` — type-safe ORM with query builder
- `findById`, `findFirst`, `findMany` — CRUD operations
- Chainable query builder: `.where().limit().orderBy()`
- Extensible store adapters: `setStore(adapter)`

#### Authentication

- `bearerAuth({ secret })` — JWT Bearer token validation
- `optionalAuth({ secret })` — non-strict JWT validation
- `apiKeyAuth({ key })` — API key authentication
- `signJwt()` / `verifyJwt()` — JWT utilities

#### Jobs & Tasks

- `defineJob<Payload>(config)` — background job definition
- `job.enqueue(payload)` — job queue with retry
- `handle.wait()` — wait for job completion

#### Logging

- `log.info/warn/error/fatal` — structured logging
- `log.child(prefix)` — scoped child loggers
- `configure({ level, pretty })` — global configuration

#### Rate Limiting

- `rateLimit({ max, windowMs })` — request rate limiting
- `strictRateLimit()` — strict limiting for sensitive endpoints
- Custom store adapters for distributed rate limiting

#### Caching

- `cache({ ttl })` — HTTP response caching
- `staleWhileRevalidate()` — stale-while-revalidate pattern
- Cache headers: X-Cache, Cache-Control, ETag

#### Testing

- `createTestClient(app)` — API test client
- `expectSchema(schema, value)` — schema validation
- `mockSections(contract)` — mock data generation

#### Documentation

- Complete API Reference with all modules
- Architecture Guide
- Updated README with feature table

### Backwards Compatibility

This release is backwards compatible with 0.1.x.

## 0.1.2

- Added `create-tzin` scaffolding CLI (`npx create-tzin my-app`)
  - Templates: Node, Bun, Cloudflare Workers
  - Interactive and non-interactive modes
- Added API Reference and Architecture Guide docs

## 0.1.1

- Documentation improvements: trimmed roadmap, added examples table

## 0.1.0 — first public release

Contract-first TypeScript framework: declare a contract once, get the typed
handler, the typed client, OpenAPI 3.1, MCP tools and realtime channels.

### Core

- `contract()` / `impl()` — flat route registry with O(1) inference per endpoint
- Extractor-style handler input: `params`, `query`, `body`, `headers`, `cookies`
  (declared sections only, validated per request via TypeBox)
- Status-discriminated response unions enforced by the compiler
- `HttpError` → mapped to declared statuses; middleware can catch and transform
- Onion-style middleware with typed per-request context (`defineContext`/`ctx.require`)
- Light DI: `provide(key, value)` seeds typed singletons into request context
- Radix-trie router (9.1M lookups/s), static beats param, order-stable tiebreak

### Runtimes

- Node (`listen()` — optimized adapter with streaming SSE + WebSockets)
- Bun (`serveBun()` — native `Bun.serve` websockets)
- Cloudflare Workers (`toWorker()`, channels inside a Durable Object via
  `TzinChannels`; verified against real workerd through miniflare)

### Realtime

- Channels mounted as ordinary routes: SSE down / POST up on every runtime,
  or native WebSockets (`wsChannels` + `attachChannels` / Bun / Workers DO)
- Presence with TTL, heartbeats and sweep — ghosts disappear even after crashes
- Multi-node: wire hubs over any `MessageBus` (Redis PUBLISH/SUBSCRIBE,
  Postgres LISTEN/NOTIFY, Durable Objects); no echo, lazy per-topic subscriptions
- Zero-dependency browser client: `joinChannel` with auto-heartbeat

### AI-native

- MCP server over stdio (`startStdioMcp`) and Streamable HTTP (`{ mcp: true }`)
- `tools/list` / `tools/call` dispatch in-process through validation, middleware
  and DI; HTTP errors surface as `isError` results
- `/llms.txt` + `/llms-full.txt` generated from contracts (`{ llms: true }`)
- OpenAPI 3.1 generation with zero schema conversion (TypeBox is JSON Schema)

### Developer experience

- Typed client with status narrowing: `if (res.status === 200) res.body...`
- Dev server with hot reload printing the route table from contracts
- CORS as onion middleware: wildcard or reflected origins, allow-lists,
  credentials-safe (never combines `*` with credentials), preflight
  short-circuit before routing
