// AD4M live integration test for the KnowledgeGraphStore.
//
// Each test spawns its own ad4m-executor in an isolated data dir on a
// random port. We exercise the real wire — addLinks against a real
// perspective, queryLinks back, removeLink for unpublishing, the
// subscription path for inbound reconciliation.
//
// Gated behind AD4M_RAG_INTEGRATION=1 so unit-test runs don't try to
// spawn executors.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startLiveExecutor, type LiveExecutor } from './harness.js'
import { createSqliteIndex, type SqliteIndex } from '../../src/sqlite/index.js'
import { createKnowledgeGraphStore, type KnowledgeGraphStore } from '../../src/store.js'
import type { EmbeddingClient } from '../../src/clients/embedding.js'
import { entityUri, claimUri, communityUri, relationshipUri } from '../../src/uri.js'
import type { Claim, Community, Entity, Relationship } from '../../src/types.js'

const INTEGRATION_ENABLED = !!process.env.AD4M_RAG_INTEGRATION

const DIM = 4

function toyEmbeddings(): EmbeddingClient {
  return {
    async embed(text: string) {
      const c = (text.charCodeAt(0) || 0) / 128
      return [c, 1 - c, 0, 0]
    },
    async embedBatch(texts: string[]) {
      return texts.map((t) => {
        const c = (t.charCodeAt(0) || 0) / 128
        return [c, 1 - c, 0, 0]
      })
    },
    dimension: () => DIM
  }
}

const RUN = INTEGRATION_ENABLED ? describe : describe.skip

