// Vite plugin: run the demo's API backend alongside the dev server.
//
// Reserves a free localhost port, spawns `node server/index.ts` bound to
// it, and proxies `/api` there. The backend boots its own isolated AD4M
// executor — nothing else on the machine is touched. The child is killed
// when the dev server (or this process) shuts down.

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { Plugin } from 'vite'

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('could not reserve a port')))
      }
    })
  })
}

export function ad4mDemoPlugin(): Plugin {
  let apiPort = 0
  let child: ChildProcess | null = null

  const kill = () => {
    if (child && !child.killed) child.kill('SIGTERM')
    child = null
  }

  return {
    name: 'ad4m-demo-backend',
    async config() {
      apiPort = await reservePort()
      return {
        server: {
          host: true,
          proxy: {
            '/api': {
              target: `http://127.0.0.1:${apiPort}`,
              changeOrigin: false,
              ws: false
            }
          }
        }
      }
    },
    configureServer(server) {
      child = spawn('node', ['server/index.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, API_PORT: String(apiPort) },
        stdio: 'inherit'
      })
      child.on('exit', (code, signal) => {
        if (!signal) console.warn(`[ad4m-demo] backend exited (code ${code})`)
      })
      server.httpServer?.once('close', kill)
      process.once('exit', kill)
      process.once('SIGINT', () => {
        kill()
        process.exit(0)
      })
      process.once('SIGTERM', () => {
        kill()
        process.exit(0)
      })
    }
  }
}
