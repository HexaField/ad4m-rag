// Translate domain records (Entity, Relationship, Claim, Community) into
// arrays of AD4M Link objects ready for `addLinks()`. Round-tripping
// these Links back into records is handled by ad4m/parse.ts.

import { Link } from '@coasys/ad4m'
import type { Claim, Community, Entity, Relationship } from '../types.js'
import {
  PRED_ALIAS,
  PRED_ASSERTED_BY,
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
  encodeAgentTarget,
  encodeStringTarget
} from './predicates.js'

type L = ConstructorParameters<typeof Link>[0]

const mkLink = (source: string, predicate: string, target: string): Link =>
  new Link({ source, predicate, target } as L)

export function entityToLinks(e: Entity): Link[] {
  const out: Link[] = []
  out.push(mkLink(e.uri, PRED_TYPE, TYPE_ENTITY))
  out.push(mkLink(e.uri, PRED_ENTITY_TYPE, encodeStringTarget(e.type)))
  out.push(mkLink(e.uri, PRED_NAME, encodeStringTarget(e.name)))
  out.push(mkLink(e.uri, PRED_DESCRIPTION, encodeStringTarget(e.description)))
  for (const a of e.aliases ?? []) out.push(mkLink(e.uri, PRED_ALIAS, encodeStringTarget(a)))
  for (const ag of e.assertedBy) out.push(mkLink(e.uri, PRED_ASSERTED_BY, encodeAgentTarget(ag.did, ag.label)))
  for (const c of e.sourceChunkIds) out.push(mkLink(e.uri, PRED_SOURCE_CHUNK, c))
  out.push(mkLink(e.uri, PRED_CREATED_AT, encodeStringTarget(String(e.createdAt))))
  out.push(mkLink(e.uri, PRED_UPDATED_AT, encodeStringTarget(String(e.updatedAt))))
  return out
}

export function relationshipToLinks(r: Relationship): Link[] {
  const out: Link[] = []
  out.push(mkLink(r.uri, PRED_TYPE, TYPE_RELATIONSHIP))
  out.push(mkLink(r.uri, PRED_REL_SOURCE, r.source))
  out.push(mkLink(r.uri, PRED_REL_PREDICATE, encodeStringTarget(r.predicate)))
  out.push(mkLink(r.uri, PRED_REL_TARGET, r.target))
  out.push(mkLink(r.uri, PRED_DESCRIPTION, encodeStringTarget(r.description)))
  out.push(mkLink(r.uri, PRED_WEIGHT, encodeStringTarget(String(r.weight))))
  for (const ag of r.assertedBy) out.push(mkLink(r.uri, PRED_ASSERTED_BY, encodeAgentTarget(ag.did, ag.label)))
  for (const c of r.sourceChunkIds) out.push(mkLink(r.uri, PRED_SOURCE_CHUNK, c))
  out.push(mkLink(r.uri, PRED_CREATED_AT, encodeStringTarget(String(r.createdAt))))
  return out
}

export function claimToLinks(c: Claim): Link[] {
  const out: Link[] = []
  out.push(mkLink(c.uri, PRED_TYPE, TYPE_CLAIM))
  out.push(mkLink(c.uri, PRED_CLAIM_ABOUT, c.about))
  out.push(mkLink(c.uri, PRED_CLAIM_STATEMENT, encodeStringTarget(c.statement)))
  for (const e of c.evidenceChunkIds) out.push(mkLink(c.uri, PRED_EVIDENCE_CHUNK, e))
  for (const ag of c.assertedBy) out.push(mkLink(c.uri, PRED_ASSERTED_BY, encodeAgentTarget(ag.did, ag.label)))
  for (const s of c.supports ?? []) out.push(mkLink(c.uri, PRED_SUPPORTS, s))
  for (const co of c.contradicts ?? []) out.push(mkLink(c.uri, PRED_CONTRADICTS, co))
  out.push(mkLink(c.uri, PRED_CREATED_AT, encodeStringTarget(String(c.createdAt))))
  return out
}

export function communityToLinks(c: Community): Link[] {
  const out: Link[] = []
  out.push(mkLink(c.uri, PRED_TYPE, TYPE_COMMUNITY))
  out.push(mkLink(c.uri, PRED_COMMUNITY_LEVEL, encodeStringTarget(String(c.level))))
  if (c.parent) out.push(mkLink(c.uri, PRED_COMMUNITY_PARENT, c.parent))
  for (const m of c.memberEntityUris) out.push(mkLink(c.uri, PRED_COMMUNITY_MEMBER, m))
  out.push(mkLink(c.uri, PRED_COMMUNITY_SUMMARY, encodeStringTarget(c.summary)))
  out.push(mkLink(c.uri, PRED_CREATED_AT, encodeStringTarget(String(c.createdAt))))
  return out
}
