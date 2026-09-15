import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { App } from './server.js'
import type { AnyRoute } from './contract.js'
import { listen } from './node.js'
import { loadConfig, type TzinConfig } from './config.js'

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function printRouteTable(routes: AnyRoute[]): void {
  console.log(`\ntzin dev · ${routes.length} routes\n`)
  for (const { contract: c } of routes) {
    const method = `\x1b[36m${pad(c.method, 7)}\x1b[0m`
    const name = c.name ? ` \x1b[2m${c.name}\x1b[0m` : ''
    const desc = c.description ? `  \x1b[2m— ${c.description}\x1b[0m` : ''
    console.log(`  ${method} ${pad(c.path, 34)}${name}${desc}`)
  }
  console.log('')
}

// Parse args: entry and --port or positional port
const args = process.argv.slice(2)
const portFlag = args.indexOf('--port')
let port = 3000
let entry = ''

if (portFlag !== -1) {
  port = Number(args[portFlag + 1]) || 3000
  entry = args.filter((_, i) => i !== portFlag && i !== portFlag + 1).find((a) => !a.startsWith('-')) ?? ''
} else {
  const nonFlags = args.filter((a) => !a.startsWith('-'))
  entry = nonFlags[0] ?? ''
  port = nonFlags[1] ? Number(nonFlags[1]) || 3000 : 3000
}

// Load config
const config = loadConfig() ?? {} as TzinConfig

// Auto-detect entry: CLI arg > config > src/app.ts
const entryFile = entry || config.entry || 'src/app.ts'
const entryPath = resolve(entryFile)

if (!existsSync(entryPath)) {
  console.error(`Entry file not found: ${entryPath}`)
  console.error('Create src/app.ts or specify entry with: tzin dev <entry>')
  process.exit(1)
}

const mod = await import(pathToFileURL(entryPath).href)
const app: App | undefined = mod.default ?? mod.app

if (!app || typeof app.fetch !== 'function' || !Array.isArray(app.routes)) {
  console.error('Entry file must export a tzin App (createApp(...))')
  process.exit(1)
}

printRouteTable(app.routes)
listen(app, config.port ?? port)
console.log(`\x1b[32m➜\x1b[0m http://localhost:${config.port ?? port}  (watching for changes)`)
