// Query engine. Two modes (local, global) behind one API. Provenance
// filters applied at every retrieval step.

import type { EmbeddingClient } from '../clients/embedding.js'
import type { LlmClient } from '../clients/llm.js'
import type { SqliteIndex } from '../sqlite/index.js'
import type {
  Citation,
  Community,
  Entity,
  ProvenanceFilter,
  QueryResult,
  Relationship
} from '../types.js'
import { classifyQueryMode } from './classify.js'

export { classifyQueryMode } from './classify.js'

export interface QueryEngineDeps {
  sqlite: SqliteIndex
  embeddings: EmbeddingClient
  llm: LlmClient
  /** Default mode when caller passes 'auto' or omits. Default: 'auto'. */
  defaultMode?: 'local' | 'global' | 'auto'
  /** Top-k for entity vector retrieval in local mode. Default 6. */
  localEntityK?: number
  /** Walk depth in local mode. Default 2. */
  localGraphDepth?: number
  /** Top-k for community vector retrieval in global mode. Default 8. */
  globalCommunityK?: number
  /** Max community-level to consider in global mode (default: top level present). */
  globalLevel?: number | 'top'
  /** Token budget for assembled context. Default 6000 (approximate). */
  maxContextTokens?: number
}

export interface QueryRequest {
  question: string
  mode?: 'local' | 'global' | 'auto'
  fromAgents?: ProvenanceFilter['fromAgents']
  fromPerspectives?: ProvenanceFilter['fromPerspectives']
  maxTokens?: number
}

export interface QueryEngine {
  query(req: QueryRequest): Promise<QueryResult>
}

