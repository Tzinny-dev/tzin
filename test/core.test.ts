import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { t } from '../src/schema.js'
import { contract, impl, HttpError, createApp, generateOpenApi, listen, client, middleware, defineContext, provide } from '../src/index.js'
import { handleMcpMessage, listTools } from '../src/mcp.js'
import { Hub } from '../src/hub.js'
import { Presence } from '../src/presence.js'
import { channelRoutes } from '../src/channels.js'
import type { App } from '../src/index.js'
import { sse } from '../src/sse.js'
import type { Ctx } from '../src/index.js'
import type { ResponseOf, HandlerInput, PathParamNames } from '../src/contract.js'

/* ---------------- domain contracts ---------------- */

const NotFound = t.Object({ error: t.String() })
const ValidationError = t.Object({ error: t.String(), details: t.Optional(t.Array(t.String())) })

const getUser = contract({
  method: 'GET',
  path: '/users/:id',
  name: 'get_user',
  description: 'Look up a user by id',
  params: t.Object({ id: t.String({ minLength: 1 }) }),
  responses: {
    200: t.Object({ id: t.String(), name: t.String(), tags: t.Array(t.String()) }),
    404: NotFound,
  },
})

const listUsers = contract({
  method: 'GET',
  path: '/users',
  query: t.Object({ limit: t.Optional(t.String()), q: t.Optional(t.String()) }),
  responses: {
    200: t.Array(t.Object({ id: t.String() })),
  },
})

const createUser = contract({
  method: 'POST',
  path: '/users',
  body: t.Object({ name: t.String({ minLength: 2 }), email: t.String({ format: 'email' }) }),
  responses: {
    201: t.Object({ id: t.String(), name: t.String() }),
    422: ValidationError,
  },
})

const health = contract({
  method: 'GET',
  path: '/health',
  responses: { 200: t.Literal('ok') },
})

const healthRoute = impl(health, async () => ({ status: 200 as const, body: 'ok' as const }))

const db = new Map<string, { id: string; name: string; email?: string; tags?: string[] }>()
db.set('u1', { id: 'u1', name: 'Ada', tags: ['admin'] })

const routes = [
  healthRoute,
  impl(getUser, async ({ params }) => {
    // extractor-style input is fully typed:
    expectTypeOf(params).toEqualTypeOf<{ id: string }>()
    const user = db.get(params.id)
    if (!user) throw new HttpError(404, 'User not found')
    return {
      status: 200,
      body: { id: user.id, name: user.name, tags: user.tags ?? [] },
    }
  }),
  impl(listUsers, async ({ query }) => {
    expectTypeOf(query).toEqualTypeOf<{ limit?: string; q?: string }>()
    let all = [...db.values()].map((u) => ({ id: u.id }))
    if (query?.q) all = all.filter((u) => u.id.includes(query.q!))
    if (query?.limit) all = all.slice(0, Number(query.limit))
    return { status: 200, body: all }
  }),
  impl(createUser, async ({ body }) => {
    expectTypeOf(body).toEqualTypeOf<{ name: string; email: string }>()
    if (body.email.endsWith('@blocked.com')) throw new HttpError(422, 'Email blocked')
    const id = `u${db.size + 1}`
    db.set(id, { id, ...body })
    return { status: 201, body: { id, name: body.name } }
  }),
]

const app = createApp(routes)
const jsonReq = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://test${path}`, init))

/* ---------------- runtime behaviour ---------------- */

