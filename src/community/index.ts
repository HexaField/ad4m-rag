// Run community detection + summarisation against a sqlite index. The
// orchestrator function lives here so consumers don't need to wire
// together the detection and summarisation steps themselves.
//
// Summary results are written back into the sqlite store as Community
// records, with their embeddings indexed for global queries.

import type { EmbeddingClient } from '../clients/embedding.js'
import type { LlmClient } from '../clients/llm.js'
import type { SqliteIndex } from '../sqlite/index.js'
import type { Community, Entity } from '../types.js'
import { hashInputs, type IngestCache } from '../ingest/cache.js'
import { communityUri } from '../uri.js'
import { detectHierarchy, type DetectOptions } from './detect.js'
import { createCommunitySummariser, type SummariseOptions } from './summarise.js'

export { detectHierarchy } from './detect.js'
export type { DetectedLevel, DetectOptions } from './detect.js'
export { createCommunitySummariser } from './summarise.js'
export type { SummariseOptions } from './summarise.js'

export interface RebuildCommunitiesDeps {
  sqlite: SqliteIndex
  llm: LlmClient
  embeddings: EmbeddingClient
  cache: IngestCache
  detect?: DetectOptions
  summarise?: SummariseOptions
}

export interface RebuildCommunitiesResult {
  levels: number
  communitiesWritten: number
}

/**
 * Run multi-level community detection over the current graph, summarise
 * each community, embed the summary, and persist as Community records.
 * Cached per (level, sorted member URIs) so unchanged communities don't
 * re-summarise.
 */
export async function rebuildCommunities(deps: RebuildCommunitiesDeps): Promise<RebuildCommunitiesResult> {
  const entityUris = deps.sqlite.allEntityUris()
  if (entityUris.length === 0) return { levels: 0, communitiesWritten: 0 }
  const rels = deps.sqlite.allRelationships()
  const hierarchy = detectHierarchy(entityUris, rels, deps.detect)

  const entities = new Map<string, Entity>()
  for (const uri of entityUris) {
    const e = deps.sqlite.getEntity(uri)
    if (e) entities.set(uri, e)
  }

  const summariser = createCommunitySummariser(deps.llm, deps.summarise)
  const now = Date.now()
  let communitiesWritten = 0

  // Track parents — for each community at level L, its parent is the
  // community at level L+1 that all its members fall into. Communities
  // at the top level have no parent. We compute parents by looking up
  // each member's assignment at level L+1.
  const parentByLevelAndCommunity = new Map<string, string>() // key: "level|communityId"

  for (let i = 0; i < hierarchy.length; i++) {
    const lvl = hierarchy[i]
    for (const [communityId, memberUris] of lvl.members) {
      const cuid = communityUri(lvl.level, memberUris)
      const cacheKey = hashInputs('summary', cuid)
      let summary = deps.cache.get<string>('community-summary', cacheKey)
      if (!summary) {
        const memberEntities = memberUris.map((u) => entities.get(u)).filter((e): e is Entity => !!e)
        const memberSet = new Set(memberUris)
        const inCommunityRels = rels.filter((r) => memberSet.has(r.source) && memberSet.has(r.target))
        summary = await summariser.summarise(memberEntities, inCommunityRels)
        deps.cache.set('community-summary', cacheKey, summary)
      }

      // Resolve parent at next level if present.
      let parent: string | undefined
      if (i + 1 < hierarchy.length) {
        // All members of this community at level L belong to the same level-(L+1)
        // community iff Leiden's hierarchy nests them — which it doesn't strictly
        // (independent runs at different resolutions). Use the modal parent:
        // whichever level-(L+1) community most members fall into.
        const next = hierarchy[i + 1]
        const tally = new Map<number, number>()
        for (const u of memberUris) {
          const a = next.assignments.get(u)
          if (a !== undefined) tally.set(a, (tally.get(a) ?? 0) + 1)
        }
        let bestId = -1
        let bestCount = -1
        for (const [id, c] of tally) {
          if (c > bestCount) {
            bestCount = c
            bestId = id
          }
        }
        if (bestId >= 0) {
          const nextMembers = next.members.get(bestId) ?? []
          parent = communityUri(next.level, nextMembers)
        }
      }

      const c: Community = {
        uri: cuid,
        level: lvl.level,
        parent,
        memberEntityUris: memberUris,
        summary: summary ?? '',
        createdAt: now
      }
      deps.sqlite.upsertCommunity(c)
      parentByLevelAndCommunity.set(`${lvl.level}|${communityId}`, cuid)
      communitiesWritten++
    }
  }

  // Embed all community summaries (single batched call).
  const allCommunities = deps.sqlite.listCommunities()
  const toEmbed = allCommunities.filter((c) => c.summary && c.summary.length > 0)
  if (toEmbed.length > 0) {
    const vectors = await deps.embeddings.embedBatch(toEmbed.map((c) => c.summary))
    for (let i = 0; i < toEmbed.length; i++) {
      deps.sqlite.storeCommunityEmbedding(toEmbed[i].uri, vectors[i])
    }
  }

  return { levels: hierarchy.length, communitiesWritten }
}
