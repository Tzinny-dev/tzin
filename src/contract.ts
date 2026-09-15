import type { Static, TSchema } from './schema.js'
import type { Ctx } from './context.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/**
 * A Contract is the single source of truth for an endpoint.
 * Plain object literal -> shallow types -> no deep instantiation.
 */
export interface ContractDef {
  method: HttpMethod
  path: string
  /** Stable identifier reused by OpenAPI operationId and MCP tool name. */
  name?: string
  /** Human/agent-readable summary, surfaced in OpenAPI and MCP. */
  description?: string
  params?: TSchema
  query?: TSchema
  body?: TSchema
  responses: Record<number, TSchema>
}

/** Identity function with `const` generics: preserves literal method/path/status keys. */
export function contract<const C extends ContractDef>(def: C): C {
  return def
}

export type AnyContract = ContractDef

/* ------------------------------------------------------------------ */
/* Type-level derivation (all shallow: indexed access, no recursion   */
/* over route chains -> constant cost per endpoint)                   */
/* ------------------------------------------------------------------ */

export type StaticOf<S> = S extends TSchema ? Static<S> : never

/** '/users/:id/posts/:postId' -> 'id' | 'postId' */
export type PathParamNames<P extends string> =
  P extends `${string}:${infer Name}/${infer Rest}`
    ? Name | PathParamNames<Rest>
    : P extends `${string}:${infer Name}`
      ? Name
      : never

/**
 * The request sections a contract declares. Shared by server input and
 * client call args so both sides stay in sync.
 */
export type SectionsOf<C extends AnyContract> = ('params' extends keyof C
  ? { params: StaticOf<C['params']> }
  : {}) &
  ('query' extends keyof C ? { query: StaticOf<C['query']> } : {}) &
  ('body' extends keyof C ? { body: StaticOf<C['body']> } : {}) &
  ('headers' extends keyof C ? { headers: StaticOf<C['headers']> } : {}) &
  ('cookies' extends keyof C ? { cookies: StaticOf<C['cookies']> } : {})

/** Extractor-style handler input: declared sections + per-request context. */
export type HandlerInput<C extends AnyContract> = { ctx: Ctx } & SectionsOf<C>

/** Discriminated union of every declared success response. */
export type ResponseOf<C extends AnyContract> = {
  [K in keyof C['responses']]: {
    status: K extends number ? K : K extends `${infer N extends number}` ? N : never
    body: StaticOf<C['responses'][K]>
  }
}[keyof C['responses']]

export type Handler<C extends AnyContract> = (
  input: HandlerInput<C>,
) => ResponseOf<C> | RawResult | Promise<ResponseOf<C> | RawResult>

/** Escape hatch: return a pre-built Response (streaming, files, proxies...). */
export interface RawResult {
  readonly __tzin_raw: Response
}

const RAW_MARKER = '__tzin_raw'

export function raw(res: Response): RawResult {
  return { [RAW_MARKER]: res }
}

export function isRawResult(v: unknown): v is RawResult {
  return typeof v === 'object' && v !== null && RAW_MARKER in v
}

export interface RouteImpl<C extends AnyContract = AnyContract> {
  contract: C
  handler: Handler<C>
}

/** Bind an implementation to a contract. The compiler checks inputs AND outputs. */
export function impl<const C extends AnyContract>(c: C, handler: Handler<C>): RouteImpl<C> {
  return { contract: c, handler }
}

/** A handler's resolved reply with the per-endpoint generics erased. */
export type RouteResult = { status: number; body: unknown } | RawResult

/**
 * A route with its contract generics erased, for heterogeneous registries —
 * `createApp`, OpenAPI/MCP/llms generators, docs tools. Each concrete
 * `RouteImpl<C>` satisfies it (impl keeps inputs/outputs fully typed); the
 * erased handler is only invoked by dispatchers, which supply validated
 * sections via a cast (the `never` input makes accidental direct calls a
 * compile error).
 */
export interface AnyRoute {
  contract: AnyContract
  handler: (input: never) => RouteResult | Promise<RouteResult>
}

/** Thrown inside handlers -> converted to an HTTP error response. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
