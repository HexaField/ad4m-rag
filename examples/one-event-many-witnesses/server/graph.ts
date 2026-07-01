// The demo's knowledge-graph layer.
//
// Composes the library's real building blocks — sqlite index, ingest
// pipeline, query engine, AD4M-backed store — with the demo's
// deterministic clients and curated corpus, then exposes the read
// helpers the HTTP API serves.
//
// The composition here is exactly what src/factory.ts:createAd4mRag does,
// unrolled by hand for one reason: the demo needs the raw SqliteIndex
// handle to read cell assignments (the 6×2 grid, the blind-spot audit),
// and the factory keeps that handle private.

import {
  claimUri,
  createAd4mFacade,
  createIngestApi,
  createIngestCache,
  createKnowledgeGraphStore,
  createQueryEngine,
  createSqliteIndex,
  entityUri,
  parseLinks,
  type Ad4mClientFacade,
  type Claim,
  type IngestApi,
  type KnowledgeGraphStore,
  type QueryEngine,
  type QueryRequest,
  type QueryResult,
  type SqliteIndex
} from '../../../dist/index.js'
import { CELL_CLASS_BY_ID, parseCellId, type CellId } from '@hexafield/hexevent'

/** The library's cell-filter term shape (not re-exported by name). */
type CellFilterTerm = NonNullable<QueryRequest['byCell']>[number]
import { createFeatureHashEmbedder, createScriptedLlm } from './clients.ts'
import { createScriptedExtractor, EVENT, SHARED_CLAIM_REF, WITNESSES, type Witness } from './corpus.ts'
import type { IsolatedExecutor } from './executor.ts'

const EMBED_DIM = 256

// Human-readable label per cell, keyed `${interrogative}|${axis}`.
const CELL_LABEL: Record<string, string> = {
  'who|objective': 'Who is the actor / source',
  'who|subjective': 'Who is affected / who experiences it',
  'what|objective': 'What happened / what was done',
  'what|subjective': 'What it means / what is at stake',
  'when|objective': 'Timestamp / sequence',
  'when|subjective': 'Felt timing / phase / urgency',
  'where|objective': 'Physical or institutional location',
  'where|subjective': 'Felt place / domain / context',
  'why|objective': 'Cause / mechanism',
  'why|subjective': 'Motivation / value / purpose',
  'how|objective': 'Procedure / mechanism in detail',
  'how|subjective': 'Manner / approach / felt method'
}

const INTERROGATIVES = ['who', 'what', 'when', 'where', 'why', 'how'] as const
const AXES = ['objective', 'subjective'] as const

// Canonical CellId strings, exact-codepoint (middot) from hexevent, keyed
// `${interrogative}|${axis}` so we can lay them out objective-first.
const CELL_ID_BY_KEY = new Map<string, CellId>()
for (const id of Object.keys(CELL_CLASS_BY_ID) as CellId[]) {
  const { interrogative, axis } = parseCellId(id)
  CELL_ID_BY_KEY.set(`${interrogative}|${axis}`, id)
}

export interface WitnessRef {
  id: string
  label: string
  did: string
}

export interface GridFiller {
  filler: string
  witnesses: WitnessRef[]
  count: number
  claimUri: string
}

export interface GridCell {
  cell: string
  interrogative: string
  axis: string
  label: string
  fillers: GridFiller[]
  /** Distinct witnesses asserting anything in this cell (under the current filter). */
  witnessCount: number
  /** No filler at all — a precise statement of unobserved information. */
  empty: boolean
  /** One shared filler asserted by more than one witness. */
  converged: boolean
  /** More than one distinct filler — witnesses diverge here. */
  diverged: boolean
}

export interface GridResult {
  witnesses: WitnessRef[]
  cells: GridCell[]
  blindSpots: string[]
}

export interface PublishResult {
  commonsUuid: string
  commonsLinkCount: number
  /** The claim as read back OUT of AD4M — proof the round-trip preserved it. */
  claim: Claim | null
  claimsInCommons: number
}

export interface Ad4mStatus {
  agentDid: string
  privateUuid: string
  commonsUuid: string
  privateLinkCount: number
  commonsLinkCount: number
}

export interface DemoGraph {
  event(): { event: typeof EVENT; witnesses: Array<Witness> }
  grid(dids?: string[]): GridResult
  query(input: { question: string; byCell?: CellFilterTerm[]; dids?: string[] }): Promise<QueryResult>
  claim(uri: string): Claim | null
  publish(uri: string): Promise<PublishResult>
  ad4mStatus(): Promise<Ad4mStatus>
  sharedClaimUri: string
  witnessRefs: WitnessRef[]
}

/**
 * Build the composed graph and seed it with the three witness accounts.
 * Runs the library's real ingest pipeline (chunk → embed → extract →
 * merge → materialise cells) over each account, driven by the scripted
 * extractor so the demo is deterministic and offline.
 */
