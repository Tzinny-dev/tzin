import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const distCli = resolve(root, 'dist/cli.js')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

type RunResult = { code: number | null; out: string; err: string }

function run(args: string[], cwd: string, useDist = false): Promise<RunResult> {
  const entry = useDist ? [distCli] : ['--import', 'tsx', resolve(root, 'src/cli.ts')]
  return spawnNode([...entry, ...args], cwd)
}

function spawnNode(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => (err += c.toString()))
    child.on('close', (code) => res({ code, out, err }))
  })
}

function watchUntil(args: string[], cwd: string, needle: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let log = ''
    const collect = (c: Buffer) => {
      log += c.toString()
      if (log.includes(needle)) res(log)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => rej(new Error(`timeout waiting for ${needle}\n${log}`)), timeoutMs)
    const done = () => clearTimeout(timer)
    child.on('close', () => done())
    const kill = () => {
      done()
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      res(log)
    }
    child.on('close', kill)
  })
}

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(resolve(root, '.tmp-cli-'))
  for (const [name, body] of Object.entries(files)) {
    const file = resolve(dir, name)
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, body)
    if (name.startsWith('node_modules/.bin/')) chmodSync(file, 0o755)
  }
  return dir
}

const tsconfig = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    declaration: true,
    outDir: 'dist',
    rootDir: 'src',
    types: [],
  },
  include: ['src'],
})

describe('cli packaging', () => {
  it('exposes the tzin bin so `tzin` resolves from node_modules/.bin', () => {
    expect(pkg.bin).toEqual({ tzin: './dist/cli.js' })
    expect(pkg.files).toContain('dist')
  })

  it('keeps the shebang in the source and in the built output', () => {
    const src = readFileSync(resolve(root, 'src/cli.ts'), 'utf8')
    expect(src.split('\n')[0]).toBe('#!/usr/bin/env node')
    if (existsSync(distCli)) {
      expect(readFileSync(distCli, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node')
    }
  })

  it('prints usage for --help', async () => {
    const dir = makeProject({ 'package.json': '{}' })
    try {
      const r = await run(['--help'], dir)
      expect(r.code).toBe(1)
      expect(r.err).toContain('tzin dev')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cli build', () => {
  it('compiles and exits 0', async () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ name: 'app', version: '0.0.0', type: 'module' }),
      'tsconfig.json': tsconfig,
      'src/app.ts': 'export const app = 1\n',
    })
    try {
      const r = await run(['build'], dir)
      expect(r.err).toBe('')
      expect(r.code).toBe(0)
      expect(existsSync(resolve(dir, 'dist/app.js'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('waits for tsc and propagates its exit code', async () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ name: 'app', version: '0.0.0', type: 'module' }),
      'tsconfig.json': tsconfig,
      'src/app.ts': 'export const app = 1\n',
      'src/broken.ts': 'const x: number = "not a number"\nexport default x\n',
    })
    try {
      const r = await run(['build'], dir)
      expect(r.code).not.toBe(0)
      expect(r.out + r.err).toContain('TS2322')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.skipIf(!existsSync(distCli))('cli dev (built package layout)', () => {
  it('finds dev-server in dist and reports the missing entry instead of crashing', async () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ name: 'app', version: '0.0.0', type: 'module' }) })
    try {
      const log = await watchUntil([distCli, 'dev'], dir, 'Entry file not found')
      expect(log).not.toContain('ERR_MODULE_NOT_FOUND')
      expect(log).not.toContain('dev-server.ts')
      expect(log).toContain('src/app.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('cli deploy', () => {
  it('rejects an unknown target', async () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ name: 'app', version: '0.0.0', type: 'module' }) })
    try {
      const r = await run(['deploy', '--target', 'cloudflare'], dir)
      expect(r.code).toBe(1)
      expect(r.err).toContain('Unknown deploy target')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('does not fall through to the node path when deploying to workers', async () => {
    const stub = `#!/bin/sh\necho "wrangler $*"\nexit 0\n`
    const dir = makeProject({
      'package.json': JSON.stringify({ name: 'app', version: '0.0.0', type: 'module' }),
      'wrangler.toml': 'name = "app"\n',
      'node_modules/.bin/wrangler': stub,
    })
    try {
      const r = await run(['deploy', '--target', 'workers'], dir)
      const log = r.out + r.err
      expect(log).toContain('wrangler deploy')
      expect(log).not.toContain('Unknown deploy target')
      expect(log).not.toContain('No tsconfig.json found')
      expect(r.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// Vitest's module runner injects a `require` shim, so importing src/*.ts in a
// test cannot catch a bare require() that only breaks once published as ESM.
// These run the built dist in a real node process.
describe.skipIf(!existsSync(resolve(root, 'dist/index.js')))('published dist in plain node', () => {
  function runModule(script: string, files: Record<string, string> = {}): Promise<RunResult> {
    const dir = makeProject(files)
    writeFileSync(resolve(dir, 'probe.mjs'), script)
    return spawnNode(['probe.mjs'], dir)
  }

  function importDist(name: string): string {
    return pathToFileURL(resolve(root, 'dist', name)).href
  }

  it('signs and verifies a JWT', async () => {
    const r = await runModule(`
import { signJwt, verifyJwt } from ${JSON.stringify(importDist('auth.js'))}
const token = signJwt({ sub: 'u1' }, 's3cret')
if (verifyJwt(token, 's3cret').sub !== 'u1') throw new Error('payload mismatch')
console.log('JWT_OK')
`)
    expect(r.err).not.toContain('ReferenceError')
    expect(r.code).toBe(0)
    expect(r.out).toContain('JWT_OK')
  }, 30_000)

  it('loads tzin.config.json', async () => {
    const r = await runModule(`
import { loadConfig } from ${JSON.stringify(importDist('config.js'))}
const config = loadConfig(process.cwd())
if (config?.port !== 4321) throw new Error('config not loaded: ' + JSON.stringify(config))
console.log('CONFIG_OK')
`, { 'tzin.config.json': JSON.stringify({ port: 4321 }) })
    expect(r.code).toBe(0)
    expect(r.out).toContain('CONFIG_OK')
  }, 30_000)

  it('serves an app built on the published entrypoint', async () => {
    const r = await runModule(`
import { createApp, contract, impl, t } from ${JSON.stringify(importDist('index.js'))}
const health = contract({ method: 'GET', path: '/ping', responses: { 200: t.Object({ ok: t.Boolean() }) } })
const app = createApp([impl(health, async () => ({ status: 200, body: { ok: true } }))])
const res = await app.fetch(new Request('http://localhost/ping'))
if (res.status !== 200) throw new Error('status ' + res.status)
console.log('APP_OK')
`)
    expect(r.code).toBe(0)
    expect(r.out).toContain('APP_OK')
  }, 30_000)
})
