import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export interface TzinConfig {
  /** Port to listen on (default: 3000) */
  port?: number
  /** Enable OpenAPI at /openapi.json */
  openapi?: boolean
  /** Enable MCP at POST /mcp */
  mcp?: boolean
  /** Enable /llms.txt and /llms-full.txt */
  llms?: boolean
  /** API metadata for OpenAPI/MCP */
  meta?: {
    title?: string
    description?: string
    version?: string
  }
  /** Glob patterns for auto-loading routes */
  routes?: string[]
  /** Glob patterns for auto-loading middleware */
  middleware?: string[]
  /** Entry point for the app (default: src/app.ts) */
  entry?: string
}

const CONFIG_FILES = [
  'tzin.config.ts',
  'tzin.config.js',
  'tzin.config.mjs',
  'tzin.config.json',
]

function findConfigFile(cwd: string): { file: string; path: string } | null {
  for (const file of CONFIG_FILES) {
    const path = resolve(cwd, file)
    if (existsSync(path)) return { file, path }
  }
  return null
}

export function loadConfig(cwd: string = process.cwd()): TzinConfig | null {
  const found = findConfigFile(cwd)
  if (!found) return null
  // A .ts config needs a TS loader; only loadConfigAsync can do that.
  if (found.file.endsWith('.ts')) return null
  try {
    // createRequire, not a bare require(): the package is ESM, where a
    // bare require() is undefined and would silently drop the config.
    const config = createRequire(import.meta.url)(found.path)
    return config.default || config
  } catch {
    return null
  }
}

/**
 * Same as {@link loadConfig}, but also reads a TypeScript `tzin.config.ts`
 * through a dynamic import. Needs a TS loader in the process (the dev server
 * runs under `tsx`).
 */
export async function loadConfigAsync(cwd: string = process.cwd()): Promise<TzinConfig | null> {
  const found = findConfigFile(cwd)
  if (!found) return null
  if (!found.file.endsWith('.ts')) return loadConfig(cwd)
  try {
    const mod = await import(pathToFileURL(found.path).href)
    return (mod.default ?? mod) as TzinConfig
  } catch (err) {
    console.error(`tzin: failed to load ${found.file}: ${(err as Error).message}`)
    return null
  }
}

export function defineConfig(config: TzinConfig): TzinConfig {
  return config
}
