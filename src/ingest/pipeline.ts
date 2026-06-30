// Ingestion pipeline orchestrator.
//
// Stages (each content-hash cached):
//   1. chunk(text)                           → chunks[]
//   2. embedChunks(chunks)                   → chunk embeddings
//   3. extract(chunks)                       → entities, relationships, claims
//   4. embedEntities(entities)               → entity embeddings
//   5. write through to KnowledgeGraphStore
//
// The store decides where the structural records actually land (AD4M or
// no-op) and is responsible for identity merging.

import { mergeClaim, mergeEntity, mergeRelationship } from '../identity.js'
import { canonicalEntityKey, cellAssignmentUri, chunkUri, claimUri, entityUri, relationshipUri } from '../uri.js'
import type {
  AgentRef,
  CellAssignment,
  Chunk,
  Claim,
  Entity,
  ExtractedCellAssignment,
  ExtractionResult,
  Relationship
} from '../types.js'
import type { EmbeddingClient } from '../clients/embedding.js'
import type { SqliteIndex } from '../sqlite/index.js'
import { hashInputs, type IngestCache } from './cache.js'
import { chunkText, type ChunkerOptions } from './chunker.js'

export interface IngestAppendInput {
  documentId: string
  text: string
  metadata?: Record<string, unknown>
  assertedBy: AgentRef
}

export interface IngestAppendResult {
  entitiesExtracted: number
  relationshipsExtracted: number
  claimsExtracted: number
}

export interface Extractor {
  extract(passage: string): Promise<ExtractionResult>
}

export interface IngestApi {
  append(input: IngestAppendInput): Promise<IngestAppendResult>
  reextract(documentId: string): Promise<void>
  retract(documentId: string): Promise<void>
}

export interface IngestDeps {
  sqlite: SqliteIndex
  embeddings: EmbeddingClient
  extractor: Extractor
  cache: IngestCache
  chunker?: ChunkerOptions
}

export function createIngestApi(deps: IngestDeps): IngestApi {
  const chunkerOpts = deps.chunker
  void deps.cache // (kept on the dep bag for future use; pipeline uses sqlite cache directly via hashInputs)

  async function append(input: IngestAppendInput): Promise<IngestAppendResult> {
    const { documentId, text, assertedBy } = input

    // 1. Chunking.
    const slices = chunkText(text, chunkerOpts)
    const chunks: Chunk[] = slices.map((s) => ({
      id: chunkUri(s.text),
      documentId,
      text: s.text,
      position: { start: s.start, end: s.end }
    }))

    for (const ch of chunks) deps.sqlite.upsertChunk(ch)

    // 2. Embed chunks (cached per chunk text).
    const toEmbedTexts: string[] = []
    const toEmbedIndexes: number[] = []
    const embeddings: (number[] | undefined)[] = new Array(chunks.length)
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i]
      const cached = deps.cache.get<number[]>('chunk-embed', ch.id)
      if (cached && cached.length === deps.embeddings.dimension()) {
        embeddings[i] = cached
      } else {
        toEmbedTexts.push(ch.text)
        toEmbedIndexes.push(i)
      }
    }
    if (toEmbedTexts.length > 0) {
      const fresh = await deps.embeddings.embedBatch(toEmbedTexts)
      for (let j = 0; j < fresh.length; j++) {
        const idx = toEmbedIndexes[j]
        embeddings[idx] = fresh[j]
        deps.cache.set('chunk-embed', chunks[idx].id, fresh[j])
      }
    }
    for (let i = 0; i < chunks.length; i++) {
      const emb = embeddings[i]
      if (emb) deps.sqlite.storeChunkEmbedding(chunks[i].id, emb)
    }

    // 3. Extraction per chunk (cached on chunk id, since chunk text → id is a hash).
    let totalEntities = 0
    let totalRelationships = 0
    let totalClaims = 0
    for (const ch of chunks) {
      const cacheKey = hashInputs(ch.id, 'v1')
      let result = deps.cache.get<ExtractionResult>('extract', cacheKey)
      if (!result) {
        result = await deps.extractor.extract(ch.text)
        deps.cache.set('extract', cacheKey, result)
      }
      const { entitiesUpserted, relsUpserted, claimsUpserted } = await applyExtraction(
        result,
        ch.id,
        assertedBy,
        deps
      )
      totalEntities += entitiesUpserted
      totalRelationships += relsUpserted
      totalClaims += claimsUpserted
    }

    return {
      entitiesExtracted: totalEntities,
      relationshipsExtracted: totalRelationships,
      claimsExtracted: totalClaims
    }
  }

  async function reextract(documentId: string): Promise<void> {
    const chunks = deps.sqlite.listChunksByDocument(documentId)
    if (chunks.length === 0) return
    // Force re-extraction by invalidating per-chunk extract cache.
    for (const ch of chunks) {
      const cacheKey = hashInputs(ch.id, 'v1')
      deps.cache.set('extract', cacheKey, null as unknown as ExtractionResult)
    }
    // Reconstruct ordered source text — chunks were chunked from contiguous
    // text and stored with positions, so sorted concatenation reproduces the
    // input modulo overlap. Overlap is fine for re-extraction (idempotent at
    // the identity-merge layer).
    const orderedText = chunks
      .slice()
      .sort((a, b) => a.position.start - b.position.start)
      .map((c) => c.text)
      .join('\n')
    // The caller-original DID isn't retrievable here. Host should re-issue
    // append() with the real DID if provenance must be preserved exactly.
    const placeholder: AgentRef = { did: 'did:reextract:synthetic' }
    await append({ documentId, text: orderedText, assertedBy: placeholder })
  }

  async function retract(documentId: string): Promise<void> {
    const removedIds = deps.sqlite.deleteChunksByDocument(documentId)
    if (removedIds.length === 0) return
    deps.sqlite.stripChunkRefsFromEntities(removedIds)
    deps.sqlite.stripChunkRefsFromRelationships(removedIds)
    deps.sqlite.stripChunkRefsFromClaims(removedIds)
    deps.sqlite.deleteOrphanedEntities()
    deps.sqlite.deleteOrphanedRelationships()
    deps.sqlite.deleteOrphanedClaims()
  }

  return { append, reextract, retract }
}

