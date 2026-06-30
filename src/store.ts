// KnowledgeGraphStore — the single storage abstraction the rest of the
// library (ingest, query, community) consumes.
//
// Writes go AD4M-first via the host-provided client; the local sqlite
// index is updated only after the AD4M write succeeds. Reads hit the
// sqlite index (fast path). `reindex()` drops the local index and
// repopulates from AD4M.

import type { Ad4mClient } from '@coasys/ad4m'
import { createAd4mFacade, type Ad4mClientFacade } from './ad4m/client.js'
import { parseLinks } from './ad4m/parse.js'
import {
  claimToLinks,
  communityToLinks,
  entityToLinks,
  relationshipToLinks
} from './ad4m/serialise.js'
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
  ad4m: {
    /** Fully-authenticated Ad4mClient instance (host-provided). */
    client: Ad4mClient
    /** The library's private perspective uuid — must exist; host responsibility. */
    privatePerspectiveUuid: string
    /** Optional set of shared perspectives whose inbound subjects are reconciled into the local index. */
    sharedPerspectiveUuids?: string[]
  }
}

/** Default batch size for AD4M link writes. */
const ADD_LINKS_BATCH_SIZE = 50

export function createKnowledgeGraphStore(deps: KnowledgeGraphStoreDeps): KnowledgeGraphStore {
  const facade: Ad4mClientFacade = createAd4mFacade(deps.ad4m.client)
  const priv = deps.ad4m.privatePerspectiveUuid

  /** Push a batch of Links to AD4M in `ADD_LINKS_BATCH_SIZE` chunks. */
  async function pushLinks(perspectiveUuid: string, links: import('@coasys/ad4m').Link[]): Promise<void> {
    for (let i = 0; i < links.length; i += ADD_LINKS_BATCH_SIZE) {
      const chunk = links.slice(i, i + ADD_LINKS_BATCH_SIZE)
      await facade.addLinks(perspectiveUuid, chunk)
    }
  }

  // ── Inbound reconciliation from shared perspectives ──────────
  const disposers: Array<() => void> = []
  for (const shared of deps.ad4m.sharedPerspectiveUuids ?? []) {
    const onAdded = (link: { data: { source: string; predicate: string; target: string } }) => {
      const parsed = parseLinks([link])
      for (const e of parsed.entities) deps.sqlite.upsertEntity(e)
      for (const r of parsed.relationships) deps.sqlite.upsertRelationship(r)
      for (const c of parsed.claims) deps.sqlite.upsertClaim(c)
      for (const c of parsed.communities) deps.sqlite.upsertCommunity(c)
      if (parsed.entities.length > 0 || parsed.relationships.length > 0 || parsed.claims.length > 0 || parsed.communities.length > 0) {
        deps.sqlite.recordPublication(
          parsed.entities[0]?.uri ??
            parsed.relationships[0]?.uri ??
            parsed.claims[0]?.uri ??
            parsed.communities[0]?.uri ??
            '',
          shared
        )
      }
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
      // Drop + recreate schema.
      const dim = (() => {
        // Sentinel: fetch dimension by inspecting the first vector row.
        return 0
      })()
      void dim
      deps.sqlite.reset()
      // Pull everything from the private perspective + shared perspectives.
      const allUuids = [priv, ...(deps.ad4m.sharedPerspectiveUuids ?? [])]
      for (const uuid of allUuids) {
        const links = await facade.queryAllLinks(uuid)
        const parsed = parseLinks(links)
        for (const e of parsed.entities) deps.sqlite.upsertEntity(e)
        for (const r of parsed.relationships) deps.sqlite.upsertRelationship(r)
        for (const c of parsed.claims) deps.sqlite.upsertClaim(c)
        for (const c of parsed.communities) deps.sqlite.upsertCommunity(c)
        // Re-record publications.
        if (uuid !== priv) {
          for (const e of parsed.entities) deps.sqlite.recordPublication(e.uri, uuid)
          for (const r of parsed.relationships) deps.sqlite.recordPublication(r.uri, uuid)
          for (const c of parsed.claims) deps.sqlite.recordPublication(c.uri, uuid)
          for (const c of parsed.communities) deps.sqlite.recordPublication(c.uri, uuid)
        }
      }
      // Embeddings are NOT recovered by reindex — callers must re-embed via
      // ingest reextract() or by rebuilding embeddings explicitly. Without
      // embeddings, vector search returns no results until repaired.
    },

    async dispose() {
      for (const d of disposers) d()
      deps.sqlite.close()
    }
  }
}
