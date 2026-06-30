// AD4M live integration harness.
//
// Spawns an isolated `ad4m-executor` process per test with:
//   - a per-test data dir under tmp
//   - a random port
//   - the localhost-only flag (no peer discovery)
//   - a unique admin credential
//
// Returns an authenticated Ad4mClient and an empty perspective UUID
// ready for the test to use. On dispose, kills the executor cleanly
// and removes the data dir.
//
// Requires `ad4m-executor` on PATH (or set AD4M_EXECUTOR env var).
// Configure with these env vars (all optional):
//   AD4M_EXECUTOR        path to ad4m-executor binary
//   AD4M_HARNESS_TIMEOUT seconds before the spawn gives up (default 90)
//   AD4M_HARNESS_KEEP    set non-empty to skip data-dir cleanup (debug)
//
// The harness is deliberately minimal — no neighbourhood publication,
// no peer-to-peer setup. Tests that need a second agent should spin up
// a second harness instance.

import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

const DEFAULT_BINARY = process.env.AD4M_EXECUTOR ?? 'ad4m-executor'
const STARTUP_TIMEOUT_S = Number(process.env.AD4M_HARNESS_TIMEOUT ?? '90')

export interface LiveExecutor {
  /** Connected Ad4mClient ready for queries + mutations. */
  client: import('@coasys/ad4m').Ad4mClient
  /** Empty perspective UUID created during bootstrap. */
  perspectiveUuid: string
  /** Per-instance admin credential, in case the test wants to construct a second client. */
  adminCredential: string
  /** GraphQL port the executor is listening on. */
  port: number
  /** Kill the executor and clean up its data dir. */
  dispose(): Promise<void>
}

export interface HarnessOptions {
  /** Override binary path. */
  binary?: string
  /** Override startup timeout (seconds). */
  startupTimeoutSeconds?: number
  /** Override agent passphrase. Default: a random 16-char hex string. */
  passphrase?: string
}