/** Take an ExtractionResult and an asserting AgentRef, upsert everything into the store. */
async function applyExtraction(
  result: ExtractionResult,
  chunkId: string,
  assertedBy: AgentRef,
  deps: IngestDeps
): Promise<{ entitiesUpserted: number; relsUpserted: number; claimsUpserted: number }> {
  const now = Date.now()
  let entitiesUpserted = 0
  let relsUpserted = 0
  let claimsUpserted = 0

  // ── Entities ──────────────────────────────────────────────────
  // Build the canonical map first so relationships can resolve names → URIs.
  const nameToUri = new Map<string, string>()
  const entitiesToEmbed: { uri: string; name: string; description: string }[] = []
  for (const e of result.entities) {
    const uri = entityUri(e.type, e.name)
    nameToUri.set(canonicalEntityKey(e.type, e.name), uri)
    const incoming: Omit<Entity, 'createdAt' | 'updatedAt'> = {
      uri,
      type: e.type,
      name: e.name,
      description: e.description,
      aliases: e.aliases,
      assertedBy: [assertedBy],
      sourceChunkIds: [chunkId]
    }
    const existing = deps.sqlite.getEntity(uri)
    const merged = existing
      ? mergeEntity(existing, incoming)
      : { ...incoming, createdAt: now, updatedAt: now }
    deps.sqlite.upsertEntity(merged)
    entitiesToEmbed.push({ uri: merged.uri, name: merged.name, description: merged.description })
    entitiesUpserted++
  }

  // Embed entities (cached per uri+description).
  const toEmbedTexts: string[] = []
  const toEmbedUris: string[] = []
  for (const e of entitiesToEmbed) {
    const key = hashInputs(e.uri, e.description)
    const cached = deps.cache.get<number[]>('entity-embed', key)
    if (cached && cached.length === deps.embeddings.dimension()) {
      deps.sqlite.storeEntityEmbedding(e.uri, cached)
    } else {
      toEmbedTexts.push(`${e.name}: ${e.description}`)
      toEmbedUris.push(e.uri)
    }
  }
  if (toEmbedTexts.length > 0) {
    const fresh = await deps.embeddings.embedBatch(toEmbedTexts)
    for (let i = 0; i < fresh.length; i++) {
      const uri = toEmbedUris[i]
      const entity = entitiesToEmbed.find((e) => e.uri === uri)!
      const key = hashInputs(uri, entity.description)
      deps.cache.set('entity-embed', key, fresh[i])
      deps.sqlite.storeEntityEmbedding(uri, fresh[i])
    }
  }

  // ── Relationships ──────────────────────────────────────────────
  for (const r of result.relationships) {
    const srcUri = nameToUri.get(canonicalEntityKey(r.source.type, r.source.name)) ?? entityUri(r.source.type, r.source.name)
    const tgtUri = nameToUri.get(canonicalEntityKey(r.target.type, r.target.name)) ?? entityUri(r.target.type, r.target.name)
    // If the entity wasn't in the same extraction, create a stub.
    if (!deps.sqlite.getEntity(srcUri)) {
      deps.sqlite.upsertEntity({
        uri: srcUri,
        type: r.source.type,
        name: r.source.name,
        description: '',
        aliases: [],
        assertedBy: [assertedBy],
        sourceChunkIds: [chunkId],
        createdAt: now,
        updatedAt: now
      })
      entitiesUpserted++
    }
    if (!deps.sqlite.getEntity(tgtUri)) {
      deps.sqlite.upsertEntity({
        uri: tgtUri,
        type: r.target.type,
        name: r.target.name,
        description: '',
        aliases: [],
        assertedBy: [assertedBy],
        sourceChunkIds: [chunkId],
        createdAt: now,
        updatedAt: now
      })
      entitiesUpserted++
    }
    const uri = relationshipUri(srcUri, r.predicate, tgtUri)
    const incoming: Omit<Relationship, 'createdAt'> = {
      uri,
      source: srcUri,
      predicate: r.predicate,
      target: tgtUri,
      description: r.description,
      weight: r.weight,
      assertedBy: [assertedBy],
      sourceChunkIds: [chunkId]
    }
    // We don't have a getRelationship — use listRelationships with the uri.
    const existing = deps.sqlite.listRelationships({ source: srcUri, predicate: r.predicate, target: tgtUri })[0]
    const merged = existing ? mergeRelationship(existing, incoming) : { ...incoming, createdAt: now }
    deps.sqlite.upsertRelationship(merged)
    relsUpserted++
  }

  // ── Claims ────────────────────────────────────────────────────
  for (const c of result.claims) {
    const aboutUri = nameToUri.get(canonicalEntityKey(c.about.type, c.about.name)) ?? entityUri(c.about.type, c.about.name)
    if (!deps.sqlite.getEntity(aboutUri)) {
      deps.sqlite.upsertEntity({
        uri: aboutUri,
        type: c.about.type,
        name: c.about.name,
        description: '',
        aliases: [],
        assertedBy: [assertedBy],
        sourceChunkIds: [chunkId],
        createdAt: now,
        updatedAt: now
      })
      entitiesUpserted++
    }
    const uri = claimUri(aboutUri, c.statement)
    const cells = materialiseCells(uri, c.cells)
    const incoming: Omit<Claim, 'createdAt'> = {
      uri,
      about: aboutUri,
      statement: c.statement,
      cells,
      evidenceChunkIds: [chunkId],
      assertedBy: [assertedBy]
    }
    const existing = deps.sqlite.getClaim(uri)
    const merged = existing ? mergeClaim(existing, incoming) : { ...incoming, createdAt: now }
    deps.sqlite.upsertClaim(merged)
    claimsUpserted++
  }

  return { entitiesUpserted, relsUpserted, claimsUpserted }
}

/**
 * Promote `ExtractedCellAssignment` entries (no URI yet, no claim back-ref)
 * into `CellAssignment` records keyed off the parent claim's URI. Duplicate
 * (cell, normalised filler) pairs collapse via the URI hash.
 */
function materialiseCells(
  claimUriValue: string,
  cells: ExtractedCellAssignment[] | undefined
): CellAssignment[] {
  const byUri = new Map<string, CellAssignment>()
  for (const c of cells ?? []) {
    const uri = cellAssignmentUri(claimUriValue, c.cell, c.filler)
    // Last write wins on conceptIri / source — the extractor produces one row
    // per LLM-emitted cell, and identical (claim, cell, filler) records
    // should overwrite each other rather than create duplicates.
    byUri.set(uri, {
      uri,
      claimUri: claimUriValue,
      cell: c.cell,
      filler: c.filler,
      conceptIri: c.conceptIri,
      source: c.source
    })
  }
  return [...byUri.values()]
}

