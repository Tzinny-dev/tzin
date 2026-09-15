import { Value } from './schema.js'
import { HttpError, isRawResult, type AnyRoute } from './contract.js'
import { createMatcher, type LookupResult, type RouteMatch } from './router.js'
import { Ctx, type ContextKey } from './context.js'
import { compose, type Middleware } from './middleware.js'
import type { ProvidedEntry } from './provide.js'
import { handleMcpMessage } from './mcp.js'
import { renderLlmsTxt, renderLlmsFullTxt, type ApiMeta } from './llms.js'
import { generateOpenApi } from './openapi.js'

export interface App {
  routes: AnyRoute[]
  fetch(req: Request): Promise<Response>
  /**
   * Same dispatch as fetch(), without constructing undici Responses for
   * tzin-built replies (~19µs/request under load). Adapters that can write
   * status/text/headers natively should prefer it.
   */
  dispatchRaw?(req: Request): Promise<RawReply>
}

/**
 * A reply that hasn't been wrapped in an undici Response yet. Either fully
 * materialized (text + headers) or a pass-through Response (raw()/SSE).
 */
export interface RawReply {
  status: number
  /** Pre-serialized body; absent means empty body (e.g. 202). */
  text?: string
  headers?: Record<string, string>
  /** Streaming/raw escape hatch — adapters fall back to Response handling. */
  response?: Response
}

export interface AppOptions {
  middleware?: Middleware[]
  provides?: ProvidedEntry[]
  /** Serve the MCP Streamable HTTP transport at POST /mcp. */
  mcp?: boolean
  /** Serve /llms.txt and /llms-full.txt generated from contracts. */
  llms?: boolean
  /** Serve the OpenAPI 3.1 document at /openapi.json, generated from contracts. */
  openapi?: boolean
  meta?: ApiMeta
}

function validationError(section: string, schema: unknown, value: unknown): HttpError {
  const errors = [...Value.Errors(schema as never, value)].map(
    (e) => `${e.path || '/'}: ${e.message}`,
  )
  return new HttpError(400, `Invalid ${section}`, errors)
}

/**
 * Responses tzin builds itself carry their serialized text alongside, so
 * adapters can write them without draining the undici body stream — the
 * single most expensive step of the over-network path (~7k req/s marginal).
 * User-created responses (raw()) simply fall back to res.text().
 */
const FAST_TEXT = '__tzin_text'

export function fastResponseText(res: Response): string | undefined {
  return (res as unknown as Record<string, unknown>)[FAST_TEXT] as string | undefined
}

/**
 * Responses tzin builds itself also carry their headers as a plain object,
 * so adapters skip undici's Headers iteration entirely on the hot path.
 */
const FAST_HEADERS = '__tzin_headers'

export function fastResponseHeaders(res: Response): Record<string, string> | undefined {
  return (res as unknown as Record<string, unknown>)[FAST_HEADERS] as
    | Record<string, string>
    | undefined
}

/** HTTP statuses that MUST NOT carry a body (1xx, 204, 304). */
function hasBody(status: number): boolean {
  return status !== 204 && status !== 304 && !(status >= 100 && status < 200)
}

const JSON_HEADERS = { 'content-type': 'application/json' }

function jsonFast(body: unknown, status: number): Response {
  const text = hasBody(status) ? JSON.stringify(body) : undefined
  const res = new Response(text ?? null, {
    status,
    ...(text === undefined ? {} : { headers: JSON_HEADERS }),
  })
  if (text !== undefined) {
    const duck = res as unknown as Record<string, unknown>
    duck[FAST_TEXT] = text
    duck[FAST_HEADERS] = JSON_HEADERS
  }
  return res
}

function check(section: string, schema: unknown, value: unknown): void {
  if (!Value.Check(schema as never, value)) throw validationError(section, schema, value)
}

/**
 * URL search params are always strings; declared boolean/number query fields
 * are coerced before validation so contracts can speak real types.
 * Unrecognized values are left as-is and fail validation with a clear error.
 */
