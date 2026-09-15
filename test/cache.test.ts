import { describe, it, expect, vi } from 'vitest'
import { t } from '../src/schema.js'
import { contract, impl, createApp, HttpError } from '../src/index.js'
import { cache, getCacheInfo, invalidateCache, staleWhileRevalidate } from '../src/cache.js'
import type { App } from '../src/index.js'
import type { CacheEntry, CacheStore } from '../src/cache.js'

const fetchIt = (app: App, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://test${path}`, init))

const echo = contract({
  method: 'GET',
  path: '/echo',
  responses: { 200: t.Object({ n: t.Number() }) },
})

/** Routes with a shared counter so tests can observe how often handlers run. */
function countingRoute(count: { n: number }) {
  return impl(echo, async () => ({ status: 200 as const, body: { n: ++count.n } }))
}

type InspectableStore = CacheStore & { entries: () => Map<string, CacheEntry> }

function memoryStore(): InspectableStore {
  const map = new Map<string, CacheEntry>()
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, entry) => void map.set(key, entry),
    delete: (key) => void map.delete(key),
    clear: () => map.clear(),
    entries: () => map,
  }
}

describe('cache middleware', () => {
  it('first request is MISS, second is HIT without re-running the handler', async () => {
    const count = { n: 0 }
    const app = createApp([countingRoute(count)], { middleware: [cache()] })

    const r1 = await fetchIt(app, '/echo')
    expect(r1.status).toBe(200)
    expect(r1.headers.get('x-cache')).toBe('MISS')
    expect((await r1.json()).n).toBe(1)

    const r2 = await fetchIt(app, '/echo')
    expect(r2.headers.get('x-cache')).toBe('HIT')
    expect(Number(r2.headers.get('x-cache-age'))).toBeGreaterThanOrEqual(0)
    expect((await r2.json()).n).toBe(1)
    expect(count.n).toBe(1)
  })

  it('the key includes the query string, so different URLs cache separately', async () => {
    const count = { n: 0 }
    const app = createApp([countingRoute(count)], { middleware: [cache()] })

    const r1 = await fetchIt(app, '/echo?v=a')
    const r2 = await fetchIt(app, '/echo?v=a')
    const r3 = await fetchIt(app, '/echo?v=b')

    expect(r1.headers.get('x-cache')).toBe('MISS')
    expect(r2.headers.get('x-cache')).toBe('HIT')
    expect(r3.headers.get('x-cache')).toBe('MISS')
    expect(await r2.json()).toEqual(await r1.json())
    expect(count.n).toBe(2)
  })

  it('does not cache methods outside the default GET/HEAD set', async () => {
    const count = { n: 0 }
    const submit = contract({
      method: 'POST',
      path: '/submit',
      body: t.Object({ v: t.Number() }),
      responses: { 200: t.Object({ n: t.Number() }) },
    })
    const route = impl(submit, async ({ body }) => ({ status: 200 as const, body: { n: ++count.n + body.v } }))

    const app = createApp([route], {
      middleware: [cache()],
    })

    for (let i = 0; i < 2; i++) {
      const res = await fetchIt(app, '/submit', { method: 'POST', body: JSON.stringify({ v: 1 }) })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-cache')).toBeNull()
    }
    expect(count.n).toBe(2)
  })

  it('only caches statuses in the configured list (default 200)', async () => {
    const created = contract({
      method: 'GET',
      path: '/created',
      responses: { 201: t.Object({ n: t.Number() }) },
    })

    const uncached = { n: 0 }
    const app = createApp([impl(created, async () => ({ status: 201 as const, body: { n: ++uncached.n } }))], {
      middleware: [cache()],
    })
    const r1 = await fetchIt(app, '/created')
    const r2 = await fetchIt(app, '/created')

    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    // not cached: the handler ran for the second request too
    expect(uncached.n).toBe(2)

    const cached = { n: 0 }
    const app2 = createApp([impl(created, async () => ({ status: 201 as const, body: { n: ++cached.n } }))], {
      middleware: [cache({ statuses: [201] })],
    })
    const r3 = await fetchIt(app2, '/created')
    const r4 = await fetchIt(app2, '/created')
    expect(r3.headers.get('x-cache')).toBe('MISS')
    expect(r4.headers.get('x-cache')).toBe('HIT')
    expect((await r4.json()).n).toBe(1)
  })

  it('does not cache errors thrown by the handler', async () => {
    const notFound = contract({
      method: 'GET',
      path: '/missing',
      responses: { 404: t.Object({ error: t.String() }) },
    })
    const route = impl(notFound, async () => {
      throw new HttpError(404, 'nope')
    })
    const app = createApp([route], { middleware: [cache()] })
    const r1 = await fetchIt(app, '/missing')
    const r2 = await fetchIt(app, '/missing')
    expect(r1.status).toBe(404)
    expect(r2.status).toBe(404)
    expect(r1.headers.get('x-cache')).toBeNull()
  })

  it('skip() bypasses the cache', async () => {
    const count = { n: 0 }
    const app = createApp([countingRoute(count)], {
      middleware: [cache({ skip: (req) => req.headers.get('x-skip') === '1' })],
    })

    const r1 = await fetchIt(app, '/echo')
    expect(r1.headers.get('x-cache')).toBe('MISS')

    const r2 = await fetchIt(app, '/echo', { headers: { 'x-skip': '1' } })
    expect(r2.headers.get('x-cache')).toBeNull()
    expect((await r2.json()).n).toBe(2)

    // cached entry from r1 survives the skipped request
    const r3 = await fetchIt(app, '/echo')
    expect(r3.headers.get('x-cache')).toBe('HIT')
    expect((await r3.json()).n).toBe(1)
  })

  it('respects a custom keyGenerator', async () => {
    const count = { n: 0 }
    const app = createApp([countingRoute(count)], {
      middleware: [cache({ keyGenerator: () => 'shared-key' })],
    })

    const r1 = await fetchIt(app, '/echo?v=a')
    const r2 = await fetchIt(app, '/echo?v=b')

    expect(r2.headers.get('x-cache')).toBe('HIT')
    expect(await r2.json()).toEqual(await r1.json())
    expect(count.n).toBe(1)
  })

  it('headers:false still caches but omits cache headers', async () => {
    const count = { n: 0 }
    const app = createApp([countingRoute(count)], {
      middleware: [cache({ headers: false })],
    })

    const r1 = await fetchIt(app, '/echo')
    const r2 = await fetchIt(app, '/echo')

    expect(r1.headers.get('x-cache')).toBeNull()
    expect(r2.headers.get('x-cache')).toBeNull()
    expect((await r2.json()).n).toBe(1)
    expect(count.n).toBe(1)
  })

  it('serves from a custom store', async () => {
    const entry = {
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"n":99}' },
      timestamp: Date.now(),
      ttl: 60_000,
    }
    const store = {
      get: vi.fn(() => entry),
      set: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    }
    const count = { n: 0 }
    const app = createApp([countingRoute(count)], {
      middleware: [cache({ store })],
    })

    const res = await fetchIt(app, '/echo')
    expect(res.headers.get('x-cache')).toBe('HIT')
    expect(await res.json()).toEqual({ n: 99 })
    expect(store.get).toHaveBeenCalledWith('GET:/echo')
    expect(count.n).toBe(0)
  })

  it('writes into a custom store on MISS', async () => {
    const store = memoryStore()
    const count = { n: 0 }
    const app = createApp([countingRoute(count)], { middleware: [cache({ store })] })

    await fetchIt(app, '/echo')
    await fetchIt(app, '/echo')

    expect(store.entries().size).toBe(1)
    const entry = store.entries().get('GET:/echo')
    expect(entry?.response.status).toBe(200)
    expect(entry?.response.body).toBe('{"n":1}')
  })

  it('expires entries once the TTL elapses', async () => {
    vi.useFakeTimers()
    try {
      const count = { n: 0 }
      const app = createApp([countingRoute(count)], {
        middleware: [cache({ ttl: 1000 })],
      })

      const r1 = await fetchIt(app, '/echo')
      expect(r1.headers.get('x-cache')).toBe('MISS')

      vi.advanceTimersByTime(2000)

      const r2 = await fetchIt(app, '/echo')
      expect(r2.headers.get('x-cache')).toBe('MISS')
      expect((await r2.json()).n).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('getCacheInfo', () => {
  it('parses HIT with age', () => {
    const res = new Response('', { headers: { 'x-cache': 'HIT', 'x-cache-age': '5' } })
    expect(getCacheInfo(res)).toEqual({ hit: true, age: 5 })
  })

  it('parses MISS without age', () => {
    const res = new Response('', { headers: { 'x-cache': 'MISS' } })
    expect(getCacheInfo(res)).toEqual({ hit: false, age: undefined })
  })

  it('returns null when no X-Cache header is present', () => {
    expect(getCacheInfo(new Response(''))).toBeNull()
  })
})

describe('staleWhileRevalidate', () => {
  it('serves STALE with a Warning when the entry is past TTL, then revalidates', async () => {
    const count = { n: 0 }
    const store = memoryStore()
    const app = createApp([countingRoute(count)], {
      middleware: [staleWhileRevalidate({ ttl: 1000, staleTtl: 60_000, store })],
    })

    const r1 = await fetchIt(app, '/echo')
    expect(r1.headers.get('x-cache')).toBe('MISS')
    expect(count.n).toBe(1)

    // age the cached entry beyond the TTL
    const key = 'GET:/echo'
    const entry = store.entries().get(key)!
    store.entries().set(key, { ...entry, timestamp: Date.now() - 5000 })

    const r2 = await fetchIt(app, '/echo')
    expect(r2.headers.get('x-cache')).toBe('STALE')
    expect(r2.headers.get('warning')).toContain('stale')
    expect((await r2.json()).n).toBe(1)

    // background revalidation refreshes the entry
    await new Promise((resolve) => setTimeout(resolve, 10))
    const r3 = await fetchIt(app, '/echo')
    expect(r3.headers.get('x-cache')).toBe('HIT')
    expect((await r3.json()).n).toBe(2)
  })

  it('treats entries beyond staleTtl as expired', async () => {
    const count = { n: 0 }
    const store = memoryStore()
    const app = createApp([countingRoute(count)], {
      middleware: [staleWhileRevalidate({ ttl: 1000, staleTtl: 60_000, store })],
    })

    await fetchIt(app, '/echo')
    expect(count.n).toBe(1)

    // An entry past staleTtl has already aged out of the store (real stores
    // drop it on get), so the middleware must re-fetch rather than serve STALE.
    store.entries().clear()

    const r2 = await fetchIt(app, '/echo')
    expect(r2.headers.get('x-cache')).toBe('MISS')
    expect((await r2.json()).n).toBe(2)
  })
})

describe('invalidateCache', () => {
  it('passes the request through and calls the invalidator', async () => {
    const invalidator = vi.fn(() => ['GET:/echo'])
    const count = { n: 0 }
    const app = createApp([countingRoute(count)], {
      middleware: [invalidateCache({ invalidator }), cache()],
    })

    const res = await fetchIt(app, '/echo')
    expect(res.status).toBe(200)
    expect(invalidator).toHaveBeenCalledTimes(1)
    expect(invalidator).toHaveBeenCalledWith(expect.any(Request))
  })

  it('handles the X-Cache-Invalidate header and config keys without erroring', async () => {
    const count = { n: 0 }
    const app = createApp([countingRoute(count)], {
      middleware: [
        invalidateCache({ keys: ['GET:/echo'] }),
        cache(),
      ],
    })

    const res = await fetchIt(app, '/echo', { headers: { 'x-cache-invalidate': 'true' } })
    expect(res.status).toBe(200)
    expect((await res.json()).n).toBe(1)
  })
})