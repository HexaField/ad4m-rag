// Entity / relationship / claim extractor.
//
// Prompts the LLM with a chunk and parses a structured JSON response
// into the ExtractionResult shape. The prompt is intentionally simple —
// it's a tunable, see the OpenQuestion in PLAN.md about iterating on
// extraction quality.

import type { LlmClient } from '../clients/llm.js'
import type { ExtractionResult } from '../types.js'

export interface ExtractorOptions {
  /** Maximum tokens for the extraction response. Default 4096. */
  maxTokens?: number
  /** Override the system prompt. Default: a generic English extraction prompt. */
  systemPrompt?: string
  /** Inject domain-specific entity types into the prompt. */
  entityTypes?: string[]
  /** Inject domain-specific relation types into the prompt. */
  relationTypes?: string[]
}

const DEFAULT_SYSTEM = `You extract a knowledge graph from a passage of text. Return ONLY valid JSON
matching this shape, with NO surrounding prose:

{
  "entities": [
    { "type": "<EntityType>", "name": "<short canonical name>", "description": "<one sentence>", "aliases": ["<optional>"] }
  ],
  "relationships": [
    {
      "source": { "type": "<EntityType>", "name": "<name>" },
      "predicate": "<RelationType>",
      "target": { "type": "<EntityType>", "name": "<name>" },
      "description": "<one sentence>",
      "weight": 0.7
    }
  ],
  "claims": [
    { "about": { "type": "<EntityType>", "name": "<name>" }, "statement": "<single factual statement>" }
  ]
}

Rules:
- Use TitleCase for entity types (Person, Project, Concept, Decision, Event, Place, Organisation, Document, etc).
- Use snake_case for relation predicates (works_on, depends_on, derived_from, mentions, located_in, etc).
- Each entity is mentioned at most once; merge duplicates.
- weight ∈ [0,1] — 0.5 default, higher when the text emphasises the link.
- A claim must be a single, verifiable factual statement about its "about" entity.
- Return an empty array if no extractions of a kind are warranted.`

export function createExtractor(llm: LlmClient, opts: ExtractorOptions = {}) {
  const systemBase = opts.systemPrompt ?? DEFAULT_SYSTEM
  const types = [
    opts.entityTypes && opts.entityTypes.length > 0 ? `Preferred entity types: ${opts.entityTypes.join(', ')}.` : '',
    opts.relationTypes && opts.relationTypes.length > 0
      ? `Preferred relation predicates: ${opts.relationTypes.join(', ')}.`
      : ''
  ]
    .filter(Boolean)
    .join('\n')
  const system = types ? `${systemBase}\n\n${types}` : systemBase

  return {
    async extract(passage: string): Promise<ExtractionResult> {
      const response = await llm.complete({
        system,
        user: passage,
        maxTokens: opts.maxTokens ?? 4096,
        temperature: 0
      })
      return parseExtractionResponse(response)
    }
  }
}

/** Parse an LLM response into ExtractionResult. Tolerates code fences and trailing prose. */
export function parseExtractionResponse(raw: string): ExtractionResult {
  const jsonText = stripCodeFences(raw).trim()
  // Find the first { and the last matching } in case the model added prose.
  const start = jsonText.indexOf('{')
  const end = jsonText.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('extraction parse: no JSON object found in LLM response')
  }
  const slice = jsonText.slice(start, end + 1)
  let parsed: any
  try {
    parsed = JSON.parse(slice)
  } catch (err) {
    throw new Error(`extraction parse: invalid JSON — ${(err as Error).message}`)
  }

  const entities = Array.isArray(parsed.entities) ? parsed.entities : []
  const relationships = Array.isArray(parsed.relationships) ? parsed.relationships : []
  const claims = Array.isArray(parsed.claims) ? parsed.claims : []

  // Validate the shape of every record; drop anything malformed.
  return {
    entities: entities
      .filter(
        (e: any) =>
          e && typeof e.type === 'string' && typeof e.name === 'string' && typeof e.description === 'string'
      )
      .map((e: any) => ({
        type: e.type.trim(),
        name: e.name.trim(),
        description: e.description.trim(),
        aliases: Array.isArray(e.aliases) ? e.aliases.filter((a: any) => typeof a === 'string') : undefined
      })),
    relationships: relationships
      .filter((r: any) => {
        return (
          r &&
          r.source &&
          typeof r.source.type === 'string' &&
          typeof r.source.name === 'string' &&
          typeof r.predicate === 'string' &&
          r.target &&
          typeof r.target.type === 'string' &&
          typeof r.target.name === 'string' &&
          typeof r.description === 'string'
        )
      })
      .map((r: any) => ({
        source: { type: r.source.type.trim(), name: r.source.name.trim() },
        predicate: r.predicate.trim(),
        target: { type: r.target.type.trim(), name: r.target.name.trim() },
        description: r.description.trim(),
        weight: typeof r.weight === 'number' && isFinite(r.weight) ? Math.max(0, Math.min(1, r.weight)) : 0.5
      })),
    claims: claims
      .filter(
        (c: any) =>
          c && c.about && typeof c.about.type === 'string' && typeof c.about.name === 'string' && typeof c.statement === 'string'
      )
      .map((c: any) => ({
        about: { type: c.about.type.trim(), name: c.about.name.trim() },
        statement: c.statement.trim()
      }))
  }
}

function stripCodeFences(s: string): string {
  // ```json\n...\n``` or ```\n...\n```
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/)
  return m ? m[1] : s
}
