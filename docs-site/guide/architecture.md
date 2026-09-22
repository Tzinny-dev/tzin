# Architecture Guide

How tzin processes requests from start to finish.

## Request Pipeline

```
Request
  │
  ▼
┌─────────────────────────┐
│  Router (radix trie)    │  Match path + method → extract params
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Validation             │  TypeBox checks params/query/body/headers
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Middleware (onion)      │  Pre-processing, auth, DI, CORS...
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Handler                │  Business logic, return typed response
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Response               │  JSON serialization, status, headers
└──────────┬──────────────┘
           │
           ▼
Response
```

## Contract-First Design

A contract is a plain object — not a builder chain. This gives O(1) type inference per endpoint.

```ts
// This is data, not a method call
const getUser = contract({
  method: 'GET',
  path: '/users/:id',
  params: t.Object({ id: t.String() }),
  responses: {
    200: t.Object({ id: t.String(), name: t.String() }),
    404: t.Object({ error: t.String() }),
  },
})
```

**Why flat objects?**

- Builder chains (`app.get(...).post(...)`) require one giant expression
- Separated statements lose type inference (`typeof app` drops routes)
- Flat objects → shallow types → constant cost per endpoint

## Type Inference

tzin grows ~130 types per endpoint. Hono grows ~1,100.

```
N=20:   tzin 4,851 types  vs  Hono 72,368 types
N=100:  tzin 15,779 types vs  Hono 111,952 types
N=300:  tzin 43,099 types vs  Hono 210,912 types
```

The difference: tzin uses indexed access on plain objects (shallow), Hono chains generic types (deep).

## Router

Radix trie with O(path depth) lookup. 9.1M lookups/s in benchmarks.

```
/users/:id     → node → {GET: handler}
/users/:id/posts → node → {GET: handler}
/health        → node → {GET: handler}
```

- Static routes beat param routes (tiebreak by specificity)
- 404: path not in trie
- 405: path exists but wrong method (returns `Allow` header per RFC 9110)

## Middleware

Onion-style composition. Each layer calls `next()` to proceed.

```
Request → middleware1 → middleware2 → handler
Response ← middleware1 ← middleware2 ← handler
```

```ts
const auth = middleware(async (ctx, next) => {
  // Before handler
  const user = await verifyToken(ctx.headers.authorization)
  ctx.set('user', user)
  
  const response = await next()
  
  // After handler (can transform response)
  return response
})
```

Middleware can:
- Read/write context (`ctx.get`, `ctx.set`)
- Short-circuit (throw `HttpError` or return early)
- Transform responses
- Add headers

## Dependency Injection

Light DI via `provide()` + `ctx.require()`.

```ts
// 1. Define a typed key
const dbKey = defineContext<Database>('db')

// 2. Seed it at app level
const app = createApp(routes, {
  provides: [provide(dbKey, database)],
})

// 3. Use it in handlers/middleware
const handler = impl(getUser, async ({ params, ctx }) => {
  const db = ctx.require(dbKey)  // typed as Database
  return { status: 200 as const, body: await db.getUser(params.id) }
})
```

Request-scoped middleware can override values:

```ts
const overrideDb = middleware(async (ctx, next) => {
  ctx.set(dbKey, testDatabase)  // override for this request
  return next()
})
```

## Runtime Adapters

All adapters implement the same pattern: convert platform request → `fetch(req)` → convert response.

### Node.js

```
node:http → duck-type Request → app.fetch → write Response to socket
```

Optimizations:
- Duck-typed request (skip undici `new Request()`)
- Fast response text (skip `res.text()` drain)
- Lazy AbortController (wired only if `ctx.signal` is read)
- Match cache (Map, capped at 10k entries)

### Bun

```
Bun.serve → app.fetch → Bun Response
```

Native WebSockets via `Bun.serve({ websocket: ... })`.

### Cloudflare Workers

```
workerd fetch → app.fetch → workerd Response
```

For WebSockets: entire app runs inside a Durable Object (single I/O context).

## Realtime Architecture

### Channels

SSE down + POST up (works on every runtime):

```
Client                Server
  │                     │
  ├─ GET /channels/lobby ──→ SSE stream
  │                     │
  ├─ POST /channels/lobby ─→ broadcast to all subscribers
  │   {event, data}     │
  │                     │
  ├─ POST /channels/lobby/heartbeat ─→ refresh presence TTL
  │                     │
  └─ POST /channels/lobby/leave ──→ announce departure
```

### Presence

Phoenix-style TTL presence:

1. Member joins → added to local members map
2. Heartbeat → TTL refreshed
3. Sweep (every 5s) → expired members removed, `presence_diff` broadcast
4. Multi-node → frames replicated over `MessageBus`, each node merges

### Multi-Node

```
Node A ←── MessageBus ──→ Node B
  │                          │
  Hub A                    Hub B
  │                          │
  Subscribers              Subscribers
```

Bus interface (2 methods):

```ts
interface MessageBus {
  publish(channel: string, message: string): Promise<void>
  subscribe(channel: string, handler: (message: string) => void): Promise<void>
}
```

Implementations: Redis (ioredis), Postgres (LISTEN/NOTIFY), Cloudflare Durable Objects.

## AI-Native Features

### MCP Server

Contracts → MCP tools automatically:

```ts
startStdioMcp(app)           // stdio transport
createApp(routes, { mcp: true }) // HTTP transport at POST /mcp
```

- `tools/list` returns JSON Schema `inputSchema` from contracts (TypeBox = JSON Schema)
- `tools/call` dispatches through validation, middleware, and DI
- Errors surface as `isError` results (not thrown)

### LLM.txt

```
GET /llms.txt      → index of endpoints
GET /llms-full.txt → index + inline JSON Schema
```

Generated from contracts — no manual maintenance.

## Performance

### Hot Path

1. Parse URL + match route (trie)
2. Validate sections (TypeBox `Value.Check`, ~0.05µs)
3. Run middleware chain
4. Execute handler
5. Serialize response (JSON.stringify + fast text)

### Why 0.9x of Hono?

In-process dispatch is equal (~127k vs 118k req/s). The gap is the Node adapter:

- Undici `new Request()` costs ~13µs under load
- `res.text()` costs ~7k req/s marginal
- Fixed with duck-request + fast response text

### Why Not 1.0x?

Remaining ~1.5x gap: Headers allocation, async scheduling overhead, middleware composition cost. Not CPU-bound (profiling shows 44% idle under load).
