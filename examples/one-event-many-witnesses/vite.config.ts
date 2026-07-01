import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'
import { ad4mDemoPlugin } from './vite-plugin-ad4m.ts'

export default defineConfig({
  plugins: [solid(), tailwindcss(), ad4mDemoPlugin()],
  server: {
    // Bind every interface so the dev server is reachable on the LAN IP and
    // the Tailscale IP alike. IP access is always allowed; `allowedHosts`
    // additionally whitelists Tailscale MagicDNS (`*.ts.net`) and mDNS
    // (`*.local`) hostnames, which Vite would otherwise reject as unknown
    // Host headers.
    host: true,
    port: 4321,
    strictPort: true,
    allowedHosts: ['.ts.net', '.local']
  }
})
