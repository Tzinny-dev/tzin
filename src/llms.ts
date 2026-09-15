import type { AnyRoute } from './contract.js'

export interface ApiMeta {
  title?: string
  description?: string
  version?: string
}

function endpointLines(routes: AnyRoute[]): string[] {
  return routes.map(({ contract: c }) => {
    const name = c.name ?? c.path.replace(/[^A-Za-z0-9]+/g, '_')
    const label = `${c.method} ${c.path}`
    const desc = c.description ? `: ${c.description}` : ''
    return `- [\`${label}\`](${name})${desc}`
  })
}

/** llms.txt: the discoverable, human-readable index of the API. */
export function renderLlmsTxt(routes: AnyRoute[], meta: ApiMeta = {}): string {
  const title = meta.title ?? 'API'
  const summary =
    meta.description ?? `${routes.length} typed endpoints over a shared contract layer.`
  return [
    `# ${title}`,
    '',
    `> ${summary}`,
    '',
    '## Endpoints',
    '',
    ...endpointLines(routes),
    '',
  ].join('\n')
}

/** llms-full.txt: same index plus each endpoint's declared JSON Schemas. */
export function renderLlmsFullTxt(routes: AnyRoute[], meta: ApiMeta = {}): string {
  const head = renderLlmsTxt(routes, meta)
  const blocks = routes.map(({ contract: c }) => {
    const name = c.name ?? c.path.replace(/[^A-Za-z0-9]+/g, '_')
    const lines = [
      `### ${c.method} ${c.path} (${name})`,
      '',
      ...(c.description ? [`${c.description}`, ''] : []),
    ]
    for (const section of ['params', 'query', 'headers', 'cookies', 'body'] as const) {
      const schema = (c as unknown as Record<string, unknown>)[section]
      if (schema) {
        lines.push(`\`${section}\` schema:`, '', '```json', JSON.stringify(schema), '```', '')
      }
    }
    for (const [status, schema] of Object.entries(c.responses)) {
      lines.push(`response ${status} schema:`, '', '```json', JSON.stringify(schema), '```', '')
    }
    return lines.join('\n')
  })
  return `${head}\n## Endpoint details\n\n${blocks.join('\n')}`
}