export function createQueryEngine(deps: QueryEngineDeps): QueryEngine {
  const localEntityK = deps.localEntityK ?? 6
  const localGraphDepth = deps.localGraphDepth ?? 2
  const globalCommunityK = deps.globalCommunityK ?? 8
  const maxContextTokens = deps.maxContextTokens ?? 6000

  async function query(req: QueryRequest): Promise<QueryResult> {
    const start = Date.now()
    const filter: ProvenanceFilter = {
      fromAgents: req.fromAgents,
      fromPerspectives: req.fromPerspectives
    }
    const requested = req.mode ?? deps.defaultMode ?? 'auto'
    const mode = requested === 'auto' ? classifyQueryMode(req.question) : requested

    let llmCalls = 0
    if (mode === 'local') {
      const { answer, citations, k, hops } = await runLocal(req.question, filter, req.maxTokens)
      llmCalls++
      return {
        answer,
        mode: 'local',
        citations,
        trace: {
          retrievalK: k,
          graphHops: hops,
          llmCalls,
          durationMs: Date.now() - start
        }
      }
    } else {
      const { answer, citations, k, communitiesConsidered, partialAnswers } = await runGlobal(
        req.question,
        filter,
        req.maxTokens
      )
      llmCalls += partialAnswers + 1
      return {
        answer,
        mode: 'global',
        citations,
        trace: {
          retrievalK: k,
          communitiesConsidered,
          partialAnswers,
          llmCalls,
          durationMs: Date.now() - start
        }
      }
    }
  }

  async function runLocal(
    question: string,
    filter: ProvenanceFilter,
    maxAnswerTokens: number | undefined
  ): Promise<{ answer: string; citations: Citation[]; k: number; hops: number }> {
    const queryVec = await deps.embeddings.embed(question)
    const seedEntities = deps.sqlite.vectorSearchEntities(queryVec, localEntityK, filter)
    if (seedEntities.length === 0) {
      return {
        answer: 'No relevant entities found in the local knowledge graph.',
        citations: [],
        k: 0,
        hops: localGraphDepth
      }
    }

    // Walk the graph from each seed up to `localGraphDepth` hops.
    const visited = new Map<string, Entity>()
    for (const e of seedEntities) visited.set(e.uri, e)
    const frontier: Set<string> = new Set(seedEntities.map((e) => e.uri))
    const allRels: Relationship[] = []
    for (let hop = 0; hop < localGraphDepth; hop++) {
      const nextFrontier = new Set<string>()
      for (const uri of frontier) {
        const outs = deps.sqlite.listRelationships({
          source: uri,
          fromAgents: filter.fromAgents,
          fromPerspectives: filter.fromPerspectives
        })
        const ins = deps.sqlite.listRelationships({
          target: uri,
          fromAgents: filter.fromAgents,
          fromPerspectives: filter.fromPerspectives
        })
        // Weight-biased fanout cap per node — top 6 by weight.
        const combined = [...outs, ...ins].sort((a, b) => b.weight - a.weight).slice(0, 6)
        for (const r of combined) {
          allRels.push(r)
          const other = r.source === uri ? r.target : r.source
          if (!visited.has(other)) {
            const e = deps.sqlite.getEntity(other)
            if (e) {
              visited.set(other, e)
              nextFrontier.add(other)
            }
          }
        }
      }
      if (nextFrontier.size === 0) break
      frontier.clear()
      for (const u of nextFrontier) frontier.add(u)
    }

    // Pull a few chunks of evidence from the seed entities' source chunks.
    const evidenceChunkIds = new Set<string>()
    for (const e of seedEntities) for (const id of e.sourceChunkIds) evidenceChunkIds.add(id)
    const chunks = deps.sqlite.getChunks([...evidenceChunkIds].slice(0, 8))

    // Build prompt context, clipped to budget.
    const context = buildLocalContext(question, [...visited.values()], allRels, chunks, maxContextTokens)
    const answer = await deps.llm.complete({
      system: LOCAL_SYSTEM,
      user: context,
      maxTokens: maxAnswerTokens ?? 1024,
      temperature: 0
    })

    const citations: Citation[] = []
    for (const e of seedEntities) citations.push({ kind: 'entity', uri: e.uri, name: e.name })
    for (const ch of chunks) {
      citations.push({
        kind: 'chunk',
        chunkId: ch.id,
        documentId: ch.documentId,
        snippet: ch.text.slice(0, 240) + (ch.text.length > 240 ? '…' : '')
      })
    }

    return { answer: answer.trim(), citations, k: seedEntities.length, hops: localGraphDepth }
  }

  async function runGlobal(
    question: string,
    filter: ProvenanceFilter,
    maxAnswerTokens: number | undefined
  ): Promise<{
    answer: string
    citations: Citation[]
    k: number
    communitiesConsidered: number
    partialAnswers: number
  }> {
    const queryVec = await deps.embeddings.embed(question)
    const allCommunities = deps.sqlite.listCommunities()
    if (allCommunities.length === 0) {
      return {
        answer: 'No communities have been detected yet; ingest more content and rebuild communities.',
        citations: [],
        k: 0,
        communitiesConsidered: 0,
        partialAnswers: 0
      }
    }
    const topLevel = (() => {
      if (deps.globalLevel === 'top' || deps.globalLevel === undefined) {
        return allCommunities.reduce((m, c) => Math.max(m, c.level), 0)
      }
      return deps.globalLevel
    })()
    const communities = deps.sqlite.vectorSearchCommunities(queryVec, globalCommunityK, topLevel, filter)
    if (communities.length === 0) {
      return {
        answer: 'No relevant communities found.',
        citations: [],
        k: 0,
        communitiesConsidered: 0,
        partialAnswers: 0
      }
    }

    // Per-community partial answer.
    const partials: { uri: string; level: number; relevance: number; text: string }[] = []
    for (const c of communities) {
      const partial = await deps.llm.complete({
        system: GLOBAL_PARTIAL_SYSTEM,
        user: buildGlobalPartialContext(question, c),
        maxTokens: 600,
        temperature: 0
      })
      const parsed = parsePartial(partial)
      if (parsed && parsed.relevance > 0) {
        partials.push({ uri: c.uri, level: c.level, relevance: parsed.relevance, text: parsed.text })
      }
    }
    partials.sort((a, b) => b.relevance - a.relevance)
    const reducedInput = partials.slice(0, 6)
    const final = await deps.llm.complete({
      system: GLOBAL_REDUCE_SYSTEM,
      user: buildGlobalReduceContext(question, reducedInput),
      maxTokens: maxAnswerTokens ?? 1500,
      temperature: 0
    })
    const citations: Citation[] = reducedInput.map((p) => ({ kind: 'community', uri: p.uri, level: p.level }))
    return {
      answer: final.trim(),
      citations,
      k: communities.length,
      communitiesConsidered: communities.length,
      partialAnswers: partials.length
    }
  }

  return { query }
}

