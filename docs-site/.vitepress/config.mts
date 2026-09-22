import { defineConfig } from 'vitepress'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

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
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API Reference', link: '/guide/api-reference' },
      { text: 'Architecture', link: '/guide/architecture' },
      { text: 'Deployment', link: '/guide/deployment' },
      {
        text: 'v1.0.6',
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
