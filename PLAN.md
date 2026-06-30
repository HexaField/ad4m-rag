# ad4m-rag — Design Plan

_GraphRAG-style knowledge extraction and query, backed by AD4M perspectives._

## Goal

Give any LLM application a reasoning-grade knowledge layer over a graph
that can be shared P2P with per-claim provenance.

Vector RAG cannot answer "what are the themes across this corpus?" — no
single chunk holds the answer. This library follows Microsoft's GraphRAG
approach: LLM-extract a typed knowledge graph (entities, relationships,
claims with provenance) from any ingested corpus, hierarchically cluster
it with Leiden community detection, generate per-community summaries,
and expose two query modes — **local** (vector hit → graph walk) and
**global** (map-reduce over community summaries).

The structural graph lives in [AD4M](https://github.com/coasys/ad4m)
perspectives. Embeddings and indexes live in a local SQLite + sqlite-vec
store keyed by AD4M URIs. The result: a knowledge layer with first-class
provenance, opt-in P2P sharing, and disagreement as information.

## Non-Goals

- A general-purpose graph database. The data model is GraphRAG-specific.
- A vector store. Embeddings are an implementation detail of the local
  index; consumers don't reach into them.
- A general AD4M perspective viewer. AD4M is used as a storage substrate;
  raw perspective state is never exposed.
- Building extraction prompts perfectly on day one. Extraction quality is
  a tunable; the architecture must survive prompt iteration without
  re-extracting unchanged input (content-hash cache).
- Resolving conflicting claims for the user. The engine surfaces both
  sides with provenance; resolution is a caller / human concern.

---

## Concept Overview

### GraphRAG, briefly

1. **Chunk** the corpus into overlapping passages.
2. **Extract** per chunk: entities (typed, with description), relationships
   (typed, with description, weight), claims (factual statements with
   source chunk).
3. **Embed** entities, communities, and chunks for vector retrieval.
4. **Community-detect** the graph hierarchically (Leiden, multiple
   levels).
5. **Summarise** each community at each level into a community report.
6. **Query** in two modes:
   - **Local** — embed query → top-k entities → walk graph neighbourhood
     → context assembly → answer.
   - **Global** — map-reduce: each community report produces a partial
     answer, partials are scored and reduced into a final answer.

### AD4M backing, briefly

AD4M perspectives are RDF-shaped graphs of Links (`source` →
`predicate` → `target`), shareable over Holochain neighbourhoods, with
SHACL Subject classes for schema. The structural graph (entities,
relationships, claims, communities) maps cleanly onto Subject instances
plus Links. Embeddings and search indexes don't fit — they stay in
local sqlite-vec, keyed by AD4M URIs.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                            @hexafield/ad4m-rag                        │
│                                                                       │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────────────┐    │
│  │  Ingest API │   │ Query Engine │   │   MCP Tool Factory       │    │
│  │             │   │              │   │   (optional integration) │    │
│  └──────┬──────┘   └──────┬───────┘   └──────────┬───────────────┘    │
│         │                 │                      │                    │
│         ▼                 ▼                      ▼                    │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                  KnowledgeGraphStore                            │  │
│  │  (single implementation — AD4M structural + sqlite-vec index)   │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│            ▲                                       ▲                  │
│            │ structural                            │ embeddings + FTS │
│            ▼                                       ▼                  │
│   ┌─────────────────────┐                  ┌────────────────────┐     │
│   │   AD4M perspective  │                  │   sqlite-vec +     │     │
│   │   (private + opted- │                  │   FTS5 (local      │     │
│   │   in shared ones)   │                  │   derived index)   │     │
│   └─────────────────────┘                  └────────────────────┘     │
└───────────────────────────────────────────────────────────────────────┘
        ▲                                            ▲
        │ Ad4mClient (host app provides)             │ better-sqlite3 + sqlite-vec
        │                                            │
   ┌────┴───────┐                            (bundled with the library)
   │  @coasys/  │
   │  ad4m      │
   └────────────┘
```

### Storage roles

- **AD4M perspective** holds the *source of truth* for structural graph
  data: entities, relationships, claims, communities. Subject classes
  enforce the schema. Holochain handles replication when subjects are
  published into shared perspectives.
- **sqlite + sqlite-vec** is a *derived index* used for vector search
  and full-text retrieval. It is rebuildable from AD4M at any time.
  Vectors are stored locally because AD4M cannot store them efficiently.

The two are kept in sync via:

- write-through on local upserts (AD4M write batches → index update),
- subscription to AD4M perspective change events for inbound subjects
  from peers,
- a `reindex()` operation that drops the local index and rebuilds from
  AD4M (slow but always correct).

---

## Data Model

Five concepts. Schema enforced via SHACL Subject classes in AD4M;
mirrored in TypeScript types for callers.

```typescript
export type EntityType = string       // 'Person' | 'Project' | 'Concept' | 'Decision' | ...
export type RelationType = string     // 'works_on' | 'depends_on' | 'derived_from' | ...

export interface Entity {
  uri: string                   // content-hashed; canonical key
  type: EntityType
  name: string
  description: string           // LLM-extracted, short
  aliases?: string[]
  assertedBy: AgentRef[]        // DIDs of agents who asserted this entity
  sourceChunkIds: string[]      // chunks this entity was extracted from
  createdAt: number
  updatedAt: number
}

export interface Relationship {
  uri: string
  source: string                // Entity.uri
  predicate: RelationType
  target: string                // Entity.uri
  description: string
  weight: number                // LLM-judged salience
  assertedBy: AgentRef[]
  sourceChunkIds: string[]
  createdAt: number
}

export interface Claim {
  uri: string
  about: string                 // Entity.uri being claimed about
  statement: string             // the claim itself, plain English
  evidenceChunkIds: string[]    // the source chunks
  assertedBy: AgentRef[]
  supports?: string[]           // Claim.uri
  contradicts?: string[]        // Claim.uri
  createdAt: number
}

export interface Community {
  uri: string
  level: number                 // 0 = leaf, higher = broader
  parent?: string               // Community.uri
  memberEntityUris: string[]
  summary: string               // LLM-generated community report
  createdAt: number
}

export interface Chunk {
  id: string                    // content-hash
  documentId: string            // logical doc the chunk came from
  text: string
  position: { start: number; end: number }
}

export interface AgentRef {
  did: string                   // AD4M-style DID
  label?: string                // human-readable, optional
}
```

URIs are content-hashed (`entity:<sha256>`) so identical extractions
converge. Identity merge: two Entities with the same canonical (type,
lowercased trimmed name) collapse to one record with merged
`assertedBy` + `sourceChunkIds`. This is what makes assertion-by-many-
agents accumulate cleanly on a single entity.

---

## KnowledgeGraphStore

The single storage interface. One implementation. Sits over both the
AD4M perspective(s) and the local sqlite index.

```typescript
export interface KnowledgeGraphStore {
  // ── Structural (writes go to AD4M + index in lockstep) ──────────
  upsertEntity(entity: Entity): Promise<void>
  upsertRelationship(rel: Relationship): Promise<void>
  upsertClaim(claim: Claim): Promise<void>
  upsertCommunity(community: Community): Promise<void>
  upsertChunk(chunk: Chunk): Promise<void>

  // ── Reads ───────────────────────────────────────────────────────
  getEntity(uri: string): Promise<Entity | null>
  getChunks(ids: string[]): Promise<Chunk[]>
  listRelationships(filter: {
    source?: string
    target?: string
    predicate?: string
    fromAgents?: AgentRef[]
    fromPerspectives?: string[]
  }): Promise<Relationship[]>
  listCommunities(level?: number): Promise<Community[]>

  // ── Vector + full-text search (against the local index) ─────────
  vectorSearchEntities(emb: number[], k: number, filter?: ProvenanceFilter): Promise<Entity[]>
  vectorSearchChunks(emb: number[], k: number, filter?: ProvenanceFilter): Promise<Chunk[]>
  vectorSearchCommunities(emb: number[], k: number, level?: number, filter?: ProvenanceFilter): Promise<Community[]>
  ftsSearchClaims(query: string, k: number, filter?: ProvenanceFilter): Promise<Claim[]>

  // ── Publication (AD4M-side) ─────────────────────────────────────
  /** Promote a single Entity / Relationship / Claim into a named shared perspective. */
  publishToPerspective(uri: string, perspectiveUuid: string): Promise<void>
  unpublishFromPerspective(uri: string, perspectiveUuid: string): Promise<void>

  // ── Maintenance ─────────────────────────────────────────────────
  /** Drop local index and rebuild from AD4M. Slow but always correct. */
  reindex(): Promise<void>
  dispose(): Promise<void>
}

export interface ProvenanceFilter {
  fromAgents?: AgentRef[]
  fromPerspectives?: string[]
}
```

### Implementation notes

- All upserts idempotent.
- Writes go AD4M-first; index updates are derived. On AD4M write
  failure, the index is not updated.
- Reads against `listRelationships` / `getEntity` may hit the local
  index (fast path) but the index is rebuilt from AD4M on `reindex()`,
  ensuring divergence is recoverable.
- `publishToPerspective` adds the subject's structural Links to the
  named perspective via batched `addLinks`. The local index is unchanged
  (it already represented the entity).
- Per-batch write size for AD4M is configurable; default 50.

### Subject classes

The library defines and exports the SHACL Subject classes for Entity,
Relationship, Claim, Community. On backend init the library ensures
they exist in every perspective it writes into (creating them where
absent). Consumers can extend these classes in their own perspectives
as long as the base properties remain.

---

## Ingestion Pipeline

Staged so prompt iteration doesn't re-process unchanged input.

```
documentId + raw text + AgentRef
        │
        ▼
   chunk(text)  ──►  chunks[]                       [cache: content-hash]
        │
        ▼
   embedChunks  ──►  chunk embeddings              [cache: hash → vector]
        │
        ▼
   extractEntities  ──►  entities[], relationships[], claims[]
                                                    [cache: hash → extraction]
        │
        ▼
   embedEntities  ──►  entity embeddings
        │
        ▼
   write to KnowledgeGraphStore (AD4M + local index)
        │
        ▼
   communityDetect()      ──► (re-runs over whole local graph)
        │
        ▼
   summariseCommunities() ──► community reports + embeddings   [cache: members-hash → summary]
```

Each stage content-hash-cached, so:

- Re-ingesting unchanged text is a no-op.
- Changing an extraction prompt invalidates only the extraction cache.
- Changing the embedding model invalidates only embeddings.

The cache itself lives in the local sqlite store next to the index.

Community detection runs over the *whole local graph* (which includes
both my own assertions and any subscribed peers' published subjects).
Summarisation results are written back into the local perspective; they
can be published if useful, but typically each peer maintains their own
community view.

The Ingest API is intentionally generic — it doesn't care what the text
is about or where it came from:

```typescript
export interface IngestApi {
  append(input: {
    documentId: string          // caller-chosen, stable
    text: string
    metadata?: Record<string, unknown>
    assertedBy: AgentRef
  }): Promise<{
    entitiesExtracted: number
    relationshipsExtracted: number
    claimsExtracted: number
  }>

  /** Force-rebuild from cache for a document — e.g. after a prompt change. */
  reextract(documentId: string): Promise<void>

  /** Remove a document and any extractions whose ONLY support was this document. */
  retract(documentId: string): Promise<void>
}
```

---

## Query Engine

Two modes behind one API. Provenance filters applied at every retrieval
step.

```typescript
export interface QueryEngine {
  query(opts: {
    question: string
    mode?: 'local' | 'global' | 'auto'
    fromAgents?: AgentRef[]
    fromPerspectives?: string[]
    maxTokens?: number
  }): Promise<QueryResult>
}

export interface QueryResult {
  answer: string
  mode: 'local' | 'global'
  citations: Array<
    | { kind: 'chunk'; chunkId: string; documentId: string; snippet: string }
    | { kind: 'entity'; uri: string; name: string }
    | { kind: 'community'; uri: string; level: number }
  >
  trace: QueryTrace
}
```

**Auto-mode classifier** picks `global` vs `local` from question shape:
broad/structural cues ("what are", "overall", "themes", "across",
"summarise") → global; otherwise → local. Deterministic rule-set;
explicit override always wins.

### Local mode flow

1. Embed query → `vectorSearchEntities(emb, k)` with provenance filter.
2. Walk `listRelationships` two hops from each hit (weight-biased,
   bounded fanout).
3. Pull supporting `Chunk`s via `getChunks`.
4. Assemble context within `maxTokens` budget.
5. Single LLM call → answer + structured citations.

### Global mode flow

1. Embed query → `vectorSearchCommunities(emb, k, level=top)`.
2. Per-community LLM call: "given this community summary, answer the
   question". Returns partial answer + relevance score.
3. Reduce: sort partials by score, take top-N within token budget, one
   final LLM synthesis call.
4. Citations include the contributing community URIs and any entity
   URIs explicitly referenced in the partials.

---

## Provenance & Trust

A single principle: **trust is a query-time decision, not an
extraction-time one.**

- Every record carries `assertedBy: AgentRef[]`.
- When the same Entity is asserted by multiple agents, their DIDs
  accumulate. The Entity isn't owned by anyone.
- Query-time filters (`fromAgents`, `fromPerspectives`) restrict
  retrieval to only assertions matching those constraints. They apply at
  every retrieval step — vector search, graph walk, community lookup.
- Conflicting Claims (`claim.contradicts`) coexist. The query engine
  surfaces both in citations.
- No automatic trust scoring. The engine surfaces; the caller (or
  human) judges.

This is the design that makes AD4M backing meaningful. Without it,
shared perspectives would force a single canonical view. With it,
disagreement is information.

---

## Sharing & Publication

Publication is per-URI, opt-in, and reversible.

- The library owns one **private** perspective per host application (auto-
  created on first run). All extractions write here. Nothing leaves
  this perspective unless explicitly published.
- `publishToPerspective(uri, perspectiveUuid)` adds the subject's
  structural Links to a named shared perspective via batched `addLinks`.
  The private copy remains.
- `unpublishFromPerspective(uri, perspectiveUuid)` removes the published
  Links. The private copy is untouched.
- **Inbound subjects** from configured shared perspectives reconcile
  into the local sqlite index on every connect + on every
  perspective-change event. The library subscribes via the host-provided
  `Ad4mClient`.
- Inbound contradicting Claims accepted; the query engine surfaces both
  in citations when retrieved.

Default policy: nothing is auto-published. Explicit calls only.

---

## Optional MCP Tool Surface

For consumers using the Model Context Protocol, the library exports a
tool factory. The host application is responsible for registering the
tools into its MCP server — `ad4m-rag` does not depend on any MCP
runtime.

```typescript
// Returned by createMcpToolFactory(store, ingest, query) — a shape the
// host application can hand to its MCP server. The library is the
// authority on schema; the host owns transport.
{
  knowledge_query({ question, mode?, fromAgents?, fromPerspectives?, maxTokens? })
  knowledge_get_entity({ uriOrName })
  knowledge_list_communities({ level? })
  knowledge_ingest({ documentId, text, metadata?, assertedBy })
  knowledge_reextract({ documentId })
  knowledge_retract({ documentId })
  knowledge_publish({ uri, perspectiveUuid })
  knowledge_unpublish({ uri, perspectiveUuid })
  knowledge_who_asserted({ uri })
}
```

`knowledge_ingest` is not the primary ingestion path — host applications
call the in-process `IngestApi` directly. The MCP tool exists for
ad-hoc ingestion of pasted text from an agent session.

---

## Library Boundary

What `@hexafield/ad4m-rag` depends on:

| Dep | Why |
|---|---|
| `@coasys/ad4m` | AD4M client manager + perspective helpers. Provided by the host as a peer dep (see below). |
| `better-sqlite3` | Local index. Synchronous API simplifies the ingest pipeline. |
| `sqlite-vec` | Vector storage and ANN search. |
| `graphology` + `graphology-communities-leiden` | Leiden community detection. |
| A configurable embedding client | Default: Ollama HTTP. Pluggable. |
| A configurable extraction LLM client | Default: Anthropic. Pluggable. |

What `@hexafield/ad4m-rag` does NOT depend on:

- Any MCP runtime. The MCP tool factory is exported; the host wires it.
- Any specific application framework (Express, Fastify, Electron, etc.).
- Any specific Sovereign / Atlas / Coasys package.

`@coasys/ad4m` is declared as a **peer dependency** so the host
application's AD4M client instance is shared with this library — no
duplicate Holochain connections, no schema mismatches.

The library is buildable, testable, and runnable standalone: a single
script that points it at a local AD4M executor + a SQLite path + an
embedding URL + an extraction LLM key should ingest a corpus and
answer queries. Lifting it into Coasys later requires no Sovereign-
internal unwinding because there is none.

---

## Requirements

The library ships as one cohesive package. Requirements are flat, no
phases.

### R1. Package skeleton

- Single-package TypeScript repo (not a monorepo).
- Public exports from `src/index.ts`.
- Subpath exports if needed for tree-shaking; otherwise single entry.
- `@coasys/ad4m` declared as a peer dependency.
- vitest configured; tsc emits `dist/`.

### R2. Data model + URI scheme

- Entity, Relationship, Claim, Community, Chunk, AgentRef as defined
  above, exported from package root.
- Content-hashed URI scheme (`entity:<sha256>`, `relationship:<sha256>`,
  `claim:<sha256>`, `community:<sha256>`, `chunk:<sha256>`).
- Identity merge: two Entities with identical canonical (type,
  lowercased trimmed name) collapse to one record with merged
  `assertedBy` + `sourceChunkIds`.

### R3. KnowledgeGraphStore

- Single interface as defined.
- All async, all upserts idempotent.
- AD4M writes batched via `addLinks` (default batch size 50).
- Vector + FTS reads against the local sqlite index.
- `reindex()` drops and rebuilds the local index from AD4M.

### R4. Subject classes

- SHACL Subject classes for Entity, Relationship, Claim, Community
  defined in the library.
- On store init, ensured to exist in the private + every configured
  shared perspective.
- Versioned so consumers can detect schema changes between library
  versions.

### R5. Local index

- `better-sqlite3` + `sqlite-vec` + `FTS5` virtual tables for entity
  descriptions and claim statements.
- Schema versioned; on version bump the index is dropped and rebuilt
  from AD4M.
- Path provided by the host application (no defaults baked in).

### R6. Ingestion pipeline

- `IngestApi.append({ documentId, text, metadata?, assertedBy })`
  performs: chunk → embed-chunks → extract → embed-entities → upsert.
- Each stage content-hash-cached in the local sqlite store.
- Pluggable embedding client (interface: `embed(text: string): Promise<number[]>`).
- Pluggable extraction LLM client (interface:
  `extract(prompt: string): Promise<ExtractionResult>`).
- `reextract(documentId)` invalidates only the extraction cache for that
  document then re-runs post-extraction stages.
- `retract(documentId)` removes the document; any extraction whose ONLY
  support was that document is removed; otherwise the document's chunk
  ids are stripped from `sourceChunkIds`.

### R7. Community detection + summarisation

- Leiden detection over the whole local graph via
  `graphology-communities-leiden`. Multi-level (default 3 levels).
- Per-community report generated by the extraction LLM, cached by
  member-set hash.
- Community embeddings produced and indexed.
- Configurable trigger: end of any ingest batch larger than N entities
  (default 25).

### R8. Query engine

- `query({ question, mode?, fromAgents?, fromPerspectives?, maxTokens? })`
  returning `QueryResult`.
- Local mode: embed → vectorSearchEntities → 2-hop walk → context
  assemble → LLM answer.
- Global mode: vectorSearchCommunities (top level) → per-community
  partial answer → score + reduce → final synthesis.
- Auto-mode classifier (rule-based) selects local vs global; explicit
  override always wins.
- Provenance filters applied at every retrieval step.

### R9. Provenance & trust filters

- `assertedBy: AgentRef[]` carried through every record.
- `fromAgents` / `fromPerspectives` filters honoured at retrieval.
- `knowledge_who_asserted(uri)` returns the full list.
- No automatic trust scoring.

### R10. Sharing & publication

- `publishToPerspective(uri, perspectiveUuid)` / `unpublish...` promote
  / demote a single subject's presence in a named perspective.
- Local private copy unaffected by either op.
- Inbound subjects from configured shared perspectives reconciled into
  the local index on connect + on perspective-change events.
- Inbound contradicting Claims accepted without resolution.

### R11. Optional MCP tool factory

- `createMcpToolFactory(store, ingest, query)` returns the tool
  definitions described above.
- No runtime dependency on any specific MCP SDK; the library produces
  the *shape* the host registers.

### R12. Host integration surface

- A single `createAd4mRag(deps)` factory composes store + ingest +
  query + MCP factory.
- `deps` includes: `ad4mClient` (peer-provided), `sqlitePath`, embedding
  client, extraction LLM client, configured shared perspective UUIDs,
  optional batch sizes and triggers.

### R13. Tests

- Unit: identity merge, URI hashing, content-hash cache invalidation,
  auto-mode classifier, provenance filter behaviour.
- Integration (sqlite layer only): ingest → query round-trip on a 5-doc
  fixture corpus, community detection produces stable communities
  across runs.
- Integration (AD4M layer, opt-in): publish → unpublish round-trip
  against a mock-AD4M client. Real-AD4M integration tests gated behind
  an env flag.
- MCP tool layer: each tool invoked end-to-end against an in-memory
  store + ingest + query stack.

---

## Open Questions

1. **Embedding model default.** Ollama `nomic-embed-text` (768-dim, fast,
   widely available) is the obvious starting point. Should the
   interface be sync or async? Async — model can be remote.

2. **Extraction LLM default.** Claude Sonnet or Haiku. Cheaper model
   for bulk extraction probably wins; extraction cost dominates
   ingestion budget at scale.

3. **Chunking strategy.** Fixed-size with overlap (GraphRAG default) or
   semantic chunking (slower, better quality)? Start with fixed; the
   interface accepts either.

4. **Subject-class versioning.** When the library updates a Subject
   class, what happens to existing perspectives? Probably an
   `ensureSubjectClasses({ migrate: 'add-only' | 'breaking-ok' })` flag
   on store init.

5. **Encryption / visibility within a published perspective.** AD4M
   perspectives are either private (local Holochain) or shared into a
   neighbourhood (gossiped). Per-link visibility controls are not
   first-class. For now: publish at the subject granularity; the
   subject either is or isn't in the perspective.

6. **Multi-language extraction.** Different extraction prompts per
   language? Single prompt that handles all? Defer — single English
   prompt for v1, language detection layer later.

7. **Holochain DHT throughput.** GraphRAG ingestion can generate
   hundreds of entities and thousands of links per document. AD4M's
   write throughput on Holochain DHT is unknown at this scale. Worth
   an early benchmark; may need a "buffer locally, batch-publish on
   schedule" mode.

---

## Out of Scope

- A UI for browsing the knowledge graph. The data is available via the
  `KnowledgeGraphStore` and `QueryEngine` APIs; UI is downstream.
- A multi-tenant SaaS deployment of the library. Out of scope; the
  library is single-tenant by design and runs in-process with the host.
- Replacing organisation-internal knowledge bases. The library composes
  with them — they can be ingested as documents — but doesn't try to
  substitute.
