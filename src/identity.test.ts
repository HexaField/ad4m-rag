import { describe, it, expect } from 'vitest'
import { mergeAgents, mergeClaim, mergeEntity, mergeIds, mergeRelationship } from './identity.js'
import type { Claim, Entity, Relationship } from './types.js'

describe('mergeAgents', () => {
  it('deduplicates by DID and preserves order', () => {
    const out = mergeAgents([{ did: 'did:a' }, { did: 'did:b' }], [{ did: 'did:b', label: 'b2' }, { did: 'did:c' }])
    expect(out.map((a) => a.did)).toEqual(['did:a', 'did:b', 'did:c'])
  })
})

describe('mergeIds', () => {
  it('set-unions with stable order', () => {
    expect(mergeIds(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(mergeIds([], ['a'])).toEqual(['a'])
  })
})

describe('mergeEntity', () => {
  const base: Entity = {
    uri: 'entity:1',
    type: 'Person',
    name: 'Josh',
    description: 'A human.',
    aliases: ['hex'],
    assertedBy: [{ did: 'did:a' }],
    sourceChunkIds: ['chunk:1'],
    createdAt: 100,
    updatedAt: 100
  }

  it('keeps existing description on empty incoming description', () => {
    const merged = mergeEntity(base, { ...base, description: '   ' })
    expect(merged.description).toBe('A human.')
  })

  it('takes incoming description when non-empty', () => {
    const merged = mergeEntity(base, { ...base, description: 'A new description.' })
    expect(merged.description).toBe('A new description.')
  })

  it('accumulates assertedBy and sourceChunkIds', () => {
    const merged = mergeEntity(base, {
      ...base,
      assertedBy: [{ did: 'did:b' }],
      sourceChunkIds: ['chunk:2']
    })
    expect(merged.assertedBy.map((a) => a.did)).toEqual(['did:a', 'did:b'])
    expect(merged.sourceChunkIds).toEqual(['chunk:1', 'chunk:2'])
  })

  it('preserves createdAt and bumps updatedAt', () => {
    const before = Date.now()
    const merged = mergeEntity(base, base)
    expect(merged.createdAt).toBe(100)
    expect(merged.updatedAt).toBeGreaterThanOrEqual(before)
  })
})

describe('mergeRelationship', () => {
  const base: Relationship = {
    uri: 'relationship:1',
    source: 'entity:1',
    predicate: 'works_on',
    target: 'entity:2',
    description: 'x',
    weight: 0.4,
    assertedBy: [{ did: 'did:a' }],
    sourceChunkIds: ['chunk:1'],
    createdAt: 100
  }
  it('takes the max weight', () => {
    const merged = mergeRelationship(base, { ...base, weight: 0.8 })
    expect(merged.weight).toBe(0.8)
    const merged2 = mergeRelationship(base, { ...base, weight: 0.1 })
    expect(merged2.weight).toBe(0.4)
  })
})

describe('mergeClaim', () => {
  const base: Claim = {
    uri: 'claim:1',
    about: 'entity:1',
    statement: 'x',
    evidenceChunkIds: ['chunk:1'],
    assertedBy: [{ did: 'did:a' }],
    createdAt: 100
  }
  it('accumulates evidence chunks', () => {
    const merged = mergeClaim(base, { ...base, evidenceChunkIds: ['chunk:2'] })
    expect(merged.evidenceChunkIds).toEqual(['chunk:1', 'chunk:2'])
  })
  it('merges supports and contradicts', () => {
    const merged = mergeClaim(
      { ...base, supports: ['claim:2'], contradicts: ['claim:3'] },
      { ...base, supports: ['claim:4'], contradicts: ['claim:3'] }
    )
    expect(merged.supports).toEqual(['claim:2', 'claim:4'])
    expect(merged.contradicts).toEqual(['claim:3'])
  })
})
