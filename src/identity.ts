// Identity-merge rules. When the same Entity (or Relationship, Claim) is
// asserted twice — possibly by different agents, possibly from different
// source chunks — the records must collapse into a single canonical
// record with accumulated `assertedBy` and `sourceChunkIds`.

import type { AgentRef, CellAssignment, Claim, Entity, Relationship } from './types.js'

/** Append `b` to `a`, deduplicating by DID. The resulting array preserves insertion order. */
export function mergeAgents(a: AgentRef[], b: AgentRef[]): AgentRef[] {
  const seen = new Set<string>()
  const out: AgentRef[] = []
  for (const arr of [a, b]) {
    for (const ref of arr) {
      if (!seen.has(ref.did)) {
        seen.add(ref.did)
        out.push(ref)
      }
    }
  }
  return out
}

/** Set-union with stable insertion order. */
export function mergeIds(a: string[], b: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const arr of [a, b]) {
    for (const id of arr) {
      if (!seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    }
  }
  return out
}

/**
 * Merge an existing Entity record with an incoming assertion. The
 * canonical (type, name) is preserved from the existing record.
 * Description from the incoming record wins when non-empty (so iterative
 * extractions can refine), but the existing description is kept on empty
 * input.
 */
export function mergeEntity(existing: Entity, incoming: Omit<Entity, 'createdAt' | 'updatedAt'>): Entity {
  return {
    uri: existing.uri,
    type: existing.type,
    name: existing.name,
    description: incoming.description.trim() || existing.description,
    aliases: mergeIds(existing.aliases ?? [], incoming.aliases ?? []),
    assertedBy: mergeAgents(existing.assertedBy, incoming.assertedBy),
    sourceChunkIds: mergeIds(existing.sourceChunkIds, incoming.sourceChunkIds),
    createdAt: existing.createdAt,
    updatedAt: Date.now()
  }
}

export function mergeRelationship(
  existing: Relationship,
  incoming: Omit<Relationship, 'createdAt'>
): Relationship {
  return {
    uri: existing.uri,
    source: existing.source,
    predicate: existing.predicate,
    target: existing.target,
    description: incoming.description.trim() || existing.description,
    weight: Math.max(existing.weight, incoming.weight),
    assertedBy: mergeAgents(existing.assertedBy, incoming.assertedBy),
    sourceChunkIds: mergeIds(existing.sourceChunkIds, incoming.sourceChunkIds),
    createdAt: existing.createdAt
  }
}

export function mergeClaim(existing: Claim, incoming: Omit<Claim, 'createdAt'>): Claim {
  return {
    uri: existing.uri,
    about: existing.about,
    statement: existing.statement,
    cells: mergeCells(existing.cells, incoming.cells),
    evidenceChunkIds: mergeIds(existing.evidenceChunkIds, incoming.evidenceChunkIds),
    assertedBy: mergeAgents(existing.assertedBy, incoming.assertedBy),
    supports: mergeIds(existing.supports ?? [], incoming.supports ?? []),
    contradicts: mergeIds(existing.contradicts ?? [], incoming.contradicts ?? []),
    createdAt: existing.createdAt
  }
}

/**
 * Set-union of cell assignments by `uri`. The URI is content-hashed over
 * (claim, cell, normalised filler), so two assignments with the same URI
 * carry the same filler in the same cell of the same claim. We keep the
 * existing record's metadata (conceptIri / source) when the incoming one
 * doesn't override them, mirroring the entity-description rule.
 */
export function mergeCells(a: CellAssignment[], b: CellAssignment[]): CellAssignment[] {
  const byUri = new Map<string, CellAssignment>()
  for (const c of a) byUri.set(c.uri, c)
  for (const c of b) {
    const prev = byUri.get(c.uri)
    if (!prev) {
      byUri.set(c.uri, c)
    } else {
      byUri.set(c.uri, {
        ...prev,
        conceptIri: c.conceptIri ?? prev.conceptIri,
        source: c.source ?? prev.source
      })
    }
  }
  return [...byUri.values()]
}