describe('routing & extractors', () => {
  it('GET with path params -> 200', async () => {
    const res = await jsonReq('/users/u1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'u1', name: 'Ada', tags: ['admin'] })
  })

  it('headers and cookies sections extract and validate', async () => {
    const whoami = contract({
      method: 'GET',
      path: '/whoami',
      headers: t.Object({ 'x-api-key': t.String() }),
      cookies: t.Object({ session: t.String() }),
      responses: { 200: t.Object({ key: t.String(), session: t.String() }) },
    })
    const localApp = createApp([
      impl(whoami, async ({ headers, cookies }) => ({
        status: 200 as const,
        body: { key: headers['x-api-key'], session: cookies.session },
      })),
    ])
    const ok = await localApp.fetch(
      new Request('http://x/whoami', { headers: { 'x-api-key': 'k1', cookie: 'session=s9; theme=dark' } }),
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ key: 'k1', session: 's9' })

    const missing = await localApp.fetch(new Request('http://x/whoami'))
    expect(missing.status).toBe(400)
  })

  it('query params flow through', async () => {
    const res = await jsonReq('/users?limit=1&q=u1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 'u1' }])
  })

  it('query params coerce to declared primitive types', async () => {
    const page = contract({
      method: 'GET',
      path: '/page',
      query: t.Object({
        active: t.Optional(t.Boolean()),
        size: t.Optional(t.Number()),
        label: t.Optional(t.String()),
      }),
      responses: {
        200: t.Object({ active: t.Boolean(), size: t.Number(), label: t.String() }),
      },
    })
    const localApp = createApp([
      impl(page, async ({ query }) => ({
        status: 200 as const,
        body: { active: !!query?.active, size: query?.size ?? 0, label: query?.label ?? '' },
      })),
    ])
    const ok = await localApp.fetch(new Request('http://x/page?active=true&size=25&label=a'))
    expect(await ok.json()).toEqual({ active: true, size: 25, label: 'a' })

    // garbage that can't coerce stays a string and fails validation loudly
    const bad = await localApp.fetch(new Request('http://x/page?active=maybe'))
    expect(bad.status).toBe(400)
    expect((await bad.json()).details).toContain('/active: Expected boolean')
  })

  it('POST validates and creates', async () => {
    const res = await jsonReq('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Grace', email: 'grace@dev.io' }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ name: 'Grace' })
  })

  it('rejects invalid body with 400 + details', async () => {
    const res = await jsonReq('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', email: 'nope' }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('Invalid body')
    expect(Array.isArray(data.details)).toBe(true)
  })

  it('HttpError maps to declared status', async () => {
    const res = await jsonReq('/users/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'User not found' })
  })

  it('unknown route -> 404', async () => {
    const res = await jsonReq('/missing')
    expect(res.status).toBe(404)
  })

  it('malformed JSON -> 400', async () => {
    const res = await jsonReq('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    expect(res.status).toBe(400)
  })
})

describe('openapi generation', () => {
  it('emits OpenAPI 3.1 from contracts', () => {
    const doc = generateOpenApi(routes, { title: 'Demo', version: '0.0.0' }) as any
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.paths['/users/{id}'].get.responses['200'].content['application/json'].schema).toBeTruthy()
    expect(doc.paths['/users'].post.requestBody).toBeTruthy()
    expect(doc.paths['/users/{id}'].get.parameters[0].name).toBe('id')
  })

  it('documents header and cookie parameters with honest required flags', () => {
    const whoami = contract({
      method: 'GET',
      path: '/whoami',
      headers: t.Object({ 'x-api-key': t.String(), 'x-trace': t.Optional(t.String()) }),
      cookies: t.Object({ session: t.String() }),
      responses: { 200: t.Object({ ok: t.Boolean() }) },
    })
    const doc = generateOpenApi([impl(whoami, async () => ({ status: 200 as const, body: { ok: true } }))]) as any
    const params = doc.paths['/whoami'].get.parameters
    const byName = Object.fromEntries(params.map((p: any) => [p.name, p]))
    expect(byName['x-api-key']).toMatchObject({ in: 'header', required: true })
    expect(byName['x-trace']).toMatchObject({ in: 'header', required: false })
    expect(byName.session).toMatchObject({ in: 'cookie', required: true })
  })
})

