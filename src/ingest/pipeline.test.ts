import { describe, it, expect } from 'vitest'
import { createSqliteIndex } from '../sqlite/index.js'
import { createIngestApi, type Extractor } from './pipeline.js'
import { createIngestCache } from './cache.js'
import type { EmbeddingClient } from '../clients/embedding.js'

const DIM = 4

function makeEmbeddings(): EmbeddingClient {
  // Deterministic toy embeddings: hash of first char.
  function embed(text: string): number[] {
    const c = (text.charCodeAt(0) || 0) / 128
    return [c, 1 - c, 0, 0]
  }
  return {
    async embed(text) {
      return embed(text)
    },
    async embedBatch(texts) {
      return texts.map(embed)
    },
    dimension: () => DIM
  }
}

function makeExtractor(): Extractor {
  return {
    async extract(passage: string) {
      // Toy extractor: every distinct capitalised word becomes a Person; if
      // two appear in the same chunk, they "work_on" each other.
      const names = [...new Set(passage.match(/\b[A-Z][a-z]+\b/g) ?? [])]
      const entities = names.map((n) => ({ type: 'Person', name: n, description: `entity for ${n}` }))
      const relationships =
        names.length >= 2
          ? [
              {
                source: { type: 'Person', name: names[0] },
                predicate: 'works_on',
                target: { type: 'Person', name: names[1] },
                description: '',
                weight: 0.5
              }
            ]
          : []
      const claims =
        names.length > 0
          ? [{ about: { type: 'Person', name: names[0] }, statement: `${names[0]} appears in the text.` }]
          : []
      return { entities, relationships, claims }
    }
  }
}

describe('ingest pipeline', () => {
  it('ingests a small document and produces entities + relationships + claims', async () => {
    const sqlite = createSqliteIndex({ path: ':memory:', embeddingDimension: DIM })
    const cache = createIngestCache(sqlite)
    const ingest = createIngestApi({
      sqlite,
      embeddings: makeEmbeddings(),
      extractor: makeExtractor(),
      cache
    })
    const result = await ingest.append({
      documentId: 'doc-A',
      text: 'Josh works with Sovereign on Atlas.',
      assertedBy: { did: 'did:test:a' }
    })
    expect(result.entitiesExtracted).toBeGreaterThan(0)
    expect(result.relationshipsExtracted).toBeGreaterThanOrEqual(1)
    expect(result.claimsExtracted).toBeGreaterThanOrEqual(1)
  })

  it('re-ingesting the same text is a near no-op via cache', async () => {
    const sqlite = createSqliteIndex({ path: ':memory:', embeddingDimension: DIM })
    const cache = createIngestCache(sqlite)
    const ingest = createIngestApi({
      sqlite,
      embeddings: makeEmbeddings(),
      extractor: makeExtractor(),
      cache
    })
    await ingest.append({
      documentId: 'doc-A',
      text: 'Josh works with Sovereign.',
      assertedBy: { did: 'did:test:a' }
    })
    // Trip the cache pre-check by tracking how many calls the extractor receives.
    let calls = 0
    const counting: Extractor = {
      async extract(p) {
        calls++
        return makeExtractor().extract(p)
      }
    }
    const ingest2 = createIngestApi({
      sqlite,
      embeddings: makeEmbeddings(),
      extractor: counting,
      cache
    })
    await ingest2.append({
      documentId: 'doc-A',
      text: 'Josh works with Sovereign.',
      assertedBy: { did: 'did:test:a' }
    })
    expect(calls).toBe(0)
  })

  it('retract removes the document chunks and orphan entities', async () => {
    const sqlite = createSqliteIndex({ path: ':memory:', embeddingDimension: DIM })
    const cache = createIngestCache(sqlite)
    const ingest = createIngestApi({
      sqlite,
      embeddings: makeEmbeddings(),
      extractor: makeExtractor(),
      cache
    })
    await ingest.append({
      documentId: 'doc-A',
      text: 'Josh works with Sovereign.',
      assertedBy: { did: 'did:test:a' }
    })
    await ingest.retract('doc-A')
    expect(sqlite.allEntityUris()).toEqual([])
  })

  it('accumulates assertedBy across multiple agents asserting the same entity', async () => {
    const sqlite = createSqliteIndex({ path: ':memory:', embeddingDimension: DIM })
    const cache = createIngestCache(sqlite)
    const ingest = createIngestApi({
      sqlite,
      embeddings: makeEmbeddings(),
      extractor: makeExtractor(),
      cache
    })
    await ingest.append({
      documentId: 'doc-A',
      text: 'Josh writes a story.',
      assertedBy: { did: 'did:a' }
    })
    await ingest.append({
      documentId: 'doc-B',
      text: 'Josh writes another story.',
      assertedBy: { did: 'did:b' }
    })
    const joshUri = sqlite.allEntityUris().find((u) => sqlite.getEntity(u)?.name === 'Josh')
    expect(joshUri).toBeTruthy()
    const josh = sqlite.getEntity(joshUri!)
    expect(josh?.assertedBy.map((a) => a.did).sort()).toEqual(['did:a', 'did:b'])
  })
})
