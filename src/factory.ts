// Single entry-point factory — composes the sqlite index, AD4M store,
// ingest pipeline, query engine, and MCP tool factory into one object
// the host can hand around.

import type { Ad4mClient } from '@coasys/ad4m'
import type { EmbeddingClient } from './clients/embedding.js'
import type { LlmClient } from './clients/llm.js'
import { createIngestApi, type IngestApi } from './ingest/pipeline.js'
import { createIngestCache } from './ingest/cache.js'
import { createExtractor, type ExtractorOptions } from './ingest/extractor.js'
import { rebuildCommunities, type RebuildCommunitiesResult } from './community/index.js'
import { createMcpToolFactory, type McpToolFactory } from './mcp.js'
import { createQueryEngine, type QueryEngine, type QueryEngineDeps } from './query/index.js'
import { createSqliteIndex } from './sqlite/index.js'
import { createKnowledgeGraphStore, type KnowledgeGraphStore } from './store.js'

export interface CreateAd4mRagDeps {
  /** Sqlite path. ':memory:' for an in-memory store. */
  sqlitePath: string
  /** Embedding client. */
  embeddings: EmbeddingClient
  /** LLM client used for extraction and query answers. */
  llm: LlmClient
  /** Already-authenticated Ad4mClient instance from the host. */
  ad4mClient: Ad4mClient
  /** Private perspective uuid the store writes into. Must exist. */
  privatePerspectiveUuid: string
  /** Optional set of shared perspectives whose subjects are reconciled into the local index. */
  sharedPerspectiveUuids?: string[]
  /** Optional extraction prompt knobs. */
  extractor?: ExtractorOptions
  /** Optional query engine knobs. */
  query?: Omit<QueryEngineDeps, 'sqlite' | 'embeddings' | 'llm'>
  /** Default AgentRef used by `knowledge_ingest` MCP tool when caller omits assertedBy. */
  defaultAssertedBy?: { did: string; label?: string }
}

export interface Ad4mRag {
  store: KnowledgeGraphStore
  ingest: IngestApi
  query: QueryEngine
  mcp: McpToolFactory
  /** Run community detection + summarisation over the current graph. */
  rebuildCommunities(): Promise<RebuildCommunitiesResult>
  dispose(): Promise<void>
}

export function createAd4mRag(deps: CreateAd4mRagDeps): Ad4mRag {
  const sqlite = createSqliteIndex({
    path: deps.sqlitePath,
    embeddingDimension: deps.embeddings.dimension()
  })
  const cache = createIngestCache(sqlite)
  const extractor = createExtractor(deps.llm, deps.extractor)

  const store = createKnowledgeGraphStore({
    sqlite,
    embeddings: deps.embeddings,
    ad4m: {
      client: deps.ad4mClient,
      privatePerspectiveUuid: deps.privatePerspectiveUuid,
      sharedPerspectiveUuids: deps.sharedPerspectiveUuids
    }
  })

  const ingest = createIngestApi({
    sqlite,
    embeddings: deps.embeddings,
    extractor,
    cache
  })

  const query = createQueryEngine({
    sqlite,
    embeddings: deps.embeddings,
    llm: deps.llm,
    ...(deps.query ?? {})
  })

  const mcp = createMcpToolFactory({
    store,
    ingest,
    query,
    defaultAssertedBy: deps.defaultAssertedBy
  })

  return {
    store,
    ingest,
    query,
    mcp,
    async rebuildCommunities() {
      return await rebuildCommunities({
        sqlite,
        llm: deps.llm,
        embeddings: deps.embeddings,
        cache
      })
    },
    async dispose() {
      await store.dispose()
    }
  }
}
