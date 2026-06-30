# ad4m-rag

GraphRAG-style knowledge extraction and query, backed by [AD4M](https://github.com/coasys/ad4m) perspectives.

## What this is

Vector RAG can't answer "what are the themes across my corpus?" — no single chunk holds the answer. This library follows the [GraphRAG](https://microsoft.github.io/graphrag/) approach: an LLM extracts a typed knowledge graph (entities, relationships, claims with provenance) from any ingested text, the graph is hierarchically clustered with Leiden community detection, per-community summaries are generated, and queries pick between **local** mode (vector hit → graph walk) and **global** mode (map-reduce over community summaries).

The structural graph lives in AD4M perspectives. Embeddings and search indexes live in a local SQLite + sqlite-vec index keyed by AD4M URIs. Same query engine, full P2P sharing properties.

## Why AD4M-backed

Most knowledge graphs are organisation-shaped: a single team owns the graph, decides what's true, and pays the storage. This library treats the graph as something multiple agents can contribute to over a P2P substrate, with **provenance as a first-class field on every record** (entity, relationship, claim). The wins:

- **Per-claim provenance.** Every assertion carries the DID of the agent that made it. Queries filter by source: "only my own claims", "only the Coasys-team perspective", "claims with at least 3 independent assertions".
- **Selective publication.** Local extraction is private by default. Publish individual entities, relationships, or claims into named neighbourhoods; the local copy stays.
- **Disagreement is first-class.** Conflicting claims coexist with their `assertedBy` sets. The query engine surfaces both in citations; the caller (or human) judges.
- **Composable across communities.** The same query engine reads from any union of (local) + (subscribed neighbourhood perspectives). Knowledge commons without centralisation.

## Status

**Planning.** No implementation yet. The full design is in [PLAN.md](./PLAN.md).

The repo is being prototyped under [@hexafield](https://github.com/HexaField) while the architecture settles. The intent is to move it to [@coasys](https://github.com/coasys) once the design is proven.

## License

MIT — see [LICENSE](./LICENSE).
