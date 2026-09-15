import type { AnyContract, StaticOf, SectionsOf } from './contract.js'

/**
 * One union member per declared response status: checking `res.status === 200`
 * narrows `body` to exactly what the contract promised. The client trusts the
 * contract completely — an undeclared status is a contract violation.
 */
export type ClientResult<C extends AnyContract> = {
  [K in keyof C['responses']]: {
    status: K extends number ? K : K extends `${infer N extends number}` ? N : never
    body: StaticOf<C['responses'][K]>
  }
}[keyof C['responses']]

export type CallerFn<C extends AnyContract> = (
  input: SectionsOf<C> & { fetchInit?: RequestInit },
) => Promise<ClientResult<C>>

/** Flat mapped type over a record of contracts: O(routes), no nesting. */
export type ClientOf<Routes extends Record<string, AnyContract>> = {
  [K in keyof Routes]: CallerFn<Routes[K]>
}

/** Runtime shape of a client call argument, given contracts are untyped at runtime. */
interface ClientInput {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
  headers?: Record<string, string>
  cookies?: Record<string, unknown>
  fetchInit?: RequestInit
}

export function client<Routes extends Record<string, AnyContract>>(
  routes: Routes,
  baseUrl = '',
): ClientOf<Routes> {
  return new Proxy({} as ClientOf<Routes>, {
    get(_target, key: string | symbol) {
      if (typeof key !== 'string' || !(key in routes)) return undefined
      const c = routes[key]
      return async (input: ClientInput = {}) => {
        let path = c.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name) =>
          encodeURIComponent(String(input.params?.[name] ?? `{${name}}`)),
        )
        if (input.query) {
          const qs = new URLSearchParams(
            Object.entries(input.query).map(([k, v]) => [k, String(v)]),
          ).toString()
          if (qs) path += `?${qs}`
        }
        const init: RequestInit = { method: c.method, ...input.fetchInit }
        if ('body' in c && c.body) init.body = JSON.stringify(input.body)
        const headers: Record<string, string> = { ...input.headers }
        if (input.cookies) {
          headers.cookie = Object.entries(input.cookies)
            .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
            .join('; ')
        }
        init.headers = { ...init.headers, ...headers }
        const res = await fetch(baseUrl + path, init)
        let body: unknown
        try {
          body = await res.json()
        } catch {
          body = null
        }
        return { status: res.status, body }
      }
    },
  })
}
