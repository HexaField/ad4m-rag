// Demo backend: a tiny node:http JSON API over the composed knowledge
// graph. Boots an isolated AD4M executor in the background (Holochain
// bring-up takes a little while), so the server starts listening
// immediately and reports boot progress via GET /api/status. The
// frontend polls that until `ready` flips true.
//
// Runs as a plain Node process (Node executes .ts directly). The vite
// dev server is the LAN-facing surface and proxies /api here; this
// process binds localhost only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { startIsolatedExecutor, type IsolatedExecutor } from './executor.ts'
import { createDemoGraph, type DemoGraph } from './graph.ts'

const PORT = Number(process.env.API_PORT ?? '8787')

let phase = 'starting'
let ready = false
let bootError: string | null = null
let executor: IsolatedExecutor | null = null
let graph: DemoGraph | null = null

async function boot(): Promise<void> {
  try {
    executor = await startIsolatedExecutor({
      onPhase: (p) => {
        phase = p
        console.log(`[demo] ${p}`)
      }
    })
    phase = 'seeding knowledge graph'
    console.log('[demo] seeding knowledge graph')
    graph = await createDemoGraph(executor)
    phase = 'ready'
    ready = true
    console.log(`[demo] ready — agent ${executor.agentDid}, executor port ${executor.port}`)
  } catch (err) {
    bootError = (err as Error).message
    phase = 'error'
    console.error('[demo] boot failed:', err)
  }
}

// ── HTTP plumbing ──────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Require a booted graph; throws a 503-shaped sentinel if not ready. */
function requireGraph(): DemoGraph {
  if (!graph) {
    const e = new Error(bootError ?? `not ready (${phase})`) as Error & { code?: number }
    e.code = 503
    throw e
  }
  return graph
}

function parseDids(value: string | null): string[] | undefined {
  if (!value) return undefined
  const dids = value.split(',').map((s) => s.trim()).filter(Boolean)
  return dids.length > 0 ? dids : undefined
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (path === '/api/status') {
    return sendJson(res, 200, {
      ready,
      phase,
      error: bootError,
      agentDid: executor?.agentDid ?? null,
      executorPort: executor?.port ?? null,
      privateUuid: executor?.privateUuid ?? null,
      commonsUuid: executor?.commonsUuid ?? null
    })
  }

  if (path === '/api/event' && method === 'GET') {
    const g = requireGraph()
    return sendJson(res, 200, g.event())
  }

  if (path === '/api/grid' && method === 'GET') {
    const g = requireGraph()
    const dids = parseDids(url.searchParams.get('dids'))
    return sendJson(res, 200, { ...g.grid(dids), sharedClaimUri: g.sharedClaimUri })
  }

  if (path === '/api/claim' && method === 'GET') {
    const g = requireGraph()
    const uri = url.searchParams.get('uri')
    if (!uri) return sendJson(res, 400, { error: 'missing uri' })
    return sendJson(res, 200, { claim: g.claim(uri) })
  }

  if (path === '/api/ad4m' && method === 'GET') {
    const g = requireGraph()
    return sendJson(res, 200, await g.ad4mStatus())
  }

  if (path === '/api/query' && method === 'POST') {
    const g = requireGraph()
    const body = (await readBody(req)) as {
      question?: string
      byCell?: Array<{ cell: string; fillerLike?: string; conceptIri?: string }>
      dids?: string[]
    }
    if (!body.question || typeof body.question !== 'string') {
      return sendJson(res, 400, { error: 'missing question' })
    }
    const result = await g.query({
      question: body.question,
      byCell: body.byCell as never,
      dids: body.dids
    })
    return sendJson(res, 200, result)
  }

  if (path === '/api/publish' && method === 'POST') {
    const g = requireGraph()
    const body = (await readBody(req)) as { uri?: string }
    const uri = body.uri ?? g.sharedClaimUri
    return sendJson(res, 200, await g.publish(uri))
  }

  sendJson(res, 404, { error: 'not found' })
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: Error & { code?: number }) => {
    if (res.headersSent) return
    const status = err.code === 503 ? 503 : 500
    sendJson(res, status, { error: err.message, phase })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[demo] API listening on http://127.0.0.1:${PORT}`)
  void boot()
})

// ── Shutdown ───────────────────────────────────────────────────────

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[demo] ${signal} — shutting down`)
  server.close()
  try {
    await executor?.dispose()
  } catch {
    /* ignore */
  }
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
