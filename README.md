# ad4m-rag

GraphRAG-style knowledge extraction and query, backed by [AD4M](https://github.com/coasys/ad4m) perspectives.

## What this is

Vector RAG can't answer "what are the themes across my corpus?" — no single chunk holds the answer. This library follows the [GraphRAG](https://microsoft.github.io/graphrag/) approach: an LLM extracts a typed knowledge graph (entities, relationships, claims with provenance) from any ingested text, the graph is hierarchically clustered with Leiden community detection, per-community summaries are generated, and queries pick between **local** mode (vector hit → graph walk) and **global** mode (map-reduce over community summaries).

The structural graph lives in AD4M perspectives. Embeddings and search indexes live in a local SQLite + sqlite-vec index keyed by AD4M URIs. Same query engine, full P2P sharing properties.

Every extracted **claim** also carries a 12-cell decomposition via [@hexafield/hexevent](https://github.com/HexaField/hexevent) — Who / What / When / Where / Why / How × Subjective / Objective. The string `statement` stays as a human summary; the cells are the structured form the query engine can filter by. See [the cell-aware retrieval section](#cell-aware-retrieval-hexevent) below.

## Why AD4M-backed

Most knowledge graphs are organisation-shaped: a single team owns the graph, decides what's true, and pays the storage. This library treats the graph as something multiple agents can contribute to over a P2P substrate, with **provenance as a first-class field on every record** (entity, relationship, claim). The wins:

- **Per-claim provenance.** Every assertion carries the DID of the agent that made it. Queries filter by source: "only my own claims", "only the Coasys-team perspective", "claims with at least 3 independent assertions".
- **Selective publication.** Local extraction is private by default. Publish individual entities, relationships, or claims into named neighbourhoods; the local copy stays.
- **Disagreement is first-class.** Conflicting claims coexist with their `assertedBy` sets. The query engine surfaces both in citations; the caller (or human) judges.
- **Composable across communities.** The same query engine reads from any union of (local) + (subscribed neighbourhood perspectives). Knowledge commons without centralisation.

## Status

**Working prototype.** The full design is in [PLAN.md](./PLAN.md). All 13 requirements are implemented; the 12-cell hexevent vocabulary is wired into every claim by default. 90 unit tests + 7 live integration tests against a real AD4M executor are green. A runnable end-to-end demo lives in [`examples/one-event-many-witnesses`](./examples/one-event-many-witnesses).

The repo is being prototyped under [@hexafield](https://github.com/HexaField) while the architecture settles. The intent is to move it to [@coasys](https://github.com/coasys) once the design is proven.

## Install

```bash
npm install @hexafield/ad4m-rag
```

Peer dependencies (you provide):

- `@coasys/ad4m` (≥ 0.13.0-test-8)
- `@anthropic-ai/sdk` *(optional — only if you use the default LLM client)*

## Usage

```ts
import {
  createAd4mRag,
  createOllamaEmbeddingClient,
  createAnthropicLlmClient
} from '@hexafield/ad4m-rag'

const rag = createAd4mRag({
  sqlitePath: './data/knowledge.db',
  embeddings: createOllamaEmbeddingClient({ model: 'nomic-embed-text' }),
  llm: await createAnthropicLlmClient({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  ad4mClient,                       // your authenticated Ad4mClient
  privatePerspectiveUuid: '…',      // a perspective you own
  sharedPerspectiveUuids: ['…']     // optional shared perspectives to read from
})

await rag.ingest.append({
  documentId: 'doc-1',
  text: '…',
  assertedBy: { did: 'did:key:…' }
})
await rag.rebuildCommunities()

const result = await rag.query.query({
  question: 'What are the themes across this corpus?',
  mode: 'auto'
})
console.log(result.answer, result.citations)
```

For the MCP tool factory:

```ts
const tools = rag.mcp.tools() // 9 tools — register with your MCP server
```

## Cell-aware retrieval (hexevent)

Every extracted `Claim` carries a structured decomposition across twelve
cells (Who / What / When / Where / Why / How × Subjective / Objective)
sourced from [@hexafield/hexevent](https://github.com/HexaField/hexevent).
The vocabulary is grounded in immanent metaphysics — the cells aren't a
convenience taxonomy; they're the minimum sufficient surface over which
any event can be described. Partial population is the norm: empty cells
are a precise statement of what hasn't been observed, not an error.

In practice this means:

- The default extraction prompt asks the LLM to fill cells alongside
  every claim.
- The local sqlite index stores cell assignments in a `cell_assignments`
  table with FTS5 over the filler text.
- On the wire, each cell IRI from hexevent doubles as the AD4M predicate
  linking a Claim to its cell-assignment subjects and as the
  `subjectFlag` typing the assignment.
- `knowledge_query` (and `rag.query.query`) accept an optional
  `byCell` argument: conjunctive cell terms that narrow the claim pool
  before the entity walk.

```ts
const result = await rag.query.query({
  question: 'What does Josh care about across the last month?',
  mode: 'local',
  byCell: [
    { cell: 'who·objective', fillerLike: 'Josh' },
    { cell: 'why·subjective' }
  ]
})
```

When the cell pool comes up empty (e.g. nothing has been tagged with the
requested cells yet) local mode falls back to the vector path so queries
never silently return nothing purely because cells are sparse.

## Testing

Unit tests (no network, no executor):

```bash
npm test
```

Live AD4M integration tests (spawns an isolated `ad4m-executor` per test, real Holochain bring-up):

```bash
AD4M_RAG_INTEGRATION=1 npm run test:integration
```

The integration harness expects `ad4m-executor` on `PATH` or `AD4M_EXECUTOR` set to the binary path.

## License

[Cryptographic Autonomy License v1.0](./LICENSE) (CAL-1.0) — the same license used by [Holochain](https://github.com/holochain) and [AD4M](https://github.com/coasys/ad4m). The CAL preserves users' rights to access their own data and cryptographic keys when the Work is offered as a service.
