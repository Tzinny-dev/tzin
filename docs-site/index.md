---
layout: home

hero:
  name: tzin
  text: Contract-first TypeScript framework
  tagline: Types that scale. Realtime built in. AI-native from day one. Declare a contract once — get validation, OpenAPI, typed clients and MCP for free.
  image:
    src: /logo.svg
    alt: tzin
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/Tzinny-dev/tzin
    - theme: alt
      text: API Reference
      link: /guide/api-reference

features:
  - icon: 📜
    title: Contract-first
    details: Flat registry, O(1) inference per endpoint. No builder-chain blowup — 15k types for 100 routes vs 112k in Hono.
  - icon: 🔒
    title: Types that scale
    details: TypeBox is JSON Schema natively. OpenAPI 3.1 and MCP tools generated with zero translation layer.
  - icon: ⚡
    title: Realtime built in
    details: SSE + POST channels, Phoenix-style presence, WS adapter. Multi-node via 2-method MessageBus (Redis, DO).
  - icon: 🤖
    title: AI-native
    details: "Every app is an MCP server (stdio + Streamable HTTP) and exposes /llms.txt + /openapi.json automatically."
  - icon: 🌐
    title: Runtimes everywhere
    details: Node (listen), Bun (serveBun), Cloudflare Workers (toWorker / toDurableWorker). One contract, three targets.
  - icon: 🧪
    title: Test & ship
    details: Typed test client, tzin dev with hot reload, tzin deploy --target node|workers with Docker pack.

---

## Declare once, get everything

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

const app = createApp([getUserRoute], { openapi: true, mcp: true })
listen(app, 3000)
```

From that single declaration you get:

* **Extractors, not guesses** — `params`/`query`/`body` appear only if declared, fully typed and validated.
* **Compiler-enforced responses** — wrong `200` shape is a type error.
* **OpenAPI 3.1 free** — contracts are already JSON Schema.
* **MCP free** — each contract becomes a tool.

## Benchmarks

| N routes | tzin: types | Hono: types | tzin: instantiations |
|---|---|---|---|
| 20 | 4,851 | 72,368 | 22,472 |
| 100 | 15,779 | 111,952 | 93,128 |
| 300 | 43,099 | 210,912 | 270k |

Strictly linear — ~130 types/endpoint.

| Runtime | req/s | p99 |
|---|---|---|
| raw node:http | ~42k | 2–3ms |
| hono | ~34–36k | 3ms |
| **tzin** | **~30–31k** | **6ms** |
| express | ~15k | 7ms |


## Quick start

```bash
npx create-tzin my-api
cd my-api
npx tzin dev    # http://localhost:3000
```

<div class="tip custom-block" style="padding-top: 8px">

Want the full story? Start with [Why tzin?](/guide/why) → [Getting Started](/guide/getting-started).

</div>