describe('typed client end-to-end', () => {
  it('calls the running server with full inference', async () => {
    const server = await listen(app, 0)
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 3000
    try {
      const api = client(
        { getUser, listUsers, createUser, health },
        `http://127.0.0.1:${port}`,
      )

      const ok = await api.getUser({ params: { id: 'u1' } })
      if (ok.status === 200) {
        expectTypeOf(ok.body).toEqualTypeOf<{ id: string; name: string; tags: string[] }>()
        expect(ok.body.name).toBe('Ada')
      } else if (ok.status === 404) {
        expectTypeOf(ok.body).toEqualTypeOf<{ error: string }>()
      }

      const created = await api.createUser({ body: { name: 'Linus', email: 'l@kernel.org' } })
      expect(created.status).toBe(201)

      const bad = await api.createUser({ body: { name: 'x', email: 'bad' } })
      expect(bad.status).toBe(400)

      const list = await api.listUsers({ query: { limit: '1' } })
      expect(list.status).toBe(200)
      if (list.status === 200) expect(list.body).toHaveLength(1)
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  })

  it('client sends headers and cookies sections', async () => {
    const whoami = contract({
      method: 'GET',
      path: '/whoami',
      headers: t.Object({ 'x-api-key': t.String() }),
      cookies: t.Object({ session: t.String() }),
      responses: { 200: t.Object({ key: t.String(), session: t.String() }) },
    })
    const localApp = createApp([
      impl(whoami, async ({ headers, cookies }) => ({
        status: 200 as const,
        body: { key: headers['x-api-key'], session: cookies.session },
      })),
    ])
    const server = await listen(localApp, 0)
    try {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 3000
      const api = client({ whoami }, `http://127.0.0.1:${port}`)
      const res = await api.whoami({ headers: { 'x-api-key': 'k1' }, cookies: { session: 's9' } })
      expect(res.status).toBe(200)
      if (res.status === 200) expect(res.body).toEqual({ key: 'k1', session: 's9' })
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  })
})

/* ---------------- type-level guarantees ---------------- */

describe('contract types', () => {
  it('parses path param names', () => {
    expectTypeOf<PathParamNames<'/users/:id/posts/:postId'>>().toEqualTypeOf<'id' | 'postId'>()
  })

  it('derives response union from declared statuses', () => {
    expectTypeOf<ResponseOf<typeof getUser>>().toEqualTypeOf<
      { status: 200; body: { id: string; name: string; tags: string[] } } | { status: 404; body: { error: string } }
    >()
  })

  it('input only exposes what the contract declares', () => {
    expectTypeOf<HandlerInput<typeof health>>().toEqualTypeOf<{ ctx: Ctx }>()
    expectTypeOf<HandlerInput<typeof getUser>['params']>().toEqualTypeOf<{ id: string }>()
  })
})

describe('middleware', () => {
  const user = defineContext<{ userId: string }>('user')

  const auth = middleware(async ({ req, ctx, next }) => {
    const token = req.headers.get('authorization')
    if (!token) throw new HttpError(401, 'unauthorized')
    ctx.set(user, { userId: `u-${token}` })
    return next()
  })

  const tracer = middleware(async ({ next }) => {
    const res = await next()
    return new Response(res.body, { status: res.status, headers: { 'x-traced': 'yes' } })
  })

  const whoami = contract({
    method: 'GET',
    path: '/whoami',
    responses: {
      200: t.Object({ userId: t.String() }),
      401: t.Object({ error: t.String() }),
    },
  })

  it('runs onion-style in registration order', async () => {
    const order: string[] = []
    const a = middleware(async ({ next }) => {
      order.push('a-pre')
      const res = await next()
      order.push('a-post')
      return res
    })
    const b = middleware(async ({ next }) => {
      order.push('b-pre')
      const res = await next()
      order.push('b-post')
      return res
    })

    const app = createApp([healthRoute], { middleware: [a, b] })
    await app.fetch(new Request('http://x/health'))

    expect(order).toEqual(['a-pre', 'b-pre', 'b-post', 'a-post'])
  })

  it('short-circuits before the handler when auth fails', async () => {
    let handlerRan = false
    const route = impl(whoami, async ({ ctx }) => {
      handlerRan = true
      return { status: 200, body: ctx.require(user) }
    })

    const app = createApp([route], { middleware: [auth] })
    const res = await app.fetch(new Request('http://x/whoami'))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', details: undefined })
    expect(handlerRan).toBe(false)
  })

  it('shares typed context from middleware to handler', async () => {
    const route = impl(whoami, async ({ ctx }) => ({
      status: 200,
      body: { userId: ctx.require(user).userId },
    }))

    const app = createApp([route], { middleware: [tracer, auth] })
    const res = await app.fetch(
      new Request('http://x/whoami', { headers: { authorization: 'secret' } }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: 'u-secret' })
    expect(res.headers.get('x-traced')).toBe('yes')
  })

  it('require() on missing context is a 500', async () => {
    const noAuth = impl(whoami, async ({ ctx }) => ({ status: 200, body: ctx.require(user) }))
    const app = createApp([noAuth])
    const res = await app.fetch(new Request('http://x/whoami'))

    expect(res.status).toBe(500)
  })

  it('rejects double next()', async () => {
    const double = middleware(async ({ next }) => {
      await next()
      return next()
    })
    const app = createApp([healthRoute], { middleware: [double] })
    const res = await app.fetch(new Request('http://x/health'))

    expect(res.status).toBe(500)
  })
})

describe('streaming', () => {
  const events = contract({
    method: 'GET',
    path: '/events',
    responses: { 200: t.Object({ ok: t.Boolean() }) },
  })

  it('streams server-sent events through a raw response', async () => {
    const route = impl(events, async () =>
      sse(async (send) => {
        send.event('ping', { n: 1 })
        send.comment('keep-alive')
        send.event('done', { ok: true })
      }),
    )
    const app = createApp([route])
    const res = await app.fetch(new Request('http://x/events'))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }

    expect(text).toContain('event: ping\ndata: {"n":1}\n\n')
    expect(text).toContain(': keep-alive\n\n')
    expect(text).toContain('event: done\ndata: {"ok":true}\n\n')
  })
})

describe('dependency injection', () => {
  interface Counter {
    count(): number
  }
  const counter = defineContext<Counter>('counter')
  const countFn = vi.fn((): number => 1)
  const instance: Counter = { count: countFn }

  const stats = contract({
    method: 'GET',
    path: '/stats',
    responses: { 200: t.Object({ n: t.Number() }) },
  })

  it('provides app-scoped singletons to handlers, typed', async () => {
    let calls = 0
    const route = impl(stats, async ({ ctx }) => {
      expectTypeOf(ctx.require(counter)).toEqualTypeOf<Counter>()
      calls++
      return { status: 200, body: { n: ctx.require(counter).count() } }
    })

    const app = createApp([route], { provides: [provide(counter, instance)] })
    await app.fetch(new Request('http://x/stats'))
    await app.fetch(new Request('http://x/stats'))

    expect(calls).toBe(2)
    expect(countFn).toHaveBeenCalledTimes(2)
  })

  it('middleware may overwrite a provided seed (request scope wins)', async () => {
    const override = middleware(async ({ ctx, next }) => {
      ctx.set(counter, { count: () => 42 })
      return next()
    })
    const route = impl(stats, async ({ ctx }) => ({
      status: 200,
      body: { n: ctx.require(counter).count() },
    }))

    const app = createApp([route], {
      middleware: [override],
      provides: [provide(counter, instance)],
    })
    const res = await app.fetch(new Request('http://x/stats'))

    expect(await res.json()).toEqual({ n: 42 })
  })
})

describe('MCP', () => {
  const mcpUser = contract({
    name: 'find_user',
    description: 'Find a user by id',
    method: 'GET',
    path: '/mcp-users/:id',
    params: t.Object({ id: t.String() }),
    responses: {
      200: t.Object({ id: t.String(), name: t.String() }),
      404: t.Object({ error: t.String() }),
    },
  })

  const mcpCreate = contract({
    method: 'POST',
    path: '/mcp-users',
    body: t.Object({ name: t.String() }),
    responses: { 201: t.Object({ ok: t.Boolean() }) },
  })

  function mcpApp(): App {
    return createApp(
      [
        impl(mcpUser, async ({ params }) => ({
          status: 200 as const,
          body: { id: params.id, name: `user-${params.id}` },
        })),
        impl(mcpCreate, async () => ({ status: 201 as const, body: { ok: true } })),
      ],
      { middleware: [middleware(async ({ next }) => next())] },
    )
  }

  it('initialize handshake', async () => {
    const res = await handleMcpMessage(mcpApp(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    })

    expect(res?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'tzin' },
      capabilities: { tools: {} },
    })
  })

  it('tools/list exposes contracts as JSON Schema tools', async () => {
    const res = await handleMcpMessage(mcpApp(), { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (res?.result as { tools: Record<string, unknown>[] }).tools

    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({
      name: 'find_user',
      description: 'Find a user by id',
    })
    expect(tools[0].inputSchema).toEqual({
      type: 'object',
      properties: { params: expect.objectContaining({ type: 'object' }) },
      required: ['params'],
    })
    expect(tools[1].name).toBe('post_mcp_users')
  })

  it('tools/call dispatches in-process through the full app', async () => {
    const res = await handleMcpMessage(mcpApp(), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'find_user', arguments: { params: { id: 'u9' } } },
    })
    const result = res?.result as { content: { text: string }[]; isError?: boolean }

    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'u9', name: 'user-u9' })
  })

  it('tools/call surfaces HTTP errors as isError', async () => {
    const missing = contract({
      method: 'GET',
      path: '/missing/:id',
      params: t.Object({ id: t.String() }),
      responses: {
        200: t.Object({ id: t.String() }),
        404: t.Object({ error: t.String() }),
      },
    })
    const failing = createApp([
      impl(missing, async ({ params }) => {
        throw new HttpError(404, `no user ${params.id}`)
      }),
    ])
    const [tool] = listTools(failing.routes) as { name: string }[]

    const res = await handleMcpMessage(failing, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: tool.name, arguments: { params: { id: 'x' } } },
    })
    const result = res?.result as { isError?: boolean; content: { text: string }[] }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('HTTP 404')
  })

  it('unknown tool and unknown method are protocol errors', async () => {
    const badTool = await handleMcpMessage(mcpApp(), {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })
    expect((badTool?.result as { isError?: boolean }).isError).toBe(true)

    const badMethod = await handleMcpMessage(mcpApp(), {
      jsonrpc: '2.0',
      id: 6,
      method: 'wat/unknown',
    })
    expect((badMethod?.error as { code: number }).code).toBe(-32601)

    expect(await handleMcpMessage(mcpApp(), { method: 'notifications/initialized' })).toBeNull()
  })
})

