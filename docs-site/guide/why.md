# Why another framework?

The TypeScript backend landscape is crowded — and still leaves real gaps:

| Gap | Evidence |
|---|---|
| Type inference collapses at scale | Hono issues [#2399](https://github.com/honojs/hono/issues/2399), [#3869](https://github.com/honojs/hono/issues/3869); chained route builders force one giant expression per app |
| No architecture in lightweight frameworks | Hono issue [#4121](https://github.com/honojs/hono/issues/4121) |
| Extractors don't exist in TS | Only Rust's Axum gets handler input right |
| OpenAPI is a bolt-on | Every TS framework translates its own schema DSL to JSON Schema at runtime or via codegen |
| AI-native toolchain | One framework ships an MCP server; the window is closing |

## tzin's answer

**Declare a contract once**, get everything else for free.

* **Handler input is extracted, not guessed**: `{ params }` exists because you declared it; add `query`, `body`, `headers` or `cookies` to the contract and they appear, fully typed and validated per request.
* **The compiler enforces your responses**: returning a shape that doesn't match the declared `200` body is a type error. Thrown `HttpError`s map to their status.
* **OpenAPI 3.1 is free**: contracts are JSON Schema (TypeBox), so `generateOpenApi(routes)` needs no translation layer.
* **Realtime and AI are primitives**, not plugins.

> `tzin` — from Nahuatl *-tzin*, an honorific suffix for what is valued and beloved. A pact between client and server, declared once.
