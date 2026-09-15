import type { App } from './server.js'
import type { AnyRoute } from './contract.js'

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'tzin', version: '0.1.0' }

/** '/users/:id' -> 'get_users_id' fallback tool name. */
function defaultToolName(c: { method: string; path: string }): string {
  return `${c.method.toLowerCase()}_${c.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
}

/**
 * One endpoint = one MCP tool.
 * The inputSchema is assembled from the contract's declared sections —
 * TypeBox schemas are already JSON Schema, so there is no conversion layer.
 */
export function toTool(route: AnyRoute): Record<string, unknown> {
  const c = route.contract
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const section of ['params', 'query', 'body'] as const) {
    if (section in c && c[section]) {
      properties[section] = c[section]
      if (section !== 'query') required.push(section)
    }
  }

  // Path placeholders without a declared params schema still surface in the
  // tool schema (as strings) so clients know to send them.
  if (!('params' in c && c.params)) {
    const placeholders = [...c.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1])
    if (placeholders.length) {
      properties.params = {
        type: 'object',
        properties: Object.fromEntries(placeholders.map((p) => [p, { type: 'string' }])),
        required: placeholders,
      }
      required.push('params')
    }
  }

  const responseLines = Object.entries(c.responses)
    .map(([status, schema]) => {
      const desc =
        (schema as { description?: string }).description ?? ''
      return `- ${status}${desc ? `: ${desc}` : ''}`
    })
    .join('\n')

  return {
    name: c.name ?? defaultToolName(c),
    ...(c.description ? { description: c.description } : {}),
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    annotations: {
      'x-tzin-method': c.method,
      'x-tzin-path': c.path,
      'x-tzin-responses': responseLines,
    },
  }
}

export function listTools(routes: AnyRoute[]): Record<string, unknown>[] {
  return routes.map(toTool)
}

function sectionProperties(schema: unknown): string[] {
  const props = (schema as { properties?: Record<string, unknown> }).properties
  return props ? Object.keys(props) : []
}

/**
 * Tool arguments arrive nested ({params:{id}}) or flattened at the top level
 * ({id}) — the common MCP client convention. Resolve either shape against the
 * section's declared property names.
 */
function resolveSection(
  args: Record<string, unknown>,
  section: string,
  schema: unknown,
): Record<string, unknown> | undefined {
  const nested = args[section]
  if (nested !== undefined) {
    return typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : undefined
  }
  const flat: Record<string, unknown> = {}
  let found = false
  for (const key of sectionProperties(schema)) {
    if (key in args) {
      flat[key] = args[key]
      found = true
    }
  }
  return found ? flat : undefined
}

async function callTool(app: App, name: string, args: unknown): Promise<Record<string, unknown>> {
  const routes: AnyRoute[] = app.routes
  const route = routes.find((r) => (r.contract.name ?? defaultToolName(r.contract)) === name)

  if (!route) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool '${name}'` }) }],
      isError: true,
    }
  }

  const c = route.contract
  const rawArgs = (args ?? {}) as Record<string, unknown>
  const paramsSchema = 'params' in c ? c.params : undefined
  const querySchema = 'query' in c ? c.query : undefined
  const bodySchema = 'body' in c ? c.body : undefined

  // Path params may arrive even without a declared params schema — resolve
  // them against the route's own :placeholders so the tool stays callable.
  const requiredParams = [...c.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1])
  const params =
    paramsSchema
      ? resolveSection(rawArgs, 'params', paramsSchema)
      : requiredParams.some((k) => k in rawArgs)
        ? Object.fromEntries(requiredParams.filter((k) => k in rawArgs).map((k) => [k, rawArgs[k]]))
        : undefined
  const missing = requiredParams.filter((k) => params?.[k] === undefined)
  if (missing.length) {
    return {
      content: [
        { type: 'text', text: `Missing argument(s): ${missing.map((k) => `params.${k}`).join(', ')}` },
      ],
      isError: true,
    }
  }
  const path = c.path.replace(/:([A-Za-z0-9_]+)/g, (_m: string, key: string) =>
    encodeURIComponent(String(params![key])),
  )

  const query = querySchema ? resolveSection(rawArgs, 'query', querySchema) : undefined
  const qs = query
    ? new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
    : ''
  const fullPath = qs ? `${path}?${qs}` : path

  const body = bodySchema ? resolveSection(rawArgs, 'body', bodySchema) : undefined
  const init: RequestInit = { method: c.method }
  if (body !== undefined) init.body = JSON.stringify(body)

  // In-process dispatch: validation, middleware and DI all apply.
  const res = await app.fetch(new Request(`http://mcp.local${fullPath}`, init))
  const text = await res.text()

  if (!res.ok) {
    return {
      content: [{ type: 'text', text: `HTTP ${res.status}: ${text}` }],
      isError: true,
    }
  }

  return { content: [{ type: 'text', text }] }
}

export interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

/** Handle one MCP JSON-RPC message; returns null for notifications. */
export async function handleMcpMessage(app: App, msg: RpcRequest): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: msg.id ?? null,
    result,
  })
  const error = (code: number, message: string): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: msg.id ?? null,
    error: { code, message },
  })

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    case 'tools/list':
      return reply({ tools: listTools(app.routes) })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const result = await callTool(app, name, msg.params?.arguments)
      return reply(result)
    }
    case 'notifications/initialized':
      return null
    case undefined:
    default:
      if (msg.method?.startsWith('notifications/')) return null
      return error(-32601, `Method not found: ${String(msg.method)}`)
  }
}
