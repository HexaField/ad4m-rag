// SQLite schema. Versioned so the local index can be dropped + rebuilt
// from AD4M on a version bump.

export const SCHEMA_VERSION = 1

export const DDL = [
  `PRAGMA journal_mode = WAL`,
  `PRAGMA synchronous = NORMAL`,
  `PRAGMA foreign_keys = ON`,

  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // ── Structural ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS entities (
    uri TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    asserted_by TEXT NOT NULL DEFAULT '[]',
    source_chunk_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS entities_type_name ON entities(type, name)`,

  `CREATE TABLE IF NOT EXISTS relationships (
    uri TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    predicate TEXT NOT NULL,
    target TEXT NOT NULL,
    description TEXT NOT NULL,
    weight REAL NOT NULL,
    asserted_by TEXT NOT NULL DEFAULT '[]',
    source_chunk_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS relationships_source ON relationships(source)`,
  `CREATE INDEX IF NOT EXISTS relationships_target ON relationships(target)`,
  `CREATE INDEX IF NOT EXISTS relationships_predicate ON relationships(predicate)`,

  `CREATE TABLE IF NOT EXISTS claims (
    uri TEXT PRIMARY KEY,
    about TEXT NOT NULL,
    statement TEXT NOT NULL,
    evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',
    asserted_by TEXT NOT NULL DEFAULT '[]',
    supports TEXT NOT NULL DEFAULT '[]',
    contradicts TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS claims_about ON claims(about)`,

  `CREATE TABLE IF NOT EXISTS communities (
    uri TEXT PRIMARY KEY,
    level INTEGER NOT NULL,
    parent TEXT,
    member_entity_uris TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS communities_level ON communities(level)`,

  `CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    text TEXT NOT NULL,
    position_start INTEGER NOT NULL,
    position_end INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id)`,

  // ── Publication ledger (which subjects are in which perspectives) ─
  `CREATE TABLE IF NOT EXISTS publications (
    uri TEXT NOT NULL,
    perspective_uuid TEXT NOT NULL,
    PRIMARY KEY (uri, perspective_uuid)
  )`,

  // ── Content-hash cache for the ingest pipeline ──────────────────
  `CREATE TABLE IF NOT EXISTS cache (
    stage TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (stage, key)
  )`,

  // ── Embedding tables (one per kind; sqlite-vec virtual tables created in code) ─
  // We create them in TS because the column count depends on the configured
  // embedding dimension at runtime.

  // ── FTS5 over claim statements + entity descriptions ────────────
  `CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(uri UNINDEXED, name, description, content='entities', content_rowid='rowid')`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(uri UNINDEXED, statement, content='claims', content_rowid='rowid')`
]
