// Typed client for the demo backend. Same-origin — the vite dev server
// proxies /api to the isolated-executor backend.

export interface Status {
  ready: boolean
  phase: string
  error: string | null
  agentDid: string | null
  executorPort: number | null
  privateUuid: string | null
  commonsUuid: string | null
}

export interface WitnessRef {
  id: string
  label: string
  did: string
}

export interface Witness extends WitnessRef {
  account: string
}

export interface EventInfo {
  title: string
  headline: string
  blurb: string
}

export interface EventResponse {
  event: EventInfo
  witnesses: Witness[]
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
  witnessCount: number
  empty: boolean
  converged: boolean
  diverged: boolean
}

export interface GridResponse {
  witnesses: WitnessRef[]
  cells: GridCell[]
  blindSpots: string[]
  sharedClaimUri: string
}

export interface Citation {
  kind: string
  uri?: string
  name?: string
  chunkId?: string
  documentId?: string
  snippet?: string
  level?: number
}

export interface QueryTrace {
  retrievalK?: number
  graphHops?: number
  llmCalls?: number
  durationMs?: number
  communitiesConsidered?: number
  partialAnswers?: number
}

export interface QueryResult {
  answer: string
  mode: string
  citations: Citation[]
  trace: QueryTrace
}

export interface CellAssignment {
  uri: string
  claimUri: string
  cell: string
  filler: string
  conceptIri?: string
  source?: string
}

export interface Claim {
  uri: string
  about: string
  statement: string
  cells: CellAssignment[]
  assertedBy: { did: string; label?: string }[]
  evidenceChunkIds: string[]
}

export interface PublishResult {
  commonsUuid: string
  commonsLinkCount: number
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

export interface CellFilterTerm {
  cell: string
  fillerLike?: string
  conceptIri?: string
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return (await res.json()) as T
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return (await res.json()) as T
}

export const api = {
  status: () => getJson<Status>('/api/status'),
  event: () => getJson<EventResponse>('/api/event'),
  grid: (dids?: string[]) =>
    getJson<GridResponse>('/api/grid' + (dids && dids.length ? `?dids=${encodeURIComponent(dids.join(','))}` : '')),
  ad4m: () => getJson<Ad4mStatus>('/api/ad4m'),
  query: (body: { question: string; byCell?: CellFilterTerm[]; dids?: string[] }) =>
    postJson<QueryResult>('/api/query', body),
  publish: (uri?: string) => postJson<PublishResult>('/api/publish', uri ? { uri } : {})
}