export async function createDemoGraph(executor: IsolatedExecutor): Promise<DemoGraph> {
  const embeddings = createFeatureHashEmbedder(EMBED_DIM)
  const llm = createScriptedLlm()
  const extractor = createScriptedExtractor()

  const sqlite: SqliteIndex = createSqliteIndex({
    path: ':memory:',
    embeddingDimension: embeddings.dimension()
  })
  const cache = createIngestCache(sqlite)

  const store: KnowledgeGraphStore = createKnowledgeGraphStore({
    sqlite,
    embeddings,
    ad4m: {
      client: executor.client,
      privatePerspectiveUuid: executor.privateUuid,
      sharedPerspectiveUuids: [executor.commonsUuid]
    }
  })

  const ingest: IngestApi = createIngestApi({ sqlite, embeddings, extractor, cache })
  const query: QueryEngine = createQueryEngine({ sqlite, embeddings, llm })
  const facade: Ad4mClientFacade = createAd4mFacade(executor.client)

  // ── Seed: one append per witness account. ──────────────────────────
  // Distinct assertedBy per witness gives every extracted record its
  // provenance; identity-merge collapses the shared objective claim into
  // one record whose assertedBy accumulates all three DIDs.
  for (const w of WITNESSES) {
    await ingest.append({
      documentId: w.id,
      text: w.account,
      assertedBy: { did: w.did, label: w.label }
    })
  }

  const witnessByDid = new Map<string, WitnessRef>()
  const witnessRefs: WitnessRef[] = WITNESSES.map((w) => {
    const ref = { id: w.id, label: w.label, did: w.did }
    witnessByDid.set(w.did, ref)
    return ref
  })

  const eventEntityUri = entityUri(SHARED_CLAIM_REF.aboutType, SHARED_CLAIM_REF.aboutName)
  const sharedClaimUri = claimUri(eventEntityUri, SHARED_CLAIM_REF.statement)

  function toAgentFilter(dids?: string[]) {
    if (!dids || dids.length === 0 || dids.length === WITNESSES.length) return undefined
    return dids.map((did) => ({ did }))
  }

  function refsFor(dids: string[]): WitnessRef[] {
    const out: WitnessRef[] = []
    for (const d of dids) {
      const r = witnessByDid.get(d)
      if (r) out.push(r)
    }
    return out
  }

  function grid(dids?: string[]): GridResult {
    const fromAgents = toAgentFilter(dids)
    const selected = fromAgents ? refsFor(dids!) : witnessRefs
    const cells: GridCell[] = []
    const blindSpots: string[] = []

    for (const interrogative of INTERROGATIVES) {
      for (const axis of AXES) {
        const cellId = CELL_ID_BY_KEY.get(`${interrogative}|${axis}`)!
        const assignments = sqlite.listCellAssignments({ cell: cellId as CellId, fromAgents })

        // Group by filler; a filler's asserters are the union of the
        // assertedBy sets of every claim carrying it.
        const byFiller = new Map<string, { dids: Set<string>; claimUri: string }>()
        for (const a of assignments) {
          const parent = sqlite.getClaim(a.claimUri)
          const entry = byFiller.get(a.filler) ?? { dids: new Set<string>(), claimUri: a.claimUri }
          for (const agent of parent?.assertedBy ?? []) entry.dids.add(agent.did)
          byFiller.set(a.filler, entry)
        }

        const fillers: GridFiller[] = [...byFiller.entries()].map(([filler, info]) => {
          const witnesses = [...info.dids].map((d) => witnessByDid.get(d)).filter((r): r is WitnessRef => !!r)
          return { filler, witnesses, count: witnesses.length, claimUri: info.claimUri }
        })

        const distinctWitnesses = new Set<string>()
        for (const f of fillers) for (const w of f.witnesses) distinctWitnesses.add(w.did)

        const empty = fillers.length === 0
        if (empty) blindSpots.push(cellId)

        cells.push({
          cell: cellId,
          interrogative,
          axis,
          label: CELL_LABEL[`${interrogative}|${axis}`] ?? cellId,
          fillers,
          witnessCount: distinctWitnesses.size,
          empty,
          converged: fillers.length === 1 && fillers[0].count > 1,
          diverged: fillers.length > 1
        })
      }
    }

    return { witnesses: selected, cells, blindSpots }
  }

  async function runQuery(input: {
    question: string
    byCell?: CellFilterTerm[]
    dids?: string[]
  }): Promise<QueryResult> {
    return query.query({
      question: input.question,
      mode: 'local',
      byCell: input.byCell,
      fromAgents: toAgentFilter(input.dids)
    })
  }

  function claim(uri: string): Claim | null {
    return sqlite.getClaim(uri)
  }

  async function publish(uri: string): Promise<PublishResult> {
    // Push the subject's links into the shared commons perspective, then
    // read them straight back out of AD4M and re-parse — the round-trip
    // that proves the 12-cell decomposition + provenance survive AD4M.
    await store.publishToPerspective(uri, executor.commonsUuid)
    const links = await facade.queryAllLinks(executor.commonsUuid)
    const parsed = parseLinks(links)
    return {
      commonsUuid: executor.commonsUuid,
      commonsLinkCount: links.length,
      claim: parsed.claims.find((c) => c.uri === uri) ?? null,
      claimsInCommons: parsed.claims.length
    }
  }

  async function ad4mStatus(): Promise<Ad4mStatus> {
    const [priv, commons] = await Promise.all([
      facade.queryAllLinks(executor.privateUuid),
      facade.queryAllLinks(executor.commonsUuid)
    ])
    return {
      agentDid: executor.agentDid,
      privateUuid: executor.privateUuid,
      commonsUuid: executor.commonsUuid,
      privateLinkCount: priv.length,
      commonsLinkCount: commons.length
    }
  }

  return {
    event() {
      return { event: EVENT, witnesses: WITNESSES }
    },
    grid,
    query: runQuery,
    claim,
    publish,
    ad4mStatus,
    sharedClaimUri,
    witnessRefs
  }
}
