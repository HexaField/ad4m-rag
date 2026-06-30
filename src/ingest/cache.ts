// Content-hash-based cache used by every stage of the ingest pipeline.
// The cache lives in the same SQLite store as the index — see sqlite/index.ts.
//
// Key contract:
//   stage:     'chunks' | 'chunk-embed' | 'extract' | 'entity-embed' | 'community-summary'
//   key:       sha256 over the canonical input to that stage
//   value:     JSON string

import { createHash } from 'node:crypto'
import type { SqliteIndex } from '../sqlite/index.js'

export type CacheStage = 'chunks' | 'chunk-embed' | 'extract' | 'entity-embed' | 'community-summary'

export function hashInputs(...parts: string[]): string {
  const h = createHash('sha256')
  for (const p of parts) {
    h.update(p)
    h.update('\0')
  }
  return h.digest('hex')
}

export interface IngestCache {
  get<T>(stage: CacheStage, key: string): T | null
  set<T>(stage: CacheStage, key: string, value: T): void
}

export function createIngestCache(sqlite: SqliteIndex): IngestCache {
  return {
    get<T>(stage: CacheStage, key: string): T | null {
      const raw = sqlite.cacheGet(stage, key)
      if (raw === null) return null
      try {
        return JSON.parse(raw) as T
      } catch {
        return null
      }
    },
    set<T>(stage: CacheStage, key: string, value: T) {
      sqlite.cacheSet(stage, key, JSON.stringify(value))
    }
  }
}