describe('realtime channels', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function readEvents(res: Response, maxMs = 500): Promise<{ event: string; data: unknown }[]> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const events: { event: string; data: unknown }[] = []
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      const chunk = await Promise.race<ReadableStreamReadResult<Uint8Array> | undefined>([
        reader.read(),
        sleep(maxMs).then(() => undefined),
      ])
      if (!chunk || chunk.done) break
      buf += decoder.decode(chunk.value)
      for (const frame of buf.split('\n\n')) {
        const ev = /^event: (.+)$/m.exec(frame)
        const da = /^data: (.+)$/m.exec(frame)
        if (ev) events.push({ event: ev[1], data: da ? JSON.parse(da[1]) : null })
      }
      buf = buf.endsWith('\n\n') ? '' : (buf.split('\n\n').pop() ?? '')
    }
    reader.cancel().catch(() => {})
    return events
  }

  it('publish reaches SSE subscribers; abort cleans up', async () => {
    const hub = new Hub()
    const app = createApp(channelRoutes(hub))
    const ac = new AbortController()

    const sub = app.fetch(
      new Request('http://x/channels/room1?member=alice', { signal: ac.signal }),
    )
    await sleep(10)

    const pub = await app.fetch(
      new Request('http://x/channels/room1', {
        method: 'POST',
        body: JSON.stringify({ event: 'chat', data: { text: 'hola' } }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(await pub.json()).toEqual({ delivered: 1 })

    const events = await Promise.all([readEvents(await sub), sleep(60)]).then(([e]) => e)
    expect(events).toContainEqual({ event: 'chat', data: { text: 'hola' } })

    expect(hub.subscriberCount('room1')).toBe(1)
    ac.abort()
    await sleep(5)
    expect(hub.subscriberCount('room1')).toBe(0)
  })

  it('presence tracks join/leave and broadcasts state + diffs', async () => {
    const hub = new Hub()
    const presence = new Presence(hub, 1000)
    presence.startSweeping(50)
    const app = createApp(channelRoutes(hub, { presence }))
    const ac = new AbortController()

    const seen: string[] = []
    hub.subscribe('room2', (e) => seen.push(e.event))

    const sub = app.fetch(
      new Request('http://x/channels/room2?member=alice', { signal: ac.signal }),
    )
    await sleep(20)
    await app.fetch(
      new Request('http://x/channels/room2/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ member: 'bob', meta: { device: 'phone' } }),
        headers: { 'content-type': 'application/json' },
      }),
    )

    const snap = presence.snapshot('room2').map((m) => m.member).sort()
    expect(snap).toEqual(['alice', 'bob'])

    ac.abort()
    await sleep(10)
    expect(presence.snapshot('room2').map((m) => m.member)).toEqual(['bob'])
    expect(seen).toContain('presence_state')
    expect(seen).toContain('presence_diff')

    presence.stopSweeping()
    void sub
  })

  it('TTL sweep removes ghost members with a diff', async () => {
    const hub = new Hub()
    const presence = new Presence(hub, 30)
    presence.startSweeping(10)
    const diffs: unknown[] = []
    hub.subscribe('ghosts', (e) => {
      if (e.event === 'presence_diff') diffs.push(e.data)
    })

    presence.join('ghosts', 'casper')
    expect(presence.snapshot('ghosts')).toHaveLength(1)
    await sleep(80)
    expect(presence.snapshot('ghosts')).toHaveLength(0)
    expect(diffs).toContainEqual({ leaves: ['casper'] })
    presence.stopSweeping()
  })
})

describe('router trie', () => {  const r = (path: string, method = 'GET', tag = path) =>
    impl(
      contract({ method: method as never, path, responses: { 200: t.Object({ route: t.String() }) } }),
      async () => ({ status: 200 as const, body: { route: tag } }),
    )

  it('static segments win over dynamic ones', async () => {
    const app = createApp([r('/users/:id', 'GET', 'dynamic'), r('/users/me', 'GET', 'static')])
    const me = await app.fetch(new Request('http://x/users/me'))
    const other = await app.fetch(new Request('http://x/users/42'))

    expect(await me.json()).toEqual({ route: 'static' })
    expect(await other.json()).toEqual({ route: 'dynamic' })
  })

  it('same path, different methods route independently', async () => {
    const app = createApp([
      r('/things', 'GET', 'list'),
      r('/things', 'POST', 'create'),
      r('/things/:id', 'DELETE', 'remove'),
    ])

    expect((await app.fetch(new Request('http://x/things'))).status).toBe(200)
    expect((await app.fetch(new Request('http://x/things', { method: 'POST' }))).status).toBe(200)
    const del = await app.fetch(new Request('http://x/things/9', { method: 'DELETE' }))
    expect(await del.json()).toEqual({ route: 'remove' })
    const wrong = await app.fetch(new Request('http://x/things/9'))
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('DELETE')
  })

  it('nested params and first-registration tiebreak', async () => {
    const app = createApp([
      r('/a/:x/b/:y', 'GET', 'nested'),
      r('/dup', 'GET', 'first'),
      r('/dup', 'GET', 'second'),
    ])
    const nested = await app.fetch(new Request('http://x/a/1/b/2'))
    expect(nested.status).toBe(200)
    expect(await app.fetch(new Request('http://x/dup')).then((res) => res.json())).toEqual({
      route: 'first',
    })

    const input = await app.fetch(new Request('http://x/a/%20/b/2'))
    expect(input.status).toBe(200)
  })

  it('trailing slash matches the same node', async () => {
    const app = createApp([r('/slashed', 'GET', 'yes')])
    expect((await app.fetch(new Request('http://x/slashed/'))).status).toBe(200)
    expect((await app.fetch(new Request('http://x/unmatched'))).status).toBe(404)
  })

  it('known path, unknown method -> 405 with Allow header; unknown path -> 404', async () => {
    const app = createApp([r('/things', 'GET'), r('/things', 'POST')])
    const res = await app.fetch(new Request('http://x/things', { method: 'DELETE' }))
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, POST')
    expect(await res.json()).toEqual({ error: 'Method Not Allowed', details: undefined })
    expect((await app.fetch(new Request('http://x/nope'))).status).toBe(404)
  })

  it('prefix of another route is 404 even though the node exists', async () => {
    const app = createApp([r('/users/:id/posts', 'GET')])
    expect((await app.fetch(new Request('http://x/users/1'))).status).toBe(404)
    expect((await app.fetch(new Request('http://x/users/1', { method: 'DELETE' }))).status).toBe(404)
  })

  it('HEAD and OPTIONS served when declared explicitly', async () => {
    const app = createApp([r('/ping', 'HEAD'), r('/ping', 'OPTIONS')])
    expect((await app.fetch(new Request('http://x/ping', { method: 'HEAD' }))).status).toBe(200)
    expect((await app.fetch(new Request('http://x/ping', { method: 'OPTIONS' }))).status).toBe(200)
    expect((await app.fetch(new Request('http://x/ping'))).status).toBe(405)
  })
})

describe('MCP over HTTP', () => {
  const mcpApp = createApp(routes, { mcp: true })

  it('serves initialize, tools/list and tools/call at POST /mcp', async () => {
    const post = (body: unknown) =>
      mcpApp.fetch(
        new Request('http://x/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )

    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(init.status).toBe(200)
    expect((await init.json()).result.serverInfo.name).toBe('tzin')

    const tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const toolNames = (await tools.json()).result.tools.map((tl: { name: string }) => tl.name)
    expect(toolNames).toContain('get_user')
    expect(toolNames).not.toContain('health')

    const call = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_user', arguments: { id: 'u1' } },
    })
    const called = await call.json()
    expect(called.result.isError).toBeUndefined()
    expect(JSON.parse(called.result.content[0].text)).toEqual({ id: 'u1', name: 'Ada', tags: ['admin'] })
  })

  it('notifications -> 202, malformed JSON -> parse error, GET -> 405', async () => {
    const notify = await mcpApp.fetch(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
    )
    expect(notify.status).toBe(202)

    const malformed = await mcpApp.fetch(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      }),
    )
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).error.code).toBe(-32700)

    const get = await mcpApp.fetch(new Request('http://x/mcp'))
    expect(get.status).toBe(405)
  })
})

