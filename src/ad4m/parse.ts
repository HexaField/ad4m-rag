// Translate inbound AD4M LinkExpressions back into domain records.
//
// We group links by their `source` (the subject URI), then per-subject
// pivot on `predicate`. Anything that doesn't fit the schema is silently
// dropped — incoming data from peers may be partial.

import { CELL_CLASS_BY_IRI } from '@hexafield/hexevent'
import type { CellAssignment, Claim, Community, Entity, Relationship } from '../types.js'
import {
  PRED_ALIAS,
  PRED_ASSERTED_BY,
  PRED_CELL_CONCEPT_IRI,
  PRED_CELL_FILLER,
  PRED_CELL_OF_CLAIM,
  PRED_CELL_SOURCE,
  PRED_CLAIM_ABOUT,
  PRED_CLAIM_STATEMENT,
  PRED_COMMUNITY_LEVEL,
  PRED_COMMUNITY_MEMBER,
  PRED_COMMUNITY_PARENT,
  PRED_COMMUNITY_SUMMARY,
  PRED_CONTRADICTS,
  PRED_CREATED_AT,
  PRED_DESCRIPTION,
  PRED_ENTITY_TYPE,
  PRED_EVIDENCE_CHUNK,
  PRED_NAME,
  PRED_REL_PREDICATE,
  PRED_REL_SOURCE,
  PRED_REL_TARGET,
  PRED_SOURCE_CHUNK,
  PRED_SUPPORTS,
  PRED_TYPE,
  PRED_UPDATED_AT,
  PRED_WEIGHT,
  TYPE_CLAIM,
  TYPE_COMMUNITY,
  TYPE_ENTITY,
  TYPE_RELATIONSHIP,
  decodeAgentTarget,
  decodeStringTarget
} from './predicates.js'

/** Minimal shape we need from each AD4M LinkExpression. */
export interface LinkLike {
  data: { source: string; predicate: string; target: string }
}

interface SubjectLinks {
  source: string
  predicates: Map<string, string[]> // predicate -> list of targets
}

function groupBySource(links: LinkLike[]): Map<string, SubjectLinks> {
  const out = new Map<string, SubjectLinks>()
  for (const link of links) {
    const { source, predicate, target } = link.data
    let bucket = out.get(source)
    if (!bucket) {
      bucket = { source, predicates: new Map() }
      out.set(source, bucket)
    }
    const arr = bucket.predicates.get(predicate) ?? []
    arr.push(target)
    bucket.predicates.set(predicate, arr)
  }
  return out
}

function firstOf(bucket: SubjectLinks, predicate: string): string | undefined {
  return bucket.predicates.get(predicate)?.[0]
}
function allOf(bucket: SubjectLinks, predicate: string): string[] {
  return bucket.predicates.get(predicate) ?? []
}

function isType(bucket: SubjectLinks, type: string): boolean {
  return allOf(bucket, PRED_TYPE).includes(type)
}

/** Extract a single Entity record from a bucket of links keyed by its URI. */
function parseEntity(uri: string, bucket: SubjectLinks): Entity | null {
  const nameTarget = firstOf(bucket, PRED_NAME)
  const name = nameTarget ? decodeStringTarget(nameTarget) ?? '' : ''
  if (!name) return null
  const description = decodeStringTarget(firstOf(bucket, PRED_DESCRIPTION) ?? '') ?? ''
  const aliases = allOf(bucket, PRED_ALIAS)
    .map(decodeStringTarget)
    .filter((s): s is string => typeof s === 'string')
  const assertedBy = allOf(bucket, PRED_ASSERTED_BY)
    .map(decodeAgentTarget)
    .filter((a): a is { did: string; label?: string } => !!a)
  const sourceChunkIds = allOf(bucket, PRED_SOURCE_CHUNK)
  const createdAt = Number(decodeStringTarget(firstOf(bucket, PRED_CREATED_AT) ?? '') ?? '0') || 0
  const updatedAt = Number(decodeStringTarget(firstOf(bucket, PRED_UPDATED_AT) ?? '') ?? String(createdAt)) || createdAt
  const type = decodeStringTarget(firstOf(bucket, PRED_ENTITY_TYPE) ?? '') ?? 'Unknown'
  return {
    uri,
    type,
    name,
    description,
    aliases: aliases.length ? aliases : undefined,
    assertedBy,
    sourceChunkIds,
    createdAt,
    updatedAt
  }
}

function parseRelationship(uri: string, bucket: SubjectLinks): Relationship | null {
  const source = firstOf(bucket, PRED_REL_SOURCE)
  const predicate = decodeStringTarget(firstOf(bucket, PRED_REL_PREDICATE) ?? '')
  const target = firstOf(bucket, PRED_REL_TARGET)
  if (!source || !predicate || !target) return null
  const description = decodeStringTarget(firstOf(bucket, PRED_DESCRIPTION) ?? '') ?? ''
  const weight = Number(decodeStringTarget(firstOf(bucket, PRED_WEIGHT) ?? '') ?? '0.5') || 0.5
  const assertedBy = allOf(bucket, PRED_ASSERTED_BY)
    .map(decodeAgentTarget)
    .filter((a): a is { did: string; label?: string } => !!a)
  const sourceChunkIds = allOf(bucket, PRED_SOURCE_CHUNK)
  const createdAt = Number(decodeStringTarget(firstOf(bucket, PRED_CREATED_AT) ?? '') ?? '0') || 0
  return { uri, source, predicate, target, description, weight, assertedBy, sourceChunkIds, createdAt }
}

