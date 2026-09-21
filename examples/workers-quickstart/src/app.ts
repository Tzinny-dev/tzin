import { createApp, contract, impl, t, Hub, Presence, channelRoutes, wsChannels, toDurableWorker, toWorker, TzinChannels } from '@carlos-tzin/tzin'

// workerd discovers Durable Object classes among the script's exports
export { TzinChannels }

const health = contract({
  name: 'health',
  method: 'GET',
  path: '/health',
  responses: { 200: t.Object({ ok: t.Boolean(), runtime: t.String() }) },
})

const chat = contract({
  name: 'chat',
  method: 'GET',
  path: '/chat',
  responses: { 200: t.Object({ ok: t.Boolean() }) },
})

export default toDurableWorker(() => {
  const hub = new Hub()
  const presence = new Presence(hub, 30_000)

  const app = createApp([
    impl(health, () => ({
      status: 200 as const,
      body: { ok: true, runtime: 'cloudflare-workers' },
    })),
    impl(chat, () => ({
      status: 200 as const,
      body: { ok: true },
    })),
    ...channelRoutes(hub, { presence }),
  ])
  return toWorker(app, { wsRoutes: [wsChannels(hub, { presence })] })
})
