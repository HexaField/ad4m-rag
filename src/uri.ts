// Content-hashed URI scheme.
//
// URIs are not opaque: the kind prefix is intentionally visible so
// consumers can inspect a URI by string. Each kind's hash is SHA-256
// over a canonical form using `|` as a field separator (chosen because
// it's printable and easy to debug; user-supplied strings rarely
// contain it, and canonical forms strip whitespace anyway).

import { createHash } from 'node:crypto'

export type UriKind = 'entity' | 'relationship' | 'claim' | 'community' | 'chunk' | 'cellassignment'

const SEP = '|'

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Canonical key for an Entity. Identity is (type, lower-cased trimmed name). */
export function canonicalEntityKey(type: string, name: string): string {
  return type.trim() + SEP + name.trim().toLowerCase()
}

export function entityUri(type: string, name: string): string {
  return 'entity:' + sha256(canonicalEntityKey(type, name))
}

/** Canonical key for a Relationship. Identity is (source URI, predicate, target URI). */
export function relationshipUri(sourceUri: string, predicate: string, targetUri: string): string {
  return 'relationship:' + sha256(sourceUri + SEP + predicate + SEP + targetUri)
}

/** Canonical key for a Claim. Identity is (about URI, statement after whitespace normalisation). */
export function claimUri(aboutUri: string, statement: string): string {
  const normalised = statement.replace(/\s+/g, ' ').trim()
  return 'claim:' + sha256(aboutUri + SEP + normalised)
}

/** Canonical key for a Community. Identity is (level, sorted member URIs). */
export function communityUri(level: number, memberEntityUris: string[]): string {
  const sorted = [...memberEntityUris].sort()
  return 'community:' + sha256(String(level) + SEP + sorted.join(SEP))
}

/** Canonical key for a Chunk. Identity is the chunk text itself. */
export function chunkUri(text: string): string {
  return 'chunk:' + sha256(text)
}

/**
 * Canonical key for a CellAssignment. Identity is
 * (claim URI, cell id, normalised filler). Re-extractions with the same
 * filler in the same cell of the same claim therefore merge.
 */
export function cellAssignmentUri(claimUri: string, cell: string, filler: string): string {
  const normalised = filler.replace(/\s+/g, ' ').trim()
  return 'cellassignment:' + sha256(claimUri + SEP + cell + SEP + normalised)
}

/** Inspect a URI's kind from its prefix. Throws on malformed input. */
export function uriKind(uri: string): UriKind {
  const colon = uri.indexOf(':')
  if (colon < 0) throw new Error('malformed uri: ' + uri)
  const prefix = uri.slice(0, colon)
  if (
    prefix !== 'entity' &&
    prefix !== 'relationship' &&
    prefix !== 'claim' &&
    prefix !== 'community' &&
    prefix !== 'chunk' &&
    prefix !== 'cellassignment'
  ) {
    throw new Error('unknown uri kind: ' + prefix)
  }
  return prefix
}