/** Spawn an isolated ad4m-executor and return a connected client + scratch perspective. */
export async function startLiveExecutor(opts: HarnessOptions = {}): Promise<LiveExecutor> {
  const binary = opts.binary ?? DEFAULT_BINARY
  const timeoutSeconds = opts.startupTimeoutSeconds ?? STARTUP_TIMEOUT_S
  const passphrase = opts.passphrase ?? randomBytes(8).toString('hex')

  const dataDir = mkdtempSync(join(tmpdir(), 'ad4m-rag-harness-'))
  const adminCredential = `tok-${randomUUID()}`

  // Pick three distinct free ports — one for GraphQL, two for Holochain
  // admin + app sockets — so concurrent harness instances don't collide.
  const [port, hcAdmin, hcApp] = await Promise.all([reservePort(), reservePort(), reservePort()])

  // No real network bootstrap seed needed for localhost-only operation, but
  // the executor accepts a JSON file; write a permissive default.
  const seedPath = join(dataDir, 'bootstrap.json')
  writeFileSync(seedPath, JSON.stringify(makeBootstrapSeed()))

  // Initialise the data dir.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['init', '--data-path', dataDir, '--network-bootstrap-seed', seedPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ad4m-executor init failed with code ${code}`))
    })
    child.on('error', reject)
  })

  // Spawn the executor. `run-dapp-server=false` skips the side dApp server
  // (which otherwise tries to bind to a hard-coded port and fails when run
  // in parallel).
  const child: ChildProcess = spawn(
    binary,
    [
      'run',
      '--app-data-path',
      dataDir,
      '--network-bootstrap-seed',
      seedPath,
      '--port',
      String(port),
      '--hc-admin-port',
      String(hcAdmin),
      '--hc-app-port',
      String(hcApp),
      '--language-language-only',
      'false',
      '--connect-holochain',
      'true',
      '--admin-credential',
      adminCredential,
      '--localhost',
      'true',
      '--hc-use-bootstrap',
      'false',
      '--hc-use-mdns',
      'false',
      '--hc-use-proxy',
      'false',
      '--run-dapp-server',
      'false'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )

  // Wait for the GraphQL listener to start.
  await waitForListening(child, port, timeoutSeconds)

  // Build the Ad4mClient over WebSocket.
  const { client } = await buildClient(port, adminCredential)

  // Bootstrap agent + perspective.
  await client.agent.generate(passphrase)
  const created = await client.perspective.add(`ad4m-rag-test-${randomUUID().slice(0, 8)}`)
  const perspectiveUuid = created.uuid

  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    // Try a graceful shutdown via the runtime API first; fall back to SIGTERM/SIGKILL.
    try {
      await Promise.race([client.runtime.quit(), wait(2_000)])
    } catch {
      /* ignore */
    }
    if (!child.killed) {
      child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        wait(3_000)
      ])
      if (!child.killed) child.kill('SIGKILL')
    }
    if (!process.env.AD4M_HARNESS_KEEP) {
      try {
        rmSync(dataDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }

  return { client, perspectiveUuid, adminCredential, port, dispose }
}

// ── Internals ────────────────────────────────────────────────────────────

async function reservePort(): Promise<number> {
  // ephemeral-range pick; verify it's actually bindable. We retry on EADDRINUSE.
  for (let i = 0; i < 20; i++) {
    const port = 30000 + Math.floor(Math.random() * 20000)
    const ok = await new Promise<boolean>((resolve) => {
      const { createServer } = require('node:net') as typeof import('node:net')
      const server = createServer()
      server.unref()
      server.on('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true))
      })
    })
    if (ok) return port
  }
  throw new Error('reservePort: no free port found after 20 attempts')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForListening(child: ChildProcess, port: number, timeoutSeconds: number): Promise<void> {
  let buffer = ''
  const markers = [
    `API server starting on http://127.0.0.1:${port}`,
    `127.0.0.1:${port}`,
    'WS RPC: registered'
  ]
  let resolved = false

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        reject(
          new Error(
            `ad4m-executor did not start listening on ${port} within ${timeoutSeconds}s. Output so far:\n${buffer.slice(-2000)}`
          )
        )
      }
    }, timeoutSeconds * 1000)

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const matched = markers.some((m) => buffer.includes(m))
      if (matched && !resolved) {
        // Confirm by actually opening a TCP connection.
        tryConnect(port)
          .then(() => {
            if (!resolved) {
              resolved = true
              clearTimeout(timer)
              resolve()
            }
          })
          .catch(() => {
            /* keep waiting */
          })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code, signal) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        reject(
          new Error(
            `ad4m-executor exited before listening (code=${code}, signal=${signal}). Output:\n${buffer.slice(-2000)}`
          )
        )
      }
    })

    // Also poll the TCP port — the executor may not always print a clear marker.
    const poll = async () => {
      while (!resolved) {
        try {
          await tryConnect(port)
          if (!resolved) {
            resolved = true
            clearTimeout(timer)
            resolve()
            return
          }
        } catch {
          /* not ready */
        }
        await wait(500)
      }
    }
    void poll()
  })
}

function tryConnect(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.end()
      resolve()
    })
    socket.once('error', (err) => reject(err))
  })
}

async function buildClient(port: number, adminCredential: string): Promise<{ client: import('@coasys/ad4m').Ad4mClient }> {
  // Recent @coasys/ad4m ships its own HTTP/WebSocket transport in
  // `ApiClient`; the Ad4mClient constructor accepts the bare base URL,
  // the admin credential, a subscribe flag, and an options bag where we
  // pass a Node WebSocket implementation (Node <22 has no global WebSocket).
  const ad4m = await import('@coasys/ad4m')
  const ws = await import('ws')
  const Ad4mClient = (ad4m as any).Ad4mClient
  const wsImpl = (ws as any).WebSocket ?? (ws as any).default
  // The Ad4mClient's ApiClient appends `/api/v1/ws` to the base URL when
  // computing the WebSocket endpoint, so the base URL must be the bare
  // host:port without a path suffix.
  const baseUrl = `http://127.0.0.1:${port}`
  const client = new Ad4mClient(baseUrl, adminCredential, true, { webSocketImpl: wsImpl })
  return { client }
}

function makeBootstrapSeed(): unknown {
  // Minimum fields required by the executor's RuntimeService. Without
  // `trustedAgents` (even empty), RuntimeService refuses to initialise and
  // subsequent agent.generate calls panic with "Ad4mDb not initialized".
  // Empty values are fine for localhost-only operation; we don't actually
  // load any languages.
  return {
    trustedAgents: [],
    knownLinkLanguages: [],
    directMessageLanguage: '',
    agentLanguage: '',
    perspectiveLanguage: '',
    neighbourhoodLanguage: '',
    languageLanguageBundle: ''
  }
}
