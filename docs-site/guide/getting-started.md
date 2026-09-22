# Getting Started

## 1. Scaffold

```bash
npx create-tzin my-api
cd my-api
```

Pick a template: `node`, `bun` or `workers`.

## 2. Define a contract

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

## 3. Create the app

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

This automatically exposes:

* `GET /openapi.json` — OpenAPI 3.1
* `POST /mcp` — MCP Streamable HTTP
* `GET /llms.txt` / `GET /llms-full.txt` — when `llms: true`

## 4. Run

```bash
npx tzin dev    # dev server at http://localhost:3000
npx tzin build  # production build -> dist/
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

## Typed client

```ts
import { client } from '@carlos-tzin/tzin'
import { getUser } from './routes/users.js'

const api = client({ getUser }, 'http://localhost:3000')
const res = await api.getUser({ params: { id: '42' } })
if (res.status === 200) {
  console.log(res.body.name) // string
}
```

## Next steps

* [API Reference](/guide/api-reference) — all exports and options
* [Architecture](/guide/architecture) — pipeline, router, middleware, DI
* [Deployment](/guide/deployment) — Docker, Workers, clustering
