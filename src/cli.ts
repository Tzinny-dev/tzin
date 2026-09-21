import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'

const [,, cmd, ...rest] = process.argv
let matched = false

function usage(): never {
  console.error(`tzin CLI

  Commands:
    tzin dev [entry] [--port N]     start dev server with hot reload
    tzin build                      build for production
    tzin deploy [--target <target>] [--pack] [--docker <tag> [--push]]
                                     deploy (node, workers)
    tzin generate route <name>      generate a route stub
    tzin generate middleware <name>  generate a middleware stub
    tzin generate test <name>       generate a test stub`)
  process.exit(1)
}

if (!cmd || cmd === '--help' || cmd === '-h') usage()

// ── dev ──────────────────────────────────────────────────────────────

if (cmd === 'dev') {
  matched = true
  let entry = ''
  let port = '3000'

  const portFlag = rest.indexOf('--port')
  if (portFlag !== -1 && rest[portFlag + 1]) port = rest[portFlag + 1]

  const entryArg = rest.find((a) => !a.startsWith('-'))
  if (entryArg) entry = entryArg

  const devServer = fileURLToPath(new URL('./dev-server.ts', import.meta.url))
  const args = ['tsx', 'watch', '--clear-screen=false', devServer]
  if (entry) args.push(entry)
  args.push('--port', port)

  const child = spawn('npx', args, { stdio: 'inherit' })
  process.on('SIGINT', () => child.kill('SIGINT'))
  child.on('exit', (code) => process.exit(code ?? 0))
  process.exit(0)
}

// ── build ─────────────────────────────────────────────────────────────

if (cmd === 'build') {
  matched = true
  const cwd = process.cwd()

  // Check for tsconfig
  if (!existsSync(resolve(cwd, 'tsconfig.json'))) {
    console.error('No tsconfig.json found')
    process.exit(1)
  }

  // Check for src/app.ts
  if (!existsSync(resolve(cwd, 'src/app.ts'))) {
    console.error('No src/app.ts found. Create an app first.')
    process.exit(1)
  }

  console.log('Building...')

  const child = spawn('npx', ['tsc', '-p', 'tsconfig.json'], {
    cwd,
    stdio: 'inherit',
  })

  child.on('exit', (code) => {
    if (code === 0) {
      console.log('\n✓ Build complete → dist/')
    }
    process.exit(code ?? 1)
  })
  process.exit(0)
}

// ── deploy ────────────────────────────────────────────────────────────

if (cmd === 'deploy') {
  matched = true
  const cwd = process.cwd()
  const targetFlag = rest.indexOf('--target')
  const target = targetFlag !== -1 ? rest[targetFlag + 1] : 'node'
  const pack = rest.includes('--pack')
  const dockerIdx = rest.indexOf('--docker')
  const dockerTag = dockerIdx !== -1 && rest[dockerIdx + 1] && !rest[dockerIdx + 1].startsWith('-')
    ? rest[dockerIdx + 1]
    : null
  const push = rest.includes('--push')

  if (target === 'workers') {
    console.log('Deploying to Cloudflare Workers...')

    // Check for wrangler.toml
    if (!existsSync(resolve(cwd, 'wrangler.toml'))) {
      console.error('No wrangler.toml found. Run: npx wrangler init')
      process.exit(1)
    }

    const child = spawn('npx', ['wrangler', 'deploy'], {
      cwd,
      stdio: 'inherit',
    })

    child.on('exit', (code) => process.exit(code ?? 1))
    process.exit(0)
  }

  // Default: Node
  if (target !== 'node') {
    console.error(`Unknown deploy target: ${target}`)
    console.error('Available: node, workers')
    process.exit(1)
  }

  // Check for tsconfig
  if (!existsSync(resolve(cwd, 'tsconfig.json'))) {
    console.error('No tsconfig.json found')
    process.exit(1)
  }

  console.log('Building for production...')

  const build = spawn('npx', ['tsc', '-p', 'tsconfig.json'], {
    cwd,
    stdio: 'inherit',
  })

  build.on('exit', (code) => {
    if (code !== 0) process.exit(code ?? 1)
    console.log('\n✓ Build complete')
    afterBuild()
  })
  // NOTE: no trailing process.exit(0) here — the parent must stay alive
  // until the build child exits and afterBuild() runs. Calling
  // process.exit() here would kill the process (and the child listener)
  // before the build finishes.

  function afterBuild() {
    const pkgPath = resolve(cwd, 'package.json')
    let name = 'app'
    let version = '0.0.0'
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      name = String(pkg.name ?? 'app').replace(/^@/, '').replace(/\//g, '-')
      version = String(pkg.version ?? '0.0.0')
    } catch {
      console.error('No package.json found — is this a tzin project?')
      process.exit(1)
    }

    // --pack: runnable tarball (dist + manifest + container files when present).
    if (pack) {
      const out = resolve(cwd, `${name}-${version}.tgz`)
      const files = ['dist', 'package.json']
      for (const f of ['Dockerfile', 'docker-compose.yml', '.dockerignore']) {
        if (existsSync(resolve(cwd, f))) files.push(f)
      }
      console.log(`Packing ${files.join(', ')} → ${out}`)
      const tar = spawn('tar', ['-czf', out, ...files], { cwd, stdio: 'inherit' })
      tar.on('exit', (tarCode) => {
        if (tarCode !== 0) process.exit(tarCode ?? 1)
        console.log(`\n✓ Packed ${out}`)
        console.log(`Unpack + run: tar -xzf ${name}-${version}.tgz && node dist/index.js`)
        if (dockerTag) dockerBuild()
        else process.exit(0)
      })
      return
    }

    if (dockerTag) {
      dockerBuild()
      return
    }

    console.log('Run: node dist/index.js')
    console.log('Tip: tzin deploy --target node --pack [--docker <tag> [--push]] for a runnable artifact')
    process.exit(0)
  }

  function dockerBuild() {
    if (!dockerTag) return
    if (!existsSync(resolve(cwd, 'Dockerfile'))) {
      console.error('No Dockerfile found. Copy the reference Dockerfile from the tzin repo (see docs/deployment.md).')
      process.exit(1)
    }
    console.log(`Building Docker image ${dockerTag}...`)
    const args = ['build', '-t', dockerTag, '.']
    const child = spawn('docker', args, { cwd, stdio: 'inherit' })
    child.on('exit', (buildCode) => {
      if (buildCode !== 0) process.exit(buildCode ?? 1)
      console.log(`\n✓ Image built: ${dockerTag}`)
      if (!push) {
        console.log(`Run: docker run -p 3000:3000 --env PORT=3000 ${dockerTag}`)
        process.exit(0)
        return
      }
      console.log(`Pushing ${dockerTag}...`)
      const pushChild = spawn('docker', ['push', dockerTag], { cwd, stdio: 'inherit' })
      pushChild.on('exit', (pushCode) => process.exit(pushCode ?? 1))
    })
  }
}