function coerceQuery(schema: unknown, raw: Record<string, string>): Record<string, unknown> {
  const props = (schema as { properties?: Record<string, { type?: string | string[] }> }).properties
  if (!props) return raw
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const types = props[key]?.type
    const list = Array.isArray(types) ? types : types ? [types] : []
    if (typeof value === 'string' && list.includes('boolean')) {
      out[key] = value === 'true' ? true : value === 'false' ? false : value
    } else if (typeof value === 'string' && (list.includes('number') || list.includes('integer'))) {
      const n = Number(value)
      out[key] = Number.isNaN(n) ? value : n
    } else {
      out[key] = value
    }
  }
  return out
}

/** Unwrap a Response produced through the middleware path into a RawReply. */
function toRawReply(res: Response): RawReply {
  const fast = fastResponseText(res)
  if (fast === undefined) return { status: res.status, response: res }
  // The FAST_HEADERS snapshot predates any header mutations middleware made
  // after construction (CORS vary/ACAO, rate-limit footers...), so read the
  // live Headers here. Only apps with middleware pay this iteration; the
  // middleware-free hot path never enters this function.
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })
  return { status: res.status, text: fast, headers }
}

/**
 * Adapters may attach a signal factory instead of a real signal so Ctx can
 * stay lazy; real Request objects carry a plain signal.
 */
export function signalSource(req: Request): AbortSignal | (() => AbortSignal | undefined) | undefined {
  const duck = req as unknown as { __tzin_signal_factory?: () => AbortSignal | undefined }
  return duck.__tzin_signal_factory ?? req.signal
}

/**
 * Runtime-agnostic app: pure (req) => res over Web Standards.
 * Testable without a server (app.fetch), adaptable to Node/Bun/Deno/Workers.
 */
