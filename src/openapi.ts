import type { AnyRoute } from './contract.js'

/** '/users/:id' -> '/users/{id}' (OpenAPI syntax) */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

function schemaRefOrInline(schema: unknown): unknown {
  // TypeBox schemas ARE JSON Schema; strip non-JSON symbol-keyed internals via JSON round-trip.
  return JSON.parse(JSON.stringify(schema))
}

/**
 * OpenAPI 3.1 document generated from contracts.
 * Zero conversion layer: TypeBox == JSON Schema == OpenAPI component vocabulary.
 */
export function generateOpenApi(
  routes: AnyRoute[],
  info: { title: string; version: string } = { title: 'API', version: '0.0.0' },
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const { contract: c } of routes) {
    const oaPath = toOpenApiPath(c.path)
    const operation: Record<string, unknown> = {
      operationId:
        c.name ?? `${c.method.toLowerCase()}_${oaPath.replace(/[^A-Za-z0-9]+/g, '_')}`,
      ...(c.description ? { description: c.description } : {}),
      responses: Object.fromEntries(
        Object.entries(c.responses).map(([status, schema]) => [
          status,
          {
            description: `Response ${status}`,
            content: { 'application/json': { schema: schemaRefOrInline(schema) } },
          },
        ]),
      ),
    }

    const parameters: unknown[] = []
    if ('params' in c && c.params) {
      const shape = (c.params as { properties?: Record<string, unknown> }).properties ?? {}
      for (const [name, schema] of Object.entries(shape)) {
        parameters.push({
          name,
          in: 'path',
          required: true,
          schema: schemaRefOrInline(schema),
        })
      }
    }
    if ('query' in c && c.query) {
      const shape = (c.query as { properties?: Record<string, unknown> }).properties ?? {}
      for (const [name, schema] of Object.entries(shape)) {
        parameters.push({ name, in: 'query', required: false, schema: schemaRefOrInline(schema) })
      }
    }
    const isOptionalSchema = (schema: unknown) =>
      (schema as Record<symbol, unknown>)[Symbol.for('TypeBox.Optional')] === 'Optional'
    if ('headers' in c && c.headers) {
      const shape = (c.headers as { properties?: Record<string, unknown> }).properties ?? {}
      for (const [name, schema] of Object.entries(shape)) {
        parameters.push({
          name,
          in: 'header',
          required: !isOptionalSchema(schema),
          schema: schemaRefOrInline(schema),
        })
      }
    }
    if ('cookies' in c && c.cookies) {
      const shape = (c.cookies as { properties?: Record<string, unknown> }).properties ?? {}
      for (const [name, schema] of Object.entries(shape)) {
        parameters.push({
          name,
          in: 'cookie',
          required: !isOptionalSchema(schema),
          schema: schemaRefOrInline(schema),
        })
      }
    }
    if (parameters.length) operation.parameters = parameters

    if ('body' in c && c.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: schemaRefOrInline(c.body) } },
      }
    }

    paths[oaPath] ??= {}
    paths[oaPath][c.method.toLowerCase()] = operation
  }

  return {
    openapi: '3.1.0',
    info,
    paths,
  }
}