// ── generate ─────────────────────────────────────────────────────────

if (cmd === 'generate' || cmd === 'g') {
  matched = true
  const [sub, ...args] = rest
  const name = args[0]

  if (!sub || !name) {
    console.error('Usage: tzin generate <route|middleware|test> <name>')
    process.exit(1)
  }

  const cwd = process.cwd()

  if (sub === 'route' || sub === 'r') {
    const dir = resolve(cwd, 'src/routes')
    mkdirSync(dir, { recursive: true })
    const file = resolve(dir, `${name}.ts`)

    if (existsSync(file)) {
      console.error(`File already exists: ${file}`)
      process.exit(1)
    }

    const slug = name.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    writeFileSync(file, `import { t } from '@carlos-tzin/tzin'
import { contract, impl } from '@carlos-tzin/tzin'

const ${slug} = contract({
  method: 'GET',
  path: '/${slug}',
  responses: {
    200: t.Object({ ok: t.Boolean() }),
  },
})

export const ${slug}Route = impl(${slug}, async () => ({
  status: 200 as const,
  body: { ok: true },
}))
`)

    console.log(`Created ${file}`)
    process.exit(0)
  }

  if (sub === 'middleware' || sub === 'm') {
    const dir = resolve(cwd, 'src/middleware')
    mkdirSync(dir, { recursive: true })
    const file = resolve(dir, `${name}.ts`)

    if (existsSync(file)) {
      console.error(`File already exists: ${file}`)
      process.exit(1)
    }

    const slug = name.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    writeFileSync(file, `import { middleware } from '@carlos-tzin/tzin'

export const ${slug} = middleware(async (ctx, next) => {
  // TODO: add logic here
  return next()
})
`)

    console.log(`Created ${file}`)
    process.exit(0)
  }

  if (sub === 'test' || sub === 't') {
    const dir = resolve(cwd, 'tests')
    mkdirSync(dir, { recursive: true })
    const file = resolve(dir, `${name}.test.ts`)

    if (existsSync(file)) {
      console.error(`File already exists: ${file}`)
      process.exit(1)
    }

    writeFileSync(file, `import { describe, it, expect } from 'vitest'
import { createTestClient } from '@carlos-tzin/tzin/test'
import { app } from '../src/app.js'

describe('${name}', () => {
  it('returns 200', async () => {
    const api = await createTestClient(app)
    try {
      const res = await api.get('/${name}')
      expect(res.status).toBe(200)
    } finally {
      await api.close()
    }
  })
})
`)

    console.log(`Created ${file}`)
    process.exit(0)
  }

  console.error(`Unknown generate type: ${sub}`)
  console.error('Available: route, middleware, test')
  process.exit(1)
}

if (!matched) usage()
