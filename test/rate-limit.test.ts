import { describe, it, expect, vi, beforeEach } from 'vitest'
import { t } from '../src/schema.js'
import { contract, impl, createApp } from '../src/index.js'
import {
  rateLimit,
  strictRateLimit,
  createRateLimiter,
  getRateLimitInfo,
} from '../src/rate-limit.js'
import type { App } from '../src/index.js'
import type { RateLimitStore } from '../src/rate-limit.js'

const fetchIt = (app: App, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://test${path}`, init))

const ping = contract({
  method: 'GET',
  path: '/ping',
  responses: { 200: t.Object({ ok: t.Boolean() }) },
})

const pingRoute = impl(ping, async () => ({ status: 200 as const, body: { ok: true } }))

describe('rateLimit', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('allows max requests then returns 429 with Retry-After', async () => {
    const app = createApp([pingRoute], {
      middleware: [rateLimit({ max: 2, windowMs: 60_000 })],
    })

    const r1 = await fetchIt(app, '/ping')
    expect(r1.status).toBe(200)
    expect(r1.headers.get('x-ratelimit-limit')).toBe('2')
    expect(r1.headers.get('x-ratelimit-remaining')).toBe('1')
    expect(Number(r1.headers.get('x-ratelimit-reset'))).toBeGreaterThan(0)

    const r2 = await fetchIt(app, '/ping')
    expect(r2.status).toBe(200)
    expect(r2.headers.get('x-ratelimit-remaining')).toBe('0')

    const r3 = await fetchIt(app, '/ping')
    expect(r3.status).toBe(429)
    expect(r3.headers.get('retry-after')).toBeDefined()
    const body = (await r3.clone().json()) as { error: string }
    expect(body.error).toBe('Too many requests')
  })

  it('keys clients by x-forwarded-for by default', async () => {
    const app = createApp([pingRoute], {
      middleware: [rateLimit({ max: 1, windowMs: 60_000 })],
    })

    const fromA = (init?: RequestInit) =>
      fetchIt(app, '/ping', { headers: { 'x-forwarded-for': '10.0.0.1', ...(init?.headers ?? {}) }, ...init })

    expect((await fromA()).status).toBe(200)
    expect((await fromA()).status).toBe(429)
    expect((await fromA()).status).toBe(429)

    // a different client is not limited
    const fromB = fetchIt(app, '/ping', { headers: { 'x-forwarded-for': '10.0.0.2' } })
    expect((await fromB).status).toBe(200)
  })

  it('honours a custom keyGenerator', async () => {
    const app = createApp([pingRoute], {
      middleware: [
        rateLimit({
          max: 1,
          windowMs: 60_000,
          keyGenerator: (req) => req.headers.get('x-api-key') ?? 'anon',
        }),
      ],
    })

    const asUser = (key: string) => fetchIt(app, '/ping', { headers: { 'x-api-key': key } })
    expect((await asUser('ada')).status).toBe(200)
    expect((await asUser('ada')).status).toBe(429)
    expect((await asUser('grace')).status).toBe(200)
  })

  it('skip() exempts requests', async () => {
    const app = createApp([pingRoute], {
      middleware: [
        rateLimit({ max: 1, windowMs: 60_000, skip: (req) => req.headers.get('x-skip') === '1' }),
      ],
    })

    expect((await fetchIt(app, '/ping')).status).toBe(200)
    expect((await fetchIt(app, '/ping')).status).toBe(429)
    expect((await fetchIt(app, '/ping', { headers: { 'x-skip': '1' } })).status).toBe(200)
  })

  it('uses a custom onLimitReached response', async () => {
    const app = createApp([pingRoute], {
      middleware: [
        rateLimit({
          max: 1,
          windowMs: 60_000,
          onLimitReached: (_req, retryAfter) =>
            new Response(JSON.stringify({ blocked: true, retryAfter }), {
              status: 403,
              headers: { 'content-type': 'application/json' },
            }),
        }),
      ],
    })

    expect((await fetchIt(app, '/ping')).status).toBe(200)
    const r2 = await fetchIt(app, '/ping')
    expect(r2.status).toBe(403)
    expect((await r2.clone().json()) as { blocked: boolean }).toEqual({ blocked: true, retryAfter: expect.any(Number) })
  })

  it('headers:false omits rate-limit headers but still limits', async () => {
    const app = createApp([pingRoute], {
      middleware: [rateLimit({ max: 1, windowMs: 60_000, headers: false })],
    })

    expect((await fetchIt(app, '/ping')).status).toBe(200)
    expect((await fetchIt(app, '/ping')).headers.get('x-ratelimit-limit')).toBeNull()
    expect((await fetchIt(app, '/ping')).status).toBe(429)
  })

  it('resets the counter once the window expires', async () => {
    vi.useFakeTimers()
    const app = createApp([pingRoute], {
      middleware: [rateLimit({ max: 1, windowMs: 60_000 })],
    })

    expect((await fetchIt(app, '/ping')).status).toBe(200)
    expect((await fetchIt(app, '/ping')).status).toBe(429)

    vi.advanceTimersByTime(61_000)

    expect((await fetchIt(app, '/ping')).status).toBe(200)
  })

  it('works with a custom store', async () => {
    const store: RateLimitStore = {
      get: vi.fn(() => null),
      increment: vi.fn(() => ({ count: 1, resetTime: Date.now() + 60_000 })),
      decrement: vi.fn(),
      reset: vi.fn(),
    }
    const app = createApp([pingRoute], {
      middleware: [rateLimit({ max: 5, windowMs: 60_000, store })],
    })

    const res = await fetchIt(app, '/ping')
    expect(res.status).toBe(200)
    expect(store.increment).toHaveBeenCalledTimes(1)
    expect(store.decrement).not.toHaveBeenCalled()
  })
})

describe('strictRateLimit', () => {
  it('defaults to max 5 and a 15 minute window', async () => {
    const app = createApp([pingRoute], { middleware: [strictRateLimit()] })

    for (let i = 0; i < 5; i++) {
      expect((await fetchIt(app, '/ping')).status).toBe(200)
    }
    expect((await fetchIt(app, '/ping')).status).toBe(429)
  })
})

describe('createRateLimiter', () => {
  it('delegates to rateLimit', async () => {
    const app = createApp([pingRoute], {
      middleware: [createRateLimiter({ max: 1, windowMs: 60_000, endpoint: 'ping' })],
    })

    expect((await fetchIt(app, '/ping')).status).toBe(200)
    expect((await fetchIt(app, '/ping')).status).toBe(429)
  })
})

describe('getRateLimitInfo', () => {
  it('parses headers into info', () => {
    const res = new Response('', {
      headers: {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '42',
        'x-ratelimit-reset': '1700000000',
        'retry-after': '3',
      },
    })
    expect(getRateLimitInfo(res)).toEqual({
      limit: 100,
      remaining: 42,
      resetTime: 1700000000000,
      retryAfter: 3,
    })
  })

  it('returns null when headers are missing', () => {
    expect(getRateLimitInfo(new Response(''))).toBeNull()
  })
})