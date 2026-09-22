# Examples

All examples live in [`examples/`](https://github.com/Tzinny-dev/tzin/tree/main/examples) and are runnable.

| Example | Runtime | What it shows |
|---|---|---|
| `examples/node-demo.ts` | Node | Minimal HTTP server with contracts |
| `examples/bun-demo.ts` | Bun | Bun.serve with validation |
| `examples/todo-api.ts` | Node | Full CRUD: auth middleware, DI, OpenAPI, MCP |
| `examples/mcp-demo.ts` | Node | MCP server over stdio |
| `examples/ws-demo.ts` | Bun | WebSocket channels with presence |
| `examples/workers-quickstart/` | Workers | Copy-paste wrangler project: DO + channels + presence |
| `examples/workers-quickstart.md` | Workers | Same project, explained file-by-file |

## Minimal Node demo

```ts
import { t, contract, impl, createApp, listen } from '@carlos-tzin/tzin'

const health = contract({
  method: 'GET',
  path: '/health',
  responses: { 200: t.Object({ status: t.String() }) },
})

const healthRoute = impl(health, async () => ({
  status: 200 as const,
  body: { status: 'ok' },
}))

const app = createApp([healthRoute])
listen(app, 3000)
```
