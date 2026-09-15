/**
 * Workers probe: verifies toWorker() HTTP + native WebSockets (WebSocketPair)
 * against REAL workerd via miniflare. Run: node scripts/workers-probe.mjs
 */
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { WebSocket } from 'ws'

const checks = []
const check = (name, ok, extra = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
}

// Bundle the example worker (pure modules only) into a single ESM script.
const { outputFiles } = await build({
  entryPoints: ['examples/worker-channels.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
})
const script = outputFiles[0].text

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityFlags: ['nodejs_compat'],
    // The whole app lives in this Durable Object (single I/O context).
    durableObjects: { TZIN_APP: { className: 'TzinChannels' } },
  }),
)
try {
  const url = await mf.ready
  const httpBase = `http://${url.host}`
  const healthRes = await fetch(`${httpBase}/health`)
  const health = await healthRes.json()
  check('HTTP GET /health', healthRes.status === 200 && health.ok === true, JSON.stringify(health))

  // 2. WS upgrade + open -> initial presence_state roster
  const wsUrl = `${httpBase.replace(/^http/, 'ws')}/channels/room?member=ada`
  const ada = new WebSocket(wsUrl)
  const adaFirst = await firstEvent(ada, 'presence_state', 5000)
  const roster1 = members(adaFirst)
  check('WS open -> initial presence_state', roster1.includes('ada'), JSON.stringify(roster1))

  // 3. Second member sees the full roster on connect
  const bob = new WebSocket(`${httpBase.replace(/^http/, 'ws')}/channels/room?member=bob`)
  const bobRoster = members(await firstEvent(bob, 'presence_state', 5000))
  check(
    'second connect sees complete roster',
    bobRoster.includes('ada') && bobRoster.includes('bob'),
    JSON.stringify(bobRoster),
  )

  // 4. push frame broadcasts cross-connections
  const bobGotChat = firstEvent(bob, 'chat', 5000)
  ada.send(JSON.stringify({ type: 'push', event: 'chat', data: { text: 'hola workers' } }))
  const chat = await bobGotChat
  check('push broadcasts to other connection', chat?.data?.text === 'hola workers', JSON.stringify(chat))

  // 5. close -> presence_diff leave observed by the survivor
  const bobDiff = firstEvent(bob, 'presence_diff', 5000)
  ada.close()
  const diff = await bobDiff
  const leaves = diff?.data?.leaves ?? []
  check('close triggers presence_diff leave', leaves.includes('ada'), JSON.stringify(diff))

  bob.close()
} finally {
  await mf.dispose()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)

/* --- helpers --- */
function members(stateMsg) {
  return (stateMsg?.data?.members ?? []).map((m) => m.member)
}
function firstEvent(ws, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs)
    ws.addEventListener('message', (ev) => {
      let f
      try {
        f = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (f.event === event || f.error) {
        clearTimeout(timer)
        resolve(f.event === event ? f : Promise.reject(new Error(`frame error: ${f.error}`)))
      }
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('websocket error'))
    })
    ws.addEventListener('close', () => {
      clearTimeout(timer)
      reject(new Error(`closed before ${event}`))
    })
  })
}
