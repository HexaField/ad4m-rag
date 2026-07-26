import { describe, it, expect } from 'vitest'
import {
  canonicalEntityKey,
  chunkUri,
  claimUri,
  communityUri,
  entityUri,
  relationshipUri,
  uriKind
} from './uri.js'

describe('canonicalEntityKey', () => {
  it('lower-cases the name and trims whitespace', () => {
    expect(canonicalEntityKey('Person', '  Josh Field  ')).toBe('Person|josh field')
  })
  it('preserves type case', () => {
    expect(canonicalEntityKey('Project', 'sovereign')).toBe('Project|sovereign')
  })
})

describe('entityUri', () => {
  it('produces the same URI for case-insensitive name variants', () => {
    expect(entityUri('Person', 'Josh Field')).toBe(entityUri('Person', 'josh field'))
    expect(entityUri('Person', 'Josh Field')).toBe(entityUri('Person', '  Josh Field  '))
  })
  it('produces a different URI for different types', () => {
    expect(entityUri('Person', 'Sovereign')).not.toBe(entityUri('Project', 'Sovereign'))
  })
  it('has the entity: prefix', () => {
    expect(entityUri('Person', 'Josh').startsWith('entity:')).toBe(true)
  })
})

describe('relationshipUri', () => {
  it('is symmetric across calls with identical inputs', () => {
    const a = relationshipUri('entity:1', 'works_on', 'entity:2')
    const b = relationshipUri('entity:1', 'works_on', 'entity:2')
    expect(a).toBe(b)
  })
  it('is direction-aware', () => {
    expect(relationshipUri('entity:1', 'works_on', 'entity:2')).not.toBe(
      relationshipUri('entity:2', 'works_on', 'entity:1')
    )
  })
})

describe('claimUri', () => {
  it('normalises whitespace in statements', () => {
    expect(claimUri('entity:1', 'The   sky   is   blue.')).toBe(claimUri('entity:1', 'The sky is blue.'))
  })
})

describe('communityUri', () => {
  it('is order-independent in member URIs', () => {
    expect(communityUri(0, ['entity:1', 'entity:2', 'entity:3'])).toBe(
      communityUri(0, ['entity:3', 'entity:1', 'entity:2'])
    )
  })
  it('is level-dependent', () => {
    expect(communityUri(0, ['entity:1'])).not.toBe(communityUri(1, ['entity:1']))
  })
})

describe('chunkUri', () => {
  it('hashes the same text to the same URI', () => {
    expect(chunkUri('hello world')).toBe(chunkUri('hello world'))
  })
})

describe('uriKind', () => {
  it('inspects the prefix', () => {
    expect(uriKind('entity:abc')).toBe('entity')
    expect(uriKind('relationship:abc')).toBe('relationship')
    expect(uriKind('claim:abc')).toBe('claim')
    expect(uriKind('community:abc')).toBe('community')
    expect(uriKind('chunk:abc')).toBe('chunk')
  })
  it('throws on malformed input', () => {
    expect(() => uriKind('no-colon')).toThrow()
    expect(() => uriKind('frog:abc')).toThrow()
  })
})
