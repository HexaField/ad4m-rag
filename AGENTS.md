# AGENTS.md — @hexafield/ad4m-rag

GraphRAG-style knowledge extraction + query over [AD4M](https://github.com/coasys/ad4m)
perspectives. Read [README.md](./README.md) for the what/why and [PLAN.md](./PLAN.md)
for the full design. This file is operational memory for anyone (human or agent)
picking up work in the repo.

## Build & test

```bash
npm run build            # tsc -p tsconfig.json → dist/
npm run check            # tsc --noEmit (type-check only)
npm test                 # vitest run (unit tests, no executor needed)
npm run test:integration # live tests against a real AD4M executor (see below)
```

- **Unit tests** are hermetic — no executor, no network. Run them for every change.
- **Integration tests** need `AD4M_RAG_INTEGRATION=1` and an `ad4m-executor` on
  `PATH`; they boot a throwaway isolated node via `tests/integration/harness.ts`.
  The `test:integration` script sets the env var for you. Config lives in
  `vitest.integration.config.ts`.

## Layout

```
src/                library source
  ad4m/             AD4M serialise/parse + client facade + predicate URIs
  ingest/           chunker → extractor → merge pipeline
  query/            query engine (local/global), classifier
  sqlite/           SQLite + sqlite-vec index (embeddings, FTS, cell assignments)
  store.ts          KnowledgeGraphStore — local index + AD4M publish/subscribe
  factory.ts        createAd4mRag — the one-call composition of all the above
tests/integration/  live-executor harness + integration specs
examples/           runnable demos (see examples/*/README.md)
dist/               build output — examples import from here, so build first
```

## Non-obvious conventions & gotchas

- **Examples import the built library**, not `src/`. They resolve
  `../../../dist/index.js`, so `npm run build` must run before an example will
  pick up source changes. The demos' `predev` script does this automatically.
- **Native TS execution.** Backends/harnesses run under Node's native TypeScript
  support (`node file.ts`, no loader). That path enforces `isolatedModules` +
  `verbatimModuleSyntax`: relative imports need explicit **`.ts`** extensions,
  and every type-only import must use `import type` or an inline `type`
  specifier. `tsc` output (the library itself) uses `.js` extensions as usual.
- **FTS5 free-text is not query syntax.** SQLite FTS5 `MATCH` treats `-`, `:`,
  `?`, quotes, etc. as operators, so passing a raw entity name or user question
  (`fig-tree`, `What happened on Saturday?`) throws `no such column: X` or a
  syntax error. All free text must be tokenised into a quoted-OR expression
  before it reaches `MATCH`. This is centralised in `toFtsMatchQuery` in
  `src/sqlite/index.ts`; `ftsSearchClaims` is the single choke point — keep it
  that way rather than sanitising at call sites.
- **A perspective is a set of links.** The same `(source, predicate, target)`
  triple can legitimately appear more than once (e.g. a re-published subject),
  but carries no extra information. Two invariants keep multi-valued fields
  (`assertedBy`, `aliases`, cell fillers) from double-counting:
  1. **Write side** — `store.ts` `publishToPerspective` is idempotent: it reads
     the target perspective and only pushes links not already present.
  2. **Read side** — `ad4m/parse.ts` `groupBySource` dedupes targets per
     predicate as a defensive backstop.
  Preserve both; either alone leaves a gap.
- **Provenance is first-class.** Every entity/relationship/claim carries an
  `assertedBy: { did, label? }[]`. Identity merge (content hash of the record,
  *excluding* cells) unions the `assertedBy` sets of duplicate assertions. Never
  fold provenance into the identity hash.
- **12-cell hexevent vocabulary.** Every claim carries a 5W1H ×
  objective/subjective decomposition from
  [@hexafield/hexevent](https://github.com/HexaField/hexevent). `CellId` strings
  use a middot (`who·objective`, U+00B7) — match on the exact codepoint; don't
  substitute an ASCII `.`.

## Provenance / status

- Peer dependency: `@coasys/ad4m` (≥ 0.13.0-test-8). `@anthropic-ai/sdk` is
  optional (only the default LLM client uses it).
- Prototyped under [@hexafield](https://github.com/HexaField) while the design
  settles; intended to move to [@coasys](https://github.com/coasys) once proven.