// ── Prompts ──────────────────────────────────────────────────────────────

const LOCAL_SYSTEM = `You answer questions using ONLY the supplied entities, relationships,
and supporting evidence. If the supplied context does not contain the
answer, say so directly. Cite entities by name where helpful. Be
concise; no filler.`

const GLOBAL_PARTIAL_SYSTEM = `Given a community report, decide whether the report is relevant to the
question and, if so, summarise what the report contributes to an answer.
Return JSON: { "relevance": <0..10>, "text": "<one paragraph or 'n/a'>" }`

const GLOBAL_REDUCE_SYSTEM = `You synthesise a final answer from per-community partial answers. The
partials are ordered by relevance. Combine them into a single answer
that respects the question's framing. Don't fabricate; if the partials
disagree, present both. No filler.`

// ── Context builders ────────────────────────────────────────────────────

function buildLocalContext(
  question: string,
  entities: Entity[],
  rels: Relationship[],
  chunks: { id: string; text: string }[],
  maxTokens: number
): string {
  // Token estimate: chars / 4 (rough). Cap each section.
  const charBudget = maxTokens * 4
  const entityLines = entities
    .slice(0, 30)
    .map((e) => `- [${e.type}] ${e.name}: ${e.description || '(no description)'}`)
    .join('\n')
  const seen = new Set<string>()
  const relLines: string[] = []
  for (const r of rels) {
    const key = `${r.source}|${r.predicate}|${r.target}`
    if (seen.has(key)) continue
    seen.add(key)
    const src = entities.find((e) => e.uri === r.source)?.name ?? r.source
    const tgt = entities.find((e) => e.uri === r.target)?.name ?? r.target
    relLines.push(`- ${src} —[${r.predicate}]→ ${tgt}${r.description ? `: ${r.description}` : ''}`)
    if (relLines.join('\n').length > Math.floor(charBudget / 3)) break
  }
  const chunkLines = chunks.map((c) => `[${c.id}] ${c.text}`).join('\n\n')
  const out = `Question: ${question}\n\nEntities:\n${entityLines}\n\nRelationships:\n${relLines.join('\n') || '(none)'}\n\nEvidence:\n${chunkLines || '(none)'}`
  if (out.length <= charBudget) return out
  return out.slice(0, charBudget)
}

function buildGlobalPartialContext(question: string, community: Community): string {
  return `Question: ${question}\n\nCommunity report (level ${community.level}):\n${community.summary}`
}

function buildGlobalReduceContext(
  question: string,
  partials: { uri: string; level: number; relevance: number; text: string }[]
): string {
  const lines = partials.map(
    (p, i) => `Partial ${i + 1} (level ${p.level}, relevance ${p.relevance.toFixed(1)}):\n${p.text}`
  )
  return `Question: ${question}\n\n${lines.join('\n\n')}`
}

function parsePartial(raw: string): { relevance: number; text: string } | null {
  const trimmed = raw.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1))
    const rel = typeof parsed.relevance === 'number' ? Math.max(0, Math.min(10, parsed.relevance)) : 0
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
    if (!text || text.toLowerCase() === 'n/a') return { relevance: rel, text: '' }
    return { relevance: rel, text }
  } catch {
    return null
  }
}
