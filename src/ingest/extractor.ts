// Entity / relationship / claim extractor.
//
// Prompts the LLM with a chunk and parses a structured JSON response
// into the ExtractionResult shape. The prompt is intentionally simple —
// it's a tunable, see the OpenQuestion in PLAN.md about iterating on
// extraction quality.

import { ALL_CELL_CLASSES, CELL_CLASS_BY_ID, type CellId } from '@hexafield/hexevent'
import type { LlmClient } from '../clients/llm.js'
import type { ExtractedCellAssignment, ExtractionResult } from '../types.js'

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

const CELL_VOCABULARY_LINES = ALL_CELL_CLASSES
  .map((c) => `  - "${c.cellId}" — ${c.label}`)
  .join('\n')

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
    {
      "about": { "type": "<EntityType>", "name": "<name>" },
      "statement": "<single factual statement>",
      "cells": [
        { "cell": "<cellId>", "filler": "<short noun phrase or value>", "conceptIri": "<optional IRI>", "source": "<optional provenance hint>" }
      ]
    }
  ]
}

Rules:
- Use TitleCase for entity types (Person, Project, Concept, Decision, Event, Place, Organisation, Document, etc).
- Use snake_case for relation predicates (works_on, depends_on, derived_from, mentions, located_in, etc).
- Each entity is mentioned at most once; merge duplicates.
- weight ∈ [0,1] — 0.5 default, higher when the text emphasises the link.
- A claim must be a single, verifiable factual statement about its "about" entity.

Cell decomposition:
Every claim is a description of an event. Decompose it across the 12-cell
5W1H × subjective/objective ontology. Each "cell" value must be one of:
${CELL_VOCABULARY_LINES}
Objective cells carry measurable form (timestamp, named actor, location,
mechanism). Subjective cells carry felt or intended aspects (motivation,
urgency, felt manner). Populate only the cells the passage actually
warrants — leaving a cell out is itself meaningful. Each filler is a
short noun phrase or value. Aim for 2–6 cells per claim, more if the
passage is rich.

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
        statement: c.statement.trim(),
        cells: parseExtractedCells(c.cells)
      }))
  }
}

/**
 * Validate cell entries from an LLM response. Drops anything whose
 * `cell` isn't one of the twelve known cell ids; trims filler/source
 * strings; passes conceptIri through when present.
 */
export function parseExtractedCells(raw: unknown): ExtractedCellAssignment[] {
  if (!Array.isArray(raw)) return []
  const out: ExtractedCellAssignment[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const cellRaw = (item as any).cell
    const fillerRaw = (item as any).filler
    if (typeof cellRaw !== 'string' || typeof fillerRaw !== 'string') continue
    const cell = cellRaw.trim() as CellId
    const filler = fillerRaw.trim()
    if (!filler) continue
    if (!CELL_CLASS_BY_ID[cell]) continue
    const conceptIriRaw = (item as any).conceptIri
    const sourceRaw = (item as any).source
    const conceptIri = typeof conceptIriRaw === 'string' && conceptIriRaw.trim() ? conceptIriRaw.trim() : undefined
    const source = typeof sourceRaw === 'string' && sourceRaw.trim() ? sourceRaw.trim() : undefined
    out.push({ cell, filler, conceptIri, source })
  }
  return out
}

function stripCodeFences(s: string): string {
  // ```json\n...\n``` or ```\n...\n```
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/)
  return m ? m[1] : s
}