function pathnameOf(url: string): string {
  const path = url.slice(url.indexOf('/', url.indexOf('//') + 2))
  const end = path.search(/[?#]/)
  return end === -1 ? path : path.slice(0, end)
}

type HandlerOutcome =
  | { kind: 'raw'; response: Response }
  | { kind: 'json'; status: number; body: unknown }

export function createApp(routes: AnyRoute[], options: AppOptions = {}): App {
  const matchRoute = createMatcher(
    routes.map((r) => ({ method: r.contract.method, path: r.contract.path, route: r })),
  )

  /** Shared validation + handler invocation. Single source for both exits. */
  async function runRoute(hit: RouteMatch<AnyRoute>, req: Request, ctx: Ctx): Promise<HandlerOutcome> {
    const c = hit.route.contract
    const input: Record<string, unknown> = { ctx }

    // Params are always injected (handler types derive them from the path
    // string); validation applies only when a params schema is declared.
    if ('params' in hit && hit.params !== undefined) {
      input.params = hit.params
      if (c.params) check('path params', c.params, hit.params)
    }

    if ('query' in c && c.query) {
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
      const rawQuery = Object.fromEntries(new URLSearchParams(qs))
      const query = coerceQuery(c.query, rawQuery)
      check('query', c.query, query)
      input.query = query
    }

    if ('headers' in c && c.headers) {
      const raw: Record<string, string> = {}
      req.headers.forEach((v, k) => {
        raw[k] = v
      })
      check('headers', c.headers, raw)
      input.headers = raw
    }

    if ('cookies' in c && c.cookies) {
      const rawCookies: Record<string, string> = {}
      for (const part of (req.headers.get('cookie') ?? '').split(';')) {
        const i = part.indexOf('=')
        if (i > 0) rawCookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
      }
      check('cookies', c.cookies, rawCookies)
      input.cookies = rawCookies
    }

    if ('body' in c && c.body) {
      let json: unknown
      try {
        json = await req.json()
      } catch {
        throw new HttpError(400, 'Malformed JSON body')
      }
      check('body', c.body, json)
      input.body = json
    }

    const result = await hit.route.handler(input as never)
    if (isRawResult(result)) return { kind: 'raw', response: result.__tzin_raw }
    return { kind: 'json', status: result.status, body: result.body }
  }

  /**
   * Route lookup memoized by "METHOD pathname". Real traffic repeats URLs
   * constantly (keep-alive clients, polls), so the trie walk + path split +
   * param decode collapse to a Map hit. Bounded: cleared when it exceeds
   * ROUTE_CACHE_MAX so abusive unique-URL traffic can't grow it unbounded.
   */
  const routeCache = new Map<string, LookupResult<AnyRoute>>()
  function cachedMatch(method: string, pathname: string): LookupResult<AnyRoute> {
    const key = `${method} ${pathname}`
    let hit = routeCache.get(key)
    if (hit === undefined) {
      hit = matchRoute(method, pathname)
      if (routeCache.size >= 10_000) routeCache.clear()
      routeCache.set(key, hit)
    }
    return hit
  }

  async function dispatch(req: Request, ctx: Ctx): Promise<Response> {
    const pathname = pathnameOf(req.url)
    const hit = cachedMatch(req.method, pathname)
    if (!hit) throw new HttpError(404, 'Not Found')
    if (!('route' in hit)) {
      throw new HttpError(405, 'Method Not Allowed', undefined, { Allow: hit.allow.join(', ') })
    }
    const out = await runRoute(hit, req, ctx)
    return out.kind === 'raw' ? out.response : jsonFast(out.body, out.status)
  }

  async function rawDispatch(req: Request, ctx: Ctx, pathname: string): Promise<RawReply> {
    const hit = cachedMatch(req.method, pathname)
    if (!hit) throw new HttpError(404, 'Not Found')
    if (!('route' in hit)) {
      throw new HttpError(405, 'Method Not Allowed', undefined, { Allow: hit.allow.join(', ') })
    }
    const out = await runRoute(hit, req, ctx)
    if (out.kind === 'raw') return { status: out.response.status, response: out.response }
    if (!hasBody(out.status)) return { status: out.status }
    return { status: out.status, text: JSON.stringify(out.body), headers: JSON_HEADERS }
  }

  const middleware = options.middleware ?? []
  const handle: (req: Request, ctx: Ctx) => Promise<Response> = middleware.length
    ? compose(middleware, dispatch)
    : dispatch
  const seed = new Map<ContextKey<never>, unknown>(
    options.provides?.map((e) => [e.key, e.value]),
  )
  const hasSeed = seed.size > 0

  async function dispatchRaw(req: Request): Promise<RawReply> {
    const pathname = pathnameOf(req.url)
    try {
      if (options.mcp && pathname === '/mcp') {
        if (req.method !== 'POST') {
          throw new HttpError(405, 'MCP HTTP transport accepts POST only')
        }
        let msg: unknown
        try {
          msg = await req.json()
        } catch {
          return {
            status: 400,
            text: JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            }),
            headers: JSON_HEADERS,
          }
        }
        const reply = await handleMcpMessage(app, msg as never)
        if (!reply) return { status: 202 }
        return { status: 200, text: JSON.stringify(reply), headers: JSON_HEADERS }
      }
      if (options.llms && pathname === '/llms.txt') {
        return {
          status: 200,
          text: renderLlmsTxt(routes, options.meta),
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }
      }
      if (options.llms && pathname === '/llms-full.txt') {
        return {
          status: 200,
          text: renderLlmsFullTxt(routes, options.meta),
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }
      }
      if (options.openapi && pathname === '/openapi.json') {
        return {
          status: 200,
          text: JSON.stringify(
            generateOpenApi(routes, {
              title: options.meta?.title ?? 'API',
              version: options.meta?.version ?? '0.0.0',
            }),
          ),
          headers: JSON_HEADERS,
        }
      }
      const ctx = new Ctx(signalSource(req), hasSeed ? seed : undefined)
      if (middleware.length) return toRawReply(await handle(req, ctx))
      return await rawDispatch(req, ctx, pathname)
    } catch (err) {
      if (err instanceof HttpError) {
        return {
          status: err.status,
          text: JSON.stringify({ error: err.message, details: err.details }),
          headers: err.headers ? { ...JSON_HEADERS, ...err.headers } : JSON_HEADERS,
        }
      }
      console.error(err)
      return { status: 500, text: JSON.stringify({ error: 'Internal Server Error' }), headers: JSON_HEADERS }
    }
  }

  async function fetch(req: Request): Promise<Response> {
    const r = await dispatchRaw(req)
    if (r.response) return r.response
    const res = new Response(r.text ?? null, { status: r.status, headers: r.headers })
    if (r.text !== undefined) {
      const duck = res as unknown as Record<string, unknown>
      duck[FAST_TEXT] = r.text
      duck[FAST_HEADERS] = r.headers
    }
    return res
  }

  const app: App = { routes, fetch, dispatchRaw }
  return app
}
