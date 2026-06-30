// KnowledgeGraphStore — the single storage abstraction the rest of the
// library (ingest, query, community) consumes.
//
// Writes go AD4M-first via the host-provided client; the local sqlite
// index is updated only after the AD4M write succeeds. Reads hit the
// sqlite index (fast path). `reindex()` drops the local index and
// repopulates from AD4M.

import type { Ad4mClient } from '@coasys/ad4m'
import { CELL_CLASS_BY_IRI } from '@hexafield/hexevent'
import { createAd4mFacade, type Ad4mClientFacade } from './ad4m/client.js'
import { parseLinks } from './ad4m/parse.js'
import { PRED_CELL_OF_CLAIM } from './ad4m/predicates.js'
import {
  claimToLinks,
  communityToLinks,
  entityToLinks,
  relationshipToLinks
} from './ad4m/serialise.js'
import type { EmbeddingClient } from './clients/embedding.js'
import type {
  AgentRef,
  Chunk,
  Claim,
  Community,
  Entity,
  ProvenanceFilter,
  Relationship
} from './types.js'
import type { SqliteIndex } from './sqlite/index.js'

export interface KnowledgeGraphStore {
  // ── Structural upserts ────────────────────────────────────────
  upsertEntity(entity: Entity): Promise<void>
  upsertRelationship(rel: Relationship): Promise<void>
  upsertClaim(claim: Claim): Promise<void>
  upsertCommunity(community: Community): Promise<void>
  upsertChunk(chunk: Chunk): Promise<void>

  // ── Reads ─────────────────────────────────────────────────────
  getEntity(uri: string): Promise<Entity | null>
  getClaim(uri: string): Promise<Claim | null>
  getChunks(ids: string[]): Promise<Chunk[]>
  listRelationships(filter: {
    source?: string
    target?: string
    predicate?: string
    fromAgents?: AgentRef[]
    fromPerspectives?: string[]
  }): Promise<Relationship[]>
  listCommunities(level?: number): Promise<Community[]>

  // ── Vector + FTS search ───────────────────────────────────────
  vectorSearchEntities(query: number[], k: number, filter?: ProvenanceFilter): Promise<Entity[]>
  vectorSearchChunks(query: number[], k: number, filter?: ProvenanceFilter): Promise<Chunk[]>
  vectorSearchCommunities(
    query: number[],
    k: number,
    level?: number,
    filter?: ProvenanceFilter
  ): Promise<Community[]>
  ftsSearchClaims(query: string, k: number, filter?: ProvenanceFilter): Promise<Claim[]>

  // ── Publication ──────────────────────────────────────────────
  publishToPerspective(uri: string, perspectiveUuid: string): Promise<void>
  unpublishFromPerspective(uri: string, perspectiveUuid: string): Promise<void>

  // ── Maintenance ──────────────────────────────────────────────
  reindex(): Promise<void>
  dispose(): Promise<void>
}

export interface KnowledgeGraphStoreDeps {
  sqlite: SqliteIndex
  /** Embedding client. Required for `reindex()` to rebuild the local vector
   *  index (which lives outside AD4M). Other store ops don't touch it. */
  embeddings: EmbeddingClient
  ad4m: {
    /** Fully-authenticated Ad4mClient instance (host-provided). Mutually
     *  exclusive with `facade` — exactly one must be supplied. */
    client?: Ad4mClient
    /** Pre-built Ad4mClientFacade. Lets tests inject a mock that doesn't
     *  require a live executor. Mutually exclusive with `client`. */
    facade?: Ad4mClientFacade
    /** The library's private perspective uuid — must exist; host responsibility. */
    privatePerspectiveUuid: string
    /** Optional set of shared perspectives whose inbound subjects are reconciled into the local index. */
    sharedPerspectiveUuids?: string[]
  }
}

/** Default batch size for AD4M link writes. */
const ADD_LINKS_BATCH_SIZE = 50

