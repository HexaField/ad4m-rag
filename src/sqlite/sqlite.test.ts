import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteIndex, type SqliteIndex } from './index.js'
import { cellAssignmentUri } from '../uri.js'
import type { CellAssignment, Entity, Relationship, Claim, Community, Chunk } from '../types.js'

const DIM = 4

function makeEntity(uri: string, name: string, description: string, agents: string[] = ['did:a']): Entity {
  return {
    uri,
    type: 'Person',
    name,
    description,
    aliases: [],
    assertedBy: agents.map((did) => ({ did })),
    sourceChunkIds: [],
    createdAt: 1,
    updatedAt: 1
  }
}

describe('SqliteIndex', () => {
  let index: SqliteIndex

  beforeEach(() => {
    index = createSqliteIndex({ path: ':memory:', embeddingDimension: DIM })
  })

  it('upserts and reads back an entity', () => {
    const e = makeEntity('entity:1', 'Josh', 'A human.')
    index.upsertEntity(e)
    const back = index.getEntity('entity:1')
    expect(back?.name).toBe('Josh')
    expect(back?.assertedBy[0].did).toBe('did:a')
  })

  it('updates entity description on second upsert', () => {
    index.upsertEntity(makeEntity('entity:1', 'Josh', 'first'))
    index.upsertEntity(makeEntity('entity:1', 'Josh', 'second'))
    expect(index.getEntity('entity:1')?.description).toBe('second')
  })

  it('listRelationships filters by source/target/predicate', () => {
    const rel: Relationship = {
      uri: 'relationship:1',
      source: 'entity:1',
      predicate: 'works_on',
      target: 'entity:2',
      description: '',
      weight: 0.5,
      assertedBy: [{ did: 'did:a' }],
      sourceChunkIds: [],
      createdAt: 1
    }
    index.upsertRelationship(rel)
    expect(index.listRelationships({ source: 'entity:1' })).toHaveLength(1)
    expect(index.listRelationships({ target: 'entity:99' })).toHaveLength(0)
    expect(index.listRelationships({ predicate: 'works_on' })).toHaveLength(1)
    expect(index.listRelationships({ predicate: 'depends_on' })).toHaveLength(0)
  })

  it('filters relationships by provenance.fromAgents', () => {
    const r1: Relationship = {
      uri: 'relationship:1',
      source: 'entity:1',
      predicate: 'p',
      target: 'entity:2',
      description: '',
      weight: 0.5,
      assertedBy: [{ did: 'did:a' }],
      sourceChunkIds: [],
      createdAt: 1
    }
    const r2: Relationship = { ...r1, uri: 'relationship:2', assertedBy: [{ did: 'did:b' }] }
    index.upsertRelationship(r1)
    index.upsertRelationship(r2)
    const onlyA = index.listRelationships({ fromAgents: [{ did: 'did:a' }] })
    expect(onlyA.map((r) => r.uri)).toEqual(['relationship:1'])
  })

  it('vector-searches entities by embedding', () => {
    const e1 = makeEntity('entity:1', 'apple', '')
    const e2 = makeEntity('entity:2', 'orange', '')
    index.upsertEntity(e1)
    index.upsertEntity(e2)
    index.storeEntityEmbedding('entity:1', [1, 0, 0, 0])
    index.storeEntityEmbedding('entity:2', [0, 1, 0, 0])
    const closest = index.vectorSearchEntities([0.9, 0.1, 0, 0], 1)
    expect(closest.map((e) => e.uri)).toEqual(['entity:1'])
  })

  it('vector search honours provenance filter', () => {
    const e1 = makeEntity('entity:1', 'a', '', ['did:a'])
    const e2 = makeEntity('entity:2', 'b', '', ['did:b'])
    index.upsertEntity(e1)
    index.upsertEntity(e2)
    index.storeEntityEmbedding('entity:1', [1, 0, 0, 0])
    index.storeEntityEmbedding('entity:2', [1, 0, 0, 0]) // both close to query
    const onlyA = index.vectorSearchEntities([1, 0, 0, 0], 5, { fromAgents: [{ did: 'did:a' }] })
    expect(onlyA.map((e) => e.uri)).toEqual(['entity:1'])
  })

  it('FTS-searches claims by statement', () => {
    const c: Claim = {
      uri: 'claim:1',
      about: 'entity:1',
      statement: 'The sky is blue.',
      cells: [],
      evidenceChunkIds: ['chunk:1'],
      assertedBy: [{ did: 'did:a' }],
      createdAt: 1
    }
    index.upsertClaim(c)
    const hits = index.ftsSearchClaims('sky', 5)
    expect(hits.map((h) => h.uri)).toEqual(['claim:1'])
  })

  it('round-trips a claim with cell assignments', () => {
    const claimUriValue = 'claim:cells-1'
    const cells: CellAssignment[] = [
      {
        uri: cellAssignmentUri(claimUriValue, 'who·objective', 'Josh'),
        claimUri: claimUriValue,
        cell: 'who·objective',
        filler: 'Josh',
        conceptIri: 'https://example.org/josh'
      },
      {
        uri: cellAssignmentUri(claimUriValue, 'why·subjective', 'commitment to open-source'),
        claimUri: claimUriValue,
        cell: 'why·subjective',
        filler: 'commitment to open-source',
        source: 'PLAN.md'
      }
    ]
    const claim: Claim = {
      uri: claimUriValue,
      about: 'entity:1',
      statement: 'Josh shipped a new module.',
      cells,
      evidenceChunkIds: ['chunk:1'],
      assertedBy: [{ did: 'did:a' }],
      createdAt: 100
    }
    index.upsertClaim(claim)
    const back = index.getClaim(claimUriValue)
    expect(back).not.toBeNull()
    expect(back!.cells).toHaveLength(2)
    const byCell = new Map(back!.cells.map((c) => [c.cell, c]))
    expect(byCell.get('who·objective')?.filler).toBe('Josh')
    expect(byCell.get('who·objective')?.conceptIri).toBe('https://example.org/josh')
    expect(byCell.get('why·subjective')?.source).toBe('PLAN.md')
  })

  it('replaces cells on subsequent upsert when the set changes', () => {
    const claimUriValue = 'claim:cells-2'
    const c1: Claim = {
      uri: claimUriValue,
      about: 'entity:1',
      statement: 'x',
      cells: [
        {
          uri: cellAssignmentUri(claimUriValue, 'who·objective', 'A'),
          claimUri: claimUriValue,
          cell: 'who·objective',
          filler: 'A'
        },
        {
          uri: cellAssignmentUri(claimUriValue, 'what·objective', 'B'),
          claimUri: claimUriValue,
          cell: 'what·objective',
          filler: 'B'
        }
      ],
      evidenceChunkIds: ['chunk:1'],
      assertedBy: [{ did: 'did:a' }],
      createdAt: 1
    }
    index.upsertClaim(c1)
    expect(index.listCellAssignmentsByClaim(claimUriValue)).toHaveLength(2)
    // Second upsert with a smaller set drops the missing cell.
    index.upsertClaim({
      ...c1,
      cells: [
        {
          uri: cellAssignmentUri(claimUriValue, 'who·objective', 'A'),
          claimUri: claimUriValue,
          cell: 'who·objective',
          filler: 'A'
        }
      ]
    })
    const after = index.listCellAssignmentsByClaim(claimUriValue)
    expect(after).toHaveLength(1)
    expect(after[0].cell).toBe('who·objective')
  })

  it('listClaimsByCell narrows by cell + filler substring', () => {
    const c1: Claim = {
      uri: 'claim:x',
      about: 'entity:1',
      statement: 'x',
      cells: [
        {
          uri: cellAssignmentUri('claim:x', 'who·objective', 'Josh'),
          claimUri: 'claim:x',
          cell: 'who·objective',
          filler: 'Josh'
        }
      ],
      evidenceChunkIds: [],
      assertedBy: [{ did: 'did:a' }],
      createdAt: 1
    }
    const c2: Claim = {
      uri: 'claim:y',
      about: 'entity:2',
      statement: 'y',
      cells: [
        {
          uri: cellAssignmentUri('claim:y', 'who·objective', 'Alice'),
          claimUri: 'claim:y',
          cell: 'who·objective',
          filler: 'Alice'
        }
      ],
      evidenceChunkIds: [],
      assertedBy: [{ did: 'did:a' }],
      createdAt: 1
    }
    index.upsertClaim(c1)
    index.upsertClaim(c2)
    const matched = index.listClaimsByCell([{ cell: 'who·objective', fillerLike: 'Josh' }])
    expect(matched.map((c) => c.uri)).toEqual(['claim:x'])
  })

  it('deleteOrphanedClaims removes cell rows and FTS shadow', () => {
    const c: Claim = {
      uri: 'claim:orphan',
      about: 'entity:1',
      statement: 'doomed',
      cells: [
        {
          uri: cellAssignmentUri('claim:orphan', 'who·objective', 'X'),
          claimUri: 'claim:orphan',
          cell: 'who·objective',
          filler: 'X'
        }
      ],
      evidenceChunkIds: [],
      assertedBy: [{ did: 'did:a' }],
      createdAt: 1
    }
    index.upsertClaim(c)
    expect(index.listCellAssignmentsByClaim('claim:orphan')).toHaveLength(1)
    const removed = index.deleteOrphanedClaims()
    expect(removed).toBe(1)
    expect(index.getClaim('claim:orphan')).toBeNull()
    expect(index.listCellAssignmentsByClaim('claim:orphan')).toHaveLength(0)
  })

  it('communities can be filtered by level', () => {
    const lvl0: Community = {
      uri: 'community:0',
      level: 0,
      memberEntityUris: ['entity:1'],
      summary: 'a',
      createdAt: 1
    }
    const lvl1: Community = { ...lvl0, uri: 'community:1', level: 1 }
    index.upsertCommunity(lvl0)
    index.upsertCommunity(lvl1)
    expect(index.listCommunities(0).map((c) => c.uri)).toEqual(['community:0'])
    expect(index.listCommunities(1).map((c) => c.uri)).toEqual(['community:1'])
    expect(index.listCommunities()).toHaveLength(2)
  })

  it('cacheGet/cacheSet round-trips JSON', () => {
    expect(index.cacheGet('extract', 'k')).toBeNull()
    index.cacheSet('extract', 'k', '{"hello": "world"}')
    expect(index.cacheGet('extract', 'k')).toBe('{"hello": "world"}')
  })

  it('retract deletes chunks and orphan entities', () => {
    const c: Chunk = {
      id: 'chunk:1',
      documentId: 'doc-A',
      text: 'hello',
      position: { start: 0, end: 5 }
    }
    index.upsertChunk(c)
    index.upsertEntity({ ...makeEntity('entity:1', 'Josh', 'h'), sourceChunkIds: ['chunk:1'] })
    expect(index.deleteChunksByDocument('doc-A')).toEqual(['chunk:1'])
    index.stripChunkRefsFromEntities(['chunk:1'])
    const removed = index.deleteOrphanedEntities()
    expect(removed).toBe(1)
    expect(index.getEntity('entity:1')).toBeNull()
  })

  it('listChunksByDocument returns ordered chunks', () => {
    index.upsertChunk({ id: 'chunk:1', documentId: 'doc-A', text: 'b', position: { start: 5, end: 6 } })
    index.upsertChunk({ id: 'chunk:2', documentId: 'doc-A', text: 'a', position: { start: 0, end: 1 } })
    const out = index.listChunksByDocument('doc-A')
    expect(out.map((c) => c.id)).toEqual(['chunk:2', 'chunk:1'])
  })

  it('publication ledger records and lists', () => {
    index.recordPublication('entity:1', 'persp-A')
    index.recordPublication('entity:1', 'persp-B')
    expect(index.listPublications('entity:1').sort()).toEqual(['persp-A', 'persp-B'])
    index.recordUnpublication('entity:1', 'persp-A')
    expect(index.listPublications('entity:1')).toEqual(['persp-B'])
  })
})
