// @hexafield/ad4m-rag — public surface.
//
// See README.md and PLAN.md for the design.

export const VERSION = '0.0.0'

// ── Data model ────────────────────────────────────────────────────
export type {
  AgentRef,
  Chunk,
  Citation,
  Claim,
  Community,
  Entity,
  EntityType,
  ExtractedClaim,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
  ProvenanceFilter,
  QueryResult,
  QueryTrace,
  RelationType,
  Relationship
} from './types.js'

// ── URI scheme + identity merge ───────────────────────────────────
export { canonicalEntityKey, chunkUri, claimUri, communityUri, entityUri, relationshipUri, uriKind, type UriKind } from './uri.js'
export { mergeAgents, mergeClaim, mergeEntity, mergeIds, mergeRelationship } from './identity.js'

// ── Storage layer ─────────────────────────────────────────────────
export { createSqliteIndex, type SqliteIndex, type SqliteIndexOptions } from './sqlite/index.js'
export { SCHEMA_VERSION } from './sqlite/schema.js'

// ── Clients ───────────────────────────────────────────────────────
export {
  createOllamaEmbeddingClient,
  cosineSimilarity,
  type EmbeddingClient,
  type OllamaEmbeddingOptions
} from './clients/embedding.js'
export { createAnthropicLlmClient, type AnthropicLlmOptions, type LlmClient } from './clients/llm.js'

// ── Ingestion ─────────────────────────────────────────────────────
export { chunkText, type ChunkerOptions, type ChunkSlice } from './ingest/chunker.js'
export { createExtractor, parseExtractionResponse, type ExtractorOptions } from './ingest/extractor.js'
export { createIngestApi, type IngestApi, type IngestAppendInput, type IngestAppendResult, type IngestDeps, type Extractor } from './ingest/pipeline.js'
export { createIngestCache, hashInputs, type CacheStage, type IngestCache } from './ingest/cache.js'

// ── Community detection ───────────────────────────────────────────
export {
  createCommunitySummariser,
  detectHierarchy,
  rebuildCommunities,
  type DetectOptions,
  type DetectedLevel,
  type RebuildCommunitiesDeps,
  type RebuildCommunitiesResult,
  type SummariseOptions
} from './community/index.js'

// ── Query engine ──────────────────────────────────────────────────
export {
  classifyQueryMode,
  createQueryEngine,
  type QueryEngine,
  type QueryEngineDeps,
  type QueryRequest
} from './query/index.js'

// ── AD4M layer ────────────────────────────────────────────────────
export { createAd4mFacade, type Ad4mClientFacade } from './ad4m/client.js'
export { parseLinks, type LinkLike } from './ad4m/parse.js'
export { entityToLinks, relationshipToLinks, claimToLinks, communityToLinks } from './ad4m/serialise.js'
export * as predicates from './ad4m/predicates.js'

// ── Store ─────────────────────────────────────────────────────────
export { createKnowledgeGraphStore, type KnowledgeGraphStore, type KnowledgeGraphStoreDeps } from './store.js'

// ── MCP tool factory ──────────────────────────────────────────────
export { createMcpToolFactory, type McpTool, type McpToolDeps, type McpToolFactory } from './mcp.js'

// ── Entry-point factory ───────────────────────────────────────────
export { createAd4mRag, type Ad4mRag, type CreateAd4mRagDeps } from './factory.js'