describe('llms.txt generation', () => {
  const llmsApp = createApp(routes, {
    llms: true,
    meta: { title: 'Demo API', description: 'Users and health.' },
  })

  it('renders an index of endpoints as text/plain', async () => {
    const res = await llmsApp.fetch(new Request('http://x/llms.txt'))
    expect(res.headers.get('content-type')).toContain('text/plain')
    const body = await res.text()
    expect(body).toContain('# Demo API')
    expect(body).toContain('> Users and health.')
    expect(body).toContain('[`GET /users/:id`](get_user)')
    expect(body).toContain(': Look up a user by id')
  })

  it('llms-full.txt embeds the declared JSON Schemas', async () => {
    const res = await llmsApp.fetch(new Request('http://x/llms-full.txt'))
    const body = await res.text()
    expect(body).toContain('### GET /users/:id (get_user)')
    expect(body).toContain('"tags"')
    expect(body).toContain('response 404 schema:')
  })

  it('is off by default', async () => {
    const off = createApp([healthRoute])
    expect((await off.fetch(new Request('http://x/llms.txt'))).status).toBe(404)
    expect((await off.fetch(new Request('http://x/mcp', { method: 'POST' }))).status).toBe(404)
  })
})

describe('openapi.json endpoint', () => {
  const oaApp = createApp(routes, { openapi: true, meta: { title: 'Demo API', version: '1.2.3' } })

  it('serves a valid OpenAPI 3.1 document from contracts', async () => {
    const res = await oaApp.fetch(new Request('http://x/openapi.json'))
    expect(res.headers.get('content-type')).toContain('application/json')
    const doc = (await res.json()) as Record<string, any>
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info.title).toBe('Demo API')
    expect(doc.info.version).toBe('1.2.3')
    const getOp = doc.paths['/users/{id}'].get
    expect(getOp.operationId).toBe('get_user')
    expect(getOp.parameters[0].name).toBe('id')
    expect(getOp.parameters[0].in).toBe('path')
    expect(getOp.responses['200'].content['application/json'].schema.properties.id).toBeDefined()
  })

  it('is off by default', async () => {
    const off = createApp([healthRoute])
    expect((await off.fetch(new Request('http://x/openapi.json'))).status).toBe(404)
  })
})

