import { defineConfig } from 'vitepress'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Versión del framework (root package.json) para el label del nav.
// Se actualiza sola en cada release: no hardcodear.
const rootPkg = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')
) as { version: string }

// Google Analytics 4: solo se inyecta en el build de producción
// (`vitepress build` corre con NODE_ENV=production) y si GA_ID está definido.
// En dev local (NODE_ENV=undefined) nunca se carga: evita ensuciar las métricas.
// GA_ID se pasa como variable de entorno, p.ej. GA_ID=G-XXXXXXXXXX npm run build.
const GA_ID = process.env.GA_ID?.trim()
const gaEnabled = GA_ID !== undefined && GA_ID !== '' && process.env.NODE_ENV === 'production'

if (GA_ID && !/^G-[A-Z0-9]{4,}$/.test(GA_ID)) {
  console.warn(`[tzin] GA_ID "${GA_ID}" no parece un measurement ID válido (formato esperado: G-XXXXXXXXXX). Se inyectará igual, revisalo.`)
}

const gaHead: ['script', Record<string, string>, string][] = gaEnabled
  ? [
      ['script', { async: 'true', src: `https://www.googletagmanager.com/gtag/js?id=${GA_ID}` }, ''],
      [
        'script',
        {},
        `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}` +
          `gtag('js',new Date());gtag('config','${GA_ID}');`,
      ],
    ]
  : []
// Si existe public/CNAME => deploy con dominio custom => base '/'
// Si no => deploy a user.github.io/tzin => base '/tzin/'
// Override manual: CUSTOM_DOMAIN=true|false  |  PAGES_BASE=/otra/
const hasCNAME = existsSync(resolve(import.meta.dirname, '../public/CNAME'))
const base =
  process.env.PAGES_BASE ??
  (process.env.CUSTOM_DOMAIN === 'true'
    ? '/'
    : process.env.CUSTOM_DOMAIN === 'false'
      ? '/tzin/'
      : hasCNAME
        ? '/'
        : '/tzin/')

export default defineConfig({
  title: 'tzin',
  description: 'Contract-first TypeScript framework. Types that scale, realtime channels with presence, and an MCP server for every API.',
  base,
  lang: 'en-US',
  cleanUrls: true,

  head: [
    ['link', { rel: 'icon', href: '/logo.svg', type: 'image/svg+xml' }],
    ['meta', { property: 'og:title', content: 'tzin — contract-first TypeScript framework' }],
    ['meta', { property: 'og:description', content: 'Declare a contract once, get validation, OpenAPI, typed clients and MCP for free.' }],
    ['meta', { name: 'theme-color', content: '#0ea5e9' }],
    ...gaHead,
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API Reference', link: '/guide/api-reference' },
      { text: 'Architecture', link: '/guide/architecture' },
      { text: 'Deployment', link: '/guide/deployment' },
      {
        text: 'Support',
        items: [
          { text: 'PayPal', link: 'https://paypal.me/carlostzin', target: '_blank', rel: 'noopener noreferrer' },
          { text: 'Buy Me a Coffee', link: 'https://buymeacoffee.com/tzinny', target: '_blank', rel: 'noopener noreferrer' },
        ],
      },
      {
        text: `v${rootPkg.version}`,
        items: [
          { text: 'Changelog', link: 'https://github.com/Tzinny-dev/tzin/blob/main/CHANGELOG.md' },
          { text: 'Roadmap', link: '/guide/roadmap' },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Why tzin?', link: '/guide/why' },
          { text: 'Getting Started', link: '/guide/getting-started' },
        ],
      },
      {
        text: 'Core',
        items: [
          { text: 'API Reference', link: '/guide/api-reference' },
          { text: 'Architecture', link: '/guide/architecture' },
          { text: 'Deployment', link: '/guide/deployment' },
          { text: 'Roadmap', link: '/guide/roadmap' },
        ],
      },
      {
        text: 'Examples',
        items: [
          { text: 'Node Demo', link: '/guide/examples' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Tzinny-dev/tzin' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@carlos-tzin/tzin' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Tzinny-dev',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/Tzinny-dev/tzin/edit/main/docs-site/:path',
      text: 'Edit this page on GitHub',
    },
  },

  vite: {
    server: { port: 5173 },
  },
})
