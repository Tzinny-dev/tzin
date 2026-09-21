import { createApp } from '@carlos-tzin/tzin'
import { bearerAuth } from '@carlos-tzin/tzin/auth'
import { configure } from '@carlos-tzin/tzin/log'
import { healthRoute } from './routes/health.js'
import { greetRoute } from './routes/greet.js'
import { usersRoute } from './routes/users.js'

// Configure logging
configure({ level: 'info', pretty: true })

export const app = createApp([healthRoute, greetRoute, ...usersRoute], {
  middleware: [
    bearerAuth({ secret: process.env.JWT_SECRET || 'dev-secret' }),
  ],
  openapi: true,
  llms: true,
  mcp: true,
  meta: { title: 'My tzin App', version: '0.0.0' },
})
