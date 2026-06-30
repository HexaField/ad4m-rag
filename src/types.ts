// Core data model. See PLAN.md.

import type { CellId } from '@hexafield/hexevent'

export type EntityType = string
export type RelationType = string

/**
 * One filled cell of the 12-cell 5W1H × subjective/objective ontology.
 *
 * Each cell belongs to a Claim and decomposes a single aspect of the
 * claim into a typed filler. Per the underlying metaphysics, a Claim
 * with some cells empty isn't using a partial ontology — it's reporting
 * partial information, and the empty cells are an explicit statement of
 * what hasn't been observed.
 *
 * See `@hexafield/hexevent` for the cell vocabulary, the metaphysical
 * grounding, and the per-cell AD4M Subject classes used on the wire.
 */
export interface CellAssignment {
  /** Content-hashed cell-assignment URI: `cellassignment:<sha256(claim|cellId|filler)>`. */
  uri: string
  /** URI of the Claim this assignment belongs to. */
  claimUri: string
  /** The cell this assignment populates — e.g. 'who·objective'. */
  cell: CellId
  /** The value being asserted for that cell. */
  filler: string
  /** Optional IRI of a typed concept the filler resolves to. */
  conceptIri?: string
  /** Optional provenance hint (free-form string). */
  source?: string
}

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

/**
 * Factual statement about an entity.
 *
 * Every claim carries a `cells` array decomposing its propositional
 * content across the twelve 5W1H × subjective/objective cells. Partial
 * population is the norm — the empty cells are themselves informative.
 * The `statement` string remains the human-readable summary.
 */
export interface Claim {
  uri: string
  about: string
  statement: string
  cells: CellAssignment[]
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

/** Raw cell assignment produced by the extractor before identity-hashing. */
export interface ExtractedCellAssignment {
  cell: CellId
  filler: string
  conceptIri?: string
  source?: string
}

export interface ExtractedClaim {
  about: { type: EntityType; name: string }
  statement: string
  /** Per-cell decomposition of the claim. May be empty. */
  cells: ExtractedCellAssignment[]
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  relationships: ExtractedRelationship[]
  claims: ExtractedClaim[]
}
