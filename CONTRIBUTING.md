# Contributing

tzin is stable at 1.0.x — issue reports, reproduction cases and well-scoped PRs
are the most valuable contributions right now.

```sh
npm install
npm test          # vitest: runtime + e2e client + type assertions
npm run typecheck # strict tsc across src/test/bench fixtures
npm run build     # dist/ + declarations, what npm ships
```

## Conventions

- **No dependencies beyond `@sinclair/typebox` and `ws`** (the ws import is
  lazy — only the Node WS adapter touches it). Browser client stays zero-dep.
- Web Standards first: core code must run on plain `fetch`/`Request`/`Response`.
  Runtime-specific logic lives in adapters (`node.ts`, `bun.ts`, `workers.ts`).
- Benchmarks must guard against measuring error paths (`status === 200`) and
  report medians of rotated rounds. See SESSION.md lessons for methodology.
- Tests travel through real sockets where behavior is adapter-dependent.

## Pull requests

1. Open an issue first for anything that changes the public API.
2. Keep commits focused; `npm test && npm run typecheck && npm run build` green.
3. Update CHANGELOG.md under an *Unreleased* heading when user-visible.

## Docs site (`docs-site/`, VitePress → https://tzin.tzinny.com)

```sh
cd docs-site
npm install
npm run dev    # http://localhost:5173, analytics always off
npm run build  # production build; dist/ is gitignored
```

- Content lives in two places: `docs/*.md` (read on GitHub) and
  `docs-site/guide/*.md` (published site). `api-reference.md`,
  `architecture.md`, `deployment.md` and `roadmap.md` exist in **both** —
  keep them in sync by hand. `getting-started.md`, `why.md` and
  `examples.md` are site-only.
- Env vars, production build only:
  - `GA_ID` — GA4 measurement ID (e.g. `G-XXXXXXXXXX`). Injected only when
    set **and** building for production; dev never tracks. CI builds the
    site with and without it. The deploy workflow reads it from the repo
    variable `GA_ID` (Settings → Secrets and variables → Actions → Variables).
  - `CUSTOM_DOMAIN=true|false`, `PAGES_BASE=/otra/` — override the base
    path (auto-detected from `public/CNAME` otherwise).
- The nav version label is read from the root `package.json` — no manual
  update needed on release.
- Deploy: pushing to `main` with changes under `docs-site/**`, `docs/**`,
  `README.md` or `pages.yml` triggers `.github/workflows/pages.yml`
  (build → GitHub Pages). `ci.yml` also builds the site on every
  push/PR so breakage is caught before merge.
