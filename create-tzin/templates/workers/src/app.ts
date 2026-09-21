import { createApp } from '@carlos-tzin/tzin'
import { healthRoute } from './routes/health.js'
import { greetRoute } from './routes/greet.js'
import { usersRoute } from './routes/users.js'

export const app = createApp([healthRoute, greetRoute, ...usersRoute], {
  openapi: true,
  llms: true,
  mcp: true,
  meta: { title: 'My tzin App', version: '0.0.0' },
})
