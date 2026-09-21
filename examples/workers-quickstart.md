# Minimal wrangler project for tzin + Durable Objects

This is a self-contained example you can copy into a fresh project and deploy.

## Files

```text
my-workers-app/
├── package.json
├── tsconfig.json
├── wrangler.toml
└── src/
    └── app.ts
```

## package.json

```json
{
  "name": "my-tzin-workers-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@carlos-tzin/tzin": "^1.0.4"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.0.0",
    "typescript": "^5.6.0",
    "wrangler": "^4.0.0"
  }
}
```

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

> Workers uses `module: "ESNext"` + `moduleResolution: "Bundler"` because Wrangler bundles the final script. Do **not** use `NodeNext` here.

## wrangler.toml

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

## src/app.ts

```ts
import {
  createApp,
  contract,
  impl,
  t,
  Hub,
  Presence,
  channelRoutes,
  wsChannels,
  toDurableWorker,
  toWorker,
  TzinChannels,
} from '@carlos-tzin/tzin'

// workerd discovers Durable Object classes among the script's exports.
export { TzinChannels }

const health = contract({
  name: 'health',
  method: 'GET',
  path: '/health',
  responses: { 200: t.Object({ ok: t.Boolean(), runtime: t.String() }) },
})

const chat = contract({
  name: 'chat',
  method: 'GET',
  path: '/chat',
  responses: { 200: t.Object({ ok: t.Boolean() }) },
})

export default toDurableWorker(() => {
  const hub = new Hub()
  const presence = new Presence(hub, 30_000)

  const app = createApp([
    impl(health, () => ({
      status: 200 as const,
      body: { ok: true, runtime: 'cloudflare-workers' },
    })),
    impl(chat, () => ({
      status: 200 as const,
      body: { ok: true },
    })),
    ...channelRoutes(hub, { presence }),
  ])
  return toWorker(app, { wsRoutes: [wsChannels(hub, { presence })] })
})
```

## Setup and deploy

```bash
npm install
npm run typecheck     # verifies the app compiles
npm run dev           # local dev with Wrangler (miniflare under the hood)
npm run deploy        # deploy to Cloudflare
```

## Tests / probe

The framework ships a workers probe used in CI:

```bash
npm run probe:workers
```

That probe bundles the app via esbuild and runs it in Miniflare, validating HTTP + WebSocket + SSE + Presence end-to-end. See `scripts/workers-probe.mjs` and `examples/worker-channels.ts`.

## When you need Durable Objects

Any app using WebSocket channels (`wsChannels`) or cross-connection broadcast **must** run inside a Durable Object. workerd ties each WebSocket to the I/O context of the request that created it — a send from one connection's context to another's socket is silently dropped.

Plain HTTP-only apps can use `toWorker` without a DO:

```ts
import { createApp, contract, impl, t, toWorker } from '@carlos-tzin/tzin'

const health = contract({
  method: 'GET',
  path: '/health',
  responses: { 200: t.Object({ ok: t.Boolean() }) },
})

const app = createApp([
  impl(health, () => ({ status: 200 as const, body: { ok: true } })),
])

export default toWorker(app)
```

This variant needs no `durable_objects` binding in `wrangler.toml`.
