// Canonical AD4M predicates used by the knowledge-graph subject schema.
//
// These IRIs are stable across the library's lifetime. Changing one is
// a breaking schema change; bump SCHEMA_VERSION in ad4m/subject-classes.ts.

export const ADR_NS = 'adr://ad4m-rag/'

// Subject class type assertions (rdf:type-like).
export const TYPE_ENTITY = `${ADR_NS}Entity`
export const TYPE_RELATIONSHIP = `${ADR_NS}Relationship`
export const TYPE_CLAIM = `${ADR_NS}Claim`
export const TYPE_COMMUNITY = `${ADR_NS}Community`

// Common predicates.
export const PRED_TYPE = `${ADR_NS}type`
export const PRED_NAME = `${ADR_NS}name`
export const PRED_DESCRIPTION = `${ADR_NS}description`
export const PRED_ALIAS = `${ADR_NS}alias`
export const PRED_ASSERTED_BY = `${ADR_NS}assertedBy`
export const PRED_SOURCE_CHUNK = `${ADR_NS}sourceChunk`
export const PRED_CREATED_AT = `${ADR_NS}createdAt`
export const PRED_UPDATED_AT = `${ADR_NS}updatedAt`

// Relationship-specific.
export const PRED_REL_SOURCE = `${ADR_NS}relSource`
export const PRED_REL_PREDICATE = `${ADR_NS}relPredicate`
export const PRED_REL_TARGET = `${ADR_NS}relTarget`
export const PRED_WEIGHT = `${ADR_NS}weight`

// Claim-specific.
export const PRED_CLAIM_ABOUT = `${ADR_NS}claimAbout`
export const PRED_CLAIM_STATEMENT = `${ADR_NS}statement`
export const PRED_EVIDENCE_CHUNK = `${ADR_NS}evidenceChunk`
export const PRED_SUPPORTS = `${ADR_NS}supports`
export const PRED_CONTRADICTS = `${ADR_NS}contradicts`

// Community-specific.
export const PRED_COMMUNITY_LEVEL = `${ADR_NS}communityLevel`
export const PRED_COMMUNITY_PARENT = `${ADR_NS}communityParent`
export const PRED_COMMUNITY_MEMBER = `${ADR_NS}communityMember`
export const PRED_COMMUNITY_SUMMARY = `${ADR_NS}communitySummary`

// Encode an AgentRef DID + optional label into a single literal:string target.
// Format: `did:method:id[|label]`.
export function encodeAgentTarget(did: string, label?: string): string {
  return `literal:string:${encodeURIComponent(label ? `${did}|${label}` : did)}`
}

export function decodeAgentTarget(target: string): { did: string; label?: string } | null {
  if (!target.startsWith('literal:string:')) return null
  let raw: string
  try {
    raw = decodeURIComponent(target.slice('literal:string:'.length))
  } catch {
    return null
  }
  const pipe = raw.indexOf('|')
  if (pipe < 0) return { did: raw }
  return { did: raw.slice(0, pipe), label: raw.slice(pipe + 1) }
}

/** Encode a plain string as a `literal:string:` target with URL encoding. */
export function encodeStringTarget(s: string): string {
  return `literal:string:${encodeURIComponent(s)}`
}

export function decodeStringTarget(target: string): string | null {
  if (!target.startsWith('literal:string:')) return null
  try {
    return decodeURIComponent(target.slice('literal:string:'.length))
  } catch {
    return null
  }
}
