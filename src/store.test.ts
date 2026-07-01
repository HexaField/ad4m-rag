// Unit tests for the KnowledgeGraphStore that don't need a live AD4M
// executor — they use an in-memory mock facade. The live integration
// tests cover the real wire (see tests/integration/).

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteIndex, type SqliteIndex } from './sqlite/index.js'
import { createKnowledgeGraphStore, type KnowledgeGraphStore } from './store.js'
import type { Ad4mClientFacade } from './ad4m/client.js'
import type { EmbeddingClient } from './clients/embedding.js'
import {
  claimToLinks,
  communityToLinks,
  entityToLinks,
  relationshipToLinks
} from './ad4m/serialise.js'
import { entityUri, claimUri, communityUri, relationshipUri } from './uri.js'
import type { Claim, Community, Entity, Relationship } from './types.js'

const DIM = 4

/**
 * In-memory mock of Ad4mClientFacade. Each perspective is a flat list of
 * Link triples; subscribers are notified on addLinks / removeLink.
 */
function createMockFacade(): {
  facade: Ad4mClientFacade
  perspective(uuid: string): { source: string; predicate: string; target: string }[]
} {
  type Triple = { source: string; predicate: string; target: string }
  const perspectives = new Map<string, Triple[]>()
  const addedSubs = new Map<string, ((l: { data: Triple }) => void)[]>()
  const removedSubs = new Map<string, ((l: { data: Triple }) => void)[]>()
  function get(uuid: string): Triple[] {
    let arr = perspectives.get(uuid)
    if (!arr) {
      arr = []
      perspectives.set(uuid, arr)
    }
    return arr
  }
  const facade: Ad4mClientFacade = {
    async perspectiveByUuid() {
      return null as never
    },
    async addLinks(uuid, links) {
      const arr = get(uuid)
      for (const l of links) {
        const triple: Triple = { source: l.source, predicate: l.predicate ?? '', target: l.target }
        arr.push(triple)
        for (const sub of addedSubs.get(uuid) ?? []) sub({ data: triple })
      }
    },
    async removeLink(uuid, link) {
      const arr = get(uuid)
      const idx = arr.findIndex(
        (t) => t.source === link.source && t.predicate === link.predicate && t.target === link.target
      )
      if (idx >= 0) {
        const [removed] = arr.splice(idx, 1)
        for (const sub of removedSubs.get(uuid) ?? []) sub({ data: removed })
      }
    },
    async queryAllLinks(uuid) {
      return get(uuid).map((t) => ({ data: t }))
    },
    subscribeLinks(uuid, onAdded, onRemoved) {
      const a = addedSubs.get(uuid) ?? []
      a.push(onAdded)
      addedSubs.set(uuid, a)
      const r = removedSubs.get(uuid) ?? []
      r.push(onRemoved)
      removedSubs.set(uuid, r)
      return () => {
        addedSubs.set(uuid, (addedSubs.get(uuid) ?? []).filter((f) => f !== onAdded))
        removedSubs.set(uuid, (removedSubs.get(uuid) ?? []).filter((f) => f !== onRemoved))
      }
    }
  }
  return { facade, perspective: (uuid) => get(uuid) }
}

