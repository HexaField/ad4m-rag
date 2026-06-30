// Per-community LLM summarisation.

import type { LlmClient } from '../clients/llm.js'
import type { Entity, Relationship } from '../types.js'

export interface SummariseOptions {
  /** Override system prompt. */
  systemPrompt?: string
  /** Maximum tokens in the summary response. Default 512. */
  maxTokens?: number
}

const DEFAULT_SYSTEM = `You write tight, one-paragraph community reports over a sub-graph of a
knowledge graph. Given the entities and the relationships between them,
state — without filler — what this cluster is about, the dominant
themes, and the most salient relationships. Maximum 5 sentences. Plain
prose, no bullet points, no headers.`

export function createCommunitySummariser(llm: LlmClient, opts: SummariseOptions = {}) {
  const system = opts.systemPrompt ?? DEFAULT_SYSTEM
  const maxTokens = opts.maxTokens ?? 512

  return {
    async summarise(members: Entity[], rels: Relationship[]): Promise<string> {
      if (members.length === 0) return ''
      const entityLines = members.map((e) => `- [${e.type}] ${e.name}: ${e.description || '(no description)'}`)
      const relLines = rels.map((r) => {
        const src = members.find((m) => m.uri === r.source)?.name ?? r.source
        const tgt = members.find((m) => m.uri === r.target)?.name ?? r.target
        return `- ${src} —[${r.predicate}]→ ${tgt}${r.description ? `: ${r.description}` : ''}`
      })
      const user = [
        'Entities:',
        entityLines.join('\n'),
        '',
        'Relationships:',
        relLines.length > 0 ? relLines.join('\n') : '(none in-community)'
      ].join('\n')
      const out = await llm.complete({ system, user, maxTokens, temperature: 0 })
      return out.trim()
    }
  }
}
