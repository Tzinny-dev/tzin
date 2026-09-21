# tzin

**Contract-first TypeScript framework. Types that scale. Realtime built in. AI-native from day one.**

> `tzin` — from Nahuatl *-tzin*, an honorific suffix for what is valued and beloved.
> A pact between client and server, declared once.

[![CI](https://github.com/Tzinny-dev/tzin/actions/workflows/ci.yml/badge.svg)](https://github.com/Tzinny-dev/tzin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@carlos-tzin/tzin)](https://www.npmjs.com/package/@carlos-tzin/tzin)
[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white)](https://paypal.me/carlostzin)

**Status: stable (1.0.x).** The core works end-to-end (see [Benchmarks](#benchmarks));
1.0.0 shipped the stable API, and 1.0.2 adds test coverage gates, a wider CI
matrix and a public type-clean surface.

```sh
npm install @carlos-tzin/tzin
```

Or scaffold a new project:

```sh
npx create-tzin my-app
```

## Documentation

- **[API Reference](docs/api-reference.md)** — all exports, types, and options
- **[Architecture Guide](docs/architecture.md)** — request pipeline, design decisions, internals
- **[Deployment Guide](docs/deployment.md)** — Docker, Cloudflare Workers, multi-node clustering
- **[Roadmap](docs/roadmap.md)** — future features

## Why another framework?

The TypeScript backend landscape is crowded — and still leaves real gaps:

| Gap | Evidence |
|---|---|
| Type inference collapses at scale | Hono issues [#2399](https://github.com/honojs/hono/issues/2399), [#3869](https://github.com/honojs/hono/issues/3869); chained route builders force one giant expression per app |
| No architecture in lightweight frameworks | Hono issue [#4121](https://github.com/honojs/hono/issues/4121) |
| Extractors don't exist in TS | Only Rust's Axum gets handler input right |
| OpenAPI is a bolt-on | Every TS framework translates its own schema DSL to JSON Schema at runtime or via codegen |
| AI-native toolchain | One framework ships an MCP server; the window is closing |

tzin's answer: **declare a contract once**, get everything else for free.

```ts
import { t } from '@carlos-tzin/tzin'
import { contract, impl, createApp, listen } from '@carlos-tzin/tzin'

const getUser = contract({
  method: 'GET',
  path: '/users/:id',
  params: t.Object({ id: t.String() }),
  responses: {
    200: t.Object({ id: t.String(), name: t.String(), tags: t.Array(t.String()) }),
    404: t.Object({ error: t.String() }),
  },
})

export const getUserRoute = impl(getUser, async ({ params }) => {
  const user = await findUser(params.id)
  if (!user) throw new HttpError(404, 'user not found')
  return { status: 200, body: user }
})

const app = createApp([getUserRoute])
listen(app, 3000)
```

From that single declaration:

- **Handler input is extracted, not guessed**: `{ params }` exists because you declared
  it; add `query`, `body`, `headers` or `cookies` to the contract and they appear,
  fully typed and validated per request.
- **The compiler enforces your responses**: returning a shape that doesn't match the
  declared `200` body is a type error. Thrown `HttpError`s map to their status.
- **OpenAPI 3.1 is free**: contracts are JSON Schema (TypeBox), so
  `generateOpenApi(routes)` needs no translation layer.

## Features

### Core

| Feature | Import | Description |
|---|---|---|
| Contracts | `@carlos-tzin/tzin` | Type-safe API contracts |
| Routes | `@carlos-tzin/tzin` | Bind contracts to handlers |
| Middleware | `@carlos-tzin/tzin` | Onion-style middleware |
| DI | `@carlos-tzin/tzin` | Typed dependency injection |

### Runtime

| Feature | Import | Description |
|---|---|---|
| Node server | `@carlos-tzin/tzin` | `listen(app, port)` |
| Bun server | `@carlos-tzin/tzin` | `serveBun(app, port)` |
| Workers | `@carlos-tzin/tzin` | `toWorker(app)` |
| Dev server | CLI | `tzin dev` with hot reload |

### Realtime

| Feature | Import | Description |
|---|---|---|
| Channels | `@carlos-tzin/tzin` | SSE + POST channels |
| Presence | `@carlos-tzin/tzin` | Phoenix-style presence |
| WebSocket | `@carlos-tzin/tzin/ws` | Native WS channels |
| Browser client | `@carlos-tzin/tzin/client-browser` | Zero-dep browser client |

### AI-Native

| Feature | Import | Description |
|---|---|---|
| MCP Server | `@carlos-tzin/tzin` | Streamable HTTP + stdio |
| OpenAPI | `@carlos-tzin/tzin` | Auto-generated from contracts |
| LLMs.txt | `@carlos-tzin/tzin` | AI-readable API index |

### Database

| Feature | Import | Description |
|---|---|---|
| Models | `@carlos-tzin/tzin/db` | Type-safe ORM |
| Query builder | `@carlos-tzin/tzin/db` | Chainable queries |
| Store adapters | `@carlos-tzin/tzin/db` | Swappable backends |

### Auth

| Feature | Import | Description |
|---|---|---|
| Bearer auth | `@carlos-tzin/tzin/auth` | JWT validation |
| Optional auth | `@carlos-tzin/tzin/auth` | Non-strict JWT |
| API key | `@carlos-tzin/tzin/auth` | Header-based auth |
| JWT utils | `@carlos-tzin/tzin/auth` | sign/verify |

### Jobs

| Feature | Import | Description |
|---|---|---|
| Define jobs | `@carlos-tzin/tzin/jobs` | Background tasks |
| Enqueue | `@carlos-tzin/tzin/jobs` | Job queue |
| Retry | `@carlos-tzin/tzin/jobs` | Auto-retry on failure |

### Logging

| Feature | Import | Description |
|---|---|---|
| Logger | `@carlos-tzin/tzin/log` | Structured logging |
| Child loggers | `@carlos-tzin/tzin/log` | Scoped context |
| Pretty/JSON | `@carlos-tzin/tzin/log` | Configurable output |

### Testing

| Feature | Import | Description |
|---|---|---|
| Test client | `@carlos-tzin/tzin/test` | API testing |
| Schema validation | `@carlos-tzin/tzin/test` | Type assertions |
| Mock data | `@carlos-tzin/tzin/test` | Generate mocks |

## Quick Start

### 1. Scaffold

```bash
npx create-tzin my-api
cd my-api
```

### 2. Define a contract

```ts
// src/routes/users.ts
import { t, contract, impl } from '@carlos-tzin/tzin'

export const getUser = contract({
  method: 'GET',
  path: '/users/:id',
  params: t.Object({ id: t.String() }),
  responses: {
    200: t.Object({ id: t.String(), name: t.String() }),
    404: t.Object({ error: t.String() }),
  },
})

export const getUserRoute = impl(getUser, async ({ params }) => {
  return { status: 200, body: { id: params.id, name: 'Ada' } }
})
```

### 3. Create the app

```ts
// src/app.ts
import { createApp } from '@carlos-tzin/tzin'
import { getUserRoute } from './routes/users.js'

export const app = createApp([getUserRoute], {
  openapi: true,
  mcp: true,
  meta: { title: 'My API', version: '1.0.0' },
})
```

### 4. Run

```bash
npx tzin dev    # dev server at http://localhost:3000
npx tzin build  # production build
```

## CLI

```bash
tzin dev [--port N]                                # dev server with hot reload
tzin build                                         # build for production
tzin deploy --target node|workers [--pack] [--docker <tag> [--push]]  # deploy
tzin generate route <name>                         # scaffold a route
tzin generate middleware <name>                    # scaffold middleware
tzin generate test <name>                          # scaffold a test
```

## Benchmarks

100 endpoints with distinct schemas, checked by `tsc --extendedDiagnostics`:

| N routes | tzin: types | Hono: types | tzin: instantiations | Hono: instantiations |
|---|---|---|---|---|
| 20 | 4,851 | 72,368 | 22,472 | 156,054 |
| 100 | 15,779 | 111,952 | 93,128 | 240k |
| 300 | 43,099 | 210,912 | 270k | 590k |

tzin grows **strictly linearly** (~130 types/endpoint).

### Runtime throughput

| Framework | req/s | p99 |
|---|---|---|
| raw node:http (floor) | ~42k | 2–3ms |
| hono | ~34–36k | 3ms |
| tzin | ~30–31k | 6ms |
| express | ~15k | 7ms |

## Examples

| Example | Runtime | What it shows |
|---|---|---|
| `examples/node-demo.ts` | Node | Minimal HTTP server with contracts |
| `examples/bun-demo.ts` | Bun | Bun.serve with validation |
| `examples/todo-api.ts` | Node | Full CRUD: auth middleware, DI, OpenAPI, MCP |
| `examples/mcp-demo.ts` | Node | MCP server over stdio |
| `examples/ws-demo.ts` | Bun | WebSocket channels with presence |
| `examples/workers-quickstart/` | Workers | Copy-paste wrangler project: DO + channels + presence |
| `examples/workers-quickstart.md` | Workers | Same project, explained file-by-file |

## Design principles

- **Contract-first, flat registry.** A route is data (`contract({...})`), not a link
  in a builder chain. Inference cost stays O(1) per endpoint.
- **JSON Schema native.** TypeBox schemas double as OpenAPI with zero conversion.
- **Web Standards runtime.** `Request` in, `Response` out; adapters stay thin.
- **Extractors over magic.** Handlers receive exactly what the contract declares.
- **Errors are control flow.** Throw typed errors; the response union already knows.
- **Light DI without ceremony.** `provide(key, value)` at app level seeds typed
  singletons into every request's context — handlers just `ctx.require(db)`.

## Development

```sh
npm install
npm test          # vitest — runtime + end-to-end client + type assertions
npm run typecheck # strict tsc across src/test/bench fixtures
```

## License

MIT — see [LICENSE](./LICENSE).