function makeEmbeddings(): EmbeddingClient {
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

describe('KnowledgeGraphStore (mock-AD4M)', () => {
  let sqlite: SqliteIndex
  let store: KnowledgeGraphStore
  let mock: ReturnType<typeof createMockFacade>
  let embeddings: EmbeddingClient

  const PRIV = 'persp-private'
  const SHARED = 'persp-shared'

  beforeEach(() => {
    sqlite = createSqliteIndex({ path: ':memory:', embeddingDimension: DIM })
    mock = createMockFacade()
    embeddings = makeEmbeddings()
    store = createKnowledgeGraphStore({
      sqlite,
      embeddings,
      ad4m: {
        facade: mock.facade,
        privatePerspectiveUuid: PRIV,
        sharedPerspectiveUuids: [SHARED]
      }
    })
  })

  function makeEntity(uri: string, name: string, description = 'd'): Entity {
    return {
      uri,
      type: 'Person',
      name,
      description,
      aliases: [],
      assertedBy: [{ did: 'did:a' }],
      sourceChunkIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  }

  it('upsertEntity writes links to the private perspective AND the local sqlite', async () => {
    const e = makeEntity(entityUri('Person', 'Josh'), 'Josh')
    await store.upsertEntity(e)
    expect(await store.getEntity(e.uri)).toEqual(e)
    const links = mock.perspective(PRIV)
    // Sanity: every link triple has uri as source.
    expect(links.length).toBeGreaterThan(0)
    expect(links.every((l) => l.source === e.uri)).toBe(true)
  })

  it('publishToPerspective copies a subject into the named perspective without affecting the private copy', async () => {
    const e = makeEntity(entityUri('Person', 'Josh'), 'Josh')
    await store.upsertEntity(e)
    const beforePrivate = mock.perspective(PRIV).length
    await store.publishToPerspective(e.uri, SHARED)
    expect(mock.perspective(PRIV).length).toBe(beforePrivate) // unchanged
    const sharedLinks = mock.perspective(SHARED)
    expect(sharedLinks.every((l) => l.source === e.uri)).toBe(true)
    expect(sqlite.listPublications(e.uri)).toEqual([SHARED])
  })

  it('publishToPerspective is idempotent — re-publishing adds no duplicate links', async () => {
    const e = makeEntity(entityUri('Person', 'Josh'), 'Josh')
    await store.upsertEntity(e)
    await store.publishToPerspective(e.uri, SHARED)
    const afterFirst = mock.perspective(SHARED).length
    expect(afterFirst).toBeGreaterThan(0)
    // Second publish of the same subject must be a no-op on the wire.
    await store.publishToPerspective(e.uri, SHARED)
    expect(mock.perspective(SHARED).length).toBe(afterFirst)
  })

  it('unpublishFromPerspective removes all subject links from the named perspective', async () => {
    const e = makeEntity(entityUri('Person', 'Josh'), 'Josh')
    await store.upsertEntity(e)
    await store.publishToPerspective(e.uri, SHARED)
    expect(mock.perspective(SHARED).length).toBeGreaterThan(0)
    await store.unpublishFromPerspective(e.uri, SHARED)
    expect(mock.perspective(SHARED).length).toBe(0)
    expect(sqlite.listPublications(e.uri)).toEqual([])
  })

  it('reconciles inbound link events from a shared perspective into the local sqlite', async () => {
    // Bypass the store — push links straight onto the shared perspective via the mock,
    // which fires the subscribed listener. Reconciliation is async (it queries the
    // perspective for the full subject), so wait a tick.
    const e: Entity = {
      uri: entityUri('Person', 'Alice'),
      type: 'Person',
      name: 'Alice',
      description: 'Author of papers.',
      aliases: [],
      assertedBy: [{ did: 'did:peer' }],
      sourceChunkIds: [],
      createdAt: 5,
      updatedAt: 5
    }
    await mock.facade.addLinks(SHARED, entityToLinks(e))
    // Reconciliation is async — poll briefly until the entity lands.
    for (let i = 0; i < 20 && !sqlite.getEntity(e.uri); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(sqlite.getEntity(e.uri)).toEqual(e)
    expect(sqlite.listPublications(e.uri)).toEqual([SHARED])
  })

  it('reindex drops the local index and rebuilds entities + relationships + claims + communities from AD4M', async () => {
    const e = makeEntity(entityUri('Project', 'Sovereign'), 'Sovereign', 'A platform.')
    e.type = 'Project'
    const r: Relationship = {
      uri: relationshipUri(e.uri, 'depends_on', e.uri),
      source: e.uri,
      predicate: 'depends_on',
      target: e.uri,
      description: 'self',
      weight: 0.5,
      assertedBy: [{ did: 'did:a' }],
      sourceChunkIds: [],
      createdAt: 1
    }
    const c: Claim = {
      uri: claimUri(e.uri, 'It uses an event bus.'),
      about: e.uri,
      statement: 'It uses an event bus.',
      cells: [],
      evidenceChunkIds: [],
      assertedBy: [{ did: 'did:a' }],
      createdAt: 1
    }
    const com: Community = {
      uri: communityUri(0, [e.uri]),
      level: 0,
      memberEntityUris: [e.uri],
      summary: 'A community of one.',
      createdAt: 1
    }
    await store.upsertEntity(e)
    await store.upsertRelationship(r)
    await store.upsertClaim(c)
    await store.upsertCommunity(com)

    // Wipe everything in sqlite without touching AD4M to simulate corruption.
    sqlite.reset()
    expect(sqlite.allEntityUris()).toEqual([])

    await store.reindex()
    expect(sqlite.getEntity(e.uri)?.type).toBe('Project')
    expect(sqlite.allRelationships().map((x) => x.uri)).toContain(r.uri)
    expect(sqlite.getClaim(c.uri)?.statement).toBe('It uses an event bus.')
    expect(sqlite.listCommunities().map((x) => x.uri)).toContain(com.uri)
  })

  it('reindex re-embeds entities so vector search keeps working', async () => {
    const e1 = makeEntity(entityUri('Person', 'Apple'), 'Apple', 'A fruit company.')
    const e2 = makeEntity(entityUri('Person', 'Orange'), 'Orange', 'A citrus company.')
    await store.upsertEntity(e1)
    await store.upsertEntity(e2)
    sqlite.storeEntityEmbedding(e1.uri, [1, 0, 0, 0])
    sqlite.storeEntityEmbedding(e2.uri, [0, 1, 0, 0])

    sqlite.reset()
    await store.reindex()

    // Vector search should still work — the descriptions were re-embedded
    // using the same toy embedding function (hash of first character).
    const hits = await store.vectorSearchEntities([1, 0, 0, 0], 5)
    expect(hits.length).toBe(2) // both have embeddings; ranking depends on first-char hash
  })

  it('publishing a subject not in the local store throws', async () => {
    await expect(store.publishToPerspective('entity:does-not-exist', SHARED)).rejects.toThrow(/not found/)
  })

  it('refuses to construct without ad4m.client or ad4m.facade', () => {
    expect(() =>
      createKnowledgeGraphStore({
        sqlite,
        embeddings,
        ad4m: { privatePerspectiveUuid: PRIV } as never
      })
    ).toThrow(/client or ad4m.facade/)
  })

  // Suppress unused-var warning for serialise imports used only in this file's spirit.
  it('keeps serialiser imports referenced', () => {
    void claimToLinks
    void communityToLinks
    void relationshipToLinks
  })
})