import { joinChannel } from '../src/client-browser.js'

describe('browser channels client', () => {
  // Minimal EventSource over fetch streaming: enough to exercise the real
  // SSE wire protocol from Node, which has no global EventSource.
  class FetchEventSource {
    #listeners = new Map<string, Set<(ev: { data: string }) => void>>()
    #ctrl = new AbortController()
    constructor(url: string) {
      void (async () => {
        const res = await fetch(url, { signal: this.#ctrl.signal })
        if (!res.body) return
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            let idx: number
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const block = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              let event = 'message'
              const dataLines: string[] = []
              for (const line of block.split('\n')) {
                if (line.startsWith(':')) continue
                if (line.startsWith('event:')) event = line.slice(6).trim()
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
              }
              if (dataLines.length) this.#emit(event, dataLines.join('\n'))
            }
          }
        } catch {
          /* aborted */
        }
      })()
    }
    #emit(type: string, data: string): void {
      const set = this.#listeners.get(type)
      if (set) for (const cb of set) cb({ data })
    }
    addEventListener(type: string, listener: (ev: { data: string }) => void): void {
      let set = this.#listeners.get(type)
      if (!set) {
        set = new Set()
        this.#listeners.set(type, set)
      }
      set.add(listener)
    }
    close(): void {
      this.#ctrl.abort()
    }
  }

  it('receives broadcasts and presence events; heartbeats keep membership alive', async () => {
    vi.useRealTimers()
    const hub = new Hub()
    const presence = new Presence(hub, 400)
    presence.startSweeping(100)
    const app = createApp([...routes, ...channelRoutes(hub, { presence })])
    const server = await listen(app, 0)
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`

    const esOpts = { eventSource: FetchEventSource as unknown as never }
    const ada = joinChannel(base, 'room', { member: 'ada', heartbeatMs: 120, ...esOpts })
    const bob = joinChannel(base, 'room', esOpts)

    const statePromise = new Promise<{ members: { member: string }[] }>((resolve) => {
      ada.on('presence_state', (d) => resolve(d as { members: { member: string }[] }))
    })

    await expect(
      Promise.race([
        statePromise.then((s) => {
          if (!s.members.some((m) => m.member === 'ada')) throw new Error('ada missing')
          return s
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no presence_state')), 2000)),
      ]),
    ).resolves.toBeTruthy()

    const greeted = new Promise<string>((resolve) =>
      bob.on('greet', (d) => resolve((d as { text: string }).text)),
    )
    const pushed = await ada.push('greet', { text: 'hi bob' })
    expect(pushed.delivered).toBeGreaterThan(0)
    await expect(greeted).resolves.toBe('hi bob')

    // Auto-heartbeat keeps ada listed past the TTL (400ms).
    await new Promise((r) => setTimeout(r, 550))
    expect(presence.snapshot('room').some((m) => m.member === 'ada')).toBe(true)

    ada.close()
    await new Promise((r) => setTimeout(r, 150))
    expect(presence.snapshot('room').some((m) => m.member === 'ada')).toBe(false)

    bob.close()
    presence.stopSweeping()
    server.closeAllConnections?.()
    server.close()
  })
})

describe('native websockets', () => {
  it('channels over WS: presence join, broadcast, close -> leave', async () => {
    const { attachChannels } = await import('../src/ws-node.js')
    const { wsChannels } = await import('../src/ws.js')
    const hub = new Hub()
    const presence = new Presence(hub, 30_000)
    const app = createApp([...routes, ...channelRoutes(hub, { presence })])
    const server = await listen(app, 0)
    attachChannels(server, [wsChannels(hub, { presence })])
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    // ada connects with presence
    const ada = new WebSocket(`ws://127.0.0.1:${port}/channels/room?member=ada`)
    ada.onerror = () => ada.close()

    const frames: Record<string, unknown>[] = []
    ada.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)))
    const adaOpen = new Promise((res, rej) => {
      ada.onopen = res
      setTimeout(() => rej(new Error('ada ws open timeout')), 2000)
    })

    // bob subscribes too and waits for ada's greeting
    const bob = new WebSocket(`ws://127.0.0.1:${port}/channels/room`)
    bob.onerror = () => bob.close()
    const greeted = new Promise<string>((resolve) => {
      bob.onmessage = (ev) => {
        const f = JSON.parse(String(ev.data))
        if (f.event === 'greet') resolve(f.data.text)
      }
    })
    await Promise.all([adaOpen, new Promise((res) => (bob.onopen = res))])

    ada.send(JSON.stringify({ type: 'push', event: 'greet', data: { text: 'ws hi' } }))
    await expect(greeted).resolves.toBe('ws hi')

    // presence joined via ?member=
    expect(presence.snapshot('room').some((m) => m.member === 'ada')).toBe(true)

    // heartbeat frame refreshes without error; invalid frames get error reply
    ada.send(JSON.stringify({ type: 'heartbeat' }))
    ada.send('not json')
    await new Promise((r) => setTimeout(r, 50))
    expect(frames.some((f) => (f as { error?: string }).error?.includes('invalid JSON'))).toBe(true)

    // close -> presence leave broadcast
    const leftPromise = new Promise<string[]>((resolve) => {
      bob.onmessage = (ev) => {
        const f = JSON.parse(String(ev.data))
        if (f.event === 'presence_diff') resolve(f.data.leaves)
      }
    })
    ada.close()
    await expect(leftPromise).resolves.toContain('ada')

    bob.close()
    server.closeAllConnections?.()
    server.close()
  })
})

