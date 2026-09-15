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
