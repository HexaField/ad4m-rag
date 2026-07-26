// Core data model. See PLAN.md.

export type EntityType = string
export type RelationType = string

/** Reference to an agent (DID) that asserted something. */
export interface AgentRef {
  did: string
  /** Optional human-readable label. Not used for identity. */
  label?: string
}

/** Typed node in the knowledge graph. Identity is canonical (type, lower-cased trimmed name). */
export interface Entity {
  uri: string
  type: EntityType
  name: string
  description: string
  aliases?: string[]
  assertedBy: AgentRef[]
  sourceChunkIds: string[]
  createdAt: number
  updatedAt: number
}

/** Typed edge in the knowledge graph. */
export interface Relationship {
  uri: string
  source: string
  predicate: RelationType
  target: string
  description: string
  /** LLM-judged salience in [0, 1]. */
  weight: number
  assertedBy: AgentRef[]
  sourceChunkIds: string[]
  createdAt: number
}

/** Factual statement about an entity. */
export interface Claim {
  uri: string
  about: string
  statement: string
  evidenceChunkIds: string[]
  assertedBy: AgentRef[]
  supports?: string[]
  contradicts?: string[]
  createdAt: number
}

/** Cluster of entities produced by community detection. */
export interface Community {
  uri: string
  /** 0 = leaf clusters; higher levels are broader clusters of clusters. */
  level: number
  parent?: string
  memberEntityUris: string[]
  /** LLM-generated community report. */
  summary: string
  createdAt: number
}

/** Original passage of text the extraction was performed on. */
export interface Chunk {
  id: string
  documentId: string
  text: string
  position: { start: number; end: number }
}

/** Filter applied at every retrieval step to scope reads by provenance. */
export interface ProvenanceFilter {
  fromAgents?: AgentRef[]
  fromPerspectives?: string[]
}

/** Structured trace returned alongside every query result. */
export interface QueryTrace {
  embeddingTokensApprox?: number
  retrievalK: number
  graphHops?: number
  communitiesConsidered?: number
  partialAnswers?: number
  llmCalls: number
  durationMs: number
}

/** Citation surfaced in a QueryResult. */
export type Citation =
  | { kind: 'chunk'; chunkId: string; documentId: string; snippet: string }
  | { kind: 'entity'; uri: string; name: string }
  | { kind: 'community'; uri: string; level: number }

/** Final answer + provenance trail returned by the query engine. */
export interface QueryResult {
  answer: string
  mode: 'local' | 'global'
  citations: Citation[]
  trace: QueryTrace
}

/** Raw extraction product before merging into the store. */
export interface ExtractedEntity {
  type: EntityType
  name: string
  description: string
  aliases?: string[]
}

export interface ExtractedRelationship {
  source: { type: EntityType; name: string }
  predicate: RelationType
  target: { type: EntityType; name: string }
  description: string
  weight: number
}

export interface ExtractedClaim {
  about: { type: EntityType; name: string }
  statement: string
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  relationships: ExtractedRelationship[]
  claims: ExtractedClaim[]
}