export function createKnowledgeGraphStore(deps: KnowledgeGraphStoreDeps): KnowledgeGraphStore {
  if (!deps.ad4m.client && !deps.ad4m.facade) {
    throw new Error('createKnowledgeGraphStore: ad4m.client or ad4m.facade must be provided')
  }
  if (deps.ad4m.client && deps.ad4m.facade) {
    throw new Error('createKnowledgeGraphStore: pass either ad4m.client or ad4m.facade, not both')
  }
  const facade: Ad4mClientFacade = deps.ad4m.facade ?? createAd4mFacade(deps.ad4m.client!)
  const priv = deps.ad4m.privatePerspectiveUuid

  /** Push a batch of Links to AD4M in `ADD_LINKS_BATCH_SIZE` chunks. */
  async function pushLinks(perspectiveUuid: string, links: import('@coasys/ad4m').Link[]): Promise<void> {
    for (let i = 0; i < links.length; i += ADD_LINKS_BATCH_SIZE) {
      const chunk = links.slice(i, i + ADD_LINKS_BATCH_SIZE)
      await facade.addLinks(perspectiveUuid, chunk)
    }
  }

  // ── Inbound reconciliation from shared perspectives ──────────
  //
  // A single link triple is rarely enough on its own to materialise a full
  // domain record — an Entity needs `type`, `entityType`, `name`,
  // `description`, … all on the same subject URI. On every link arrival we
  // schedule a re-parse of the full link set for that subject. Multiple
  // arrivals for the same subject within a microtask are coalesced into a
  // single reconcile; if a reconcile is already running when a new arrival
  // appears, we re-run once it finishes (one extra pass max).
  const disposers: Array<() => void> = []
  for (const shared of deps.ad4m.sharedPerspectiveUuids ?? []) {
    const inFlight = new Map<string, Promise<void>>()
    const pendingAgain = new Set<string>()

    const runReconcile = async (subjectUri: string): Promise<void> => {
      try {
        const all = await facade.queryAllLinks(shared)
        // Build a set of subject URIs whose link bucket we need parsed
        // together: the arrival itself, plus its cell-related neighbours.
        // A Claim arrival pulls its assignments; an assignment arrival
        // pulls its parent Claim *and* sibling assignments so the parsed
        // Claim has its full cell array.
        const wantedSources = new Set<string>([subjectUri])
        const forSubject = all.filter((l) => l.data.source === subjectUri)
        for (const l of forSubject) {
          if (CELL_CLASS_BY_IRI[l.data.predicate]) {
            wantedSources.add(l.data.target)
          }
        }
        for (const l of forSubject) {
          if (l.data.predicate === PRED_CELL_OF_CLAIM) {
            const claimUri = l.data.target
            wantedSources.add(claimUri)
            for (const cl of all) {
              if (cl.data.source === claimUri && CELL_CLASS_BY_IRI[cl.data.predicate]) {
                wantedSources.add(cl.data.target)
              }
            }
          }
        }
        const relevant = all.filter((l) => wantedSources.has(l.data.source))
        const parsed = parseLinks(relevant)
        for (const e of parsed.entities) {
          deps.sqlite.upsertEntity(e)
          deps.sqlite.recordPublication(e.uri, shared)
        }
        for (const r of parsed.relationships) {
          deps.sqlite.upsertRelationship(r)
          deps.sqlite.recordPublication(r.uri, shared)
        }
        for (const c of parsed.claims) {
          deps.sqlite.upsertClaim(c)
          deps.sqlite.recordPublication(c.uri, shared)
        }
        for (const c of parsed.communities) {
          deps.sqlite.upsertCommunity(c)
          deps.sqlite.recordPublication(c.uri, shared)
        }
      } catch (err) {
        console.warn('[ad4m-rag] reconcile failed for', subjectUri, (err as Error).message)
      }
    }

    const reconcile = (subjectUri: string) => {
      const running = inFlight.get(subjectUri)
      if (running) {
        // Mark that another arrival came in while we were running; the
        // currently-running reconcile's finally clause will re-run once.
        pendingAgain.add(subjectUri)
        return
      }
      const p = runReconcile(subjectUri).finally(() => {
        inFlight.delete(subjectUri)
        if (pendingAgain.delete(subjectUri)) reconcile(subjectUri)
      })
      inFlight.set(subjectUri, p)
    }

    const onAdded = (link: { data: { source: string; predicate: string; target: string } }) => {
      reconcile(link.data.source)
    }
    const onRemoved = (_link: { data: { source: string; predicate: string; target: string } }) => {
      // Removal events are coarse; we conservatively don't drop records here.
      // Callers wanting consistency after deletes should call reindex().
    }
    disposers.push(facade.subscribeLinks(shared, onAdded, onRemoved))
  }

  return {
    async upsertEntity(entity) {
      await pushLinks(priv, entityToLinks(entity))
      deps.sqlite.upsertEntity(entity)
    },
    async upsertRelationship(rel) {
      await pushLinks(priv, relationshipToLinks(rel))
      deps.sqlite.upsertRelationship(rel)
    },
    async upsertClaim(claim) {
      await pushLinks(priv, claimToLinks(claim))
      deps.sqlite.upsertClaim(claim)
    },
    async upsertCommunity(community) {
      await pushLinks(priv, communityToLinks(community))
      deps.sqlite.upsertCommunity(community)
    },
    async upsertChunk(chunk) {
      // Chunks are local-only: they're raw passages, not structural data. We
      // don't push them to AD4M because they'd dwarf the structural graph.
      deps.sqlite.upsertChunk(chunk)
    },

    async getEntity(uri) {
      return deps.sqlite.getEntity(uri)
    },
    async getClaim(uri) {
      return deps.sqlite.getClaim(uri)
    },
    async getChunks(ids) {
      return deps.sqlite.getChunks(ids)
    },
    async listRelationships(filter) {
      return deps.sqlite.listRelationships(filter)
    },
    async listCommunities(level) {
      return deps.sqlite.listCommunities(level)
    },

    async vectorSearchEntities(query, k, filter) {
      return deps.sqlite.vectorSearchEntities(query, k, filter)
    },
    async vectorSearchChunks(query, k, filter) {
      return deps.sqlite.vectorSearchChunks(query, k, filter)
    },
    async vectorSearchCommunities(query, k, level, filter) {
      return deps.sqlite.vectorSearchCommunities(query, k, level, filter)
    },
    async ftsSearchClaims(query, k, filter) {
      return deps.sqlite.ftsSearchClaims(query, k, filter)
    },

    async publishToPerspective(uri, perspectiveUuid) {
      const fromEntity = deps.sqlite.getEntity(uri)
      const fromClaim = deps.sqlite.getClaim(uri)
      let links: import('@coasys/ad4m').Link[] = []
      if (fromEntity) links = entityToLinks(fromEntity)
      else if (fromClaim) links = claimToLinks(fromClaim)
      else {
        // Try relationship + community by listing.
        const allRels = deps.sqlite.allRelationships()
        const rel = allRels.find((r) => r.uri === uri)
        if (rel) links = relationshipToLinks(rel)
        else {
          const communities = deps.sqlite.listCommunities()
          const com = communities.find((c) => c.uri === uri)
          if (com) links = communityToLinks(com)
        }
      }
      if (links.length === 0) {
        throw new Error(`publishToPerspective: subject not found in local store: ${uri}`)
      }
      await pushLinks(perspectiveUuid, links)
      deps.sqlite.recordPublication(uri, perspectiveUuid)
    },
    async unpublishFromPerspective(uri, perspectiveUuid) {
      // Remove every link with `source = uri` from the named perspective.
      const allLinks = await facade.queryAllLinks(perspectiveUuid)
      const toRemove = allLinks.filter((l) => l.data.source === uri)
      for (const l of toRemove) {
        await facade.removeLink(perspectiveUuid, l.data)
      }
      deps.sqlite.recordUnpublication(uri, perspectiveUuid)
    },

    async reindex() {
      // Drop the local index and rebuild from AD4M. Embeddings + chunks are
      // local-only (intentionally not stored in AD4M) — we re-embed entity
      // descriptions and community summaries here so vector search keeps
      // working after a reindex. Chunks themselves can't be recovered;
      // callers needing chunk-level vector retrieval after a reindex must
      // re-ingest the original documents via IngestApi.append().
      deps.sqlite.reset()
      const allUuids = [priv, ...(deps.ad4m.sharedPerspectiveUuids ?? [])]
      const entitiesToEmbed: Entity[] = []
      const communitiesToEmbed: Community[] = []
      for (const uuid of allUuids) {
        const links = await facade.queryAllLinks(uuid)
        const parsed = parseLinks(links)
        for (const e of parsed.entities) {
          deps.sqlite.upsertEntity(e)
          entitiesToEmbed.push(e)
        }
        for (const r of parsed.relationships) deps.sqlite.upsertRelationship(r)
        for (const c of parsed.claims) deps.sqlite.upsertClaim(c)
        for (const c of parsed.communities) {
          deps.sqlite.upsertCommunity(c)
          if (c.summary && c.summary.length > 0) communitiesToEmbed.push(c)
        }
        if (uuid !== priv) {
          for (const e of parsed.entities) deps.sqlite.recordPublication(e.uri, uuid)
          for (const r of parsed.relationships) deps.sqlite.recordPublication(r.uri, uuid)
          for (const c of parsed.claims) deps.sqlite.recordPublication(c.uri, uuid)
          for (const c of parsed.communities) deps.sqlite.recordPublication(c.uri, uuid)
        }
      }
      // Re-embed entities by description (skipping description-less stubs).
      const embedEntities = entitiesToEmbed.filter((e) => e.description && e.description.length > 0)
      if (embedEntities.length > 0) {
        const vectors = await deps.embeddings.embedBatch(embedEntities.map((e) => `${e.name}: ${e.description}`))
        for (let i = 0; i < embedEntities.length; i++) {
          deps.sqlite.storeEntityEmbedding(embedEntities[i].uri, vectors[i])
        }
      }
      // Re-embed community summaries.
      if (communitiesToEmbed.length > 0) {
        const vectors = await deps.embeddings.embedBatch(communitiesToEmbed.map((c) => c.summary))
        for (let i = 0; i < communitiesToEmbed.length; i++) {
          deps.sqlite.storeCommunityEmbedding(communitiesToEmbed[i].uri, vectors[i])
        }
      }
    },

    async dispose() {
      for (const d of disposers) d()
      deps.sqlite.close()
    }
  }
}
