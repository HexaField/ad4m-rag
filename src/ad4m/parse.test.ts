import { describe, it, expect } from 'vitest'
import { parseLinks } from './parse.js'
import { entityToLinks, relationshipToLinks, claimToLinks, communityToLinks } from './serialise.js'
import type { Claim, Community, Entity, Relationship } from '../types.js'

describe('AD4M serialise + parse round-trip', () => {
  it('round-trips an Entity fully', () => {
    const e: Entity = {
      uri: 'entity:1',
      type: 'Person',
      name: 'Josh Field',
      description: 'A human.',
      aliases: ['hex', 'JF'],
      assertedBy: [{ did: 'did:a', label: 'Alice' }, { did: 'did:b' }],
      sourceChunkIds: ['chunk:1', 'chunk:2'],
      createdAt: 100,
      updatedAt: 200
    }
    const links = entityToLinks(e).map((l) => ({ data: { source: l.source, predicate: l.predicate ?? '', target: l.target } }))
    const parsed = parseLinks(links as any).entities
    expect(parsed).toHaveLength(1)
    const back = parsed[0]
    expect(back).toEqual(e)
  })

  it('defaults Entity.type to "Unknown" when entityType predicate is missing', () => {
    // Synthesise a minimal Entity bucket missing the entityType predicate.
    const links = [
      { data: { source: 'entity:1', predicate: 'adr://ad4m-rag/type', target: 'adr://ad4m-rag/Entity' } },
      { data: { source: 'entity:1', predicate: 'adr://ad4m-rag/name', target: 'literal:string:' + encodeURIComponent('Josh') } },
      { data: { source: 'entity:1', predicate: 'adr://ad4m-rag/description', target: 'literal:string:' + encodeURIComponent('h') } }
    ]
    const parsed = parseLinks(links as any).entities
    expect(parsed[0].type).toBe('Unknown')
  })

  it('round-trips a Relationship', () => {
    const r: Relationship = {
      uri: 'relationship:1',
      source: 'entity:1',
      predicate: 'works_on',
      target: 'entity:2',
      description: 'collaboration',
      weight: 0.8,
      assertedBy: [{ did: 'did:a' }],
      sourceChunkIds: ['chunk:1'],
      createdAt: 100
    }
    const links = relationshipToLinks(r).map((l) => ({ data: { source: l.source, predicate: l.predicate ?? '', target: l.target } }))
    const parsed = parseLinks(links as any).relationships
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual(r)
  })

  it('round-trips a Claim', () => {
    const c: Claim = {
      uri: 'claim:1',
      about: 'entity:1',
      statement: 'Sovereign uses an event bus.',
      evidenceChunkIds: ['chunk:1', 'chunk:2'],
      assertedBy: [{ did: 'did:a' }],
      supports: ['claim:99'],
      contradicts: ['claim:100'],
      createdAt: 100
    }
    const links = claimToLinks(c).map((l) => ({ data: { source: l.source, predicate: l.predicate ?? '', target: l.target } }))
    const parsed = parseLinks(links as any).claims
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual(c)
  })

  it('round-trips a Community', () => {
    const c: Community = {
      uri: 'community:1',
      level: 1,
      parent: 'community:2',
      memberEntityUris: ['entity:1', 'entity:2', 'entity:3'],
      summary: 'A cluster of collaborators.',
      createdAt: 100
    }
    const links = communityToLinks(c).map((l) => ({ data: { source: l.source, predicate: l.predicate ?? '', target: l.target } }))
    const parsed = parseLinks(links as any).communities
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual(c)
  })

  it('parseLinks silently drops malformed records', () => {
    // No `type` triple — won't match any kind.
    const stray = [{ data: { source: 'entity:?', predicate: 'noise', target: 'noise' } }]
    const parsed = parseLinks(stray as any)
    expect(parsed.entities).toEqual([])
    expect(parsed.relationships).toEqual([])
    expect(parsed.claims).toEqual([])
    expect(parsed.communities).toEqual([])
  })
})
