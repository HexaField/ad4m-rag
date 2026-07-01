// SQLite-backed local index. Owns embeddings (via sqlite-vec), FTS5, the
// structural mirror of AD4M state, the content-hash cache used by the
// ingest pipeline, and the publication ledger.
//
// All reads against the structural tables hit this index for speed; the
// `reindex()` operation drops everything and rebuilds from AD4M.

import Database, { type Database as Db } from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import type {
  AgentRef,
  CellAssignment,
  Chunk,
  Claim,
  Community,
  Entity,
  ProvenanceFilter,
  Relationship
} from '../types.js'
import type { CellId } from '@hexafield/hexevent'
import { DDL, SCHEMA_VERSION } from './schema.js'

export interface SqliteIndexOptions {
  /** Path to the SQLite DB file, or ':memory:' for an in-memory index. */
  path: string
  /** Dimension of the embedding model. All vectors must match. */
  embeddingDimension: number
}

/**
 * Serialise an array of AgentRef into the JSON string we store in `asserted_by`.
 * The on-disk format is a flat array of `{ did, label? }`.
 */
const serialiseAgents = (agents: AgentRef[]): string => JSON.stringify(agents)
const parseAgents = (raw: string): AgentRef[] => {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

const serialiseIds = (ids: string[]): string => JSON.stringify(ids)
const parseIds = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// Turn arbitrary free text (entity names, user questions) into a safe FTS5
// MATCH expression. Raw text is NOT valid query syntax — hyphens, colons,
// quotes and '?' are all operators, so `fig-tree` throws "no such column:
// tree" and `Saturday?` throws a syntax error. We tokenise on non-word
// characters and OR each token as a quoted phrase, maximising recall (callers
// filter the results further). Returns null when there is nothing to match on.
const toFtsMatchQuery = (text: string): string | null => {
  const tokens = text.match(/[\p{L}\p{N}]+/gu)
  if (!tokens || tokens.length === 0) return null
  return tokens.map((t) => `"${t}"`).join(' OR ')
}

export interface SqliteIndex {
  // ── Structural upserts ────────────────────────────────────────
  upsertEntity(entity: Entity): void
  upsertRelationship(rel: Relationship): void
  upsertClaim(claim: Claim): void
  upsertCommunity(community: Community): void
  upsertChunk(chunk: Chunk): void

  // ── Structural reads ──────────────────────────────────────────
  getEntity(uri: string): Entity | null
  getClaim(uri: string): Claim | null
  getChunks(ids: string[]): Chunk[]
  listChunksByDocument(documentId: string): Chunk[]
  listRelationships(filter: {
    source?: string
    target?: string
    predicate?: string
    fromAgents?: AgentRef[]
    fromPerspectives?: string[]
  }): Relationship[]
  listCommunities(level?: number): Community[]
  /** All entity URIs currently in the index. Used by community detection. */
  allEntityUris(): string[]
  /** All relationships, used by community detection. */
  allRelationships(): Relationship[]
  /** Cells attached to a claim. */
  listCellAssignmentsByClaim(claimUri: string): CellAssignment[]
  /** Cells matching a filter, with provenance scoping applied to the parent claim. */
  listCellAssignments(filter: {
    cell?: CellId
    fillerLike?: string
    conceptIri?: string
    fromAgents?: AgentRef[]
    fromPerspectives?: string[]
  }): CellAssignment[]
  /** Claims whose cells match every term in `terms`. Each term constrains a single cell. */
  listClaimsByCell(
    terms: ReadonlyArray<{ cell: CellId; fillerLike?: string; conceptIri?: string }>,
    filter?: ProvenanceFilter
  ): Claim[]

  // ── Embeddings ────────────────────────────────────────────────
  storeEntityEmbedding(uri: string, vector: number[]): void
  storeChunkEmbedding(id: string, vector: number[]): void
  storeCommunityEmbedding(uri: string, vector: number[]): void
  vectorSearchEntities(query: number[], k: number, filter?: ProvenanceFilter): Entity[]
  vectorSearchChunks(query: number[], k: number, filter?: ProvenanceFilter): Chunk[]
  vectorSearchCommunities(query: number[], k: number, level?: number, filter?: ProvenanceFilter): Community[]

  // ── FTS ───────────────────────────────────────────────────────
  ftsSearchClaims(query: string, k: number, filter?: ProvenanceFilter): Claim[]

  // ── Publications ──────────────────────────────────────────────
  recordPublication(uri: string, perspectiveUuid: string): void
  recordUnpublication(uri: string, perspectiveUuid: string): void
  listPublications(uri: string): string[]

  // ── Ingest cache ──────────────────────────────────────────────
  cacheGet(stage: string, key: string): string | null
  cacheSet(stage: string, key: string, value: string): void

  // ── Deletion ──────────────────────────────────────────────────
  deleteChunksByDocument(documentId: string): string[]
  stripChunkRefsFromEntities(chunkIds: string[]): void
  stripChunkRefsFromRelationships(chunkIds: string[]): void
  stripChunkRefsFromClaims(chunkIds: string[]): void
  deleteOrphanedEntities(): number
  deleteOrphanedRelationships(): number
  /** Removes orphan claims AND their cell assignments (cells cascade via FK). */
  deleteOrphanedClaims(): number

  // ── Lifecycle ─────────────────────────────────────────────────
  /** Drop every table and rebuild empty schema. */
  reset(): void
  close(): void
}

export function createSqliteIndex(opts: SqliteIndexOptions): SqliteIndex {
  const db: Db = new Database(opts.path)
  sqliteVec.load(db)

  // Schema bootstrap.
  for (const stmt of DDL) db.exec(stmt)
  // Embedding virtual tables — column count depends on the configured dim.
  const dim = opts.embeddingDimension
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_entities USING vec0(uri TEXT PRIMARY KEY, embedding FLOAT[${dim}])`)
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dim}])`)
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_communities USING vec0(uri TEXT PRIMARY KEY, embedding FLOAT[${dim}])`)

  // Schema version check.
  const meta = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as { value?: string } | undefined
  if (!meta) {
    db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', ?)`).run(String(SCHEMA_VERSION))
  } else if (meta.value !== String(SCHEMA_VERSION)) {
    throw new Error(
      `sqlite index schema mismatch: file is at version ${meta.value}, library expects ${SCHEMA_VERSION}. ` +
        `Drop the index and reindex from AD4M.`
    )
  }

  const upsertEntityStmt = db.prepare(`
    INSERT INTO entities (uri, type, name, description, aliases, asserted_by, source_chunk_ids, created_at, updated_at)
    VALUES (@uri, @type, @name, @description, @aliases, @asserted_by, @source_chunk_ids, @created_at, @updated_at)
    ON CONFLICT(uri) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      description = excluded.description,
      aliases = excluded.aliases,
      asserted_by = excluded.asserted_by,
      source_chunk_ids = excluded.source_chunk_ids,
      updated_at = excluded.updated_at
  `)

  const upsertRelationshipStmt = db.prepare(`
    INSERT INTO relationships (uri, source, predicate, target, description, weight, asserted_by, source_chunk_ids, created_at)
    VALUES (@uri, @source, @predicate, @target, @description, @weight, @asserted_by, @source_chunk_ids, @created_at)
    ON CONFLICT(uri) DO UPDATE SET
      description = excluded.description,
      weight = excluded.weight,
      asserted_by = excluded.asserted_by,
      source_chunk_ids = excluded.source_chunk_ids
  `)

  const upsertClaimStmt = db.prepare(`
    INSERT INTO claims (uri, about, statement, evidence_chunk_ids, asserted_by, supports, contradicts, created_at)
    VALUES (@uri, @about, @statement, @evidence_chunk_ids, @asserted_by, @supports, @contradicts, @created_at)
    ON CONFLICT(uri) DO UPDATE SET
      evidence_chunk_ids = excluded.evidence_chunk_ids,
      asserted_by = excluded.asserted_by,
      supports = excluded.supports,
      contradicts = excluded.contradicts
  `)

  const upsertCommunityStmt = db.prepare(`
    INSERT INTO communities (uri, level, parent, member_entity_uris, summary, created_at)
    VALUES (@uri, @level, @parent, @member_entity_uris, @summary, @created_at)
    ON CONFLICT(uri) DO UPDATE SET
      level = excluded.level,
      parent = excluded.parent,
      member_entity_uris = excluded.member_entity_uris,
      summary = excluded.summary
  `)

  const upsertChunkStmt = db.prepare(`
    INSERT INTO chunks (id, document_id, text, position_start, position_end)
    VALUES (@id, @document_id, @text, @position_start, @position_end)
    ON CONFLICT(id) DO NOTHING
  `)

  const upsertEntityFtsStmt = db.prepare(`
    INSERT INTO entities_fts (rowid, uri, name, description)
    VALUES ((SELECT rowid FROM entities WHERE uri = @uri), @uri, @name, @description)
  `)
  const deleteEntityFtsStmt = db.prepare(`DELETE FROM entities_fts WHERE uri = @uri`)
  const upsertClaimFtsStmt = db.prepare(`
    INSERT INTO claims_fts (rowid, uri, statement)
    VALUES ((SELECT rowid FROM claims WHERE uri = @uri), @uri, @statement)
  `)
  const deleteClaimFtsStmt = db.prepare(`DELETE FROM claims_fts WHERE uri = @uri`)

  const upsertCellStmt = db.prepare(`
    INSERT INTO cell_assignments (uri, claim_uri, cell, filler, concept_iri, source)
    VALUES (@uri, @claim_uri, @cell, @filler, @concept_iri, @source)
    ON CONFLICT(uri) DO UPDATE SET
      filler = excluded.filler,
      concept_iri = excluded.concept_iri,
      source = excluded.source
  `)
  const deleteCellByUriStmt = db.prepare(`DELETE FROM cell_assignments WHERE uri = @uri`)
  const deleteCellsByClaimStmt = db.prepare(`DELETE FROM cell_assignments WHERE claim_uri = @claim_uri`)
  const upsertCellFtsStmt = db.prepare(`
    INSERT INTO cell_assignments_fts (rowid, uri, claim_uri, cell, filler)
    VALUES ((SELECT rowid FROM cell_assignments WHERE uri = @uri), @uri, @claim_uri, @cell, @filler)
  `)
  const deleteCellFtsByUriStmt = db.prepare(`DELETE FROM cell_assignments_fts WHERE uri = @uri`)
  const deleteCellFtsByClaimStmt = db.prepare(`DELETE FROM cell_assignments_fts WHERE claim_uri = @claim_uri`)

  function rowToEntity(row: any): Entity {
    return {
      uri: row.uri,
      type: row.type,
      name: row.name,
      description: row.description,
      aliases: parseIds(row.aliases),
      assertedBy: parseAgents(row.asserted_by),
      sourceChunkIds: parseIds(row.source_chunk_ids),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
  function rowToRelationship(row: any): Relationship {
    return {
      uri: row.uri,
      source: row.source,
      predicate: row.predicate,
      target: row.target,
      description: row.description,
      weight: row.weight,
      assertedBy: parseAgents(row.asserted_by),
      sourceChunkIds: parseIds(row.source_chunk_ids),
      createdAt: row.created_at
    }
  }
  function rowToCellAssignment(row: any): CellAssignment {
    return {
      uri: row.uri,
      claimUri: row.claim_uri,
      cell: row.cell,
      filler: row.filler,
      conceptIri: row.concept_iri ?? undefined,
      source: row.source ?? undefined
    }
  }
  function loadCellsForClaim(claimUri: string): CellAssignment[] {
    const rows = db
      .prepare(`SELECT * FROM cell_assignments WHERE claim_uri = ? ORDER BY rowid`)
      .all(claimUri) as any[]
    return rows.map(rowToCellAssignment)
  }
  function rowToClaim(row: any): Claim {
    return {
      uri: row.uri,
      about: row.about,
      statement: row.statement,
      cells: loadCellsForClaim(row.uri),
      evidenceChunkIds: parseIds(row.evidence_chunk_ids),
      assertedBy: parseAgents(row.asserted_by),
      supports: parseIds(row.supports),
      contradicts: parseIds(row.contradicts),
      createdAt: row.created_at
    }
  }
  function rowToCommunity(row: any): Community {
    return {
      uri: row.uri,
      level: row.level,
      parent: row.parent ?? undefined,
      memberEntityUris: parseIds(row.member_entity_uris),
      summary: row.summary,
      createdAt: row.created_at
    }
  }
  function rowToChunk(row: any): Chunk {
    return {
      id: row.id,
      documentId: row.document_id,
      text: row.text,
      position: { start: row.position_start, end: row.position_end }
    }
  }

  /** Build a SQL fragment + binding values for an `assertedBy DID ∈ X` filter
   *  applied to a JSON-encoded `asserted_by` column. */
  function provenanceClause(column: string, filter?: ProvenanceFilter): { sql: string; bindings: unknown[] } {
    if (!filter) return { sql: '', bindings: [] }
    const clauses: string[] = []
    const bindings: unknown[] = []
    if (filter.fromAgents && filter.fromAgents.length > 0) {
      // EXISTS (SELECT 1 FROM json_each(asserted_by) WHERE json_extract(value, '$.did') IN (?, ?, ...))
      const placeholders = filter.fromAgents.map(() => '?').join(', ')
      clauses.push(
        `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_extract(json_each.value, '$.did') IN (${placeholders}))`
      )
      for (const a of filter.fromAgents) bindings.push(a.did)
    }
    if (filter.fromPerspectives && filter.fromPerspectives.length > 0) {
      // Must be published into at least one of the named perspectives.
      const placeholders = filter.fromPerspectives.map(() => '?').join(', ')
      clauses.push(
        `EXISTS (SELECT 1 FROM publications p WHERE p.uri = uri AND p.perspective_uuid IN (${placeholders}))`
      )
      for (const u of filter.fromPerspectives) bindings.push(u)
    }
    if (clauses.length === 0) return { sql: '', bindings: [] }
    return { sql: ` AND ${clauses.join(' AND ')}`, bindings }
  }

  return {
    upsertEntity(entity) {
      const exists = db.prepare(`SELECT 1 FROM entities WHERE uri = ?`).get(entity.uri)
      upsertEntityStmt.run({
        uri: entity.uri,
        type: entity.type,
        name: entity.name,
        description: entity.description,
        aliases: serialiseIds(entity.aliases ?? []),
        asserted_by: serialiseAgents(entity.assertedBy),
        source_chunk_ids: serialiseIds(entity.sourceChunkIds),
        created_at: entity.createdAt,
        updated_at: entity.updatedAt
      })
      if (exists) deleteEntityFtsStmt.run({ uri: entity.uri })
      upsertEntityFtsStmt.run({ uri: entity.uri, name: entity.name, description: entity.description })
    },

    upsertRelationship(rel) {
      upsertRelationshipStmt.run({
        uri: rel.uri,
        source: rel.source,
        predicate: rel.predicate,
        target: rel.target,
        description: rel.description,
        weight: rel.weight,
        asserted_by: serialiseAgents(rel.assertedBy),
        source_chunk_ids: serialiseIds(rel.sourceChunkIds),
        created_at: rel.createdAt
      })
    },

    upsertClaim(claim) {
      const exists = db.prepare(`SELECT 1 FROM claims WHERE uri = ?`).get(claim.uri)
      upsertClaimStmt.run({
        uri: claim.uri,
        about: claim.about,
        statement: claim.statement,
        evidence_chunk_ids: serialiseIds(claim.evidenceChunkIds),
        asserted_by: serialiseAgents(claim.assertedBy),
        supports: serialiseIds(claim.supports ?? []),
        contradicts: serialiseIds(claim.contradicts ?? []),
        created_at: claim.createdAt
      })
      if (exists) deleteClaimFtsStmt.run({ uri: claim.uri })
      upsertClaimFtsStmt.run({ uri: claim.uri, statement: claim.statement })

      // Replace the claim's cell set with the incoming one. Identity is by
      // `uri`, but we wipe-and-reinsert because the cell merge happens above
      // this layer (see identity.ts:mergeClaim → mergeCells). Cells with the
      // same URI carry the same filler, so the replacement is idempotent.
      const incomingUris = new Set(claim.cells.map((c) => c.uri))
      const currentUris = (
        db.prepare(`SELECT uri FROM cell_assignments WHERE claim_uri = ?`).all(claim.uri) as {
          uri: string
        }[]
      ).map((r) => r.uri)
      for (const u of currentUris) {
        if (!incomingUris.has(u)) {
          deleteCellByUriStmt.run({ uri: u })
          deleteCellFtsByUriStmt.run({ uri: u })
        }
      }
      for (const cell of claim.cells) {
        const wasPresent = currentUris.includes(cell.uri)
        upsertCellStmt.run({
          uri: cell.uri,
          claim_uri: cell.claimUri,
          cell: cell.cell,
          filler: cell.filler,
          concept_iri: cell.conceptIri ?? null,
          source: cell.source ?? null
        })
        if (wasPresent) deleteCellFtsByUriStmt.run({ uri: cell.uri })
        upsertCellFtsStmt.run({
          uri: cell.uri,
          claim_uri: cell.claimUri,
          cell: cell.cell,
          filler: cell.filler
        })
      }
    },

    upsertCommunity(community) {
      upsertCommunityStmt.run({
        uri: community.uri,
        level: community.level,
        parent: community.parent ?? null,
        member_entity_uris: serialiseIds(community.memberEntityUris),
        summary: community.summary,
        created_at: community.createdAt
      })
    },

    upsertChunk(chunk) {
      upsertChunkStmt.run({
        id: chunk.id,
        document_id: chunk.documentId,
        text: chunk.text,
        position_start: chunk.position.start,
        position_end: chunk.position.end
      })
    },

    getEntity(uri) {
      const row = db.prepare(`SELECT * FROM entities WHERE uri = ?`).get(uri) as any
      return row ? rowToEntity(row) : null
    },

    getClaim(uri) {
      const row = db.prepare(`SELECT * FROM claims WHERE uri = ?`).get(uri) as any
      return row ? rowToClaim(row) : null
    },

    listChunksByDocument(documentId) {
      const rows = db
        .prepare(`SELECT * FROM chunks WHERE document_id = ? ORDER BY position_start`)
        .all(documentId) as any[]
      return rows.map(rowToChunk)
    },

    getChunks(ids) {
      if (ids.length === 0) return []
      const placeholders = ids.map(() => '?').join(', ')
      const rows = db.prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`).all(...ids) as any[]
      return rows.map(rowToChunk)
    },

    listRelationships(filter) {
      const where: string[] = ['1 = 1']
      const bindings: unknown[] = []
      if (filter.source) {
        where.push('source = ?')
        bindings.push(filter.source)
      }
      if (filter.target) {
        where.push('target = ?')
        bindings.push(filter.target)
      }
      if (filter.predicate) {
        where.push('predicate = ?')
        bindings.push(filter.predicate)
      }
      const prov = provenanceClause('asserted_by', {
        fromAgents: filter.fromAgents,
        fromPerspectives: filter.fromPerspectives
      })
      const sql = `SELECT * FROM relationships WHERE ${where.join(' AND ')}${prov.sql}`
      const rows = db.prepare(sql).all(...bindings, ...prov.bindings) as any[]
      return rows.map(rowToRelationship)
    },

    listCommunities(level) {
      const rows =
        typeof level === 'number'
          ? (db.prepare(`SELECT * FROM communities WHERE level = ?`).all(level) as any[])
          : (db.prepare(`SELECT * FROM communities`).all() as any[])
      return rows.map(rowToCommunity)
    },

    allEntityUris() {
      const rows = db.prepare(`SELECT uri FROM entities`).all() as { uri: string }[]
      return rows.map((r) => r.uri)
    },

    allRelationships() {
      const rows = db.prepare(`SELECT * FROM relationships`).all() as any[]
      return rows.map(rowToRelationship)
    },

    listCellAssignmentsByClaim(claimUri) {
      return loadCellsForClaim(claimUri)
    },

    listCellAssignments(filter) {
      const where: string[] = ['1 = 1']
      const bindings: unknown[] = []
      if (filter.cell) {
        where.push('ca.cell = ?')
        bindings.push(filter.cell)
      }
      if (filter.fillerLike) {
        where.push('ca.filler LIKE ?')
        bindings.push(`%${filter.fillerLike}%`)
      }
      if (filter.conceptIri) {
        where.push('ca.concept_iri = ?')
        bindings.push(filter.conceptIri)
      }
      const prov = provenanceClause('c.asserted_by', {
        fromAgents: filter.fromAgents,
        fromPerspectives: filter.fromPerspectives
      })
      // Scope to claims that pass provenance; cells inherit their parent's provenance.
      const sql = `
        SELECT ca.* FROM cell_assignments ca
        JOIN claims c ON c.uri = ca.claim_uri
        WHERE ${where.join(' AND ')}${prov.sql}
        ORDER BY ca.rowid
      `
      const rows = db.prepare(sql).all(...bindings, ...prov.bindings) as any[]
      return rows.map(rowToCellAssignment)
    },

    listClaimsByCell(terms, filter) {
      if (terms.length === 0) return []
      const subWhere: string[] = []
      const bindings: unknown[] = []
      for (const t of terms) {
        const clauses: string[] = ['cell = ?']
        bindings.push(t.cell)
        if (t.fillerLike) {
          clauses.push('filler LIKE ?')
          bindings.push(`%${t.fillerLike}%`)
        }
        if (t.conceptIri) {
          clauses.push('concept_iri = ?')
          bindings.push(t.conceptIri)
        }
        subWhere.push(
          `EXISTS (SELECT 1 FROM cell_assignments ca WHERE ca.claim_uri = c.uri AND ${clauses.join(' AND ')})`
        )
      }
      const prov = provenanceClause('c.asserted_by', filter)
      const sql = `
        SELECT c.* FROM claims c
        WHERE ${subWhere.join(' AND ')}${prov.sql}
        ORDER BY c.created_at DESC
      `
      const rows = db.prepare(sql).all(...bindings, ...prov.bindings) as any[]
      return rows.map(rowToClaim)
    },

    storeEntityEmbedding(uri, vector) {
      db.prepare(`DELETE FROM vec_entities WHERE uri = ?`).run(uri)
      db.prepare(`INSERT INTO vec_entities (uri, embedding) VALUES (?, ?)`).run(
        uri,
        new Float32Array(vector) as unknown as Buffer
      )
    },
    storeChunkEmbedding(id, vector) {
      db.prepare(`DELETE FROM vec_chunks WHERE id = ?`).run(id)
      db.prepare(`INSERT INTO vec_chunks (id, embedding) VALUES (?, ?)`).run(
        id,
        new Float32Array(vector) as unknown as Buffer
      )
    },
    storeCommunityEmbedding(uri, vector) {
      db.prepare(`DELETE FROM vec_communities WHERE uri = ?`).run(uri)
      db.prepare(`INSERT INTO vec_communities (uri, embedding) VALUES (?, ?)`).run(
        uri,
        new Float32Array(vector) as unknown as Buffer
      )
    },

    vectorSearchEntities(query, k, filter) {
      const prov = provenanceClause('e.asserted_by', filter)
      const sql = `
        SELECT e.* FROM vec_entities v
        JOIN entities e ON e.uri = v.uri
        WHERE v.embedding MATCH ? AND k = ?${prov.sql}
        ORDER BY v.distance
      `
      const rows = db
        .prepare(sql)
        .all(new Float32Array(query) as unknown as Buffer, k, ...prov.bindings) as any[]
      return rows.map(rowToEntity)
    },
    vectorSearchChunks(query, k, _filter) {
      // Chunks have no asserted_by; filter is a no-op for them.
      const sql = `
        SELECT c.* FROM vec_chunks v
        JOIN chunks c ON c.id = v.id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `
      const rows = db.prepare(sql).all(new Float32Array(query) as unknown as Buffer, k) as any[]
      return rows.map(rowToChunk)
    },
    vectorSearchCommunities(query, k, level, _filter) {
      const where: string[] = []
      const bindings: unknown[] = [new Float32Array(query) as unknown as Buffer, k]
      if (typeof level === 'number') {
        where.push('c.level = ?')
        bindings.push(level)
      }
      const sql = `
        SELECT c.* FROM vec_communities v
        JOIN communities c ON c.uri = v.uri
        WHERE v.embedding MATCH ? AND k = ?${where.length ? ' AND ' + where.join(' AND ') : ''}
        ORDER BY v.distance
      `
      const rows = db.prepare(sql).all(...bindings) as any[]
      return rows.map(rowToCommunity)
    },

    ftsSearchClaims(query, k, filter) {
      const match = toFtsMatchQuery(query)
      if (!match) return []
      const prov = provenanceClause('c.asserted_by', filter)
      const sql = `
        SELECT c.* FROM claims_fts f
        JOIN claims c ON c.uri = f.uri
        WHERE f.statement MATCH ?${prov.sql}
        ORDER BY rank
        LIMIT ?
      `
      const rows = db.prepare(sql).all(match, ...prov.bindings, k) as any[]
      return rows.map(rowToClaim)
    },

    recordPublication(uri, perspectiveUuid) {
      db.prepare(`INSERT OR IGNORE INTO publications (uri, perspective_uuid) VALUES (?, ?)`).run(uri, perspectiveUuid)
    },
    recordUnpublication(uri, perspectiveUuid) {
      db.prepare(`DELETE FROM publications WHERE uri = ? AND perspective_uuid = ?`).run(uri, perspectiveUuid)
    },
    listPublications(uri) {
      const rows = db
        .prepare(`SELECT perspective_uuid FROM publications WHERE uri = ?`)
        .all(uri) as { perspective_uuid: string }[]
      return rows.map((r) => r.perspective_uuid)
    },

    cacheGet(stage, key) {
      const row = db.prepare(`SELECT value FROM cache WHERE stage = ? AND key = ?`).get(stage, key) as
        | { value: string }
        | undefined
      return row ? row.value : null
    },
    cacheSet(stage, key, value) {
      db.prepare(
        `INSERT INTO cache (stage, key, value, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(stage, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`
      ).run(stage, key, value, Date.now())
    },

    deleteChunksByDocument(documentId) {
      const rows = db.prepare(`SELECT id FROM chunks WHERE document_id = ?`).all(documentId) as { id: string }[]
      const ids = rows.map((r) => r.id)
      if (ids.length === 0) return []
      const placeholders = ids.map(() => '?').join(', ')
      db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...ids)
      db.prepare(`DELETE FROM vec_chunks WHERE id IN (${placeholders})`).run(...ids)
      return ids
    },

    stripChunkRefsFromEntities(chunkIds) {
      if (chunkIds.length === 0) return
      const idsJson = JSON.stringify(chunkIds)
      // Remove any chunkId in `source_chunk_ids` that appears in `chunkIds`.
      const rows = db.prepare(`SELECT uri, source_chunk_ids FROM entities`).all() as {
        uri: string
        source_chunk_ids: string
      }[]
      const updateStmt = db.prepare(`UPDATE entities SET source_chunk_ids = ?, updated_at = ? WHERE uri = ?`)
      const toRemove = new Set(chunkIds)
      const now = Date.now()
      const tx = db.transaction(() => {
        for (const r of rows) {
          const arr = parseIds(r.source_chunk_ids)
          const filtered = arr.filter((id) => !toRemove.has(id))
          if (filtered.length !== arr.length) {
            updateStmt.run(serialiseIds(filtered), now, r.uri)
          }
        }
      })
      tx()
      void idsJson
    },
    stripChunkRefsFromRelationships(chunkIds) {
      if (chunkIds.length === 0) return
      const rows = db.prepare(`SELECT uri, source_chunk_ids FROM relationships`).all() as {
        uri: string
        source_chunk_ids: string
      }[]
      const updateStmt = db.prepare(`UPDATE relationships SET source_chunk_ids = ? WHERE uri = ?`)
      const toRemove = new Set(chunkIds)
      const tx = db.transaction(() => {
        for (const r of rows) {
          const arr = parseIds(r.source_chunk_ids)
          const filtered = arr.filter((id) => !toRemove.has(id))
          if (filtered.length !== arr.length) {
            updateStmt.run(serialiseIds(filtered), r.uri)
          }
        }
      })
      tx()
    },
    stripChunkRefsFromClaims(chunkIds) {
      if (chunkIds.length === 0) return
      const rows = db.prepare(`SELECT uri, evidence_chunk_ids FROM claims`).all() as {
        uri: string
        evidence_chunk_ids: string
      }[]
      const updateStmt = db.prepare(`UPDATE claims SET evidence_chunk_ids = ? WHERE uri = ?`)
      const toRemove = new Set(chunkIds)
      const tx = db.transaction(() => {
        for (const r of rows) {
          const arr = parseIds(r.evidence_chunk_ids)
          const filtered = arr.filter((id) => !toRemove.has(id))
          if (filtered.length !== arr.length) {
            updateStmt.run(serialiseIds(filtered), r.uri)
          }
        }
      })
      tx()
    },

    deleteOrphanedEntities() {
      const rows = db.prepare(`SELECT uri, source_chunk_ids FROM entities`).all() as {
        uri: string
        source_chunk_ids: string
      }[]
      const orphans = rows.filter((r) => parseIds(r.source_chunk_ids).length === 0).map((r) => r.uri)
      if (orphans.length === 0) return 0
      const placeholders = orphans.map(() => '?').join(', ')
      db.prepare(`DELETE FROM entities WHERE uri IN (${placeholders})`).run(...orphans)
      db.prepare(`DELETE FROM vec_entities WHERE uri IN (${placeholders})`).run(...orphans)
      for (const uri of orphans) deleteEntityFtsStmt.run({ uri })
      return orphans.length
    },
    deleteOrphanedRelationships() {
      const rows = db.prepare(`SELECT uri, source_chunk_ids FROM relationships`).all() as {
        uri: string
        source_chunk_ids: string
      }[]
      const orphans = rows.filter((r) => parseIds(r.source_chunk_ids).length === 0).map((r) => r.uri)
      if (orphans.length === 0) return 0
      const placeholders = orphans.map(() => '?').join(', ')
      db.prepare(`DELETE FROM relationships WHERE uri IN (${placeholders})`).run(...orphans)
      return orphans.length
    },
    deleteOrphanedClaims() {
      const rows = db.prepare(`SELECT uri, evidence_chunk_ids FROM claims`).all() as {
        uri: string
        evidence_chunk_ids: string
      }[]
      const orphans = rows.filter((r) => parseIds(r.evidence_chunk_ids).length === 0).map((r) => r.uri)
      if (orphans.length === 0) return 0
      const placeholders = orphans.map(() => '?').join(', ')
      for (const uri of orphans) {
        // FK cascade handles cell_assignments rows; we still need to clean up
        // the FTS shadow table because FTS5 external-content tables don't
        // observe foreign-key cascades.
        deleteCellsByClaimStmt.run({ claim_uri: uri })
        deleteCellFtsByClaimStmt.run({ claim_uri: uri })
      }
      db.prepare(`DELETE FROM claims WHERE uri IN (${placeholders})`).run(...orphans)
      for (const uri of orphans) deleteClaimFtsStmt.run({ uri })
      return orphans.length
    },

    reset() {
      const tables = [
        'entities',
        'relationships',
        'claims',
        'cell_assignments',
        'communities',
        'chunks',
        'publications',
        'cache',
        'vec_entities',
        'vec_chunks',
        'vec_communities',
        'entities_fts',
        'claims_fts',
        'cell_assignments_fts',
        'schema_meta'
      ]
      const tx = db.transaction(() => {
        for (const t of tables) {
          try {
            db.exec(`DROP TABLE IF EXISTS ${t}`)
          } catch {
            /* virtual tables sometimes fail on drop; ignore */
          }
        }
      })
      tx()
      for (const stmt of DDL) db.exec(stmt)
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_entities USING vec0(uri TEXT PRIMARY KEY, embedding FLOAT[${dim}])`)
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dim}])`)
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_communities USING vec0(uri TEXT PRIMARY KEY, embedding FLOAT[${dim}])`)
      db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', ?)`).run(String(SCHEMA_VERSION))
    },

    close() {
      db.close()
    }
  }
}
