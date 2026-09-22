# Framework Roadmap

De toolkit a framework completo. Orden por impacto.

## Fase 1: Convenciones (Ya)

**Project structure**
```
my-app/
├── src/
│   ├── routes/          # contratos + handlers
│   │   ├── users.ts
│   │   └── health.ts
│   ├── middleware/       # middleware custom
│   │   └── auth.ts
│   ├── services/        # lógica de negocio
│   │   └── user.service.ts
│   ├── lib/             # utilidades
│   │   └── db.ts
│   └── app.ts           # createApp + config
├── tests/
│   └── routes/          # tests por contrato
├── tzin.config.ts       # configuración del framework
└── package.json
```

**Config file** (`tzin.config.ts`)
```ts
export default defineConfig({
  port: 3000,
  openapi: true,
  mcp: true,
  llms: true,
  middleware: ['./src/middleware/auth.ts'],
})
```

## Fase 2: Testing Utilities

**`@carlos-tzin/tzin/test`**

```ts
import { createTestClient } from '@carlos-tzin/tzin/test'

const api = createTestClient(app)

// Valida contrato completo
const res = await api.get('/users/:id', { params: { id: '1' } })
expect(res.status).toBe(200)
expect(res.body).toMatchType(getUser.responses[200])

// Valida errores
const err = await api.get('/users/:id', { params: { id: '999' } })
expect(err.status).toBe(404)
```

**Contract testing**
```ts
import { testContract } from '@carlos-tzin/tzin/test'

testContract(getUser, async (api) => {
  // Testea que el handler cumple el contrato
  const res = await api.call(getUser, { params: { id: '1' } })
  expect(res).toSatisfyContract()
})
```

## Fase 3: CLI con Codegen

**`tzin generate`**
```bash
# Generar route stub desde contrato
tzin generate route users/create

# Generar middleware stub
tzin generate middleware auth

# Generar test stub
tzin generate test users/get

# Generar cliente MCP desde contratos
tzin generate mcp
```

**`tzin dev` mejorado**
```bash
# Instead of: npx tsx src/cli.ts dev examples/node-demo.ts
tzin dev

# Auto-detecta app.ts, imprime rutas, hot reload
```

**`tzin build`**
```bash
# Build para producción
tzin build

# Build + deploy a Cloudflare Workers
tzin deploy --target workers

# Build + deploy a Node
tzin deploy --target node
```

## Fase 4: Database Integration

**`@carlos-tzin/tzin/db`**
```ts
import { defineModel } from '@carlos-tzin/tzin/db'

const User = defineModel('users', {
  id: t.String(),
  name: t.String(),
  email: t.String(),
})

// Query builder tipado
const user = await User.findById('1')
const users = await User.where({ name: 'ada' })
```

## Fase 5: Auth Patterns

**`@carlos-tzin/tzin/auth`**
```ts
import { bearerAuth, jwt } from '@carlos-tzin/tzin/auth'

const app = createApp(routes, {
  middleware: [
    bearerAuth({ secret: process.env.JWT_SECRET }),
  ],
})
```

## Fase 6: Jobs & Tasks

**`@carlos-tzin/tzin/jobs`**
```ts
import { defineJob } from '@carlos-tzin/tzin/jobs'

const sendEmail = defineJob('send-email', async (payload) => {
  await resend.emails.send({ ... })
})

// En handler
await sendEmail.enqueue({ to: 'ada@example.com' })
```

## Fase 7: Logging

**`@carlos-tzin/tzin/log`**
```ts
import { log } from '@carlos-tzin/tzin/log'

const handler = impl(getUser, async ({ params, ctx }) => {
  log.info('Fetching user', { id: params.id })
  const user = await db.getUser(params.id)
  log.debug('User found', { user })
  return { status: 200 as const, body: user }
})
```

## Orden de implementación

1. **Project structure + config** — convenciones claras
2. **Testing utilities** — validar contratos
3. **CLI mejorado** — dev, generate, build
4. **Database** — integración básica
5. **Auth** — patrones comunes
6. **Jobs** — background tasks
7. **Logging** — observabilidad

Cada fase es un release minor (1.1.0, 1.2.0, etc.)