describe('multi-node hubs over a bus', () => {
  it('publish on node1 reaches subscribers on node2; echo is suppressed', async () => {
    const { LocalBus, clusterHubs } = await import('../src/bus.js')
    const bus = new LocalBus()
    const [node1, node2] = clusterHubs(bus, 2)

    const got = new Promise<unknown>((resolve) => {
      node2.subscribe('room', (e) => resolve(e.data))
    })
    const delivered = node1.publish('room', 'chat', { text: 'cross-node' })
    // node1 has no local subscribers; the frame still crossed the bus
    expect(delivered).toBe(0)
    await expect(got).resolves.toEqual({ text: 'cross-node' })

    // own frames don't loop back
    let echoes = 0
    node1.subscribe('room', () => echoes++)
    node1.publish('room', 'ping', null)
    await new Promise((r) => setTimeout(r, 20))
    expect(echoes).toBe(1) // local delivery only
  })

  it('end-to-end: client of node2 receives what a client of node1 publishes', async () => {
    const { LocalBus } = await import('../src/bus.js')
    const bus = new LocalBus()
    const hubA = new Hub({ bus })
    const hubB = new Hub({ bus })

    const appA = createApp([...routes, ...channelRoutes(hubA)])
    const appB = createApp([...routes, ...channelRoutes(hubB)])
    const serverA = await listen(appA, 0)
    const serverB = await listen(appB, 0)
    try {
      const portA = (serverA.address() as { port: number }).port
      const portB = (serverB.address() as { port: number }).port

      // Subscriber on node B.
      const received = new Promise<unknown>((resolve) => {
        hubB.subscribe('lobby', (e) => resolve(e.data))
      })

      const res = await fetch(`http://127.0.0.1:${portA}/channels/lobby`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'chat', data: { msg: 'from A to B' } }),
      })
      expect(res.status).toBe(200)
      await expect(received).resolves.toEqual({ msg: 'from A to B' })
    } finally {
      serverA.closeAllConnections?.()
      serverA.close()
      serverB.closeAllConnections?.()
      serverB.close()
    }
  })

  it('presence replicates: every node holds the full view', async () => {
    const { LocalBus } = await import('../src/bus.js')
    const bus = new LocalBus()
    const presA = new Presence(new Hub({ bus }))
    const hubB = new Hub({ bus })
    const presB = new Presence(hubB)

    presA.join('room', 'ada', { device: 'phone' })

    // node B holds the replica without any local activity on that topic
    const replica = presB.snapshot('room')
    expect(replica.map((m) => m.member)).toEqual(['ada'])
    expect(replica[0].meta).toEqual({ device: 'phone' })
    expect(typeof replica[0].onlineAt).toBe('number')

    // a join on B now broadcasts COMPLETE cluster state, not just B's locals
    const seen = new Promise<{ members: { member: string }[] }>((resolve) => {
      hubB.subscribe('room', (e) => {
        if (e.event === 'presence_state') resolve(e.data as { members: { member: string }[] })
      })
    })
    presB.join('room', 'bob')
    const state = await seen
    expect(state.members.map((m) => m.member).sort()).toEqual(['ada', 'bob'])
  })

  it('ghosts expire on surviving nodes when their origin node dies', async () => {
    const { LocalBus } = await import('../src/bus.js')
    const bus = new LocalBus()
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    // node A tracks with a short TTL but "crashes": its sweeper never runs again
    const presA = new Presence(new Hub({ bus }), 40)
    const presB = new Presence(new Hub({ bus }), 30)
    presB.startSweeping(10)

    presA.join('room', 'casper')
    expect(presB.snapshot('room')).toHaveLength(1)

    await sleep(80)
    // B stops seeing heartbeats -> its own sweep expires the replica
    expect(presB.snapshot('room')).toHaveLength(0)
    presB.stopSweeping()
  })

  it('e2e: subscribing on node B gets node A members in the initial presence_state', async () => {
    const { LocalBus } = await import('../src/bus.js')
    const bus = new LocalBus()
    const hubA = new Hub({ bus })
    const hubB = new Hub({ bus })
    const presA = new Presence(hubA)
    const presB = new Presence(hubB)

    const appA = createApp(channelRoutes(hubA, { presence: presA }))
    const appB = createApp(channelRoutes(hubB, { presence: presB }))
    const serverA = await listen(appA, 0)
    const serverB = await listen(appB, 0)
    const parseFrame = (frame: string) => ({
      event: /^event: (.+)$/m.exec(frame)?.[1] ?? '',
      data: (() => {
        try {
          return JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? '')
        } catch {
          return null
        }
      })(),
    })

    try {
      const portA = (serverA.address() as { port: number }).port
      const portB = (serverB.address() as { port: number }).port

      // ada joins through node A
      await fetch(`http://127.0.0.1:${portA}/channels/lobby/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ member: 'ada', meta: { city: 'lima' } }),
      })

      // bob subscribes on node B: first event is the replicated cluster state
      const res = await fetch(`http://127.0.0.1:${portB}/channels/lobby?member=bob`)
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (!buf.includes('\n\n')) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 1000)),
        ])
        if (!chunk || chunk.done) break
        buf += decoder.decode(chunk.value)
      }
      reader.cancel().catch(() => {})

      const states = buf
        .split('\n\n')
        .map(parseFrame)
        .filter((f) => f.event === 'presence_state')
      // First state (bob's join broadcast) already contains ada — proof that
      // her membership replicated from node A into node B's local view.
      const first = states[0]?.data as { members: { member: string; meta?: unknown }[] }
      expect(first.members.map((m) => m.member).sort()).toEqual(['ada', 'bob'])
      expect(first.members.find((m) => m.member === 'ada')?.meta).toEqual({ city: 'lima' })
    } finally {
      serverA.closeAllConnections?.()
      serverA.close()
      serverB.closeAllConnections?.()
      serverB.close()
    }
  })
})