function parseClaim(
  uri: string,
  bucket: SubjectLinks,
  cellsByClaim: Map<string, CellAssignment[]>
): Claim | null {
  const about = firstOf(bucket, PRED_CLAIM_ABOUT)
  const statement = decodeStringTarget(firstOf(bucket, PRED_CLAIM_STATEMENT) ?? '')
  if (!about || !statement) return null
  const evidenceChunkIds = allOf(bucket, PRED_EVIDENCE_CHUNK)
  const assertedBy = allOf(bucket, PRED_ASSERTED_BY)
    .map(decodeAgentTarget)
    .filter((a): a is { did: string; label?: string } => !!a)
  const supports = allOf(bucket, PRED_SUPPORTS)
  const contradicts = allOf(bucket, PRED_CONTRADICTS)
  const createdAt = Number(decodeStringTarget(firstOf(bucket, PRED_CREATED_AT) ?? '') ?? '0') || 0
  return {
    uri,
    about,
    statement,
    cells: cellsByClaim.get(uri) ?? [],
    evidenceChunkIds,
    assertedBy,
    supports: supports.length ? supports : undefined,
    contradicts: contradicts.length ? contradicts : undefined,
    createdAt
  }
}

/**
 * A cell-assignment subject. Detected by its `type` triple pointing at
 * one of the twelve hexevent cell IRIs. Returns the parsed assignment
 * and `null` if the bucket doesn't have the minimum required shape.
 */
function parseCellAssignment(
  uri: string,
  bucket: SubjectLinks
): CellAssignment | null {
  const typeIris = allOf(bucket, PRED_TYPE)
  let cellId: CellAssignment['cell'] | undefined
  for (const iri of typeIris) {
    const cls = CELL_CLASS_BY_IRI[iri]
    if (cls) {
      cellId = cls.cellId
      break
    }
  }
  if (!cellId) return null
  const claimUri = firstOf(bucket, PRED_CELL_OF_CLAIM)
  const filler = decodeStringTarget(firstOf(bucket, PRED_CELL_FILLER) ?? '')
  if (!claimUri || filler === null || filler === undefined || filler === '') return null
  const conceptIri = decodeStringTarget(firstOf(bucket, PRED_CELL_CONCEPT_IRI) ?? '') ?? undefined
  const source = decodeStringTarget(firstOf(bucket, PRED_CELL_SOURCE) ?? '') ?? undefined
  return { uri, claimUri, cell: cellId, filler, conceptIri, source }
}

function parseCommunity(uri: string, bucket: SubjectLinks): Community | null {
  const summary = decodeStringTarget(firstOf(bucket, PRED_COMMUNITY_SUMMARY) ?? '')
  const level = Number(decodeStringTarget(firstOf(bucket, PRED_COMMUNITY_LEVEL) ?? '') ?? 'NaN')
  if (!isFinite(level) || summary === null) return null
  const parent = firstOf(bucket, PRED_COMMUNITY_PARENT)
  const memberEntityUris = allOf(bucket, PRED_COMMUNITY_MEMBER)
  const createdAt = Number(decodeStringTarget(firstOf(bucket, PRED_CREATED_AT) ?? '') ?? '0') || 0
  return { uri, level, parent, memberEntityUris, summary, createdAt }
}

/** Parse a flat batch of incoming Links into domain records. */
export function parseLinks(links: LinkLike[]): {
  entities: Entity[]
  relationships: Relationship[]
  claims: Claim[]
  communities: Community[]
  cellAssignments: CellAssignment[]
} {
  const grouped = groupBySource(links)
  const entities: Entity[] = []
  const relationships: Relationship[] = []
  const claims: Claim[] = []
  const communities: Community[] = []
  const cellAssignments: CellAssignment[] = []
  // Cells must be parsed before claims so claim hydration can include them.
  const cellsByClaim = new Map<string, CellAssignment[]>()
  for (const [uri, bucket] of grouped) {
    const c = parseCellAssignment(uri, bucket)
    if (c) {
      cellAssignments.push(c)
      const arr = cellsByClaim.get(c.claimUri) ?? []
      arr.push(c)
      cellsByClaim.set(c.claimUri, arr)
    }
  }
  for (const [uri, bucket] of grouped) {
    if (isType(bucket, TYPE_ENTITY)) {
      const e = parseEntity(uri, bucket)
      if (e) entities.push(e)
    } else if (isType(bucket, TYPE_RELATIONSHIP)) {
      const r = parseRelationship(uri, bucket)
      if (r) relationships.push(r)
    } else if (isType(bucket, TYPE_CLAIM)) {
      const c = parseClaim(uri, bucket, cellsByClaim)
      if (c) claims.push(c)
    } else if (isType(bucket, TYPE_COMMUNITY)) {
      const c = parseCommunity(uri, bucket)
      if (c) communities.push(c)
    }
  }
  return { entities, relationships, claims, communities, cellAssignments }
}