RUN('KnowledgeGraphStore (live AD4M executor)', () => {
  let executor: LiveExecutor
  let sqlite: SqliteIndex
  let store: KnowledgeGraphStore

  beforeEach(async () => {
    executor = await startLiveExecutor()
    sqlite = createSqliteIndex({ path: ':memory:', embeddingDimension: DIM })
    store = createKnowledgeGraphStore({
      sqlite,
      embeddings: toyEmbeddings(),
      ad4m: {
        client: executor.client,
        privatePerspectiveUuid: executor.perspectiveUuid
      }
    })
  }, 120_000)

  afterEach(async () => {
    try {
      await store.dispose()
    } catch {
      /* ignore — sqlite close errors don't matter at teardown */
    }
    await executor.dispose()
  }, 30_000)

  function makeEntity(name: string, description = 'd', type = 'Person'): Entity {
    return {
      uri: entityUri(type, name),
      type,
      name,
      description,
      aliases: [],
      assertedBy: [{ did: 'did:test:a' }],
      sourceChunkIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  }

  it('upsertEntity writes Links to the real perspective', async () => {
    const e = makeEntity('Josh', 'A human being.')
    await store.upsertEntity(e)
    // Round-trip via reindex (which pulls from AD4M back into a fresh sqlite).
    sqlite.reset()
    await store.reindex()
    expect(sqlite.getEntity(e.uri)?.name).toBe('Josh')
    expect(sqlite.getEntity(e.uri)?.description).toBe('A human being.')
    expect(sqlite.getEntity(e.uri)?.type).toBe('Person')
  }, 60_000)

  it('upsertRelationship + reindex round-trip', async () => {
    const a = makeEntity('Alice')
    const b = makeEntity('Bob')
    await store.upsertEntity(a)
    await store.upsertEntity(b)
    const r: Relationship = {
      uri: relationshipUri(a.uri, 'works_with', b.uri),
      source: a.uri,
      predicate: 'works_with',
      target: b.uri,
      description: 'collaboration',
      weight: 0.7,
      assertedBy: [{ did: 'did:test:a' }],
      sourceChunkIds: [],
      createdAt: 1
    }
    await store.upsertRelationship(r)
    sqlite.reset()
    await store.reindex()
    const rels = sqlite.allRelationships()
    const back = rels.find((x) => x.uri === r.uri)
    expect(back).toBeTruthy()
    expect(back!.predicate).toBe('works_with')
    expect(back!.weight).toBeCloseTo(0.7, 3)
  }, 60_000)

  it('upsertClaim + reindex round-trip', async () => {
    const a = makeEntity('Sovereign', 'A platform.', 'Project')
    await store.upsertEntity(a)
    const c: Claim = {
      uri: claimUri(a.uri, 'Sovereign uses an event bus.'),
      about: a.uri,
      statement: 'Sovereign uses an event bus.',
      evidenceChunkIds: ['chunk:1'],
      assertedBy: [{ did: 'did:test:a' }],
      createdAt: 1
    }
    await store.upsertClaim(c)
    sqlite.reset()
    await store.reindex()
    const back = sqlite.getClaim(c.uri)
    expect(back?.statement).toBe('Sovereign uses an event bus.')
    expect(back?.about).toBe(a.uri)
  }, 60_000)

  it('upsertCommunity + reindex round-trip', async () => {
    const a = makeEntity('Alpha')
    const b = makeEntity('Beta')
    await store.upsertEntity(a)
    await store.upsertEntity(b)
    const com: Community = {
      uri: communityUri(0, [a.uri, b.uri]),
      level: 0,
      memberEntityUris: [a.uri, b.uri],
      summary: 'A small cluster.',
      createdAt: 1
    }
    await store.upsertCommunity(com)
    sqlite.reset()
    await store.reindex()
    const back = sqlite.listCommunities().find((x) => x.uri === com.uri)
    expect(back?.summary).toBe('A small cluster.')
    expect(back?.memberEntityUris.sort()).toEqual([a.uri, b.uri].sort())
  }, 60_000)

  it('reindex re-embeds entity descriptions so vector search keeps working', async () => {
    const e1 = makeEntity('Apple', 'A fruit company.', 'Organisation')
    const e2 = makeEntity('Orange', 'A citrus company.', 'Organisation')
    await store.upsertEntity(e1)
    await store.upsertEntity(e2)

    // Wipe local sqlite (including embeddings) without touching AD4M.
    sqlite.reset()
    await store.reindex()

    const hits = await store.vectorSearchEntities([1, 0, 0, 0], 5)
    expect(hits.length).toBe(2)
  }, 60_000)

  it('publishToPerspective writes to a second perspective without affecting the primary', async () => {
    const secondaryName = 'ad4m-rag-secondary'
    const secondary = await executor.client.perspective.add(secondaryName)
    try {
      const e = makeEntity('Hex', 'An AI assistant.')
      await store.upsertEntity(e)
      const before = await primaryLinkCount(executor, executor.perspectiveUuid)
      await store.publishToPerspective(e.uri, secondary.uuid)
      const afterPrimary = await primaryLinkCount(executor, executor.perspectiveUuid)
      const afterSecondary = await primaryLinkCount(executor, secondary.uuid)
      expect(afterPrimary).toBe(before)
      expect(afterSecondary).toBeGreaterThan(0)
    } finally {
      await executor.client.perspective.remove(secondary.uuid)
    }
  }, 60_000)

  it('unpublishFromPerspective removes only the published subject', async () => {
    const secondary = await executor.client.perspective.add('ad4m-rag-secondary-2')
    try {
      const e = makeEntity('Hex')
      await store.upsertEntity(e)
      await store.publishToPerspective(e.uri, secondary.uuid)
      const before = await primaryLinkCount(executor, secondary.uuid)
      expect(before).toBeGreaterThan(0)
      await store.unpublishFromPerspective(e.uri, secondary.uuid)
      const after = await primaryLinkCount(executor, secondary.uuid)
      expect(after).toBe(0)
    } finally {
      await executor.client.perspective.remove(secondary.uuid)
    }
  }, 60_000)
})

async function primaryLinkCount(executor: LiveExecutor, perspectiveUuid: string): Promise<number> {
  const links = await executor.client.perspective.queryLinks(perspectiveUuid, { source: '', predicate: '', target: '' } as never)
  return (links ?? []).length
}
