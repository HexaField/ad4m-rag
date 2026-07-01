// Boot an isolated ad4m-executor for the demo.
//
// Mirrors the library's integration harness (tests/integration/harness.ts):
// per-run temp data dir, three random localhost ports, localhost-only, no
// peer discovery. Nothing here touches any other executor on the machine.
//
// Requires `ad4m-executor` on PATH (or AD4M_EXECUTOR set to the binary).

import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Ad4mClient } from '@coasys/ad4m'

const DEFAULT_BINARY = process.env.AD4M_EXECUTOR ?? 'ad4m-executor'
const STARTUP_TIMEOUT_S = Number(process.env.AD4M_DEMO_TIMEOUT ?? '120')

export interface IsolatedExecutor {
  client: Ad4mClient
  agentDid: string
  /** Perspective the knowledge graph is written into. */
  privateUuid: string
  /** A second perspective standing in for a shared neighbourhood / commons. */
  commonsUuid: string
  port: number
  dataDir: string
  dispose(): Promise<void>
}

export interface BootOptions {
  onPhase?: (phase: string) => void
}

export async function startIsolatedExecutor(opts: BootOptions = {}): Promise<IsolatedExecutor> {
  const phase = opts.onPhase ?? (() => {})
  const binary = DEFAULT_BINARY
  const passphrase = randomBytes(8).toString('hex')

  const dataDir = mkdtempSync(join(tmpdir(), 'ad4m-rag-demo-'))
  const adminCredential = `tok-${randomUUID()}`
  const [port, hcAdmin, hcApp] = await Promise.all([reservePort(), reservePort(), reservePort()])

  const seedPath = join(dataDir, 'bootstrap.json')
  writeFileSync(seedPath, JSON.stringify(makeBootstrapSeed()))

  phase('initialising data dir')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['init', '--data-path', dataDir, '--network-bootstrap-seed', seedPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ad4m-executor init failed (code ${code})`))))
    child.on('error', reject)
  })

  phase('starting executor (Holochain bring-up)')
  const child: ChildProcess = spawn(
    binary,
    [
      'run',
      '--app-data-path', dataDir,
      '--network-bootstrap-seed', seedPath,
      '--port', String(port),
      '--hc-admin-port', String(hcAdmin),
      '--hc-app-port', String(hcApp),
      '--language-language-only', 'false',
      '--connect-holochain', 'true',
      '--admin-credential', adminCredential,
      '--localhost', 'true',
      '--hc-use-bootstrap', 'false',
      '--hc-use-mdns', 'false',
      '--hc-use-proxy', 'false',
      '--run-dapp-server', 'false'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )

  await waitForListening(child, port, STARTUP_TIMEOUT_S)

  phase('connecting client')
  const client = await buildClient(port, adminCredential)

  phase('generating agent')
  await client.agent.generate(passphrase)
  const me = await client.agent.me()
  const agentDid = me.did

  phase('creating perspectives')
  const priv = await client.perspective.add('demo-knowledge-graph')
  const commons = await client.perspective.add('demo-commons')

  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    try {
      await Promise.race([client.runtime.quit(), wait(2_000)])
    } catch {
      /* ignore */
    }
    if (!child.killed) {
      child.kill('SIGTERM')
      await Promise.race([new Promise<void>((r) => child.once('exit', () => r())), wait(3_000)])
      if (!child.killed) child.kill('SIGKILL')
    }
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  return {
    client,
    agentDid,
    privateUuid: priv.uuid,
    commonsUuid: commons.uuid,
    port,
    dataDir,
    dispose
  }
}

// ── Internals (adapted from tests/integration/harness.ts) ──────────────

function reservePort(): Promise<number> {
  return (async () => {
    for (let i = 0; i < 20; i++) {
      const p = 30000 + Math.floor(Math.random() * 20000)
      const ok = await new Promise<boolean>((resolve) => {
        const server = createServer()
        server.unref()
        server.on('error', () => resolve(false))
        server.listen(p, '127.0.0.1', () => server.close(() => resolve(true)))
      })
      if (ok) return p
    }
    throw new Error('reservePort: no free port after 20 attempts')
  })()
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function waitForListening(child: ChildProcess, port: number, timeoutSeconds: number): Promise<void> {
  let buffer = ''
  const markers = [`http://127.0.0.1:${port}`, `127.0.0.1:${port}`, 'WS RPC: registered']
  let resolved = false
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        reject(new Error(`ad4m-executor not listening on ${port} within ${timeoutSeconds}s. Output:\n${buffer.slice(-2000)}`))
      }
    }, timeoutSeconds * 1000)

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      if (markers.some((m) => buffer.includes(m)) && !resolved) {
        tryConnect(port)
          .then(() => {
            if (!resolved) {
              resolved = true
              clearTimeout(timer)
              resolve()
            }
          })
          .catch(() => {})
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code, signal) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timer)
        reject(new Error(`ad4m-executor exited before listening (code=${code}, signal=${signal}). Output:\n${buffer.slice(-2000)}`))
      }
    })

    void (async () => {
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
    })()
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

async function buildClient(port: number, adminCredential: string): Promise<Ad4mClient> {
  const ad4m = await import('@coasys/ad4m')
  const ws = await import('ws')
  const Ad4mClientCtor = (ad4m as any).Ad4mClient
  const wsImpl = (ws as any).WebSocket ?? (ws as any).default
  const client = new Ad4mClientCtor(`http://127.0.0.1:${port}`, adminCredential, true, { webSocketImpl: wsImpl })
  return client as Ad4mClient
}

function makeBootstrapSeed(): unknown {
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
